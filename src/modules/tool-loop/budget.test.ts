import { describe, expect, it, vi } from "vitest";
import { budgetVerdict, type BudgetPolicy } from "./index";
import { cost, usage } from "./test-kit";

const cap = (est: (i: never) => unknown, max = 1000, currency = "IRR"): BudgetPolicy => ({ kind: "cap", currency, maxMicros: max, estimateStepMicros: est as never });
const E = (cost_: unknown) => ({ usage: usage(1, 1), cost: cost_ });
const NEXT = { step: 2, maxOutputTokens: 500, continuationChars: 10 };

describe("tool-loop · دروازهٔ هزینه", () => {
  it("none ⇒ همیشه مجاز و برآوردگری صدا زده نمی‌شود", () => {
    expect(budgetVerdict({ kind: "none" }, [E(null)], NEXT)).toBeNull();
  });
  it("زیرِ سقف مجاز؛ دقیقاً برابرِ سقف هم مجاز؛ یک واحد بیشتر ممنوع", () => {
    expect(budgetVerdict(cap(() => 300), [E(cost(600))], NEXT)).toBeNull();
    expect(budgetVerdict(cap(() => 400), [E(cost(600))], NEXT)).toBeNull();
    expect(budgetVerdict(cap(() => 401), [E(cost(600))], NEXT)).toBe("BUDGET_EXCEEDED");
  });
  it("بی‌هزینهٔ پیشین فقط برآورد را می‌سنجد", () => {
    expect(budgetVerdict(cap(() => 1000), [], NEXT)).toBeNull();
    expect(budgetVerdict(cap(() => 1001), [], NEXT)).toBe("BUDGET_EXCEEDED");
  });
  it("هزینهٔ نامعلوم صفر نیست ⇒ SPEND_UNKNOWN", () => {
    expect(budgetVerdict(cap(() => 1), [E(cost(10)), E(null)], NEXT)).toBe("SPEND_UNKNOWN");
    expect(budgetVerdict(cap(() => 1), [{ usage: null, cost: undefined }], NEXT)).toBe("SPEND_UNKNOWN");
  });
  it("ارزِ دیگر قابل‌مقایسه نیست ⇒ SPEND_UNKNOWN", () => {
    expect(budgetVerdict(cap(() => 1), [E(cost(10, "USD"))], NEXT)).toBe("SPEND_UNKNOWN");
    expect(budgetVerdict(cap(() => 1), [E(cost(10)), E(cost(10, "USD"))], NEXT)).toBe("SPEND_UNKNOWN");
  });
  it("دو نسخهٔ قیمتِ هم‌ارز با هم جمع می‌شوند (سقف دربارهٔ پول است)", () => {
    expect(budgetVerdict(cap(() => 1, 700), [E(cost(300, "IRR", "v1")), E(cost(400, "IRR", "v2"))], NEXT)).toBe("BUDGET_EXCEEDED");
    expect(budgetVerdict(cap(() => 1, 701), [E(cost(300, "IRR", "v1")), E(cost(400, "IRR", "v2"))], NEXT)).toBeNull();
  });
  it.each([
    ["NaN", Number.NaN],
    ["منفی", -1],
    ["اعشاری", 1.5],
    ["بی‌نهایت", Number.POSITIVE_INFINITY],
    ["رشته", "5"],
    ["null", null],
    ["undefined", undefined],
    ["ناامن", Number.MAX_SAFE_INTEGER + 2],
  ])("برآوردگرِ خراب (%s) ⇒ SPEND_UNKNOWN", (_n, v) => {
    expect(budgetVerdict(cap(() => v), [], NEXT)).toBe("SPEND_UNKNOWN");
  });
  it("برآوردگرِ پرتابگر ⇒ SPEND_UNKNOWN و پرتاب نمی‌شود", () => {
    expect(budgetVerdict(cap(() => { throw new Error("x"); }), [], NEXT)).toBe("SPEND_UNKNOWN");
  });
  it("سرریزِ جمعِ هزینه ⇒ BUDGET_EXCEEDED (گرد نمی‌شود)", () => {
    const big = E(cost(Number.MAX_SAFE_INTEGER));
    expect(budgetVerdict(cap(() => 0, Number.MAX_SAFE_INTEGER), [big, E(cost(5))], NEXT)).toBe("BUDGET_EXCEEDED");
    expect(budgetVerdict(cap(() => 1, Number.MAX_SAFE_INTEGER), [big], NEXT)).toBe("BUDGET_EXCEEDED");
  });
  it("برآوردگر ورودیِ یخ‌زدهٔ درست می‌گیرد و تغییرِ آن بی‌اثر است", () => {
    const frozen: boolean[] = [];
    const spy = vi.fn((i: { step: number }) => {
      frozen.push(Object.isFrozen(i)); // assertion داخلِ برآوردگر پرتاب می‌شد و به SPEND_UNKNOWN تبدیل می‌شد؛ پس بیرون می‌سنجیم.
      return 1;
    });
    const input = { ...NEXT };
    budgetVerdict(cap(spy), [], input);
    expect(spy).toHaveBeenCalledWith(NEXT);
    expect(frozen).toEqual([true]);
  });
  it("هزینهٔ کامل‌شده ولی برآوردگر لازم نیست وقتی نامعلوم هست (ترتیب: معلوم‌بودن ← سقف)", () => {
    const spy = vi.fn(() => 1);
    expect(budgetVerdict(cap(spy), [E(null)], NEXT)).toBe("SPEND_UNKNOWN");
    expect(spy).not.toHaveBeenCalled();
  });
});
