import { describe, expect, it } from "vitest";
import { FALLBACK_ELIGIBLE_CODES, POLICY_LIMITS, RETRYABLE_CODES, resolvePolicy } from "./index";
import { ERROR_CODES } from "./index";
import { makeError } from "./errors";
import { BASE_POLICY } from "./resilience-kit";

const NAMES = new Set(["m1", "m2", "m3"]);
const P = (over: Record<string, unknown> = {}) => ({ ...BASE_POLICY, backoff: { ...BASE_POLICY.backoff }, ...over });
const issuesOf = (input: unknown, names: ReadonlySet<string> | null = NAMES): readonly string[] => {
  const r = resolvePolicy(input, names);
  if (r.ok) throw new Error("انتظار رد بود");
  return r.issues;
};
const has = (issues: readonly string[], part: string): boolean => issues.some((i) => i.includes(part));

describe("resolvePolicy · پذیرش و انجماد", () => {
  it("سیاست کامل می‌پذیرد و مقدارها را همان‌گونه نگه می‌دارد", () => {
    const r = resolvePolicy(P({ fallbacks: { m1: ["m2", "m3"] } }), NAMES);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.value).toMatchObject({ maxAttemptsPerModel: 3, maxTotalAttempts: 6, totalTimeoutMs: 100_000, baseDelayMs: 100, maxDelayMs: 1000, jitter: "none", random: null });
    expect([...r.value.retryOn].sort()).toEqual([...RETRYABLE_CODES].sort());
    expect([...r.value.fallbackOn].sort()).toEqual([...FALLBACK_ELIGIBLE_CODES].sort());
    expect(r.value.fallbacks.get("m1")).toEqual(["m2", "m3"]);
    expect(Object.isFrozen(r.value)).toBe(true);
    expect(Object.isFrozen(r.value.fallbacks.get("m1"))).toBe(true);
  });
  it("کپی گرفته می‌شود: ویرایش بعدیِ ورودی اثر ندارد", () => {
    const input = P({ retryOn: ["TIMEOUT"], fallbacks: { m1: ["m2"] } }) as Record<string, unknown>;
    const r = resolvePolicy(input, NAMES);
    if (!r.ok) throw new Error("رد");
    (input["retryOn"] as string[]).push("PROVIDER_UNAVAILABLE");
    (input["fallbacks"] as Record<string, string[]>)["m1"]?.push("m3");
    input["maxAttemptsPerModel"] = 9;
    expect([...r.value.retryOn]).toEqual(["TIMEOUT"]);
    expect(r.value.fallbacks.get("m1")).toEqual(["m2"]);
    expect(r.value.maxAttemptsPerModel).toBe(3);
  });
  it("random و jitter: random اختیاری با none؛ الزامی با full/equal؛ تابع next گرفته (bind) می‌شود", () => {
    expect(resolvePolicy(P(), NAMES).ok).toBe(true);
    for (const jitter of ["full", "equal"]) {
      const noRandom = P({ backoff: { baseDelayMs: 1, maxDelayMs: 2, jitter } });
      expect(has(issuesOf(noRandom), "policy.random")).toBe(true);
      const obj = { v: 0.25, next() { return this.v; } };
      const r = resolvePolicy({ ...noRandom, random: obj }, NAMES);
      if (!r.ok) throw new Error("رد");
      obj.next = () => 0.9;
      expect(r.value.random?.next()).toBe(0.25);
    }
    expect(resolvePolicy(P({ random: { next: () => 0 } }), NAMES).ok).toBe(true);
  });
  it("ثابت‌های راحتی: همان کدهای مجاز؛ PROVIDER_ERROR هرگز قابل‌تلاش نیست؛ همه کد معتبر هسته‌اند", () => {
    expect(RETRYABLE_CODES).toEqual(["TIMEOUT", "PROVIDER_RATE_LIMITED", "PROVIDER_UNAVAILABLE"]);
    expect(RETRYABLE_CODES).not.toContain("PROVIDER_ERROR");
    expect(FALLBACK_ELIGIBLE_CODES).toContain("PROVIDER_ERROR");
    for (const c of [...RETRYABLE_CODES, ...FALLBACK_ELIGIBLE_CODES]) expect(ERROR_CODES).toContain(c);
    // RETRYABLE_CODES دقیقاً همان کدهایی است که هسته retryable می‌داند.
    expect(ERROR_CODES.filter((c) => makeError(c).retryable).sort()).toEqual([...RETRYABLE_CODES].sort());
    expect(Object.isFrozen(RETRYABLE_CODES)).toBe(true);
    expect(Object.isFrozen(FALLBACK_ELIGIBLE_CODES)).toBe(true);
    expect(Object.isFrozen(POLICY_LIMITS)).toBe(true);
  });
});

describe("resolvePolicy · سخت‌گیری (بدون پیش‌فرض)", () => {
  it.each([null, undefined, 3, "x", [], () => 1])("ورودی غیرشیء رد: %s", (v) => {
    expect(issuesOf(v)).toEqual(["policy باید شیء باشد."]);
  });
  it("{} همهٔ الزامی‌ها را یک‌جا گزارش می‌کند", () => {
    const i = issuesOf({});
    for (const f of ["maxAttemptsPerModel", "maxTotalAttempts", "totalTimeoutMs", "backoff", "retryOn", "fallbackOn", "fallbacks"]) expect(has(i, `policy.${f}`), f).toBe(true);
  });
  it("کلید ناشناخته رد (غلط املایی ‘retryon’ نباید بی‌صدا تلاش را خاموش کند)", () => {
    expect(has(issuesOf(P({ retryon: ["TIMEOUT"] })), '"retryon"')).toBe(true);
    expect(has(issuesOf(P({ backoff: { ...BASE_POLICY.backoff, jiter: 1 } })), "policy.backoff: کلید ناشناخته")).toBe(true);
  });
  it("کلید ناشناختهٔ بسیار بلند کوتاه گزارش می‌شود (بی‌نشت)", () => {
    const i = issuesOf(P({ ["x".repeat(500)]: 1 }));
    expect(i.join("").length).toBeLessThan(400);
  });
  it.each([
    ["maxAttemptsPerModel", POLICY_LIMITS.maxAttemptsPerModel],
    ["maxTotalAttempts", POLICY_LIMITS.maxTotalAttempts],
    ["totalTimeoutMs", POLICY_LIMITS.maxTotalTimeoutMs],
  ] as const)("%s: مرزها ۱ و %s پذیرفته؛ ۰، سقف+۱، اعشار، NaN، متن رد", (field, max) => {
    const ok = (v: unknown) => resolvePolicy(P({ [field]: v, retryOn: ["TIMEOUT"] }), NAMES).ok;
    expect(ok(1)).toBe(true);
    expect(ok(max)).toBe(true);
    for (const bad of [0, -1, max + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", null, undefined]) expect(ok(bad), String(bad)).toBe(false);
  });
  it("حدها قراردادی‌اند: با عددِ ثابت سنجیده می‌شوند، نه با خودِ POLICY_LIMITS (تا تغییر بی‌صدای حد دیده شود)", () => {
    expect(POLICY_LIMITS).toEqual({ maxAttemptsPerModel: 10, maxTotalAttempts: 20, maxTotalTimeoutMs: 3_600_000, maxBaseDelayMs: 60_000, maxDelayMs: 600_000, maxFallbacksPerModel: 5 });
    const ok = (over: Record<string, unknown>) => resolvePolicy(P({ retryOn: ["TIMEOUT"], ...over }), NAMES).ok;
    expect([ok({ maxAttemptsPerModel: 10 }), ok({ maxAttemptsPerModel: 11 })]).toEqual([true, false]);
    expect([ok({ maxTotalAttempts: 20 }), ok({ maxTotalAttempts: 21 })]).toEqual([true, false]);
    expect([ok({ totalTimeoutMs: 3_600_000 }), ok({ totalTimeoutMs: 3_600_001 })]).toEqual([true, false]);
  });
  it("backoff: مرزها و ترتیب base ≤ max؛ jitter محدود به سه مقدار", () => {
    const ok = (b: Record<string, unknown>) => resolvePolicy(P({ backoff: b }), NAMES).ok;
    expect(ok({ baseDelayMs: 0, maxDelayMs: 0, jitter: "none" })).toBe(true);
    expect(ok({ baseDelayMs: 60_000, maxDelayMs: 600_000, jitter: "none" })).toBe(true);
    expect(ok({ baseDelayMs: 60_001, maxDelayMs: 600_000, jitter: "none" })).toBe(false);
    expect(ok({ baseDelayMs: 0, maxDelayMs: 600_001, jitter: "none" })).toBe(false);
    expect(ok({ baseDelayMs: 500, maxDelayMs: 499, jitter: "none" })).toBe(false);
    expect(ok({ baseDelayMs: 500, maxDelayMs: 500, jitter: "none" })).toBe(true);
    expect(ok({ baseDelayMs: -1, maxDelayMs: 5, jitter: "none" })).toBe(false);
    expect(ok({ baseDelayMs: 1.5, maxDelayMs: 5, jitter: "none" })).toBe(false);
    expect(ok({ baseDelayMs: 1, maxDelayMs: 5 })).toBe(false);
    expect(ok({ baseDelayMs: 1, maxDelayMs: 5, jitter: "FULL" })).toBe(false);
    expect(has(issuesOf(P({ backoff: { baseDelayMs: 500, maxDelayMs: 499, jitter: "none" } })), "maxDelayMs نباید کمتر")).toBe(true);
    for (const b of [null, [], "x", 3]) expect(has(issuesOf(P({ backoff: b })), "policy.backoff الزامی")).toBe(true);
  });
  it("retryOn: فقط کدهای قابل‌تلاش؛ تکرار و نوع غلط رد؛ PROVIDER_ERROR و AUTH مجاز نیستند", () => {
    for (const code of ["PROVIDER_ERROR", "PROVIDER_AUTH", "INVALID_REQUEST", "ABORTED", "ok", ""]) {
      expect(has(issuesOf(P({ retryOn: [code] })), "policy.retryOn: مقدار نامجاز"), code).toBe(true);
    }
    expect(has(issuesOf(P({ retryOn: ["TIMEOUT", "TIMEOUT"] })), "تکراری")).toBe(true);
    expect(has(issuesOf(P({ retryOn: [1] })), "نامجاز")).toBe(true);
    for (const bad of ["TIMEOUT", null, {}, undefined]) expect(has(issuesOf(P({ retryOn: bad })), "policy.retryOn باید آرایه")).toBe(true);
  });
  it("fallbackOn: فقط کدهای مجاز؛ ABORTED/INVALID_* هرگز", () => {
    expect(resolvePolicy(P({ fallbackOn: ["PROVIDER_ERROR"] }), NAMES).ok).toBe(true);
    for (const code of ["ABORTED", "INVALID_REQUEST", "UNKNOWN_MODEL", "INTERNAL_ERROR", "INVALID_CONFIG"]) {
      expect(has(issuesOf(P({ fallbackOn: [code] })), "policy.fallbackOn: مقدار نامجاز"), code).toBe(true);
    }
    expect(has(issuesOf(P({ fallbackOn: ["TIMEOUT", "TIMEOUT"] })), "تکراری")).toBe(true);
  });
  it("ناسازگاریِ بی‌اثر رد: تلاش دوباره بدون retryOn؛ جایگزین بدون fallbackOn", () => {
    expect(has(issuesOf(P({ retryOn: [] })), "policy.retryOn نباید تهی")).toBe(true);
    expect(resolvePolicy(P({ retryOn: [], maxAttemptsPerModel: 1 }), NAMES).ok).toBe(true);
    expect(has(issuesOf(P({ fallbackOn: [], fallbacks: { m1: ["m2"] } })), "policy.fallbackOn نباید تهی")).toBe(true);
    expect(resolvePolicy(P({ fallbackOn: [], fallbacks: {} }), NAMES).ok).toBe(true);
  });
  it("fallbacks: مدل ناشناخته، خودش، تکراری، تهی، بلندتر از ۵، غیرآرایه، عضو غیرمتنی رد", () => {
    expect(has(issuesOf(P({ fallbacks: { zz: ["m2"] } })), "مدل اصلی در models تعریف نشده")).toBe(true);
    expect(has(issuesOf(P({ fallbacks: { m1: ["zz"] } })), "جایگزین")).toBe(true);
    expect(has(issuesOf(P({ fallbacks: { m1: ["m1"] } })), "جایگزین خودش")).toBe(true);
    expect(has(issuesOf(P({ fallbacks: { m1: ["m2", "m2"] } })), "جایگزین تکراری")).toBe(true);
    expect(has(issuesOf(P({ fallbacks: { m1: [] } })), "آرایهٔ ۱ تا 5")).toBe(true);
    expect(has(issuesOf(P({ fallbacks: { m1: ["a", "b", "c", "d", "e", "f"] } })), "آرایهٔ ۱ تا 5")).toBe(true);
    expect(has(issuesOf(P({ fallbacks: { m1: "m2" } })), "آرایهٔ ۱ تا 5")).toBe(true);
    expect(has(issuesOf(P({ fallbacks: { m1: [7] } })), "عضو غیرمتنی")).toBe(true);
    for (const bad of [null, [], "x"]) expect(has(issuesOf(P({ fallbacks: bad })), "policy.fallbacks الزامی")).toBe(true);
  });
  it("اندازهٔ زنجیره: ۵ مجاز؛ نام‌هایی مثل constructor/__proto__ ناشناخته‌اند", () => {
    const five = new Set(["a", "b", "c", "d", "e", "f"]);
    expect(resolvePolicy(P({ fallbacks: { a: ["b", "c", "d", "e", "f"] } }), five).ok).toBe(true);
    expect(has(issuesOf(P({ fallbacks: { m1: ["constructor"] } })), "تعریف نشده")).toBe(true);
    const evil = JSON.parse('{"__proto__": ["m2"]}') as unknown;
    expect(has(issuesOf(P({ fallbacks: evil })), "مدل اصلی در models تعریف نشده")).toBe(true);
  });
  it("modelNames=null: سنجشِ ارجاع به مدل‌ها انجام نمی‌شود ولی بقیه سخت‌گیر می‌ماند", () => {
    expect(resolvePolicy(P({ fallbacks: { x: ["y"] } }), null).ok).toBe(true);
    expect(has(issuesOf(P({ fallbacks: { x: ["x"] }, retryOn: [] }), null), "جایگزین خودش")).toBe(true);
  });
  it("همهٔ مشکل‌ها یک‌جا گزارش می‌شوند", () => {
    const i = issuesOf({ maxAttemptsPerModel: 0, maxTotalAttempts: 0, totalTimeoutMs: 0, backoff: 1, retryOn: 1, fallbackOn: 1, fallbacks: 1, extra: 1 });
    expect(i.length).toBeGreaterThanOrEqual(8);
  });
  it("ورودی خصمانه: getter پرتاب‌کننده ⇒ رد بی‌پرتاب و بی‌نشت", () => {
    const evil = { get maxAttemptsPerModel(): number { throw new Error("CANARY-نشت"); } };
    const r = resolvePolicy(evil, NAMES);
    expect(r).toEqual({ ok: false, issues: ["policy قابل خواندن نیست."] });
    const proxy = new Proxy({}, { ownKeys() { throw new Error("CANARY-نشت"); } });
    expect(resolvePolicy(proxy, NAMES)).toEqual({ ok: false, issues: ["policy قابل خواندن نیست."] });
  });
  it("random نامعتبر رد", () => {
    for (const bad of [1, null, {}, { next: 1 }, []]) expect(has(issuesOf(P({ random: bad })), "policy.random باید تابع next")).toBe(true);
  });
});
