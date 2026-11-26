/**
 * `startToolPolicyBootstrap` — مرزِ برنامه برای میزبانِ سیاستِ ابزار (ADR-0076). یک بار از `instrumentation` صدا زده می‌شود و:
 *  ۱. پیکربندی را روی مرز می‌سنجد؛ ۲. env را شکست‌بسته می‌خواند (`off` پیش‌فرض است)؛
 *  ۳. فقط وقتی `on` و معتبر است و میزبانی از پیش نیست، پایگاه را (تنبل) باز می‌کند؛ ۴. runtime و host می‌سازد و singleton می‌کند؛
 *  ۵. بوت را **بدون انتظار** آغاز می‌کند (سرور پشتِ پایگاهِ کُند منتظر نمی‌ماند؛ پروبِ startup همین را می‌گوید).
 * هرگز مهاجرت نمی‌کند: پایگاهِ مهاجرت‌نشده ⇒ `NOT_MIGRATED` از ریشه، بی‌بازتلاش، `ready=۵۰۳`.
 * هرگز نمی‌پرتابد و هرگز رد نمی‌شود. لاگ فقط رویدادِ بسته است: نه مقدارِ env، نه پیامِ خطای پایگاه (ممکن است رشتهٔ اتصال داشته باشد).
 */
import { createNodeExit, createNodeSignalSource } from "@/modules/settlement-host";
import { createNodeTimer } from "@/modules/settlement-runtime";
import { acquireToolPolicyHost, createToolPolicyHost, getToolPolicyHost } from "@/modules/tool-policy-host";
import type { HostBootResult } from "@/modules/tool-policy-host";
import { createPgToolPolicyRuntime } from "@/modules/tool-policy-runtime";
import { parseBootstrapEnv } from "./env";
import type { BootstrapErrorCode, BootstrapEvent, BootstrapOutcome, OpenedDatabase, ProcessOwner } from "./types";

/** کلیدِ نشانگرِ «بوت در جریان» روی ظرف (هم‌زمانیِ دو register یا HMR یک پایگاهِ اضافه باز نکند). */
const INFLIGHT_KEY: unique symbol = Symbol.for("legal-platform.tool-policy-bootstrap.inflight");

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

const BOOT_CRASHED: HostBootResult = Object.freeze({ booted: false as const, reason: "RUNTIME_INVALID" as const, attempts: 0 });

const failure = (code: BootstrapErrorCode, issues: readonly string[]): BootstrapOutcome => Object.freeze({ status: "failed" as const, code, issues: Object.freeze([...issues]) });

function emit(log: (event: BootstrapEvent) => unknown, event: BootstrapEvent): void {
  try {
    const r = log(event);
    if (isObj(r) && typeof r["then"] === "function") Promise.resolve(r).then(undefined, () => undefined);
  } catch {
    // لاگِ خراب نباید بوت را بشکند.
  }
}

/**
 * شکستِ بوت پیش از آن‌که میزبان مالکِ پایگاه شود: اگر مصرف‌کننده `release` داده باشد (پس‌دادنِ اجاره بی‌بستنِ استخرِ مشترکِ برنامه) همان صدا زده می‌شود،
 * وگرنه `close`. استخرِ برنامه را وبِ اصلی هم می‌خواند؛ بوتِ شکست‌خوردهٔ سیاست نباید آن را ببندد (ADR-0076 تصمیم ۶).
 * `close` فقط در `closeResources` (پس از توقفِ تمیز) صدا زده می‌شود.
 */
async function closeQuietly(opened: OpenedDatabase): Promise<void> {
  try {
    const give = typeof opened.release === "function" ? opened.release : opened.close;
    await Promise.resolve(give.call(opened));
  } catch {
    // پس‌دادنِ اجارهٔ اضافه best-effort است.
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

  const existing = getToolPolicyHost(cfg.store);
  if (existing !== null) return Object.freeze({ status: "started" as const, created: false, host: existing, booting: null });

  let opened: OpenedDatabase;
  try {
    const o = await cfg.openDatabase();
    if (!isObj(o) || !isObj(o["db"]) || typeof o["close"] !== "function") return failure("DATABASE_UNAVAILABLE", ["openDatabase نتیجهٔ نامعتبر داد."]);
    opened = o as OpenedDatabase;
  } catch {
    return failure("DATABASE_UNAVAILABLE", ["openDatabase پرتاب کرد."]);
  }

  // یک زمان‌سنج برای ریشه و میزبان (آزمونِ زمانِ مجازی هر دو را با یک ساعت می‌راند).
  const timer = cfg.timer === undefined ? createNodeTimer() : cfg.timer;

  const rtConfig: Record<string, unknown> = { db: opened.db, tuning: { ...settings.tuning }, timer };
  if (settings.schema !== null) rtConfig["schema"] = settings.schema;
  if (settings.statementTimeoutMs !== null) rtConfig["statementTimeoutMs"] = settings.statementTimeoutMs;
  const runtime = createPgToolPolicyRuntime(rtConfig);
  if (!runtime.ok) {
    await closeQuietly(opened);
    return failure("RUNTIME_INVALID", runtime.error.issues);
  }

  const hostConfig: Record<string, unknown> = {
    runtime: runtime.value,
    timer,
    signals: cfg.signals === undefined ? createNodeSignalSource() : cfg.signals,
    closeResources: () => opened.close(),
    observer: (event: unknown) => emit(cfg.log, { type: "host", event: event as never }),
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
  const made = createToolPolicyHost(hostConfig);
  if (!made.ok) {
    await closeQuietly(opened);
    return failure("HOST_INVALID", made.error.issues);
  }
  const acquired = acquireToolPolicyHost(cfg.store, () => made);
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
  const booting: Promise<HostBootResult> = Promise.resolve(acquired.value.boot()).then(
    (r) => r,
    () => BOOT_CRASHED,
  );
  return Object.freeze({ status: "started" as const, created: true, host: acquired.value, booting });
}

export function startToolPolicyBootstrap(raw: unknown): Promise<BootstrapOutcome> {
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
