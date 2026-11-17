/**
 * درج افزایشی (بخش ۴ب‑۲، داخلی؛ از `store.insertIncremental` در دسترس است).
 *
 * مسئله: قانون تازه (آیین‌نامه، اصلاحیه، رأی) به مادهٔ قانونی ارجاع می‌دهد که **از قبل در پایگاه است**؛ ولی `loadCorpus`
 * فقط Corpus «خودبسنده» را می‌پذیرد. راه‌حل: **اسکلتِ زمینه**.
 *
 *  1. ورودی بی‌اعتماد است؛ پس شناسهٔ سندهای بیرونی را فقط به‌عنوان *پارامتر پرس‌وجو* (نه SQL) از رابطه‌ها و ارجاع‌های رأی می‌خوانیم.
 *  2. از پایگاه فقط اسکلت آن سندها می‌آید (شناسه، نوع، عنوان، برچسب مواد، رابطه‌های موجود میان آن‌ها) — نه متن‌ها.
 *  3. اسکلت + ورودی **یک‌جا** از همان `loadCorpus` می‌گذرد: ارجاع معلق، رابطهٔ تکراری، تناقض «نسخ دوطرفه»، همه با قواعد اصلی.
 *     مسیر مسئله‌ها به ایندکس ورودی بازنویسی می‌شود (نه ایندکس اسکلت).
 *  4. فقط بخش **نو** درج می‌شود؛ سند/رأی با شناسهٔ موجود همچنان `ALREADY_EXISTS` است (فقط‌افزودنی؛ هیچ‌چیز بازنویسی نمی‌شود).
 *
 * همهٔ این‌ها در **یک تراکنش زیر قفل نوشتن** است؛ پس اسکلت و درج یک تصویر را می‌بینند و شکست = هیچ‌چیز ذخیره نمی‌شود.
 * محدودیت شناخته‌شده: رابطه‌های موجودی که یک سرشان بیرون از اسکلت است در اعتبارسنجی ترکیبی نیستند (تناقض فقط میان
 * سندهای درگیر سنجیده می‌شود). قید یکتایی رابطه در خودِ پایگاه هر حال تکراری را رد می‌کند.
 */
import { sql } from "drizzle-orm";
import { loadCorpus, type Corpus, type CorpusIssue } from "@/modules/legal-kb-schema";
import { StoreAbort, toStoreError } from "./errors";
import { assertNoClashes, flattenCorpus, insertFlat } from "./insert";
import { assertCurrent } from "./migrate";
import { tableRef } from "./naming";
import { DATE_OUT, str, strOrNull } from "./rows";
import type { InsertReport, KbDatabase, KbExecutor, StoreResult } from "./types";

/** سقف شمار سندهای بیرونیِ یک درج؛ بیشتر از آن یعنی ورودی احتمالاً اشتباه یا مخرب است. */
export const MAX_EXTERNAL_DOCUMENTS = 200;
const MAX_ID_CHARS = 64;

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * شناسهٔ سندهایی که رابطه‌ها/رأی‌های ورودی به آن‌ها ارجاع می‌دهند ولی در خودِ ورودی نیستند (مرتب، یکتا).
 * `null` یعنی ورودی شکل `{documents[], relations[], rulings[]}` ندارد. این تابع هیچ اعتباری نمی‌دهد؛ فقط جمع می‌کند.
 */
export function collectExternalDocumentIds(input: unknown): readonly string[] | null {
  if (!isRecord(input)) return null;
  const { documents, relations, rulings } = input;
  if (!Array.isArray(documents) || !Array.isArray(relations) || !Array.isArray(rulings)) return null;
  const own = new Set<string>();
  for (const d of documents) if (isRecord(d) && typeof d["id"] === "string") own.add(d["id"]);
  const external = new Set<string>();
  const note = (n: unknown): void => {
    if (isRecord(n) && typeof n["documentId"] === "string" && n["documentId"].length <= MAX_ID_CHARS && !own.has(n["documentId"])) external.add(n["documentId"]);
  };
  for (const r of relations) if (isRecord(r)) (note(r["from"]), note(r["to"]));
  for (const g of rulings) if (isRecord(g) && Array.isArray(g["cites"])) for (const c of g["cites"]) note(c);
  return [...external].sort();
}

/** مسیر مسئله‌ها را از ایندکس Corpus ترکیبی به ایندکس ورودی برمی‌گرداند؛ مسئلهٔ مربوط به اسکلت با پیشوند `context.` می‌ماند. */
export function remapContextPaths(issues: readonly CorpusIssue[], documentOffset: number, relationOffset: number): CorpusIssue[] {
  const shift = (kind: "documents" | "relations", offset: number) => (path: string): string =>
    path.replace(new RegExp(`^${kind}\\[(\\d+)\\]`), (_m, n: string) => {
      const k = Number(n) - offset;
      return k >= 0 ? `${kind}[${k}]` : `context.${kind}[${n}]`;
    });
  const docs = shift("documents", documentOffset);
  const rels = shift("relations", relationOffset);
  return issues.map((i) => ({ ...i, path: rels(docs(i.path)) }));
}

const STUB_PROVENANCE = {
  sourceName: "context",
  sourceUrl: null,
  sourceKind: "secondary",
  retrievedOn: null,
  review: { status: "pending-legal-review", reviewedBy: null, reviewedOn: null },
} as const;

type Context = Readonly<{ documents: readonly Json[]; relations: readonly Json[] }>;

/** اسکلت سندهای موجود: هر ماده یک نسخهٔ ساختگی دارد (فقط برای اینکه مدل «ماده بدون نسخه» را نپذیرد)، نه متن واقعی. */
async function loadContext(tx: KbExecutor, schema: string, ids: readonly string[]): Promise<Context> {
  const param = JSON.stringify(ids);
  const docs = (await tx.execute(sql`SELECT id, kind, title FROM ${tableRef(schema, "document")} WHERE id IN (SELECT jsonb_array_elements_text(${param}::jsonb)) ORDER BY seq`)).rows;
  const arts = (
    await tx.execute(
      sql`SELECT document_id, label FROM ${tableRef(schema, "article")} WHERE document_id IN (SELECT jsonb_array_elements_text(${param}::jsonb)) ORDER BY document_id, article_number, article_repeat`,
    )
  ).rows;
  const rels = (
    await tx.execute(
      sql`SELECT type, from_document_id, from_article, to_document_id, to_article, ${DATE_OUT("effective_from", "effective_from")}
          FROM ${tableRef(schema, "relation")}
          WHERE from_document_id IN (SELECT jsonb_array_elements_text(${param}::jsonb)) AND to_document_id IN (SELECT jsonb_array_elements_text(${param}::jsonb))
          ORDER BY seq`,
    )
  ).rows;
  const labelsByDoc = new Map<string, string[]>();
  for (const a of arts) {
    const id = str(a, "document_id");
    const list = labelsByDoc.get(id);
    if (list) list.push(str(a, "label"));
    else labelsByDoc.set(id, [str(a, "label")]);
  }
  const stubVersion = { validFrom: "2000-01-01", validTo: null, text: "context", subparts: [], provenance: STUB_PROVENANCE };
  return {
    documents: docs.map((d) => ({
      id: str(d, "id"),
      kind: str(d, "kind"),
      title: str(d, "title"),
      shortTitle: null,
      enactedOn: null,
      provenance: STUB_PROVENANCE,
      articles: (labelsByDoc.get(str(d, "id")) ?? []).map((label) => ({ label, versions: [stubVersion] })),
    })),
    relations: rels.map((r) => ({
      type: str(r, "type"),
      from: { documentId: str(r, "from_document_id"), article: strOrNull(r, "from_article") },
      to: { documentId: str(r, "to_document_id"), article: strOrNull(r, "to_article") },
      effectiveFrom: strOrNull(r, "effective_from"),
      note: null,
      provenance: STUB_PROVENANCE,
    })),
  };
}

const invalidCorpus = (issues: readonly CorpusIssue[]): StoreAbort =>
  new StoreAbort({ code: "INVALID_CORPUS", message: `Corpus نامعتبر است (${issues.length} مسئله)؛ چیزی ذخیره نشد.`, issues });

export async function insertIncremental(db: KbDatabase, schema: string, input: unknown): Promise<StoreResult<InsertReport>> {
  try {
    const alone = loadCorpus(input);
    const external = alone.ok ? [] : collectExternalDocumentIds(input);
    // ورودی خودبسته (یا بی‌امید به زمینه): بدون سفر به پایگاه، همان پاسخ `loadCorpus`.
    if (!alone.ok && (external === null || external.length === 0)) throw invalidCorpus(alone.error);
    if (external !== null && external.length > MAX_EXTERNAL_DOCUMENTS) {
      throw invalidCorpus([{ code: "LIMIT_EXCEEDED", path: "$", message: `ارجاع به بیش از ${MAX_EXTERNAL_DOCUMENTS} سندِ بیرون از ورودی در یک درج پذیرفته نمی‌شود.` }]);
    }
    const raw = input as Readonly<{ documents: readonly unknown[]; relations: readonly unknown[]; rulings: readonly unknown[] }>;

    const report = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`legal-kb-store:write:${schema}`}, 0))`);
      await assertCurrent(tx, schema);

      let fresh: Corpus;
      if (alone.ok) {
        fresh = alone.value;
      } else {
        const context = await loadContext(tx, schema, external ?? []);
        // `...raw`: کلیدهای ناشناختهٔ سطح بالا هم مثل قبل مسئله می‌شوند (بی‌صدا دور ریخته نمی‌شوند).
        const combined = loadCorpus({
          ...raw,
          documents: [...context.documents, ...raw.documents],
          relations: [...context.relations, ...raw.relations],
          rulings: raw.rulings,
        });
        if (!combined.ok) {
          const issues = remapContextPaths(combined.error, context.documents.length, context.relations.length);
          // مسئله در اسکلتِ خوانده‌شده از پایگاه = دادهٔ ذخیره‌شده خراب است، نه ورودی.
          if (issues.some((i) => i.path.startsWith("context."))) {
            throw new StoreAbort({ code: "CORRUPT_DATA", message: "دادهٔ موجود در پایگاه با قواعد مدل نمی‌خواند؛ درج افزایشی انجام نشد.", issues });
          }
          throw invalidCorpus(issues);
        }
        fresh = {
          documents: combined.value.documents.slice(context.documents.length),
          relations: combined.value.relations.slice(context.relations.length),
          rulings: combined.value.rulings,
        };
      }
      await assertNoClashes(tx, schema, fresh);
      return insertFlat(tx, schema, flattenCorpus(fresh));
    });
    return { ok: true, value: report };
  } catch (e) {
    return { ok: false, error: toStoreError(e) };
  }
}
