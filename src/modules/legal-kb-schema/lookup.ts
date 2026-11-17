/**
 * شاخص خواندنی روی Corpus معتبر + جست‌وجوی نسخهٔ معتبر در یک تاریخ (نسخه‌بندی زمانی).
 * همه‌چیز خالص و قطعی است؛ «امروز» از بیرون می‌آید.
 */
import { err, ok, type Result } from "@/modules/shared-types";
import { compareIsoDates, parseIsoDate } from "./dates";
import { canonicalArticleLabel, articleKey, canonicalSubpartLabel, parseArticleLabel } from "./label";
import type { Article, ArticleVersion, CitationRef, Corpus, IsoDate, LawDocument, NodeRef, Relation, Ruling, VersionLookup } from "./types";

type ArticleEntry = Readonly<{ document: LawDocument; article: Article }>;

export type CorpusIndex = Readonly<{
  corpus: Corpus;
  documents: ReadonlyMap<string, LawDocument>;
  articles: ReadonlyMap<string, ArticleEntry>;
  relationsByNode: ReadonlyMap<string, readonly Relation[]>;
  rulingsByNode: ReadonlyMap<string, readonly Ruling[]>;
}>;

const nodeKey = (documentId: string, article: string | null): string => {
  if (article === null) return documentId;
  const l = parseArticleLabel(article);
  return `${documentId}/${l.ok ? articleKey(l.value) : article}`;
};

function push<V>(map: Map<string, V[]>, key: string, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** فقط روی خروجی `loadCorpus` تضمین درستی دارد. */
export function buildCorpusIndex(corpus: Corpus): CorpusIndex {
  const documents = new Map<string, LawDocument>();
  const articles = new Map<string, ArticleEntry>();
  const relationsByNode = new Map<string, Relation[]>();
  const rulingsByNode = new Map<string, Ruling[]>();
  for (const document of corpus.documents) {
    documents.set(document.id, document);
    for (const article of document.articles) articles.set(nodeKey(document.id, article.label), { document, article });
  }
  for (const r of corpus.relations) {
    const a = nodeKey(r.from.documentId, r.from.article);
    const b = nodeKey(r.to.documentId, r.to.article);
    push(relationsByNode, a, r);
    push(relationsByNode, b, r); // a≠b همیشه (رابطه با خودش در loadCorpus رد می‌شود)
  }
  for (const g of corpus.rulings) for (const c of g.cites) push(rulingsByNode, nodeKey(c.documentId, c.article), g);
  return { corpus, documents, articles, relationsByNode, rulingsByNode };
}

export function findDocument(index: CorpusIndex, documentId: string): LawDocument | undefined {
  return index.documents.get(documentId);
}

export function findArticle(index: CorpusIndex, documentId: string, articleLabel: string): Article | undefined {
  const c = canonicalArticleLabel(articleLabel);
  return c.ok ? index.articles.get(nodeKey(documentId, c.value))?.article : undefined;
}

/** نسخهٔ معتبر در تاریخ (بازهٔ نیم‌باز)؛ آرایهٔ نسخه‌ها مرتب است (خروجی loadCorpus). */
function versionAt(versions: readonly ArticleVersion[], date: IsoDate): VersionLookup | ArticleVersion {
  let previous: ArticleVersion | null = null;
  for (const v of versions) {
    if (compareIsoDates(date, v.validFrom) < 0) {
      if (previous === null) return { status: "not-yet-in-force", firstValidFrom: v.validFrom };
      // previous.validTo ≤ date < v.validFrom ⇒ شکاف (اگر previous بی‌پایان بود، درونش می‌افتاد)
      return { status: "gap", previousValidTo: previous.validTo as IsoDate, nextValidFrom: v.validFrom };
    }
    if (v.validTo === null || compareIsoDates(date, v.validTo) < 0) return v;
    previous = v;
  }
  return { status: "no-longer-in-force", lastValidTo: (previous as ArticleVersion).validTo as IsoDate };
}

function isVersion(x: VersionLookup | ArticleVersion): x is ArticleVersion {
  return "validFrom" in x;
}

/**
 * ارجاع را در تاریخ مشخص حل می‌کند. خطای `Result` فقط برای ورودی بد (تاریخ، ارجاع)؛
 * «سند/ماده/بخش نیست» و «در آن تاریخ معتبر نیست» نتیجهٔ عادی (`status`) هستند تا راستی‌آزمایی روی همه switch کند.
 * ⚠️ `found.verified=false` یعنی نسخه هنوز توسط حقوقدان تأیید نشده و نباید به‌عنوان استنادِ قطعی به کاربر برسد.
 */
export function resolveCitation(index: CorpusIndex, ref: CitationRef, onDate: IsoDate): Result<VersionLookup> {
  const d = parseIsoDate(onDate);
  if (!d.ok) return d;
  const label = canonicalArticleLabel(ref.article);
  if (!label.ok) return label;
  if (ref.subpart !== null && ref.subpart.kind !== "note" && ref.subpart.kind !== "clause") return err("INVALID_INPUT", "نوع تبصره/بند نامعتبر است.");
  const sub = ref.subpart === null ? null : canonicalSubpartLabel(ref.subpart.label);
  if (sub && !sub.ok) return sub;

  const document = index.documents.get(ref.documentId);
  if (!document) return ok({ status: "unknown-document" });
  const entry = index.articles.get(nodeKey(ref.documentId, label.value));
  if (!entry) return ok({ status: "unknown-article" });

  const found = versionAt(entry.article.versions, d.value);
  if (!isVersion(found)) return ok(found);

  let subpart = null;
  if (ref.subpart !== null && sub && sub.ok) {
    subpart = found.subparts.find((s) => s.kind === ref.subpart?.kind && s.label === sub.value) ?? null;
    if (!subpart) return ok({ status: "unknown-subpart", version: found });
  }
  return ok({
    status: "found",
    documentId: ref.documentId,
    article: label.value,
    version: found,
    subpart,
    verified: found.provenance.review.status === "legally-verified",
  });
}

export type InForceEntry = Readonly<{ documentId: string; article: string; version: ArticleVersion; verified: boolean }>;

/** همهٔ مواد معتبر در یک تاریخ (برای فیلتر تاریخ در بازیابی). ترتیب: ترتیب سندها و مواد. */
export function versionsInForceAt(index: CorpusIndex, onDate: IsoDate): Result<readonly InForceEntry[]> {
  const d = parseIsoDate(onDate);
  if (!d.ok) return d;
  const out: InForceEntry[] = [];
  for (const doc of index.corpus.documents) {
    for (const article of doc.articles) {
      const v = versionAt(article.versions, d.value);
      if (isVersion(v)) out.push({ documentId: doc.id, article: article.label, version: v, verified: v.provenance.review.status === "legally-verified" });
    }
  }
  return ok(out);
}

/**
 * رابطه‌های یک گره. برای گرهٔ «ماده»، رابطه‌های سطح کل سند هم به‌طور پیش‌فرض می‌آیند
 * (مثلاً «قانون الف، قانون ب را نسخ کرد» همهٔ مواد ب را درگیر می‌کند).
 */
export function relationsFor(index: CorpusIndex, ref: NodeRef, options: Readonly<{ includeDocumentLevel?: boolean }> = {}): readonly Relation[] {
  const exact = index.relationsByNode.get(nodeKey(ref.documentId, ref.article)) ?? [];
  if (ref.article === null || options.includeDocumentLevel === false) return exact;
  const docLevel = index.relationsByNode.get(ref.documentId) ?? [];
  // یک رابطه ممکن است هم در سطح سند و هم در سطح ماده بنشیند (مثلاً مبدأ سند، مقصد ماده)؛ فقط یک بار برگردد.
  return Array.from(new Set([...docLevel, ...exact]));
}

/** رأی‌هایی که به این گره ارجاع دارند (دقیقاً همین گره؛ ارجاع به کل سند جدا شمرده می‌شود). */
export function rulingsCiting(index: CorpusIndex, ref: NodeRef): readonly Ruling[] {
  return index.rulingsByNode.get(nodeKey(ref.documentId, ref.article)) ?? [];
}
