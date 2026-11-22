/**
 * `startSettlementBootstrap` — مرزِ برنامه برای رفتگرِ تسویه (ADR-0033). یک بار از `instrumentation` صدا زده می‌شود و:
 *  ۱. پیکربندی را روی مرز می‌سنجد؛ ۲. env را شکست‌بسته می‌خواند (`off` پیش‌فرض است)؛
 *  ۳. فقط وقتی `on` و معتبر است و میزبانی از پیش نیست، پایگاه را (تنبل) باز می‌کند؛ ۴. runtime و host می‌سازد و singleton می‌کند؛
 *  ۵. بوت را **بدون انتظار** آغاز می‌کند (سرور نباید پشتِ پایگاهِ کُند منتظر بماند؛ پروبِ startup همین را می‌گوید).
 *  ۶. (ADR-0043) فقط با `SETTLEMENT_BACKLOG_WATCH=on`: پایشِ زندهٔ پسماندِ زنگ را روی **همان** پایگاه و **همان** زمان‌سنج/ساعتِ رفتگر می‌سازد، در ظرف ثبت می‌کند
 *     (پروب‌ها از آن می‌خوانند؛ خواندنش در سمتِ پایگاه هم سقف دارد: مهلتِ پایش + فرجه، ADR-0045)، با رویدادِ `booted` (بوتِ موفق، حتی دستیِ پس از شکست) شروع می‌کند و با `shutdown.started` (و تکیه‌گاهِ دوم در `closeResources`، پیش از بستنِ پایگاه) متوقف می‌کند.
 *  ۷. (ADR-0051) فقط با `SETTLEMENT_BACKLOG_SOURCE=pending`: پایش از **نمایهٔ مشتقِ** `settlement-pending` می‌خواند (هزینه O(تأییدنشده‌ها) نه O(تأییدشده‌ها))، با همان سقفِ سمتِ پایگاه.
 *     **هرگز بی‌صدا به outbox برنمی‌گردد:** نمایهٔ نصب‌نشده/برگشته ⇒ خواندن شکست می‌خورد ⇒ نمونه `SAMPLE_UNREADABLE`/`LIST_FAILED` (درجا degraded) و نه «ok»ی کاذب یا خواندنِ کُندِ ناخواسته.
 *     بوت هرگز نمایه را نصب/بررسی نمی‌کند (نصب = `npm run settlement:pending -- up`) و نتیجهٔ بوتِ رفتگر هرگز به آن وابسته نیست.
 * هرگز نمی‌پرتابد و هرگز رد نمی‌شود. لاگ فقط رویدادِ بسته است: نه مقدارِ env، نه پیامِ خطای پایگاه (ممکن است رشتهٔ اتصال داشته باشد).
 */
import { acquireSettlementHost, createNodeExit, createNodeSignalSource, createSettlementHost, getSettlementHost } from "@/modules/settlement-host";
import type { HostBootResult } from "@/modules/settlement-host";
import { createNodeTimer, createPgSettlementRuntime, createSystemClock } from "@/modules/settlement-runtime";
import { SETTLEMENT_DEFAULT_SCHEMA, createPgSettlementOutbox } from "@/modules/settlement";
import { createPendingDeadIndex } from "@/modules/settlement-pending";
import { SETTLEMENT_BACKLOG_WATCH_DEFAULTS, SETTLEMENT_BACKLOG_WATCH_LIMITS, createBacklogWatch } from "@/modules/settlement-backlog-watch";
import type { BacklogReadyPolicy, BacklogWatch } from "@/modules/settlement-backlog-watch";
import { parseBootstrapEnv } from "./env";
import { BACKLOG_WATCH_STORE_KEY } from "./http";
import type { BootstrapErrorCode, BootstrapEvent, BootstrapOutcome, OpenedDatabase, ProcessOwner } from "./types";

/** کلیدِ نشانگرِ «بوت در جریان» روی ظرف (هم‌زمانیِ دو register یا HMR یک پایگاهِ اضافه باز نکند). */
const INFLIGHT_KEY: unique symbol = Symbol.for("legal-platform.settlement-bootstrap.inflight");

/**
 * فرجهٔ سقفِ سمتِ پایگاه نسبت به مهلتِ پایش (ADR-0045): تایمرِ پایش **زودتر** شلیک می‌کند (نمونه ⇒ `TIMEOUT`، همان کدی که پایش درجا degraded می‌شود)
 * و پایگاه کمی بعد همان پرسش را لغو می‌کند. اگر سقف برابر یا کمتر بود، رقابتِ دو مهلت گاه `LIST_FAILED` و گاه `TIMEOUT` می‌داد (کدِ نمونه ناپایدار).
 * یک ثانیه = بیشینهٔ زمانی که پرسشِ رهاشده می‌تواند اتصالِ استخر را نگه دارد.
 */
export const BACKLOG_STATEMENT_GRACE_MS = 1_000;

/**
 * سقفِ `statement_timeout`ِ خواندنِ پایش = مهلتِ مؤثرِ پایش (env یا پیش‌فرض) + فرجه. مهلتِ نامعتبر ⇒ `undefined` (بی‌سقف): همان مهلت را
 * `createBacklogWatch` شکست‌بسته رد می‌کند (BACKLOG_INVALID) و سیمی ساخته نمی‌شود، پس «بی‌سقف» هرگز به اجرا نمی‌رسد.
 */
export function backlogReadStatementTimeoutMs(overrides: Readonly<Record<string, unknown>>): number | undefined {
  const raw = overrides["timeoutMs"];
  // پیش‌فرض از ماژولِ watch خوانده می‌شود، نه سخت‌کد (نگهبانِ `backlog-source.test.ts`).
  const dflt: number = SETTLEMENT_BACKLOG_WATCH_DEFAULTS.timeoutMs;
  const timeoutMs = raw === undefined ? dflt : raw;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SETTLEMENT_BACKLOG_WATCH_LIMITS.maxTimeoutMs) return undefined;
  return timeoutMs + BACKLOG_STATEMENT_GRACE_MS;
}

type Cfg = Readonly<{
  env: unknown;
  store: Record<symbol, unknown>;
  openDatabase: () => OpenedDatabase | Promise<OpenedDatabase>;
  processOwner: ProcessOwner;
  log: (event: BootstrapEvent) => unknown;
  timer: unknown;
  signals: unknown;
  exit: unknown;
}>;

const isObj = (v: unknown): v is Record<string, unknown> => (typeof v === "object" || typeof v === "function") && v !== null;

const BOOT_CRASHED: HostBootResult = Object.freeze({ booted: false as const, reason: "RUNTIME_INVALID" as const, code: null, attempts: 0 });

const failure = (code: BootstrapErrorCode, issues: readonly string[]): BootstrapOutcome => Object.freeze({ status: "failed" as const, code, issues: Object.freeze([...issues]) });

function emit(log: (event: BootstrapEvent) => unknown, event: BootstrapEvent): void {
  try {
    const r = log(event);
    if (isObj(r) && typeof r["then"] === "function") Promise.resolve(r).then(undefined, () => undefined);
  } catch {
    // لاگِ خراب نباید بوت را بشکند.
  }
}

async function closeQuietly(opened: OpenedDatabase): Promise<void> {
  try {
    await Promise.resolve(opened.close());
  } catch {
    // بستنِ استخرِ اضافه best-effort است.
  }
}

function readConfig(raw: unknown): { ok: true; cfg: Cfg } | { ok: false; issues: string[] } {
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, issues: ["پیکربندی باید یک شیء ساده باشد."] };
    const r = raw as Record<string, unknown>;
    const issues: string[] = [];
    const known = ["env", "store", "openDatabase", "processOwner", "log", "timer", "signals", "exit"];
    for (const k of Object.keys(r)) if (!known.includes(k)) issues.push(`کلید ناشناخته: ${JSON.stringify(k.slice(0, 40))}.`);
    const env = r["env"];
    const store = r["store"];
    const openDatabase = r["openDatabase"];
    const processOwner = r["processOwner"];
    const log = r["log"];
    if (!isObj(env) || Array.isArray(env)) issues.push("env باید شیء باشد.");
    if (!isObj(store)) issues.push("store باید شیء باشد.");
    if (typeof openDatabase !== "function") issues.push("openDatabase باید تابع باشد.");
    if (processOwner !== "host" && processOwner !== "next") issues.push("processOwner باید host یا next باشد.");
    if (log !== undefined && typeof log !== "function") issues.push("log باید تابع باشد.");
    if (issues.length > 0) return { ok: false, issues };
    return {
      ok: true,
      cfg: {
        env,
        store: store as Record<symbol, unknown>,
        openDatabase: openDatabase as Cfg["openDatabase"],
        processOwner: processOwner as ProcessOwner,
        log: (log as Cfg["log"] | undefined) ?? (() => undefined),
        timer: r["timer"],
        signals: r["signals"],
        exit: r["exit"],
      },
    };
  } catch {
    return { ok: false, issues: ["خواندنِ پیکربندی ناموفق بود."] };
  }
}

async function run(cfg: Cfg): Promise<BootstrapOutcome> {
  const parsed = parseBootstrapEnv(cfg.env);
  if (!parsed.ok) return failure("INVALID_ENV", parsed.issues);
  const settings = parsed.value;
  if (!settings.enabled) return Object.freeze({ status: "disabled" as const });

  const existing = getSettlementHost(cfg.store);
  if (existing !== null) return Object.freeze({ status: "started" as const, created: false, host: existing, booting: null });

  let opened: OpenedDatabase;
  try {
    const o = await cfg.openDatabase();
    if (!isObj(o) || !isObj(o["db"]) || typeof o["close"] !== "function") return failure("DATABASE_UNAVAILABLE", ["openDatabase نتیجهٔ نامعتبر داد."]);
    opened = o as OpenedDatabase;
  } catch {
    return failure("DATABASE_UNAVAILABLE", ["openDatabase پرتاب کرد."]);
  }

  const rtConfig: Record<string, unknown> = { db: opened.db, graceMs: settings.graceMs, deadLetters: false };
  if (settings.ledgerSchema !== null) rtConfig["ledgerSchema"] = settings.ledgerSchema;
  if (settings.settlementSchema !== null) rtConfig["settlementSchema"] = settings.settlementSchema;
  const runtime = createPgSettlementRuntime(rtConfig);
  if (!runtime.ok) {
    await closeQuietly(opened);
    return failure("RUNTIME_INVALID", runtime.error.issues);
  }

  const timer = cfg.timer === undefined ? createNodeTimer() : cfg.timer;

  // پایشِ زندهٔ پسماندِ زنگ (ADR-0043): فقط با کلیدِ صریح؛ هر نقصِ پیکربندی همین‌جا و پیش از ساختنِ میزبان شکست‌بسته است.
  let watch: BacklogWatch | null = null;
  let readyPolicy: BacklogReadyPolicy = "report";
  /** نشانهٔ منبع در لاگ: فقط برای `pending` (پیش‌فرض ⇒ رویدادها بی‌تغییرند). */
  const sourceTag: { source?: "pending" } = settings.backlog?.source === "pending" ? { source: "pending" } : {};
  if (settings.backlog !== undefined) {
    // نمونهٔ جدا از نمونهٔ رفتگر: سقفِ سمتِ پایگاه فقط روی خواندن‌های پایش می‌نشیند و هیچ نوشتنِ رفتگر را نمی‌گیرد (ADR-0045).
    const readTimeoutMs = backlogReadStatementTimeoutMs(settings.backlog.overrides);
    const readOptions = {
      schema: settings.settlementSchema ?? SETTLEMENT_DEFAULT_SCHEMA,
      ...(readTimeoutMs === undefined ? {} : { readStatementTimeoutMs: readTimeoutMs }),
    };
    // منبعِ خواندن (ADR-0051): `pending` ⇒ نمایهٔ مشتق؛ وگرنه (پیش‌فرض) outboxِ PostgreSQL، بایت‌به‌بایت مثلِ پیش. هر دو همان پورتِ فقط‌خواندنیِ پایش‌اند و هیچ‌کدام دیگری را جایگزینِ خطا نمی‌کند.
    const outbox =
      settings.backlog.source === "pending"
        ? createPendingDeadIndex(opened.db as never, readOptions)
        : createPgSettlementOutbox(opened.db as never, readOptions);
    if (!outbox.ok) {
      await closeQuietly(opened);
      return failure("BACKLOG_INVALID", ["settlementSchema برای پایشِ پسماند نامعتبر است."]);
    }
    const made = createBacklogWatch({ outbox: outbox.value, clock: createSystemClock(), timer, ...settings.backlog.overrides });
    if (!made.ok) {
      await closeQuietly(opened);
      return failure("BACKLOG_INVALID", made.error.issues);
    }
    watch = made.value;
    readyPolicy = settings.backlog.overrides["readyPolicy"] === "gate_down" ? "gate_down" : "report";
  }
  let closing = false;
  let watchStarted = false;
  const stopWatch = (): void => {
    closing = true;
    if (watch === null || !watchStarted) return;
    watchStarted = false;
    try {
      watch.stop();
    } catch {
      // توقفِ پایش هرگز خاموشیِ میزبان را نمی‌شکند.
    }
    emit(cfg.log, { type: "bootstrap.backlog_watch", state: "stopped", readyPolicy, ...sourceTag });
  };
  const startWatch = (): void => {
    try {
      if (watch === null || closing) return;
      if (watch.start().started) {
        watchStarted = true;
        emit(cfg.log, { type: "bootstrap.backlog_watch", state: "started", readyPolicy, ...sourceTag });
      }
    } catch {
      // شروعِ پایش هرگز نتیجهٔ بوتِ میزبان را عوض نمی‌کند.
    }
  };
  // چرخهٔ عمرِ پایش از رویدادهای میزبان می‌آید (نه از وعدهٔ بوتِ نخست): بوتِ موفقِ دستیِ بعد از شکست هم پایش را شروع می‌کند و آغازِ خاموشی آن را پیش از رفتگر می‌ایستاند.
  const onHostEvent = (event: unknown): void => {
    if (!isObj(event)) return;
    if (event["type"] === "booted") startWatch();
    else if (event["type"] === "shutdown.started") stopWatch();
  };

  const hostConfig: Record<string, unknown> = {
    runtime: runtime.value,
    timer,
    signals: cfg.signals === undefined ? createNodeSignalSource() : cfg.signals,
    closeResources: () => {
      stopWatch(); // پیش از بستنِ استخر: خواندنِ پایش پس از بسته‌شدنِ پایگاه نباید بماند.
      return opened.close();
    },
    observer: (event: unknown) => {
      emit(cfg.log, { type: "host", event: event as never });
      onHostEvent(event);
    },
  };
  // خروجِ فرایند فقط وقتی ما صاحبِ سیگنالیم؛ وگرنه Next خودش می‌بُرد و دو `exit` رقابت نمی‌کنند.
  if (cfg.processOwner === "host") hostConfig["exit"] = cfg.exit === undefined ? createNodeExit() : cfg.exit;
  if (settings.shutdownTimeoutMs !== null) hostConfig["shutdownTimeoutMs"] = settings.shutdownTimeoutMs;
  if (settings.bootAttempts !== null || settings.bootRetryDelayMs !== null) {
    hostConfig["bootRetry"] = {
      ...(settings.bootAttempts !== null ? { maxAttempts: settings.bootAttempts } : {}),
      ...(settings.bootRetryDelayMs !== null ? { delayMs: settings.bootRetryDelayMs } : {}),
    };
  }
  const made = createSettlementHost(hostConfig);
  if (!made.ok) {
    await closeQuietly(opened);
    return failure("HOST_INVALID", made.error.issues);
  }
  const acquired = acquireSettlementHost(cfg.store, () => made);
  if (!acquired.ok) {
    await closeQuietly(opened);
    return failure("STORE_INVALID", acquired.error.issues);
  }
  if (!acquired.created) {
    // میزبانِ دیگری در همین فاصله ثبت شد (دو بسته‌بندیِ ماژول): پایگاهِ اضافه را ببند.
    await closeQuietly(opened);
    return Object.freeze({ status: "started" as const, created: false, host: acquired.value, booting: null });
  }
  emit(cfg.log, { type: "bootstrap.started", created: true, processOwner: cfg.processOwner });
  if (watch !== null) {
    try {
      cfg.store[BACKLOG_WATCH_STORE_KEY] = watch;
      if (cfg.store[BACKLOG_WATCH_STORE_KEY] !== watch) throw new TypeError("store");
      emit(cfg.log, { type: "bootstrap.backlog_watch", state: "armed", readyPolicy, ...sourceTag });
    } catch {
      watch = null; // ثبت نشد ⇒ پروب‌ها نمی‌توانند ببینندش؛ نمونه‌گیریِ بی‌گزارش هزینه است بی‌سود.
    }
  }
  const booting: Promise<HostBootResult> = Promise.resolve(acquired.value.boot()).then(
    (r) => r,
    () => BOOT_CRASHED,
  );
  return Object.freeze({ status: "started" as const, created: true, host: acquired.value, booting });
}

export function startSettlementBootstrap(raw: unknown): Promise<BootstrapOutcome> {
  const read = readConfig(raw);
  if (!read.ok) return Promise.resolve(failure("INVALID_CONFIG", read.issues));
  const cfg = read.cfg;
  const inflight = cfg.store[INFLIGHT_KEY];
  if (inflight instanceof Promise) return inflight as Promise<BootstrapOutcome>;

  const pending: Promise<BootstrapOutcome> = run(cfg).then(
    (outcome) => {
      if (outcome.status === "disabled") emit(cfg.log, { type: "bootstrap.disabled" });
      else if (outcome.status === "failed") emit(cfg.log, { type: "bootstrap.failed", code: outcome.code, issues: outcome.issues });
      return outcome;
    },
    () => {
      const crashed = failure("RUNTIME_INVALID", ["خطای پیش‌بینی‌نشده در بوت."]);
      emit(cfg.log, { type: "bootstrap.failed", code: "RUNTIME_INVALID", issues: ["خطای پیش‌بینی‌نشده در بوت."] });
      return crashed;
    },
  );
  try {
    cfg.store[INFLIGHT_KEY] = pending;
    void pending.then(() => {
      try {
        if (cfg.store[INFLIGHT_KEY] === pending) delete cfg.store[INFLIGHT_KEY];
      } catch {
        // ظرفِ قفل‌شده: نشانگر می‌ماند و فقط هم‌زمانیِ بعدی را به همین نتیجه می‌دهد.
      }
    });
  } catch {
    // ظرفِ قفل‌شده: بدونِ نگهبانِ هم‌زمانی ادامه (acquire خودش ظرفِ نامعتبر را STORE_INVALID می‌کند).
  }
  return pending;
}
