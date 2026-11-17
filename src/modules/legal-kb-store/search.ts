/**
 * جست‌وجوی کلمه‌ای (بخش ۴ب‑۳، ADR-0009) — داخلی؛ از `createKbStore(...)` در دسترس است.
 *
 * اصل طراحی: **نمایه فقط «مکان‌یاب» است، نه منبع حقیقت.** هر چیزی که به حقوقدان/کاربر می‌رسد از جدول‌های اصلی خوانده می‌شود:
 *   • متن، تبصره‌ها و منبع/وضعیت تأیید ← `article_version`/`article_subpart` (نه نمایه)؛
 *   • اعتبار در تاریخ ← `valid_during @> asOf` روی جدول اصلی؛  • فیلتر «فقط تأییدشده» ← `review_status` جدول اصلی.
 * پس تأیید/پس‌گرفتنِ تأیید بی‌درنگ در جست‌وجو اثر می‌کند (بدون بازسازی)، و نمایهٔ کهنه فقط **بازیابی را کم می‌کند، نه نتیجهٔ غلط می‌دهد:**
 * برای هر نتیجه هشِ محتوای جدول اصلی با هشِ ثبت‌شده در نمایه (و اثر انگشتِ قاعدهٔ نرمال‌سازی) مقایسه می‌شود؛ ناهمخوان ⇒ حذف + شمارش در `staleSkipped`.
 *
 * هیچ‌یک از مسیرهای نوشتنِ موجود (`insertCorpus`، `insertIncremental`، `correctVersion`، …) نمایه را لمس نمی‌کنند؛ به‌روزرسانی با
 * `reindexSearch()` (ایدمپوتنت، افزایشی) و کنترلش با `searchStatus()` است.
 */
import { sql } from "drizzle-orm";
import type { Subpart } from "@/modules/legal-kb-schema";
import { CorruptRowError, StoreAbort, toStoreError } from "./errors";
import { assertCurrent } from "./migrate";
import { searchTableRef, tableRef } from "./naming";
import { assertSearchCurrent } from "./search-migrate";
import { SEARCH_MIGRATIONS } from "./search-migrations";
import type { ReindexReport, SearchHit, SearchResult, SearchStatus } from "./search-types";
import { buildIndexRow, parseSearchInput, referenceMatches, searchKeyFingerprint } from "./search-text";
import { DATE_OUT, int, isoDate, isoDateOrNull, provenanceSelect, readProvenance, readSubpart, str, strOrNull, type Row } from "./rows";
import type { KbDatabase, KbExecutor, StoreResult } from "./types";

const REPEATABLE_READ_ONLY = { isolationLevel: "repeatable read", accessMode: "read only" } as const;
const BATCH = 200;

/** `jsonb_agg` تبصره/بندها به ترتیب `ordinal` (در همان دستور SELECT ⇒ یک عکس لحظه‌ای با متن نسخه). */
const SUBPARTS_JSON = (kb: ReturnType<typeof tableRef>) => sql`coalesce((
  SELECT jsonb_agg(jsonb_build_object('kind', s.kind, 'label', s.label, 'body', s.body) ORDER BY s.ordinal)
  FROM ${kb} s
  WHERE s.document_id = v.document_id AND s.article_label = v.article_label AND s.valid_from = v.valid_from
), '[]'::jsonb) AS subparts`;

function readSubparts(r: Row): Subpart[] {
  const v = r["subparts"];
  if (!Array.isArray(v)) throw new CorruptRowError("ستون subparts");
  return v.map((x) => {
    if (typeof x !== "object" || x === null) throw new CorruptRowError("عضو subparts");
    return readSubpart(x as Row);
  });
}

type VersionKey = Readonly<{ documentId: string; article: string; validFrom: string }>;
const keyOf = (k: VersionKey): string => JSON.stringify([k.documentId, k.article, k.validFrom]);

/** همهٔ نسخه‌ها به ترتیب کلید طبیعی، دسته‌دسته (keyset)، همراه با هش/اثر انگشتِ نمایهٔ فعلی (اگر باشد). */
async function* scanVersions(
  ex: KbExecutor,
  schema: string,
): AsyncGenerator<ReadonlyArray<Readonly<{ key: VersionKey; text: string; subparts: Subpart[]; indexedHash: string | null; indexedFp: string | null }>>> {
  let cursor: VersionKey | null = null;
  for (;;) {
    const after = cursor === null ? sql`TRUE` : sql`(v.document_id, v.article_label, v.valid_from) > (${cursor.documentId}, ${cursor.article}, ${cursor.validFrom}::date)`;
    const rows: Row[] = (
      await ex.execute(sql`SELECT v.document_id, v.article_label, ${DATE_OUT("v.valid_from", "valid_from")}, v.body,
          ${SUBPARTS_JSON(tableRef(schema, "article_subpart"))},
          x.content_hash AS indexed_hash, x.key_fingerprint AS indexed_fp
        FROM ${tableRef(schema, "article_version")} v
        LEFT JOIN ${searchTableRef(schema, "article_search")} x
          ON x.document_id = v.document_id AND x.article_label = v.article_label AND x.valid_from = v.valid_from
        WHERE ${after}
        ORDER BY v.document_id, v.article_label, v.valid_from
        LIMIT ${BATCH}`)
    ).rows;
    if (rows.length === 0) return;
    const batch = rows.map((r) => ({
      key: { documentId: str(r, "document_id"), article: str(r, "article_label"), validFrom: isoDate(r, "valid_from") },
      text: str(r, "body"),
      subparts: readSubparts(r),
      indexedHash: strOrNull(r, "indexed_hash"),
      indexedFp: strOrNull(r, "indexed_fp"),
    }));
    yield batch;
    const last = batch[batch.length - 1];
    if (rows.length < BATCH || last === undefined) return;
    cursor = last.key;
  }
}

async function count(ex: KbExecutor, query: ReturnType<typeof sql>): Promise<number> {
  const r = (await ex.execute(query)).rows[0];
  if (r === undefined) throw new CorruptRowError("شمارش");
  return int(r, "n");
}

export async function reindexSearch(db: KbDatabase, schema: string): Promise<StoreResult<ReindexReport>> {
  try {
    const report = await db.transaction(async (tx) => {
      await assertCurrent(tx, schema);
      await assertSearchCurrent(tx, schema);
      // یک بازسازِ هم‌زمان در هر شِما (جلوگیری از رقابت upsert)
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`legal-kb-store:search-reindex:${schema}`}, 0))`);
      const fp = searchKeyFingerprint();
      let indexed = 0;
      let updated = 0;
      let unchanged = 0;
      for await (const batch of scanVersions(tx, schema)) {
        const upserts: Array<Record<string, unknown>> = [];
        for (const v of batch) {
          const row = buildIndexRow({ text: v.text, subparts: v.subparts });
          if (v.indexedHash === row.contentHash && v.indexedFp === fp) {
            unchanged++;
            continue;
          }
          if (v.indexedHash === null) indexed++;
          else updated++;
          upserts.push({ document_id: v.key.documentId, article_label: v.key.article, valid_from: v.key.validFrom, content_hash: row.contentHash, key_fingerprint: row.keyFingerprint, tokens: row.tokens });
        }
        if (upserts.length === 0) continue;
        const res = await tx.execute(sql`WITH up AS (
            INSERT INTO ${searchTableRef(schema, "article_search")} (document_id, article_label, valid_from, content_hash, key_fingerprint, tokens)
            SELECT t.document_id, t.article_label, t.valid_from, t.content_hash, t.key_fingerprint, ARRAY(SELECT jsonb_array_elements_text(t.tokens))
            FROM jsonb_to_recordset(${JSON.stringify(upserts)}::jsonb) AS t(document_id text, article_label text, valid_from date, content_hash text, key_fingerprint text, tokens jsonb)
            ON CONFLICT (document_id, article_label, valid_from) DO UPDATE
              SET content_hash = EXCLUDED.content_hash, key_fingerprint = EXCLUDED.key_fingerprint, tokens = EXCLUDED.tokens, indexed_at = now()
            RETURNING 1) SELECT count(*)::integer AS n FROM up`);
        const n = res.rows[0]?.["n"];
        if (n !== upserts.length) throw new StoreAbort({ code: "DB_ERROR", message: `شمار ردیف نمایهٔ نوشته‌شده (${String(n)}) با انتظار (${upserts.length}) نمی‌خواند.` });
      }
      const removed = await count(
        tx,
        sql`WITH del AS (
            DELETE FROM ${searchTableRef(schema, "article_search")} x
            WHERE NOT EXISTS (SELECT 1 FROM ${tableRef(schema, "article_version")} v
              WHERE v.document_id = x.document_id AND v.article_label = x.article_label AND v.valid_from = x.valid_from)
            RETURNING 1) SELECT count(*)::integer AS n FROM del`,
      );
      const totalVersions = indexed + updated + unchanged;
      return { indexed, updated, unchanged, removed, totalVersions } satisfies ReindexReport;
    });
    return { ok: true, value: report };
  } catch (e) {
    return { ok: false, error: toStoreError(e) };
  }
}

export async function searchStatus(db: KbDatabase, schema: string): Promise<StoreResult<SearchStatus>> {
  try {
    const status = await db.transaction(async (tx) => {
      await assertCurrent(tx, schema);
      await assertSearchCurrent(tx, schema);
      const fp = searchKeyFingerprint();
      let totalVersions = 0;
      let missing = 0;
      let stale = 0;
      for await (const batch of scanVersions(tx, schema)) {
        for (const v of batch) {
          totalVersions++;
          if (v.indexedHash === null) {
            missing++;
            continue;
          }
          const row = buildIndexRow({ text: v.text, subparts: v.subparts });
          if (v.indexedHash !== row.contentHash || v.indexedFp !== fp) stale++;
        }
      }
      const indexed = await count(tx, sql`SELECT count(*)::integer AS n FROM ${searchTableRef(schema, "article_search")}`);
      const orphans = await count(
        tx,
        sql`SELECT count(*)::integer AS n FROM ${searchTableRef(schema, "article_search")} x
            WHERE NOT EXISTS (SELECT 1 FROM ${tableRef(schema, "article_version")} v
              WHERE v.document_id = x.document_id AND v.article_label = x.article_label AND v.valid_from = x.valid_from)`,
      );
      return {
        totalVersions,
        indexed,
        missing,
        stale,
        orphans,
        upToDate: missing === 0 && stale === 0 && orphans === 0,
        keyFingerprint: fp,
        migrations: SEARCH_MIGRATIONS.map((m) => m.name),
      } satisfies SearchStatus;
    }, REPEATABLE_READ_ONLY);
    return { ok: true, value: status };
  } catch (e) {
    return { ok: false, error: toStoreError(e) };
  }
}

export async function searchArticles(db: KbDatabase, schema: string, input: unknown): Promise<StoreResult<SearchResult>> {
  const parsed = parseSearchInput(input);
  if (!parsed.ok) return parsed;
  const q = parsed.value;
  try {
    const result = await db.transaction(async (tx): Promise<SearchResult> => {
      await assertCurrent(tx, schema);
      await assertSearchCurrent(tx, schema);
      const fp = searchKeyFingerprint();
      const tokenArray = sql`ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(q.tokens)}::jsonb))`;
      const rows: Row[] = (
        await tx.execute(sql`SELECT x.document_id, x.article_label, ${DATE_OUT("v.valid_from", "valid_from")}, ${DATE_OUT("v.valid_to", "valid_to")}, v.body,
            ${provenanceSelect("v")}, ${SUBPARTS_JSON(tableRef(schema, "article_subpart"))},
            d.title AS document_title, x.content_hash AS indexed_hash, x.key_fingerprint AS indexed_fp,
            (SELECT count(*) FROM unnest(x.tokens) AS u(tok) WHERE tok = ANY(${tokenArray}))::integer AS matches
          FROM ${searchTableRef(schema, "article_search")} x
          JOIN ${tableRef(schema, "article_version")} v
            ON v.document_id = x.document_id AND v.article_label = x.article_label AND v.valid_from = x.valid_from
          JOIN ${tableRef(schema, "article")} a ON a.document_id = v.document_id AND a.label = v.article_label
          JOIN ${tableRef(schema, "document")} d ON d.id = v.document_id
          WHERE x.tokens @> ${tokenArray}
            AND v.valid_during @> ${q.asOf}::date
            AND (${q.verifiedOnly}::boolean = false OR v.review_status = 'legally-verified')
            AND (${q.documentId}::text IS NULL OR v.document_id = ${q.documentId}::text)
          ORDER BY matches DESC, d.seq, a.article_number, a.article_repeat
          LIMIT ${q.limit + 1}`)
      ).rows;

      const hasMore = rows.length > q.limit;
      const hits: SearchHit[] = [];
      let staleSkipped = 0;
      for (const r of rows.slice(0, q.limit)) {
        const subparts = readSubparts(r);
        const text = str(r, "body");
        // «مثبتِ کاذب ممکن نیست»: حتی با نمایهٔ خراب، فقط نتیجه‌ای برمی‌گردد که **متن اصلی** واقعاً همهٔ واژه‌های پرسش را دارد
        // و امتیازش با نمایه یکی است. هشِ ثبت‌شده و اثر انگشت هم باید بخواند (کهنگی). ناهمخوانی ⇒ حذف و شمارش.
        const actual = buildIndexRow({ text, subparts });
        const truth = referenceMatches(q.tokens, actual);
        if (actual.contentHash !== str(r, "indexed_hash") || fp !== str(r, "indexed_fp") || truth === null || truth !== int(r, "matches")) {
          staleSkipped++;
          continue;
        }
        const provenance = readProvenance(r);
        hits.push({
          ref: { documentId: str(r, "document_id"), article: str(r, "article_label"), validFrom: isoDate(r, "valid_from") },
          documentTitle: str(r, "document_title"),
          validTo: isoDateOrNull(r, "valid_to"),
          text,
          subparts,
          provenance,
          verified: provenance.review.status === "legally-verified",
          contentHash: actual.contentHash,
          matches: truth,
        });
      }
      return { tokens: q.tokens, asOf: q.asOf, verifiedOnly: q.verifiedOnly, hits, hasMore, staleSkipped };
    }, REPEATABLE_READ_ONLY);
    return { ok: true, value: result };
  } catch (e) {
    return { ok: false, error: toStoreError(e) };
  }
}
