/**
 * ارزیابِ سلامتِ رفتگر (ADR-0030، م۳‑ه‑۱): پیکربندی، جدولِ قاعده‌ها و مرزها، ورودیِ بدجنس (بی‌پرتاب، شکستِ بسته، بی‌نشت)،
 * خاصیتی در برابر مدلِ مرجعِ مستقل، یکنوایی، و یکپارچگی با حلقهٔ واقعیِ `createSweepLoop` روی زمانِ مجازی.
 */
import { describe, expect, it } from "vitest";
import { SETTLEMENT_LIMITS, createSweepHealthCheck, createSweepLoop, sweepHealthHttpStatus } from "./index";
import type { HealthStatus, LoopFaultKind, SweepHealth, SweepHealthCheck } from "./index";
import { fakeSweeper, manualTimer, sweepReport } from "./test-kit";

const GRACE = 20_000;
const HALF = GRACE / 2;
const CANARY = "LEAK-CANARY-health-7b3e";
const NOW = 5_000_000;
const FAULT_KINDS: readonly LoopFaultKind[] = ["SWEEP_THREW", "BAD_REPORT", "LIST_FAILED", "OUTBOX_FAILURES", "SCHEDULE_FAILED", "DEAD_LIST_FAILED", "DEAD_DELIVER_FAILED", "DEAD_ACK_FAILED"];

const TOTALS = { examined: 0, settled: 0, retryLater: 0, raced: 0, outboxFailures: 0, buried: 0, faults: 0, observerFailures: 0 };
const DEAD = { enabled: false, delivered: 0, acknowledged: 0, deliverFailures: 0, ackFailures: 0, listFailures: 0, lastAckAtMs: null };
const st = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ state: "running", busy: false, runs: 5, consecutiveFailures: 0, lastRunAtMs: NOW, lastSuccessAtMs: NOW, lastFault: null, totals: TOTALS, deadLetters: DEAD, ...over });

function mk(cfg: Record<string, unknown> = { graceMs: GRACE }): SweepHealthCheck {
  const r = createSweepHealthCheck(cfg);
  if (!r.ok) throw new Error(`پیکربندیِ آزمون نامعتبر: ${r.error.issues.join(" | ")}`);
  return r.value;
}
// تایپ را دور می‌زنیم: عمداً ورودیِ نادرست می‌دهیم.
const ev = (c: SweepHealthCheck, status: unknown, nowMs: unknown = NOW, sinceMs?: unknown): SweepHealth => c.evaluate({ status, nowMs, ...(sinceMs === undefined ? {} : { sinceMs }) } as never);
const codes = (h: SweepHealth): string[] => h.reasons.map((r) => r.code);

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("ارزیابِ سلامت · پیکربندی", () => {
  it("پیش‌فرض‌ها: degraded = ⌊grace/2⌋ و down = grace", () => {
    const h = ev(mk(), st());
    expect([h.degradedAfterMs, h.downAfterMs]).toEqual([HALF, GRACE]);
  });
  it("graceMs فرد: کفِ نصف", () => {
    const h = ev(mk({ graceMs: 2001 }), st());
    expect([h.degradedAfterMs, h.downAfterMs]).toEqual([1000, 2001]);
  });
  it("مرزها پذیرفته می‌شوند: grace = ۲، grace = سقف، degraded = down", () => {
    expect(createSweepHealthCheck({ graceMs: 2 }).ok).toBe(true);
    expect(createSweepHealthCheck({ graceMs: SETTLEMENT_LIMITS.maxGraceMs }).ok).toBe(true);
    expect(createSweepHealthCheck({ graceMs: GRACE, degradedAfterMs: 7, downAfterMs: 7 }).ok).toBe(true);
    expect(createSweepHealthCheck({ graceMs: GRACE, degradedAfterMs: SETTLEMENT_LIMITS.maxGraceMs, downAfterMs: SETTLEMENT_LIMITS.maxGraceMs }).ok).toBe(true);
  });
  it("آستانه‌های دستی جایگزینِ پیش‌فرض می‌شوند", () => {
    const h = ev(mk({ graceMs: GRACE, degradedAfterMs: 3, downAfterMs: 9 }), st());
    expect([h.degradedAfterMs, h.downAfterMs]).toEqual([3, 9]);
  });
  it("graceMs=۲ ⇒ degraded=۱، down=۲", () => {
    const h = ev(mk({ graceMs: 2 }), st());
    expect([h.degradedAfterMs, h.downAfterMs]).toEqual([1, 2]);
  });
  const MAX = SETTLEMENT_LIMITS.maxGraceMs;
  it.each<[string, unknown]>([
    ["null", null],
    ["عدد", 5],
    ["رشته", "x"],
    ["آرایه", []],
    ["تابع", () => 1],
    ["شیء خالی", {}],
    ["graceMs یک", { graceMs: 1 }],
    ["graceMs صفر", { graceMs: 0 }],
    ["graceMs منفی", { graceMs: -5 }],
    ["graceMs اعشاری", { graceMs: 2000.5 }],
    ["graceMs رشته", { graceMs: "20000" }],
    ["graceMs NaN", { graceMs: NaN }],
    ["graceMs بی‌نهایت", { graceMs: Infinity }],
    ["graceMs بالاتر از سقف", { graceMs: MAX + 1 }],
    ["degradedAfterMs بی‌graceMs", { degradedAfterMs: 5, downAfterMs: 9 }],
    ["degradedAfterMs صفر", { graceMs: GRACE, degradedAfterMs: 0 }],
    ["degradedAfterMs اعشاری", { graceMs: GRACE, degradedAfterMs: 1.5 }],
    ["degradedAfterMs رشته", { graceMs: GRACE, degradedAfterMs: "5" }],
    ["degradedAfterMs null", { graceMs: GRACE, degradedAfterMs: null }],
    ["degradedAfterMs بالاتر از سقف", { graceMs: GRACE, degradedAfterMs: MAX + 1, downAfterMs: MAX }],
    ["downAfterMs صفر", { graceMs: GRACE, downAfterMs: 0 }],
    ["downAfterMs NaN", { graceMs: GRACE, downAfterMs: NaN }],
    ["downAfterMs بالاتر از سقف", { graceMs: GRACE, downAfterMs: MAX + 1 }],
    ["degraded > down (دستی)", { graceMs: GRACE, degradedAfterMs: 10, downAfterMs: 9 }],
    ["degraded دستی > down پیش‌فرض", { graceMs: 100, degradedAfterMs: 101 }],
    ["کلید ناشناخته", { graceMs: GRACE, policy: "x" }],
  ])("%s ⇒ INVALID_CONFIG", (_n, raw) => {
    const r = createSweepHealthCheck(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_CONFIG");
      expect(r.error.issues.length).toBeGreaterThan(0);
    }
  });
  it("آرایه‌ای که ویژگیِ graceMs دارد شیءِ ساده نیست ⇒ INVALID_CONFIG", () => {
    const r = createSweepHealthCheck(Object.assign([], { graceMs: GRACE }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues).toEqual(["پیکربندی باید یک شیء ساده باشد."]);
  });
  it("null پیکربندیِ نامعتبر با پیامِ «شیء ساده» است (نه خطای خواندن)", () => {
    const r = createSweepHealthCheck(null);
    expect(!r.ok && r.error.issues).toEqual(["پیکربندی باید یک شیء ساده باشد."]);
  });
  it("پیامِ مشکل دقیقاً همان فیلدِ معیوب را می‌گوید (نه خطای هم‌بسته‌ی دیگر)", () => {
    const issues = (raw: unknown): readonly string[] => {
      const r = createSweepHealthCheck(raw);
      return r.ok ? [] : r.error.issues;
    };
    expect(issues({ graceMs: GRACE, downAfterMs: 0 })).toEqual([`downAfterMs باید صحیح ۱ تا ${SETTLEMENT_LIMITS.maxGraceMs} باشد.`]);
    expect(issues({ graceMs: GRACE, degradedAfterMs: 0 })).toEqual([`degradedAfterMs باید صحیح ۱ تا ${SETTLEMENT_LIMITS.maxGraceMs} باشد.`]);
    expect(issues({ graceMs: GRACE, degradedAfterMs: SETTLEMENT_LIMITS.maxGraceMs + 1, downAfterMs: SETTLEMENT_LIMITS.maxGraceMs })).toEqual([`degradedAfterMs باید صحیح ۱ تا ${SETTLEMENT_LIMITS.maxGraceMs} باشد.`]);
    expect(issues({ graceMs: GRACE, downAfterMs: SETTLEMENT_LIMITS.maxGraceMs + 1 })).toEqual([`downAfterMs باید صحیح ۱ تا ${SETTLEMENT_LIMITS.maxGraceMs} باشد.`]);
    expect(issues({ graceMs: GRACE, degradedAfterMs: 10, downAfterMs: 9 })).toEqual(["degradedAfterMs نباید از downAfterMs بیشتر باشد."]);
  });
  it("مشکل‌ها نامِ فیلد را می‌برند نه مقدار را", () => {
    const r = createSweepHealthCheck({ graceMs: CANARY, downAfterMs: CANARY });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(JSON.stringify(r.error)).not.toContain(CANARY);
      expect(r.error.issues.some((i) => i.startsWith("graceMs"))).toBe(true);
      expect(r.error.issues.some((i) => i.startsWith("downAfterMs"))).toBe(true);
    }
  });
  it("getter و Proxyِ بدجنس در پیکربندی ⇒ INVALID_CONFIG بی‌پرتاب", () => {
    const evil = { graceMs: GRACE };
    Object.defineProperty(evil, "downAfterMs", { get: () => { throw new Error(CANARY); }, enumerable: true });
    const a = createSweepHealthCheck(evil);
    expect(a.ok).toBe(false);
    const b = createSweepHealthCheck(new Proxy({}, { get: () => { throw new Error(CANARY); }, ownKeys: () => { throw new Error(CANARY); } }));
    expect(b.ok).toBe(false);
    expect(JSON.stringify([a, b])).not.toContain(CANARY);
  });
  it("ارزیاب منجمد است و دو ارزیاب از هم مستقل‌اند", () => {
    const a = mk({ graceMs: 100 });
    const b = mk({ graceMs: 200 });
    expect(Object.isFrozen(a)).toBe(true);
    expect(ev(a, st()).downAfterMs).toBe(100);
    expect(ev(b, st()).downAfterMs).toBe(200);
  });
});

describe("ارزیابِ سلامت · قاعده‌ها", () => {
  const c = mk();
  it("حلقهٔ سالم و تازه ⇒ ok، بی‌دلیل، سکوتِ صفر", () => {
    const h = ev(c, st());
    expect(h.status).toBe("ok");
    expect(h.reasons).toEqual([]);
    expect(h.silenceMs).toBe(0);
    expect(h.consecutiveFailures).toBe(0);
  });
  it.each<[string, number, HealthStatus]>([
    ["سکوت = نیمِ grace ⇒ ok", HALF, "ok"],
    ["سکوت = نیمِ grace + ۱ ⇒ degraded", HALF + 1, "degraded"],
    ["سکوت = grace ⇒ هنوز degraded", GRACE, "degraded"],
    ["سکوت = grace + ۱ ⇒ down", GRACE + 1, "down"],
    ["سکوتِ بسیار ⇒ down", 10 * GRACE, "down"],
  ])("%s", (_n, silence, status) => {
    const h = ev(c, st({ lastSuccessAtMs: NOW - silence }));
    expect(h.status).toBe(status);
    expect(h.silenceMs).toBe(silence);
    if (status !== "ok") expect(codes(h)).toEqual(["STALE_SUCCESS"]);
  });
  it("stopped ⇒ down فقط با LOOP_STOPPED (حتی با موفقیتِ تازه)", () => {
    const h = ev(c, st({ state: "stopped" }));
    expect([h.status, codes(h)]).toEqual(["down", ["LOOP_STOPPED"]]);
    expect(h.silenceMs).toBeNull();
  });
  it("stalled ⇒ down فقط با LOOP_STALLED", () => {
    const h = ev(c, st({ state: "stalled", consecutiveFailures: 3, lastFault: "SCHEDULE_FAILED" }));
    expect([h.status, codes(h)]).toEqual(["down", ["LOOP_STALLED"]]);
  });
  it("stopping ⇒ degraded با LOOP_STOPPING", () => {
    const h = ev(c, st({ state: "stopping" }));
    expect([h.status, codes(h)]).toEqual(["degraded", ["LOOP_STOPPING"]]);
  });
  it.each(FAULT_KINDS)("شکستِ پیاپی با آخرین شکستِ %s ⇒ degraded و کدِ شکست در دلیل", (kind) => {
    const h = ev(c, st({ consecutiveFailures: 2, lastFault: kind }));
    expect(h.status).toBe("degraded");
    expect(h.reasons).toEqual([{ code: "LOOP_FAULTING", severity: "degraded", fault: kind }]);
    expect(h.lastFault).toBe(kind);
    expect(h.consecutiveFailures).toBe(2);
  });
  it("شکستِ پیاپی بی‌lastFault ⇒ fault=null", () => {
    expect(ev(c, st({ consecutiveFailures: 1, lastFault: null })).reasons).toEqual([{ code: "LOOP_FAULTING", severity: "degraded", fault: null }]);
  });
  it("شکستِ قدیمی (consecutiveFailures=۰) سلامت را خراب نمی‌کند", () => {
    const h = ev(c, st({ consecutiveFailures: 0, lastFault: "LIST_FAILED" }));
    expect(h.status).toBe("ok");
    expect(h.lastFault).toBe("LIST_FAILED");
  });
  it("ترکیب: down پیش از degraded می‌آید، در هر سطح ترتیبِ قاعده‌ها", () => {
    const h = ev(c, st({ consecutiveFailures: 4, lastFault: "OUTBOX_FAILURES", lastSuccessAtMs: NOW - GRACE - 1 }));
    expect(h.status).toBe("down");
    expect(h.reasons.map((r) => [r.code, r.severity])).toEqual([["STALE_SUCCESS", "down"], ["LOOP_FAULTING", "degraded"]]);
  });
  it("busy و lastRunAtMs در حکم دخالتی ندارند (گذرِ آویزان با سکوتِ موفقیت گرفته می‌شود)", () => {
    const h = ev(c, st({ busy: true, lastRunAtMs: null, lastSuccessAtMs: NOW - GRACE - 1 }));
    expect([h.status, codes(h)]).toEqual(["down", ["STALE_SUCCESS"]]);
  });

  describe("sinceMs (آغاز)", () => {
    const fresh = (over: Record<string, unknown> = {}) => st({ runs: 0, lastRunAtMs: null, lastSuccessAtMs: null, ...over });
    it.each<[string, number, HealthStatus]>([
      ["آغازِ تازه ⇒ ok", 0, "ok"],
      ["سکوت = نیمِ grace ⇒ ok", HALF, "ok"],
      ["نیمِ grace + ۱ ⇒ degraded", HALF + 1, "degraded"],
      ["grace ⇒ degraded", GRACE, "degraded"],
      ["grace + ۱ ⇒ down", GRACE + 1, "down"],
    ])("هنوز موفق نشده: %s", (_n, silence, status) => {
      const h = ev(c, fresh(), NOW, NOW - silence);
      expect(h.status).toBe(status);
      expect(h.silenceMs).toBe(silence);
      if (status !== "ok") expect(codes(h)).toEqual(["NO_SUCCESS_SINCE_START"]);
    });
    it("آغازِ تازه‌تر از آخرین موفقیت (ریستارتِ حلقه) ⇒ سکوت از آغاز می‌شمارد", () => {
      const h = ev(c, st({ lastSuccessAtMs: NOW - 100_000 }), NOW, NOW - 100);
      expect([h.status, h.silenceMs]).toEqual(["ok", 100]);
    });
    it("آغازِ قدیمی‌تر از آخرین موفقیت ⇒ سکوت از موفقیت و کدِ STALE_SUCCESS", () => {
      const h = ev(c, st({ lastSuccessAtMs: NOW - HALF - 1 }), NOW, NOW - 100_000);
      expect([h.status, codes(h), h.silenceMs]).toEqual(["degraded", ["STALE_SUCCESS"], HALF + 1]);
    });
    it("برابریِ آغاز و آخرین موفقیت ⇒ STALE_SUCCESS", () => {
      expect(codes(ev(c, st({ lastSuccessAtMs: NOW - GRACE - 1 }), NOW, NOW - GRACE - 1))).toEqual(["STALE_SUCCESS"]);
    });
    it("sinceMs=null و undefined یکسان‌اند", () => {
      const s = st({ lastSuccessAtMs: NOW - 3 });
      expect(ev(c, s, NOW, null)).toEqual(ev(c, s, NOW));
    });
    it("بی‌مرجع: هنوز گذری نبوده ⇒ degraded با NOT_YET_RUN و سکوتِ نامعلوم", () => {
      const h = ev(c, fresh());
      expect([h.status, codes(h), h.silenceMs]).toEqual(["degraded", ["NOT_YET_RUN"], null]);
    });
    it("بی‌مرجع: گذرهایی بوده ولی هرگز موفق نشده ⇒ degraded با NO_SUCCESS_SINCE_START", () => {
      const h = ev(c, st({ runs: 3, lastSuccessAtMs: null, consecutiveFailures: 3, lastFault: "LIST_FAILED" }));
      expect([h.status, codes(h), h.silenceMs]).toEqual(["degraded", ["LOOP_FAULTING", "NO_SUCCESS_SINCE_START"], null]);
    });
  });

  describe("پرشِ ساعت", () => {
    it("ساعتِ پروب عقب‌تر از آخرین موفقیت ⇒ degraded با CLOCK_BEHIND و سکوتِ نامعلوم", () => {
      const h = ev(c, st({ lastSuccessAtMs: NOW + 1 }));
      expect([h.status, codes(h), h.silenceMs]).toEqual(["degraded", ["CLOCK_BEHIND"], null]);
    });
    it("برابر ⇒ سکوتِ صفر (CLOCK_BEHIND نیست)", () => {
      expect(ev(c, st({ lastSuccessAtMs: NOW })).silenceMs).toBe(0);
    });
    it("ساعتِ پروب عقب‌تر از sinceMs ⇒ CLOCK_BEHIND", () => {
      expect(codes(ev(c, st({ runs: 0, lastRunAtMs: null, lastSuccessAtMs: null }), NOW, NOW + 5))).toEqual(["CLOCK_BEHIND"]);
    });
  });

  it("آستانهٔ دستی بی‌باندِ degraded (degraded = down) ⇒ ok سپس مستقیم down", () => {
    const c5 = mk({ graceMs: GRACE, degradedAfterMs: 5, downAfterMs: 5 });
    expect(ev(c5, st({ lastSuccessAtMs: NOW - 5 })).status).toBe("ok");
    expect(ev(c5, st({ lastSuccessAtMs: NOW - 6 })).status).toBe("down");
  });
});

describe("ارزیابِ سلامت · ورودیِ بدجنس (بی‌پرتاب، شکستِ بسته، بی‌نشت)", () => {
  const c = mk();
  it.each<[string, unknown]>([["null", null], ["undefined", undefined], ["عدد", 5], ["رشته", "x"], ["آرایه", []], ["تابع", () => 1]])("ورودیِ %s ⇒ down با هر دو دلیل", (_n, input) => {
    const h = c.evaluate(input as never);
    expect(h.status).toBe("down");
    expect(codes(h)).toEqual(["STATUS_INVALID", "CLOCK_INVALID"]);
    expect([h.silenceMs, h.consecutiveFailures, h.lastFault]).toEqual([null, null, null]);
  });
  it.each<[string, unknown]>([
    ["status ندارد", undefined],
    ["status=null", null],
    ["status آرایه", []],
    ["status رشته", "running"],
    ["state ناشناخته", st({ state: "weird" })],
    ["state ندارد", st({ state: undefined })],
    ["state عدد", st({ state: 1 })],
    ["state از prototype (toString)", st({ state: "toString" })],
    ["runs منفی", st({ runs: -1 })],
    ["runs اعشاری", st({ runs: 1.5 })],
    ["runs رشته", st({ runs: "3" })],
    ["runs NaN", st({ runs: NaN })],
    ["runs ناایمن", st({ runs: Number.MAX_SAFE_INTEGER + 2 })],
    ["runs ندارد", st({ runs: undefined })],
    ["consecutiveFailures منفی", st({ consecutiveFailures: -1 })],
    ["consecutiveFailures اعشاری", st({ consecutiveFailures: 0.5 })],
    ["consecutiveFailures ندارد", st({ consecutiveFailures: undefined })],
    ["lastSuccessAtMs ندارد (undefined)", st({ lastSuccessAtMs: undefined })],
    ["lastSuccessAtMs منفی", st({ lastSuccessAtMs: -1 })],
    ["lastSuccessAtMs NaN", st({ lastSuccessAtMs: NaN })],
    ["lastSuccessAtMs رشته", st({ lastSuccessAtMs: "1" })],
    ["lastSuccessAtMs اعشاری", st({ lastSuccessAtMs: 1.5 })],
    ["lastFault ناشناخته", st({ lastFault: "BOGUS" })],
    ["lastFault ندارد (undefined)", st({ lastFault: undefined })],
    ["lastFault از prototype", st({ lastFault: "constructor" })],
    ["lastFault شیء", st({ lastFault: {} })],
  ])("status نامعتبر: %s ⇒ down با STATUS_INVALID", (_n, status) => {
    const h = ev(c, status);
    expect(h.status).toBe("down");
    expect(codes(h)).toEqual(["STATUS_INVALID"]);
    expect([h.silenceMs, h.consecutiveFailures, h.lastFault]).toEqual([null, null, null]);
  });
  it.each<[string, unknown]>([["نبود", undefined], ["null", null], ["منفی", -1], ["NaN", NaN], ["بی‌نهایت", Infinity], ["اعشاری", 1.5], ["رشته", "5"], ["ناایمن", Number.MAX_SAFE_INTEGER + 2], ["BigInt", BigInt(5)]])("nowMs %s ⇒ down با CLOCK_INVALID (حالتِ status محفوظ)", (_n, now) => {
    const h = c.evaluate({ status: st({ consecutiveFailures: 2, lastFault: "LIST_FAILED" }), nowMs: now } as never); // مستقیم: پارامترِ پیش‌فرضِ ev جای undefined را می‌گیرد
    expect([h.status, codes(h)]).toEqual(["down", ["CLOCK_INVALID"]]);
    expect([h.consecutiveFailures, h.lastFault, h.silenceMs]).toEqual([2, "LIST_FAILED", null]);
  });
  it.each<[string, unknown]>([["منفی", -1], ["NaN", NaN], ["اعشاری", 1.5], ["رشته", "5"], ["شیء", {}], ["ناایمن", Number.MAX_SAFE_INTEGER + 2]])("sinceMs %s ⇒ down با CLOCK_INVALID", (_n, since) => {
    expect(codes(ev(c, st(), NOW, since))).toEqual(["CLOCK_INVALID"]);
    expect(ev(c, st(), NOW, since).status).toBe("down");
  });
  it("آرایه‌ای با ویژگی‌های ساختگی نه status معتبر است نه ورودیِ معتبر", () => {
    expect(codes(ev(c, Object.assign([], st())))).toEqual(["STATUS_INVALID"]);
    const h = c.evaluate(Object.assign([], { status: st(), nowMs: NOW }) as never);
    expect([h.status, codes(h)]).toEqual(["down", ["STATUS_INVALID", "CLOCK_INVALID"]]);
  });
  it("هر دو نامعتبر ⇒ هر دو دلیل، STATUS_INVALID اول", () => {
    expect(codes(ev(c, "x", NaN))).toEqual(["STATUS_INVALID", "CLOCK_INVALID"]);
  });
  it("nowMs=۰ و sinceMs=۰ معتبرند", () => {
    expect(ev(c, st({ lastSuccessAtMs: 0 }), 0, 0).status).toBe("ok");
  });
  it("getterِ پرتاب‌کننده روی ورودی، status یا فیلدی ⇒ down بی‌پرتاب و بی‌نشت", () => {
    const boom = (): never => {
      throw new Error(CANARY);
    };
    const onInput = { nowMs: NOW } as Record<string, unknown>;
    Object.defineProperty(onInput, "status", { get: boom, enumerable: true });
    const statusEvil = st();
    Object.defineProperty(statusEvil, "state", { get: boom, enumerable: true });
    const nowEvil = { status: st() } as Record<string, unknown>;
    Object.defineProperty(nowEvil, "nowMs", { get: boom, enumerable: true });
    const outs = [c.evaluate(onInput as never), ev(c, statusEvil), c.evaluate(nowEvil as never)];
    for (const h of outs) expect(h.status).toBe("down");
    expect(JSON.stringify(outs)).not.toContain(CANARY);
  });
  it("Proxyِ بدجنس (حتی لغوشده) ⇒ down بی‌پرتاب", () => {
    const evil = new Proxy({}, { get: boom, has: boom, ownKeys: boom, getOwnPropertyDescriptor: boom, getPrototypeOf: boom });
    expect(c.evaluate(evil as never).status).toBe("down");
    expect(ev(c, evil).status).toBe("down");
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(c.evaluate(proxy as never).status).toBe("down");
    expect(ev(c, proxy).status).toBe("down");
    function boom(): never {
      throw new Error(CANARY);
    }
  });
  it("فیلدهای اضافهٔ ورودی و status (پیام، کلید، totals) هرگز به نتیجه نمی‌رسند", () => {
    const h = c.evaluate({ status: st({ secret: CANARY, totals: { x: CANARY }, deadLetters: { y: CANARY } }), nowMs: NOW, sinceMs: null, extra: CANARY } as never);
    expect(JSON.stringify(h)).not.toContain(CANARY);
    expect(Object.keys(h).sort()).toEqual(["consecutiveFailures", "degradedAfterMs", "downAfterMs", "lastFault", "reasons", "silenceMs", "status"]);
  });
  it("lastFaultِ نامعتبر حاوی متن ⇒ STATUS_INVALID بی‌نشتِ متن", () => {
    const h = ev(c, st({ lastFault: CANARY }));
    expect(codes(h)).toEqual(["STATUS_INVALID"]);
    expect(JSON.stringify(h)).not.toContain(CANARY);
  });
  it("ورودی دست‌نخورده می‌ماند و ورودیِ منجمد پذیرفته می‌شود", () => {
    const input = Object.freeze({ status: Object.freeze(st({ consecutiveFailures: 1, lastFault: "LIST_FAILED" })), nowMs: NOW });
    const before = JSON.stringify(input);
    c.evaluate(input as never);
    expect(JSON.stringify(input)).toBe(before);
  });
  it("نتیجه منجمد، JSON-پذیر و با شکلِ ثابت است", () => {
    const h = ev(c, st({ consecutiveFailures: 1, lastFault: "LIST_FAILED", lastSuccessAtMs: NOW - HALF - 1 }));
    expect(Object.isFrozen(h)).toBe(true);
    expect(Object.isFrozen(h.reasons)).toBe(true);
    for (const r of h.reasons) {
      expect(Object.isFrozen(r)).toBe(true);
      expect(Object.keys(r).sort()).toEqual(["code", "fault", "severity"]);
    }
    expect(JSON.parse(JSON.stringify(h))).toEqual(h);
    expect(() => ((h as { status: string }).status = "ok")).toThrow();
  });
  it("دو فراخوانیِ پیاپی نتیجهٔ برابر و شیءِ جدا می‌دهند (بی‌حالت)", () => {
    const s = st({ lastSuccessAtMs: NOW - HALF - 1 });
    const a = ev(c, s);
    const b = ev(c, s);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe("sweepHealthHttpStatus", () => {
  const c = mk();
  it("ok و degraded ⇒ ۲۰۰؛ down ⇒ ۵۰۳", () => {
    expect(sweepHealthHttpStatus(ev(c, st()))).toBe(200);
    expect(sweepHealthHttpStatus(ev(c, st({ state: "stopping" })))).toBe(200);
    expect(sweepHealthHttpStatus(ev(c, st({ state: "stopped" })))).toBe(503);
    expect(sweepHealthHttpStatus(ev(c, "x"))).toBe(503);
  });
  it.each<[string, unknown]>([["null", null], ["undefined", undefined], ["رشتهٔ ok", "ok"], ["شیء خالی", {}], ["حروفِ بزرگ", { status: "OK" }], ["ناشناخته", { status: "fine" }], ["آرایه", ["ok"]], ["عدد", 200]])("نتیجهٔ خراب (%s) ⇒ ۵۰۳ (شکستِ بسته)", (_n, v) => {
    expect(sweepHealthHttpStatus(v as never)).toBe(503);
  });
  it("Proxyِ بدجنس ⇒ ۵۰۳ بی‌پرتاب", () => {
    const evil = new Proxy({}, { get: () => { throw new Error(CANARY); } });
    expect(sweepHealthHttpStatus(evil as never)).toBe(503);
  });
});

// ───────────────────────── خاصیتی در برابر مدلِ مرجعِ مستقل ─────────────────────────

type Sev = "degraded" | "down";
/** مرجعِ مستقل: با فهرستِ جفت‌ها و «نمره» (۰ ok، ۱ degraded، ۲ down) نوشته شده، نه با ساختارِ پیاده‌سازی. */
function model(th: { d: number; u: number }, s: { state: string; runs: number; cf: number; ok: number | null; fault: string | null }, now: number, since: number | null): Array<[string, Sev]> {
  if (s.state === "stopped") return [["LOOP_STOPPED", "down"]];
  if (s.state === "stalled") return [["LOOP_STALLED", "down"]];
  if (s.state === "stopping") return [["LOOP_STOPPING", "degraded"]];
  const downs: Array<[string, Sev]> = [];
  const degs: Array<[string, Sev]> = [];
  if (s.cf > 0) degs.push(["LOOP_FAULTING", "degraded"]);
  const candidates = [s.ok, since].filter((x): x is number => x !== null);
  if (candidates.length === 0) degs.push([s.runs === 0 ? "NOT_YET_RUN" : "NO_SUCCESS_SINCE_START", "degraded"]);
  else {
    const ref = Math.max(...candidates);
    const fromSuccess = s.ok !== null && s.ok >= (since ?? -1);
    const label = fromSuccess ? "STALE_SUCCESS" : "NO_SUCCESS_SINCE_START";
    const age = now - ref;
    if (age < 0) degs.push(["CLOCK_BEHIND", "degraded"]);
    else if (age > th.u) downs.push([label, "down"]);
    else if (age > th.d) degs.push([label, "degraded"]);
  }
  return [...downs, ...degs];
}

describe("ارزیابِ سلامت · خاصیتی (مرجعِ مستقل)", () => {
  it("۴۰ بذر × ۵۰۰ مورد: دلیل‌ها و وضعیت با مدلِ مرجع یکی است (مرزها عمداً پرتکرار)", () => {
    let boundary = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed * 7919);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
      for (let i = 0; i < 500; i++) {
        const grace = 2 + Math.floor(r() * 60);
        const d = 1 + Math.floor(r() * grace);
        const u = d + Math.floor(r() * (grace + 5));
        const useDefault = r() < 0.4;
        const check = mk(useDefault ? { graceMs: grace } : { graceMs: grace, degradedAfterMs: d, downAfterMs: u });
        const th = useDefault ? { d: Math.floor(grace / 2), u: grace } : { d, u };
        const base = 1000 + Math.floor(r() * 1000);
        const ok = r() < 0.25 ? null : base + Math.floor(r() * 20);
        const since = r() < 0.4 ? null : base + Math.floor(r() * 20);
        const ref = Math.max(ok ?? -1, since ?? -1);
        const edge = pick([-1, 0, 1, th.d - 1, th.d, th.d + 1, th.u - 1, th.u, th.u + 1, Math.floor(r() * (th.u + 10))]);
        const now = Math.max(0, (ref < 0 ? base : ref) + edge);
        if (ref >= 0 && [th.d, th.d + 1, th.u, th.u + 1].includes(now - ref)) boundary++;
        const s = { state: pick(["running", "running", "running", "running", "stopped", "stalled", "stopping"]), runs: ok === null && r() < 0.5 ? 0 : 1 + Math.floor(r() * 9), cf: r() < 0.5 ? 0 : 1 + Math.floor(r() * 4), ok, fault: r() < 0.5 ? null : pick(FAULT_KINDS) };
        const h = check.evaluate({ status: st({ state: s.state, runs: s.runs, consecutiveFailures: s.cf, lastSuccessAtMs: s.ok, lastFault: s.fault }), nowMs: now, sinceMs: since } as never);
        const want = model(th, s, now, since);
        const ctx = JSON.stringify({ seed, i, th, s, now, since });
        expect(h.reasons.map((x) => [x.code, x.severity]), ctx).toEqual(want);
        expect(h.status, ctx).toBe(want.length === 0 ? "ok" : want.some((w) => w[1] === "down") ? "down" : "degraded");
        const fault = h.reasons.find((x) => x.code === "LOOP_FAULTING")?.fault;
        if (fault !== undefined) expect(fault, ctx).toBe(s.fault);
      }
    }
    expect(boundary).toBeGreaterThan(2000); // آزمون واقعاً مرزها را می‌زند
  });

  it("یکنوایی: با ثابت‌ماندنِ وضعیت و now ≥ مرجع، جلو رفتنِ ساعت هرگز سلامت را بهتر نمی‌کند", () => {
    const rank: Record<HealthStatus, number> = { ok: 0, degraded: 1, down: 2 };
    for (let seed = 1; seed <= 30; seed++) {
      const r = rng(seed * 104729);
      for (let i = 0; i < 60; i++) {
        const grace = 2 + Math.floor(r() * 80);
        const check = mk({ graceMs: grace });
        const ok = r() < 0.3 ? null : 1000 + Math.floor(r() * 50);
        const since = r() < 0.5 ? null : 1000 + Math.floor(r() * 50);
        const ref = Math.max(ok ?? 0, since ?? 0, 1049);
        const status = st({ lastSuccessAtMs: ok, consecutiveFailures: r() < 0.5 ? 0 : 2, lastFault: "LIST_FAILED", runs: ok === null ? 0 : 3 });
        let prev = -1;
        for (let t = ref; t <= ref + 3 * grace + 5; t += 1 + Math.floor(r() * 5)) {
          const h = check.evaluate({ status, nowMs: t, sinceMs: since } as never);
          expect(rank[h.status], `seed ${seed} i ${i} t ${t}`).toBeGreaterThanOrEqual(prev);
          prev = rank[h.status];
        }
      }
    }
  });

  it("فازِ ۱۰۰۰ورودیِ آشفته (BigInt، Symbol، تابع، شیء، آرایه): هرگز نمی‌پرتابد و همیشه نتیجهٔ سازگار و منجمد می‌دهد", () => {
    const junk: unknown[] = [undefined, null, 0, 1, -1, 1.5, NaN, Infinity, "", "running", "x".repeat(1000), BigInt(5), Symbol("s"), () => 1, {}, [], [1], new Date(0), /x/, new Map(), true, false, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1];
    const goodStatus = st();
    const r = rng(2024);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
    const c = mk();
    for (let i = 0; i < 1000; i++) {
      const status = r() < 0.5 ? pick(junk) : Object.fromEntries(Object.entries(goodStatus).map(([k, v]) => [k, r() < 0.3 ? pick(junk) : v]));
      const input = r() < 0.1 ? pick(junk) : { status, nowMs: r() < 0.7 ? NOW : pick(junk), sinceMs: r() < 0.7 ? undefined : pick(junk) };
      const h = c.evaluate(input as never);
      const ctx = `i=${i}`;
      expect(["ok", "degraded", "down"], ctx).toContain(h.status);
      expect(Object.isFrozen(h), ctx).toBe(true);
      expect(h.status === "ok", ctx).toBe(h.reasons.length === 0);
      expect(h.status === "down", ctx).toBe(h.reasons.some((x) => x.severity === "down"));
      expect(() => JSON.stringify(h), ctx).not.toThrow();
      expect(sweepHealthHttpStatus(h), ctx).toBe(h.status === "down" ? 503 : 200);
    }
  });

  it("شکستِ بسته: هر ورودیِ نامعتبرِ جداگانه (از میانِ فیلدهای لازم) هرگز ok نمی‌دهد", () => {
    const c = mk();
    const bad: Record<string, unknown[]> = {
      state: [undefined, "x", 1],
      runs: [undefined, -1, 1.5, "1"],
      consecutiveFailures: [undefined, -1, "0"],
      lastSuccessAtMs: [undefined, -1, "1", 1.5],
      lastFault: [undefined, "x", 1],
    };
    for (const [field, values] of Object.entries(bad)) for (const v of values) expect(ev(c, st({ [field]: v })).status, `${field}=${String(v)}`).toBe("down");
  });
});

// ───────────────────────── یکپارچگی با حلقهٔ واقعی ─────────────────────────

const INTERVAL = HALF; // بیشینهٔ فاصلهٔ مجازِ حلقه (ADR-0023): آستانه‌های پیش‌فرض باید حتی با آن «ok» بمانند.

function rig(step: (n: number) => unknown, over: Record<string, unknown> = {}) {
  const timer = manualTimer();
  const sw = fakeSweeper(step);
  const made = createSweepLoop({ sweeper: sw, timer, clock: timer.clock, graceMs: GRACE, intervalMs: 1000, ...over });
  if (!made.ok) throw new Error("پیکربندیِ حلقه");
  const check = mk();
  const loop = made.value;
  const sinceRef = { ms: null as number | null };
  const probe = (): SweepHealth => check.evaluate({ status: loop.status(), nowMs: timer.now(), sinceMs: sinceRef.ms });
  const start = () => {
    const r = loop.start();
    if (r.started) sinceRef.ms = timer.now();
    return r;
  };
  return { loop, timer, sw, probe, start, sinceRef };
}
const idle = () => sweepReport();

describe("ارزیابِ سلامت · با حلقهٔ واقعی", () => {
  it("حلقهٔ ساخته‌شده ولی نشروع ⇒ down (LOOP_STOPPED)؛ پس از start و نخستین گذر ⇒ ok", async () => {
    const x = rig(idle);
    expect(codes(x.probe())).toEqual(["LOOP_STOPPED"]);
    x.start();
    expect(x.probe().status).toBe("ok"); // آغازِ تازه (هنوز گذری نبوده)
    await x.timer.advance(1);
    const h = x.probe();
    expect([h.status, h.reasons.length]).toEqual(["ok", 0]);
    expect(h.consecutiveFailures).toBe(0);
  });
  it("شکستِ پیاپی: نخست degraded (LOOP_FAULTING با نوعِ شکست)، پس از grace/2 ماندنِ بی‌موفقیت STALE، پس از grace down؛ بهبود ⇒ دوباره ok", async () => {
    let healthy = false;
    const x = rig(() => (healthy ? sweepReport() : sweepReport({ listFailed: true })));
    x.start();
    await x.timer.advance(1); // گذرِ اول: شکست
    let h = x.probe();
    expect([h.status, h.reasons]).toEqual(["degraded", [{ code: "LOOP_FAULTING", severity: "degraded", fault: "LIST_FAILED" }]]);
    expect(h.consecutiveFailures).toBeGreaterThan(0);
    await x.timer.advance(HALF + 1);
    h = x.probe();
    expect(h.status).toBe("degraded");
    expect(codes(h)).toEqual(["LOOP_FAULTING", "NO_SUCCESS_SINCE_START"]);
    await x.timer.advance(HALF + 1);
    h = x.probe();
    expect([h.status, codes(h)]).toEqual(["down", ["NO_SUCCESS_SINCE_START", "LOOP_FAULTING"]]);
    expect(sweepHealthHttpStatus(h)).toBe(503);
    healthy = true;
    await x.timer.advance(HALF + 5); // عقب‌نشینی ≤ grace/2 ⇒ گذرِ بعد می‌رسد
    h = x.probe();
    expect([h.status, h.reasons.length, h.consecutiveFailures]).toEqual(["ok", 0, 0]);
  });
  it("stop ⇒ down (LOOP_STOPPED)؛ start دوباره ⇒ سکوت از آغازِ تازه (ok)", async () => {
    const x = rig(idle);
    x.start();
    await x.timer.advance(5000);
    expect(x.probe().status).toBe("ok");
    expect((await x.loop.stop()).clean).toBe(true);
    expect(codes(x.probe())).toEqual(["LOOP_STOPPED"]);
    await x.timer.advance(GRACE * 3); // مدتی خاموش
    x.start();
    const h = x.probe();
    expect([h.status, h.silenceMs]).toEqual(["ok", 0]);
    await x.timer.advance(1);
    expect(x.probe().status).toBe("ok");
  });
  it("خرابیِ زمان‌سنج در میانهٔ کار ⇒ stalled ⇒ down (LOOP_STALLED)", async () => {
    const x = rig(idle);
    x.start();
    x.timer.failAfter(1); // زمان‌بندیِ گذرِ بعد می‌پرتابد
    await x.timer.advance(1);
    expect(x.loop.status().state).toBe("stalled");
    const h = x.probe();
    expect([h.status, codes(h)]).toEqual(["down", ["LOOP_STALLED"]]);
  });
  it("هم‌خوانیِ آستانه‌ها با سقفِ فاصلهٔ حلقه: حلقهٔ سالم با گذرِ آنی و فاصلهٔ ⌊grace/2⌋ در هر لحظه (۲۰۰ نمونهٔ تصادفی) ok است (گذرِ کُند: ADR-0030 «محدودیت‌ها»)", async () => {
    const x = rig(idle, { intervalMs: INTERVAL });
    x.start();
    const r = rng(77);
    for (let i = 0; i < 200; i++) {
      await x.timer.advance(1 + Math.floor(r() * INTERVAL));
      const h = x.probe();
      expect(h.status, `i=${i} now=${x.timer.now()} silence=${h.silenceMs}`).toBe("ok");
    }
  });
  it("حلقهٔ واقعی زیرِ توالیِ تصادفیِ موفقیت/شکست/پرتاب: شکلِ status همیشه پذیرفته می‌شود (هرگز STATUS_INVALID/CLOCK_INVALID) و ok ⇒ سکوت ≤ grace/2", async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const r = rng(seed * 31);
      const x = rig((n) => {
        const k = Math.floor(r() * 6);
        if (k === 0) return sweepReport({ listFailed: true });
        if (k === 1) return sweepReport({ outboxFailures: 2 });
        if (k === 2) return new Error("sweeper boom");
        if (k === 3) return { not: "a report" };
        return sweepReport({ examined: n, settled: k === 4 ? 1 : 0 });
      });
      x.start();
      for (let i = 0; i < 80; i++) {
        await x.timer.advance(1 + Math.floor(r() * 4000));
        const h = x.probe();
        const ctx = `seed ${seed} i ${i}`;
        expect(codes(h), ctx).not.toContain("STATUS_INVALID");
        expect(codes(h), ctx).not.toContain("CLOCK_INVALID");
        if (h.status === "ok") expect(h.silenceMs ?? 0, ctx).toBeLessThanOrEqual(HALF);
        expect(x.loop.status().consecutiveFailures > 0, ctx).toBe(codes(h).includes("LOOP_FAULTING"));
      }
    }
  });
});
