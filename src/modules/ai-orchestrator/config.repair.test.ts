/** اعتبارسنجی `policy.repair` هنگام ساخت (ADR-0017 §۱): اختیاری، بی‌پیش‌فرض، سخت‌گیر، منجمد. */
import { describe, expect, it } from "vitest";
import { resolveConfig } from "./config";
import { fakeChecker, fakeGateway, fakeSearcher, replyJson } from "./test-kit";

const good = () => ({ searcher: fakeSearcher([]), gateway: fakeGateway(() => replyJson({})), checker: fakeChecker({ texts: {} }) });
const BASE = { onRejectedCitation: "withhold", requireQuotes: true } as const;
const issuesOf = (r: ReturnType<typeof resolveConfig>): readonly string[] => {
  if (r.ok) throw new Error("expected failure");
  return r.error.issues ?? [];
};
const withRepair = (repair: unknown) => resolveConfig({ ...good(), policy: { ...BASE, repair } });

describe("ai-orchestrator · config · policy.repair", () => {
  it("نبودن (یا undefined) = بی‌ترمیم؛ کلید در سیاستِ گرفته‌شده نیست", () => {
    for (const policy of [BASE, { ...BASE, repair: undefined }]) {
      const r = resolveConfig({ ...good(), policy });
      expect(r.ok).toBe(true);
      if (r.ok) expect("repair" in r.value.policy).toBe(false);
    }
  });

  it("شیء معتبر پذیرفته و منجمد می‌شود؛ ویرایش بعدیِ ورودی اثر ندارد", () => {
    const repair = { maxFirstAttemptSpendMicros: 1000, currency: "IRR" };
    const r = withRepair(repair);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.policy).toEqual({ ...BASE, repair: { maxFirstAttemptSpendMicros: 1000, currency: "IRR" } });
    expect(Object.isFrozen(r.value.policy)).toBe(true);
    expect(Object.isFrozen(r.value.policy.repair)).toBe(true);
    repair.maxFirstAttemptSpendMicros = 9;
    expect(r.value.policy.repair?.maxFirstAttemptSpendMicros).toBe(1000);
  });

  it("مرزها: ۰ و 2^53−1 مجاز؛ −۱، 2^53، اعشاری، NaN، Infinity، رشته رد", () => {
    for (const n of [0, 1, Number.MAX_SAFE_INTEGER]) expect(withRepair({ maxFirstAttemptSpendMicros: n, currency: "IRR" }).ok).toBe(true);
    for (const n of [-1, Number.MAX_SAFE_INTEGER + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5", null, undefined]) {
      expect(issuesOf(withRepair({ maxFirstAttemptSpendMicros: n, currency: "IRR" }))).toEqual(["policy.repair.maxFirstAttemptSpendMicros"]);
    }
  });

  it("ارز باید دقیقاً سه حرف بزرگ لاتین باشد", () => {
    for (const c of ["IRR", "USD"]) expect(withRepair({ maxFirstAttemptSpendMicros: 1, currency: c }).ok).toBe(true);
    for (const c of ["irr", "IR", "IRRR", "IR1", " IRR", "ایران", "", null, undefined, 5]) {
      expect(issuesOf(withRepair({ maxFirstAttemptSpendMicros: 1, currency: c }))).toEqual(["policy.repair.currency"]);
    }
  });

  it("هر دو کلید الزامی‌اند؛ کلید ناشناخته (غلط املایی) رد می‌شود", () => {
    expect(issuesOf(withRepair({}))).toEqual(["policy.repair.maxFirstAttemptSpendMicros", "policy.repair.currency"]);
    expect(issuesOf(withRepair({ maxFirstAttemptSpendMicros: 1, currency: "IRR", extra: 1 }))).toEqual(["unknown:policy.repair.extra"]);
    expect(issuesOf(withRepair({ maxFirstAttemptSpendMicro: 1, currency: "IRR" }))).toEqual(["unknown:policy.repair.maxFirstAttemptSpendMicro", "policy.repair.maxFirstAttemptSpendMicros"]);
  });

  it("null/false/true/عدد/رشته/آرایه رد می‌شوند (غیرفعال‌کردن فقط با حذف کلید)", () => {
    for (const v of [null, false, true, 0, 5, "on", [], [1]]) expect(issuesOf(withRepair(v))).toEqual(["policy.repair"]);
  });

  it("کلیدِ ناشناختهٔ بلندِ repair در issues کوتاه می‌شود؛ خطا بی‌نشت و بی‌ساخت", () => {
    const r = withRepair({ maxFirstAttemptSpendMicros: 1, currency: "IRR", ["x".repeat(500)]: 1 });
    const issues = issuesOf(r);
    expect(issues).toHaveLength(1);
    expect((issues[0] as string).length).toBeLessThanOrEqual("unknown:policy.repair.".length + 40);
  });

  it("خطای repair با خطای دیگرِ سیاست جمع می‌شود (همه با هم گزارش می‌شوند)", () => {
    const r = resolveConfig({ ...good(), policy: { requireQuotes: true, repair: { currency: "IRR" } } });
    expect(issuesOf(r)).toEqual(["policy.onRejectedCitation", "policy.repair.maxFirstAttemptSpendMicros"]);
  });
});
