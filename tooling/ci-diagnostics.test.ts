/** آزمون تشخیص علت شکست در دروازهٔ CI (describeFailures): خالص، بدون پایگاه. */
import { describe, expect, it } from "vitest";
import { describeFailures, gateAnnotation } from "./ci-tests";

const ESC = String.fromCharCode(27);
const assertion = (status: string, fullName: string, failureMessages: string[] = []) => ({ status, fullName, title: "t", ancestorTitles: [], failureMessages });
const file = (name: string, assertions: ReturnType<typeof assertion>[], status = "failed", message = "") => ({ name, status, message, assertionResults: assertions });

describe("tooling: علت شکست‌ها در خروجی دروازه (describeFailures)", () => {
  it("نام تست و فقط اولین خط پیام را می‌آورد؛ مسیر مطلق به نسبی کوتاه می‌شود", () => {
    const out = describeFailures({
      testResults: [file("/home/runner/work/Pdf/Pdf/src/modules/x/a.test.ts", [assertion("passed", "سبز"), assertion("failed", "الف > ب", ["Error: Test timed out in 5000ms.\n    at stack…"])])],
    });
    expect(out).toEqual(["src/modules/x/a.test.ts › الف > ب — Error: Test timed out in 5000ms."]);
  });

  it("مسیر ویندوزی هم نرمال می‌شود", () => {
    const out = describeFailures({ testResults: [file("C:\\w\\Pdf\\tooling\\b.test.ts", [assertion("failed", "ت", ["boom"])])] });
    expect(out).toEqual(["tooling/b.test.ts › ت — boom"]);
  });

  it("کدهای رنگ ANSI از پیام حذف می‌شود و خط خالصِ اول نادیده گرفته می‌شود", () => {
    const out = describeFailures({ testResults: [file("/r/src/c.test.ts", [assertion("failed", "ت", [`\n${ESC}[31mAssertionError${ESC}[39m: expected 1 to be 2`])])] });
    expect(out).toEqual(["src/c.test.ts › ت — AssertionError: expected 1 to be 2"]);
  });

  it("فایلی که بارگذاری نشد (بدون assertion) با پیام سطح فایل گزارش می‌شود", () => {
    const out = describeFailures({ testResults: [file("/r/src/d.test.ts", [], "failed", "DATABASE_URL is required\n at …")] });
    expect(out).toEqual(["src/d.test.ts — DATABASE_URL is required"]);
  });

  it("فایل بدون پیام: متن پیش‌فرض؛ تست رد‌شده/todo/سبز گزارش نمی‌شود", () => {
    const out = describeFailures({
      testResults: [file("/r/src/e.test.ts", [], "failed"), file("/r/src/f.test.ts", [assertion("skipped", "س"), assertion("todo", "ت"), assertion("passed", "ک")], "passed")],
    });
    expect(out).toEqual(["src/e.test.ts — فایل اجرا نشد"]);
  });

  it("شکستِ بدون failureMessages: «(بدون پیام)»", () => {
    const out = describeFailures({ testResults: [file("/r/src/g.test.ts", [assertion("failed", "ت")])] });
    expect(out).toEqual(["src/g.test.ts › ت — (بدون پیام)"]);
  });

  it("سقف تعداد: بیش از limit ⇒ خلاصهٔ «… و N مورد دیگر»", () => {
    const many = Array.from({ length: 5 }, (_, i) => assertion("failed", `ت${i}`, ["x"]));
    const out = describeFailures({ testResults: [file("/r/src/h.test.ts", many)] }, 2);
    expect(out).toHaveLength(3);
    expect(out[2]).toBe("… و 3 مورد دیگر");
  });

  it("گزارش خراب/نامعتبر هرگز پرتاب نمی‌کند و فهرست خالی می‌دهد", () => {
    for (const bad of [null, undefined, 42, "x", [], {}, { testResults: "x" }, { testResults: [null, 1, {}, { name: 5 }] }]) {
      expect(() => describeFailures(bad)).not.toThrow();
      expect(describeFailures(bad)).toEqual([]);
    }
  });

  it("گزارش کاملاً سبز ⇒ فهرست خالی", () => {
    expect(describeFailures({ testResults: [file("/r/src/i.test.ts", [assertion("passed", "ک")], "passed")] })).toEqual([]);
  });
});

describe("tooling: annotationِ کنترل منفی (gateAnnotation)", () => {
  it("در اجرای عادی خطا همچنان ::error:: است و خط‌شکن‌ها حذف می‌شود", () => {
    expect(gateAnnotation("error", "الف\nب", false)).toBe("::error::الف ب");
  });

  it("در کنترل منفی، خطا به notice با برچسب «مورد انتظار» تنزل می‌یابد (هرگز ::error:: نیست)", () => {
    const line = gateAnnotation("error", "KB_TEST_DATABASE_URL یا DATABASE_URL لازم است", true);
    expect(line.startsWith("::notice::")).toBe(true);
    expect(line).toContain("مورد انتظار");
    expect(line).not.toContain("::error::");
    expect(line).toContain("KB_TEST_DATABASE_URL"); // متن اصلی برای عیب‌یابی حفظ می‌شود
  });

  it("سطح notice/warning در کنترل منفی دست‌نخورده می‌ماند", () => {
    expect(gateAnnotation("warning", "w", true)).toBe("::warning::w");
    expect(gateAnnotation("notice", "n", true)).toBe("::notice::n");
  });
});
