/**
 * نسخه‌بندی زمانی **در سمت پایگاه** (داخلی): «کدام متن در این تاریخ معتبر بود؟» با عملگر `@>` روی `valid_during` و ایندکس gist.
 *
 * قرارداد: خروجی با `resolveCitation`/`versionsInForceAt` ماژول `legal-kb-schema` **یکسان** است (تست تفاضلی روی هزاران
 * زنجیرهٔ تصادفی و همهٔ روزهای مرزی). اعتبارسنجی ورودی هم همان توابع آن ماژول است تا پیام و رفتار یکی باشد.
 * هیچ «حدسی» نیست: هر وضعیتی که پایگاه با مدل نخواند (مثلاً دو نسخهٔ هم‌زمان معتبر چون قید برداشته شده) `CORRUPT_DATA` است.
 */
import { sql } from "drizzle-orm";
import {
  canonicalArticleLabel,
  canonicalSubpartLabel,
  parseIsoDate,
  type ArticleVersion,
  type CitationRef,
  type InForceEntry,
  type IsoDate,
  type Subpart,
  type VersionLookup,
} from "@/modules/legal-kb-schema";
import { CorruptRowError, StoreAbort, toStoreError } from "./errors";
import { assertCurrent } from "./migrate";
import { tableRef } from "./naming";
import { DATE_OUT, int, isoDate, isoDateOrNull, provenanceSelect, readSubpart, readVersionRow, str, type Row } from "./rows";
import type { KbDatabase, KbExecutor, StoreResult } from "./types";

const REPEATABLE_READ_ONLY = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

const invalid = (message: string): StoreAbort => new StoreAbort({ code: "INVALID_INPUT", message });

export async function subpartsOf(ex: KbExecutor, schema: string, documentId: string, label: string, validFrom: IsoDate): Promise<Subpart[]> {
  const rows = (
    await ex.execute(
      sql`SELECT kind, label, body FROM ${tableRef(schema, "article_subpart")}
          WHERE document_id = ${documentId} AND article_label = ${label} AND valid_from = ${validFrom}::date
          ORDER BY ordinal`,
    )
  ).rows;
  return rows.map(readSubpart);
}

export async function resolveCitation(db: KbDatabase, schema: string, ref: CitationRef, onDate: IsoDate): Promise<StoreResult<VersionLookup>> {
  try {
    // ورودی: همان ترتیب و پیام‌های resolveCitation در legal-kb-schema
    const date = parseIsoDate(onDate);
    if (!date.ok) throw invalid(date.error.message);
    if (typeof ref !== "object" || ref === null || typeof ref.documentId !== "string") throw invalid("ارجاع نامعتبر است (documentId باید متن باشد).");
    const label = canonicalArticleLabel(ref.article);
    if (!label.ok) throw invalid(label.error.message);
    if (ref.subpart !== null && ref.subpart.kind !== "note" && ref.subpart.kind !== "clause") throw invalid("نوع تبصره/بند نامعتبر است.");
    const sub = ref.subpart === null ? null : canonicalSubpartLabel(ref.subpart.label);
    if (sub && !sub.ok) throw invalid(sub.error.message);

    const documentId = ref.documentId;
    const result = await db.transaction(async (tx): Promise<VersionLookup> => {
      await assertCurrent(tx, schema);

      const exists = (
        await tx.execute(sql`SELECT
          (SELECT count(*) FROM ${tableRef(schema, "document")} WHERE id = ${documentId})::integer AS docs,
          (SELECT count(*) FROM ${tableRef(schema, "article")} WHERE document_id = ${documentId} AND label = ${label.value})::integer AS arts`)
      ).rows[0] as Row;
      if (int(exists, "docs") === 0) return { status: "unknown-document" };
      if (int(exists, "arts") === 0) return { status: "unknown-article" };

      const hits = (
        await tx.execute(
          sql`SELECT ${DATE_OUT("valid_from", "valid_from")}, ${DATE_OUT("valid_to", "valid_to")}, body, ${provenanceSelect("")}
              FROM ${tableRef(schema, "article_version")}
              WHERE document_id = ${documentId} AND article_label = ${label.value} AND valid_during @> ${date.value}::date`,
        )
      ).rows;
      if (hits.length > 1) throw new CorruptRowError("دو نسخهٔ هم‌زمان معتبر برای یک ماده (قید نبود هم‌پوشانی برداشته شده؟)");

      const hit = hits[0];
      if (hit === undefined) {
        const edges = (
          await tx.execute(
            sql`(SELECT 'first' AS k, ${DATE_OUT("valid_from", "valid_from")}, ${DATE_OUT("valid_to", "valid_to")} FROM ${tableRef(schema, "article_version")}
                  WHERE document_id = ${documentId} AND article_label = ${label.value} ORDER BY valid_from ASC LIMIT 1)
                UNION ALL
                (SELECT 'prev', ${DATE_OUT("valid_from", "valid_from")}, ${DATE_OUT("valid_to", "valid_to")} FROM ${tableRef(schema, "article_version")}
                  WHERE document_id = ${documentId} AND article_label = ${label.value} AND valid_from < ${date.value}::date ORDER BY valid_from DESC LIMIT 1)
                UNION ALL
                (SELECT 'next', ${DATE_OUT("valid_from", "valid_from")}, ${DATE_OUT("valid_to", "valid_to")} FROM ${tableRef(schema, "article_version")}
                  WHERE document_id = ${documentId} AND article_label = ${label.value} AND valid_from > ${date.value}::date ORDER BY valid_from ASC LIMIT 1)`,
          )
        ).rows;
        const edge = (k: string) => edges.find((r) => r["k"] === k);
        const first = edge("first");
        if (first === undefined) throw new CorruptRowError("ماده‌ای بدون هیچ نسخه");
        const prev = edge("prev");
        const next = edge("next");
        if (prev === undefined) return { status: "not-yet-in-force", firstValidFrom: isoDate(first, "valid_from") };
        const previousValidTo = isoDateOrNull(prev, "valid_to");
        // نسخهٔ پیشین بی‌پایان و تاریخ بیرون از آن، ناممکن است؛ اگر دیده شود دادهٔ خراب است.
        if (previousValidTo === null) throw new CorruptRowError("نسخهٔ بی‌پایان که تاریخ را در بر نمی‌گیرد");
        if (next === undefined) return { status: "no-longer-in-force", lastValidTo: previousValidTo };
        return { status: "gap", previousValidTo, nextValidFrom: isoDate(next, "valid_from") };
      }

      const vFrom = isoDate(hit, "valid_from");
      const version: ArticleVersion = readVersionRow(hit, await subpartsOf(tx, schema, documentId, label.value, vFrom));
      let subpart: Subpart | null = null;
      if (ref.subpart !== null && sub && sub.ok) {
        subpart = version.subparts.find((s) => s.kind === ref.subpart?.kind && s.label === sub.value) ?? null;
        if (!subpart) return { status: "unknown-subpart", version };
      }
      return { status: "found", documentId, article: label.value, version, subpart, verified: version.provenance.review.status === "legally-verified" };
    }, REPEATABLE_READ_ONLY);
    return { ok: true, value: result };
  } catch (e) {
    return { ok: false, error: toStoreError(e) };
  }
}

export async function versionsInForceAt(db: KbDatabase, schema: string, onDate: IsoDate): Promise<StoreResult<readonly InForceEntry[]>> {
  try {
    const date = parseIsoDate(onDate);
    if (!date.ok) throw invalid(date.error.message);
    const entries = await db.transaction(async (tx) => {
      await assertCurrent(tx, schema);
      const versionRows = (
        await tx.execute(
          sql`SELECT v.document_id, v.article_label, ${DATE_OUT("v.valid_from", "valid_from")}, ${DATE_OUT("v.valid_to", "valid_to")}, v.body, ${provenanceSelect("v")}
              FROM ${tableRef(schema, "article_version")} v
              JOIN ${tableRef(schema, "document")} d ON d.id = v.document_id
              JOIN ${tableRef(schema, "article")} a ON a.document_id = v.document_id AND a.label = v.article_label
              WHERE v.valid_during @> ${date.value}::date
              ORDER BY d.seq, a.article_number, a.article_repeat`,
        )
      ).rows;
      const subpartRows = (
        await tx.execute(
          sql`SELECT s.document_id, s.article_label, s.kind, s.label, s.body
              FROM ${tableRef(schema, "article_subpart")} s
              JOIN ${tableRef(schema, "article_version")} v
                ON v.document_id = s.document_id AND v.article_label = s.article_label AND v.valid_from = s.valid_from
              WHERE v.valid_during @> ${date.value}::date
              ORDER BY s.document_id, s.article_label, s.ordinal`,
        )
      ).rows;
      const subs = new Map<string, Subpart[]>();
      for (const r of subpartRows) {
        const key = `${str(r, "document_id")}\u0001${str(r, "article_label")}`;
        const list = subs.get(key);
        if (list) list.push(readSubpart(r));
        else subs.set(key, [readSubpart(r)]);
      }
      const seen = new Set<string>();
      return versionRows.map((r): InForceEntry => {
        const documentId = str(r, "document_id");
        const article = str(r, "article_label");
        const key = `${documentId}\u0001${article}`;
        if (seen.has(key)) throw new CorruptRowError("دو نسخهٔ هم‌زمان معتبر برای یک ماده");
        seen.add(key);
        const version = readVersionRow(r, subs.get(key) ?? []);
        return { documentId, article, version, verified: version.provenance.review.status === "legally-verified" };
      });
    }, REPEATABLE_READ_ONLY);
    return { ok: true, value: entries };
  } catch (e) {
    return { ok: false, error: toStoreError(e) };
  }
}
