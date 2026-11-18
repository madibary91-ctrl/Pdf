/**
 * سیاستِ خالصِ حلقهٔ رفتگر (ADR-0023): تأخیرِ گذر بعد (جدول + خاصیتی با مرجعِ مستقل) و اعتبارسنجیِ گزارشِ رفتگرِ تزریقی.
 */
import { describe, expect, it } from "vitest";
import { faultOf, hasProgress, nextDelay, parseReport } from "./loop-policy";
import type { DelayPolicy } from "./loop-policy";
import { sweepReport } from "./test-kit";

const P: DelayPolicy = { intervalMs: 1000, maxBackoffMs: 8000, maxDrainRuns: 3 };

describe("settlement · loop-policy · nextDelay (جدول)", () => {
  it("گذرِ بیکار ⇒ فاصلهٔ عادی و شمارندهٔ تخلیه صفر", () => {
    expect(nextDelay(P, "idle", 0, 0)).toEqual({ delayMs: 1000, drainRuns: 0 });
    expect(nextDelay(P, "idle", 0, 2)).toEqual({ delayMs: 1000, drainRuns: 0 });
  });
  it("گذرِ پربار ⇒ بی‌انتظار تا maxDrainRuns، سپس فاصلهٔ عادی و شمارندهٔ صفر", () => {
    expect(nextDelay(P, "progress", 0, 0)).toEqual({ delayMs: 0, drainRuns: 1 });
    expect(nextDelay(P, "progress", 0, 1)).toEqual({ delayMs: 0, drainRuns: 2 });
    expect(nextDelay(P, "progress", 0, 2)).toEqual({ delayMs: 0, drainRuns: 3 });
    expect(nextDelay(P, "progress", 0, 3)).toEqual({ delayMs: 1000, drainRuns: 0 });
  });
  it("شکست ⇒ عقب‌نشینی نمایی با سقف؛ نخستین شکست همان فاصلهٔ عادی", () => {
    expect([1, 2, 3, 4, 5, 6, 40].map((n) => nextDelay(P, "unhealthy", n, 2).delayMs)).toEqual([1000, 2000, 4000, 8000, 8000, 8000, 8000]);
  });
  it("شکست شمارندهٔ تخلیه را صفر می‌کند", () => {
    expect(nextDelay(P, "unhealthy", 1, 3).drainRuns).toBe(0);
  });
  it("شمارندهٔ شکستِ صفر یا منفی (ورودیِ ناممکن) هرگز تأخیرِ کمتر از فاصله یا بیش از سقف نمی‌دهد", () => {
    for (const n of [0, -5]) expect(nextDelay(P, "unhealthy", n, 0).delayMs).toBe(1000);
  });
  it("توانِ بسیار بزرگ سرریز نمی‌کند (سقف می‌ماند)", () => {
    expect(nextDelay({ intervalMs: 86_400_000, maxBackoffMs: 86_400_000, maxDrainRuns: 1 }, "unhealthy", 10_000, 0).delayMs).toBe(86_400_000);
    expect(nextDelay(P, "unhealthy", Number.MAX_SAFE_INTEGER, 0).delayMs).toBe(8000);
  });
});

function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

describe("settlement · loop-policy · nextDelay (خاصیتی با مرجعِ مستقل)", () => {
  for (let seed = 1; seed <= 25; seed++) {
    it(`بذر ${seed}: ۴۰۰ گذرِ تصادفی؛ کران، یکنوایی و بازنشانی`, () => {
      const r = prng(seed * 7919);
      const interval = 1 + Math.floor(r() * 500);
      const policy: DelayPolicy = { intervalMs: interval, maxBackoffMs: interval * (1 + Math.floor(r() * 40)), maxDrainRuns: 1 + Math.floor(r() * 6) };
      let failures = 0;
      let drain = 0;
      let prevDelayInFailStreak = 0;
      let refDrain = 0;
      for (let i = 0; i < 400; i++) {
        const x = r();
        const outcome = x < 0.3 ? "unhealthy" : x < 0.65 ? "progress" : "idle";
        failures = outcome === "unhealthy" ? failures + 1 : 0;
        const got = nextDelay(policy, outcome, failures, drain);
        // مرجعِ ساده‌ی مستقل
        let want: number;
        if (outcome === "unhealthy") {
          want = interval;
          for (let k = 1; k < failures && want < policy.maxBackoffMs; k++) want *= 2;
          want = Math.min(want, policy.maxBackoffMs);
          refDrain = 0;
        } else if (outcome === "progress" && refDrain < policy.maxDrainRuns) {
          want = 0;
          refDrain += 1;
        } else {
          want = interval;
          refDrain = 0;
        }
        expect(got.delayMs).toBe(want);
        expect(got.drainRuns).toBe(refDrain);
        // ناوردا: هرگز بیش از سقفِ فاصله؛ هرگز منفی
        expect(got.delayMs).toBeGreaterThanOrEqual(0);
        expect(got.delayMs).toBeLessThanOrEqual(Math.max(policy.intervalMs, policy.maxBackoffMs));
        // یکنوایی در رشتهٔ شکست
        if (outcome === "unhealthy") {
          if (failures > 1) expect(got.delayMs).toBeGreaterThanOrEqual(prevDelayInFailStreak);
          prevDelayInFailStreak = got.delayMs;
        } else prevDelayInFailStreak = 0;
        // تخلیهٔ پیاپی هرگز از maxDrainRuns بیشتر نمی‌شود
        expect(got.drainRuns).toBeLessThanOrEqual(policy.maxDrainRuns);
        drain = got.drainRuns;
      }
    });
  }
});

describe("settlement · loop-policy · faultOf و hasProgress", () => {
  it("listFailed بر outboxFailures مقدم است؛ بی‌هیچ‌کدام null", () => {
    expect(faultOf(sweepReport({ listFailed: true, outboxFailures: 3 }))).toBe("LIST_FAILED");
    expect(faultOf(sweepReport({ outboxFailures: 1 }))).toBe("OUTBOX_FAILURES");
    expect(faultOf(sweepReport({ retryLater: 5, raced: 2, settled: 1 }))).toBeNull();
  });
  it("پیشرفت = تسویه یا مرگ؛ retryLater و raced پیشرفت نیستند", () => {
    expect(hasProgress(sweepReport({ settled: 1 }))).toBe(true);
    expect(hasProgress(sweepReport({ buried: [{ tenantId: "t", accountId: "a", reservationId: "r", reason: "EXPIRED_UNBILLED", errorCode: null }] }))).toBe(true);
    expect(hasProgress(sweepReport({ examined: 9, retryLater: 4, raced: 5 }))).toBe(false);
  });
});

describe("settlement · loop-policy · parseReport", () => {
  const item = { tenantId: "t", accountId: "a", reservationId: "r", reason: "LEDGER_REJECTED", errorCode: "X" };
  it("گزارشِ معتبر ⇒ کپیِ منجمد", () => {
    const raw = sweepReport({ examined: 2, settled: 1, buried: [item as never] });
    const p = parseReport(raw);
    expect(p).toEqual(raw);
    expect(p).not.toBe(raw);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p?.buried)).toBe(true);
    expect(Object.isFrozen(p?.buried[0])).toBe(true);
  });
  it("فیلدِ اضافه (مثلاً پیامِ خام) حذف می‌شود، حتی در عضوِ buried", () => {
    const p = parseReport({ ...sweepReport({ buried: [{ ...item, message: "RAW-CANARY" } as never] }), message: "RAW-CANARY" });
    expect(JSON.stringify(p)).not.toContain("RAW-CANARY");
  });
  it("کپی از مرجع جداست: دستکاریِ بعدیِ ورودی اثری ندارد", () => {
    const buried = [{ ...item }];
    const p = parseReport({ ...sweepReport(), buried });
    buried[0] = { ...item, reservationId: "changed" };
    buried.push({ ...item });
    expect(p?.buried).toHaveLength(1);
    expect(p?.buried[0]?.reservationId).toBe("r");
  });
  it.each<[string, unknown]>([
    ["null", null],
    ["آرایه", []],
    ["رشته", "x"],
    ["عدد", 3],
    ["بی‌examined", { ...sweepReport(), examined: undefined }],
    ["examined منفی", { ...sweepReport(), examined: -1 }],
    ["settled اعشاری", { ...sweepReport(), settled: 1.5 }],
    ["retryLater رشته", { ...sweepReport(), retryLater: "1" }],
    ["raced NaN", { ...sweepReport(), raced: Number.NaN }],
    ["outboxFailures بی‌نهایت", { ...sweepReport(), outboxFailures: Infinity }],
    ["examined ناامن", { ...sweepReport(), examined: 2 ** 53 }],
    ["listFailed غیرBoolean", { ...sweepReport(), listFailed: 0 }],
    ["buried غیرآرایه", { ...sweepReport(), buried: {} }],
    ["buried با عضوِ null", { ...sweepReport(), buried: [null] }],
    ["عضوِ بی‌tenantId", { ...sweepReport(), buried: [{ ...item, tenantId: undefined }] }],
    ["شناسهٔ تهی", { ...sweepReport(), buried: [{ ...item, accountId: "" }] }],
    ["شناسهٔ بلند", { ...sweepReport(), buried: [{ ...item, reservationId: "x".repeat(257) }] }],
    ["دلیلِ ناشناخته", { ...sweepReport(), buried: [{ ...item, reason: "WHATEVER" }] }],
    ["errorCode عدد", { ...sweepReport(), buried: [{ ...item, errorCode: 5 }] }],
    ["errorCode تهی", { ...sweepReport(), buried: [{ ...item, errorCode: "" }] }],
  ])("%s ⇒ null", (_n, raw) => {
    expect(parseReport(raw)).toBeNull();
  });
  it("errorCode null پذیرفته می‌شود", () => {
    expect(parseReport(sweepReport({ buried: [{ ...item, errorCode: null } as never] }))?.buried[0]?.errorCode).toBeNull();
  });
  it("هر سه دلیلِ مرگ پذیرفته می‌شوند", () => {
    for (const reason of ["EXPIRED_UNBILLED", "ATTEMPTS_EXHAUSTED", "LEDGER_REJECTED"]) expect(parseReport(sweepReport({ buried: [{ ...item, reason } as never] }))).not.toBeNull();
  });
  it("getter پرتاب‌کننده ⇒ null (بی‌پرتاب)", () => {
    const evil = {};
    Object.defineProperty(evil, "examined", {
      get() {
        throw new Error("boom");
      },
    });
    expect(parseReport(evil)).toBeNull();
  });
  it("Proxy آویزان/پرتاب‌کننده ⇒ null", () => {
    const p = new Proxy({}, { get: () => { throw new Error("boom"); }, ownKeys: () => { throw new Error("boom"); } });
    expect(parseReport(p)).toBeNull();
  });
});

describe("settlement · loop-policy · سقفِ اندازهٔ گزارش", () => {
  const item = { tenantId: "t", accountId: "a", reservationId: "r", reason: "LEDGER_REJECTED", errorCode: null };
  it("۱۰۰٬۰۰۰ عضوِ buried پذیرفته و ۱۰۰٬۰۰۱ رد می‌شود (گزارشِ غول‌آسا حافظه نمی‌خورد)", () => {
    expect(parseReport({ ...sweepReport(), buried: Array.from({ length: 100_000 }, () => item) })?.buried).toHaveLength(100_000);
    expect(parseReport({ ...sweepReport(), buried: Array.from({ length: 100_001 }, () => item) })).toBeNull();
  });
});
