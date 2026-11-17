/**
 * خواندن کل پایگاه به‌صورت `Corpus` و آمار (داخلی).
 *
 * `readCorpus` همهٔ جدول‌ها را در **یک تراکنش فقط‌خواندنیِ REPEATABLE READ** (تصویر یکدست) می‌خواند، ردیف‌ها را به شکل ورودیِ
 * `loadCorpus` درمی‌آورد و **دوباره از `loadCorpus` می‌گذراند**. پس هرچه برمی‌گردد متعارف و معتبر است؛
 * اگر پایگاه (با دور زدن قیدها) خراب شده باشد، خروجی `CORRUPT_DATA` با فهرست مسائل است، نه دادهٔ نادرست.
 */
import { sql } from "drizzle-orm";
import { loadCorpus, type Corpus } from "@/modules/legal-kb-schema";
import { toStoreError } from "./errors";
import { assertCurrent } from "./migrate";
import { MIGRATIONS } from "./migrations";
import { tableRef } from "./naming";
import { DATE_OUT, int, isoDateOrNull, provenanceSelect, readProvenance, str, strOrNull, type Row } from "./rows";
import type { KbDatabase, StoreResult, StoreStats } from "./types";

const REPEATABLE_READ_ONLY = { isolationLevel: "repeatable read", accessMode: "read only" } as const;

function group<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = out.get(k);
    if (list) list.push(it);
    else out.set(k, [it]);
  }
  return out;
}

/** جداکنندهٔ کلید مرکب؛ در هیچ‌کدام از اجزا (شناسه/برچسب/تاریخ) نمی‌آید. */
const SEP = "\u0001";

export async function readCorpus(db: KbDatabase, schema: string): Promise<StoreResult<Corpus>> {
  const q = (t: Parameters<typeof tableRef>[1]) => tableRef(schema, t);
  try {
    const raw = await db.transaction(async (tx) => {
      await assertCurrent(tx, schema);
      const docs = (await tx.execute(sql`SELECT id, kind, title, short_title, ${DATE_OUT("enacted_on", "enacted_on")}, ${provenanceSelect("")} FROM ${q("document")} ORDER BY seq`)).rows;
      const arts = (await tx.execute(sql`SELECT document_id, label FROM ${q("article")} ORDER BY document_id, article_number, article_repeat`)).rows;
      const vers = (
        await tx.execute(
          sql`SELECT document_id, article_label, ${DATE_OUT("valid_from", "valid_from")}, ${DATE_OUT("valid_to", "valid_to")}, body, ${provenanceSelect("")}
              FROM ${q("article_version")} ORDER BY document_id, article_label, valid_from`,
        )
      ).rows;
      const subs = (
        await tx.execute(
          sql`SELECT document_id, article_label, ${DATE_OUT("valid_from", "valid_from")}, kind, label, body
              FROM ${q("article_subpart")} ORDER BY document_id, article_label, valid_from, ordinal`,
        )
      ).rows;
      const rels = (
        await tx.execute(
          sql`SELECT type, from_document_id, from_article, to_document_id, to_article, ${DATE_OUT("effective_from", "effective_from")}, note, ${provenanceSelect("")}
              FROM ${q("relation")} ORDER BY seq`,
        )
      ).rows;
      const rules = (
        await tx.execute(sql`SELECT id, kind, number, issuer, ${DATE_OUT("issued_on", "issued_on")}, title, body, ${provenanceSelect("")} FROM ${q("ruling")} ORDER BY seq`)
      ).rows;
      const cites = (await tx.execute(sql`SELECT ruling_id, document_id, article_label FROM ${q("ruling_cite")} ORDER BY ruling_id, ordinal`)).rows;

      const subsByVersion = group(subs, (r) => [str(r, "document_id"), str(r, "article_label"), str(r, "valid_from")].join(SEP));
      const versByArticle = group(vers, (r) => [str(r, "document_id"), str(r, "article_label")].join(SEP));
      const artsByDoc = group(arts, (r) => str(r, "document_id"));
      const citesByRuling = group(cites, (r) => str(r, "ruling_id"));
      const node = (documentId: string, article: string | null) => ({ documentId, article });
      const provenance = (r: Row) => {
        const p = readProvenance(r);
        return { sourceName: p.sourceName, sourceUrl: p.sourceUrl, sourceKind: p.sourceKind, retrievedOn: p.retrievedOn, review: p.review };
      };

      return {
        documents: docs.map((d) => ({
          id: str(d, "id"),
          kind: str(d, "kind"),
          title: str(d, "title"),
          shortTitle: strOrNull(d, "short_title"),
          enactedOn: isoDateOrNull(d, "enacted_on"),
          provenance: provenance(d),
          articles: (artsByDoc.get(str(d, "id")) ?? []).map((a) => ({
            label: str(a, "label"),
            versions: (versByArticle.get([str(a, "document_id"), str(a, "label")].join(SEP)) ?? []).map((v) => ({
              validFrom: str(v, "valid_from"),
              validTo: strOrNull(v, "valid_to"),
              text: str(v, "body"),
              subparts: (subsByVersion.get([str(v, "document_id"), str(v, "article_label"), str(v, "valid_from")].join(SEP)) ?? []).map((s) => ({
                kind: str(s, "kind"),
                label: str(s, "label"),
                text: str(s, "body"),
              })),
              provenance: provenance(v),
            })),
          })),
        })),
        relations: rels.map((r) => ({
          type: str(r, "type"),
          from: node(str(r, "from_document_id"), strOrNull(r, "from_article")),
          to: node(str(r, "to_document_id"), strOrNull(r, "to_article")),
          effectiveFrom: strOrNull(r, "effective_from"),
          note: strOrNull(r, "note"),
          provenance: provenance(r),
        })),
        rulings: rules.map((g) => ({
          id: str(g, "id"),
          kind: str(g, "kind"),
          number: str(g, "number"),
          issuer: str(g, "issuer"),
          issuedOn: str(g, "issued_on"),
          title: strOrNull(g, "title"),
          text: str(g, "body"),
          cites: (citesByRuling.get(str(g, "id")) ?? []).map((c) => node(str(c, "document_id"), strOrNull(c, "article_label"))),
          provenance: provenance(g),
        })),
      };
    }, REPEATABLE_READ_ONLY);

    const loaded = loadCorpus(raw);
    if (!loaded.ok) {
      return { ok: false, error: { code: "CORRUPT_DATA", message: `دادهٔ ذخیره‌شده با قواعد مدل نمی‌خواند (${loaded.error.length} مسئله)؛ چیزی برگردانده نمی‌شود.`, issues: loaded.error } };
    }
    return { ok: true, value: loaded.value };
  } catch (e) {
    return { ok: false, error: toStoreError(e) };
  }
}

export async function readStats(db: KbDatabase, schema: string): Promise<StoreResult<StoreStats>> {
  const q = (t: Parameters<typeof tableRef>[1]) => tableRef(schema, t);
  try {
    const stats = await db.transaction(async (tx) => {
      await assertCurrent(tx, schema);
      const row = (
        await tx.execute(sql`SELECT
          (SELECT count(*) FROM ${q("document")})::integer AS documents,
          (SELECT count(*) FROM ${q("article")})::integer AS articles,
          (SELECT count(*) FROM ${q("article_version")})::integer AS versions,
          (SELECT count(*) FROM ${q("article_subpart")})::integer AS subparts,
          (SELECT count(*) FROM ${q("relation")})::integer AS relations,
          (SELECT count(*) FROM ${q("ruling")})::integer AS rulings,
          (SELECT count(*) FROM ${q("ruling_cite")})::integer AS citations,
          (SELECT count(*) FROM ${q("article_version")} WHERE review_status = 'legally-verified')::integer AS verified_versions`)
      ).rows[0] as Row;
      return {
        documents: int(row, "documents"),
        articles: int(row, "articles"),
        versions: int(row, "versions"),
        subparts: int(row, "subparts"),
        relations: int(row, "relations"),
        rulings: int(row, "rulings"),
        citations: int(row, "citations"),
        verifiedVersions: int(row, "verified_versions"),
        migrations: MIGRATIONS.map((m) => m.name),
      } satisfies StoreStats;
    }, REPEATABLE_READ_ONLY);
    return { ok: true, value: stats };
  } catch (e) {
    return { ok: false, error: toStoreError(e) };
  }
}
