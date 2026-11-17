import { describe, expect, it } from "vitest";
import { isValidIsoDate, parseIsoDate } from "./dates";
import {
  articleKey,
  canonicalArticleLabel,
  canonicalSubpartLabel,
  compareArticleLabels,
  formatArticleLabel,
  formatCitationKey,
  isValidDocumentId,
  parseArticleKey,
  parseArticleLabel,
  parseCitationKey,
  type ArticleLabel,
} from "./label";

const canon = (s: string) => {
  const r = canonicalArticleLabel(s);
  return r.ok ? r.value : `ERR:${r.error.code}`;
};

/** مولد شبه‌تصادفی قطعی (LCG)؛ تست‌ها باید تکرارپذیر باشند. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
}

describe("برچسب ماده: نرمال‌سازی به شکل متعارف", () => {
  it("ارقام فارسی، عربی و لاتین یکی‌اند", () => {
    expect(canon("۱۰")).toBe("10");
    expect(canon("١٠")).toBe("10");
    expect(canon("10")).toBe("10");
    expect(canon("۰۱۰")).toBe("10"); // صفر پیشرو
  });

  it("پیشوند «ماده»/«اصل» و فاصله‌ها", () => {
    expect(canon("ماده ۱۰")).toBe("10");
    expect(canon("اصل ۴۴")).toBe("44");
    expect(canon("  ماده   ۱۰  ")).toBe("10");
    expect(canon("ماده\u200C۱۰")).toBe("10"); // نیم‌فاصله
  });

  it("مکرر (با ک/ی عربی و کشیده)", () => {
    expect(canon("10 مکرر")).toBe("10 مکرر");
    expect(canon("۱۰ مكرر")).toBe("10 مکرر");
    expect(canon("ماده ۱۰ مکـــرر")).toBe("10 مکرر");
    expect(canon("10 مکرر 2")).toBe("10 مکرر 2");
    expect(canon("۱۰ مکرر ۲")).toBe("10 مکرر 2");
    expect(canon("10 مکرر 99")).toBe("10 مکرر 99");
  });

  it("واحده", () => {
    expect(canon("واحده")).toBe("واحده");
    expect(canon("ماده واحده")).toBe("واحده");
    expect(canon("ماده‌واحده")).toBe("واحده");
  });

  it("مرزها: ۱ و ۹۹۹۹۹ مجازند؛ ۰ و ۱۰۰۰۰۰ نه", () => {
    expect(canon("1")).toBe("1");
    expect(canon("99999")).toBe("99999");
    expect(canon("0")).toBe("ERR:OUT_OF_RANGE");
    expect(canon("100000")).toBe("ERR:INVALID_INPUT"); // ۶ رقم: الگو نمی‌خورد
  });

  it("شکل‌های مبهم یا ناشناخته = خطای صریح، نه حدس", () => {
    for (const bad of ["", "   ", "ماده", "abc", "10 bis", "10مکرر", "10 مکرر 1", "10 مکرر 100", "-5", "1.5", "1e3", "10 مکرر مکرر", "ماده ماده 10", "10 مکرر x", "مکرر 10"]) {
      expect(canon(bad).startsWith("ERR:"), bad).toBe(true);
    }
    expect(canon("10 مکرر 1")).toBe("ERR:OUT_OF_RANGE");
    expect(canon("10 مکرر 0")).toBe("ERR:OUT_OF_RANGE");
    expect(canon(5 as unknown as string)).toBe("ERR:INVALID_INPUT");
  });

  it("چند صفر پیشرو و رقم‌های مخلوط", () => {
    expect(canon("۰۰۰۰۷")).toBe("7");
    expect(canon("1۰")).toBe("10");
  });
});

describe("برچسب ماده: رفت‌وبرگشت و ترتیب (خاصیت)", () => {
  it("۲۰۰۰ برچسب تصادفی: format↔parse و key↔parseKey پایدارند", () => {
    const rnd = lcg(7);
    for (let i = 0; i < 2000; i++) {
      const label: ArticleLabel =
        rnd(10) === 0
          ? { kind: "single" }
          : { kind: "numbered", number: 1 + rnd(99999), repeat: rnd(3) === 0 ? 0 : rnd(2) === 0 ? 1 : 2 + rnd(98) };
      const text = formatArticleLabel(label);
      const back = parseArticleLabel(text);
      expect(back.ok && back.value).toEqual(label);
      const key = articleKey(label);
      const back2 = parseArticleKey(key);
      expect(back2.ok && back2.value).toEqual(label);
      expect(/^[a-z0-9-]+$/.test(key)).toBe(true);
    }
  });

  it("کلید یکتاست: دو برچسب متفاوت کلید یکسان ندارند", () => {
    const rnd = lcg(11);
    const seen = new Map<string, string>();
    for (let i = 0; i < 3000; i++) {
      const label: ArticleLabel = { kind: "numbered", number: 1 + rnd(40), repeat: rnd(4) };
      const k = articleKey(label);
      const f = formatArticleLabel(label);
      if (seen.has(k)) expect(seen.get(k)).toBe(f);
      seen.set(k, f);
    }
  });

  it("ترتیب طبیعی: واحده < شماره < مکرر < مکرر ۲ < شمارهٔ بعد", () => {
    const labels = ["11", "10 مکرر 2", "واحده", "10", "2", "10 مکرر", "1"];
    const sorted = labels
      .map((l) => parseArticleLabel(l))
      .map((r) => (r.ok ? r.value : (null as never)))
      .sort(compareArticleLabels)
      .map(formatArticleLabel);
    expect(sorted).toEqual(["واحده", "1", "2", "10", "10 مکرر", "10 مکرر 2", "11"]);
  });

  it("کلید غیرمتعارف رد می‌شود (برای هر ماده فقط یک کلید)", () => {
    for (const bad of ["007", "10-bis-1", "10-bis-02", "10-bis-100", "10-BIS", "0", "10-bis-", "bis", "10 ", "-10", "single2"]) {
      expect(parseArticleKey(bad).ok, bad).toBe(false);
    }
    expect(parseArticleKey(3 as unknown as string).ok).toBe(false);
  });
});

describe("برچسب تبصره/بند", () => {
  it("عدد و حروف فارسی", () => {
    const f = (s: string) => {
      const r = canonicalSubpartLabel(s);
      return r.ok ? r.value : `ERR:${r.error.code}`;
    };
    expect(f("۲")).toBe("2");
    expect(f("02")).toBe("2");
    expect(f("٣")).toBe("3");
    expect(f("الف")).toBe("الف");
    expect(f(" ب ")).toBe("ب");
    expect(f("ك")).toBe("ک"); // ک عربی
    expect(f("0")).toBe("ERR:OUT_OF_RANGE");
    expect(f("0000")).toBe("ERR:INVALID_INPUT");
    expect(f("1000")).toBe("ERR:INVALID_INPUT");
    expect(f("999")).toBe("999");
    expect(f("a")).toBe("ERR:INVALID_INPUT");
    expect(f("")).toBe("ERR:INVALID_INPUT");
    expect(f("الف ب")).toBe("ERR:INVALID_INPUT");
    expect(f("الفباپتثج")).toBe("ERR:INVALID_INPUT"); // ۸ حرف
    expect(f(1 as unknown as string)).toBe("ERR:INVALID_INPUT");
  });
});

describe("شناسهٔ سند", () => {
  it("قالب و طول", () => {
    expect(isValidDocumentId("sample-law")).toBe(true);
    expect(isValidDocumentId("a")).toBe(true);
    expect(isValidDocumentId("a".repeat(64))).toBe(true);
    expect(isValidDocumentId("a".repeat(65))).toBe(false);
    for (const bad of ["", "-a", "a-", "a--b", "A", "a_b", "a/b", "قانون", "a b", "a.b", "../x"]) expect(isValidDocumentId(bad), bad).toBe(false);
    expect(isValidDocumentId(5)).toBe(false);
    expect(isValidDocumentId(null)).toBe(false);
  });
});

describe("کلید ارجاع", () => {
  it("رفت‌وبرگشت با و بدون بخش", () => {
    const refs = [
      { documentId: "sample-law", article: "10", subpart: null },
      { documentId: "sample-law", article: "10 مکرر", subpart: null },
      { documentId: "x1", article: "10 مکرر 3", subpart: { kind: "note" as const, label: "2" } },
      { documentId: "x1", article: "واحده", subpart: { kind: "clause" as const, label: "الف" } },
    ];
    const keys = refs.map((r) => {
      const k = formatCitationKey(r);
      return k.ok ? k.value : "ERR";
    });
    expect(keys).toEqual(["sample-law/10", "sample-law/10-bis", "x1/10-bis-3/note/2", "x1/single/clause/الف"]);
    keys.forEach((k, i) => {
      const back = parseCitationKey(k);
      expect(back.ok && back.value).toEqual(refs[i]);
    });
  });

  it("ورودی انسانی به شکل متعارف تبدیل می‌شود", () => {
    const k = formatCitationKey({ documentId: "a", article: "ماده ۱۰ مکرر", subpart: { kind: "note", label: "۲" } });
    expect(k.ok && k.value).toBe("a/10-bis/note/2");
  });

  it("کلید نامعتبر", () => {
    for (const bad of ["", "a", "a/b/c", "a/10/foo/1", "A/10", "a/10/note/02", "a/10/note/x", "a/10/note/", "a/007", "a/10/note/1/extra", "/10"]) {
      expect(parseCitationKey(bad).ok, bad).toBe(false);
    }
    expect(parseCitationKey(1 as unknown as string).ok).toBe(false);
    expect(formatCitationKey({ documentId: "BAD", article: "1", subpart: null }).ok).toBe(false);
    expect(formatCitationKey({ documentId: "a", article: "zz", subpart: null }).ok).toBe(false);
    expect(formatCitationKey({ documentId: "a", article: "1", subpart: { kind: "foo" as "note", label: "1" } }).ok).toBe(false);
    expect(formatCitationKey({ documentId: "a", article: "1", subpart: { kind: "note", label: "x" } }).ok).toBe(false);
  });
});

describe("تاریخ میلادی ISO", () => {
  it("کبیسه‌ها (قاعدهٔ ۴/۱۰۰/۴۰۰)", () => {
    expect(isValidIsoDate("2000-02-29")).toBe(true);
    expect(isValidIsoDate("2024-02-29")).toBe(true);
    expect(isValidIsoDate("1900-02-29")).toBe(false);
    expect(isValidIsoDate("2100-02-29")).toBe(false);
    expect(isValidIsoDate("2023-02-29")).toBe(false);
    expect(isValidIsoDate("2023-02-28")).toBe(true);
  });

  it("طول ماه‌ها و قالب", () => {
    expect(isValidIsoDate("2024-04-30")).toBe(true);
    expect(isValidIsoDate("2024-04-31")).toBe(false);
    expect(isValidIsoDate("2024-12-31")).toBe(true);
    for (const bad of ["2024-13-01", "2024-00-10", "2024-01-00", "2024-1-01", "2024-01-1", " 2024-01-01", "2024-01-01 ", "2024-01-01T00:00:00Z", "20240101", "۲۰۲۴-۰۱-۰۱", "", "2024/01/01"]) {
      expect(isValidIsoDate(bad), bad).toBe(false);
    }
    expect(isValidIsoDate(20240101)).toBe(false);
    expect(isValidIsoDate(null)).toBe(false);
  });

  it("حدود سال: ۱۸۰۰ تا ۲۲۰۰؛ تاریخ جلالی (۱۴۰۳) به‌اشتباه به‌جای میلادی رد می‌شود", () => {
    expect(isValidIsoDate("1799-12-31")).toBe(false);
    expect(isValidIsoDate("1800-01-01")).toBe(true);
    expect(isValidIsoDate("2200-12-31")).toBe(true);
    expect(isValidIsoDate("2201-01-01")).toBe(false);
    expect(isValidIsoDate("1403-01-01")).toBe(false);
    const r = parseIsoDate("1403-01-01");
    expect(!r.ok && r.error.code).toBe("INVALID_DATE");
    const r2 = parseIsoDate(5);
    expect(!r2.ok && r2.error.code).toBe("INVALID_DATE");
  });
});
