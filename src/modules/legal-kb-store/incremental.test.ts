/**
 * درج افزایشی (پایگاه واقعی). قلب کار تست تفاضلی است: «درج A سپس افزایشیِ B» باید دقیقاً برابر «درج یک‌جای A∪B» باشد.
 */
import { afterEach, describe, expect, it } from "vitest";
import { FICTIONAL_SAMPLE_CORPUS } from "@/modules/legal-kb-schema";
import { dbDescribe, openTestKb, type TestKb } from "./test-db";
import { article, corpusJson, documentJson, pendingProv, randomCorpus, relationJson, rulingJson, version, verifiedProv, type J } from "./test-corpus";
import type { StoreResult } from "./types";

const must = <T>(r: StoreResult<T>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error).slice(0, 600));
  return r.value;
};
const failure = <T>(r: StoreResult<T>) => {
  if (r.ok) throw new Error("باید شکست می‌خورد");
  return r.error;
};
const sampleJson = (): J => JSON.parse(JSON.stringify(FICTIONAL_SAMPLE_CORPUS));
const node = (documentId: string, article: string | null = null) => ({ documentId, article });
const simpleDoc = (id: string, extra: J = {}) => documentJson(id, [article("1", [version("2000-01-01", null, `متن ${id}`)])], extra);

dbDescribe("legal-kb-store · درج افزایشی (پایگاه واقعی)", () => {
  const opened: TestKb[] = [];
  const open = async (): Promise<TestKb> => {
    const kb = await openTestKb();
    opened.push(kb);
    return kb;
  };
  // هر تست store خودش را همان‌جا می‌بندد (شمار اتصال پستگرس محدود است و فایل‌های تست هم‌زمان اجرا می‌شوند).
  afterEach(async () => {
    for (const kb of opened.splice(0)) await kb.drop();
  });
  /** عکس کامل برای «هیچ‌چیز تغییر نکرد». */
  const snap = async (kb: TestKb) => ({ corpus: must(await kb.store.readCorpus()), stats: must(await kb.store.stats()) });

  /** پایگاه با نمونهٔ ساختگی: سندهای sample-law (مواد ۱ و ۲)، sample-regulation، sample-single-act، یک رأی و ۳ رابطه. */
  const withSample = async () => {
    const kb = await open();
    must(await kb.store.insertCorpus(sampleJson()));
    return kb;
  };

  describe("کاربرد اصلی", () => {
    it("آیین‌نامهٔ تازه و رأی تازه به مادهٔ موجود ارجاع می‌دهند؛ فقط بخش نو درج می‌شود", async () => {
      const kb = await withSample();
      const before = await snap(kb);
      const report = must(
        await kb.store.insertIncremental(
          corpusJson(
            [simpleDoc("new-regulation", { kind: "regulation" })],
            [relationJson("implements", node("new-regulation", "1"), node("sample-law", "2"), { effectiveFrom: "2020-01-01" })],
            [rulingJson("new-ruling", [node("sample-law", "1"), node("new-regulation")])],
          ),
        ),
      );
      expect(report).toEqual({ documents: 1, articles: 1, versions: 1, subparts: 0, relations: 1, rulings: 1, citations: 2 });
      const after = await snap(kb);
      expect(after.stats).toEqual({
        ...before.stats,
        documents: before.stats.documents + 1,
        articles: before.stats.articles + 1,
        versions: before.stats.versions + 1,
        relations: before.stats.relations + 1,
        rulings: before.stats.rulings + 1,
        citations: before.stats.citations + 2,
      });
      // سندهای قبلی (از جمله بازبینی‌ها) بایت‌به‌بایت دست‌نخورده‌اند و سند نو در انتها آمده
      expect(after.corpus.documents.slice(0, before.corpus.documents.length)).toEqual(before.corpus.documents);
      expect(after.corpus.documents.at(-1)?.id).toBe("new-regulation");
      expect(after.corpus.relations.slice(0, before.corpus.relations.length)).toEqual(before.corpus.relations);
      expect(after.corpus.rulings.at(-1)?.cites).toEqual([node("sample-law", "1"), node("new-regulation")]);
    });

    it("فقط رابطهٔ تازه میان دو سند موجود (بدون سند نو)", async () => {
      const kb = await withSample();
      const before = await snap(kb);
      const r = must(await kb.store.insertIncremental(corpusJson([], [relationJson("refers-to", node("sample-single-act"), node("sample-law", "2"))])));
      expect(r).toMatchObject({ documents: 0, relations: 1 });
      const after = await snap(kb);
      expect(after.corpus.relations).toHaveLength(before.corpus.relations.length + 1);
      expect(after.corpus.relations.at(-1)).toMatchObject({ type: "refers-to", from: node("sample-single-act"), to: node("sample-law", "2") });
    });

    it("رابطه از سند موجود به سند نو هم مجاز است؛ رابطه و رأی نو پیش‌فرض تأییدنشده‌اند", async () => {
      const kb = await withSample();
      must(await kb.store.insertIncremental(corpusJson([simpleDoc("later-law")], [relationJson("refers-to", node("sample-law"), node("later-law", "1"))])));
      const c = must(await kb.store.readCorpus());
      expect(c.relations.at(-1)?.provenance.review.status).toBe("pending-legal-review");
      expect(c.documents.at(-1)?.provenance.review.status).toBe("pending-legal-review");
      expect(must(await kb.store.stats()).verifiedVersions).toBe(2); // همان دو نسخهٔ تأییدشدهٔ نمونه
    });

    it("سند نوِ تأییدشده (با بازبین) همان‌طور که هست ذخیره می‌شود", async () => {
      const kb = await withSample();
      must(await kb.store.insertIncremental(corpusJson([documentJson("verified-new", [article("1", [version("2000-01-01", null, "متن", [], verifiedProv())])])], [relationJson("refers-to", node("verified-new", "1"), node("sample-law", "1"))])));
      expect(must(await kb.store.stats()).verifiedVersions).toBe(3);
    });

    it("ورودی خودبسنده: دقیقاً مثل insertCorpus رفتار می‌کند (گزارش و محتوا)", async () => {
      const a = await open();
      const b = await open();
      const ra = must(await a.store.insertCorpus(sampleJson()));
      const rb = must(await b.store.insertIncremental(sampleJson()));
      expect(rb).toEqual(ra);
      expect(must(await b.store.readCorpus())).toEqual(must(await a.store.readCorpus()));
    });

    it("پایگاه خالی + ورودی با ارجاع به سند ناموجود: DANGLING_REF (نه خطای خام)", async () => {
      const kb = await open();
      const e = failure(await kb.store.insertIncremental(corpusJson([], [relationJson("refers-to", node("ghost-a"), node("ghost-b"))])));
      expect(e.code).toBe("INVALID_CORPUS");
      expect(e.issues?.map((i) => `${i.code}@${i.path}`)).toEqual(["DANGLING_REF@relations[0].from", "DANGLING_REF@relations[0].to"]);
    });
  });

  describe("تفاضلی: A سپس افزایشیِ B  ≡  درج یک‌جای A∪B", () => {
    it("نمونهٔ ساختگی به‌اضافهٔ بستهٔ دستی", async () => {
      const bPart = corpusJson(
        [simpleDoc("b-reg", { kind: "regulation" }), simpleDoc("b-dir", { kind: "directive" })],
        [
          relationJson("implements", node("b-reg", "1"), node("sample-law", "1")),
          relationJson("amends", node("b-dir"), node("sample-regulation")),
          relationJson("refers-to", node("b-dir", "1"), node("b-reg")),
        ],
        [rulingJson("b-ruling", [node("sample-law", "2"), node("b-reg", "1")])],
      );
      const a = JSON.parse(JSON.stringify(sampleJson()));
      const union = { documents: [...a.documents, ...bPart["documents"]], relations: [...a.relations, ...bPart["relations"]], rulings: [...a.rulings, ...bPart["rulings"]] };
      const x = await open();
      const y = await open();
      must(await x.store.insertCorpus(union));
      must(await y.store.insertCorpus(a));
      must(await y.store.insertIncremental(bPart));
      expect(await snap(y)).toEqual(await snap(x));
    });

    it("۲۵ بذر تصادفی (شکاف/مجاورت/تبصره/رابطه/رأی) با بستهٔ نویی که به گره‌های تصادفی A ارجاع می‌دهد", async () => {
      // دو store انباشتی (نه ۵۰ store): هر بذر پیشوند یکتا دارد و ترتیب درج در هر دو یکسان است.
      const x = await open();
      const y = await open();
      for (let seed = 1; seed <= 25; seed++) {
        const a = randomCorpus(seed, `a${seed}`);
        const pick = a.articles[seed % a.articles.length]!;
        const bPart = corpusJson(
          [simpleDoc(`b${seed}-one`), simpleDoc(`b${seed}-two`)],
          [
            relationJson("implements", node(`b${seed}-one`, "1"), node(pick.documentId, pick.label)),
            relationJson("refers-to", node(`b${seed}-two`), node(pick.documentId)),
            ...(seed % 2 === 0 ? [relationJson("amends", node(`b${seed}-two`, "1"), node(`b${seed}-one`, "1"))] : []),
          ],
          [rulingJson(`b${seed}-r`, [node(pick.documentId, pick.label), node(`b${seed}-one`)])],
        );
        const aj = a.json as J;
        const union = { documents: [...aj["documents"], ...bPart["documents"]], relations: [...aj["relations"], ...bPart["relations"]], rulings: [...aj["rulings"], ...bPart["rulings"]] };
        must(await x.store.insertCorpus(union));
        must(await y.store.insertCorpus(aj));
        const rep = must(await y.store.insertIncremental(bPart));
        expect(rep.documents, `seed ${seed}`).toBe(2);
        expect(await snap(y), `seed ${seed}`).toEqual(await snap(x));
      }
    });
  });

  describe("اعتبارسنجی ترکیبی (قواعد loadCorpus با زمینهٔ موجود)", () => {
    it("ارجاع معلق: مسیر مسئله به ایندکس ورودی برمی‌گردد (نه ایندکس اسکلت)؛ ماده یا سند نبود", async () => {
      const kb = await withSample(); // اسکلت چند سند و ۳ رابطه از قبل دارد ⇒ ایندکس ترکیبی جابه‌جا است
      const before = await snap(kb);
      const e = failure(
        await kb.store.insertIncremental(
          corpusJson(
            [simpleDoc("fresh-doc")],
            [
              relationJson("implements", node("fresh-doc", "1"), node("sample-law", "1")),
              relationJson("implements", node("fresh-doc", "1"), node("sample-law", "99")),
              relationJson("implements", node("fresh-doc", "1"), node("no-such-law")),
            ],
          ),
        ),
      );
      expect(e.code).toBe("INVALID_CORPUS");
      expect(e.issues?.map((i) => `${i.code}@${i.path}`)).toEqual(["DANGLING_REF@relations[1].to", "DANGLING_REF@relations[2].to"]);
      expect(e.issues?.[0]?.message).toContain("99");
      expect(await snap(kb)).toEqual(before);
    });

    it("مسئلهٔ ساختاری در سند نو: مسیر documents[i] نسبت به ورودی است", async () => {
      const kb = await withSample();
      const bad = simpleDoc("bad-doc");
      bad["kind"] = "not-a-kind";
      const e = failure(await kb.store.insertIncremental(corpusJson([simpleDoc("ok-doc"), bad], [relationJson("refers-to", node("ok-doc"), node("sample-law"))])));
      expect(e.code).toBe("INVALID_CORPUS");
      expect(e.issues?.some((i) => i.path === "documents[1].kind")).toBe(true);
      expect(e.issues?.every((i) => !i.path.startsWith("context."))).toBe(true);
    });

    it("رابطهٔ تکراریِ موجود (نوع، مبدأ، مقصد، تاریخ اثر یکسان): DUPLICATE روی ورودی", async () => {
      const kb = await withSample();
      const existing = must(await kb.store.readCorpus()).relations[0]!;
      const e = failure(
        await kb.store.insertIncremental(corpusJson([], [relationJson(existing.type, node(existing.from.documentId, existing.from.article), node(existing.to.documentId, existing.to.article), { effectiveFrom: existing.effectiveFrom })])),
      );
      expect(e.issues?.map((i) => `${i.code}@${i.path}`)).toEqual(["DUPLICATE@relations[0]"]);
    });

    it("تناقض با رابطهٔ موجود: «الف ب را نسخ می‌کند» و سپس «ب الف را نسخ می‌کند»", async () => {
      const kb = await open();
      must(await kb.store.insertCorpus(corpusJson([simpleDoc("law-a"), simpleDoc("law-b")], [relationJson("repeals", node("law-a"), node("law-b"))])));
      const before = await snap(kb);
      const e = failure(await kb.store.insertIncremental(corpusJson([], [relationJson("repeals", node("law-b"), node("law-a"))])));
      expect(e.issues?.map((i) => i.code)).toEqual(["CONTRADICTORY_RELATION"]);
      expect(await snap(kb)).toEqual(before);
      // و رابطهٔ هم‌جهت با تاریخ اثر دیگر مجاز است
      must(await kb.store.insertIncremental(corpusJson([], [relationJson("repeals", node("law-a"), node("law-b"), { effectiveFrom: "2022-02-02" })])));
    });

    it("کلید ناشناختهٔ سطح بالا بی‌صدا دور ریخته نمی‌شود (حتی وقتی زمینه لازم است)", async () => {
      const kb = await withSample();
      const input = { ...corpusJson([], [relationJson("refers-to", node("sample-law"), node("sample-single-act"))]), typo: 1 };
      const e = failure(await kb.store.insertIncremental(input));
      expect(e.code).toBe("INVALID_CORPUS");
      expect(e.issues?.some((i) => i.code === "UNKNOWN_FIELD")).toBe(true);
    });

    it("شناسهٔ مخرب سند در ارجاع فقط پارامتر است: DANGLING_REF و پایگاه سالم", async () => {
      const kb = await withSample();
      const before = await snap(kb);
      for (const evil of ["x'); DROP SCHEMA public CASCADE; --", '"; DROP TABLE x; --', "سند‌فارسی", "a".repeat(64), "A B"]) {
        const e = failure(await kb.store.insertIncremental(corpusJson([], [relationJson("refers-to", node("sample-law"), node(evil))])));
        expect(e.code).toBe("INVALID_CORPUS");
      }
      expect(await snap(kb)).toEqual(before);
      const alive = await kb.raw(`SELECT 1 AS ok FROM information_schema.schemata WHERE schema_name = 'public'`);
      expect(alive).toHaveLength(1);
    });

    it("بیش از ۲۰۰ سندِ بیرونی: LIMIT_EXCEEDED بدون سفر به پایگاه", async () => {
      const kb = await withSample();
      const rels = Array.from({ length: 201 }, (_, i) => relationJson("refers-to", node("sample-law"), node(`ghost-${i}`)));
      const e = failure(await kb.store.insertIncremental(corpusJson([], rels)));
      expect(e.issues?.map((i) => i.code)).toEqual(["LIMIT_EXCEEDED"]);
    });

    it("ورودی بدشکل: INVALID_CORPUS و هرگز پرتاب نمی‌کند", async () => {
      const kb = await withSample();
      for (const bad of [null, undefined, 5, "x", [], {}, { documents: {} }, { documents: [], relations: [], rulings: "x" }, { documents: [null], relations: [], rulings: [] }]) {
        const e = failure(await kb.store.insertIncremental(bad));
        expect(e.code, JSON.stringify(bad)).toBe("INVALID_CORPUS");
      }
    });
  });

  describe("فقط‌افزودنی و اتمی", () => {
    it("سند یا رأی با شناسهٔ موجود: ALREADY_EXISTS با فهرست؛ هیچ‌چیز (حتی بخش نوِ همان ورودی) درج نمی‌شود", async () => {
      const kb = await withSample();
      const before = await snap(kb);
      const e = failure(
        await kb.store.insertIncremental(
          corpusJson(
            [simpleDoc("brand-new"), simpleDoc("sample-law")],
            [relationJson("refers-to", node("brand-new", "1"), node("sample-single-act"))],
            [rulingJson("sample-unity-ruling-1", [node("sample-law")])],
          ),
        ),
      );
      expect(e.code).toBe("ALREADY_EXISTS");
      expect(e.conflicts).toEqual(["document:sample-law", "ruling:sample-unity-ruling-1"]);
      expect(await snap(kb)).toEqual(before);
    });

    it("درج دوباره‌ی همان بستهٔ افزایشی: ALREADY_EXISTS (ایدمپوتنت‌نما نیست؛ بازنویسی نمی‌کند)", async () => {
      const kb = await withSample();
      const pkg = corpusJson([simpleDoc("once")], [relationJson("refers-to", node("once", "1"), node("sample-law"))]);
      must(await kb.store.insertIncremental(pkg));
      const after1 = await snap(kb);
      expect(failure(await kb.store.insertIncremental(pkg)).code).toBe("ALREADY_EXISTS");
      expect(await snap(kb)).toEqual(after1);
    });

    it("رابطهٔ تکراری میان دو سند موجود در دو درج پشت‌هم: بار دوم رد می‌شود", async () => {
      const kb = await withSample();
      const rel = relationJson("interprets", node("sample-single-act"), node("sample-law", "1"), { effectiveFrom: "2021-01-01" });
      must(await kb.store.insertIncremental(corpusJson([], [rel])));
      const e = failure(await kb.store.insertIncremental(corpusJson([], [rel])));
      expect(e.issues?.[0]?.code).toBe("DUPLICATE");
    });

    it("شکست در میانهٔ درج (قید پایگاه) ⇒ برگشت کامل: نه سند، نه رابطه", async () => {
      const kb = await withSample();
      const before = await snap(kb);
      // تریگر آزمایشی روی رأی: درج سند و رابطه انجام می‌شود و درج رأی شکست می‌خورد.
      await kb.raw(`CREATE FUNCTION {{schema}}.boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom' USING ERRCODE = '23514'; END $$`);
      await kb.raw(`CREATE TRIGGER boom BEFORE INSERT ON {{schema}}.ruling FOR EACH ROW EXECUTE FUNCTION {{schema}}.boom()`);
      const e = failure(
        await kb.store.insertIncremental(
          corpusJson([simpleDoc("half-doc")], [relationJson("refers-to", node("half-doc", "1"), node("sample-law"))], [rulingJson("half-ruling", [node("half-doc")])]),
        ),
      );
      expect(e.code).toBe("CONSTRAINT_VIOLATION");
      await kb.raw(`DROP TRIGGER boom ON {{schema}}.ruling`);
      expect(await snap(kb)).toEqual(before);
    });

    it("۶ درج افزایشی هم‌زمان با سندهای متفاوت روی همان سندِ موجود: همه موفق، seq بی‌حفره و یکتا", async () => {
      const kb = await withSample();
      const before = must(await kb.store.stats());
      const rs = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          kb.store.insertIncremental(corpusJson([simpleDoc(`par-${i}`)], [relationJson("implements", node(`par-${i}`, "1"), node("sample-law", "1"))], [rulingJson(`par-r${i}`, [node("sample-law", "2")])])),
        ),
      );
      for (const r of rs) expect(r.ok).toBe(true);
      const after = must(await kb.store.stats());
      expect(after.documents).toBe(before.documents + 6);
      expect(after.relations).toBe(before.relations + 6);
      expect(after.rulings).toBe(before.rulings + 6);
      for (const t of ["document", "relation", "ruling"]) {
        const seqs = (await kb.raw(`SELECT seq::int AS seq FROM {{schema}}.${t} ORDER BY seq`)).map((r) => r["seq"] as number);
        expect(seqs, t).toEqual(seqs.map((_, i) => i + 1));
      }
    });

    it("۸ درج هم‌زمان همان سند: دقیقاً یکی موفق، بقیه ALREADY_EXISTS", async () => {
      const kb = await withSample();
      const rs = await Promise.all(Array.from({ length: 8 }, () => kb.store.insertIncremental(corpusJson([simpleDoc("race-doc")], [relationJson("refers-to", node("race-doc", "1"), node("sample-law"))]))));
      expect(rs.filter((r) => r.ok)).toHaveLength(1);
      for (const r of rs) if (!r.ok) expect(r.error.code).toBe("ALREADY_EXISTS");
      expect(must(await kb.store.stats()).documents).toBe(4);
    });

    it("درج افزایشی و تأیید هم‌زمان روی سند موجود با هم تداخل ندارند (قفل نوشتن مشترک)", async () => {
      const kb = await withSample();
      const ref = { documentId: "sample-law", article: "1", validFrom: "2018-01-01" };
      const lookup = must(await kb.store.resolveCitation({ documentId: "sample-law", article: "1", subpart: null }, "2018-01-01"));
      if (lookup.status !== "found") throw new Error("setup");
      const { versionContentHash } = await import("./content-hash");
      const [ins, ver] = await Promise.all([
        kb.store.insertIncremental(corpusJson([simpleDoc("conc-doc")], [relationJson("refers-to", node("conc-doc", "1"), node("sample-law", "1"))])),
        kb.store.markVerified(ref, { expectedHash: versionContentHash(lookup.version), reviewedBy: "بازبین", reviewedOn: "2025-01-01" }),
      ]);
      expect(ins.ok && ver.ok).toBe(true);
    });
  });

  describe("سلامت پس از درج افزایشی", () => {
    it("حقیقت زمانی: resolveCitation روی ماده‌های سندِ نو و قدیم بعد از درج افزایشی درست است", async () => {
      const kb = await withSample();
      must(await kb.store.insertIncremental(corpusJson([documentJson("timed", [article("1", [version("2005-01-01", "2010-01-01", "الف"), version("2012-01-01", null, "ب")])])], [relationJson("refers-to", node("timed", "1"), node("sample-law", "1"))])));
      const at = async (day: string) => must(await kb.store.resolveCitation({ documentId: "timed", article: "1", subpart: null }, day));
      expect((await at("2004-12-31")).status).toBe("not-yet-in-force");
      expect((await at("2009-12-31")).status).toBe("found");
      expect((await at("2010-01-01")).status).toBe("gap");
      expect((await at("2012-01-01")).status).toBe("found");
      const old = must(await kb.store.resolveCitation({ documentId: "sample-law", article: "1", subpart: null }, "2015-06-01"));
      expect(old.status).toBe("gap"); // شکاف عمدی نمونه همچنان هست
    });

    it("ورودی null-prototype/کلید ویژه: بی‌خطر (hasOwnProperty، __proto__)", async () => {
      const kb = await withSample();
      const input = JSON.parse(`{"documents":[],"relations":[],"rulings":[],"__proto__":{"x":1}}`);
      const e = failure(await kb.store.insertIncremental(input));
      expect(e.code).toBe("INVALID_CORPUS");
    });
  });

  it("پیکربندی: pendingProv ساختگی بدون درز (بدون ارزش حقوقی)", () => {
    expect(JSON.stringify(pendingProv())).not.toMatch(/password|token/i);
  });
});
