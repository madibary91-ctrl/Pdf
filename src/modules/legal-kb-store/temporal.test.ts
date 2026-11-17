/**
 * نسخه‌بندی زمانی در پایگاه: تست **تفاضلی** در برابر موتور خالص `legal-kb-schema`.
 * دو پیاده‌سازی مستقل (JS روی شاخص حافظه، و SQL با `@>`/gist) باید روی هر Corpus و هر روز **دقیقاً** یک نتیجه بدهند.
 * مرجع مستقل سوم: جدول دست‌نویس برای نمونهٔ ساختگی (مرزهای نیم‌باز).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FICTIONAL_SAMPLE_CORPUS, buildCorpusIndex, loadCorpus, resolveCitation, versionsInForceAt, type CitationRef, type CorpusIndex, type VersionLookup } from "@/modules/legal-kb-schema";
import { dbDescribe, openTestKb, type TestKb } from "./test-db";
import { corpusJson, dayToIso, documentJson, article, isoToDay, randomCorpus, rng, version, type J } from "./test-corpus";

const sampleJson = (): J => JSON.parse(JSON.stringify(FICTIONAL_SAMPLE_CORPUS));

const brief = (l: VersionLookup): string => {
  switch (l.status) {
    case "found":
      return `found:${l.version.validFrom}${l.subpart ? `+${l.subpart.kind}${l.subpart.label}` : ""}`;
    case "gap":
      return `gap:${l.previousValidTo}..${l.nextValidFrom}`;
    case "not-yet-in-force":
      return `not-yet:${l.firstValidFrom}`;
    case "no-longer-in-force":
      return `no-longer:${l.lastValidTo}`;
    case "unknown-subpart":
      return `unknown-subpart@${l.version.validFrom}`;
    default:
      return l.status;
  }
};

async function inChunks<T, R>(items: readonly T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

dbDescribe("legal-kb-store · نسخه‌بندی زمانی (پایگاه واقعی)", () => {
  let kb: TestKb;
  let index: CorpusIndex;
  const catalog: Array<{ documentId: string; label: string; subparts: ReadonlyArray<{ kind: string; label: string }>; edges: number[] }> = [];

  beforeAll(async () => {
    kb = await openTestKb();
    const documents: J[] = [];
    const relations: J[] = [];
    const rulings: J[] = [];

    const sample = sampleJson();
    const r0 = await kb.store.insertCorpus(sample);
    if (!r0.ok) throw new Error("sample insert failed");
    documents.push(...sample["documents"]);
    relations.push(...sample["relations"]);
    rulings.push(...sample["rulings"]);
    for (const d of sample["documents"] as J[]) {
      for (const a of d["articles"] as J[]) {
        const edges = (a["versions"] as J[]).flatMap((v) => [isoToDay(v["validFrom"]), ...(v["validTo"] ? [isoToDay(v["validTo"])] : [])]);
        const subparts = (a["versions"] as J[]).flatMap((v) => (v["subparts"] as J[]).map((s) => ({ kind: s["kind"], label: s["label"] })));
        catalog.push({ documentId: d["id"], label: a["label"], subparts, edges });
      }
    }

    for (let seed = 1000; seed < 1040; seed++) {
      const info = randomCorpus(seed, `tq${seed}`);
      const r = await kb.store.insertCorpus(info.json);
      if (!r.ok) throw new Error(`seed ${seed}: ${JSON.stringify(r.error).slice(0, 300)}`);
      documents.push(...info.json["documents"]);
      relations.push(...info.json["relations"]);
      rulings.push(...info.json["rulings"]);
      for (const a of info.articles) catalog.push({ documentId: a.documentId, label: a.label, subparts: a.subparts, edges: [...a.edges] });
    }
    const merged = loadCorpus(corpusJson(documents, relations, rulings));
    if (!merged.ok) throw new Error("merged corpus invalid");
    index = buildCorpusIndex(merged.value);
  }, 120_000);

  afterAll(async () => {
    await kb.drop();
  });

  const ask = async (ref: CitationRef, date: string) => kb.store.resolveCitation(ref, date);
  const pure = (ref: CitationRef, date: string) => resolveCitation(index, ref, date);

  describe("مرجع مستقل: نمونهٔ ساختگی (جدول دست‌نویس)", () => {
    // ماده ۱ سند sample-law: [2001-01-01,2010-06-01) [2010-06-01,2015-01-01) شکاف [2018-01-01,∞)
    const cite = (article: string, subpart: CitationRef["subpart"] = null): CitationRef => ({ documentId: "sample-law", article, subpart });
    const table: ReadonlyArray<readonly [string, string, string]> = [
      ["1", "1800-01-01", "not-yet:2001-01-01"],
      ["1", "2000-12-31", "not-yet:2001-01-01"],
      ["1", "2001-01-01", "found:2001-01-01"],
      ["1", "2010-05-31", "found:2001-01-01"],
      ["1", "2010-06-01", "found:2010-06-01"],
      ["1", "2014-12-31", "found:2010-06-01"],
      ["1", "2015-01-01", "gap:2015-01-01..2018-01-01"],
      ["1", "2017-12-31", "gap:2015-01-01..2018-01-01"],
      ["1", "2018-01-01", "found:2018-01-01"],
      ["1", "2200-12-31", "found:2018-01-01"],
      ["2 مکرر", "2012-04-30", "not-yet:2012-05-01"],
      ["2 مکرر", "2012-05-01", "found:2012-05-01"],
      ["۲ مکرر", "2012-05-01", "found:2012-05-01"], // رقم فارسی ≡ لاتین
      ["ماده ۱", "2018-01-01", "found:2018-01-01"],
      ["99", "2018-01-01", "unknown-article"],
    ];
    it.each(table)("ماده %s در %s ← %s", async (label, date, expected) => {
      const r = await ask(cite(label), date);
      expect(r.ok && brief(r.value)).toBe(expected);
    });
    it("سند نسخ‌شده: sample-single-act تا ۲۰۱۹-۱۲-۳۱ معتبر و از ۲۰۲۰-۰۱-۰۱ نه", async () => {
      const at = async (d: string) => {
        const r = await ask({ documentId: "sample-single-act", article: "واحده", subpart: null }, d);
        return r.ok ? brief(r.value) : r.error.code;
      };
      expect(await at("2019-12-31")).toBe("found:2005-01-01");
      expect(await at("2020-01-01")).toBe("no-longer:2020-01-01");
      expect(await at("2004-12-31")).toBe("not-yet:2005-01-01");
    });
    it("سند ناشناخته و تبصره: unknown-document، unknown-subpart، found با تبصره", async () => {
      expect((await ask({ documentId: "nope", article: "1", subpart: null }, "2020-01-01")).ok && true).toBe(true);
      const unk = await ask({ documentId: "nope", article: "1", subpart: null }, "2020-01-01");
      expect(unk.ok && unk.value.status).toBe("unknown-document");
      const sub = await ask({ documentId: "sample-law", article: "2", subpart: { kind: "clause", label: "الف" } }, "2020-01-01");
      expect(sub.ok && brief(sub.value)).toBe("found:2001-01-01+clauseالف");
      const missing = await ask({ documentId: "sample-law", article: "2", subpart: { kind: "clause", label: "ج" } }, "2020-01-01");
      expect(missing.ok && brief(missing.value)).toBe("unknown-subpart@2001-01-01");
      // تبصرهٔ نسخهٔ دوم در نسخهٔ سوم نیست
      const v2 = await ask({ documentId: "sample-law", article: "1", subpart: { kind: "note", label: "1" } }, "2012-01-01");
      expect(v2.ok && brief(v2.value)).toBe("found:2010-06-01+note1");
      const v3 = await ask({ documentId: "sample-law", article: "1", subpart: { kind: "note", label: "1" } }, "2019-01-01");
      expect(v3.ok && brief(v3.value)).toBe("unknown-subpart@2018-01-01");
    });
    it("verified فقط از وضعیت بازبینیِ همان نسخه می‌آید", async () => {
      const verified = await ask({ documentId: "sample-law", article: "1", subpart: null }, "2005-01-01"); // نسخهٔ اول: تأییدشده
      const pending = await ask({ documentId: "sample-law", article: "1", subpart: null }, "2012-01-01"); // نسخهٔ دوم: تأییدنشده
      expect(verified.ok && verified.value.status === "found" && verified.value.verified).toBe(true);
      expect(pending.ok && pending.value.status === "found" && pending.value.verified).toBe(false);
    });
  });

  describe("تفاضلی: پایگاه = موتور خالص", () => {
    it("resolveCitation روی همهٔ مواد و روزهای مرزی (هزاران بررسی) برابر است", async () => {
      const r = rng(777);
      const queries: Array<{ ref: CitationRef; date: string }> = [];
      for (const a of catalog) {
        const dates = new Set<string>(["1800-01-01", "2200-12-31"]);
        for (const e of a.edges) {
          dates.add(dayToIso(e - 1));
          dates.add(dayToIso(e));
        }
        for (let i = 0; i < 2; i++) dates.add(dayToIso(r.int(isoToDay("1999-01-01"), isoToDay("2030-01-01"))));
        for (const date of dates) {
          queries.push({ ref: { documentId: a.documentId, article: a.label, subpart: null }, date });
          const sub = a.subparts[0];
          if (sub) queries.push({ ref: { documentId: a.documentId, article: a.label, subpart: { kind: sub.kind as "note" | "clause", label: sub.label } }, date });
        }
        queries.push({ ref: { documentId: a.documentId, article: a.label, subpart: { kind: "clause", label: "ششششش" } }, date: dayToIso(a.edges[0] ?? 0) });
      }
      queries.push({ ref: { documentId: "no-such-doc", article: "1", subpart: null }, date: "2020-01-01" });
      queries.push({ ref: { documentId: "tq1000-d0", article: "12345", subpart: null }, date: "2020-01-01" });
      expect(queries.length).toBeGreaterThan(4000);

      const seen = new Map<string, number>();
      const bad: string[] = [];
      await inChunks(queries, 8, async (q) => {
        const [db, mem] = [await ask(q.ref, q.date), pure(q.ref, q.date)];
        if (!db.ok || !mem.ok) {
          bad.push(`خطا: ${JSON.stringify(q)} db=${JSON.stringify(db)} mem=${JSON.stringify(mem)}`);
          return;
        }
        const key = mem.value.status + (mem.value.status === "found" && mem.value.subpart ? "+subpart" : "");
        seen.set(key, (seen.get(key) ?? 0) + 1);
        try {
          expect(db.value).toEqual(mem.value);
        } catch {
          bad.push(`ناهمخوان: ${JSON.stringify(q)}\n  db : ${brief(db.value)}\n  mem: ${brief(mem.value)}`);
        }
      });
      expect(bad.slice(0, 5)).toEqual([]);
      // تست واقعاً همهٔ وضعیت‌ها را دیده است (وگرنه سبز بودنش بی‌معناست)
      for (const status of ["found", "found+subpart", "gap", "not-yet-in-force", "no-longer-in-force", "unknown-subpart", "unknown-article", "unknown-document"]) {
        expect(seen.get(status) ?? 0, `وضعیت دیده‌نشده: ${status}`).toBeGreaterThan(0);
      }
    }, 240_000);

    it("versionsInForceAt در ۲۵۰ روز برابر است (محتوا و ترتیب سند/ماده)", async () => {
      const dates = new Set<string>(["1800-01-01", "2200-12-31", "2010-06-01", "2015-01-01", "2018-01-01"]);
      for (let day = isoToDay("1999-06-01"); day < isoToDay("2031-01-01"); day += 47) dates.add(dayToIso(day));
      for (const a of catalog.slice(0, 60)) for (const e of a.edges) dates.add(dayToIso(e));
      const list = [...dates].slice(0, 250);
      expect(list.length).toBeGreaterThanOrEqual(200);
      let nonEmpty = 0;
      const bad: string[] = [];
      await inChunks(list, 6, async (date) => {
        const db = await kb.store.versionsInForceAt(date);
        const mem = versionsInForceAt(index, date);
        if (!db.ok || !mem.ok) return void bad.push(`خطا ${date}`);
        if (mem.value.length > 0) nonEmpty++;
        try {
          expect(db.value).toEqual(mem.value);
        } catch {
          bad.push(`ناهمخوان در ${date}: db=${db.value.length} mem=${mem.value.length}`);
        }
      });
      expect(bad.slice(0, 5)).toEqual([]);
      expect(nonEmpty).toBeGreaterThan(100);
    }, 240_000);
  });

  describe("ورودی نامعتبر: همان خطا و همان پیام موتور خالص", () => {
    const refOk: CitationRef = { documentId: "sample-law", article: "1", subpart: null };
    it("تاریخ‌های ناممکن", async () => {
      for (const date of ["2020-13-01", "2020-02-30", "2021-02-29", "1403-01-01", "1799-12-31", "2201-01-01", "", "2020-1-1", "20200101", "2020/01/01", " 2020-01-01", "2020-01-01 ", "۲۰۲۰-۰۱-۰۱", "2020-01-01T00:00:00Z"]) {
        const db = await ask(refOk, date);
        const mem = pure(refOk, date);
        expect(mem.ok, date).toBe(false);
        expect(db.ok, date).toBe(false);
        if (!db.ok && !mem.ok) {
          expect(db.error.code).toBe("INVALID_INPUT");
          expect(db.error.message).toBe(mem.error.message);
        }
      }
      for (const bad of [null, undefined, 20200101, {}, []] as unknown[]) {
        const r = await ask(refOk, bad as string);
        expect(r.ok).toBe(false);
        const v = await kb.store.versionsInForceAt(bad as string);
        expect(v.ok).toBe(false);
      }
      const v = await kb.store.versionsInForceAt("2020-02-30");
      expect(v.ok).toBe(false);
    });
    it("برچسب ماده و تبصره/بند نامعتبر", async () => {
      const cases: CitationRef[] = [
        { documentId: "sample-law", article: "abc", subpart: null },
        { documentId: "sample-law", article: "", subpart: null },
        { documentId: "sample-law", article: "0", subpart: null },
        { documentId: "sample-law", article: "100000", subpart: null },
        { documentId: "sample-law", article: "1 مکرر 1", subpart: null },
        { documentId: "sample-law", article: "1", subpart: { kind: "note", label: "x" } },
        { documentId: "sample-law", article: "1", subpart: { kind: "note", label: "0" } },
        { documentId: "sample-law", article: "1", subpart: { kind: "item" as "note", label: "1" } },
      ];
      for (const c of cases) {
        const db = await ask(c, "2020-01-01");
        const mem = pure(c, "2020-01-01");
        expect(mem.ok, JSON.stringify(c)).toBe(false);
        expect(db.ok, JSON.stringify(c)).toBe(false);
        if (!db.ok && !mem.ok) {
          expect(db.error.code).toBe("INVALID_INPUT");
          expect(db.error.message).toBe(mem.error.message);
        }
      }
      for (const bad of [null, undefined, "str", 5, { documentId: 5, article: "1", subpart: null }] as unknown[]) {
        const r = await ask(bad as CitationRef, "2020-01-01");
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
      }
    });
    it("شناسهٔ سند مخرب فقط «سند ناشناخته» است و جدول‌ها سالم می‌مانند (پارامتر پیوندی، نه الحاق)", async () => {
      const evil = ["x'; DROP TABLE legal_kb.document; --", `"; DROP SCHEMA "${kb.schema}" CASCADE; --`, "{{schema}}", "$1", "%", "' OR '1'='1", "", "x".repeat(10_000), "سند-فارسی", "a\u0000b".replace("\u0000", "")];
      for (const documentId of evil) {
        const r = await ask({ documentId, article: "1", subpart: null }, "2020-01-01");
        expect(r.ok && r.value.status, documentId.slice(0, 30)).toBe("unknown-document");
      }
      const s = await kb.store.stats();
      expect(s.ok && s.value.documents).toBeGreaterThan(40);
    });
  });

  describe("خواندن‌ها هرگز نمی‌نویسند", () => {
    it("تراکنش خواندن فقط‌خواندنی است: تلاش برای نوشتن در آن رد می‌شود", async () => {
      // نمونهٔ مستقیم: همان گزینه‌های تراکنشی که store استفاده می‌کند
      const db = kb.db;
      await expect(
        db.transaction(async (tx) => tx.execute((await import("drizzle-orm")).sql`DELETE FROM ${(await import("drizzle-orm")).sql.identifier(kb.schema)}.relation`), { isolationLevel: "repeatable read", accessMode: "read only" }),
      ).rejects.toBeTruthy();
      const s = await kb.store.stats();
      expect(s.ok && s.value.relations).toBeGreaterThan(0);
    });
  });
});

dbDescribe("legal-kb-store · دیده‌شدن اتمی (تصویر یکدست)", () => {
  it("خواننده‌ها در حین یک درج بزرگ یا هیچ‌چیز می‌بینند یا همه‌چیز (نه نیمه‌کاره)", async () => {
    const kb = await openTestKb();
    try {
      const docs = Array.from({ length: 120 }, (_, d) =>
        documentJson(`atomic-${d}`, Array.from({ length: 10 }, (_, a) => article(String(a + 1), [version("2000-01-01", "2010-01-01", `متن ${d}/${a}`), version("2010-01-01", null, `متن نو ${d}/${a}`)]))),
      );
      const insert = kb.store.insertCorpus(corpusJson(docs));
      const observed: number[] = [];
      let done = false;
      const reader = (async () => {
        while (!done) {
          const s = await kb.store.stats();
          if (s.ok) {
            // هر شمارشِ تصویر یکدست باید با نسبت‌های درج سازگار باشد
            expect(s.value.articles).toBe(s.value.documents * 10);
            expect(s.value.versions).toBe(s.value.documents * 20);
            observed.push(s.value.documents);
          }
        }
      })();
      const r = await insert;
      done = true;
      await reader;
      expect(r.ok).toBe(true);
      expect(observed.every((n) => n === 0 || n === 120), `شمارش‌های دیده‌شده: ${[...new Set(observed)].join(",")}`).toBe(true);
      const final = await kb.store.stats();
      expect(final.ok && final.value.documents).toBe(120);
    } finally {
      await kb.drop();
    }
  }, 120_000);
});
