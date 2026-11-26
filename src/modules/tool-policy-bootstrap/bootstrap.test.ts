/**
 * `startToolPolicyBootstrap` (ADR-0076): خاموشِ پیش‌فرض، شکست‌بسته روی env/پیکربندی/پایگاه/ریشه/میزبان/ظرف، بوتِ بی‌مسدودی، تک‌نمونه،
 * پس‌دادنِ اجارهٔ پایگاه در شکست (بی‌بستنِ استخرِ مشترک)، صاحبِ خروج، بازتلاشِ فقط‌گذرا، لاگِ بسته و بی‌نشت.
 * ریشه **واقعی** است (`createPgToolPolicyRuntime`) روی `db`ِ ساختگی که همیشه می‌شکند ⇒ بوت `UNAVAILABLE`؛ مسیرِ سالم/مهاجرت‌نشده در آزمونِ PG است.
 */
import { describe, expect, it } from "vitest";
import { TOOL_POLICY_HOST_STORE_KEY, getToolPolicyHost } from "@/modules/tool-policy-host";
import type { ToolPolicyHost } from "@/modules/tool-policy-host";
import { startToolPolicyBootstrap } from "./index";
import type { BootstrapEvent, BootstrapOutcome } from "./index";

const CANARY = "LEAK-CANARY-policy-bootstrap-77e1";
const TUNING_ENV = {
  TOOL_POLICY_INTERVAL_MS: "10000",
  TOOL_POLICY_RETRY_MS: "2000",
  TOOL_POLICY_ATTEMPT_DEADLINE_MS: "6000",
  TOOL_POLICY_REFRESH_TIMEOUT_MS: "5000",
  TOOL_POLICY_MAX_STALE_MS: "30000",
};
const ENV_ON = { TOOL_POLICY_HOST: "on", ...TUNING_ENV };
const flush = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
};

/** پایگاهی که همیشه می‌شکند ⇒ پیش‌بازرسیِ ریشه `UNAVAILABLE`. متنِ خطا حاویِ CANARY است تا نشت دیده شود. */
const failingDb = () => ({
  execute: async (): Promise<never> => { throw new Error(CANARY); },
  transaction: async (): Promise<never> => { throw new Error(CANARY); },
});

/** پایگاهی که هرگز پاسخ نمی‌دهد (برای بی‌مسدودی). */
const hangingDb = () => ({ execute: () => new Promise<never>(() => undefined), transaction: () => new Promise<never>(() => undefined) });

/** زمان‌سنج: فقط تأخیرهای مشخص‌شده شلیک می‌کنند؛ بقیه (مهلت‌ها) هرگز. */
function timerFiring(fireAt: readonly number[] = []) {
  const delays: number[] = [];
  let n = 0;
  return {
    delays,
    after: (fn: () => void, ms: number): unknown => {
      delays.push(ms);
      if (fireAt.includes(ms)) setImmediate(fn);
      return ++n;
    },
    cancel: (): void => undefined,
  };
}

function fakeSignals() {
  const listeners = new Map<string, () => void>();
  return {
    on: (s: string, l: () => void): unknown => void listeners.set(s, l),
    off: (s: string): unknown => void listeners.delete(s),
    emit: (s: string): void => listeners.get(s)?.(),
    count: (): number => listeners.size,
  };
}

function world(opts: { db?: unknown; withRelease?: boolean } = {}) {
  const calls = { open: 0, close: 0, release: 0 };
  const events: BootstrapEvent[] = [];
  const store: Record<symbol, unknown> = {};
  const db = opts.db ?? failingDb();
  const openDatabase = async () => {
    calls.open += 1;
    return {
      db,
      close: () => void (calls.close += 1),
      ...(opts.withRelease === true ? { release: () => void (calls.release += 1) } : {}),
    };
  };
  const base = { env: ENV_ON, store, openDatabase, processOwner: "next" as const, log: (e: BootstrapEvent) => void events.push(e), timer: timerFiring(), signals: false as const };
  return { calls, events, store, base };
}

const hostOf = (o: BootstrapOutcome): ToolPolicyHost => {
  if (o.status !== "started") throw new Error(`status:${o.status}`);
  return o.host;
};

describe("tool-policy-bootstrap · خاموش و شکست‌بسته", () => {
  it("پیش‌فرض خاموش: هیچ پایگاهی باز نمی‌شود و هیچ چیزی در ظرف نیست", async () => {
    const w = world();
    const out = await startToolPolicyBootstrap({ ...w.base, env: {} });
    expect(out).toEqual({ status: "disabled" });
    expect(w.calls).toEqual({ open: 0, close: 0, release: 0 });
    expect(Reflect.ownKeys(w.store)).toEqual([]);
    expect(w.events).toEqual([{ type: "bootstrap.disabled" }]);
  });

  it("TOOL_POLICY_HOST=off صریح هم همان است", async () => {
    const w = world();
    expect(await startToolPolicyBootstrap({ ...w.base, env: { TOOL_POLICY_HOST: "off" } })).toEqual({ status: "disabled" });
    expect(w.calls.open).toBe(0);
  });

  it("env نامعتبر ⇒ INVALID_ENV (نه خاموشِ بی‌صدا)؛ پایگاه باز نمی‌شود؛ لاگِ failed", async () => {
    const w = world();
    const out = await startToolPolicyBootstrap({ ...w.base, env: { ...ENV_ON, TOOL_POLICY_HOST: "ON" } });
    expect(out).toMatchObject({ status: "failed", code: "INVALID_ENV" });
    expect(w.calls.open).toBe(0);
    expect(w.events).toEqual([{ type: "bootstrap.failed", code: "INVALID_ENV", issues: ["TOOL_POLICY_HOST باید on یا off باشد."] }]);
  });

  it("tuning ناقص با on ⇒ INVALID_ENV و پنج مشکلِ هم‌زمان", async () => {
    const w = world();
    const out = await startToolPolicyBootstrap({ ...w.base, env: { TOOL_POLICY_HOST: "on" } });
    expect(out.status === "failed" && out.issues).toHaveLength(5);
    expect(w.calls.open).toBe(0);
  });

  const BAD_CONFIGS: ReadonlyArray<readonly [string, unknown]> = [
    ["null", null],
    ["آرایه", []],
    ["رشته", "x"],
    ["بی‌env", { store: {}, openDatabase: () => undefined, processOwner: "next" }],
    ["بی‌store", { env: {}, openDatabase: () => undefined, processOwner: "next" }],
    ["openDatabase غیرتابع", { env: {}, store: {}, openDatabase: 1, processOwner: "next" }],
    ["processOwner نامعتبر", { env: {}, store: {}, openDatabase: () => undefined, processOwner: "both" }],
    ["log غیرتابع", { env: {}, store: {}, openDatabase: () => undefined, processOwner: "next", log: 5 }],
    ["کلیدِ ناشناخته", { env: {}, store: {}, openDatabase: () => undefined, processOwner: "next", extra: 1 }],
    ];
  it.each(BAD_CONFIGS)("پیکربندیِ نامعتبر (%s) ⇒ INVALID_CONFIG بی‌پرتاب", async (_n, cfg) => {
    const out = await startToolPolicyBootstrap(cfg);
    expect(out).toMatchObject({ status: "failed", code: "INVALID_CONFIG" });
  });

  it("پیکربندیِ دارای getterِ پرتاب‌کننده ⇒ INVALID_CONFIG", async () => {
    const cfg = {};
    Object.defineProperty(cfg, "env", { enumerable: true, get: () => { throw new Error(CANARY); } });
    const out = await startToolPolicyBootstrap(cfg);
    expect(out).toEqual({ status: "failed", code: "INVALID_CONFIG", issues: ["خواندنِ پیکربندی ناموفق بود."] });
  });

  it("نتیجه‌ها یخ‌زده‌اند", async () => {
    const w = world();
    expect(Object.isFrozen(await startToolPolicyBootstrap({ ...w.base, env: {} }))).toBe(true);
    const f = await startToolPolicyBootstrap({ ...w.base, env: { TOOL_POLICY_HOST: "x" } });
    expect(Object.isFrozen(f) && f.status === "failed" && Object.isFrozen(f.issues)).toBe(true);
  });
});

describe("tool-policy-bootstrap · شروع", () => {
  it("on و معتبر: میزبان در ظرف، بوت آغاز می‌شود و پایگاهِ خراب ⇒ UNAVAILABLE بی‌بازتلاشِ پیش‌فرض", async () => {
    const w = world();
    const out = await startToolPolicyBootstrap(w.base);
    expect(out).toMatchObject({ status: "started", created: true });
    expect(getToolPolicyHost(w.store)).toBe(hostOf(out));
    expect(w.calls.open).toBe(1);
    expect(out.status === "started" && (await out.booting)).toEqual({ booted: false, reason: "UNAVAILABLE", attempts: 1 });
    expect(hostOf(out).status()).toMatchObject({ state: "failed", lastBootFailure: { reason: "UNAVAILABLE" } });
    expect(w.events[0]).toEqual({ type: "bootstrap.started", created: true, processOwner: "next" });
  });

  it("بوتِ ناموفق پایگاه را نمی‌بندد (بازتلاش/خاموشیِ بعدی ممکن می‌ماند)", async () => {
    const w = world({ withRelease: true });
    const out = await startToolPolicyBootstrap(w.base);
    if (out.status === "started") await out.booting;
    expect(w.calls).toEqual({ open: 1, close: 0, release: 0 });
  });

  it("بی‌مسدودی: outcome پیش از پایانِ بوت برمی‌گردد (پایگاهِ کُند ⇒ booting هنوز معلق)", async () => {
    const w = world({ db: hangingDb() });
    const out = await startToolPolicyBootstrap(w.base);
    expect(out.status).toBe("started");
    const SENT = Symbol("pending");
    const raced = await Promise.race([out.status === "started" ? out.booting : null, flush(3).then(() => SENT)]);
    expect(raced).toBe(SENT);
    expect(hostOf(out).status().state).toBe("booting");
    expect(hostOf(out).probes.startup().httpStatus).toBe(503);
    void hostOf(out).shutdown(); // رها کردنِ پروندهٔ معلق (بی‌انتظار)
  });

  it("تک‌نمونه: فراخوانیِ دوم همان میزبان را بی‌بازکردنِ پایگاه می‌دهد", async () => {
    const w = world();
    const a = await startToolPolicyBootstrap(w.base);
    const b = await startToolPolicyBootstrap(w.base);
    expect(b).toMatchObject({ status: "started", created: false, booting: null });
    expect(hostOf(b)).toBe(hostOf(a));
    expect(w.calls.open).toBe(1);
  });

  it("هم‌زمان: دو فراخوانی ⇒ یک پایگاه و همان وعده", async () => {
    const w = world();
    const p1 = startToolPolicyBootstrap(w.base);
    const p2 = startToolPolicyBootstrap(w.base);
    expect(p2).toBe(p1);
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(b);
    expect(w.calls.open).toBe(1);
  });

  it("نشانگرِ «در جریان» پس از پایان پاک می‌شود (فراخوانیِ بعدی دوباره می‌سنجد)", async () => {
    const w = world();
    await startToolPolicyBootstrap(w.base);
    expect(Reflect.ownKeys(w.store).filter((k) => String(k).includes("inflight"))).toEqual([]);
  });

  it("دو بسته‌بندیِ ماژول: میزبانِ دیگری هنگامِ بازشدنِ پایگاه ثبت شد ⇒ اجارهٔ اضافه پس داده می‌شود و همان میزبان برمی‌گردد", async () => {
    const w = world({ withRelease: true });
    const other = { boot: async () => undefined, shutdown: async () => undefined, status: () => ({ state: "idle" }), probes: { live: () => ({}), startup: () => ({}), ready: () => ({}) } };
    const out = await startToolPolicyBootstrap({
      ...w.base,
      openDatabase: async () => {
        w.store[TOOL_POLICY_HOST_STORE_KEY] = other;
        return { db: failingDb(), close: () => void (w.calls.close += 1), release: () => void (w.calls.release += 1) };
      },
    });
    expect(out).toMatchObject({ status: "started", created: false, booting: null });
    expect(hostOf(out)).toBe(other);
    expect(w.calls).toMatchObject({ close: 0, release: 1 });
  });
});

describe("tool-policy-bootstrap · شکست‌های سازه‌ای (پایگاهِ بازشده پس داده می‌شود و چیزی ذخیره نمی‌شود)", () => {
  const OPENERS: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    ["پرتاب", async () => { throw new Error(CANARY); }],
    ["null", async () => null],
    ["بی‌db", async () => ({ close: () => undefined })],
    ["db غیرشیء", async () => ({ db: 5, close: () => undefined })],
    ["بی‌close", async () => ({ db: {} })],
  ];
  it.each(OPENERS)("openDatabase %s ⇒ DATABASE_UNAVAILABLE", async (_n, openDatabase) => {
    const w = world();
    const out = await startToolPolicyBootstrap({ ...w.base, openDatabase });
    expect(out).toMatchObject({ status: "failed", code: "DATABASE_UNAVAILABLE" });
    expect(JSON.stringify([out, w.events])).not.toContain(CANARY);
    expect(Reflect.ownKeys(w.store)).toEqual([]);
  });

  it.each([
    ["رابطهٔ tuning (retry>interval)", { TOOL_POLICY_RETRY_MS: "20000" }, "tuning"],
    ["مهلتِ پایگاه > مهلتِ تازه‌سازی", { TOOL_POLICY_STATEMENT_TIMEOUT_MS: "9000" }, "statementTimeoutMs"],
    ["نامِ شِمای نامعتبر", { TOOL_POLICY_SCHEMA: `bad-schema; DROP ${CANARY}` }, "schema"],
    ["مهلتِ تازه‌سازی > کهنگی", { TOOL_POLICY_REFRESH_TIMEOUT_MS: "40000" }, "refreshTimeoutMs"],
  ])("%s ⇒ RUNTIME_INVALID، اجاره پس داده می‌شود، میزبانی ساخته نمی‌شود، مقدار نشت نمی‌کند", async (_n, extra, needle) => {
    for (const withRelease of [true, false]) {
      const w = world({ withRelease });
      const out = await startToolPolicyBootstrap({ ...w.base, env: { ...ENV_ON, ...extra } });
      expect(out).toMatchObject({ status: "failed", code: "RUNTIME_INVALID" });
      expect(out.status === "failed" && out.issues.join(" ")).toContain(needle);
      expect(w.calls).toEqual({ open: 1, close: withRelease ? 0 : 1, release: withRelease ? 1 : 0 });
      expect(getToolPolicyHost(w.store)).toBeNull();
      expect(JSON.stringify([out, w.events])).not.toContain(CANARY);
    }
  });

  it("db بی‌execute/transaction ⇒ RUNTIME_INVALID", async () => {
    const w = world({ db: {} });
    expect(await startToolPolicyBootstrap(w.base)).toMatchObject({ status: "failed", code: "RUNTIME_INVALID" });
  });

  it("منبعِ سیگنالِ نامعتبر ⇒ HOST_INVALID و اجاره پس داده می‌شود", async () => {
    const w = world({ withRelease: true });
    const out = await startToolPolicyBootstrap({ ...w.base, signals: "nope" });
    expect(out).toMatchObject({ status: "failed", code: "HOST_INVALID" });
    expect(w.calls).toMatchObject({ close: 0, release: 1 });
    expect(getToolPolicyHost(w.store)).toBeNull();
  });

  it("زمان‌سنجِ نامعتبر ⇒ RUNTIME_INVALID (ریشه پیش از میزبان می‌سنجد)", async () => {
    const w = world();
    expect(await startToolPolicyBootstrap({ ...w.base, timer: {} })).toMatchObject({ status: "failed", code: "RUNTIME_INVALID" });
  });

  it("مقدارِ بیگانه زیرِ کلیدِ میزبان ⇒ STORE_INVALID و بازنویسی نمی‌شود، اجاره پس داده می‌شود", async () => {
    const w = world({ withRelease: true });
    w.store[TOOL_POLICY_HOST_STORE_KEY] = "alien";
    const out = await startToolPolicyBootstrap(w.base);
    expect(out).toMatchObject({ status: "failed", code: "STORE_INVALID" });
    expect(w.store[TOOL_POLICY_HOST_STORE_KEY]).toBe("alien");
    expect(w.calls).toMatchObject({ close: 0, release: 1 });
  });

  it("ظرفِ فقط‌خواندنی (یخ‌زده) ⇒ STORE_INVALID (نه پرتاب)", async () => {
    const w = world({ withRelease: true });
    const out = await startToolPolicyBootstrap({ ...w.base, store: Object.freeze({}) });
    expect(out).toMatchObject({ status: "failed", code: "STORE_INVALID" });
    expect(w.calls.release).toBe(1);
  });

  it("شکست‌ها لاگ می‌شوند: یک رویدادِ bootstrap.failed با همان کد", async () => {
    const w = world();
    await startToolPolicyBootstrap({ ...w.base, timer: {} });
    expect(w.events).toHaveLength(1);
    expect(w.events[0]).toMatchObject({ type: "bootstrap.failed", code: "RUNTIME_INVALID" });
  });
});

describe("tool-policy-bootstrap · صاحبِ خروج، سیگنال و خاموشی", () => {
  it("processOwner=host: SIGTERM ⇒ خاموشیِ مرتب ⇒ close یک بار ⇒ exit(0)", async () => {
    const w = world();
    const sig = fakeSignals();
    const exits: number[] = [];
    const out = await startToolPolicyBootstrap({ ...w.base, processOwner: "host", signals: sig, exit: (c: number) => void exits.push(c) });
    if (out.status === "started") await out.booting;
    expect(sig.count()).toBeGreaterThan(0);
    sig.emit("SIGTERM");
    await flush();
    expect(hostOf(out).status().state).toBe("stopped");
    expect(w.calls.close).toBe(1);
    expect(exits).toEqual([0]);
    expect(sig.count()).toBe(0);
    expect(w.events.some((e) => e.type === "host" && e.event.type === "shutdown.finished")).toBe(true);
  });

  it("processOwner=next: همان خاموشی ولی هرگز exit (حتی اگر exit داده شود)", async () => {
    const w = world();
    const sig = fakeSignals();
    const exits: number[] = [];
    const out = await startToolPolicyBootstrap({ ...w.base, processOwner: "next", signals: sig, exit: (c: number) => void exits.push(c) });
    if (out.status === "started") await out.booting;
    sig.emit("SIGINT");
    await flush();
    expect(w.calls.close).toBe(1);
    expect(exits).toEqual([]);
  });

  it("خاموشیِ دستی (shutdown) هم close می‌کند، نه release", async () => {
    const w = world({ withRelease: true });
    const out = await startToolPolicyBootstrap(w.base);
    if (out.status === "started") await out.booting;
    const r = await hostOf(out).shutdown();
    expect(r).toMatchObject({ ok: true, clean: true, closed: "ok" });
    expect(w.calls).toEqual({ open: 1, close: 1, release: 0 });
  });

  it("close که می‌پرتابد ⇒ خاموشی ok=false و exit(1) (شکستِ بستنِ استخر پنهان نمی‌شود)", async () => {
    const w = world();
    const sig = fakeSignals();
    const exits: number[] = [];
    const out = await startToolPolicyBootstrap({
      ...w.base,
      processOwner: "host",
      signals: sig,
      exit: (c: number) => void exits.push(c),
      openDatabase: async () => ({ db: failingDb(), close: () => { throw new Error(CANARY); } }),
    });
    if (out.status === "started") await out.booting;
    sig.emit("SIGTERM");
    await flush();
    expect(exits).toEqual([1]);
    expect(JSON.stringify(w.events)).not.toContain(CANARY);
  });

  it("SHUTDOWN_TIMEOUT_MS به میزبان می‌رسد (زمان‌سنجِ کلِ خاموشی)", async () => {
    const w = world();
    const t = timerFiring();
    const out = await startToolPolicyBootstrap({ ...w.base, timer: t, env: { ...ENV_ON, TOOL_POLICY_SHUTDOWN_TIMEOUT_MS: "1234" } });
    if (out.status === "started") await out.booting;
    await hostOf(out).shutdown();
    expect(t.delays).toContain(1234);
    expect(t.delays).not.toContain(15_000);
  });

  it("بی‌SHUTDOWN_TIMEOUT_MS مهلتِ پیش‌فرضِ میزبان (۱۵٬۰۰۰) است", async () => {
    const w = world();
    const t = timerFiring();
    const out = await startToolPolicyBootstrap({ ...w.base, timer: t });
    if (out.status === "started") await out.booting;
    await hostOf(out).shutdown();
    expect(t.delays).toContain(15_000);
  });
});

describe("tool-policy-bootstrap · بازتلاشِ بوت", () => {
  it("BOOT_ATTEMPTS=3 با تأخیرِ ۵ ⇒ سه تلاش (فقط UNAVAILABLE)، رویدادهای attempt_failed و boot.failed", async () => {
    const w = world();
    const t = timerFiring([5]);
    const out = await startToolPolicyBootstrap({ ...w.base, timer: t, env: { ...ENV_ON, TOOL_POLICY_BOOT_ATTEMPTS: "3", TOOL_POLICY_BOOT_RETRY_DELAY_MS: "5" } });
    expect(out.status === "started" && (await out.booting)).toEqual({ booted: false, reason: "UNAVAILABLE", attempts: 3 });
    const hostEvents = w.events.flatMap((e) => (e.type === "host" ? [e.event] : []));
    expect(hostEvents.filter((e) => e.type === "boot.attempt_failed")).toEqual([
      { type: "boot.attempt_failed", attempt: 1, reason: "UNAVAILABLE", willRetry: true },
      { type: "boot.attempt_failed", attempt: 2, reason: "UNAVAILABLE", willRetry: true },
      { type: "boot.attempt_failed", attempt: 3, reason: "UNAVAILABLE", willRetry: false },
    ]);
    expect(t.delays.filter((d) => d === 5)).toHaveLength(2);
  });

  it("فقط BOOT_ATTEMPTS (بی‌تأخیر) ⇒ تأخیرِ پیش‌فرضِ میزبان (۱۰۰۰)", async () => {
    const w = world();
    const t = timerFiring([1000]);
    const out = await startToolPolicyBootstrap({ ...w.base, timer: t, env: { ...ENV_ON, TOOL_POLICY_BOOT_ATTEMPTS: "2" } });
    expect(out.status === "started" && (await out.booting)).toMatchObject({ attempts: 2 });
    expect(t.delays).toContain(1000);
  });

  it("پیش‌فرض: یک تلاش و بی‌انتظار", async () => {
    const w = world();
    const t = timerFiring();
    const out = await startToolPolicyBootstrap({ ...w.base, timer: t });
    expect(out.status === "started" && (await out.booting)).toMatchObject({ attempts: 1 });
    expect(t.delays).not.toContain(1000);
  });
});

describe("tool-policy-bootstrap · لاگِ بسته و مقاوم", () => {
  it("لاگِ پرتاب‌کننده بوت را نمی‌شکند", async () => {
    const w = world();
    const out = await startToolPolicyBootstrap({ ...w.base, log: () => { throw new Error(CANARY); } });
    expect(out.status).toBe("started");
  });

  it("لاگِ ناهمگامِ ردشونده ⇒ rejection بی‌مالک نمی‌ماند", async () => {
    const w = world();
    const unhandled: unknown[] = [];
    const h = (r: unknown): void => void unhandled.push(r);
    process.on("unhandledRejection", h);
    try {
      await startToolPolicyBootstrap({ ...w.base, log: () => Promise.reject(new Error(CANARY)) });
      await flush();
    } finally {
      process.off("unhandledRejection", h);
    }
    expect(unhandled).toEqual([]);
  });

  it("هیچ رویدادی مقدارِ env/پیامِ خطای پایگاه را نمی‌برد", async () => {
    const w = world();
    const out = await startToolPolicyBootstrap({ ...w.base, env: { ...ENV_ON, TOOL_POLICY_SCHEMA: "policy_ok" } });
    if (out.status === "started") await out.booting;
    const text = JSON.stringify(w.events);
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("policy_ok");
    expect(text).not.toContain("10000");
  });

  it("خاصیتی: ۲۰۰ پیکربندیِ خصمانه هرگز نمی‌پرتابد/رد نمی‌شود و همیشه نتیجهٔ بسته می‌دهد", async () => {
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const junk: unknown[] = [undefined, null, 0, 1, "", "x", {}, [], () => undefined, () => { throw new Error(CANARY); }, Symbol("s"), true];
    const keys = ["env", "store", "openDatabase", "processOwner", "log", "timer", "signals", "exit"];
    for (let i = 0; i < 200; i++) {
      const cfg: Record<string, unknown> = {};
      for (const k of keys) if (rnd() < 0.8) cfg[k] = junk[Math.floor(rnd() * junk.length)];
      const out = await startToolPolicyBootstrap(cfg);
      expect(["disabled", "started", "failed"]).toContain(out.status);
      expect(JSON.stringify(out.status === "failed" ? out.issues : [])).not.toContain(CANARY);
    }
  });
});
