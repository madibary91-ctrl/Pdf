import { describe, expect, it } from "vitest";
import { KB_LIMITS } from "./issues";
import { loadCorpus, loadCorpusFromJson } from "./load";
import { FICTIONAL_SAMPLE_CORPUS } from "./sample-corpus";
import type { Corpus, CorpusIssue, IssueCode } from "./types";

type J = Record<string, any>;

const fresh = (): J => JSON.parse(JSON.stringify(FICTIONAL_SAMPLE_CORPUS));

function issuesOf(input: unknown): readonly CorpusIssue[] {
  const r = loadCorpus(input);
  return r.ok ? [] : r.error;
}
function mutated(fn: (c: J) => void): readonly CorpusIssue[] {
  const c = fresh();
  fn(c);
  return issuesOf(c);
}
const codes = (list: readonly CorpusIssue[]) => list.map((i) => `${i.code}@${i.path}`);
function expectIssue(list: readonly CorpusIssue[], code: IssueCode, path: string) {
  expect(codes(list), `انتظار ${code}@${path}`).toContain(`${code}@${path}`);
}
function loaded(input: unknown): Corpus {
  const r = loadCorpus(input);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

describe("نمونهٔ ساختگی", () => {
  it("بی‌خطا بارگذاری می‌شود و شمارش‌ها درست است", () => {
    const c = loaded(fresh());
    expect(c.documents.map((d) => d.id)).toEqual(["sample-law", "sample-single-act", "sample-regulation"]);
    expect(c.documents[0]?.articles.map((a) => a.label)).toEqual(["1", "2", "2 مکرر"]);
    expect(c.documents[0]?.articles[0]?.versions).toHaveLength(3);
    expect(c.relations).toHaveLength(3);
    expect(c.rulings).toHaveLength(1);
  });

  it("رفت‌وبرگشت JSON: بارگذاریِ خروجی همان خروجی را می‌دهد (خودتوان)", () => {
    const c = loaded(fresh());
    expect(loaded(JSON.parse(JSON.stringify(c)))).toEqual(c);
  });

  it("ترتیب متعارف: مواد و نسخه‌ها هر طور بیایند مرتب می‌شوند؛ ترتیب سندها حفظ می‌شود", () => {
    const base = loaded(fresh());
    const s = fresh();
    s.documents[0].articles.reverse();
    s.documents[0].articles[2].versions.reverse(); // ماده ۱ (اکنون آخر)
    expect(loaded(s)).toEqual(base);
  });

  it("ورودی اصلی دست‌نخورده می‌ماند (بدون جهش)", () => {
    const s = fresh();
    const before = JSON.stringify(s);
    loaded(s);
    expect(JSON.stringify(s)).toBe(before);
  });

  it("رأی و رابطه اختیاری‌اند؛ سند بی‌ماده مجاز است", () => {
    const c = loaded({ documents: [{ ...fresh().documents[0], articles: [] }] });
    expect(c.relations).toEqual([]);
    expect(c.rulings).toEqual([]);
  });
});

describe("سخت‌گیری شکل", () => {
  it("ریشه باید شیء باشد", () => {
    for (const bad of [null, undefined, [], "x", 5, true]) {
      const list = issuesOf(bad);
      expect(list.map((i) => i.code)).toEqual(["INVALID_FIELD"]);
    }
    class Foo {
      documents = [];
    }
    expect(issuesOf(new Foo()).map((i) => i.code)).toEqual(["INVALID_FIELD"]);
    expect(issuesOf(Object.assign(Object.create(null), { documents: [] }))).toEqual([]);
  });

  it("کلید ناشناخته در هر سطح (غلط املایی بی‌صدا پذیرفته نمی‌شود)", () => {
    expectIssue(mutated((c) => (c.extra = 1)), "UNKNOWN_FIELD", "$.extra");
    expectIssue(mutated((c) => (c.documents[0].extra = 1)), "UNKNOWN_FIELD", "documents[0].extra");
    expectIssue(mutated((c) => (c.documents[0].articles[0].extra = 1)), "UNKNOWN_FIELD", "documents[0].articles[0].extra");
    expectIssue(
      mutated((c) => {
        const v = c.documents[0].articles[0].versions[0];
        v.validTO = v.validTo;
        delete v.validTo;
      }),
      "UNKNOWN_FIELD",
      "documents[0].articles[0].versions[0].validTO",
    );
    expectIssue(mutated((c) => (c.documents[0].articles[0].versions[0].provenance.x = 1)), "UNKNOWN_FIELD", "documents[0].articles[0].versions[0].provenance.x");
    expectIssue(mutated((c) => (c.documents[0].articles[0].versions[0].provenance.review.x = 1)), "UNKNOWN_FIELD", "documents[0].articles[0].versions[0].provenance.review.x");
    expectIssue(mutated((c) => (c.relations[0].x = 1)), "UNKNOWN_FIELD", "relations[0].x");
    expectIssue(mutated((c) => (c.relations[0].from.x = 1)), "UNKNOWN_FIELD", "relations[0].from.x");
    expectIssue(mutated((c) => (c.rulings[0].x = 1)), "UNKNOWN_FIELD", "rulings[0].x");
    expectIssue(mutated((c) => (c.documents[0].articles[1].versions[0].subparts[0].x = 1)), "UNKNOWN_FIELD", "documents[0].articles[1].versions[0].subparts[0].x");
  });

  it("«__proto__» از JSON.parse کلید ناشناخته است و Object.prototype آلوده نمی‌شود", () => {
    const input = JSON.parse('{"documents":[],"__proto__":{"polluted":true}}');
    expectIssue(issuesOf(input), "UNKNOWN_FIELD", "$.__proto__");
    expect(({} as J).polluted).toBeUndefined();
  });

  it("validTo باید صریح بیاید (حذف = خطا؛ null = بی‌پایان)", () => {
    expectIssue(mutated((c) => delete c.documents[0].articles[0].versions[2].validTo), "MISSING_FIELD", "documents[0].articles[0].versions[2].validTo");
    expectIssue(mutated((c) => (c.documents[0].articles[0].versions[2].validTo = undefined)), "MISSING_FIELD", "documents[0].articles[0].versions[2].validTo");
    expect(mutated((c) => (c.documents[0].articles[0].versions[2].validTo = null))).toEqual([]);
  });

  it("effectiveFrom رابطه باید صریح بیاید", () => {
    expectIssue(mutated((c) => delete c.relations[0].effectiveFrom), "MISSING_FIELD", "relations[0].effectiveFrom");
    expect(mutated((c) => (c.relations[0].effectiveFrom = null))).toEqual([]);
  });

  it("فیلدهای الزامی", () => {
    expectIssue(mutated((c) => delete c.documents), "MISSING_FIELD", "$.documents");
    expectIssue(mutated((c) => delete c.documents[0].id), "MISSING_FIELD", "documents[0].id");
    expectIssue(mutated((c) => delete c.documents[0].kind), "MISSING_FIELD", "documents[0].kind");
    expectIssue(mutated((c) => delete c.documents[0].title), "MISSING_FIELD", "documents[0].title");
    expectIssue(mutated((c) => delete c.documents[0].provenance), "MISSING_FIELD", "documents[0].provenance");
    expectIssue(mutated((c) => delete c.documents[0].articles), "MISSING_FIELD", "documents[0].articles");
    expectIssue(mutated((c) => delete c.documents[0].articles[0].label), "MISSING_FIELD", "documents[0].articles[0].label");
    expectIssue(mutated((c) => delete c.documents[0].articles[0].versions), "MISSING_FIELD", "documents[0].articles[0].versions");
    expectIssue(mutated((c) => (c.documents[0].articles[0].versions = [])), "MISSING_FIELD", "documents[0].articles[0].versions");
    expectIssue(mutated((c) => delete c.documents[0].articles[0].versions[0].validFrom), "MISSING_FIELD", "documents[0].articles[0].versions[0].validFrom");
    expectIssue(mutated((c) => delete c.documents[0].articles[0].versions[0].text), "MISSING_FIELD", "documents[0].articles[0].versions[0].text");
    expectIssue(mutated((c) => delete c.documents[0].articles[0].versions[0].provenance), "MISSING_FIELD", "documents[0].articles[0].versions[0].provenance");
    expectIssue(mutated((c) => delete c.documents[0].provenance.sourceName), "MISSING_FIELD", "documents[0].provenance.sourceName");
    expectIssue(mutated((c) => delete c.documents[0].provenance.sourceKind), "MISSING_FIELD", "documents[0].provenance.sourceKind");
    expectIssue(mutated((c) => delete c.relations[0].from), "MISSING_FIELD", "relations[0].from");
    expectIssue(mutated((c) => delete c.relations[0].to), "MISSING_FIELD", "relations[0].to");
    expectIssue(mutated((c) => delete c.relations[0].type), "MISSING_FIELD", "relations[0].type");
    expectIssue(mutated((c) => delete c.rulings[0].text), "MISSING_FIELD", "rulings[0].text");
    expectIssue(mutated((c) => delete c.rulings[0].issuedOn), "MISSING_FIELD", "rulings[0].issuedOn");
    expectIssue(mutated((c) => delete c.rulings[0].id), "MISSING_FIELD", "rulings[0].id");
    expectIssue(mutated((c) => delete c.documents[0].articles[1].versions[0].subparts[0].text), "MISSING_FIELD", "documents[0].articles[1].versions[0].subparts[0].text");
    expectIssue(mutated((c) => delete c.documents[0].articles[1].versions[0].subparts[0].label), "MISSING_FIELD", "documents[0].articles[1].versions[0].subparts[0].label");
  });

  it("نوع‌های نادرست", () => {
    expectIssue(mutated((c) => (c.documents = {})), "INVALID_FIELD", "$.documents");
    expectIssue(mutated((c) => (c.documents[0].articles = "x")), "INVALID_FIELD", "documents[0].articles");
    expectIssue(mutated((c) => (c.documents[0].id = 5)), "INVALID_FIELD", "documents[0].id");
    expectIssue(mutated((c) => (c.documents[0].title = 5)), "INVALID_FIELD", "documents[0].title");
    expectIssue(mutated((c) => (c.documents[0].articles[0].versions[0].text = ["x"])), "INVALID_FIELD", "documents[0].articles[0].versions[0].text");
    expectIssue(mutated((c) => (c.documents[0].articles[0].label = 10)), "INVALID_FIELD", "documents[0].articles[0].label");
    expectIssue(mutated((c) => (c.documents[0].articles[0].versions[0] = 5)), "INVALID_FIELD", "documents[0].articles[0].versions[0]");
    expectIssue(mutated((c) => (c.documents[0].provenance = "x")), "INVALID_FIELD", "documents[0].provenance");
    expectIssue(mutated((c) => (c.documents[0].articles[1].versions[0].subparts = {})), "INVALID_FIELD", "documents[0].articles[1].versions[0].subparts");
  });

  it("شمارهٔ enum نامعتبر", () => {
    expectIssue(mutated((c) => (c.documents[0].kind = "law")), "INVALID_FIELD", "documents[0].kind");
    expectIssue(mutated((c) => (c.relations[0].type = "deletes")), "INVALID_FIELD", "relations[0].type");
    expectIssue(mutated((c) => (c.rulings[0].kind = "x")), "INVALID_FIELD", "rulings[0].kind");
    expectIssue(mutated((c) => (c.documents[0].provenance.sourceKind = "wiki")), "INVALID_FIELD", "documents[0].provenance.sourceKind");
    expectIssue(mutated((c) => (c.documents[0].articles[1].versions[0].subparts[0].kind = "para")), "INVALID_FIELD", "documents[0].articles[1].versions[0].subparts[0].kind");
    expectIssue(mutated((c) => (c.documents[0].provenance.review.status = "ok")), "INVALID_FIELD", "documents[0].provenance.review.status");
  });

  it("شناسه‌ها", () => {
    for (const bad of ["Sample", "a b", "a_b", "-a", "قانون", "", "a".repeat(65)]) {
      expectIssue(mutated((c) => (c.documents[0].id = bad)), "INVALID_FIELD", "documents[0].id");
    }
    expectIssue(mutated((c) => (c.rulings[0].id = "Bad Id")), "INVALID_FIELD", "rulings[0].id");
    expectIssue(mutated((c) => (c.relations[0].from.documentId = "Bad")), "INVALID_FIELD", "relations[0].from.documentId");
  });
});

describe("تاریخ‌ها", () => {
  const vf = (c: J) => c.documents[0].articles[0].versions[0];
  it("تاریخ ناممکن، قالب غلط و جلالی به‌جای میلادی", () => {
    for (const bad of ["2024-02-30", "2023-02-29", "2024-13-01", "1403-01-01", "۲۰۲۴-۰۱-۰۱", "2024/01/01", "", 20240101, null]) {
      expectIssue(mutated((c) => (vf(c).validFrom = bad)), bad === null ? "INVALID_FIELD" : "INVALID_FIELD", "documents[0].articles[0].versions[0].validFrom");
    }
  });
  it("تاریخ اختیاری ناممکن", () => {
    expectIssue(mutated((c) => (c.documents[0].enactedOn = "2001-02-30")), "INVALID_FIELD", "documents[0].enactedOn");
    expectIssue(mutated((c) => (c.documents[0].provenance.retrievedOn = "1404-01-01")), "INVALID_FIELD", "documents[0].provenance.retrievedOn");
    expectIssue(mutated((c) => (c.relations[0].effectiveFrom = "x")), "INVALID_FIELD", "relations[0].effectiveFrom");
    expect(mutated((c) => (c.documents[0].enactedOn = null))).toEqual([]);
    expect(mutated((c) => delete c.documents[0].enactedOn)).toEqual([]);
  });
});

describe("متن و نویسه‌های خطرناک", () => {
  const text = (c: J) => c.documents[0].articles[0].versions[0];
  const path = "documents[0].articles[0].versions[0].text";

  it("متن خالی یا فقط فاصله", () => {
    for (const bad of ["", "   ", "\n\t "]) expectIssue(mutated((c) => (text(c).text = bad)), "INVALID_FIELD", path);
  });

  it("نویسهٔ کنترلی، BOM و علامت‌های جهت‌دهی Trojan-Source رد می‌شوند", () => {
    for (const bad of ["a\u0000b", "a\u0007b", "a\u001Bb", "a\u007Fb", "a\u0085b", "a\u202Eb", "a\u202Ab", "a\u2066b", "a\u2069b", "a\uFEFFb", "a\rb".replace("\r", "\u000B")]) {
      expectIssue(mutated((c) => (text(c).text = bad)), "INVALID_FIELD", path);
    }
  });

  it("نیم‌فاصله، LRM/RLM، تب و خط‌جدید مجازند؛ CRLF به LF تبدیل و دو سر برش می‌خورد", () => {
    const c = fresh();
    text(c).text = "  می\u200Cخواهد\u200F؛ یک\u200E\tدو\r\nسه\rچهار  ";
    const out = loaded(c);
    expect(out.documents[0]?.articles[0]?.versions[0]?.text).toBe("می\u200Cخواهد\u200F؛ یک\u200E\tدو\nسه\nچهار");
  });

  it("فیلد تک‌خطی نباید خط‌جدید داشته باشد و دو سرش برش می‌خورد", () => {
    expectIssue(mutated((c) => (c.documents[0].title = "الف\nب")), "INVALID_FIELD", "documents[0].title");
    const c = fresh();
    c.documents[0].title = "  عنوان  ";
    expect(loaded(c).documents[0]?.title).toBe("عنوان");
  });

  it("سقف طول متن و عنوان", () => {
    expect(mutated((c) => (text(c).text = "ا".repeat(KB_LIMITS.textChars)))).toEqual([]);
    expectIssue(mutated((c) => (text(c).text = "ا".repeat(KB_LIMITS.textChars + 1))), "LIMIT_EXCEEDED", path);
    expectIssue(mutated((c) => (c.documents[0].title = "ا".repeat(301))), "LIMIT_EXCEEDED", "documents[0].title");
    expect(mutated((c) => (c.documents[0].title = "ا".repeat(300)))).toEqual([]);
  });
});

describe("منبع، نشانی و بازبینی", () => {
  const prov = (c: J) => c.documents[0].articles[0].versions[1].provenance;
  const ppath = "documents[0].articles[0].versions[1].provenance";

  it("نشانی فقط http/https بدون فاصله", () => {
    for (const bad of ["javascript:alert(1)", "ftp://x.ir", "https://x.ir/a b", "//x.ir", "x.ir", "https://", 5, `https://x.ir/${"a".repeat(2100)}`]) {
      expectIssue(mutated((c) => (prov(c).sourceUrl = bad)), "INVALID_FIELD", `${ppath}.sourceUrl`);
    }
    expect(mutated((c) => (prov(c).sourceUrl = "https://example.org/a?b=c"))).toEqual([]);
    expect(mutated((c) => (prov(c).sourceUrl = null))).toEqual([]);
  });

  it("review حذف‌شده = تأییدنشده (پیش‌فرض امن)", () => {
    const c = fresh();
    delete prov(c).review;
    const v = loaded(c).documents[0]?.articles[0]?.versions[1];
    expect(v?.provenance.review).toEqual({ status: "pending-legal-review", reviewedBy: null, reviewedOn: null });
  });

  it("تأییدشده باید نام و تاریخ بازبین داشته باشد", () => {
    expectIssue(mutated((c) => (prov(c).review = { status: "legally-verified" })), "REVIEW_INCONSISTENT", `${ppath}.review`);
    expectIssue(mutated((c) => (prov(c).review = { status: "legally-verified", reviewedBy: "الف" })), "REVIEW_INCONSISTENT", `${ppath}.review`);
    expectIssue(mutated((c) => (prov(c).review = { status: "legally-verified", reviewedOn: "2025-01-01" })), "REVIEW_INCONSISTENT", `${ppath}.review`);
    expect(mutated((c) => (prov(c).review = { status: "legally-verified", reviewedBy: "الف", reviewedOn: "2025-01-01" }))).toEqual([]);
  });

  it("تأییدنشده نباید نام یا تاریخ بازبین داشته باشد (وضعیت ناسازگار)", () => {
    expectIssue(mutated((c) => (prov(c).review = { status: "pending-legal-review", reviewedBy: "الف" })), "REVIEW_INCONSISTENT", `${ppath}.review`);
    expectIssue(mutated((c) => (prov(c).review = { status: "pending-legal-review", reviewedOn: "2025-01-01" })), "REVIEW_INCONSISTENT", `${ppath}.review`);
  });
});

describe("یکپارچگی: مواد و نسخه‌ها", () => {
  const ver = (c: J, i: number) => c.documents[0].articles[0].versions[i];
  const vpath = (i: number) => `documents[0].articles[0].versions[${i}]`;

  it("برچسب ماده به شکل متعارف ذخیره می‌شود", () => {
    const c = fresh();
    c.documents[0].articles[2].label = "ماده ۲ مكرر";
    expect(loaded(c).documents[0]?.articles.map((a) => a.label)).toEqual(["1", "2", "2 مکرر"]);
  });

  it("مادهٔ تکراری (حتی با رقم فارسی)", () => {
    expectIssue(
      mutated((c) => {
        c.documents[0].articles[1].label = "۱";
      }),
      "DUPLICATE",
      "documents[0].articles[1].label",
    );
  });

  it("بازه: validTo باید پس از validFrom باشد (نیم‌باز)", () => {
    expectIssue(mutated((c) => (ver(c, 0).validTo = ver(c, 0).validFrom)), "INVALID_INTERVAL", `${vpath(0)}.validTo`);
    expectIssue(mutated((c) => (ver(c, 0).validTo = "2000-01-01")), "INVALID_INTERVAL", `${vpath(0)}.validTo`);
  });

  it("هم‌پوشانی یک روزه خطاست؛ نسخه‌های چسبیده و شکاف‌دار مجازند", () => {
    // نسخهٔ ۰ تا ۲۰۱۰-۰۶-۰۱؛ یک روز جلوتر ⇒ هم‌پوشان
    expectIssue(mutated((c) => (ver(c, 0).validTo = "2010-06-02")), "VERSION_OVERLAP", `${vpath(0)}.validTo`);
    // چسبیده (پیش‌فرض نمونه) و شکاف‌دار (نسخهٔ ۱ → ۲) مجازند: نمونه بی‌خطاست
    expect(issuesOf(fresh())).toEqual([]);
    // کوتاه‌کردن یک روزه: شکاف می‌شود، خطا نیست
    expect(mutated((c) => (ver(c, 0).validTo = "2010-05-31"))).toEqual([]);
  });

  it("نسخهٔ بی‌پایان پیش از نسخهٔ بعدی", () => {
    expectIssue(mutated((c) => (ver(c, 0).validTo = null)), "VERSION_OVERLAP", `${vpath(0)}.validTo`);
  });

  it("درج نسخه‌ای درون بازهٔ نسخهٔ دیگر (هم‌پوشانی غیرمجاور) گرفته می‌شود", () => {
    const c = fresh();
    c.documents[0].articles[0].versions.push({ ...ver(c, 1), validFrom: "2005-01-01", validTo: "2006-01-01", provenance: ver(c, 1).provenance });
    expectIssue(issuesOf(c), "VERSION_OVERLAP", `${vpath(0)}.validTo`);
  });

  it("validFrom یکسان = تکراری", () => {
    expectIssue(mutated((c) => (ver(c, 1).validFrom = ver(c, 0).validFrom)), "DUPLICATE", `${vpath(1)}.validFrom`);
  });

  it("تبصره/بند تکراری (۲ و ۲ فارسی یکی‌اند؛ نوع متفاوت یکی نیست)", () => {
    const sub = (c: J) => c.documents[0].articles[1].versions[0].subparts;
    expectIssue(mutated((c) => sub(c).push({ kind: "note", label: "۱", text: "تکرار" })), "DUPLICATE", "documents[0].articles[1].versions[0].subparts[3]");
    expect(mutated((c) => sub(c).push({ kind: "clause", label: "1", text: "نوع متفاوت، برچسب یکسان" }))).toEqual([]);
    expectIssue(mutated((c) => (sub(c)[0].label = "x")), "INVALID_FIELD", "documents[0].articles[1].versions[0].subparts[0].label");
  });

  it("سند تکراری", () => {
    expectIssue(mutated((c) => (c.documents[1].id = "sample-law")), "DUPLICATE", "documents[1].id");
  });
});

describe("یکپارچگی: رابطه‌ها و رأی‌ها", () => {
  it("ارجاع معلق", () => {
    expectIssue(mutated((c) => (c.relations[0].to.documentId = "ghost")), "DANGLING_REF", "relations[0].to");
    expectIssue(mutated((c) => (c.relations[0].from.documentId = "ghost")), "DANGLING_REF", "relations[0].from");
    expectIssue(mutated((c) => (c.relations[1].to.article = "99")), "DANGLING_REF", "relations[1].to");
    expectIssue(mutated((c) => (c.rulings[0].cites[0].article = "3")), "DANGLING_REF", "rulings[0].cites[0]");
    expectIssue(mutated((c) => (c.rulings[0].cites[0].documentId = "ghost")), "DANGLING_REF", "rulings[0].cites[0]");
  });

  it("ارجاع با رقم فارسی/«مکرر» عربی به شکل متعارف تبدیل و پیدا می‌شود", () => {
    const c = fresh();
    c.relations[1].to.article = "ماده ۲ مكرر";
    expect(loaded(c).relations[1]?.to.article).toBe("2 مکرر");
  });

  it("رابطه با خودش", () => {
    expectIssue(
      mutated((c) => {
        c.relations[1].to = { ...c.relations[1].from };
      }),
      "INVALID_FIELD",
      "relations[1]",
    );
  });

  it("رابطهٔ تکراری؛ همان رابطه با تاریخ دیگر مجاز است", () => {
    expectIssue(mutated((c) => c.relations.push({ ...c.relations[1] })), "DUPLICATE", "relations[3]");
    expect(mutated((c) => c.relations.push({ ...c.relations[1], effectiveFrom: "2018-01-01" }))).toEqual([]);
  });

  it("نسخ/جایگزینیِ دوطرفه متناقض است؛ «refers-to» دوطرفه نه", () => {
    const rel = (type: string) => ({
      type,
      from: { documentId: "sample-single-act", article: null },
      to: { documentId: "sample-law", article: null },
      effectiveFrom: null,
      note: null,
      provenance: fresh().documents[0].provenance,
    });
    expectIssue(mutated((c) => c.relations.push(rel("repeals"))), "CONTRADICTORY_RELATION", "relations[3]");
    expectIssue(
      mutated((c) => {
        c.relations.push({ ...rel("replaces") });
        c.relations.push({ ...rel("replaces"), from: rel("x").to, to: rel("x").from });
      }),
      "CONTRADICTORY_RELATION",
      "relations[4]",
    );
    expect(
      mutated((c) => {
        c.relations.push(rel("refers-to"));
        c.relations.push({ ...rel("refers-to"), from: rel("x").to, to: rel("x").from });
      }),
    ).toEqual([]);
  });

  it("رأی: شناسه و ارجاع تکراری", () => {
    expectIssue(mutated((c) => c.rulings.push({ ...c.rulings[0] })), "DUPLICATE", "rulings[1].id");
    expectIssue(mutated((c) => c.rulings[0].cites.push({ ...c.rulings[0].cites[0] })), "DUPLICATE", "rulings[0].cites[1]");
    expect(mutated((c) => (c.rulings[0].cites = []))).toEqual([]);
    expect(mutated((c) => delete c.rulings[0].cites)).toEqual([]);
  });
});

describe("گزارش مسائل", () => {
  it("همهٔ مسائل یک‌جا گزارش می‌شوند", () => {
    const list = mutated((c) => {
      c.documents[0].kind = "x";
      c.documents[1].title = "";
      c.relations[0].type = "zzz";
    });
    expect(codes(list)).toEqual(expect.arrayContaining(["INVALID_FIELD@documents[0].kind", "INVALID_FIELD@documents[1].title", "INVALID_FIELD@relations[0].type"]));
  });

  it("وقتی شکل خراب است، مسئلهٔ ثانویهٔ یکپارچگی نویز نمی‌سازد", () => {
    const list = mutated((c) => {
      c.documents[1].id = "sample-law"; // تکراری
      c.documents[0].kind = "x"; // خرابی شکل
    });
    expect(list.map((i) => i.code)).toEqual(["INVALID_FIELD"]);
  });

  it("پیام‌ها فارسی و مسیرها دقیق‌اند", () => {
    const list = mutated((c) => (c.documents[0].kind = "x"));
    expect(list[0]?.message).toMatch(/[\u0600-\u06FF]/);
    expect(list[0]?.path).toBe("documents[0].kind");
  });

  it("آرایهٔ تُنُک (خانهٔ خالی) بی‌صدا رد نمی‌شود — رگرسیون باگِ یافته‌شده با تست فازی", () => {
    const c = fresh();
    delete c.documents[0].articles[0].versions[1]; // خانهٔ خالی، نه undefined
    expect(1 in c.documents[0].articles[0].versions).toBe(false);
    expectIssue(issuesOf(c), "INVALID_FIELD", "documents[0].articles[0].versions[1]");
    const d = fresh();
    delete d.documents[1];
    expectIssue(issuesOf(d), "INVALID_FIELD", "documents[1]");
    const e = fresh();
    delete e.relations[0];
    expectIssue(issuesOf(e), "INVALID_FIELD", "relations[0]");
  });

  it("سقف مسائل: حداکثر ۱۰۰ + یک مسئلهٔ پایانی", () => {
    const c = fresh();
    c.documents = Array.from({ length: 300 }, () => ({ id: "BAD", kind: "x" }));
    const list = issuesOf(c);
    expect(list.length).toBe(KB_LIMITS.maxIssues + 1);
    expect(list[list.length - 1]?.code).toBe("LIMIT_EXCEEDED");
    expect(list[list.length - 1]?.path).toBe("$");
  });
});

describe("سقف‌های فنی", () => {
  it("آرایهٔ بزرگ‌تر از سقف، بی‌پیمایش رد می‌شود", () => {
    const c = fresh();
    c.documents = new Array(KB_LIMITS.documents + 1).fill(0);
    expect(codes(issuesOf(c))).toEqual(["LIMIT_EXCEEDED@$.documents"]);
    const d = fresh();
    d.relations = new Array(KB_LIMITS.relations + 1).fill(0);
    expect(codes(issuesOf(d))).toEqual(["LIMIT_EXCEEDED@$.relations"]);
    expectIssue(mutated((x) => (x.documents[0].articles[0].versions = new Array(KB_LIMITS.versionsPerArticle + 1).fill(0))), "LIMIT_EXCEEDED", "documents[0].articles[0].versions");
    expectIssue(mutated((x) => (x.documents[0].articles[1].versions[0].subparts = new Array(KB_LIMITS.subpartsPerVersion + 1).fill(0))), "LIMIT_EXCEEDED", "documents[0].articles[1].versions[0].subparts");
    expectIssue(mutated((x) => (x.rulings[0].cites = new Array(KB_LIMITS.citesPerRuling + 1).fill(0))), "LIMIT_EXCEEDED", "rulings[0].cites");
  });
});

describe("loadCorpusFromJson", () => {
  it("JSON درست", () => {
    expect(loadCorpusFromJson(JSON.stringify(fresh())).ok).toBe(true);
  });
  it("نحو نامعتبر، ورودی غیرمتن و حجم بیش از سقف", () => {
    for (const bad of ["{", "", "undefined", "{'a':1}", '{"documents":[],}']) {
      const r = loadCorpusFromJson(bad);
      expect(!r.ok && r.error[0]?.code).toBe("INVALID_FIELD");
    }
    const r2 = loadCorpusFromJson(5 as unknown as string);
    expect(!r2.ok && r2.error[0]?.code).toBe("INVALID_FIELD");
    const r3 = loadCorpusFromJson("x".repeat(KB_LIMITS.maxJsonChars + 1));
    expect(!r3.ok && r3.error[0]?.code).toBe("LIMIT_EXCEEDED");
  });
  it("JSON معتبر ولی با شکل نادرست", () => {
    const r = loadCorpusFromJson("[]");
    expect(!r.ok && r.error[0]?.code).toBe("INVALID_FIELD");
  });
});

describe("فاز: ورودی تصادفی هرگز پرتاب نمی‌کند و خروجی موفق همیشه خودتوان است", () => {
  function lcg(seed: number) {
    let s = seed >>> 0;
    return (n: number) => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s % n;
    };
  }
  const junk: unknown[] = [null, undefined, 0, -1, 1.5, NaN, "", " ", "x", "2024-01-01", "1403-01-01", true, false, [], {}, [1, 2], { a: 1 }, "\u202E", "a\u0000", "ماده ۱۰", Infinity];

  function allPaths(node: unknown, path: (string | number)[], out: (string | number)[][]) {
    out.push(path);
    if (Array.isArray(node)) node.forEach((x, i) => allPaths(x, [...path, i], out));
    else if (node && typeof node === "object") for (const k of Object.keys(node)) allPaths((node as J)[k], [...path, k], out);
  }

  it("۳۰۰۰ جهش تصادفی روی نمونه", () => {
    const rnd = lcg(2025);
    let okCount = 0;
    let failCount = 0;
    for (let i = 0; i < 3000; i++) {
      const c = fresh();
      const paths: (string | number)[][] = [];
      allPaths(c, [], paths);
      const target = paths[1 + rnd(paths.length - 1)] as (string | number)[];
      const parent = target.slice(0, -1).reduce<J>((n, k) => n[k as string], c);
      const key = target[target.length - 1] as string | number;
      const mode = rnd(3);
      if (mode === 0) parent[key as string] = junk[rnd(junk.length)];
      else if (mode === 1) delete parent[key as string];
      else if (Array.isArray(parent)) parent.splice(key as number, 0, junk[rnd(junk.length)]);
      else parent["zz" + rnd(3)] = junk[rnd(junk.length)];
      let r: ReturnType<typeof loadCorpus> | undefined;
      expect(() => (r = loadCorpus(c))).not.toThrow();
      if (r?.ok) {
        okCount++;
        expect(loadCorpus(JSON.parse(JSON.stringify(r.value)))).toEqual(r);
      } else {
        failCount++;
        expect(r && !r.ok && r.error.length > 0).toBe(true);
      }
    }
    // هر دو شاخه واقعاً دیده شده‌اند (تست پوچ نباشد)
    expect(okCount).toBeGreaterThan(50);
    expect(failCount).toBeGreaterThan(500);
  });
});
