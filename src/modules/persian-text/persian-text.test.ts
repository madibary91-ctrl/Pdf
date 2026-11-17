import { describe, expect, it } from "vitest";
import {
  containsPersian,
  formatInteger,
  normalizeForDisplay,
  normalizeForStorage,
  normalizePersianText,
  parseInteger,
  searchKey,
  tokenize,
  toLatinDigits,
  toPersianDigits,
} from "./index";

const ZWNJ = "\u200C";

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("persian-text: یکسان‌سازی نویسه‌ها", () => {
  it("ي/ى → ی و ك/ڪ → ک", () => {
    expect(normalizeForStorage("علي كتاب مصطفى")).toBe("علی کتاب مصطفی");
    expect(normalizeForStorage("ڪتاب")).toBe("کتاب");
  });

  it("هاء‌های متفرقه → ه", () => {
    expect(normalizeForStorage("ھمه ہمه")).toBe("همه همه");
  });

  it("کشیده و اعراب", () => {
    expect(normalizeForStorage("اللّـه")).toBe("اللّه"); // کشیده حذف، اعراب (تشدید) در ذخیره می‌ماند
    expect(normalizePersianText("مَدَنی", { removeDiacritics: true })).toBe("مدنی");
  });

  it("شکل‌های ارائه (ﻛ ﻳ ﻻ) به حروف پایه", () => {
    expect(normalizeForStorage("\uFEDB\uFEF3\uFEFC")).toBe("کیلا");
  });

  it("نشانه‌های جهت‌دهی و فاصلهٔ نامرئی حذف می‌شوند", () => {
    expect(normalizeForStorage("\u200Fماده\u200E ۱۰\uFEFF")).toBe("ماده ۱۰");
    expect(normalizeForStorage("a\u200Bb\u200Dc")).toBe("abc");
  });

  it("ورودی تهی و بدون تغییر", () => {
    expect(normalizeForStorage("")).toBe("");
    expect(normalizeForStorage("   \n\t ")).toBe("");
    expect(normalizeForStorage("سلام")).toBe("سلام");
    expect(normalizeForStorage("Hello World")).toBe("Hello World");
  });

  it("خودتوانی: اعمال دوباره نتیجه را عوض نمی‌کند", () => {
    const samples = [
      "علي  كتاب‌ ها ي من\u200F  می خواهم؟\n\n\n\nبله ,  حتما ;",
      "ماده ١٠ قانون مدني: «تعهدات»",
      "می\u200C\u200Cخواهم  ‌ ‌ دانشجو‌ها",
    ];
    for (const s of samples) {
      for (const fn of [normalizeForStorage, normalizeForDisplay, searchKey]) {
        const once = fn(s);
        expect(fn(once)).toBe(once);
      }
    }
  });
});

describe("persian-text: فاصله‌ها و نیم‌فاصله", () => {
  it("فاصله‌های متعدد و عجیب یکی می‌شوند", () => {
    expect(normalizeForStorage("الف   ب\u00A0\u00A0ج\t\td")).toBe("الف ب ج d");
  });

  it("خط‌های خالی بیش از یکی ادغام و انتهای خطوط پاک می‌شود", () => {
    expect(normalizeForStorage("یک  \r\n\r\n\r\n\r\nدو \r سه")).toBe("یک\n\nدو\nسه");
  });

  it("نیم‌فاصلهٔ تکراری، کنار فاصله و ابتدا/انتها پاک می‌شود، ولی میان کلمه می‌ماند", () => {
    expect(normalizeForStorage(`می${ZWNJ}${ZWNJ}خواهم`)).toBe(`می${ZWNJ}خواهم`);
    expect(normalizeForStorage(`کتاب${ZWNJ} ها`)).toBe("کتاب ها");
    expect(normalizeForStorage(`کتاب ${ZWNJ}ها`)).toBe("کتاب ها");
    expect(normalizeForStorage(`${ZWNJ}سلام${ZWNJ}`)).toBe("سلام");
  });

  it("اصلاح نیم‌فاصله: می/نمی و ها/های/تر/ترین", () => {
    const f = (s: string) => normalizePersianText(s, { fixHalfSpace: true });
    expect(f("می خواهم")).toBe(`می${ZWNJ}خواهم`);
    expect(f("او نمی دانست")).toBe(`او نمی${ZWNJ}دانست`);
    expect(f("کتاب ها")).toBe(`کتاب${ZWNJ}ها`);
    expect(f("خانه های بزرگ")).toBe(`خانه${ZWNJ}های بزرگ`);
    expect(f("بزرگ تر و بزرگ ترین")).toBe(`بزرگ${ZWNJ}تر و بزرگ${ZWNJ}ترین`);
  });

  it("اصلاح نیم‌فاصله به کلمات دیگر آسیب نمی‌زند", () => {
    const f = (s: string) => normalizePersianText(s, { fixHalfSpace: true });
    expect(f("کرمی می‌آید")).toBe("کرمی می‌آید");
    expect(f("می")).toBe("می");
    expect(f("ما تراشه دیدیم")).toBe("ما تراشه دیدیم"); // «تراشه» با «تر» شروع می‌شود
    expect(f("با هم")).toBe("با هم");
  });
});

describe("persian-text: ارقام", () => {
  it("تبدیل به فارسی و لاتین", () => {
    expect(toPersianDigits("ماده 10 و ٢٣")).toBe("ماده ۱۰ و ۲۳");
    expect(toLatinDigits("ماده ۱۰ و ٢٣")).toBe("ماده 10 و 23");
    expect(toLatinDigits("۱٬۲۰۰٫۵")).toBe("1,200.5");
    expect(toLatinDigits("٬ ٫")).toBe("٬ ٫"); // خارج از میان ارقام دست‌نخورده
  });

  it("گزینهٔ digits در normalizePersianText", () => {
    expect(normalizePersianText("۱۲ 12", { digits: "latin" })).toBe("12 12");
    expect(normalizePersianText("۱۲ 12", { digits: "persian" })).toBe("۱۲ ۱۲");
    expect(normalizePersianText("۱۲ 12")).toBe("۱۲ 12");
  });

  it("formatInteger", () => {
    expect(unwrap(formatInteger(1234567))).toBe("۱٬۲۳۴٬۵۶۷");
    expect(unwrap(formatInteger(1234567, { digits: "latin" }))).toBe("1,234,567");
    expect(unwrap(formatInteger(999))).toBe("۹۹۹");
    expect(unwrap(formatInteger(0))).toBe("۰");
    expect(unwrap(formatInteger(-1000))).toBe("-۱٬۰۰۰");
    expect(unwrap(formatInteger(1234567, { grouping: false, digits: "latin" }))).toBe("1234567");
    expect(unwrap(formatInteger(BigInt("12345678901234567890"), { digits: "latin" }))).toBe("12,345,678,901,234,567,890");
    expect(formatInteger(1.5).ok).toBe(false);
    expect(formatInteger(Number.NaN).ok).toBe(false);
    expect(formatInteger(2 ** 60).ok).toBe(false);
  });

  it("parseInteger", () => {
    expect(unwrap(parseInteger("۱٬۲۳۴٬۵۶۷"))).toBe(1234567);
    expect(unwrap(parseInteger("1,234,567"))).toBe(1234567);
    expect(unwrap(parseInteger(" ۵۰۰ "))).toBe(500);
    expect(unwrap(parseInteger("-۱۲"))).toBe(-12);
    expect(unwrap(parseInteger("\u2212۱۲"))).toBe(-12);
    expect(unwrap(parseInteger("1234567"))).toBe(1234567);
    for (const bad of ["", "abc", "۱۲٫۵", "1.5", "12,34", "۱۲ ۳۴ x", "--1", "1,,000"]) {
      expect(parseInteger(bad).ok).toBe(false);
    }
    expect(parseInteger("99999999999999999999").ok).toBe(false);
    expect(parseInteger(5 as unknown as string).ok).toBe(false);
  });

  it("رفت‌وبرگشت format ⇄ parse", () => {
    for (const n of [0, 1, 12, 999, 1000, 123456, 10_000_000_000, -5, -1_234_567]) {
      expect(unwrap(parseInteger(unwrap(formatInteger(n))))).toBe(n);
    }
  });
});

describe("persian-text: نشانه‌گذاری", () => {
  const f = (s: string) => normalizePersianText(s, { localizePunctuation: true, fixPunctuationSpacing: true });

  it("علامت‌های لاتین بعد از حرف فارسی به فارسی تبدیل می‌شوند", () => {
    expect(f("چرا؟")).toBe("چرا؟");
    expect(f("چرا?")).toBe("چرا؟");
    expect(f("بله, خیر; شاید")).toBe("بله، خیر؛ شاید");
  });

  it("علامت‌های لاتین در متن لاتین و اعداد دست‌نخورده می‌مانند", () => {
    expect(f("Hello, world? yes;")).toBe("Hello, world? yes;");
    expect(f("مبلغ ۱,۰۰۰ ریال")).toBe("مبلغ ۱,۰۰۰ ریال");
    expect(f("نسبت 1.5 برابر")).toBe("نسبت 1.5 برابر");
  });

  it("فاصله پیش از نشانه حذف و پس از آن اضافه می‌شود", () => {
    expect(f("سلام ، خوبی ؟")).toBe("سلام، خوبی؟");
    expect(f("سلام،خوبی")).toBe("سلام، خوبی");
    expect(f("ماده ۱۰:بند الف")).toBe("ماده ۱۰: بند الف");
    expect(f("نتیجه:خوب")).toBe("نتیجه: خوب");
    expect(f("( متن )")).toBe("(متن)");
    expect(f("« متن »")).toBe("«متن»");
  });

  it("ساعت و نشانی اینترنتی خراب نمی‌شود", () => {
    expect(f("ساعت 12:30 است")).toBe("ساعت 12:30 است");
    expect(f("https://example.com/a")).toBe("https://example.com/a");
  });
});

describe("persian-text: نمایش", () => {
  it("نمونهٔ ترکیبی", () => {
    expect(normalizeForDisplay("ماده  10 قانون مدني ,  كتاب ها مي باشد ?")).toBe(
      `ماده ۱۰ قانون مدنی، کتاب${ZWNJ}ها می${ZWNJ}باشد؟`,
    );
  });
});

describe("persian-text: کلید جست‌وجو و واژه‌ها", () => {
  it("ماده ۱۰ در همهٔ شکل‌ها یک کلید دارد", () => {
    expect(searchKey("ماده ۱۰")).toBe("ماده 10");
    expect(searchKey("مادهٔ ۱۰")).toBe("ماده 10"); // همزهٔ اضافه (ٔ) حذف می‌شود
    expect(searchKey("مادۀ ۱۰")).toBe("ماده 10");
    expect(searchKey("ماده 10")).toBe("ماده 10");
    expect(searchKey("ماده ١٠")).toBe("ماده 10");
    expect(searchKey("«ماده ۱۰»")).toBe("ماده 10");
    expect(searchKey("ماده  ۱۰.")).toBe("ماده 10");
  });

  it("همزه‌ها و اعراب", () => {
    expect(searchKey("آیین دادرسی")).toBe(searchKey("ایین دادرسی"));
    expect(searchKey("مسئول")).not.toBe(searchKey("مسؤول")); // ئ و ؤ عمداً یکی نمی‌شوند: دو املای رایج متفاوت
    expect(searchKey("مَسْئُولیّت")).toBe("مسیولیت");
    expect(searchKey("أحمد إبراهيم")).toBe("احمد ابراهیم");
  });

  it("ي/ك عربی با فارسی یکی است", () => {
    expect(searchKey("كتاب علي")).toBe(searchKey("کتاب علی"));
  });

  it("حروف لاتین کوچک می‌شوند", () => {
    expect(searchKey("PDF و Word")).toBe("pdf و word");
  });

  it("نیم‌فاصله: پیش‌فرض فاصله، یا حذف", () => {
    expect(searchKey(`می${ZWNJ}خواهم`)).toBe("می خواهم");
    expect(searchKey(`کتاب${ZWNJ}ها`, { zwnj: "remove" })).toBe("کتابها");
    expect(searchKey(`کتاب${ZWNJ}ها`)).toBe("کتاب ها");
  });

  it("جداکنندهٔ هزارگان از اعداد برداشته می‌شود", () => {
    expect(searchKey("۱٬۰۰۰٬۰۰۰ ریال")).toBe("1000000 ریال");
    expect(searchKey("1,000,000 ریال")).toBe("1000000 ریال");
  });

  it("tokenize", () => {
    expect(tokenize("ماده ۱۰، قانون مدنی؛")).toEqual(["ماده", "10", "قانون", "مدنی"]);
    expect(tokenize("   ")).toEqual([]);
    expect(tokenize("،؛؟")).toEqual([]);
  });

  it("containsPersian", () => {
    expect(containsPersian("abc ی")).toBe(true);
    expect(containsPersian("abc 123")).toBe(false);
    expect(containsPersian("")).toBe(false);
  });
});
