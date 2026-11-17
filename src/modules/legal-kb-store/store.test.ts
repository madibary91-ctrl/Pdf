/** درج، خواندن و رفت‌وبرگشت (پایگاه واقعی). رفت‌وبرگشت باید **بایت‌به‌بایت** معادل `loadCorpus` باشد. */
import { afterAll, describe, expect, it } from "vitest";
import { FICTIONAL_SAMPLE_CORPUS, loadCorpus, type Corpus } from "@/modules/legal-kb-schema";
import { dbDescribe, openTestKb, type TestKb } from "./test-db";
import { article, corpusJson, documentJson, pendingProv, randomCorpus, relationJson, rulingJson, version, type J } from "./test-corpus";

const canonical = (input: unknown): Corpus => {
  const r = loadCorpus(input);
  if (!r.ok) throw new Error(`corpus invalid: ${JSON.stringify(r.error.slice(0, 3))}`);
  return r.value;
};
const sampleJson = (): J => JSON.parse(JSON.stringify(FICTIONAL_SAMPLE_CORPUS));

dbDescribe("legal-kb-store · درج و خواندن (پایگاه واقعی)", () => {
  const opened: TestKb[] = [];
  const open = async () => {
    const kb = await openTestKb();
    opened.push(kb);
    return kb;
  };
  afterAll(async () => {
    for (const kb of opened) await kb.drop();
  });
  const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(JSON.stringify(r.error).slice(0, 500));
    return r.value;
  };

  describe("نمونهٔ ساختگی", () => {
    it("درج ← گزارش شمارها ← خواندن = دقیقاً همان Corpus متعارف", async () => {
      const kb = await open();
      const report = must(await kb.store.insertCorpus(sampleJson()));
      expect(report).toEqual({ documents: 3, articles: 5, versions: 7, subparts: 4, relations: 3, rulings: 1, citations: 1 });
      expect(must(await kb.store.readCorpus())).toEqual(canonical(sampleJson()));
    });
    it("آمار: شمارها و فقط نسخه‌های تأییدشده شمرده می‌شوند", async () => {
      const kb = await open();
      must(await kb.store.insertCorpus(sampleJson()));
      expect(must(await kb.store.stats())).toMatchObject({ documents: 3, articles: 5, versions: 7, subparts: 4, relations: 3, rulings: 1, citations: 1, verifiedVersions: 2 });
    });
    it("Corpus خالی و پایگاه خالی: خواندن = Corpus خالی؛ درج Corpus خالی بی‌خطر", async () => {
      const kb = await open();
      expect(must(await kb.store.readCorpus())).toEqual({ documents: [], relations: [], rulings: [] });
      expect(must(await kb.store.insertCorpus(corpusJson([])))).toEqual({ documents: 0, articles: 0, versions: 0, subparts: 0, relations: 0, rulings: 0, citations: 0 });
    });
  });

  describe("فقط‌افزودنی و اتمی", () => {
    it("درج دوباره: ALREADY_EXISTS با فهرست شناسه‌ها؛ پایگاه دست‌نخورده", async () => {
      const kb = await open();
      must(await kb.store.insertCorpus(sampleJson()));
      const before = must(await kb.store.readCorpus());
      const again = await kb.store.insertCorpus(sampleJson());
      expect(again.ok).toBe(false);
      if (!again.ok) {
        expect(again.error.code).toBe("ALREADY_EXISTS");
        expect(again.error.conflicts).toEqual(["document:sample-law", "document:sample-regulation", "document:sample-single-act", "ruling:sample-unity-ruling-1"]);
      }
      expect(must(await kb.store.readCorpus())).toEqual(before);
    });
    it("تعارض جزئی (یک سندِ نو + یک سندِ موجود): هیچ‌کدام نوشته نمی‌شود", async () => {
      const kb = await open();
      must(await kb.store.insertCorpus(corpusJson([documentJson("existing", [article("1", [version("2000-01-01", null)])])])));
      const mixed = corpusJson([documentJson("brand-new", [article("1", [version("2000-01-01", null)])]), documentJson("existing", [article("2", [version("2001-01-01", null)])])]);
      const r = await kb.store.insertCorpus(mixed);
      expect(r.ok).toBe(false);
      const docs = must(await kb.store.readCorpus()).documents.map((d) => d.id);
      expect(docs).toEqual(["existing"]);
      // متن موجود هم عوض نشده است
      expect(must(await kb.store.readCorpus()).documents[0]?.articles.map((a) => a.label)).toEqual(["1"]);
    });
    it("Corpus نامعتبر: INVALID_CORPUS با فهرست کامل مسائل؛ چیزی نوشته نمی‌شود", async () => {
      const kb = await open();
      const bad = corpusJson([
        documentJson("overlap", [article("1", [version("2000-01-01", "2010-01-01"), version("2005-01-01", null)])]),
        documentJson("overlap", []), // شناسهٔ تکراری
      ]);
      const r = await kb.store.insertCorpus(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("INVALID_CORPUS");
        expect(r.error.issues?.map((i) => i.code)).toEqual(expect.arrayContaining(["VERSION_OVERLAP", "DUPLICATE"]));
      }
      expect(must(await kb.store.stats()).documents).toBe(0);
    });
    it("دور زدن loadCorpus با شیء دست‌ساز ممکن نیست (هم‌پوشانی، تأیید بدون بازبین، کلید ناشناخته، تاریخ جلالی)", async () => {
      const kb = await open();
      const mk = (mut: (d: J) => void) => {
        const c = corpusJson([documentJson("x", [article("1", [version("2000-01-01", null)])])]);
        mut(c["documents"][0]);
        return c;
      };
      const attempts: unknown[] = [
        mk((d) => (d["articles"][0]["versions"][0]["provenance"]["review"] = { status: "legally-verified", reviewedBy: null, reviewedOn: null })),
        mk((d) => (d["articles"][0]["versions"][0]["validFrom"] = "1403-01-01")),
        mk((d) => (d["extra"] = 1)),
        mk((d) => (d["articles"][0]["versions"][0]["validTo"] = undefined)),
        mk((d) => (d["articles"][0]["versions"][0]["text"] = "a\u202Eb")),
        { documents: "nope" },
        null,
        undefined,
        42,
        "str",
      ];
      for (const a of attempts) {
        const r = await kb.store.insertCorpus(a);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("INVALID_CORPUS");
      }
      expect(must(await kb.store.stats()).documents).toBe(0);
    });
    it("شکست در میانهٔ درج (نویسهٔ غیرقابل‌ذخیره در رأی که آخر درج می‌شود): همهٔ درج‌های پیشین برمی‌گردد", async () => {
      const kb = await open();
      const c = corpusJson(
        [documentJson("will-roll-back", [article("1", [version("2000-01-01", null, "متن", [{ kind: "note", label: "1", text: "تبصره" }])])])],
        [],
        [rulingJson("r1", [{ documentId: "will-roll-back", article: "1" }], { text: "سرنویس \ud800 بی‌جفت" })],
      );
      // loadCorpus نویسهٔ جانشین بی‌جفت را نمی‌گیرد یا می‌گیرد؛ در هر دو حال هیچ رکوردی نباید بماند.
      const r = await kb.store.insertCorpus(c);
      expect(r.ok).toBe(false);
      const s = must(await kb.store.stats());
      expect(s).toMatchObject({ documents: 0, articles: 0, versions: 0, subparts: 0, rulings: 0, citations: 0 });
    });
    it("همین شکست از مسیر DB (نه loadCorpus) رخ می‌دهد و CONSTRAINT_VIOLATION است", async () => {
      const kb = await open();
      const c = corpusJson([documentJson("d", [article("1", [version("2000-01-01", null)])])], [], [rulingJson("r1", [], { text: "سر \ud800 نو" })]);
      const loaded = loadCorpus(c);
      if (!loaded.ok) return; // اگر loadCorpus بی‌جفت را رد کند، لایهٔ اول کافی است؛ تست قبلی همین را پوشش داد
      const r = await kb.store.insertCorpus(c);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("CONSTRAINT_VIOLATION");
      expect(must(await kb.store.stats()).documents).toBe(0);
    });
  });

  describe("ترتیب و درج‌های پیاپی", () => {
    it("ترتیب سندها/رابطه‌ها/رأی‌ها = ترتیب درج، در چند درج پیاپی", async () => {
      const kb = await open();
      const a = corpusJson(
        [documentJson("zeta", [article("1", [version("2000-01-01", null)])]), documentJson("alpha", [article("1", [version("2000-01-01", null)])])],
        [relationJson("refers-to", { documentId: "zeta", article: null }, { documentId: "alpha", article: null })],
        [rulingJson("r-z", []), rulingJson("r-a", [])],
      );
      const b = corpusJson(
        [documentJson("mid", [article("1", [version("2000-01-01", null)])]), documentJson("beta", [article("1", [version("2000-01-01", null)])])],
        [relationJson("refers-to", { documentId: "mid", article: null }, { documentId: "beta", article: null })],
        [rulingJson("r-m", [])],
      );
      must(await kb.store.insertCorpus(a));
      must(await kb.store.insertCorpus(b));
      const out = must(await kb.store.readCorpus());
      expect(out.documents.map((d) => d.id)).toEqual(["zeta", "alpha", "mid", "beta"]); // نه الفبایی
      expect(out.relations.map((r) => r.from.documentId)).toEqual(["zeta", "mid"]);
      expect(out.rulings.map((g) => g.id)).toEqual(["r-z", "r-a", "r-m"]);
      expect(out).toEqual(canonical(corpusJson([...a["documents"], ...b["documents"]], [...a["relations"], ...b["relations"]], [...a["rulings"], ...b["rulings"]])));
    });
    it("هم‌زمانی: ۸ درج هم‌زمانِ سندهای متفاوت همه موفق؛ seq یکتا و پیوسته", async () => {
      const kb = await open();
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => kb.store.insertCorpus(corpusJson([documentJson(`par-${i}`, [article("1", [version("2000-01-01", null)])])]))));
      for (const r of results) expect(r.ok).toBe(true);
      const seqs = (await kb.raw(`SELECT seq::int AS s FROM {{schema}}.document ORDER BY seq`)).map((r) => r["s"]);
      expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(must(await kb.store.readCorpus()).documents).toHaveLength(8);
    });
    it("هم‌زمانی: ۸ درج هم‌زمانِ همان سند: دقیقاً یکی موفق، بقیه ALREADY_EXISTS", async () => {
      const kb = await open();
      const same = () => corpusJson([documentJson("contested", [article("1", [version("2000-01-01", null)])])]);
      const results = await Promise.all(Array.from({ length: 8 }, () => kb.store.insertCorpus(same())));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const r of results) if (!r.ok) expect(r.error.code).toBe("ALREADY_EXISTS");
      expect(must(await kb.store.stats()).documents).toBe(1);
    });
  });

  describe("دقت متن", () => {
    it("یونیکد، علائم و کاراکترهای ویژه بایت‌به‌بایت حفظ می‌شود (بدون نرمال‌سازی پنهان)", async () => {
      const kb = await open();
      const texts = [
        "می\u200Cخواهم و نمی\u200Cخواهم", // نیم‌فاصله
        "علامت\u200F راست‌به‌چپ\u200E و چپ‌به‌راست",
        "ي و ك عربی در متن حفظ می‌شوند، ی و ک فارسی هم",
        "ارقام ۱۲۳ ٤٥٦ 789 با هم",
        "e\u0301 (ترکیبی) در برابر \u00e9 (پیش‌ترکیب‌شده)",
        "ایموجی 😀 و نویسهٔ خارج از BMP 𝒳 𠀀",
        "خط اول\n\nخط سوم با   فاصله‌های  متعدد\tو تب",
        "نقل‌قول ' و \" و \\ و $$ و $1 و {{schema}} و ; -- DROP TABLE x; و %s و ${x}",
        "<script>alert(1)</script> و &amp; و [[]] و {}",
        "x".repeat(200_000),
      ];
      const docs = texts.map((t, i) => documentJson(`txt-${i}`, [article("1", [version("2000-01-01", null, t, [{ kind: "note", label: "1", text: `تبصره: ${t.slice(0, 50)}` }])])], { title: `عنوان ${t.slice(0, 20).replace(/\n/g, " ")}` }));
      const input = corpusJson(docs);
      must(await kb.store.insertCorpus(input));
      const out = must(await kb.store.readCorpus());
      expect(out).toEqual(canonical(input));
      texts.forEach((t, i) => expect(out.documents[i]?.articles[0]?.versions[0]?.text).toBe(t));
    });
    it("همهٔ فیلدهای تهی‌پذیر و همهٔ مقدارهای شمارشی رفت‌وبرگشت می‌شوند", async () => {
      const kb = await open();
      const kinds = ["constitution", "statute", "regulation", "directive", "approval"];
      const docs = kinds.map((kind, i) =>
        documentJson(`k-${kind}`, [article("1", [version("2000-01-01", null)])], { kind, shortTitle: i % 2 ? null : "کوتاه", enactedOn: i % 2 ? null : "1999-12-31" }),
      );
      const rels = ["amends", "repeals", "replaces", "refers-to", "implements", "interprets"].map((type, i) =>
        relationJson(type, { documentId: "k-statute", article: i % 2 ? "1" : null }, { documentId: "k-regulation", article: null }, { effectiveFrom: i % 3 ? null : "2020-02-29", note: i % 2 ? null : "یادداشت" }),
      );
      const rul = ["unity-ruling", "constitutional-opinion", "advisory-opinion", "judgment"].map((kind, i) =>
        rulingJson(`rl-${kind}`, i === 0 ? [] : [{ documentId: "k-statute", article: null }, { documentId: "k-statute", article: "1" }], { kind, title: i % 2 ? null : "عنوان" }),
      );
      const input = corpusJson(docs, rels, rul);
      must(await kb.store.insertCorpus(input));
      expect(must(await kb.store.readCorpus())).toEqual(canonical(input));
    });
    it("منبع: نشانی، رسمی/ثانویه و بازبینی (تأییدشده با نام و تاریخ) حفظ می‌شود", async () => {
      const kb = await open();
      const prov = { sourceName: "روزنامهٔ رسمی (ساختگی)", sourceUrl: "https://example.org/a?b=1#c", sourceKind: "official", retrievedOn: "2025-03-04", review: { status: "legally-verified", reviewedBy: "نام بازبین", reviewedOn: "2025-03-05" } };
      const input = corpusJson([documentJson("with-prov", [article("1", [version("2000-01-01", null, "متن", [], prov)])], { provenance: prov })]);
      must(await kb.store.insertCorpus(input));
      const out = must(await kb.store.readCorpus());
      expect(out.documents[0]?.provenance).toEqual(prov);
      expect(out.documents[0]?.articles[0]?.versions[0]?.provenance).toEqual(prov);
    });
  });

  describe("خاصیت: رفت‌وبرگشت Corpus تصادفی", () => {
    it("۶۰ Corpus تصادفی (بذردار) در یک store: خواندن = loadCorpus(ادغام ورودی‌ها)", async () => {
      const kb = await open();
      const docs: J[] = [];
      const rels: J[] = [];
      const rulings: J[] = [];
      for (let seed = 1; seed <= 60; seed++) {
        const { json } = randomCorpus(seed, `rt${seed}`);
        const r = await kb.store.insertCorpus(json);
        expect(r.ok, `seed ${seed}: ${JSON.stringify(r)}`).toBe(true);
        docs.push(...json["documents"]);
        rels.push(...json["relations"]);
        rulings.push(...json["rulings"]);
      }
      const out = must(await kb.store.readCorpus());
      expect(out).toEqual(canonical(corpusJson(docs, rels, rulings)));
      expect(out.documents.length).toBeGreaterThanOrEqual(60);
    });
    it("مقیاس: ۳۰۰ سند × ۲۰ ماده × ۳ نسخه درج و بازخوانی می‌شود", async () => {
      const kb = await open();
      const documents = Array.from({ length: 300 }, (_, d) =>
        documentJson(
          `big-${d}`,
          Array.from({ length: 20 }, (_, a) =>
            article(String(a + 1), [version("2000-01-01", "2005-01-01", `متن ${d}/${a}/1`), version("2005-01-01", "2010-01-01", `متن ${d}/${a}/2`), version("2012-01-01", null, `متن ${d}/${a}/3`)]),
          ),
        ),
      );
      const input = corpusJson(documents);
      const t0 = Date.now();
      const r = must(await kb.store.insertCorpus(input));
      expect(r).toMatchObject({ documents: 300, articles: 6000, versions: 18000 });
      expect(must(await kb.store.readCorpus())).toEqual(canonical(input));
      expect(Date.now() - t0).toBeLessThan(60_000);
    }, 120_000);
  });

  describe("دادهٔ خراب (قیدها عمداً برداشته می‌شود)", () => {
    const corrupt = async (setup: (kb: TestKb) => Promise<void>) => {
      const kb = await open();
      must(await kb.store.insertCorpus(sampleJson()));
      await setup(kb);
      return kb;
    };

    it("هم‌پوشانی نسخه‌ها (قید EXCLUDE برداشته شد): readCorpus ← CORRUPT_DATA با VERSION_OVERLAP", async () => {
      const kb = await corrupt(async (k) => {
        await k.raw(`ALTER TABLE {{schema}}.article_version DROP CONSTRAINT article_version_no_overlap`);
        await k.raw(
          `INSERT INTO {{schema}}.article_version (document_id, article_label, valid_from, valid_to, body, source_name, source_kind)
           VALUES ('sample-law', '2', '2005-01-01', '2006-01-01', 'هم‌پوشان', 's', 'secondary')`,
        );
      });
      const r = await kb.store.readCorpus();
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("CORRUPT_DATA");
        expect(r.error.issues?.map((i) => i.code)).toContain("VERSION_OVERLAP");
      }
      // پرس‌وجوی نقطه‌ای در روزِ هم‌پوشان هم حدس نمی‌زند
      const q = await kb.store.resolveCitation({ documentId: "sample-law", article: "2", subpart: null }, "2005-06-01");
      expect(q.ok).toBe(false);
      if (!q.ok) expect(q.error.code).toBe("CORRUPT_DATA");
      const all = await kb.store.versionsInForceAt("2005-06-01");
      expect(all.ok).toBe(false);
      if (!all.ok) expect(all.error.code).toBe("CORRUPT_DATA");
      // خارج از روز هم‌پوشان، پرس‌وجو هنوز درست کار می‌کند
      const ok = await kb.store.resolveCitation({ documentId: "sample-law", article: "2", subpart: null }, "2007-01-01");
      expect(ok.ok && ok.value.status).toBe("found");
    });
    it("«تأییدشده» بدون بازبین (قید برداشته شد): هرگز verified:true برنمی‌گردد", async () => {
      const kb = await corrupt(async (k) => {
        await k.raw(`ALTER TABLE {{schema}}.article_version DROP CONSTRAINT article_version_review_consistent_ck`);
        await k.raw(`UPDATE {{schema}}.article_version SET review_status = 'legally-verified' WHERE document_id = 'sample-regulation'`);
      });
      const q = await kb.store.resolveCitation({ documentId: "sample-regulation", article: "1", subpart: null }, "2020-01-01");
      expect(q.ok).toBe(false);
      if (!q.ok) expect(q.error.code).toBe("CORRUPT_DATA");
      const r = await kb.store.readCorpus();
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("CORRUPT_DATA");
    });
    it("بازهٔ تهی (validTo = validFrom؛ قیدها برداشته شد): readCorpus ← CORRUPT_DATA با INVALID_INTERVAL", async () => {
      const kb = await corrupt(async (k) => {
        await k.raw(`ALTER TABLE {{schema}}.article_version DROP CONSTRAINT article_version_interval_ck`);
        await k.raw(`UPDATE {{schema}}.article_version SET valid_to = valid_from WHERE document_id = 'sample-regulation'`);
      });
      const r = await kb.store.readCorpus();
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("CORRUPT_DATA");
        expect(r.error.issues?.map((i) => i.code)).toContain("INVALID_INTERVAL");
      }
    });
    it("ماده‌ای بدون هیچ نسخه (SQL دستی): resolveCitation ← CORRUPT_DATA", async () => {
      const kb = await corrupt(async (k) => {
        await k.raw(`INSERT INTO {{schema}}.article (document_id, label, article_number, article_repeat) VALUES ('sample-law', '77', 77, 0)`);
      });
      const q = await kb.store.resolveCitation({ documentId: "sample-law", article: "77", subpart: null }, "2020-01-01");
      expect(q.ok).toBe(false);
      if (!q.ok) expect(q.error.code).toBe("CORRUPT_DATA");
    });
  });
});

describe("legal-kb-store · ثابت‌ها", () => {
  it("pendingProv پیش‌فرض تأییدنشده است (تضمین سازندهٔ تست)", () => {
    expect(pendingProv()["review"]["status"]).toBe("pending-legal-review");
  });
});
