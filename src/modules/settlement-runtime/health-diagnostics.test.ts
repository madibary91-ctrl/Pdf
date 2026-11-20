/**
 * خلاصهٔ تشخیصیِ سلامت (`healthDiagnostics`) و حاشیهٔ زمانیِ دودیِ زمانِ واقعی (ADR-0041، م۳‑ه‑۴‑د).
 * ماجرا: آزمونِ دودیِ زمانِ واقعی یک بار `expected 'degraded' to be 'ok'` داد بی‌آنکه بدانیم چرا؛ بازتولید زیرِ بارِ CPU نشان داد
 * علت `STALE_SUCCESS` است (توقفِ حلقهٔ رویداد بیش از ⌊graceMs/2⌋). این فایل (الف) قالبِ پیامِ شکست را قفل می‌کند و
 * (ب) حاشیهٔ تحملِ `SMOKE_GRACE_MS` را. همه‌چیز با زمانِ مجازی و بی‌پایگاه است.
 */
import { describe, expect, it } from "vitest";
import { createSettlementRuntime } from "./index";
import type { SettlementRuntime } from "./index";
import { CANARY, GRACE, SMOKE_GRACE_MS, healthDiagnostics, manualTimer, orphan, world } from "./test-kit";
import type { World } from "./test-kit";

const HALF = GRACE / 2;
const field = (line: string, name: string): string | undefined => new RegExp(`(?:^| )${name}=(\\S+)`).exec(line)?.[1];

function build(w: World, outbox: unknown = w.outbox, over: Record<string, unknown> = {}): SettlementRuntime {
  const r = createSettlementRuntime({ ledger: w.ledger, outbox, clock: w.timer.clock, timer: w.timer, graceMs: GRACE, deadLetters: false, ...over });
  if (!r.ok) throw new Error(r.error.issues.join("; "));
  return r.value;
}

const fake = (health: unknown, status: unknown) => ({ health: () => health, status: () => status });
const goodHealth = {
  httpStatus: 200,
  health: { status: "degraded", reasons: [{ code: "STALE_SUCCESS", severity: "degraded", fault: null }], silenceMs: 133, degradedAfterMs: 60, downAfterMs: 120, lastFault: null, consecutiveFailures: 0 },
};
const goodStatus = { state: "running", startedAtMs: 5, loop: { state: "running", busy: true, runs: 3, consecutiveFailures: 0 } };

describe("healthDiagnostics · قالب و محتوا", () => {
  it("همهٔ فیلدهای تشخیصی را به‌ترتیبِ ثابت و تک‌خطی می‌دهد", () => {
    expect(healthDiagnostics(fake(goodHealth, goodStatus))).toBe(
      "health=degraded http=200 reasons=[STALE_SUCCESS:degraded] silenceMs=133 degradedAfterMs=60 downAfterMs=120 lastFault=null runtimeState=running loopState=running busy=true runs=3 consecutiveFailures=0",
    );
  });
  it("چند دلیل: همه با ترتیبِ اصلی و جداکنندهٔ کاما", () => {
    const h = { ...goodHealth, health: { ...goodHealth.health, status: "down", reasons: [{ code: "LOOP_FAULTING", severity: "degraded" }, { code: "STALE_SUCCESS", severity: "down" }] } };
    expect(field(healthDiagnostics(fake(h, goodStatus)), "reasons")).toBe("[LOOP_FAULTING:degraded,STALE_SUCCESS:down]");
  });
  it("بدون دلیل (ok): reasons=[] و silenceMs=null پذیرفته است", () => {
    const h = { httpStatus: 200, health: { status: "ok", reasons: [], silenceMs: null, degradedAfterMs: 5, downAfterMs: 10, lastFault: null } };
    const line = healthDiagnostics(fake(h, goodStatus));
    expect(field(line, "health")).toBe("ok");
    expect(field(line, "reasons")).toBe("[]");
    expect(field(line, "silenceMs")).toBe("null");
  });
  it("lastFault شمارشی نمایش داده می‌شود", () => {
    const h = { ...goodHealth, health: { ...goodHealth.health, lastFault: "LIST_FAILED" } };
    expect(field(healthDiagnostics(fake(h, goodStatus)), "lastFault")).toBe("LIST_FAILED");
  });
  it("ورودیِ خالی/ناقص: هر فیلد ? است و هیچ‌چیز نمی‌پرتابد", () => {
    const line = healthDiagnostics(fake({}, {}));
    for (const name of ["health", "http", "reasons", "silenceMs", "degradedAfterMs", "downAfterMs", "lastFault", "runtimeState", "loopState", "busy", "runs", "consecutiveFailures"]) {
      expect(field(line, name), name).toBe("?");
    }
  });
  it("عددِ نامتناهی/NaN/رشته به‌جای عدد ⇒ ?", () => {
    const h = { httpStatus: "200", health: { ...goodHealth.health, silenceMs: Number.NaN, degradedAfterMs: Infinity, downAfterMs: "120" } };
    const line = healthDiagnostics(fake(h, goodStatus));
    expect(field(line, "http")).toBe("?");
    expect(field(line, "silenceMs")).toBe("?");
    expect(field(line, "degradedAfterMs")).toBe("?");
    expect(field(line, "downAfterMs")).toBe("?");
  });
  it("خروجی همیشه یک خط است و طولش کران‌دار (۱۰۰۰ دلیل ⇒ فقط ۸ تا و «…»)", () => {
    const many = Array.from({ length: 1000 }, () => ({ code: "STALE_SUCCESS", severity: "down" }));
    const line = healthDiagnostics(fake({ ...goodHealth, health: { ...goodHealth.health, reasons: many } }, goodStatus));
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThan(500);
    expect(field(line, "reasons")?.split(",").length).toBe(9);
    expect(field(line, "reasons")).toMatch(/,…\]$/);
  });
  it("دقیقاً هشت دلیل: بدونِ نشانهٔ «…»؛ نه دلیل: با نشانه", () => {
    const mk = (n: number) => healthDiagnostics(fake({ ...goodHealth, health: { ...goodHealth.health, reasons: Array.from({ length: n }, () => ({ code: "STALE_SUCCESS", severity: "down" })) } }, goodStatus));
    expect(mk(8)).not.toContain("…");
    expect(mk(9)).toContain("…");
  });
});

describe("healthDiagnostics · ایمنی", () => {
  it("بی‌نشت: رشتهٔ آزاد (پیام، شناسه، رمز) هرگز به خروجی نمی‌رسد", () => {
    const evil = {
      httpStatus: 200,
      message: CANARY,
      health: { status: `degraded ${CANARY}`, reasons: [{ code: `STALE_${CANARY}`, severity: CANARY, fault: CANARY, detail: CANARY }], silenceMs: 1, degradedAfterMs: 1, downAfterMs: 2, lastFault: `X ${CANARY}`, extra: CANARY },
    };
    const line = healthDiagnostics(fake(evil, { state: CANARY, loop: { state: CANARY, busy: CANARY, runs: CANARY, error: CANARY } }));
    expect(line).not.toContain(CANARY);
    expect(field(line, "health")).toBe("?");
    expect(field(line, "reasons")).toBe("[?:?]");
  });
  it("هرگز نمی‌پرتابد: health/status پرتابگر، getterِ پرتابگر، Proxy، null و مقدارِ ابتدایی", () => {
    const boom = (): never => {
      throw new Error(`boom: ${CANARY}`);
    };
    const getter = {
      get health(): unknown {
        return boom();
      },
    };
    const proxy = new Proxy({}, { get: boom, has: boom, ownKeys: boom });
    const cases: Array<{ health(): unknown; status(): unknown }> = [
      { health: boom, status: boom },
      { health: boom, status: () => goodStatus },
      { health: () => goodHealth, status: boom },
      fake(getter, getter),
      fake(proxy, proxy),
      fake(null, undefined),
      fake(42, "x"),
      fake([], []),
      fake({ health: { reasons: [null, 1, "x", proxy] } }, { loop: proxy }),
    ];
    for (const c of cases) {
      let out = "";
      expect(() => (out = healthDiagnostics(c))).not.toThrow();
      expect(out).not.toContain(CANARY);
      expect(out).not.toContain("\n");
    }
  });
  it("خرابیِ تک‌فیلد فقط همان فیلد را ? می‌کند؛ خرابیِ غیرِ قابل‌مهار رشتهٔ ثابتِ unreadable می‌دهد", () => {
    const boom = (): never => {
      throw new Error(`boom: ${CANARY}`);
    };
    const hostileArray = new Proxy([], { get: boom });
    expect(healthDiagnostics(fake({ health: { reasons: hostileArray } }, goodStatus))).toBe("healthDiagnostics: unreadable");
    const hostileMethod = {
      get health(): () => unknown {
        return boom();
      },
      status: () => goodStatus,
    };
    expect(() => healthDiagnostics(hostileMethod)).not.toThrow();
    expect(healthDiagnostics(hostileMethod)).not.toContain(CANARY);
    // getterِ خراب فقط روی یک فیلد: بقیهٔ فیلدها سالم می‌مانند (علتِ شکست با یک فیلدِ خراب گم نمی‌شود).
    const oneBad = { ...goodHealth, health: { ...goodHealth.health, get status(): unknown { return boom(); } } };
    const line = healthDiagnostics(fake(oneBad, goodStatus));
    expect(field(line, "health")).toBe("?");
    expect(field(line, "reasons")).toBe("[STALE_SUCCESS:degraded]");
    expect(field(line, "silenceMs")).toBe("133");
    expect(field(line, "runs")).toBe("3");
    expect(line).not.toContain(CANARY);
  });
  it("هر متد دقیقاً یک بار فراخوانده می‌شود (عکسِ یکپارچه، نه دو ساعتِ متفاوت)", () => {
    let h = 0;
    let s = 0;
    healthDiagnostics({ health: () => ((h += 1), goodHealth), status: () => ((s += 1), goodStatus) });
    expect([h, s]).toEqual([1, 1]);
  });
  it("ورودی را تغییر نمی‌دهد و قطعی است", () => {
    const before = JSON.stringify([goodHealth, goodStatus]);
    expect(healthDiagnostics(fake(goodHealth, goodStatus))).toBe(healthDiagnostics(fake(goodHealth, goodStatus)));
    expect(JSON.stringify([goodHealth, goodStatus])).toBe(before);
  });
});

describe("healthDiagnostics · روی اجرای واقعی (زمانِ مجازی)", () => {
  it("اجرای شروع‌نشده: LOOP_STOPPED با وضعیتِ down و ۵۰۳", async () => {
    const w = await world();
    const line = healthDiagnostics(build(w));
    expect(field(line, "health")).toBe("down");
    expect(field(line, "http")).toBe("503");
    expect(field(line, "reasons")).toBe("[LOOP_STOPPED:down]");
    expect(field(line, "runtimeState")).toBe("idle");
    expect(field(line, "loopState")).toBe("stopped");
  });
  it("گذرِ آویزان ⇒ STALE_SUCCESS (همان علتِ ناپایداریِ واقعی)؛ خلاصه دقیقاً با health() یکی است", async () => {
    const w = await world();
    // نخستین claimDue واقعی است (یک موفقیتِ ثبت‌شده)؛ از آن پس هر گذر پشتِ دروازه می‌ماند ⇒ سکوتِ موفقیت.
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let calls = 0;
    const real = w.outbox as unknown as { claimDue(q: unknown): Promise<unknown> };
    const hung = { ...w.outbox, claimDue: async (q: unknown) => ((calls += 1) <= 1 ? real.claimDue(q) : (await gate, real.claimDue(q))) };
    const run = build(w, hung);
    await orphan(w, "r1");
    expect((await run.start()).started).toBe(true);
    await w.timer.advance(GRACE / 4 + 1); // نخستین گذرِ موفق ثبت می‌شود
    expect(run.health().health.status).toBe("ok");
    await w.timer.advance(HALF + GRACE / 4); // گذرهای بعدی آویزان‌اند؛ سکوت > ⌊graceMs/2⌋
    const h = run.health();
    expect(h.health.status).not.toBe("ok");
    const line = healthDiagnostics(run);
    expect(field(line, "health")).toBe(h.health.status);
    expect(field(line, "http")).toBe(String(h.httpStatus));
    expect(field(line, "reasons")).toBe(`[${h.health.reasons.map((x) => `${x.code}:${x.severity}`).join(",")}]`);
    expect(field(line, "reasons")).toMatch(/STALE_SUCCESS/);
    expect(Number(field(line, "silenceMs"))).toBe(h.health.silenceMs);
    expect(Number(field(line, "silenceMs"))).toBeGreaterThan(HALF);
    expect(field(line, "degradedAfterMs")).toBe(String(HALF));
    expect(field(line, "downAfterMs")).toBe(String(GRACE));
    expect(field(line, "busy")).toBe("true");
    release();
    await w.timer.advance(1);
    await run.stop();
  });
});

describe("SMOKE_GRACE_MS · حاشیهٔ تحملِ توقفِ حلقهٔ رویداد", () => {
  /** حاشیه = آستانهٔ degraded (از ارزیابِ واقعی) − فاصلهٔ واقعیِ نخستین گذر (از زمان‌سنجِ مجازی)؛ هیچ فرمولی تکرار نمی‌شود. */
  async function margin(grace: number): Promise<number> {
    const w = await world({ timer: manualTimer() });
    const run = build(w, w.outbox, { graceMs: grace });
    expect((await run.start()).started).toBe(true);
    await w.timer.advance(1); // نخستین گذر بی‌درنگ است (تأخیرِ ۰)؛ تأخیرِ بعدی همان فاصلهٔ واقعیِ گذرهاست.
    const interval = w.timer.delays[1] as number;
    const degradedAfter = run.health().health.degradedAfterMs;
    await run.stop();
    return degradedAfter - interval;
  }
  it("با ۱۲۰ms حاشیه ۳۰ms بود (علتِ ناپایداری) و با SMOKE_GRACE_MS حداقل ۲۵۰ms است", async () => {
    expect(await margin(120)).toBe(30);
    expect(await margin(SMOKE_GRACE_MS)).toBe(SMOKE_GRACE_MS / 4);
    expect(await margin(SMOKE_GRACE_MS)).toBeGreaterThanOrEqual(250);
  });
  it("مقدارِ آزمونِ دودی صحیح و مضربِ ۴ است (آستانه‌ها اعشاری نمی‌شوند)", () => {
    expect(Number.isSafeInteger(SMOKE_GRACE_MS)).toBe(true);
    expect(SMOKE_GRACE_MS % 4).toBe(0);
  });
  it("کران بالا: دودی زیر ۵ث می‌ماند تا بودجهٔ انتظارِ آزمون را نخورد", () => {
    expect(SMOKE_GRACE_MS * 2).toBeLessThan(5_000);
  });
});
