/**
 * settlement-backlog · ارزیابِ خالص (ADR-0039): هر قاعده، مرزهای دقیقِ `>`/`≥`، ترتیبِ دلیل‌ها، شکستِ بسته روی نمونهٔ ناسازگار،
 * بی‌نشت، بی‌پرتاب و مجموعِ `check()` با ساعت و outboxِ واقعی.
 */
import { describe, expect, it } from "vitest";
import { createMemoryOutbox } from "@/modules/settlement";
import type { BacklogHealth } from "./index";
import { REF, T0, TH, buryMany, manualClock, monitorOf, must } from "./test-kit";
import { createDeadLetterBacklogMonitor } from "./index";

const NOW = T0;
const BY = { EXPIRED_UNBILLED: 0, ATTEMPTS_EXHAUSTED: 0, LEDGER_REJECTED: 0 };
/** نمونهٔ سالمِ معتبر: `count` مرده با قدیمی‌ترینِ `oldest`. */
const sample = (over: Record<string, unknown> = {}): Record<string, unknown> => {
  const count = typeof over["count"] === "number" ? over["count"] : 0;
  return { ok: true, atMs: NOW, count, truncated: count === TH.sampleLimit, oldestDeadAtMs: count === 0 ? null : NOW - 10, undated: 0, byReason: { ...BY, ATTEMPTS_EXHAUSTED: count }, ...over };
};
const ev = (s: unknown, nowMs: unknown = NOW): BacklogHealth => monitorOf().evaluate({ sample: s, nowMs });
const codes = (h: BacklogHealth): string[] => h.reasons.map((r) => r.code);

describe("settlement-backlog · ارزیابی: حالتِ سالم", () => {
  it("پسماندِ صفر ⇒ ok بی‌دلیل؛ همهٔ فیلدها پر و آستانه‌ها بازتاب", () => {
    const h = ev(sample());
    expect(h).toEqual({ status: "ok", reasons: [], count: 0, truncated: false, oldestAgeMs: null, sampleAgeMs: 0, byReason: BY, failure: null, thresholds: { degradedCount: 3, downCount: 5, degradedAfterMs: 1000, downAfterMs: 5000, sampleMaxAgeMs: 2000 } });
  });
  it("کمتر از آستانه و جوان ⇒ ok با سن‌های دقیق", () => {
    const h = ev(sample({ count: 2, oldestDeadAtMs: NOW - 400 }), NOW + 300);
    expect(h).toMatchObject({ status: "ok", reasons: [], count: 2, oldestAgeMs: 700, sampleAgeMs: 300 });
  });
  it("نتیجه و بخش‌هایش منجمد و JSON‌پذیرند", () => {
    const h = ev(sample({ count: 4 }));
    expect(Object.isFrozen(h) && Object.isFrozen(h.reasons) && Object.isFrozen(h.byReason) && Object.isFrozen(h.thresholds)).toBe(true);
    expect(Object.isFrozen(h.reasons[0])).toBe(true);
    expect(JSON.parse(JSON.stringify(h))).toEqual(h);
  });
});

describe("settlement-backlog · ارزیابی: شمار (≥)", () => {
  it.each([
    [0, "ok", []],
    [1, "ok", []],
    [2, "ok", []],
    [3, "degraded", ["COUNT_HIGH"]],
    [4, "degraded", ["COUNT_HIGH"]],
    [5, "down", ["COUNT_CRITICAL"]],
    [9, "down", ["COUNT_CRITICAL"]],
  ])("count=%i ⇒ %s %j (فقط یک دلیلِ شمار؛ critical جانشینِ high می‌شود)", (count, status, expected) => {
    const h = ev(sample({ count }));
    expect(h.status).toBe(status);
    expect(codes(h)).toEqual(expected);
  });
  it("فهرستِ بریده‌شده (count=سقف) همیشه دست‌کم down است چون downCount ≤ سقف", () => {
    const h = ev(sample({ count: 10 }));
    expect(h).toMatchObject({ status: "down", truncated: true, count: 10 });
    expect(codes(h)).toEqual(["COUNT_CRITICAL"]);
  });
  it("آستانه‌های برابر: degradedCount=downCount ⇒ در آستانه مستقیم down", () => {
    const m = monitorOf({ degradedCount: 4, downCount: 4 });
    expect(codes(m.evaluate({ sample: sample({ count: 3 }), nowMs: NOW }))).toEqual([]);
    expect(codes(m.evaluate({ sample: sample({ count: 4 }), nowMs: NOW }))).toEqual(["COUNT_CRITICAL"]);
  });
});

describe("settlement-backlog · ارزیابی: سنِ قدیمی‌ترین (>)", () => {
  const at = (age: number) => ev(sample({ count: 1, oldestDeadAtMs: NOW - age }));
  it.each([
    [0, "ok", []],
    [999, "ok", []],
    [1000, "ok", []],
    [1001, "degraded", ["OLDEST_AGED"]],
    [5000, "degraded", ["OLDEST_AGED"]],
    [5001, "down", ["OLDEST_STUCK"]],
    [900_000, "down", ["OLDEST_STUCK"]],
  ])("سن=%i ⇒ %s %j (مرز اکیداً «>»)", (age, status, expected) => {
    const h = at(age);
    expect(h.status).toBe(status);
    expect(codes(h)).toEqual(expected);
    expect(h.oldestAgeMs).toBe(age);
  });
  it("با ثابتِ نمونه، جلو رفتنِ ساعت از ok به degraded و down می‌برد (همان مرزها)", () => {
    const s = sample({ count: 1, oldestDeadAtMs: NOW });
    const m = monitorOf({ sampleMaxAgeMs: 10_000_000 });
    const at2 = (d: number) => m.evaluate({ sample: s, nowMs: NOW + d });
    expect(at2(1000).status).toBe("ok");
    expect(at2(1001).status).toBe("degraded");
    expect(at2(5000).status).toBe("degraded");
    expect(at2(5001).status).toBe("down");
  });
  it("زمانِ مرگِ صفر معتبر است", () => {
    expect(ev(sample({ count: 1, oldestDeadAtMs: 0 }), 5001).reasons.map((r) => r.code)).toContain("OLDEST_STUCK");
  });
});

describe("settlement-backlog · ارزیابی: تازگیِ نمونه (>)", () => {
  it.each([
    [0, []],
    [2000, []],
    [2001, ["SAMPLE_STALE"]],
    [60_000, ["SAMPLE_STALE"]],
  ])("نمونه با سنِ %i ⇒ %j", (age, expected) => {
    const h = ev(sample({ atMs: NOW - age, oldestDeadAtMs: null, count: 0 }), NOW);
    expect(codes(h)).toEqual(expected);
    expect(h.status).toBe(expected.length === 0 ? "ok" : "degraded");
    expect(h.sampleAgeMs).toBe(age);
  });
  it("نمونهٔ کهنه، پسماندِ صفر را «سالم» اعلام نمی‌کند", () => {
    expect(ev(sample({ atMs: 0 }), 10 ** 9).status).toBe("degraded");
  });
});

describe("settlement-backlog · ارزیابی: ساعتِ عقب‌مانده و بی‌زمان", () => {
  it("ساعت پیش از نمونه ⇒ CLOCK_BEHIND degraded و سنِ نمونه null", () => {
    const h = ev(sample(), NOW - 1);
    expect(h).toMatchObject({ status: "degraded", sampleAgeMs: null });
    expect(codes(h)).toEqual(["CLOCK_BEHIND"]);
  });
  it("برابری (سنِ صفر) عقب‌ماندگی نیست؛ یک میلی‌ثانیه کمتر هست", () => {
    expect(codes(ev(sample({ count: 1, oldestDeadAtMs: NOW }), NOW))).toEqual([]);
    expect(codes(ev(sample({ count: 1, oldestDeadAtMs: NOW + 1, atMs: NOW - 5 }), NOW))).toEqual(["CLOCK_BEHIND"]);
  });
  it("زمانِ مرگ در آینده ⇒ CLOCK_BEHIND و oldestAgeMs=null (سنِ منفی گزارش نمی‌شود)", () => {
    const h = ev(sample({ count: 1, oldestDeadAtMs: NOW + 50 }));
    expect(h.oldestAgeMs).toBeNull();
    expect(codes(h)).toEqual(["CLOCK_BEHIND"]);
  });
  it("هر دو عقب‌ماندگی فقط یک دلیلِ CLOCK_BEHIND می‌دهند", () => {
    expect(codes(ev(sample({ count: 1, oldestDeadAtMs: NOW + 50 }), NOW - 10))).toEqual(["CLOCK_BEHIND"]);
  });
  it("مردهٔ بی‌زمانِ مرگ ⇒ AGE_UNKNOWN degraded", () => {
    const h = ev(sample({ count: 1, undated: 1, oldestDeadAtMs: null }));
    expect(h).toMatchObject({ status: "degraded", oldestAgeMs: null });
    expect(codes(h)).toEqual(["AGE_UNKNOWN"]);
  });
  it("بی‌زمان کنارِ تاریخ‌دارِ قدیمی: هر دو دلیل می‌آیند", () => {
    const h = ev(sample({ count: 2, undated: 1, oldestDeadAtMs: NOW - 9000, byReason: { ...BY, LEDGER_REJECTED: 2 } }));
    expect(codes(h)).toEqual(["OLDEST_STUCK", "AGE_UNKNOWN"]);
  });
});

describe("settlement-backlog · ارزیابی: نمونهٔ ناخوانا", () => {
  it.each(["CLOCK_INVALID", "LIST_FAILED", "BAD_LIST", "TIMEOUT"])("شکستِ %s ⇒ SAMPLE_UNREADABLE degraded با failure (هرگز ok و هرگز ۵۰۳)", (code) => {
    const h = ev({ ok: false, atMs: NOW, code });
    expect(h).toEqual({ status: "degraded", reasons: [{ code: "SAMPLE_UNREADABLE", severity: "degraded" }], count: null, truncated: null, oldestAgeMs: null, sampleAgeMs: null, byReason: null, failure: code, thresholds: h.thresholds });
  });
  it("atMs=null (ساعتِ خراب) هم پذیرفته است", () => {
    expect(ev({ ok: false, atMs: null, code: "CLOCK_INVALID" }).status).toBe("degraded");
  });
  it.each([
    ["کدِ ناشناخته", { ok: false, atMs: NOW, code: "WHATEVER" }],
    ["کدِ prototype", { ok: false, atMs: NOW, code: "toString" }],
    ["بی‌کد", { ok: false, atMs: NOW }],
    ["atMs منفی", { ok: false, atMs: -1, code: "TIMEOUT" }],
    ["atMs ناموجود", { ok: false, code: "TIMEOUT" }],
  ])("نمونهٔ ناموفقِ بدشکل (%s) ⇒ INPUT_INVALID down", (_n, s) => {
    expect(codes(ev(s))).toEqual(["INPUT_INVALID"]);
  });
});

describe("settlement-backlog · ارزیابی: ترتیب و ترکیبِ دلیل‌ها", () => {
  it("همهٔ دلیل‌ها: down ها اول و ترتیبِ قاعده‌ها در هر سطح پایدار", () => {
    const h = ev(sample({ count: 6, atMs: NOW - 9_000, oldestDeadAtMs: NOW - 9_000 - 6_000, undated: 1, byReason: { ...BY, EXPIRED_UNBILLED: 6 } }), NOW);
    expect(h.reasons).toEqual([
      { code: "COUNT_CRITICAL", severity: "down" },
      { code: "OLDEST_STUCK", severity: "down" },
      { code: "SAMPLE_STALE", severity: "degraded" },
      { code: "AGE_UNKNOWN", severity: "degraded" },
    ]);
    expect(h.status).toBe("down");
  });
  it("degraded‌ها: ترتیبِ STALE، COUNT_HIGH، OLDEST_AGED", () => {
    const h = ev(sample({ count: 3, atMs: NOW - 3_000, oldestDeadAtMs: NOW - 3_000 - 1_500 }), NOW);
    expect(codes(h)).toEqual(["SAMPLE_STALE", "COUNT_HIGH", "OLDEST_AGED"]);
    expect(h.status).toBe("degraded");
  });
  it("وضعیت = شدیدترین دلیل (یک down بس است)", () => {
    expect(ev(sample({ count: 1, oldestDeadAtMs: NOW - 6000 })).status).toBe("down");
  });
});

describe("settlement-backlog · ارزیابی: ورودیِ نامعتبر ⇒ down (شکستِ بسته)", () => {
  const bad = (input: unknown) => monitorOf().evaluate(input);
  it.each([undefined, null, 5, "x", [], () => 1])("ورودیِ غیرشیء %j ⇒ INPUT_INVALID", (input) => {
    const h = bad(input);
    expect(h).toMatchObject({ status: "down", reasons: [{ code: "INPUT_INVALID", severity: "down" }], count: null, truncated: null, oldestAgeMs: null, sampleAgeMs: null, byReason: null, failure: null });
  });
  it.each([[undefined], [null], [-1], [1.5], ["5"], [Number.NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1]])("nowMs=%j ⇒ INPUT_INVALID (حتی با نمونهٔ سالم)", (nowMs) => {
    expect(codes(monitorOf().evaluate({ sample: sample(), nowMs }))).toEqual(["INPUT_INVALID"]);
  });
  it("nowMs اصلاً داده نشود ⇒ INPUT_INVALID", () => {
    expect(codes(monitorOf().evaluate({ sample: sample() }))).toEqual(["INPUT_INVALID"]);
  });
  it.each([
    ["غیرشیء", 5],
    ["ناموجود", undefined],
    ["ok غیربولی", { ...sample(), ok: "true" }],
    ["atMs منفی", sample({ atMs: -1 })],
    ["atMs اعشاری", sample({ atMs: 1.5 })],
    ["count منفی", sample({ count: -1 })],
    ["count اعشاری", sample({ count: 1.5 })],
    ["count بیش از سقف", sample({ count: 11, truncated: false, byReason: { ...BY, ATTEMPTS_EXHAUSTED: 11 } })],
    ["truncated نادرست (به سقف رسیده)", sample({ count: 10, truncated: false })],
    ["truncated نادرست (به سقف نرسیده)", sample({ count: 4, truncated: true })],
    ["truncated غیربولی", sample({ truncated: 0 })],
    ["undated بیش از count", sample({ count: 1, undated: 2 })],
    ["undated منفی", sample({ undated: -1 })],
    ["oldest null با رکوردِ تاریخ‌دار", sample({ count: 2, oldestDeadAtMs: null })],
    ["oldest مقداردار بی‌رکوردِ تاریخ‌دار", sample({ count: 1, undated: 1, oldestDeadAtMs: NOW })],
    ["oldest منفی", sample({ count: 1, oldestDeadAtMs: -5 })],
    ["oldest غیرعدد", sample({ count: 1, oldestDeadAtMs: "5" })],
    ["byReason ناموجود", sample({ byReason: undefined })],
    ["byReason غیرشیء", sample({ byReason: [] })],
    ["byReason کلیدِ کم", sample({ byReason: { EXPIRED_UNBILLED: 0, ATTEMPTS_EXHAUSTED: 0 } })],
    ["byReason کلیدِ اضافه", sample({ byReason: { ...BY, EXTRA: 0 } })],
    ["byReason مقدارِ منفی", sample({ count: 0, byReason: { ...BY, LEDGER_REJECTED: -1 } })],
    ["byReason مقدارِ اعشاری", sample({ byReason: { ...BY, LEDGER_REJECTED: 0.5 } })],
    ["byReason مقدارِ منفی با جمعِ درست", sample({ count: 1, byReason: { EXPIRED_UNBILLED: -1, ATTEMPTS_EXHAUSTED: 2, LEDGER_REJECTED: 0 } })],
    ["byReason مقدارهای اعشاری با جمعِ درست", sample({ count: 1, byReason: { EXPIRED_UNBILLED: 0.5, ATTEMPTS_EXHAUSTED: 0.5, LEDGER_REJECTED: 0 } })],
    ["جمعِ byReason ≠ count", sample({ count: 2, byReason: { ...BY, LEDGER_REJECTED: 1 } })],
  ])("نمونهٔ %s ⇒ INPUT_INVALID", (_n, s) => {
    expect(codes(ev(s))).toEqual(["INPUT_INVALID"]);
    expect(ev(s).status).toBe("down");
  });
  it("Proxy/getterِ بدجنس ⇒ INPUT_INVALID بی‌پرتاب و بی‌نشتِ پیام", () => {
    const evil = new Proxy({}, { get() { throw new Error("evil-secret"); } });
    for (const input of [evil, { sample: evil, nowMs: NOW }, { sample: sample(), get nowMs(): number { throw new Error("evil-secret"); } }]) {
      const h = bad(input);
      expect(codes(h)).toEqual(["INPUT_INVALID"]);
      expect(JSON.stringify(h)).not.toContain("evil-secret");
    }
  });
});

describe("settlement-backlog · ارزیابی: بی‌نشت و بی‌اثر", () => {
  it("فیلدهای اضافهٔ نمونه/ورودی هرگز به نتیجه نمی‌رسند", () => {
    const s = { ...sample({ count: 1 }), tenantId: "TENANT-SECRET", reservationId: "RES-SECRET", reserved: 987654, byReason: { ...BY, ATTEMPTS_EXHAUSTED: 1 } };
    const h = monitorOf().evaluate({ sample: s, nowMs: NOW, password: "PW-SECRET" });
    const json = JSON.stringify(h);
    for (const secret of ["TENANT-SECRET", "RES-SECRET", "987654", "PW-SECRET"]) expect(json).not.toContain(secret);
    expect(Object.keys(h).sort()).toEqual(["byReason", "count", "failure", "oldestAgeMs", "reasons", "sampleAgeMs", "status", "thresholds", "truncated"]);
  });
  it("ورودی را تغییر نمی‌دهد و نتیجه اشتراکِ شیء با آن ندارد", () => {
    const s = sample({ count: 2, byReason: { ...BY, EXPIRED_UNBILLED: 2 } });
    const before = JSON.stringify(s);
    const h = ev(s);
    expect(JSON.stringify(s)).toBe(before);
    expect(h.byReason).not.toBe(s["byReason"]);
  });
  it("هر بار نتیجهٔ تازه می‌سازد (بی‌حالت)", () => {
    const m = monitorOf();
    const a = m.evaluate({ sample: sample(), nowMs: NOW });
    const b = m.evaluate({ sample: sample(), nowMs: NOW });
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
  it("evaluate مستقل از ساعتِ مانیتور است (زمان فقط آرگومان)", () => {
    const m = monitorOf({}, createMemoryOutbox(), manualClock(123456789));
    expect(m.evaluate({ sample: sample({ count: 1, oldestDeadAtMs: NOW - 6000 }), nowMs: NOW }).status).toBe("down");
  });
});

describe("settlement-backlog · check(): نمونه‌گیری و ارزیابی با ساعتِ واقعیِ همان لحظه", () => {
  it("outboxِ خالی ⇒ ok", async () => {
    expect((await monitorOf().check()).status).toBe("ok");
  });
  it("پسماندِ تازه ⇒ ok؛ با گذشتِ زمان و بی‌تأیید ⇒ degraded ⇒ down؛ پس از تأییدِ همه ⇒ دوباره ok", async () => {
    const clock = manualClock(T0);
    const outbox = createMemoryOutbox();
    const m = monitorOf({ degradedCount: 4 }, outbox, clock);
    await buryMany(outbox, 2, () => T0);
    expect((await m.check()).status).toBe("ok");
    clock.advance(1_001);
    expect(codes(await m.check())).toEqual(["OLDEST_AGED"]);
    clock.advance(4_000);
    expect(codes(await m.check())).toEqual(["OLDEST_STUCK"]);
    await outbox.acknowledgeDead(REF(1), { atMs: clock.now });
    expect(codes(await m.check())).toEqual(["OLDEST_STUCK"]);
    await outbox.acknowledgeDead(REF(2), { atMs: clock.now });
    expect(await m.check()).toMatchObject({ status: "ok", count: 0, reasons: [] });
  });
  it("چند مرده: شمارِ تأییدنشده‌ها از آستانه‌ها عبور می‌کند", async () => {
    const outbox = createMemoryOutbox();
    const m = monitorOf({}, outbox);
    await buryMany(outbox, 3);
    expect(codes(await m.check())).toEqual(["COUNT_HIGH"]);
    await buryMany(createMemoryOutbox(), 0);
    const outbox2 = createMemoryOutbox();
    await buryMany(outbox2, 5);
    expect(codes(await monitorOf({}, outbox2).check())).toEqual(["COUNT_CRITICAL"]);
  });
  it("outboxِ خراب ⇒ degraded با failure (پروبِ سلامت نمی‌شکند)", async () => {
    const m = monitorOf({}, { listUnacknowledgedDead: async () => ({ ok: false, error: { code: "STORE_FAILURE", message: "m" } }) });
    expect(await m.check()).toMatchObject({ status: "degraded", failure: "LIST_FAILED" });
  });
  it("ساعتِ ناسالم از همان اول ⇒ down (INPUT_INVALID؛ مثلِ health.ts ساعتِ نامعتبر شکستِ بسته است) و outbox خوانده نمی‌شود", async () => {
    const calls: number[] = [];
    const m = monitorOf({}, { listUnacknowledgedDead: async () => { calls.push(1); return { ok: true, value: [] }; } }, { nowMs: () => Number.NaN });
    expect(await m.check()).toMatchObject({ status: "down", reasons: [{ code: "INPUT_INVALID", severity: "down" }] });
    expect(calls).toHaveLength(0);
  });
  it("ساعتِ سالم ولی sample ناخوانا (از راهِ evaluate) ⇒ degraded؛ ساعتِ خراب در نمونه ⇒ پذیرفته ولی ناخوانا", () => {
    expect(monitorOf().evaluate({ sample: { ok: false, atMs: null, code: "CLOCK_INVALID" }, nowMs: T0 })).toMatchObject({ status: "degraded", failure: "CLOCK_INVALID" });
  });
  it("ساعتی که میانهٔ راه خراب می‌شود ⇒ INPUT_INVALID down (سنِ ساختگی ساخته نمی‌شود)", async () => {
    let n = 0;
    const m = monitorOf({}, createMemoryOutbox(), { nowMs: () => (++n === 1 ? T0 : Number.NaN) });
    expect(await m.check()).toMatchObject({ status: "down", reasons: [{ code: "INPUT_INVALID" }] });
  });
  it("check هرگز نمی‌پرتابد", async () => {
    const m = must(createDeadLetterBacklogMonitor({ outbox: { listUnacknowledgedDead: () => { throw new Error("x"); } }, clock: { nowMs: () => { throw new Error("y"); } }, ...TH }));
    await expect(m.check()).resolves.toMatchObject({ status: "down" });
    const m2 = must(createDeadLetterBacklogMonitor({ outbox: { listUnacknowledgedDead: () => { throw new Error("x"); } }, clock: manualClock(), ...TH }));
    await expect(m2.check()).resolves.toMatchObject({ status: "degraded", failure: "LIST_FAILED" });
  });
});
