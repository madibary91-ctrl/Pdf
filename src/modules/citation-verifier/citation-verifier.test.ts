import { describe, expect, it } from "vitest";
import { buildCorpusIndex, FICTIONAL_SAMPLE_CORPUS, loadCorpus, type CorpusIndex } from "@/modules/legal-kb-schema";
import {
  buildAliasTable,
  checkQuote,
  checkText,
  DEFAULT_REDACTION,
  extractMentions,
  MIN_QUOTE_CHARS,
  redactRejected,
  verifyCitation,
  verifyCitations,
  type CitationClaim,
} from "./index";
import { foldWord, isLinkGap, tokenize } from "./tokens";

function sampleIndex(mutate?: (c: any) => void): CorpusIndex {
  const raw = JSON.parse(JSON.stringify(FICTIONAL_SAMPLE_CORPUS));
  mutate?.(raw);
  const r = loadCorpus(raw);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return buildCorpusIndex(r.value);
}
const IDX = sampleIndex();
const claim = (documentId: string, article: string, subpart: CitationClaim["ref"]["subpart"] = null, quote?: string | null): CitationClaim => ({
  ref: { documentId, article, subpart },
  ...(quote === undefined ? {} : { quote }),
});

describe("tokens: هم‌سان‌سازی نگارش و واژه‌بندی", () => {
  it("foldWord: ارقام، ی/ک عربی، اعراب، کشیده و حروف لاتین", () => {
    expect(foldWord("۱۲۳")).toBe("123");
    expect(foldWord("٤٥٦")).toBe("456");
    expect(foldWord("علي")).toBe("علی");
    expect(foldWord("كتاب")).toBe("کتاب");
    expect(foldWord("مُدَّت")).toBe("مدت");
    expect(foldWord("ســلام")).toBe("سلام");
    expect(foldWord("ABC")).toBe("abc");
    expect(foldWord("نمونهٔ")).toBe("نمونه");
  });

  it("tokenize: نیم‌فاصله و نشانه‌گذاری مرز واژه‌اند و جایگاه‌ها به متن اصلی برمی‌گردند", () => {
    const text = "ماده‌ی ۱۰، قانون (نمونه)؛";
    const toks = tokenize(text);
    expect(toks.map((t) => t.folded)).toEqual(["ماده", "ی", "10", "قانون", "نمونه"]);
    for (const t of toks) expect(text.slice(t.start, t.end)).toBe(t.raw);
    expect(tokenize("   ،؛.  ")).toEqual([]);
    expect(tokenize("")).toEqual([]);
  });

  it("isLinkGap: فاصله/پرانتز مجاز؛ مرز جمله مجاز نیست", () => {
    for (const g of ["", " ", "  ", "\u200c", " (", ") ", " «", "- "]) expect(isLinkGap(g), JSON.stringify(g)).toBe(true);
    for (const g of [".", "،", ", ", "؛", ":", "؟", "!", " . ", "\n"].filter((x) => x !== "\n")) expect(isLinkGap(g), JSON.stringify(g)).toBe(false);
  });
});

describe("checkQuote", () => {
  const T = "متن ساختگی ماده ۲ که در آن مهلت پرداخت سی روز پس از ابلاغ است.";
  it("برش پیوسته از متن پذیرفته می‌شود؛ نگارش (ارقام، نیم‌فاصله، نشانه) اثری ندارد", () => {
    expect(checkQuote("مهلت پرداخت سی روز", [T]).ok).toBe(true);
    expect(checkQuote("«ماده 2 كه در آن»", [T]).ok).toBe(true);
    expect(checkQuote("ماده ۲، که در آن", [T]).ok).toBe(true);
  });
  it("واژه‌ای که در متن نیست، ترتیب جابه‌جا، و زیررشتهٔ میانِ واژه رد می‌شود", () => {
    expect(checkQuote("مهلت پرداخت شصت روز", [T]).ok).toBe(false);
    expect(checkQuote("روز سی پرداخت مهلت", [T]).ok).toBe(false);
    expect(checkQuote("مهلت پردا", [T]).ok).toBe(false); // نیمهٔ یک واژه
    expect(checkQuote("هلت پرداخت سی", [T]).ok).toBe(false);
  });
  it("«…» بخش‌ها را جدا می‌کند؛ بخش‌ها باید به‌ترتیب و بی‌هم‌پوشانی بیایند", () => {
    expect(checkQuote("متن ساختگی ماده … پس از ابلاغ است", [T]).ok).toBe(true);
    expect(checkQuote("متن ساختگی ماده ... پس از ابلاغ است", [T]).ok).toBe(true);
    expect(checkQuote("پس از ابلاغ است … متن ساختگی ماده", [T]).ok).toBe(false);
    expect(checkQuote("مهلت پرداخت … پرداخت سی روز", [T]).ok).toBe(false); // هم‌پوشان
  });
  it("نقل‌قولِ خالی یا بسیار کوتاه رد می‌شود (و کف طول با واژه‌های کوتاه هم دور زده نمی‌شود)", () => {
    for (const q of ["", "   ", "…", "، ؛", "و", "ماده", "در آن"]) {
      const r = checkQuote(q, [T]);
      expect(r.ok, q).toBe(false);
    }
    expect(MIN_QUOTE_CHARS).toBeGreaterThanOrEqual(6);
  });
  it("همهٔ بخش‌ها باید در یک متن بیایند، نه پراکنده بین چند متن", () => {
    expect(checkQuote("الفبای نخست … واژهٔ دوم متن", ["الفبای نخست بدون ادامه", "یک جملهٔ دیگر که واژهٔ دوم متن دارد"]).ok).toBe(false);
    expect(checkQuote("الفبای نخست … واژهٔ دوم متن", ["الفبای نخست و سپس واژهٔ دوم متن"]).ok).toBe(true);
  });
});

describe("verifyCitation: همهٔ حکم‌ها روی نمونهٔ ساختگی", () => {
  it("valid: نسخهٔ تأییدشده و معتبر در تاریخ", () => {
    const v = verifyCitation(IDX, claim("sample-law", "1"), "2005-01-01");
    expect(v.code).toBe("valid");
    expect(v.accepted).toBe(true);
    expect(v.evidence).toEqual({ documentId: "sample-law", article: "1", validFrom: "2001-01-01", validTo: "2010-06-01", subpart: null, verified: true });
  });

  it("unverified-source: پیش‌فرض رد؛ با allowUnverified پذیرفته (ولی کُد همان می‌ماند)", () => {
    const strict = verifyCitation(IDX, claim("sample-law", "1"), "2024-01-01");
    expect(strict).toMatchObject({ code: "unverified-source", accepted: false });
    expect(strict.evidence?.verified).toBe(false);
    const lax = verifyCitation(IDX, claim("sample-law", "1"), "2024-01-01", { allowUnverified: true });
    expect(lax).toMatchObject({ code: "unverified-source", accepted: true });
    expect(lax.message).toContain("تأییدنشده");
    expect(verifyCitation(IDX, claim("sample-law", "1"), "2024-01-01", { allowUnverified: false }).accepted).toBe(false);
  });

  it("بازهٔ نیم‌باز: روز پایان و روز شروع", () => {
    expect(verifyCitation(IDX, claim("sample-law", "1"), "2010-05-31").evidence?.validFrom).toBe("2001-01-01");
    expect(verifyCitation(IDX, claim("sample-law", "1"), "2010-06-01").evidence?.validFrom).toBe("2010-06-01");
  });

  it("وضعیت‌های «نیست»", () => {
    const code = (c: CitationClaim, d: string) => verifyCitation(IDX, c, d).code;
    expect(code(claim("nope", "1"), "2005-01-01")).toBe("unknown-document");
    expect(code(claim("sample-law", "99"), "2005-01-01")).toBe("unknown-article");
    expect(code(claim("sample-law", "1", { kind: "note", label: "1" }), "2005-01-01")).toBe("unknown-subpart");
    expect(code(claim("sample-law", "2 مکرر"), "2005-01-01")).toBe("not-yet-in-force");
    expect(code(claim("sample-single-act", "واحده"), "2024-01-01")).toBe("no-longer-in-force");
    expect(code(claim("sample-law", "1"), "2016-06-01")).toBe("gap");
  });

  it("هیچ‌کدام از حکم‌های رد پذیرفته نیست، حتی با allowUnverified", () => {
    for (const c of [claim("nope", "1"), claim("sample-law", "99"), claim("sample-law", "2 مکرر")]) {
      expect(verifyCitation(IDX, c, "2005-01-01", { allowUnverified: true }).accepted).toBe(false);
    }
    expect(verifyCitation(IDX, claim("sample-law", "1"), "2016-06-01", { allowUnverified: true }).accepted).toBe(false);
  });

  it("ورودی بد ⇒ malformed (بدون پرتاب)", () => {
    const bad: unknown[] = [
      null,
      undefined,
      42,
      "x",
      [],
      {},
      { ref: null },
      { ref: { documentId: "", article: "1", subpart: null } },
      { ref: { documentId: "sample-law", article: 1, subpart: null } },
      { ref: { documentId: "sample-law", article: "1", subpart: { kind: "note" } } },
      { ref: { documentId: "sample-law", article: "1", subpart: "x" } },
      { ref: { documentId: "sample-law", article: "1", subpart: null }, quote: 5 },
      claim("sample-law", "ماده صفر"),
      claim("sample-law", "0"),
      claim("sample-law", "1", { kind: "paragraph" as never, label: "1" }),
      claim("sample-law", "1", { kind: "note", label: "؟" }),
    ];
    for (const b of bad) {
      const v = verifyCitation(IDX, b as CitationClaim, "2005-01-01");
      expect(v.code, JSON.stringify(b)).toBe("malformed");
      expect(v.accepted).toBe(false);
      expect(v.message).not.toBe("");
    }
    expect(verifyCitation(IDX, claim("sample-law", "1"), "2005-13-40").code).toBe("malformed");
    expect(verifyCitation(IDX, claim("sample-law", "1"), "امروز").code).toBe("malformed");
  });

  it("برچسب ماده با نگارش‌های برابر (ارقام فارسی، پیشوند «ماده») همان ماده است", () => {
    expect(verifyCitation(IDX, claim("sample-law", "۲ مکرر"), "2016-01-01", { allowUnverified: true }).code).toBe("unverified-source");
    expect(verifyCitation(IDX, claim("sample-law", "ماده ۱"), "2005-01-01").code).toBe("valid");
  });

  it("subpart: undefined مثل null رفتار می‌کند", () => {
    const c = { ref: { documentId: "sample-law", article: "1" } } as unknown as CitationClaim;
    expect(verifyCitation(IDX, c, "2005-01-01").code).toBe("valid");
  });

  describe("نقل‌قول", () => {
    const QUOTE_OK = "متن ساختگی ماده ۱ نسخهٔ نخست";
    it("درست ⇒ valid؛ نادرست ⇒ quote-mismatch (با مدرک)", () => {
      expect(verifyCitation(IDX, claim("sample-law", "1", null, QUOTE_OK), "2005-01-01").code).toBe("valid");
      const bad = verifyCitation(IDX, claim("sample-law", "1", null, "متن ساختگی ماده ۱ نسخهٔ سوم"), "2005-01-01");
      expect(bad).toMatchObject({ code: "quote-mismatch", accepted: false });
      expect(bad.evidence).not.toBeNull();
    });
    it("نقل‌قولِ نسخهٔ دیگر (در تاریخ دیگر) رد می‌شود؛ همان نقل‌قول در تاریخ درست پذیرفته می‌شود", () => {
      const q = "متن ساختگی ماده ۱، نسخهٔ دوم";
      expect(verifyCitation(IDX, claim("sample-law", "1", null, q), "2005-01-01").code).toBe("quote-mismatch");
      expect(verifyCitation(IDX, claim("sample-law", "1", null, q), "2012-01-01", { allowUnverified: true }).code).toBe("unverified-source");
    });
    it("نقل‌قول از ماده‌ای دیگر رد می‌شود", () => {
      expect(verifyCitation(IDX, claim("sample-law", "1", null, "متن ساختگی ماده ۲"), "2005-01-01").code).toBe("quote-mismatch");
    });
    it("ارجاع به تبصره/بند: فقط متن همان بخش؛ ارجاع به ماده: متن ماده یا بخش‌های همان نسخه", () => {
      expect(verifyCitation(IDX, claim("sample-law", "2", { kind: "clause", label: "الف" }, "بند الف ساختگی"), "2005-01-01").code).toBe("valid");
      expect(verifyCitation(IDX, claim("sample-law", "2", { kind: "clause", label: "الف" }, "متن ساختگی ماده ۲"), "2005-01-01").code).toBe("quote-mismatch");
      expect(verifyCitation(IDX, claim("sample-law", "2", null, "بند الف ساختگی"), "2005-01-01").code).toBe("valid");
    });
    it("نقل‌قول بسیار کوتاه/خالی رد؛ null و نبودن = بدون سنجش", () => {
      expect(verifyCitation(IDX, claim("sample-law", "1", null, "ماده"), "2005-01-01").code).toBe("quote-mismatch");
      expect(verifyCitation(IDX, claim("sample-law", "1", null, ""), "2005-01-01").code).toBe("quote-mismatch");
      expect(verifyCitation(IDX, claim("sample-law", "1", null, null), "2005-01-01").code).toBe("valid");
      expect(verifyCitation(IDX, claim("sample-law", "1"), "2005-01-01").code).toBe("valid");
    });
    it("نقل‌قول نادرست روی نسخهٔ تأییدنشده هم رد می‌شود (حتی با allowUnverified)", () => {
      const v = verifyCitation(IDX, claim("sample-law", "1", null, "این متن در قانون نیست"), "2024-01-01", { allowUnverified: true });
      expect(v).toMatchObject({ code: "quote-mismatch", accepted: false });
    });
  });
});

describe("verifyCitations", () => {
  it("گزارش: پذیرفته‌ها، رد‌شده‌ها و allAccepted", () => {
    const r = verifyCitations(IDX, [claim("sample-law", "1"), claim("sample-law", "99"), claim("sample-regulation", "1")], "2005-01-01");
    expect(r.verdicts.map((v) => v.code)).toEqual(["valid", "unknown-article", "unverified-source"]);
    expect(r.accepted).toHaveLength(1);
    expect(r.rejected).toHaveLength(2);
    expect(r.allAccepted).toBe(false);
    expect(verifyCitations(IDX, [claim("sample-law", "1")], "2005-01-01").allAccepted).toBe(true);
    expect(verifyCitations(IDX, [], "2005-01-01")).toEqual({ verdicts: [], accepted: [], rejected: [], allAccepted: true });
  });
});

describe("extractMentions: شکل‌های ارجاع در متن", () => {
  const table = buildAliasTable(IDX);
  const ex = (text: string, def: string | null = null) => extractMentions(text, table, def);
  const one = (text: string, def: string | null = null) => {
    const m = ex(text, def);
    expect(m, text).toHaveLength(1);
    return m[0]!;
  };

  it("ماده + نام کوتاه/کامل سند؛ ارقام فارسی/عربی/لاتین؛ نیم‌فاصله", () => {
    for (const t of ["ماده ۱ قانون نمونه", "ماده 1 قانون نمونه", "ماده ١ قانون نمونه", "ماده‌ی ۱ قانون نمونه".replace("ماده‌ی", "ماده"), "ماده ۱ از قانون نمونه", "ماده ۱ قانون نمونهٔ آزمایشی", "ماده ۱ قانون نمونهٔ آزمایشی (ساختگی)"]) {
      const m = one(t);
      expect(m.status, t).toBe("resolved");
      expect(m.claim).toEqual({ ref: { documentId: "sample-law", article: "1", subpart: null }, quote: null });
      expect(m.text, t).toBe(t);
    }
  });

  it("مکرر، ماده واحده، اصل", () => {
    expect(one("ماده ۲ مکرر قانون نمونه").claim?.ref.article).toBe("2 مکرر");
    expect(one("ماده واحده قانون ماده‌واحده‌ای نمونه").claim?.ref).toEqual({ documentId: "sample-single-act", article: "واحده", subpart: null });
    expect(one("ماده‌ واحده قانون ماده‌واحده‌ای نمونه").status).toBe("resolved");
    expect(one("اصل ۲ قانون نمونه").claim?.ref.article).toBe("2");
  });

  it("تبصره و بند پیش از ماده", () => {
    expect(one("تبصره ۱ ماده ۲ قانون نمونه").claim?.ref).toEqual({ documentId: "sample-law", article: "2", subpart: { kind: "note", label: "1" } });
    expect(one("بند الف ماده ۲ قانون نمونه").claim?.ref.subpart).toEqual({ kind: "clause", label: "الف" });
    expect(one("بند (ب) ماده ۲ قانون نمونه").claim?.ref.subpart).toEqual({ kind: "clause", label: "ب" });
    expect(one("بند (ب) ماده ۲ قانون نمونه").text).toBe("بند (ب) ماده ۲ قانون نمونه");
  });

  it("بازهٔ هر ارجاع دقیقاً همان نوشته است و بقیهٔ متن بیرونش می‌ماند", () => {
    const text = "نخست: طبق ماده ۱ قانون نمونه و نیز تبصره ۱ ماده ۲ قانون نمونه، پایان.";
    const ms = ex(text);
    expect(ms.map((m) => m.text)).toEqual(["ماده ۱ قانون نمونه", "تبصره ۱ ماده ۲ قانون نمونه"]);
    for (const m of ms) expect(text.slice(m.start, m.end)).toBe(m.text);
    expect(ms[0]!.end).toBeLessThanOrEqual(ms[1]!.start);
  });

  it("بدون نام قانون ⇒ no-document؛ با سند پیش‌فرض ⇒ resolved", () => {
    expect(one("طبق ماده ۱۰ باید عمل شود").status).toBe("no-document");
    expect(one("طبق ماده ۱۰ باید عمل شود").text).toBe("ماده ۱۰");
    const m = one("طبق ماده ۲ باید عمل شود", "sample-law");
    expect(m.status).toBe("resolved");
    expect(m.claim?.ref.documentId).toBe("sample-law");
  });

  it("مرز جمله پیوند را می‌شکند: «ماده ۱، قانون نمونه …» ارجاع به آن قانون نیست", () => {
    expect(one("ماده ۱، قانون نمونه را اصلاح کرد").status).toBe("no-document");
    expect(one("ماده ۱. قانون نمونه چنین است").status).toBe("no-document");
  });

  it("قانونِ نامبرده که در پایگاه نیست ⇒ unknown-document", () => {
    const m = one("ماده ۱۰ قانون مدنی");
    expect(m.status).toBe("unknown-document");
    expect(m.claim).toBeNull();
    expect(one("ماده ۱۰ آیین دادرسی").status).toBe("unknown-document");
  });

  it("نام مبهم (به دو سند می‌خورد) ⇒ ambiguous-document", () => {
    const idx2 = sampleIndex((c) => {
      c.documents[2].shortTitle = "قانون نمونه"; // همان نام کوتاه سند اول
    });
    const m = extractMentions("ماده ۱ قانون نمونه", buildAliasTable(idx2));
    expect(m).toHaveLength(1);
    expect(m[0]!.status).toBe("ambiguous-document");
    expect(m[0]!.reason).toContain("sample-law");
    // نام کامل هنوز یکتاست
    expect(extractMentions("ماده ۱ قانون نمونهٔ آزمایشی", buildAliasTable(idx2))[0]!.status).toBe("resolved");
  });

  it("بلندترین نام برنده است", () => {
    const idx2 = sampleIndex((c) => {
      c.documents[2].shortTitle = "قانون نمونه دوم";
    });
    const m = extractMentions("ماده ۱ قانون نمونه دوم", buildAliasTable(idx2));
    expect(m[0]!.claim?.ref.documentId).toBe("sample-regulation");
    expect(extractMentions("ماده ۱ قانون نمونه", buildAliasTable(idx2))[0]!.claim?.ref.documentId).toBe("sample-law");
  });

  it("شمارهٔ نامعتبر ⇒ malformed (ماده ۰، بیش از سقف، مکرر ۱، برچسب تبصرهٔ نامعتبر)", () => {
    for (const t of ["ماده ۰ قانون نمونه", "ماده ۱۰۰۰۰۰۰ قانون نمونه", "ماده ۲ مکرر ۱ قانون نمونه", "تبصره ۰ ماده ۲ قانون نمونه", "بند abc ماده ۲ قانون نمونه"]) {
      const m = one(t);
      expect(m.status, t).toBe("malformed");
      expect(m.claim).toBeNull();
    }
  });

  it("برچسبِ حروفیِ ظاهراً معتبر («تبصره یک») فهمیده می‌شود ولی راستی‌آزمایی آن را رد می‌کند (شکست‌به‌سمت‌ایمنی)", () => {
    const m = one("تبصره یک ماده ۲ قانون نمونه");
    expect(m.status).toBe("resolved");
    const c = checkText(IDX, "تبصره یک ماده ۲ قانون نمونه", "2005-01-01");
    expect(c.ok).toBe(false);
    expect(c.mentions[0]!.verdict?.code).toBe("unknown-subpart");
  });

  it("پرانتزِ عنوان در بازه می‌ماند تا پس از حذف «)» یتیم نماند", () => {
    const text = "طبق ماده ۱ قانون نمونهٔ آزمایشی (ساختگی) و ماده ۹۹ قانون نمونهٔ آزمایشی ( ساختگی ) است.";
    const ms = ex(text);
    expect(ms.map((m) => m.text)).toEqual(["ماده ۱ قانون نمونهٔ آزمایشی (ساختگی)", "ماده ۹۹ قانون نمونهٔ آزمایشی ( ساختگی )"]);
    const r = redactRejected(text, checkText(IDX, text, "2005-01-01"));
    expect(r).toEqual({ ok: true, value: `طبق ماده ۱ قانون نمونهٔ آزمایشی (ساختگی) و ${DEFAULT_REDACTION} است.` });
  });

  it("شکل‌های نفهمیدنی رد می‌شوند، نه نادیده: «مواد ۲ و ۳»، «تبصره ماده ۲»", () => {
    const p = ex("طبق مواد ۲ و ۳ و ۴ قانون نمونه عمل شود");
    expect(p).toHaveLength(1);
    expect(p[0]!.status).toBe("unsupported-form");
    expect(p[0]!.text).toBe("مواد ۲ و ۳ و ۴ قانون نمونه"); // کل فهرست و نام قانون با هم؛ چیزی از آن پس از حذف نمی‌ماند
    expect(ex("مواد ۲، ۳ تا ۵")[0]!.text).toBe("مواد ۲، ۳ تا ۵");
    const t = one("تبصره ماده ۲ قانون نمونه");
    expect(t.status).toBe("unsupported-form");
    expect(t.text.startsWith("تبصره")).toBe(true);
  });

  it("متن عادی ارجاع حساب نمی‌شود", () => {
    for (const t of ["", "   ", "مواد مخدر ممنوع است", "اصل برائت", "این ماده روشن است", "ماده", "اصل", "اصل ۱۰ را", "ماده‌ای", "بند ۳ قرارداد", "تبصره", "مواد", "شماره ۱۰ قانون نمونه"].filter((x) => x !== "اصل ۱۰ را")) {
      expect(ex(t), JSON.stringify(t)).toEqual([]);
    }
  });

  it("چند ارجاع پشت‌سرهم و هم‌پوشانی‌نداشتن", () => {
    const text = "ماده ۱ قانون نمونه ماده ۲ قانون نمونه تبصره ۱ ماده ۲ قانون نمونه";
    const ms = ex(text);
    expect(ms).toHaveLength(3);
    for (let i = 1; i < ms.length; i++) expect(ms[i]!.start).toBeGreaterThanOrEqual(ms[i - 1]!.end);
  });
});

describe("checkText و redactRejected", () => {
  const TEXT = "بر پایهٔ ماده ۱ قانون نمونه و تبصره ۱ ماده ۱ قانون نمونه و ماده ۱۰ قانون مدنی نتیجه می‌شود.";

  it("هر ارجاع حکم خودش را می‌گیرد؛ ok فقط وقتی همه پذیرفته‌اند", () => {
    const c = checkText(IDX, TEXT, "2005-01-01");
    expect(c.mentions.map((m) => [m.mention.status, m.verdict?.code ?? null, m.accepted])).toEqual([
      ["resolved", "valid", true],
      ["resolved", "unknown-subpart", false],
      ["unknown-document", null, false],
    ]);
    expect(c.ok).toBe(false);
    expect(c.rejected).toHaveLength(2);
    expect(checkText(IDX, "ماده ۱ قانون نمونه", "2005-01-01").ok).toBe(true);
    expect(checkText(IDX, "متنی بی‌ارجاع.", "2005-01-01")).toEqual({ mentions: [], rejected: [], ok: true });
  });

  it("تاریخ مهم است: همان ارجاع در تاریخ دیگر رد می‌شود", () => {
    expect(checkText(IDX, "ماده ۱ قانون نمونه", "2005-01-01").ok).toBe(true);
    expect(checkText(IDX, "ماده ۱ قانون نمونه", "2016-06-01").ok).toBe(false); // شکاف
    expect(checkText(IDX, "ماده ۱ قانون نمونه", "2024-01-01").ok).toBe(false); // تأییدنشده
    expect(checkText(IDX, "ماده ۱ قانون نمونه", "2024-01-01", { allowUnverified: true }).ok).toBe(true);
  });

  it("سند پیش‌فرض به ارجاع بی‌نام اعمال و سپس راستی‌آزمایی می‌شود", () => {
    expect(checkText(IDX, "طبق ماده ۱ عمل شود", "2005-01-01").ok).toBe(false);
    expect(checkText(IDX, "طبق ماده ۱ عمل شود", "2005-01-01", { defaultDocumentId: "sample-law" }).ok).toBe(true);
    expect(checkText(IDX, "طبق ماده ۱ عمل شود", "2005-01-01", { defaultDocumentId: "nope" }).ok).toBe(false);
  });

  it("redactRejected: فقط ردشده‌ها عوض می‌شوند؛ پذیرفته‌ها و متن اطراف دست‌نخورده", () => {
    const c = checkText(IDX, TEXT, "2005-01-01");
    const r = redactRejected(TEXT, c);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toBe(`بر پایهٔ ماده ۱ قانون نمونه و ${DEFAULT_REDACTION} و ${DEFAULT_REDACTION} مدنی نتیجه می‌شود.`);
    // درستیِ بازبینی مجدد: متنِ پاک‌شده دیگر ارجاع ردشونده ندارد
    expect(checkText(IDX, r.value, "2005-01-01").ok).toBe(true);
  });

  it("redactRejected: نشانهٔ سفارشی؛ بدون ردشده متن همان است", () => {
    const ok = checkText(IDX, "ماده ۱ قانون نمونه", "2005-01-01");
    expect(redactRejected("ماده ۱ قانون نمونه", ok)).toEqual({ ok: true, value: "ماده ۱ قانون نمونه" });
    const bad = checkText(IDX, "ماده ۹ قانون نمونه", "2005-01-01");
    expect(redactRejected("ماده ۹ قانون نمونه", bad, "⟦حذف⟧")).toEqual({ ok: true, value: "⟦حذف⟧" });
  });

  it("redactRejected: نتیجهٔ بررسیِ متنی دیگر خطا می‌دهد (به‌جای حذفِ غلط)", () => {
    const c = checkText(IDX, "ماده ۹ قانون نمونه", "2005-01-01");
    for (const other of ["متن دیگر", "ماده ۸ قانون نمونه", "", "ماده ۹"]) {
      const r = redactRejected(other, c);
      expect(r.ok, other).toBe(false);
    }
  });

  it("نشانهٔ پیش‌فرض خودش ارجاع نیست (حذف، تکرارپذیر و پایدار است)", () => {
    expect(extractMentions(DEFAULT_REDACTION, buildAliasTable(IDX))).toEqual([]);
    const c = checkText(IDX, TEXT, "2005-01-01");
    const r1 = redactRejected(TEXT, c);
    if (!r1.ok) throw new Error("x");
    const r2 = redactRejected(r1.value, checkText(IDX, r1.value, "2005-01-01"));
    expect(r2).toEqual({ ok: true, value: r1.value });
  });
});

describe("مرزهای ریز (یافته‌های آزمون جهشی)", () => {
  const table = buildAliasTable(IDX);
  const ex = (t: string) => extractMentions(t, table);

  it("tokenize: واژهٔ فقط‌اعراب/کشیده واژه نیست و جایگاه واژه‌های بعدی را به هم نمی‌زند", () => {
    expect(tokenize("\u0640 \u064E \u0640\u0640")).toEqual([]);
    const text = "متن \u0640 ساختگی \u064E ماده";
    expect(tokenize(text).map((t) => t.folded)).toEqual(["متن", "ساختگی", "ماده"]);
    // نقل‌قول از متنی که میانش کشیده/اعراب تنهاست، هنوز واژه‌به‌واژه درست سنجیده می‌شود
    expect(checkQuote("متن ساختگی ماده", ["متن \u0640 ساختگی \u064E ماده"]).ok).toBe(true);
  });

  it("checkQuote: دلیلِ رد برای نقل‌قولِ خالی با «بسیار کوتاه» فرق دارد؛ بخش‌های تهیِ میان «…» بی‌اثرند", () => {
    const empty = checkQuote("… …", ["متن ساختگی ماده"]);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toContain("خالی");
    const short = checkQuote("متن", ["متن ساختگی ماده"]);
    if (!short.ok) expect(short.reason).toContain("کوتاه");
    expect(checkQuote("متن ساختگی … … ماده بعدی", ["متن ساختگی و سپس ماده بعدی"]).ok).toBe(true);
  });

  it("«ماده» و عدد باید پیوسته باشند؛ مرز جمله میانشان ارجاع نمی‌سازد", () => {
    for (const t of ["ماده، ۱ قانون نمونه", "ماده. ۱ قانون نمونه", "ماده: ۱", "مواد؛ ۱۰ قانون نمونه", "ماده\n\n۱ قانون نمونه".replace(/\n\n/g, "، ")]) {
      expect(ex(t), t).toEqual([]);
    }
  });

  it("«واحده» فقط پس از «ماده» معنا دارد (نه «اصل واحده»)", () => {
    expect(ex("اصل واحده قانون نمونه")).toEqual([]);
    expect(ex("ماده واحده قانون ماده‌واحده‌ای نمونه")).toHaveLength(1);
  });

  it("redactRejected: نتیجهٔ دست‌کاری‌شده با بازه‌های هم‌پوشان خطا می‌دهد، نه خروجیِ خراب", () => {
    const text = "ماده ۹ قانون نمونه";
    const c = checkText(IDX, text, "2005-01-01");
    expect(c.rejected).toHaveLength(1);
    const doubled = { ...c, rejected: [c.rejected[0]!, c.rejected[0]!] };
    expect(redactRejected(text, doubled).ok).toBe(false);
  });
});
