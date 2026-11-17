/**
 * جست‌وجوی کلمه‌ای روی پایگاه واقعی (بخش ۴ب‑۳). اصل سنجش: «نمایه فقط مکان‌یاب است».
 *   • هیچ نتیجه‌ای که متنِ اصلی واقعاً همهٔ واژه‌ها را نداشته باشد (مثبتِ کاذب ممکن نیست)، حتی با نمایهٔ خراب؛
 *   • نمایهٔ کهنه فقط بازیابی را کم می‌کند و شمرده می‌شود (`staleSkipped`)، و با `reindexSearch` درست می‌شود؛
 *   • اعتبار در تاریخ و «تأییدشده» همیشه از جدول اصلی است (تأیید/پس‌گرفتن بی‌درنگ اثر می‌کند).
 * به‌علاوه: تست تفاضلی با اوراکل خالص روی Corpusهای تصادفیِ بذردار.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildCorpusIndex, loadCorpus, versionsInForceAt, type Corpus } from "@/modules/legal-kb-schema";
import { versionContentHash } from "./content-hash";
import { buildIndexRow, referenceMatches, searchKeyFingerprint } from "./search-text";
import type { SearchResult } from "./search-types";
import { article, corpusJson, dayToIso, documentJson, pendingProv, randomCorpus, rng, verifiedProv, version, type J } from "./test-corpus";
import { dbDescribe, openTestKb, type TestKb } from "./test-db";
import type { StoreError, StoreResult } from "./types";

const must = <T>(r: StoreResult<T>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error).slice(0, 600));
  return r.value;
};
const failure = <T>(r: StoreResult<T>): StoreError => {
  if (r.ok) throw new Error("باید شکست می‌خورد");
  return r.error;
};
const refs = (r: SearchResult): string[] => r.hits.map((h) => `${h.ref.documentId}/${h.ref.article}@${h.ref.validFrom}`);

/** Corpus ساختگیِ جست‌وجو. هیچ چیز واقعی نیست. */
const sub = (kind: "note" | "clause", label: string, text: string): J => ({ kind, label, text });
const searchCorpus = (): J =>
  corpusJson([
    documentJson("law-a", [
      article("1", [
        version("2001-01-01", "2010-01-01", "فروشنده مکلف است مبیع را تحویل دهد.", [sub("note", "1", "تحویل مبیع در محل عقد انجام می‌شود.")], verifiedProv()),
        version("2010-01-01", null, "فروشنده مکلف است مبیع را در مهلت مقرر تحویل دهد. مبیع باید سالم باشد.", [], pendingProv()),
      ]),
      article("2", [version("2001-01-01", null, "خریدار مکلف است ثمن را بپردازد. ثمن ثمن", [], verifiedProv())]),
      article("10 مکرر", [version("2005-05-05", null, "مادهٔ ۱۰ مکرر: كتاب‌ها و می‌خواهم ۱۰۰ برگ", [], verifiedProv())]),
    ]),
    documentJson("law-b", [article("واحده", [version("2015-01-01", null, "تحویل مبیع و پرداخت ثمن در این ماده", [], pendingProv())])]),
  ]);

dbDescribe("legal-kb-store · جست‌وجوی کلمه‌ای (پایگاه واقعی)", () => {
  const opened: TestKb[] = [];
  const open = async (o: Readonly<{ migrate?: boolean }> = {}): Promise<TestKb> => {
    const kb = await openTestKb(o);
    opened.push(kb);
    return kb;
  };
  /** store با نمونه، نمایه مهاجرت‌شده و ساخته‌شده. */
  const ready = async (corpus: J = searchCorpus()): Promise<TestKb> => {
    const kb = await open();
    must(await kb.store.insertCorpus(corpus));
    must(await kb.store.migrateSearch());
    must(await kb.store.reindexSearch());
    return kb;
  };
  afterEach(async () => {
    for (const kb of opened.splice(0)) await kb.drop();
  });
  const q = (kb: TestKb, text: string, asOf: string, extra: Record<string, unknown> = {}) => kb.store.searchArticles({ text, asOf, ...extra });
  const searchSchema = (kb: TestKb) => `"${kb.schema}_search"`;
  const indexCount = async (kb: TestKb): Promise<number> => Number((await kb.raw(`SELECT count(*)::int AS n FROM ${searchSchema(kb)}.article_search`))[0]?.["n"]);
  const current = async (kb: TestKb, doc: string, art: string, at: string) => {
    const r = must(await kb.store.resolveCitation({ documentId: doc, article: art, subpart: null }, at));
    if (r.status !== "found") throw new Error(`not found ${r.status}`);
    return r.version;
  };

  describe("مهاجرت و دفتر مستقل", () => {
    it("`migrate()` نمایه را نمی‌سازد؛ تا migrateSearch همه‌چیز NOT_MIGRATED (و پیام راهنما) است", async () => {
      const kb = await open();
      const schemas = async () => (await kb.raw(`SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE $1 ORDER BY 1`, [`${kb.schema}%`])).map((r) => r["schema_name"]);
      expect(await schemas()).toEqual([kb.schema, `${kb.schema}_audit`]);
      const calls: ReadonlyArray<() => Promise<StoreResult<unknown>>> = [() => q(kb, "ثمن", "2024-01-01"), () => kb.store.reindexSearch(), () => kb.store.searchStatus()];
      for (const call of calls) {
        const e = failure(await call());
        expect(e.code).toBe("NOT_MIGRATED");
        expect(e.message).toContain("migrateSearch");
      }
      expect(must(await kb.store.searchMigrationStatus())).toEqual({ applied: [], pending: ["0001_article_search"] });
      must(await kb.store.migrateSearch());
      expect(await schemas()).toEqual([kb.schema, `${kb.schema}_audit`, `${kb.schema}_search`]);
    });

    it("مهاجرت دانش دست‌نخورده می‌ماند: همان دو مهاجرت و همان ۸ جدول", async () => {
      const kb = await open();
      must(await kb.store.migrateSearch());
      expect(must(await kb.store.migrationStatus())).toEqual({ applied: ["0001_init", "0002_version_audit"], pending: [] });
      const tables = (await kb.raw(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`, [kb.schema])).map((r) => r["table_name"]);
      expect(tables).toEqual(["article", "article_subpart", "article_version", "document", "migration_ledger", "relation", "ruling", "ruling_cite"]);
    });

    it("ایدمپوتنت؛ دفتر با checksum؛ ۶ مهاجرت هم‌زمان ⇒ دقیقاً یکی اعمال می‌کند", async () => {
      const kb = await open();
      const runs = await Promise.all(Array.from({ length: 6 }, () => kb.store.migrateSearch()));
      const reports = runs.map(must);
      expect(reports.filter((r) => r.applied.length === 1)).toHaveLength(1);
      expect(must(await kb.store.migrateSearch())).toEqual({ applied: [], alreadyApplied: ["0001_article_search"] });
      const ledger = await kb.raw(`SELECT name, checksum FROM ${searchSchema(kb)}.search_ledger`);
      expect(ledger).toEqual([{ name: "0001_article_search", checksum: "356117fca6e0cffd02b59471df9f76f192747d3ba2e573ee41124bb1ff15ae65" }]);
    });

    it("دست‌کاری دفتر: checksum ناهمخوان ⇒ MIGRATION_TAMPERED؛ مهاجرت ناشناخته ⇒ MIGRATION_UNKNOWN", async () => {
      const kb = await ready();
      await kb.raw(`UPDATE ${searchSchema(kb)}.search_ledger SET checksum = repeat('0', 64)`);
      expect(failure(await q(kb, "ثمن", "2024-01-01")).code).toBe("MIGRATION_TAMPERED");
      expect(failure(await kb.store.migrateSearch()).code).toBe("MIGRATION_TAMPERED");
      await kb.raw(`UPDATE ${searchSchema(kb)}.search_ledger SET checksum = '356117fca6e0cffd02b59471df9f76f192747d3ba2e573ee41124bb1ff15ae65'`);
      expect(must(await q(kb, "ثمن", "2024-01-01", { verifiedOnly: false })).hits.length).toBeGreaterThan(0);
      await kb.raw(`INSERT INTO ${searchSchema(kb)}.search_ledger (name, checksum) VALUES ('9999_future', repeat('1', 64))`);
      expect(failure(await q(kb, "ثمن", "2024-01-01")).code).toBe("MIGRATION_UNKNOWN");
    });

    it("مهاجرتِ معلق (ردیف دفتر پاک شده): همهٔ عملیات NOT_MIGRATED با پیام «مهاجرت معلق» و وضعیت «معلق»", async () => {
      const kb = await ready();
      await kb.raw(`DELETE FROM ${searchSchema(kb)}.search_ledger WHERE name = '0001_article_search'`);
      expect(must(await kb.store.searchMigrationStatus())).toEqual({ applied: [], pending: ["0001_article_search"] });
      const calls: ReadonlyArray<() => Promise<StoreResult<unknown>>> = [() => q(kb, "ثمن", "2024-01-01"), () => kb.store.reindexSearch(), () => kb.store.searchStatus()];
      for (const call of calls) {
        const e = failure(await call());
        expect(e.code).toBe("NOT_MIGRATED");
        expect(e.message).toContain("مهاجرت معلق");
      }
    });

    it("جدول نمایه قید دارد: هش/اثر انگشت نامعتبر و واژهٔ NULL رد می‌شود", async () => {
      const kb = await ready();
      const ins = async (hash: string, fp: string, tokens: string) => {
        try {
          await kb.raw(`INSERT INTO ${searchSchema(kb)}.article_search (document_id, article_label, valid_from, content_hash, key_fingerprint, tokens) VALUES ('zz', '1', '2020-01-01', $1, $2, ${tokens})`, [hash, fp]);
          return null;
        } catch (e) {
          return (e as { constraint?: string }).constraint ?? "?";
        }
      };
      const ok = "a".repeat(64);
      expect(await ins("xyz", ok, "ARRAY['a']")).toBe("article_search_hash_ck");
      expect(await ins(ok, "A".repeat(64), "ARRAY['a']")).toBe("article_search_fp_ck");
      expect(await ins(ok, ok, "ARRAY['a', NULL]")).toBe("article_search_tokens_ck");
      expect(await ins(ok, ok, "ARRAY['a']")).toBeNull();
    });
  });

  describe("نمایه‌سازی", () => {
    it("نخستین بار همه «تازه»؛ بار دوم همه «بدون‌تغییر»؛ سلامت سبز", async () => {
      const kb = await open();
      must(await kb.store.insertCorpus(searchCorpus()));
      must(await kb.store.migrateSearch());
      expect(must(await kb.store.reindexSearch())).toEqual({ indexed: 5, updated: 0, unchanged: 0, removed: 0, totalVersions: 5 });
      expect(must(await kb.store.reindexSearch())).toEqual({ indexed: 0, updated: 0, unchanged: 5, removed: 0, totalVersions: 5 });
      const st = must(await kb.store.searchStatus());
      expect(st).toEqual({ totalVersions: 5, indexed: 5, missing: 0, stale: 0, orphans: 0, upToDate: true, keyFingerprint: searchKeyFingerprint(), migrations: ["0001_article_search"] });
    });

    it("محتوای نمایه همان buildIndexRow است (هش، اثر انگشت، واژه‌ها) و تبصره‌ها هم نمایه می‌شوند", async () => {
      const kb = await ready();
      const v = await current(kb, "law-a", "1", "2005-01-01");
      const row = (await kb.raw(`SELECT content_hash, key_fingerprint, tokens FROM ${searchSchema(kb)}.article_search WHERE document_id = 'law-a' AND article_label = '1' AND valid_from = '2001-01-01'`))[0];
      const expected = buildIndexRow({ text: v.text, subparts: v.subparts });
      expect(row?.["content_hash"]).toBe(expected.contentHash);
      expect(row?.["content_hash"]).toBe(versionContentHash(v));
      expect(row?.["key_fingerprint"]).toBe(searchKeyFingerprint());
      expect(row?.["tokens"]).toEqual(expected.tokens);
      expect(expected.tokens).toContain("عقد"); // فقط در تبصره
    });

    it("درج افزایشی: سند تازه تا reindex «بی‌نمایه» است و دیده نمی‌شود؛ سپس پیدا می‌شود", async () => {
      const kb = await ready();
      must(await kb.store.insertIncremental(corpusJson([documentJson("law-c", [article("1", [version("2020-01-01", null, "ضمانت اجرای مبیع", [], verifiedProv())])])])));
      expect(must(await kb.store.searchStatus())).toMatchObject({ missing: 1, stale: 0, orphans: 0, upToDate: false, totalVersions: 6, indexed: 5 });
      expect(refs(must(await q(kb, "ضمانت", "2024-01-01")))).toEqual([]);
      expect(must(await kb.store.reindexSearch())).toMatchObject({ indexed: 1, updated: 0, unchanged: 5 });
      expect(refs(must(await q(kb, "ضمانت", "2024-01-01")))).toEqual(["law-c/1@2020-01-01"]);
    });

    it("نمایهٔ یتیم (نسخه‌ای که دیگر نیست) دیده، از نتیجه دور و با reindex پاک می‌شود", async () => {
      const kb = await ready();
      await kb.raw(`DELETE FROM {{schema}}.article_subpart WHERE document_id = 'law-a' AND article_label = '1' AND valid_from = '2001-01-01'`);
      await kb.raw(`DELETE FROM {{schema}}.article_version WHERE document_id = 'law-a' AND article_label = '1' AND valid_from = '2001-01-01'`);
      expect(must(await kb.store.searchStatus())).toMatchObject({ orphans: 1, missing: 0, stale: 0, upToDate: false });
      expect(refs(must(await q(kb, "مبیع", "2005-01-01")))).toEqual([]);
      expect(must(await kb.store.reindexSearch())).toMatchObject({ removed: 1, unchanged: 4, totalVersions: 4 });
      expect(must(await kb.store.searchStatus()).upToDate).toBe(true);
    });

    it("بیش از یک دسته (۴۵۰ نسخه): صفحه‌بندی keyset هیچ نسخه‌ای را جا نمی‌اندازد و تکرار نمی‌کند", async () => {
      const labels = Array.from({ length: 450 }, (_, i) => String(i + 1));
      const kb = await ready(corpusJson([documentJson("bulk", labels.map((l) => article(l, [version("2020-01-01", null, `ماده ${l} حکم مشترک`, [], verifiedProv())])))]));
      const st = must(await kb.store.searchStatus());
      expect(st).toMatchObject({ totalVersions: 450, indexed: 450, missing: 0, stale: 0, orphans: 0, upToDate: true });
      expect(await indexCount(kb)).toBe(450);
      expect(must(await kb.store.reindexSearch())).toMatchObject({ indexed: 0, updated: 0, unchanged: 450 });
    });

    it("اتمی: شکست در دستهٔ سوم، دسته‌های اول و دوم را هم برمی‌گرداند (چیزی نیمه‌کاره نمی‌ماند)", async () => {
      const labels = Array.from({ length: 450 }, (_, i) => String(i + 1));
      const kb = await open();
      must(await kb.store.insertCorpus(corpusJson([
        documentJson("bulk", labels.map((l) => article(l, [version("2020-01-01", null, `ماده ${l} حکم مشترک`, [], verifiedProv())]))),
        documentJson("zzz-poison", [article("1", [version("2020-01-01", null, "متن زهرآگین", [], verifiedProv())])]),
      ])));
      must(await kb.store.migrateSearch());
      await kb.raw(`CREATE FUNCTION ${searchSchema(kb)}.boom() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.document_id = 'zzz-poison' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $f$`);
      await kb.raw(`CREATE TRIGGER boom BEFORE INSERT ON ${searchSchema(kb)}.article_search FOR EACH ROW EXECUTE FUNCTION ${searchSchema(kb)}.boom()`);
      expect(failure(await kb.store.reindexSearch()).code).toBe("DB_ERROR");
      expect(await indexCount(kb)).toBe(0);
      await kb.raw(`DROP TRIGGER boom ON ${searchSchema(kb)}.article_search`);
      expect(must(await kb.store.reindexSearch())).toMatchObject({ indexed: 451, unchanged: 0 });
    }, 60_000);

    it("قفل بازسازی (قطعی): تا وقتی قفل مشورتیِ همان شِما در دست دیگری است، reindexSearch منتظر می‌ماند و پس از آزاد شدن کامل می‌شود", async () => {
      const kb = await open();
      must(await kb.store.insertCorpus(searchCorpus()));
      must(await kb.store.migrateSearch());
      const holder = await kb.pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`legal-kb-store:search-reindex:${kb.schema}`]);
        let finished = false;
        const run = kb.store.reindexSearch().then((r) => {
          finished = true;
          return r;
        });
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(finished).toBe(false);
        expect(await indexCount(kb)).toBe(0);
        await holder.query("COMMIT");
        expect(must(await run)).toMatchObject({ indexed: 5 });
      } finally {
        holder.release();
      }
    });

    it("۴ بازسازی هم‌زمان: هر نسخه دقیقاً یک بار «تازه» نمایه می‌شود و هیچ رقابتی خطا نمی‌دهد", async () => {
      const kb = await open();
      must(await kb.store.insertCorpus(searchCorpus()));
      must(await kb.store.migrateSearch());
      const reports = (await Promise.all(Array.from({ length: 4 }, () => kb.store.reindexSearch()))).map(must);
      expect(reports.reduce((n, r) => n + r.indexed, 0)).toBe(5);
      expect(reports.reduce((n, r) => n + r.updated, 0)).toBe(0);
      expect(must(await kb.store.searchStatus()).upToDate).toBe(true);
    });
  });

  describe("جست‌وجو: معنا", () => {
    it("همهٔ واژه‌ها (AND)، تطبیق کامل واژه؛ متن از جدول اصلی؛ همراه منبع و بازهٔ اعتبار", async () => {
      const kb = await ready();
      const r = must(await q(kb, "تحویل مبیع", "2005-01-01"));
      expect(refs(r)).toEqual(["law-a/1@2001-01-01"]);
      const h = r.hits[0]!;
      expect(h).toMatchObject({ documentTitle: "قانون ساختگی law-a", validTo: "2010-01-01", verified: true, matches: 4 });
      expect(h.text).toBe("فروشنده مکلف است مبیع را تحویل دهد.");
      expect(h.subparts).toEqual([{ kind: "note", label: "1", text: "تحویل مبیع در محل عقد انجام می‌شود." }]);
      expect(h.provenance.review.status).toBe("legally-verified");
      expect(h.contentHash).toBe(versionContentHash(h));
      expect(r).toMatchObject({ tokens: ["تحویل", "مبیع"], asOf: "2005-01-01", verifiedOnly: true, hasMore: false, staleSkipped: 0 });
      expect(refs(must(await q(kb, "تحویل ثمن", "2005-01-01")))).toEqual([]); // «ثمن» در ماده ۱ نیست
      expect(refs(must(await q(kb, "مبی", "2005-01-01")))).toEqual([]); // زیررشته ≠ واژه
    });

    it("تبصره/بندها با ترتیب ذخیره‌شده (نه ترتیب برچسب) برمی‌گردند و هش همان هشِ نسخهٔ اصلی است", async () => {
      const kb = await ready(corpusJson([documentJson("ord", [article("1", [version("2020-01-01", null, "متن اصلی ترتیب", [sub("note", "2", "دومین تبصره واژه‌ای"), sub("clause", "الف", "بند الف"), sub("note", "1", "نخستین تبصره")], verifiedProv())])])]));
      const r = must(await q(kb, "ترتیب", "2024-01-01"));
      const v = await current(kb, "ord", "1", "2024-01-01");
      expect(r.hits[0]?.subparts.map((x) => `${x.kind}:${x.label}`)).toEqual(["note:2", "clause:الف", "note:1"]);
      expect(r.hits[0]?.subparts).toEqual(v.subparts);
      expect(r.hits[0]?.contentHash).toBe(versionContentHash(v));
      expect(refs(must(await q(kb, "نخستین", "2024-01-01")))).toEqual(["ord/1@2020-01-01"]); // واژهٔ فقط در تبصره
    });

    it("هم‌ارزی نوشتاری: ی/ک عربی، ارقام فارسی/عربی/لاتین، «مادهٔ»، نیم‌فاصله، اعراب", async () => {
      const kb = await ready();
      const expected = ["law-a/10 مکرر@2005-05-05"];
      for (const text of ["ماده 10", "ماده ۱۰", "ماده ١٠", "مادهٔ 10", "كتاب ها", "کتاب‌ها", "كتاب‌ها", "می خواهم", "می‌خواهم", "۱۰۰ برگ", "100 برگ", "مَادّهٔ 10"]) {
        expect(refs(must(await q(kb, text, "2024-01-01"))), text).toEqual(expected);
      }
    });

    it("تاریخ: بازهٔ نیم‌باز [از، تا)؛ روز شروع شامل، روز پایان نه", async () => {
      const kb = await ready();
      const at = async (d: string) => refs(must(await q(kb, "مبیع", d, { verifiedOnly: false, documentId: "law-a" })));
      expect(await at("2000-12-31")).toEqual([]);
      expect(await at("2001-01-01")).toEqual(["law-a/1@2001-01-01"]);
      expect(await at("2009-12-31")).toEqual(["law-a/1@2001-01-01"]);
      expect(await at("2010-01-01")).toEqual(["law-a/1@2010-01-01"]);
      expect(await at("2099-12-31")).toEqual(["law-a/1@2010-01-01"]);
      // واژهٔ مخصوص نسخهٔ دوم در تاریخ نسخهٔ اول پیدا نمی‌شود
      expect(refs(must(await q(kb, "مهلت", "2009-12-31", { verifiedOnly: false })))).toEqual([]);
      expect(refs(must(await q(kb, "مهلت", "2010-01-01", { verifiedOnly: false })))).toEqual(["law-a/1@2010-01-01"]);
    });

    it("پیش‌فرض ایمن: فقط تأییدشده؛ verifiedOnly:false «در انتظار» را هم می‌آورد (با verified:false)", async () => {
      const kb = await ready();
      expect(refs(must(await q(kb, "مبیع", "2024-01-01")))).toEqual([]); // نسخهٔ فعلی ماده ۱ و law-b تأییدنشده‌اند
      const all = must(await q(kb, "مبیع", "2024-01-01", { verifiedOnly: false }));
      expect(refs(all)).toEqual(["law-a/1@2010-01-01", "law-b/واحده@2015-01-01"]);
      expect(all.hits.map((h) => h.verified)).toEqual([false, false]);
      expect(all.verifiedOnly).toBe(false);
      expect(failure(await q(kb, "مبیع", "2024-01-01", { verifiedOnly: "false" })).code).toBe("INVALID_INPUT");
      expect(failure(await q(kb, "مبیع", "2024-01-01", { verifiedonly: false })).code).toBe("INVALID_INPUT");
    });

    it("رتبه: امتیاز = جمع دفعات؛ هم‌امتیاز ⇒ ترتیب سند و ماده (قطعی)", async () => {
      const kb = await ready();
      const r = must(await q(kb, "ثمن", "2024-01-01", { verifiedOnly: false }));
      expect(r.hits.map((h) => [h.ref.documentId, h.matches])).toEqual([["law-a", 3], ["law-b", 1]]);
      const bulk = await ready(corpusJson([documentJson("bulk", ["10", "9", "10 مکرر", "1", "2", "واحده"].map((l) => article(l, [version("2020-01-01", null, "حکم مشترک", [], verifiedProv())])))]));
      expect(refs(must(await q(bulk, "مشترک", "2024-01-01"))).map((x) => x.split("/")[1]!.split("@")[0])).toEqual(["واحده", "1", "2", "9", "10", "10 مکرر"]);
    });

    it("فیلتر سند، سقف و hasMore", async () => {
      const labels = Array.from({ length: 30 }, (_, i) => String(i + 1));
      const kb = await ready(corpusJson([
        documentJson("bulk", labels.map((l) => article(l, [version("2020-01-01", null, "حکم مشترک", [], verifiedProv())]))),
        documentJson("other", [article("1", [version("2020-01-01", null, "حکم مشترک دیگر", [], verifiedProv())])]),
      ]));
      const page = must(await q(kb, "مشترک", "2024-01-01", { documentId: "bulk", limit: 10 }));
      expect(page.hits).toHaveLength(10);
      expect(page.hasMore).toBe(true);
      expect(page.hits.map((h) => h.ref.article)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]); // عددی، نه الفبایی
      const all = must(await q(kb, "مشترک", "2024-01-01", { documentId: "bulk", limit: 30 }));
      expect(all.hits).toHaveLength(30);
      expect(all.hasMore).toBe(false);
      expect(refs(must(await q(kb, "مشترک", "2024-01-01", { documentId: "other" })))).toEqual(["other/1@2020-01-01"]);
      expect(refs(must(await q(kb, "مشترک", "2024-01-01", { documentId: "nope" })))).toEqual([]);
      expect(must(await q(kb, "مشترک", "2024-01-01", { limit: 100 })).hits).toHaveLength(31);
    });

    it("پرسشِ خصمانه اثری ندارد و پایگاه سالم می‌ماند", async () => {
      const kb = await ready();
      const before = must(await kb.store.stats());
      for (const text of ["'; DROP SCHEMA public CASCADE; --", "a & b | !c :* <->", "\\ % _ ' \"", "ثمن'); DELETE FROM x; --", "😀 ثمن 🔥", "ثمن\u202E\u0007", "x".repeat(60)]) {
        const r = await q(kb, text, "2024-01-01", { verifiedOnly: false });
        if (!r.ok) expect(r.error.code, text).toBe("INVALID_INPUT");
      }
      expect(failure(await q(kb, "x ".repeat(300), "2024-01-01")).code).toBe("INVALID_INPUT");
      expect((await kb.raw(`SELECT 1 AS ok FROM information_schema.schemata WHERE schema_name = 'public'`))[0]?.["ok"]).toBe(1);
      expect(must(await kb.store.stats())).toEqual(before);
    });

    it("فقط‌خواندنی: جست‌وجو و وضعیت چیزی نمی‌نویسند", async () => {
      const kb = await ready();
      const snap = async () => (await kb.raw(`SELECT count(*)::int AS n, max(indexed_at)::text AS t, md5(string_agg(tokens::text || content_hash, '|' ORDER BY document_id, article_label, valid_from)) AS h FROM ${searchSchema(kb)}.article_search`))[0];
      const before = await snap();
      await q(kb, "ثمن", "2024-01-01", { verifiedOnly: false });
      must(await kb.store.searchStatus());
      expect(await snap()).toEqual(before);
    });

    it("دو store روی یک پایگاه (شِمای جدا) نتیجهٔ همدیگر را نمی‌بینند", async () => {
      const a = await ready();
      const b = await ready(corpusJson([documentJson("law-x", [article("1", [version("2020-01-01", null, "ثمن اختصاصی ایکس", [], verifiedProv())])])]));
      expect(refs(must(await q(b, "ثمن", "2024-01-01")))).toEqual(["law-x/1@2020-01-01"]);
      expect(refs(must(await q(a, "اختصاصی", "2024-01-01")))).toEqual([]);
    });
  });

  describe("جست‌وجو و مسیر اعتماد: اعتبار و تأیید همیشه از جدول اصلی", () => {
    it("تأیید و پس‌گرفتنِ تأیید بی‌درنگ اثر می‌کند (بدون reindex)", async () => {
      const kb = await ready();
      const ref = { documentId: "law-a", article: "1", validFrom: "2010-01-01" };
      expect(refs(must(await q(kb, "مهلت", "2024-01-01")))).toEqual([]);
      const v = await current(kb, ref.documentId, ref.article, "2024-01-01");
      must(await kb.store.markVerified(ref, { expectedHash: versionContentHash(v), reviewedBy: "حقوقدان فرضی", reviewedOn: "2025-03-01" }));
      const hit = must(await q(kb, "مهلت", "2024-01-01")).hits[0]!;
      expect(hit).toMatchObject({ verified: true, provenance: { review: { reviewedBy: "حقوقدان فرضی" } } });
      must(await kb.store.revokeVerification(ref, { expectedHash: versionContentHash(v), revokedBy: "حقوقدان فرضی", revokedOn: "2025-03-02", reason: "دلیل ساختگی برای آزمون" }));
      expect(refs(must(await q(kb, "مهلت", "2024-01-01")))).toEqual([]);
      expect(must(await kb.store.searchStatus()).upToDate).toBe(true); // تأیید متن را عوض نمی‌کند ⇒ نمایه کهنه نمی‌شود
    });

    it("اصلاح متن: نتیجهٔ کهنه هرگز برنمی‌گردد (staleSkipped)، سلامت قرمز می‌شود و reindex درست می‌کند؛ تأیید هم پاک شده است", async () => {
      const kb = await ready();
      const ref = { documentId: "law-a", article: "2", validFrom: "2001-01-01" };
      const v = await current(kb, ref.documentId, ref.article, "2024-01-01");
      expect(refs(must(await q(kb, "ثمن", "2024-01-01", { documentId: "law-a" })))).toEqual(["law-a/2@2001-01-01"]);
      must(await kb.store.correctVersion(ref, { expectedHash: versionContentHash(v), text: "خریدار مکلف است قیمت را بپردازد.", subparts: [], correctedBy: "ویراستار فرضی", correctedOn: "2025-03-03", reason: "اصلاح غلط تایپی (ساختگی)" }));

      const stale = must(await q(kb, "ثمن", "2024-01-01", { documentId: "law-a", verifiedOnly: false }));
      expect(stale.hits).toEqual([]); // متن قدیمی («ثمن») دیگر برنمی‌گردد
      expect(stale.staleSkipped).toBe(1);
      expect(must(await q(kb, "قیمت", "2024-01-01", { verifiedOnly: false })).hits).toEqual([]); // نمایه هنوز نمی‌داند
      expect(must(await kb.store.searchStatus())).toMatchObject({ stale: 1, missing: 0, upToDate: false });

      expect(must(await kb.store.reindexSearch())).toMatchObject({ updated: 1, indexed: 0, unchanged: 4 });
      const fixed = must(await q(kb, "قیمت", "2024-01-01", { verifiedOnly: false }));
      expect(refs(fixed)).toEqual(["law-a/2@2001-01-01"]);
      expect(fixed.hits[0]).toMatchObject({ text: "خریدار مکلف است قیمت را بپردازد.", verified: false }); // اصلاح تأیید را پاک کرده
      expect(fixed.staleSkipped).toBe(0);
      expect(refs(must(await q(kb, "قیمت", "2024-01-01")))).toEqual([]); // و پیش‌فرضِ ایمن آن را نشان نمی‌دهد
      expect(must(await kb.store.searchStatus()).upToDate).toBe(true);
    });

    it("سیاست یکدست: اصلاحی که واژه‌ها را عوض نمی‌کند (فقط نشانه‌گذاری) هم نمایه را «کهنه» می‌کند؛ تا reindex دیده نمی‌شود و سلامت قرمز است", async () => {
      const kb = await ready();
      const ref = { documentId: "law-a", article: "2", validFrom: "2001-01-01" };
      const v = await current(kb, ref.documentId, ref.article, "2024-01-01");
      must(await kb.store.correctVersion(ref, { expectedHash: versionContentHash(v), text: "خریدار مکلف است ثمن را بپردازد؛ ثمن ثمن", subparts: [], correctedBy: "ویراستار فرضی", correctedOn: "2025-03-03", reason: "اصلاح نشانه‌گذاری (ساختگی)" }));
      expect(buildIndexRow({ text: "خریدار مکلف است ثمن را بپردازد؛ ثمن ثمن", subparts: [] }).tokens).toEqual(buildIndexRow({ text: v.text, subparts: v.subparts }).tokens);
      const r = must(await q(kb, "ثمن", "2024-01-01", { documentId: "law-a", verifiedOnly: false }));
      expect(r.hits).toEqual([]);
      expect(r.staleSkipped).toBe(1);
      expect(must(await kb.store.searchStatus())).toMatchObject({ stale: 1, upToDate: false });
      must(await kb.store.reindexSearch());
      const after = must(await q(kb, "ثمن", "2024-01-01", { documentId: "law-a", verifiedOnly: false }));
      expect(after.hits[0]?.text).toBe("خریدار مکلف است ثمن را بپردازد؛ ثمن ثمن");
      expect(after.staleSkipped).toBe(0);
    });

    it("رقابت: بازسازی هم‌زمان با اصلاح — هر نتیجه همیشه با متنِ فعلیِ جدول اصلی می‌خواند و واژه‌ها واقعاً در آن‌اند", async () => {
      const kb = await ready();
      const ref = { documentId: "law-a", article: "2", validFrom: "2001-01-01" };
      for (let round = 0; round < 6; round++) {
        const v = await current(kb, ref.documentId, ref.article, "2024-01-01");
        const next = round % 2 === 0 ? "خریدار مکلف است قیمت را بپردازد." : "خریدار مکلف است ثمن را بپردازد. ثمن ثمن";
        const [rx] = await Promise.all([
          kb.store.correctVersion(ref, { expectedHash: versionContentHash(v), text: next, subparts: [], correctedBy: "ویراستار فرضی", correctedOn: "2025-03-03", reason: `دور ${round} (ساختگی)` }),
          kb.store.reindexSearch(),
          q(kb, "ثمن", "2024-01-01", { verifiedOnly: false }),
        ]);
        must(rx);
        for (const word of ["ثمن", "قیمت"]) {
          const r = must(await q(kb, word, "2024-01-01", { verifiedOnly: false }));
          for (const h of r.hits) {
            const now = await current(kb, h.ref.documentId, h.ref.article, "2024-01-01");
            expect(h.text, `${word} دور ${round}`).toBe(now.text);
            expect(h.text.includes(word)).toBe(true);
          }
        }
        must(await kb.store.reindexSearch());
        expect(must(await kb.store.searchStatus()).upToDate, `دور ${round}`).toBe(true);
      }
    }, 60_000);

    it("تغییر قاعدهٔ نرمال‌سازی (اثر انگشت) ⇒ همهٔ نمایه‌ها کهنه؛ هیچ نتیجه‌ای از قاعدهٔ قدیم برنمی‌گردد؛ reindex همه را بازمی‌سازد", async () => {
      const kb = await ready();
      await kb.raw(`UPDATE ${searchSchema(kb)}.article_search SET key_fingerprint = repeat('0', 64)`);
      expect(must(await kb.store.searchStatus())).toMatchObject({ stale: 5, upToDate: false });
      const r = must(await q(kb, "ثمن", "2024-01-01", { verifiedOnly: false }));
      expect(r.hits).toEqual([]);
      expect(r.staleSkipped).toBe(2);
      expect(must(await kb.store.reindexSearch())).toMatchObject({ updated: 5, indexed: 0, unchanged: 0 });
      expect(must(await q(kb, "ثمن", "2024-01-01", { verifiedOnly: false })).hits).toHaveLength(2);
    });

    it("نمایهٔ دست‌کاری‌شده: واژهٔ جعلی در نمایه (با هش درست) هرگز مثبتِ کاذب نمی‌دهد", async () => {
      const kb = await ready();
      await kb.raw(`UPDATE ${searchSchema(kb)}.article_search SET tokens = tokens || ARRAY['جعلی'] WHERE document_id = 'law-a' AND article_label = '2'`);
      const r = must(await q(kb, "جعلی", "2024-01-01", { verifiedOnly: false }));
      expect(r.hits).toEqual([]);
      expect(r.staleSkipped).toBe(1);
      // امتیازِ ناهمخوان (تکرار جعلیِ واژهٔ واقعی) هم رد می‌شود
      await kb.raw(`UPDATE ${searchSchema(kb)}.article_search SET tokens = array_cat(tokens, ARRAY['ثمن', 'ثمن']) WHERE document_id = 'law-a' AND article_label = '2'`);
      const r2 = must(await q(kb, "ثمن", "2024-01-01", { verifiedOnly: false, documentId: "law-a" }));
      expect(r2.hits).toEqual([]);
      expect(r2.staleSkipped).toBe(1);
    });
  });

  describe("تفاضلی: پایگاه در برابر اوراکل خالص (Corpusهای تصادفیِ بذردار)", () => {
    const WORDS = ["متن", "ساختگی", "نسخه", "تبصره", "بند", "note", "clause", "الف", "ب", "ج", "1", "2", "3", "4", "10", "0", "مکرر", "نیست"];
    const toFa = (s: string) => s.replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)] as string);

    it("۲۵ بذر × پرسش‌های تصادفی: مجموعه، ترتیب، امتیاز، verified و hasMore دقیقاً برابرند", async () => {
      const kb = await open();
      const infos = Array.from({ length: 25 }, (_, i) => randomCorpus(7000 + i, `s${i}`));
      for (const info of infos) must(await kb.store.insertCorpus(info.json));
      must(await kb.store.migrateSearch());
      must(await kb.store.reindexSearch());
      expect(must(await kb.store.searchStatus()).upToDate).toBe(true);

      const corpus: Corpus = must(await kb.store.readCorpus());
      const index = buildCorpusIndex(corpus);
      const r = rng(424242);
      let checks = 0;
      let nonEmpty = 0;
      for (let n = 0; n < 400; n++) {
        const info = r.pick(infos);
        const art = r.pick(info.articles);
        const day = r.pick(art.edges) + r.pick([-1, 0, 1]);
        const asOf = dayToIso(day);
        const tokens = Array.from({ length: r.int(1, 3) }, () => r.pick(WORDS));
        const text = tokens.map((t) => (r.chance(0.3) ? toFa(t) : t)).join(r.pick([" ", "، ", " ‌"]));
        const verifiedOnly = r.chance(0.5);
        const documentId = r.chance(0.3) ? art.documentId : undefined;
        const limit = r.int(1, 12);

        const got = must(await q(kb, text, asOf, { verifiedOnly, ...(documentId === undefined ? {} : { documentId }), limit }));
        const parsedTokens = got.tokens;

        const force = versionsInForceAt(index, asOf);
        if (!force.ok) throw new Error(force.error.message);
        const inForce = force.value;
        const oracle = inForce
          .filter((e) => (documentId === undefined || e.documentId === documentId) && (!verifiedOnly || e.verified))
          .map((e) => ({ e, m: referenceMatches(parsedTokens, buildIndexRow({ text: e.version.text, subparts: e.version.subparts })) }))
          .filter((x): x is { e: (typeof inForce)[number]; m: number } => x.m !== null)
          .sort((a, b) => b.m - a.m); // Array.prototype.sort پایدار است ⇒ ترتیب سند/ماده برای هم‌امتیازها حفظ می‌شود
        const expected = oracle.slice(0, limit).map((x) => `${x.e.documentId}/${x.e.article}@${x.e.version.validFrom}#${x.m}#${x.e.verified}`);
        const actual = got.hits.map((h) => `${h.ref.documentId}/${h.ref.article}@${h.ref.validFrom}#${h.matches}#${h.verified}`);
        const ctx = `n=${n} text=${JSON.stringify(text)} asOf=${asOf} verifiedOnly=${verifiedOnly} doc=${documentId ?? "-"} limit=${limit}`;
        expect(actual, ctx).toEqual(expected);
        expect(got.hasMore, ctx).toBe(oracle.length > limit);
        expect(got.staleSkipped, ctx).toBe(0);
        checks++;
        if (expected.length > 0) nonEmpty++;
      }
      expect(checks).toBe(400);
      expect(nonEmpty).toBeGreaterThan(80); // تست تهی نیست: دست‌کم ۲۰٪ پرسش‌ها نتیجه دارند
    }, 120_000);

    it("بدون تأیید ساختگی: هر نتیجه از اوراکل `versionsInForceAt` روی Corpus خوانده‌شده از پایگاه هم‌خوان است (تاریخ‌های مرزی)", async () => {
      const kb = await open();
      const info = randomCorpus(99, "edge");
      must(await kb.store.insertCorpus(info.json));
      must(await kb.store.migrateSearch());
      must(await kb.store.reindexSearch());
      const loaded = loadCorpus(info.json);
      if (!loaded.ok) throw new Error("corpus");
      const index = buildCorpusIndex(loaded.value);
      for (const art of info.articles) {
        for (const edge of art.edges) {
          for (const delta of [-1, 0, 1]) {
            const asOf = dayToIso(edge + delta);
            const inForce = versionsInForceAt(index, asOf);
            if (!inForce.ok) throw new Error("date");
            const got = must(await q(kb, "متن", asOf, { verifiedOnly: false, limit: 100 }));
            expect(new Set(refs(got)), `${art.documentId}/${art.label} ${asOf}`).toEqual(new Set(inForce.value.map((e) => `${e.documentId}/${e.article}@${e.version.validFrom}`)));
          }
        }
      }
    }, 60_000);
  });
});
