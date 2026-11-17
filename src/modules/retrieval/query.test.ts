import { describe, expect, it } from "vitest";
import { SEARCH_LIMITS } from "@/modules/legal-kb-store";
import { searchKey } from "@/modules/persian-text";
import { MAX_QUESTION_CHARS, STOPWORDS_FA, isStopword, planQuery, planRelaxation } from "./query";
import { compareArticleLabels } from "./rank";

const plan = (q: unknown, maxTerms?: number) => {
  const r = planQuery(q, maxTerms);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};
const fail = (q: unknown, maxTerms?: number) => {
  const r = planQuery(q, maxTerms);
  if (r.ok) throw new Error("باید شکست می‌خورد");
  return r.error;
};

describe("retrieval · planQuery", () => {
  it("پرسش طبیعی به واژه‌های محتوایی می‌کاهد و واژه‌های ربطی را ثبت می‌کند", () => {
    const p = plan("آیا فروشنده مکلف به تحویل مبیع است؟");
    expect(p.tokens).toEqual(["فروشنده", "مکلف", "تحویل", "مبیع"]);
    expect(p.stopwords).toEqual(["ایا", "به", "است"]);
    expect(p.unsearchable).toEqual([]);
    expect(p.truncated).toEqual([]);
  });

  it("نرمال‌سازی همان searchKey است: ارقام فارسی/عربی، ی/ک عربی، همزه، نیم‌فاصله", () => {
    expect(plan("مادهٔ ۱۰ مکرر").tokens).toEqual(["ماده", "10", "مکرر"]);
    expect(plan("ماده ١٠").tokens).toEqual(["ماده", "10"]);
    expect(plan("كتاب‌ها").tokens).toEqual(["کتاب"]); // «ها» واژهٔ ربطی است
    expect(plan("كتاب‌ها").stopwords).toEqual(["ها"]);
  });

  it("واژهٔ تکراری یک‌بار می‌آید (ترتیب نخستین ورود)", () => {
    expect(plan("ثمن مبیع ثمن مبیع ثمن").tokens).toEqual(["ثمن", "مبیع"]);
  });

  it("ورودی نامعتبر INVALID_INPUT است و برش بی‌صدا ندارد", () => {
    for (const bad of [undefined, null, 5, {}, [], true]) expect(fail(bad).code).toBe("INVALID_INPUT");
    expect(fail("الف ".repeat(MAX_QUESTION_CHARS)).code).toBe("INVALID_INPUT");
    expect(planQuery("الف".repeat(10)).ok).toBe(true);
    expect(fail("ب".repeat(MAX_QUESTION_CHARS)).code).toBe("EMPTY_QUERY"); // دقیقاً در سقف: طول مجاز است، ولی یک واژهٔ بیش‌ازحد بلند ⇒ بدون واژهٔ محتوایی
  });

  it("سقف دقیق طول پرسش: ۲۰۰۰ نویسه پذیرفته، ۲۰۰۱ رد", () => {
    const ok = `ثمن ${"x".repeat(MAX_QUESTION_CHARS - 4)}`;
    expect(ok.length).toBe(MAX_QUESTION_CHARS);
    expect(fail(`${ok}y`).code).toBe("INVALID_INPUT");
    expect(plan(ok).unsearchable).toHaveLength(1);
  });

  it("پرسش بدون واژهٔ محتوایی EMPTY_QUERY است (فقط ربطی، نشانه، خالی، یا واژهٔ بیش‌ازحد بلند)", () => {
    for (const q of ["", "   ", "؟!؟", "آیا این است؟", "و در به از", "x".repeat(SEARCH_LIMITS.maxTokenChars + 1)]) expect(fail(q).code, q).toBe("EMPTY_QUERY");
  });

  it("واژهٔ بلندتر از ۶۴ نویسه unsearchable است و بقیه می‌مانند؛ دقیقاً ۶۴ مجاز است", () => {
    const long = "ا".repeat(SEARCH_LIMITS.maxTokenChars + 1);
    const exact = "ب".repeat(SEARCH_LIMITS.maxTokenChars);
    const p = plan(`ثمن ${long} ${exact}`);
    expect(p.unsearchable).toEqual([long]);
    expect(p.tokens).toEqual(["ثمن", exact]);
  });

  it("maxTerms: مرز معتبر ۱…۱۲، بیرونش INVALID_INPUT", () => {
    for (const bad of [0, -1, 13, 1.5, Number.NaN]) expect(fail("ثمن", bad).code, String(bad)).toBe("INVALID_INPUT");
    expect(planQuery("ثمن", 1).ok).toBe(true);
    expect(planQuery("ثمن", 12).ok).toBe(true);
  });

  it("سقف واژه‌ها: بلندترین‌ها می‌مانند، ترتیب ورود حفظ می‌شود و افتاده‌ها در truncated ثبت می‌شوند", () => {
    const p = plan("ثمن مبیع تحویل پرداخت خریدار", 3); // طول‌ها: 3 4 5 5 5
    expect(p.tokens).toEqual(["تحویل", "پرداخت", "خریدار"]);
    expect(p.truncated).toEqual(["ثمن", "مبیع"]);
  });

  it("سقف واژه‌ها: هم‌طول ⇒ واژهٔ زودتر می‌ماند؛ دقیقاً در سقف ⇒ هیچ برشی", () => {
    const p = plan("اب جد هو زح", 2);
    expect(p.tokens).toEqual(["اب", "جد"]);
    expect(p.truncated).toEqual(["هو", "زح"]);
    expect(plan("اب جد", 2).truncated).toEqual([]);
  });

  it("خروجی همیشه ≤ maxTerms، بی‌تکرار و نقطهٔ ثابتِ searchKey است (ورودی‌های تصادفی)", () => {
    let seed = 7;
    const next = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const alphabet = "ابپتثجچحخدذرزسشصضطظعغفقکگلمنوهیيك۰۱۲٣٤ ‌؟!.-\u064E\u0640";
    for (let i = 0; i < 300; i++) {
      const q = Array.from({ length: 1 + Math.floor(next() * 40) }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
      const mt = 1 + Math.floor(next() * 12);
      const r = planQuery(q, mt);
      if (!r.ok) {
        expect(r.error.code).toBe("EMPTY_QUERY");
        continue;
      }
      expect(r.value.tokens.length).toBeLessThanOrEqual(mt);
      expect(new Set(r.value.tokens).size).toBe(r.value.tokens.length);
      for (const t of r.value.tokens) {
        expect(searchKey(t), JSON.stringify(q)).toBe(t);
        expect(isStopword(t)).toBe(false);
      }
    }
  });

  it("فهرست واژه‌های ربطی: بدون «ماده»، ارقام و واژه‌های حقوقیِ معنادار؛ همه نقطهٔ ثابتِ نرمال‌سازی", () => {
    for (const must of ["ماده", "مگر", "بدون", "قبل", "بعد", "حق", "تبصره", "بند", "اصل"]) expect(isStopword(searchKey(must)), must).toBe(false);
    for (const w of STOPWORDS_FA) {
      expect(/[0-9۰-۹]/.test(w), w).toBe(false);
      for (const t of searchKey(w).split(" ")) expect(isStopword(t), w).toBe(true);
    }
    expect(isStopword("ایا")).toBe(true); // «آیا» پس از نرمال‌سازی
  });
});

const C = (n: number, k: number): number => (k === 0 || k === n ? 1 : C(n - 1, k - 1) + C(n - 1, k));
const isSubsequence = (sub: readonly string[], all: readonly string[]): boolean => {
  let i = 0;
  for (const t of all) if (t === sub[i]) i++;
  return i === sub.length;
};

describe("retrieval · planRelaxation", () => {
  const tk = (n: number) => Array.from({ length: n }, (_, i) => "w".repeat(i + 1)); // طول‌ها 1..n

  it("بدون واژه: خالی؛ یک واژه یا minCoverage=1: فقط گونهٔ کامل", () => {
    expect(planRelaxation([], { minCoverage: 0.6, maxQueries: 12 })).toEqual({ variants: [], complete: true });
    expect(planRelaxation(["ثمن"], { minCoverage: 0.1, maxQueries: 12 })).toEqual({ variants: [["ثمن"]], complete: true });
    expect(planRelaxation(tk(5), { minCoverage: 1, maxQueries: 12 }).variants).toEqual([tk(5)]);
  });

  it("کفِ ceil(n×minCoverage): دو واژه با ۰٫۶ آرام نمی‌شود؛ سه واژه تا دو واژه", () => {
    expect(planRelaxation(tk(2), { minCoverage: 0.6, maxQueries: 12 }).variants).toHaveLength(1);
    expect(planRelaxation(tk(3), { minCoverage: 0.6, maxQueries: 12 }).variants).toHaveLength(1 + 3);
    expect(planRelaxation(tk(2), { minCoverage: 0.5, maxQueries: 12 }).variants).toHaveLength(1 + 2);
    expect(planRelaxation(tk(4), { minCoverage: 0.75, maxQueries: 12 }).variants).toHaveLength(1 + 4); // ceil(3)=3
    expect(planRelaxation(tk(4), { minCoverage: 0.76, maxQueries: 12 }).variants).toHaveLength(1); // ceil(3.04)=4
  });

  it("ترتیب: کامل، سپس یک‌کمتر با افتادنِ کوتاه‌ترین واژه زودتر", () => {
    const t = ["ccc", "a", "bb"];
    const v = planRelaxation(t, { minCoverage: 0.6, maxQueries: 12 }).variants;
    expect(v).toEqual([["ccc", "a", "bb"], ["ccc", "bb"], ["ccc", "a"], ["a", "bb"]]);
  });

  it("هم‌وزن ⇒ ترتیب ورود؛ سطح‌ها از بزرگ به کوچک", () => {
    const v = planRelaxation(["aa", "bb", "cc", "dd"], { minCoverage: 0.5, maxQueries: 64 }).variants;
    expect(v.slice(1, 5)).toEqual([["bb", "cc", "dd"], ["aa", "cc", "dd"], ["aa", "bb", "dd"], ["aa", "bb", "cc"]]);
    expect(v.slice(5).every((x) => x.length === 2)).toBe(true);
    expect(v).toHaveLength(1 + 4 + 6);
  });

  it("خاصیت‌ها (n=1…۱۲، چند minCoverage): شمار = ΣC، یکتا، زیردنباله، سطح‌ها نزولی، قطعی", () => {
    for (let n = 1; n <= 12; n++) {
      for (const mc of [0.2, 0.5, 0.6, 0.9, 1]) {
        const t = tk(n);
        const r = planRelaxation(t, { minCoverage: mc, maxQueries: 64 });
        const minTerms = Math.min(n, Math.max(1, Math.ceil(n * mc - 1e-9)));
        let expected = 1;
        for (let k = n - 1; k >= minTerms; k--) expected += C(n, k);
        if (expected <= 64) {
          expect(r.variants).toHaveLength(expected);
          expect(r.complete).toBe(true);
        } else {
          expect(r.variants).toHaveLength(64);
          expect(r.complete).toBe(false);
        }
        expect(new Set(r.variants.map((v) => v.join("|"))).size).toBe(r.variants.length);
        for (const v of r.variants) {
          expect(isSubsequence(v, t)).toBe(true);
          expect(v.length).toBeGreaterThanOrEqual(minTerms);
        }
        for (let i = 1; i < r.variants.length; i++) expect((r.variants[i] as string[]).length).toBeLessThanOrEqual((r.variants[i - 1] as string[]).length);
        expect(planRelaxation(t, { minCoverage: mc, maxQueries: 64 })).toEqual(r);
      }
    }
  });

  it("سقف maxQueries دقیق است و complete را درست می‌گوید", () => {
    const t = tk(5); // minCoverage 0.6 ⇒ سطح‌ها 4 و 3: 1+5+10 = 16
    expect(planRelaxation(t, { minCoverage: 0.6, maxQueries: 16 })).toMatchObject({ complete: true });
    expect(planRelaxation(t, { minCoverage: 0.6, maxQueries: 16 }).variants).toHaveLength(16);
    const cut = planRelaxation(t, { minCoverage: 0.6, maxQueries: 15 });
    expect(cut.variants).toHaveLength(15);
    expect(cut.complete).toBe(false);
    expect(planRelaxation(t, { minCoverage: 0.6, maxQueries: 1 })).toEqual({ variants: [t], complete: false });
    expect(planRelaxation(t, { minCoverage: 0.6, maxQueries: 0 }).variants).toHaveLength(1); // کف ۱
  });
});

describe("retrieval · compareArticleLabels", () => {
  it("ترتیب طبیعی: ۹ پیش از ۱۰؛ مکرر پس از خودِ ماده؛ مکرر ۲ پس از مکرر؛ برچسب غیرعددی آخر", () => {
    const sorted = ["واحده", "10 مکرر 2", "10", "9", "10 مکرر", "100", "2"].sort(compareArticleLabels);
    expect(sorted).toEqual(["2", "9", "10", "10 مکرر", "10 مکرر 2", "100", "واحده"]);
    expect(compareArticleLabels("10 مکرر", "10")).toBeGreaterThan(0);
    expect(compareArticleLabels("10", "10 مکرر")).toBeLessThan(0);
    expect(compareArticleLabels("10 مکرر 2", "10 مکرر")).toBeGreaterThan(0);
    expect(compareArticleLabels("10 مکرر", "10 مکرر 2")).toBeLessThan(0);
    expect(compareArticleLabels("9", "10")).toBeLessThan(0);
    expect(compareArticleLabels("5", "5")).toBe(0);
    expect(compareArticleLabels("الف", "ب")).toBeLessThan(0);
    expect(compareArticleLabels("ب", "الف")).toBeGreaterThan(0);
  });
});
