import { describe, expect, it } from "vitest";
import { MAX_CONTEXT_CHARS, MIN_CONTEXT_CHARS, TRUNCATION_MARK, buildContext, lookupSource } from "./context";
import type { Context, Passage } from "./types";

const passage = (article: string, text: string, extra: Partial<Passage> = {}): Passage => ({
  ref: { documentId: "law-a", article, validFrom: "2001-01-01" },
  citation: { documentId: "law-a", article, subpart: null },
  documentTitle: "قانون ساختگی",
  validTo: null,
  text,
  subparts: [],
  verified: true,
  contentHash: "h",
  matchedTerms: [],
  missingTerms: [],
  coverage: 1,
  score: 1,
  ...extra,
});
const ctx = (ps: readonly Passage[], o?: Parameters<typeof buildContext>[1]): Context => {
  const r = buildContext(ps, o);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe("retrieval · buildContext", () => {
  it("منبع‌ها S1، S2، … به ترتیب رتبه با سرایند و تبصره/بند برچسب‌دار", () => {
    const c = ctx([
      passage("2", "متن دو", { subparts: [{ kind: "note", label: "1", text: "نکتهٔ یک" }, { kind: "clause", label: "الف", text: "بند الف" }], validTo: "2010-01-01" }),
      passage("1", "متن یک"),
    ]);
    expect(c.sources.map((s) => s.id)).toEqual(["S1", "S2"]);
    expect(c.sources[0]?.citation).toEqual({ documentId: "law-a", article: "2", subpart: null });
    expect(c.text).toBe(
      "[S1] قانون ساختگی — ماده 2 (معتبر از 2001-01-01 تا 2010-01-01)\nمتن دو\nتبصره 1: نکتهٔ یک\nبند الف: بند الف\n\n[S2] قانون ساختگی — ماده 1 (معتبر از 2001-01-01 تا اکنون)\nمتن یک",
    );
    expect(c.omitted).toBe(0);
    expect(c.omittedUnverified).toBe(0);
  });

  it("بند تأییدنشده به‌طور پیش‌فرض وارد نمی‌شود (و شماره‌گذاری پس از آن پیوسته است)؛ با allowUnverified می‌آید و علامت دارد", () => {
    const ps = [passage("1", "الف"), passage("2", "ب", { verified: false }), passage("3", "ج")];
    const c = ctx(ps);
    expect(c.sources.map((s) => `${s.id}:${s.citation.article}`)).toEqual(["S1:1", "S2:3"]);
    expect(c.omittedUnverified).toBe(1);
    expect(c.text).not.toContain("تأییدنشده");
    const d = ctx(ps, { allowUnverified: true });
    expect(d.sources).toHaveLength(3);
    expect(d.sources[1]?.verified).toBe(false);
    expect(d.sources[1]?.header).toContain("تأییدنشده");
    expect(d.omittedUnverified).toBe(0);
    // مقدارِ truthy غیرِ true دور زدن نیست
    expect(ctx(ps, { allowUnverified: "yes" as unknown as boolean }).sources).toHaveLength(2);
  });

  it("ورودی خالی ⇒ متن خالی؛ maxChars نامعتبر ⇒ INVALID_INPUT (بدون پرتاب)", () => {
    expect(ctx([])).toEqual({ text: "", sources: [], omitted: 0, omittedUnverified: 0 });
    for (const bad of [0, 199, 200_001, 1.5, Number.NaN, -5]) {
      const r = buildContext([passage("1", "x")], { maxChars: bad });
      expect(r.ok, String(bad)).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
    }
    expect(buildContext([], { maxChars: MIN_CONTEXT_CHARS }).ok).toBe(true);
    expect(buildContext([], { maxChars: MAX_CONTEXT_CHARS }).ok).toBe(true);
  });

  it("مرز دقیق سقف: بلوکی که درست جا شود می‌آید، یک نویسه کمتر ⇒ برش/حذف", () => {
    const big = passage("1", "ا".repeat(400));
    const e2 = ctx([big], { maxChars: 10_000 }).text.length;
    expect(ctx([big], { maxChars: e2 }).sources[0]?.truncated).toBe(false);
    const cut = ctx([big], { maxChars: e2 - 1 });
    expect(cut.sources[0]?.truncated).toBe(true);
    expect(cut.text.length).toBeLessThanOrEqual(e2 - 1);
  });

  it("نخستین بندِ بزرگ با علامت صریح برش می‌خورد و بقیه در omitted شمرده می‌شوند", () => {
    const c = ctx([passage("1", "ب".repeat(1000)), passage("2", "کوتاه")], { maxChars: 300 });
    expect(c.sources).toHaveLength(1);
    expect(c.sources[0]?.truncated).toBe(true);
    expect(c.sources[0]?.body.endsWith(TRUNCATION_MARK)).toBe(true);
    expect(c.text.length).toBeLessThanOrEqual(300);
    expect(c.omitted).toBe(1);
  });

  it("ترتیب رتبه حفظ می‌شود: بندِ بزرگِ جانیفتاده، بندهای کوچک‌ترِ بعدی را جلو نمی‌اندازد", () => {
    const c = ctx([passage("1", "الف"), passage("2", "ب".repeat(900)), passage("3", "ج")], { maxChars: 400 });
    expect(c.sources.map((s) => s.citation.article)).toEqual(["1"]);
    expect(c.omitted).toBe(2);
    expect(c.sources.every((s) => !s.truncated)).toBe(true); // برش فقط برای نخستین بند
  });

  it("خاصیت: طول متن هرگز از maxChars بیشتر نیست و شناسه‌ها پیوسته‌اند (ورودی‌های تصادفی)", () => {
    let seed = 99;
    const next = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < 200; i++) {
      const ps = Array.from({ length: 1 + Math.floor(next() * 6) }, (_, k) => passage(String(k + 1), "م".repeat(Math.floor(next() * 800)), { verified: next() > 0.2 }));
      const maxChars = MIN_CONTEXT_CHARS + Math.floor(next() * 1500);
      const c = ctx(ps, { maxChars });
      expect(c.text.length).toBeLessThanOrEqual(maxChars);
      c.sources.forEach((s, k) => expect(s.id).toBe(`S${k + 1}`));
      expect(c.sources.length + c.omitted + c.omittedUnverified).toBe(ps.length);
    }
  });

  it("برش، جفت‌جانشین (emoji) را نمی‌شکند (چند سقف متوالی تا مرزِ فرد و زوج هر دو دیده شود)", () => {
    for (let maxChars = 300; maxChars <= 305; maxChars++) {
      const c = ctx([passage("1", "😀".repeat(500))], { maxChars });
      expect(c.sources[0]?.truncated).toBe(true);
      expect(c.text.length).toBeLessThanOrEqual(maxChars);
      expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(c.text), String(maxChars)).toBe(false); // جانشینِ بالایِ تنها
      expect(/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(c.text), String(maxChars)).toBe(false); // جانشینِ پایینیِ تنها
    }
  });
});

describe("retrieval · lookupSource", () => {
  const c = ctx([passage("1", "الف"), passage("2", "ب")]);
  it("شناسهٔ موجود ⇒ منبع؛ جعلی، ناموجود، یا غیرمتن ⇒ null", () => {
    expect(lookupSource(c, "S2")?.citation.article).toBe("2");
    for (const bad of ["S3", "s1", "S0", "S1 ", "", null, undefined, 1, {}, ["S1"]]) expect(lookupSource(c, bad), String(bad)).toBeNull();
  });
});
