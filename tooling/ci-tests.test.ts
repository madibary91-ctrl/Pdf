/** آزمون «دروازهٔ صفر-رد»: خودِ بررسی‌گر باید رد‌شدن، شکست و گزارش خراب را بگیرد (آزمون نگهبان). */
import { describe, expect, it } from "vitest";
import { evaluateReport, MIN_PASSED_TESTS } from "./ci-tests";
import { fileURLToPath } from "node:url";
import { readFloorHistory, requiredFloor } from "./gate-floor";

type A = { status: string; fullName?: string };
const file = (name: string, assertions: A[], status = "passed") => ({
  name,
  status,
  assertionResults: assertions.map((a, i) => ({ fullName: a.fullName ?? `${name}#${i}`, title: "t", ancestorTitles: [], status: a.status })),
});
const report = (...files: ReturnType<typeof file>[]) => ({ testResults: files });
const ok = (n: number): A[] => Array.from({ length: n }, () => ({ status: "passed" }));

describe("tooling: دروازهٔ صفر-رد (evaluateReport)", () => {
  it("گزارش کاملاً سبز پذیرفته می‌شود و شمارها درست است", () => {
    const r = evaluateReport(report(file("/a.test.ts", ok(3)), file("/b.test.ts", ok(2))), { minPassed: 5 });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.summary).toEqual({ files: 2, passed: 5, failed: 0, skipped: 0, todo: 0 });
  });

  it("حتی یک تست رد‌شده (مثل نبودن پایگاه) ⇒ قرمز، با نام تست", () => {
    const r = evaluateReport(
      report(file("/db.test.ts", [{ status: "passed" }, { status: "skipped", fullName: "پایگاه واقعی > درج" }])),
      { minPassed: 1 },
    );
    expect(r.ok).toBe(false);
    expect(r.summary.skipped).toBe(1);
    expect(r.skippedTests[0]).toContain("پایگاه واقعی > درج");
    expect(r.problems.join(" ")).toMatch(/رد \(skip\)/);
  });

  it("وضعیت‌های pending/disabled/ناشناخته هم «اجرا نشده» حساب می‌شوند", () => {
    for (const status of ["pending", "disabled", "skipped", "weird"]) {
      const r = evaluateReport(report(file("/x.test.ts", [...ok(2), { status }])), { minPassed: 1 });
      expect(r.ok, status).toBe(false);
      expect(r.summary.skipped, status).toBe(1);
    }
  });

  it("بازتولید دقیق ماجرای واقعی: ۴۴۷ سبز + ۱۵۶ رد‌شده (بدون پایگاه) ⇒ قرمز", () => {
    const r = evaluateReport(
      report(file("/store.test.ts", Array.from({ length: 156 }, () => ({ status: "skipped" }))), file("/rest.test.ts", ok(447))),
      { minPassed: MIN_PASSED_TESTS },
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toMatchObject({ passed: 447, skipped: 156 });
  });

  it("تست شکست‌خورده ⇒ قرمز", () => {
    const r = evaluateReport(report(file("/a.test.ts", [...ok(2), { status: "failed", fullName: "بد" }], "failed")), { minPassed: 1 });
    expect(r.ok).toBe(false);
    expect(r.failedTests).toEqual(["/a.test.ts › بد"]);
  });

  it("فایلی که بارگذاری نشد (بدون assertion، وضعیت failed) ⇒ قرمز", () => {
    const r = evaluateReport(report(file("/broken.test.ts", [], "failed"), file("/a.test.ts", ok(3))), { minPassed: 3 });
    expect(r.ok).toBe(false);
    expect(r.failedTests[0]).toContain("/broken.test.ts");
  });

  it("کل فایلِ رد‌شده بدون assertion هم دیده می‌شود", () => {
    const r = evaluateReport(report(file("/gone.test.ts", [], "skipped"), file("/a.test.ts", ok(3))), { minPassed: 3 });
    expect(r.ok).toBe(false);
    expect(r.skippedTests[0]).toContain("/gone.test.ts");
  });

  it("todo رد‌شده حساب نمی‌شود ولی گزارش می‌شود (نمونه‌های مرجع منتظر حقوقدان)", () => {
    const r = evaluateReport(report(file("/a.test.ts", [...ok(3), { status: "todo", fullName: "حقوقدان: نمونهٔ مرجع" }])), { minPassed: 3 });
    expect(r.ok).toBe(true);
    expect(r.summary.todo).toBe(1);
    expect(r.todoTests[0]).toContain("حقوقدان");
  });

  it("چنگک: کمتر از کف سبز (فایل تست بی‌صدا حذف/نادیده‌گرفته شده) ⇒ قرمز؛ برابر کف ⇒ سبز", () => {
    expect(evaluateReport(report(file("/a.test.ts", ok(9))), { minPassed: 10 }).ok).toBe(false);
    expect(evaluateReport(report(file("/a.test.ts", ok(10))), { minPassed: 10 }).ok).toBe(true);
  });

  it("گزارش خالی (هیچ فایلی اجرا نشد) ⇒ قرمز", () => {
    expect(evaluateReport(report(), { minPassed: 1 }).ok).toBe(false);
  });

  it("ورودی خراب/ناشناخته هرگز «سبز» نمی‌شود (ایمن‌به‌طور پیش‌فرض)", () => {
    const bad: unknown[] = [null, undefined, 42, "x", [], {}, { testResults: "no" }, { testResults: [null] }, { testResults: [{ name: "a", status: "passed" }] }, { testResults: [{ name: "a", status: "passed", assertionResults: [{}] }] }];
    for (const b of bad) {
      const r = evaluateReport(b, { minPassed: 0 });
      expect(r.ok, JSON.stringify(b)).toBe(false);
      expect(r.problems.length).toBeGreaterThan(0);
    }
  });

  it("کف مقرر هرگز از آخرین مقدار تأییدشده (تاریخچهٔ گیت) کمتر نیست؛ عدد سنجاق‌شده ندارد (ADR-0012)", () => {
    expect(MIN_PASSED_TESTS).toBeGreaterThanOrEqual(requiredFloor(readFloorHistory(fileURLToPath(new URL("..", import.meta.url))) ?? []));
  });
});
