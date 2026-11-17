import { describe, expect, it } from "vitest";
import { loadCorpus } from "./load";
import { buildCorpusIndex, findArticle, findDocument, relationsFor, resolveCitation, rulingsCiting, versionsInForceAt, type CorpusIndex } from "./lookup";
import { FICTIONAL_SAMPLE_CORPUS } from "./sample-corpus";
import type { CitationRef, VersionLookup } from "./types";

type J = Record<string, any>;

function indexOf(input: unknown): CorpusIndex {
  const r = loadCorpus(input);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return buildCorpusIndex(r.value);
}
const sample = () => indexOf(JSON.parse(JSON.stringify(FICTIONAL_SAMPLE_CORPUS)));

const cite = (documentId: string, article: string, subpart: CitationRef["subpart"] = null): CitationRef => ({ documentId, article, subpart });
function lookup(index: CorpusIndex, ref: CitationRef, date: string): VersionLookup {
  const r = resolveCitation(index, ref, date);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
/** خلاصهٔ خوانا: found ← متن نسخه */
function brief(l: VersionLookup): string {
  switch (l.status) {
    case "found":
      return `found:${l.version.validFrom}`;
    case "gap":
      return `gap:${l.previousValidTo}..${l.nextValidFrom}`;
    case "not-yet-in-force":
      return `not-yet:${l.firstValidFrom}`;
    case "no-longer-in-force":
      return `no-longer:${l.lastValidTo}`;
    default:
      return l.status;
  }
}

describe("نسخه‌بندی زمانی: مرزهای بازهٔ نیم‌باز [validFrom, validTo)", () => {
  const index = sample();
  // ماده ۱: [2001-01-01,2010-06-01) [2010-06-01,2015-01-01) شکاف [2018-01-01,∞)
  const at = (d: string) => brief(lookup(index, cite("sample-law", "1"), d));

  it("پیش از نخستین نسخه", () => {
    expect(at("2000-12-31")).toBe("not-yet:2001-01-01");
    expect(at("1800-01-01")).toBe("not-yet:2001-01-01");
  });
  it("روز شروع شامل است", () => {
    expect(at("2001-01-01")).toBe("found:2001-01-01");
    expect(at("2018-01-01")).toBe("found:2018-01-01");
  });
  it("آخرین روز پیش از validTo هنوز معتبر؛ خودِ validTo نسخهٔ بعدی", () => {
    expect(at("2010-05-31")).toBe("found:2001-01-01");
    expect(at("2010-06-01")).toBe("found:2010-06-01");
    expect(at("2014-12-31")).toBe("found:2010-06-01");
  });
  it("شکاف: از روز validTo تا یک روز پیش از شروع نسخهٔ بعد", () => {
    expect(at("2015-01-01")).toBe("gap:2015-01-01..2018-01-01");
    expect(at("2016-07-15")).toBe("gap:2015-01-01..2018-01-01");
    expect(at("2017-12-31")).toBe("gap:2015-01-01..2018-01-01");
  });
  it("نسخهٔ بی‌پایان تا آخر معتبر است", () => {
    expect(at("2099-12-31")).toBe("found:2018-01-01");
    expect(at("2200-12-31")).toBe("found:2018-01-01");
  });
  it("مادهٔ نسخ‌شده: پس از validTo آخر «دیگر معتبر نیست»", () => {
    const at2 = (d: string) => brief(lookup(index, cite("sample-single-act", "واحده"), d));
    expect(at2("2019-12-31")).toBe("found:2005-01-01");
    expect(at2("2020-01-01")).toBe("no-longer:2020-01-01");
    expect(at2("2100-01-01")).toBe("no-longer:2020-01-01");
    expect(at2("2004-12-31")).toBe("not-yet:2005-01-01");
  });
  it("ماده‌ای که در سال‌های بعد افزوده شد", () => {
    const at3 = (d: string) => brief(lookup(index, cite("sample-law", "2 مکرر"), d));
    expect(at3("2012-04-30")).toBe("not-yet:2012-05-01");
    expect(at3("2012-05-01")).toBe("found:2012-05-01");
  });
});

describe("resolveCitation: نتیجه‌های صریح", () => {
  const index = sample();
  it("سند یا ماده ناموجود", () => {
    expect(lookup(index, cite("ghost", "1"), "2020-01-01").status).toBe("unknown-document");
    expect(lookup(index, cite("sample-law", "99"), "2020-01-01").status).toBe("unknown-article");
    expect(lookup(index, cite("sample-law", "2 مکرر 2"), "2020-01-01").status).toBe("unknown-article");
    // «۲ مکرر» ≠ «۲»
    expect(lookup(index, cite("sample-regulation", "2"), "2020-01-01").status).toBe("unknown-article");
  });

  it("ارقام فارسی/پیشوند «ماده» همان ماده را می‌یابند", () => {
    const a = lookup(index, cite("sample-law", "۲"), "2020-01-01");
    const b = lookup(index, cite("sample-law", "ماده 2"), "2020-01-01");
    expect(a).toEqual(b);
    expect(lookup(index, cite("sample-law", "ماده ۲ مكرر"), "2020-01-01").status).toBe("found");
    expect(lookup(index, cite("sample-single-act", "ماده واحده"), "2010-01-01").status).toBe("found");
  });

  it("تبصره/بند: یافتن، نیافتن و وابستگی به نسخه (تاریخ)", () => {
    const n = lookup(index, cite("sample-law", "2", { kind: "note", label: "۱" }), "2020-01-01");
    expect(n.status === "found" && n.subpart?.text).toBe("تبصرهٔ ۱ ساختگی.");
    const c = lookup(index, cite("sample-law", "2", { kind: "clause", label: "الف" }), "2020-01-01");
    expect(c.status === "found" && c.subpart?.label).toBe("الف");
    expect(lookup(index, cite("sample-law", "2", { kind: "clause", label: "پ" }), "2020-01-01").status).toBe("unknown-subpart");
    expect(lookup(index, cite("sample-law", "2", { kind: "note", label: "الف" }), "2020-01-01").status).toBe("unknown-subpart"); // نوع متفاوت
    // ماده ۱: تبصرهٔ ۱ فقط در نسخهٔ دوم هست
    expect(lookup(index, cite("sample-law", "1", { kind: "note", label: "1" }), "2005-01-01").status).toBe("unknown-subpart");
    expect(lookup(index, cite("sample-law", "1", { kind: "note", label: "1" }), "2012-01-01").status).toBe("found");
    expect(lookup(index, cite("sample-law", "1", { kind: "note", label: "1" }), "2020-01-01").status).toBe("unknown-subpart");
    // وقتی ماده در آن تاریخ معتبر نیست، وضعیت زمانی گزارش می‌شود نه subpart
    expect(lookup(index, cite("sample-law", "1", { kind: "note", label: "1" }), "2016-01-01").status).toBe("gap");
  });

  it("verified: فقط وقتی نسخه (نه سند) «legally-verified» است", () => {
    const f = (ref: CitationRef, d: string) => {
      const l = lookup(index, ref, d);
      return l.status === "found" ? l.verified : null;
    };
    expect(f(cite("sample-law", "1"), "2005-01-01")).toBe(true); // نسخهٔ نخست تأییدشده
    expect(f(cite("sample-law", "1"), "2012-01-01")).toBe(false); // نسخهٔ دوم نه
    expect(f(cite("sample-law", "2"), "2020-01-01")).toBe(true);
    expect(f(cite("sample-regulation", "1"), "2020-01-01")).toBe(false);
  });

  it("found شامل کل نسخه و برچسب متعارف است", () => {
    const l = lookup(index, cite("sample-law", "ماده ۲ مكرر"), "2020-01-01");
    expect(l.status === "found" && l.article).toBe("2 مکرر");
    expect(l.status === "found" && l.documentId).toBe("sample-law");
    expect(l.status === "found" && l.version.text).toBe("متن ساختگی ماده ۲ مکرر.");
    expect(l.status === "found" && l.subpart).toBeNull();
  });

  it("ورودی بد = خطای Result، نه نتیجهٔ جعلی", () => {
    const err = (ref: CitationRef, d: string) => {
      const r = resolveCitation(index, ref, d);
      return r.ok ? "OK" : r.error.code;
    };
    expect(err(cite("sample-law", "1"), "2020-13-01")).toBe("INVALID_DATE");
    expect(err(cite("sample-law", "1"), "1403-01-01")).toBe("INVALID_DATE");
    expect(err(cite("sample-law", "1"), "")).toBe("INVALID_DATE");
    expect(err(cite("sample-law", "1"), 5 as unknown as string)).toBe("INVALID_DATE");
    expect(err(cite("sample-law", "abc"), "2020-01-01")).toBe("INVALID_INPUT");
    expect(err(cite("sample-law", "0"), "2020-01-01")).toBe("OUT_OF_RANGE");
    expect(err(cite("sample-law", "1", { kind: "note", label: "zz" }), "2020-01-01")).toBe("INVALID_INPUT");
    expect(err(cite("sample-law", "1", { kind: "para" as "note", label: "1" }), "2020-01-01")).toBe("INVALID_INPUT");
    // شناسهٔ سند نامعتبر خطا نیست؛ «سند ناموجود» است
    expect(lookup(index, cite("BAD ID", "1"), "2020-01-01").status).toBe("unknown-document");
  });

  it("«hasOwnProperty»/«__proto__» به‌عنوان شناسهٔ سند چیزی نمی‌یابد", () => {
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(lookup(index, cite(id, "1"), "2020-01-01").status).toBe("unknown-document");
    }
  });
});

describe("جست‌وجوهای کمکی", () => {
  const index = sample();

  it("findDocument / findArticle", () => {
    expect(findDocument(index, "sample-law")?.title).toContain("نمونه");
    expect(findDocument(index, "ghost")).toBeUndefined();
    expect(findArticle(index, "sample-law", "۲ مکرر")?.label).toBe("2 مکرر");
    expect(findArticle(index, "sample-law", "99")).toBeUndefined();
    expect(findArticle(index, "sample-law", "نامعتبر!")).toBeUndefined();
  });

  it("versionsInForceAt: فیلتر تاریخ اعتبار", () => {
    const list = (d: string) => {
      const r = versionsInForceAt(index, d);
      if (!r.ok) throw new Error("x");
      return r.value.map((e) => `${e.documentId}/${e.article}@${e.version.validFrom}`);
    };
    expect(list("2000-01-01")).toEqual([]);
    expect(list("2002-01-01")).toEqual(["sample-law/1@2001-01-01", "sample-law/2@2001-01-01"]);
    expect(list("2011-01-01")).toEqual(["sample-law/1@2010-06-01", "sample-law/2@2001-01-01", "sample-single-act/واحده@2005-01-01", "sample-regulation/1@2003-01-01"]);
    // ماده ۱ در شکاف است و نیست؛ «واحده» هنوز تا ۲۰۲۰ معتبر است
    expect(list("2016-01-01")).toEqual(["sample-law/2@2001-01-01", "sample-law/2 مکرر@2012-05-01", "sample-single-act/واحده@2005-01-01", "sample-regulation/1@2003-01-01"]);
    // از ۲۰۲۰-۰۱-۰۱ «واحده» (validTo) دیگر معتبر نیست
    expect(list("2020-01-01")).toEqual(["sample-law/1@2018-01-01", "sample-law/2@2001-01-01", "sample-law/2 مکرر@2012-05-01", "sample-regulation/1@2003-01-01"]);
    const bad = versionsInForceAt(index, "2020-02-30");
    expect(!bad.ok && bad.error.code).toBe("INVALID_DATE");
  });

  it("relationsFor: ماده شامل رابطه‌های سطح سند هم می‌شود (قابل خاموش‌کردن)", () => {
    const types = (rs: readonly { type: string }[]) => rs.map((r) => r.type);
    // ماده ۲ قانون نمونه: اصلاحیه (مبدأ) + رابطه‌های سطح سند (اجرا: مقصد، نسخ: مبدأ)
    expect(types(relationsFor(index, { documentId: "sample-law", article: "2" }))).toEqual(["implements", "repeals", "amends"]);
    expect(types(relationsFor(index, { documentId: "sample-law", article: "2" }, { includeDocumentLevel: false }))).toEqual(["amends"]);
    // ماده ۱ (مقصد اصلاح)
    expect(types(relationsFor(index, { documentId: "sample-law", article: "1" }, { includeDocumentLevel: false }))).toEqual(["amends"]);
    // خود سند: دقیقاً رابطه‌های سطح سند
    expect(types(relationsFor(index, { documentId: "sample-law", article: null }))).toEqual(["implements", "repeals"]);
    expect(types(relationsFor(index, { documentId: "sample-single-act", article: null }))).toEqual(["repeals"]);
    expect(relationsFor(index, { documentId: "ghost", article: null })).toEqual([]);
  });

  it("rulingsCiting فقط همان گره را می‌دهد", () => {
    expect(rulingsCiting(index, { documentId: "sample-law", article: "2" }).map((g) => g.id)).toEqual(["sample-unity-ruling-1"]);
    expect(rulingsCiting(index, { documentId: "sample-law", article: "۲" }).length).toBe(1);
    expect(rulingsCiting(index, { documentId: "sample-law", article: "1" })).toEqual([]);
    expect(rulingsCiting(index, { documentId: "sample-law", article: null })).toEqual([]);
  });

  it("رابطه‌ای که هم سطح سند و هم سطح ماده را لمس می‌کند، یک بار می‌آید", () => {
    const c = JSON.parse(JSON.stringify(FICTIONAL_SAMPLE_CORPUS)) as J;
    c.relations = [{ ...c.relations[0], type: "refers-to", from: { documentId: "sample-law", article: null }, to: { documentId: "sample-law", article: "1" } }];
    const idx = indexOf(c);
    expect(relationsFor(idx, { documentId: "sample-law", article: "1" }).length).toBe(1);
  });
});

// ───────────── oracle مستقل: حساب روی «شمارهٔ روز» صحیح، نه رشته ─────────────

describe("مقایسهٔ انبوه با oracle (نمایش عددی روز؛ منطق جدا از موتور)", () => {
  function lcg(seed: number) {
    let s = seed >>> 0;
    return (n: number) => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s % n;
    };
  }
  const DAY = 86_400_000;
  const BASE = Date.UTC(2000, 0, 1) / DAY;
  const iso = (day: number) => new Date((BASE + day) * DAY).toISOString().slice(0, 10);

  type Seg = { s: number; e: number | null };
  /** oracle: فقط مقایسهٔ عددی */
  function oracle(segs: Seg[], t: number): string {
    for (const g of segs) if (t >= g.s && (g.e === null || t < g.e)) return `found:${iso(g.s)}`;
    if (t < segs[0]!.s) return `not-yet:${iso(segs[0]!.s)}`;
    const last = segs[segs.length - 1]!;
    if (last.e !== null && t >= last.e) return `no-longer:${iso(last.e)}`;
    const prev = [...segs].reverse().find((g) => g.e !== null && g.e <= t)!;
    const next = segs.find((g) => g.s > t)!;
    return `gap:${iso(prev.e as number)}..${iso(next.s)}`;
  }

  it("۳۰۰ زنجیرهٔ تصادفی × همهٔ روزهای مرزی و تصادفی", () => {
    const rnd = lcg(99);
    let checks = 0;
    let kinds = new Set<string>();
    for (let n = 0; n < 300; n++) {
      const count = 1 + rnd(5);
      const segs: Seg[] = [];
      let cursor = rnd(300);
      for (let i = 0; i < count; i++) {
        const s = cursor;
        const last = i === count - 1;
        const open = last && rnd(2) === 0;
        const e = open ? null : s + 1 + rnd(400);
        segs.push({ s, e });
        cursor = (e ?? s) + (rnd(3) === 0 ? 1 + rnd(200) : 0); // گاهی شکاف، گاهی چسبیده
      }
      const sampleJson = JSON.parse(JSON.stringify(FICTIONAL_SAMPLE_CORPUS)) as J;
      const prov = sampleJson.documents[0].articles[0].versions[0].provenance;
      sampleJson.documents = [
        {
          ...sampleJson.documents[0],
          articles: [{ label: "7", versions: segs.map((g, i) => ({ validFrom: iso(g.s), validTo: g.e === null ? null : iso(g.e), text: `نسخه ${i}`, subparts: [], provenance: prov })) }],
        },
      ];
      sampleJson.relations = [];
      sampleJson.rulings = [];
      const index = indexOf(sampleJson);
      const days = new Set<number>();
      for (const g of segs) for (const d of [g.s - 1, g.s, g.s + 1, (g.e ?? g.s) - 1, g.e ?? g.s, (g.e ?? g.s) + 1]) days.add(d);
      for (let k = 0; k < 10; k++) days.add(rnd(1400) - 50);
      const maxEnd = Math.max(...segs.map((g) => g.e ?? g.s));
      days.add(maxEnd + 5000);
      for (const t of days) {
        const got = brief(lookup(index, cite("sample-law", "7"), iso(t)));
        const want = oracle(segs, t);
        expect(got, `زنجیره ${n} روز ${iso(t)} ${JSON.stringify(segs)}`).toBe(want);
        kinds.add(want.split(":")[0]!);
        checks++;
      }
    }
    expect(checks).toBeGreaterThan(5000);
    // همهٔ چهار وضعیت زمانی واقعاً دیده شده‌اند
    expect([...kinds].sort()).toEqual(["found", "gap", "no-longer", "not-yet"]);
  });
});
