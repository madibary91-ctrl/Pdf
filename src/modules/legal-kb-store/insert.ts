/**
 * درج Corpus در پایگاه (داخلی؛ از `store.insertCorpus` در دسترس است).
 *
 * اصل‌ها:
 *  - ورودی **همیشه** از `loadCorpus` می‌گذرد (حتی اگر نوعش `Corpus` باشد): شیء دست‌ساز هرگز دور نمی‌زند.
 *  - **فقط‌افزودنی و اتمی:** یا همهٔ رکوردها ثبت می‌شوند یا هیچ. شناسهٔ تکراری بازنویسی نمی‌شود (`ALREADY_EXISTS` با فهرست شناسه‌ها)؛
 *    متنِ تأییدشده بی‌صدا عوض نمی‌شود.
 *  - Corpus باید **خودبسنده** باشد (رابطه/رأی فقط به اسناد همان Corpus ارجاع دهند)؛ ارجاع به سندِ موجود در پایگاه بخش بعدی است.
 *  - ترتیب سندها/رابطه‌ها/رأی‌ها با ستون `seq` (ادامهٔ بیشینهٔ موجود، زیر قفل مشورتی) حفظ می‌شود.
 *  - داده با **یک پارامتر JSON** به‌ازای هر جدول می‌رود (`jsonb_to_recordset`)؛ نه الحاق رشته، نه سقف شمار پارامتر.
 */
import { sql, type SQL } from "drizzle-orm";
import { loadCorpus, parseArticleLabel, type Corpus, type NodeRef, type Provenance } from "@/modules/legal-kb-schema";
import { StoreAbort, toStoreError } from "./errors";
import { assertCurrent } from "./migrate";
import { tableRef } from "./naming";
import type { InsertReport, KbDatabase, KbExecutor, StoreResult } from "./types";

type Json = Record<string, unknown>;

const prov = (p: Provenance): Json => ({
  source_name: p.sourceName,
  source_url: p.sourceUrl,
  source_kind: p.sourceKind,
  retrieved_on: p.retrievedOn,
  review_status: p.review.status,
  reviewed_by: p.review.reviewedBy,
  reviewed_on: p.review.reviewedOn,
});

/** ستون‌های منبع در سه شکل: فهرست ستون، فهرست انتخاب و تعریف recordset (ثابت‌های درون کد). */
const PROV_COLS = "source_name, source_url, source_kind, retrieved_on, review_status, reviewed_by, reviewed_on";
const PROV_SEL = "t.source_name, t.source_url, t.source_kind, t.retrieved_on, t.review_status, t.reviewed_by, t.reviewed_on";
const PROV_REC = "source_name text, source_url text, source_kind text, retrieved_on date, review_status text, reviewed_by text, reviewed_on date";

function articleNumbers(label: string): { number: number; repeat: number } {
  const r = parseArticleLabel(label);
  // پس از loadCorpus برچسب همیشه معتبر است؛ این شاخه فقط پوشش «ناممکن» است و به‌جای حدس، می‌ایستد.
  if (!r.ok) throw new StoreAbort({ code: "INVALID_INPUT", message: `برچسب ماده «${label}» نامعتبر است.` });
  return r.value.kind === "single" ? { number: 0, repeat: 0 } : { number: r.value.number, repeat: r.value.repeat };
}

export type FlatCorpus = Readonly<{
  documents: readonly Json[];
  articles: readonly Json[];
  versions: readonly Json[];
  subparts: readonly Json[];
  relations: readonly Json[];
  rulings: readonly Json[];
  cites: readonly Json[];
}>;

/** Corpus (معتبر) → ردیف‌های تخت هر جدول. خالص و قطعی؛ تست واحد دارد. */
export function flattenCorpus(corpus: Corpus): FlatCorpus {
  const documents: Json[] = [];
  const articles: Json[] = [];
  const versions: Json[] = [];
  const subparts: Json[] = [];
  const relations: Json[] = [];
  const rulings: Json[] = [];
  const cites: Json[] = [];
  const node = (n: NodeRef, prefix: "from" | "to"): Json => ({ [`${prefix}_document_id`]: n.documentId, [`${prefix}_article`]: n.article });

  corpus.documents.forEach((d, idx) => {
    documents.push({ idx, id: d.id, kind: d.kind, title: d.title, short_title: d.shortTitle, enacted_on: d.enactedOn, ...prov(d.provenance) });
    for (const a of d.articles) {
      const n = articleNumbers(a.label);
      articles.push({ document_id: d.id, label: a.label, article_number: n.number, article_repeat: n.repeat });
      for (const v of a.versions) {
        versions.push({ document_id: d.id, article_label: a.label, valid_from: v.validFrom, valid_to: v.validTo, body: v.text, ...prov(v.provenance) });
        v.subparts.forEach((s, ordinal) => {
          subparts.push({ document_id: d.id, article_label: a.label, valid_from: v.validFrom, ordinal, kind: s.kind, label: s.label, body: s.text });
        });
      }
    }
  });
  corpus.relations.forEach((r, idx) => {
    relations.push({ idx, type: r.type, ...node(r.from, "from"), ...node(r.to, "to"), effective_from: r.effectiveFrom, note: r.note, ...prov(r.provenance) });
  });
  corpus.rulings.forEach((g, idx) => {
    rulings.push({ idx, id: g.id, kind: g.kind, number: g.number, issuer: g.issuer, issued_on: g.issuedOn, title: g.title, body: g.text, ...prov(g.provenance) });
    g.cites.forEach((c, ordinal) => cites.push({ ruling_id: g.id, ordinal, document_id: c.documentId, article_label: c.article }));
  });
  return { documents, articles, versions, subparts, relations, rulings, cites };
}

/** `INSERT … SELECT … FROM jsonb_to_recordset` که شمار ردیف‌های واقعاً درج‌شده را برمی‌گرداند. */
async function insertRows(ex: KbExecutor, rows: readonly Json[], build: (json: string) => SQL): Promise<number> {
  if (rows.length === 0) return 0;
  const res = await ex.execute(build(JSON.stringify(rows)));
  const n = res.rows[0]?.["n"];
  if (n !== rows.length) {
    // ناممکن در حالت عادی؛ اگر رخ دهد تراکنش برمی‌گردد تا «درج نیمه‌کاره» هرگز نماند.
    throw new StoreAbort({ code: "DB_ERROR", message: `شمار ردیف درج‌شده (${String(n)}) با انتظار (${rows.length}) نمی‌خواند.` });
  }
  return rows.length;
}

async function existingIds(ex: KbExecutor, schema: string, table: "document" | "ruling", ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const res = await ex.execute(
    sql`SELECT id FROM ${tableRef(schema, table)} WHERE id IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)) ORDER BY id LIMIT 20`,
  );
  return res.rows.map((r) => String(r["id"]));
}

/** درج فقط‌افزودنی: سند یا رأیی با شناسهٔ موجود ⇒ `ALREADY_EXISTS` و هیچ‌چیز نوشته نمی‌شود (بازنویسی بی‌صدا ممنوع). */
export async function assertNoClashes(tx: KbExecutor, schema: string, corpus: Corpus): Promise<void> {
  const clashes = [
    ...(await existingIds(tx, schema, "document", corpus.documents.map((d) => d.id))).map((id) => `document:${id}`),
    ...(await existingIds(tx, schema, "ruling", corpus.rulings.map((g) => g.id))).map((id) => `ruling:${id}`),
  ];
  if (clashes.length > 0) {
    throw new StoreAbort({
      code: "ALREADY_EXISTS",
      message: `درج فقط‌افزودنی است و رکورد زیر از قبل هست؛ چیزی ذخیره نشد: ${clashes.join("، ")}`,
      conflicts: clashes,
    });
  }
}

/** ردیف‌های تخت را (بدون هیچ بررسی دیگری) درج می‌کند؛ باید داخل تراکنشِ دارای قفل نوشتن و پس از `assertCurrent` صدا زده شود. */
export async function insertFlat(tx: KbExecutor, schema: string, flat: FlatCorpus): Promise<InsertReport> {
  const q = (t: Parameters<typeof tableRef>[1]) => tableRef(schema, t);
  const documents = await insertRows(
    tx,
    flat.documents,
    (json) => sql`WITH ins AS (
      INSERT INTO ${q("document")} (seq, id, kind, title, short_title, enacted_on, ${sql.raw(PROV_COLS)})
      SELECT (SELECT coalesce(max(seq), 0) FROM ${q("document")}) + t.idx + 1, t.id, t.kind, t.title, t.short_title, t.enacted_on, ${sql.raw(PROV_SEL)}
      FROM jsonb_to_recordset(${json}::jsonb) AS t(idx integer, id text, kind text, title text, short_title text, enacted_on date, ${sql.raw(PROV_REC)})
      ORDER BY t.idx
      RETURNING 1) SELECT count(*)::integer AS n FROM ins`,
  );
  const articles = await insertRows(
    tx,
    flat.articles,
    (json) => sql`WITH ins AS (
      INSERT INTO ${q("article")} (document_id, label, article_number, article_repeat)
      SELECT t.document_id, t.label, t.article_number, t.article_repeat
      FROM jsonb_to_recordset(${json}::jsonb) AS t(document_id text, label text, article_number integer, article_repeat integer)
      RETURNING 1) SELECT count(*)::integer AS n FROM ins`,
  );
  const versions = await insertRows(
    tx,
    flat.versions,
    (json) => sql`WITH ins AS (
      INSERT INTO ${q("article_version")} (document_id, article_label, valid_from, valid_to, body, ${sql.raw(PROV_COLS)})
      SELECT t.document_id, t.article_label, t.valid_from, t.valid_to, t.body, ${sql.raw(PROV_SEL)}
      FROM jsonb_to_recordset(${json}::jsonb) AS t(document_id text, article_label text, valid_from date, valid_to date, body text, ${sql.raw(PROV_REC)})
      RETURNING 1) SELECT count(*)::integer AS n FROM ins`,
  );
  const subparts = await insertRows(
    tx,
    flat.subparts,
    (json) => sql`WITH ins AS (
      INSERT INTO ${q("article_subpart")} (document_id, article_label, valid_from, ordinal, kind, label, body)
      SELECT t.document_id, t.article_label, t.valid_from, t.ordinal, t.kind, t.label, t.body
      FROM jsonb_to_recordset(${json}::jsonb) AS t(document_id text, article_label text, valid_from date, ordinal integer, kind text, label text, body text)
      RETURNING 1) SELECT count(*)::integer AS n FROM ins`,
  );
  const relations = await insertRows(
    tx,
    flat.relations,
    (json) => sql`WITH ins AS (
      INSERT INTO ${q("relation")} (seq, type, from_document_id, from_article, to_document_id, to_article, effective_from, note, ${sql.raw(PROV_COLS)})
      SELECT (SELECT coalesce(max(seq), 0) FROM ${q("relation")}) + t.idx + 1, t.type, t.from_document_id, t.from_article, t.to_document_id, t.to_article,
             t.effective_from, t.note, ${sql.raw(PROV_SEL)}
      FROM jsonb_to_recordset(${json}::jsonb) AS t(idx integer, type text, from_document_id text, from_article text, to_document_id text, to_article text,
                                                   effective_from date, note text, ${sql.raw(PROV_REC)})
      ORDER BY t.idx
      RETURNING 1) SELECT count(*)::integer AS n FROM ins`,
  );
  const rulings = await insertRows(
    tx,
    flat.rulings,
    (json) => sql`WITH ins AS (
      INSERT INTO ${q("ruling")} (seq, id, kind, number, issuer, issued_on, title, body, ${sql.raw(PROV_COLS)})
      SELECT (SELECT coalesce(max(seq), 0) FROM ${q("ruling")}) + t.idx + 1, t.id, t.kind, t.number, t.issuer, t.issued_on, t.title, t.body, ${sql.raw(PROV_SEL)}
      FROM jsonb_to_recordset(${json}::jsonb) AS t(idx integer, id text, kind text, number text, issuer text, issued_on date, title text, body text, ${sql.raw(PROV_REC)})
      ORDER BY t.idx
      RETURNING 1) SELECT count(*)::integer AS n FROM ins`,
  );
  const citations = await insertRows(
    tx,
    flat.cites,
    (json) => sql`WITH ins AS (
      INSERT INTO ${q("ruling_cite")} (ruling_id, ordinal, document_id, article_label)
      SELECT t.ruling_id, t.ordinal, t.document_id, t.article_label
      FROM jsonb_to_recordset(${json}::jsonb) AS t(ruling_id text, ordinal integer, document_id text, article_label text)
      RETURNING 1) SELECT count(*)::integer AS n FROM ins`,
  );
  return { documents, articles, versions, subparts, relations, rulings, citations } satisfies InsertReport;
}

export async function insertCorpus(db: KbDatabase, schema: string, input: unknown): Promise<StoreResult<InsertReport>> {
  const loaded = loadCorpus(input);
  if (!loaded.ok) {
    return { ok: false, error: { code: "INVALID_CORPUS", message: `Corpus نامعتبر است (${loaded.error.length} مسئله)؛ چیزی ذخیره نشد.`, issues: loaded.error } };
  }
  const flat = flattenCorpus(loaded.value);

  try {
    const report = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`legal-kb-store:write:${schema}`}, 0))`);
      await assertCurrent(tx, schema);

      await assertNoClashes(tx, schema, loaded.value);
      return insertFlat(tx, schema, flat);
    });
    return { ok: true, value: report };
  } catch (e) {
    return { ok: false, error: toStoreError(e) };
  }
}
