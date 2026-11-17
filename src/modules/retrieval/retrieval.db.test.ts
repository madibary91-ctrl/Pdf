/**
 * retrieval روی PostgreSQL واقعی (از رابط عمومی store). تأییدشده/معتبر-در-تاریخ همیشه از جدول اصلی است؛ بازیابی فقط رتبه می‌دهد.
 * و سازگاریِ ذخیره‌گاه ساختگیِ تست‌های خالص با store واقعی را می‌سنجد (تا آن مدل خودش خطا نباشد).
 */
import { afterEach, describe, expect, it } from "vitest";
import { fakeSearcher, type FakeArticle } from "./fake-searcher";
import { buildContext, lookupSource } from "./context";
import { retrieve } from "./retrieve";
import type { Retrieval } from "./types";
import { dbDescribe, openRetrievalKb, seedCorpus, type RetrievalTestKb, type SeedArticle } from "./test-db";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

const seed: SeedArticle[] = [
  {
    document: "law-a",
    label: "1",
    versions: [
      { validFrom: "2001-01-01", validTo: "2010-01-01", text: "فروشنده مکلف است مبیع را تحویل دهد.", verified: true, subparts: [{ kind: "note", label: "1", text: "تحویل مبیع در محل عقد انجام می‌شود." }] },
      { validFrom: "2010-01-01", validTo: null, text: "فروشنده مکلف است مبیع را در مهلت مقرر تحویل دهد. مبیع باید سالم باشد.", verified: false },
    ],
  },
  { document: "law-a", label: "2", versions: [{ validFrom: "2001-01-01", validTo: null, text: "خریدار مکلف است ثمن را بپردازد. ثمن ثمن", verified: true }] },
  { document: "law-a", label: "10 مکرر", versions: [{ validFrom: "2005-05-05", validTo: null, text: "مادهٔ ۱۰ مکرر: كتاب‌ها و می‌خواهم ۱۰۰ برگ", verified: true }] },
  { document: "law-b", label: "واحده", versions: [{ validFrom: "2015-01-01", validTo: null, text: "تحویل مبیع و پرداخت ثمن در این ماده", verified: true }] },
];

dbDescribe("retrieval · روی store واقعی", () => {
  const opened: RetrievalTestKb[] = [];
  afterEach(async () => {
    for (const kb of opened.splice(0)) await kb.drop();
  });
  const ready = async (articles: readonly SeedArticle[] = seed): Promise<RetrievalTestKb> => {
    const kb = await openRetrievalKb();
    opened.push(kb);
    must(await kb.store.insertCorpus(seedCorpus(articles)));
    must(await kb.store.reindexSearch());
    return kb;
  };
  const go = async (kb: RetrievalTestKb, req: Record<string, unknown>): Promise<Retrieval> => must(await retrieve(kb.store, req));
  const refs = (r: Retrieval): string[] => r.passages.map((p) => `${p.ref.documentId}/${p.ref.article}@${p.ref.validFrom}`);

  it("پرسش طبیعی (با واژهٔ ربطی) نسخهٔ معتبر در تاریخ را برمی‌گرداند؛ پوشش و ارجاع ساختاریافته درست است", async () => {
    const kb = await ready();
    const r = await go(kb, { question: "آیا فروشنده مکلف به تحویل مبیع است؟", asOf: "2008-01-01" });
    expect(r.plan.tokens).toEqual(["فروشنده", "مکلف", "تحویل", "مبیع"]);
    expect(refs(r)).toEqual(["law-a/1@2001-01-01"]);
    expect(r.passages[0]).toMatchObject({ coverage: 1, verified: true, citation: { documentId: "law-a", article: "1", subpart: null } });
    expect(r.incomplete).toBe(false);
  });

  it("مرز نیم‌باز زمانی روی پایگاه واقعی: روز آغاز نسخهٔ بعد، نسخهٔ بعد (تأییدنشده) است", async () => {
    const kb = await ready();
    expect(refs(await go(kb, { question: "مبیع تحویل", asOf: "2009-12-31" }))).toEqual(["law-a/1@2001-01-01"]);
    const onBoundary = await go(kb, { question: "مبیع تحویل", asOf: "2010-01-01" });
    expect(refs(onBoundary)).not.toContain("law-a/1@2001-01-01");
    expect(refs(onBoundary)).not.toContain("law-a/1@2010-01-01"); // تأییدنشده؛ پیش‌فرض فقط‌تأییدشده
    const loose = await go(kb, { question: "مبیع تحویل", asOf: "2010-01-01", verifiedOnly: false });
    expect(refs(loose)).toContain("law-a/1@2010-01-01");
    expect(loose.passages.find((p) => p.ref.validFrom === "2010-01-01")?.verified).toBe(false);
  });

  it("آرام‌سازی روی پایگاه واقعی: واژهٔ بی‌ربط AND کامل را خالی می‌کند ولی بند درست با coverage<1 می‌آید", async () => {
    const kb = await ready();
    const r = await go(kb, { question: "خریدار مکلف است ثمن را بپردازد یا شرط خیار؟", asOf: "2024-01-01" });
    expect(r.relaxed).toBe(true);
    const top = r.passages[0];
    expect(top?.ref.article).toBe("2");
    expect(top?.coverage).toBeLessThan(1);
    expect([...(top?.missingTerms ?? [])].sort()).toEqual(["خیار", "شرط"]);
  });

  it("اعداد و حروف عربی/فارسی در پرسش با متن یکی‌اند (ماده ۱۰ مکرر، «كتاب»)", async () => {
    const kb = await ready();
    expect(refs(await go(kb, { question: "ماده ۱۰ مکرر کتاب", asOf: "2024-01-01", minCoverage: 1 }))).toEqual(["law-a/10 مکرر@2005-05-05"]);
    expect(refs(await go(kb, { question: "ماده ١٠ مکرر كتاب", asOf: "2024-01-01", minCoverage: 1 }))).toEqual(["law-a/10 مکرر@2005-05-05"]);
  });

  it("documentId محدود می‌کند؛ limit و hasMore درست‌اند", async () => {
    const kb = await ready();
    const only = await go(kb, { question: "مبیع", asOf: "2024-01-01", documentId: "law-b", verifiedOnly: false });
    expect(refs(only)).toEqual(["law-b/واحده@2015-01-01"]);
    const lim = await go(kb, { question: "مبیع", asOf: "2024-01-01", verifiedOnly: false, limit: 1 });
    expect(lim.passages).toHaveLength(1);
    expect(lim.hasMore).toBe(true);
  });

  it("نمایهٔ کهنه: staleSkipped شمرده و incomplete=true؛ پس از reindex درست می‌شود (متن کهنه هرگز برنمی‌گردد)", async () => {
    const kb = await ready();
    await kb.raw(`UPDATE {{schema}}.article_version SET body = $1 WHERE document_id = 'law-a' AND article_label = '2'`, ["خریدار مکلف است ثمن را بپردازد. متن اصلاح‌شده"]);
    const stale = await go(kb, { question: "خریدار ثمن", asOf: "2024-01-01", minCoverage: 1 });
    expect(stale.staleSkipped).toBeGreaterThan(0);
    expect(stale.incomplete).toBe(true);
    expect(refs(stale)).not.toContain("law-a/2@2001-01-01");
    must(await kb.store.reindexSearch());
    const fresh = await go(kb, { question: "خریدار ثمن", asOf: "2024-01-01", minCoverage: 1 });
    expect(fresh.incomplete).toBe(false);
    expect(fresh.passages[0]?.text).toContain("اصلاح‌شده");
  });

  it("نمایهٔ جست‌وجو مهاجرت نشده ⇒ STORE_ERROR با storeCode (نه نتیجهٔ خالیِ گمراه‌کننده)", async () => {
    const kb = await openRetrievalKb({ migrateSearch: false });
    opened.push(kb);
    const r = await retrieve(kb.store, { question: "ثمن", asOf: "2024-01-01" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("STORE_ERROR");
      expect(r.error.storeCode).toBeDefined();
    }
  });

  it("زمینهٔ مدل از نتیجهٔ واقعی ساخته می‌شود و شناسهٔ جعلی رد می‌شود", async () => {
    const kb = await ready();
    const r = await go(kb, { question: "مبیع ثمن تحویل پرداخت", asOf: "2024-01-01", minCoverage: 0.5 });
    const c = must(buildContext(r.passages));
    expect(c.sources.length).toBe(r.passages.length);
    expect(c.text).toContain("[S1]");
    expect(lookupSource(c, "S1")?.citation).toEqual(r.passages[0]?.citation);
    expect(lookupSource(c, "S99")).toBeNull();
  });

  it("تفاضلی: ذخیره‌گاه ساختگی ≡ store واقعی (مجموعه، ترتیب، فیلترها) روی ۶۰ پرسش تصادفی", async () => {
    const vocab = ["ثمن", "مبیع", "تحویل", "فروشنده", "خریدار", "كتاب", "مکلف", "پرداخت", "مهلت", "عقد", "سالم", "محل", "۱۰", "قرارداد"];
    let s = 12345;
    const next = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
    const fakes: FakeArticle[] = [];
    const arts: SeedArticle[] = [];
    for (let i = 1; i <= 24; i++) {
      const doc = pick(["law-a", "law-b"]);
      const text = Array.from({ length: 1 + Math.floor(next() * 8) }, () => pick(vocab)).join(" ");
      const from = next() < 0.3 ? "2010-01-01" : "2001-01-01";
      const to = from === "2001-01-01" && next() < 0.3 ? "2010-01-01" : null;
      const verified = next() > 0.25;
      fakes.push({ documentId: doc, article: String(i), validFrom: from, validTo: to, text, verified });
      arts.push({ document: doc, label: String(i), versions: [{ validFrom: from, validTo: to, text, verified }] });
    }
    const kb = await ready(arts);
    const fake = fakeSearcher(fakes);
    for (let i = 0; i < 60; i++) {
      const req = {
        question: Array.from({ length: 1 + Math.floor(next() * 5) }, () => pick(vocab)).join(" "),
        asOf: pick(["2005-05-05", "2010-01-01", "2024-01-01"]),
        verifiedOnly: next() > 0.3,
        limit: 100,
        minCoverage: pick([0.5, 1]),
      };
      const real = must(await retrieve(kb.store, req));
      const model = must(await retrieve(fake, req));
      const key = (r: Retrieval) => r.passages.map((p) => `${p.ref.documentId}/${p.ref.article}@${p.ref.validFrom}:${p.coverage}:${p.score}`);
      expect(key(real), JSON.stringify(req)).toEqual(key(model));
      expect(real.queriesRun).toBe(model.queriesRun);
    }
  });
});
