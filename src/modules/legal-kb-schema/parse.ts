/**
 * ورودی `unknown` (JSON) → `Corpus` تایپ‌دار و متعارف (داخلی؛ رابط عمومی: `loadCorpus` در load.ts).
 * سخت‌گیرانه: کلید ناشناخته، نوع نادرست، تاریخ ناممکن، متن خالی و نویسهٔ خطرناک همه مسئله‌اند.
 */
import { canonicalSubpartLabel, isValidRecordId } from "./label";
import { addIssue, KB_LIMITS, type Ctx } from "./issues";
import {
  articleLabelValue,
  explicitNullableDate,
  optDate,
  optText,
  optUrl,
  readArray,
  record,
  reqDate,
  reqEnum,
  reqText,
  type Rec,
} from "./reader";
import {
  DOCUMENT_KINDS,
  RELATION_TYPES,
  RULING_KINDS,
  SUBPART_KINDS,
  type Article,
  type ArticleVersion,
  type Corpus,
  type LawDocument,
  type NodeRef,
  type Provenance,
  type Relation,
  type Review,
  type Ruling,
  type Subpart,
} from "./types";

const PENDING: Review = { status: "pending-legal-review", reviewedBy: null, reviewedOn: null };

/** مقدار جایگزین فقط برای ادامهٔ بررسی پس از خطا؛ هرگز به خروجی نمی‌رسد. */
const NO_PROVENANCE: Provenance = { sourceName: "", sourceUrl: null, sourceKind: "secondary", retrievedOn: null, review: PENDING };

function readReview(ctx: Ctx, v: unknown, path: string): Review {
  if (v === undefined) return PENDING; // پیش‌فرض امن: تأییدنشده
  const rec = record(ctx, v, path, ["status", "reviewedBy", "reviewedOn"]);
  if (!rec) return PENDING;
  const status = reqEnum(ctx, rec, "status", path, ["pending-legal-review", "legally-verified"] as const, "pending-legal-review");
  const reviewedBy = optText(ctx, rec, "reviewedBy", path, { max: 200 });
  const reviewedOn = optDate(ctx, rec, "reviewedOn", path);
  if (status === "legally-verified" && (reviewedBy === null || reviewedOn === null)) {
    addIssue(ctx, "REVIEW_INCONSISTENT", path, "وضعیت «legally-verified» نام بازبین (reviewedBy) و تاریخ بازبینی (reviewedOn) را لازم دارد.");
  }
  if (status === "pending-legal-review" && (reviewedBy !== null || reviewedOn !== null)) {
    addIssue(ctx, "REVIEW_INCONSISTENT", path, "وضعیت «pending-legal-review» نباید نام یا تاریخ بازبین داشته باشد.");
  }
  return { status, reviewedBy, reviewedOn };
}

function readProvenance(ctx: Ctx, v: unknown, path: string): Provenance {
  if (v === undefined) {
    addIssue(ctx, "MISSING_FIELD", path, "منبع (provenance) الزامی است.");
    return NO_PROVENANCE;
  }
  const rec = record(ctx, v, path, ["sourceName", "sourceUrl", "sourceKind", "retrievedOn", "review"]);
  if (!rec) return NO_PROVENANCE;
  return {
    sourceName: reqText(ctx, rec, "sourceName", path, { max: 300 }),
    sourceUrl: optUrl(ctx, rec, "sourceUrl", path),
    sourceKind: reqEnum(ctx, rec, "sourceKind", path, ["official", "secondary"] as const, "secondary"),
    retrievedOn: optDate(ctx, rec, "retrievedOn", path),
    review: readReview(ctx, rec["review"], `${path}.review`),
  };
}

function readSubpart(ctx: Ctx, v: unknown, path: string): Subpart {
  const fallback: Subpart = { kind: "note", label: "1", text: "" };
  const rec = record(ctx, v, path, ["kind", "label", "text"]);
  if (!rec) return fallback;
  const kind = reqEnum(ctx, rec, "kind", path, SUBPART_KINDS, "note");
  let label = "";
  if (rec["label"] === undefined) addIssue(ctx, "MISSING_FIELD", `${path}.label`, "این کلید الزامی است.");
  else if (typeof rec["label"] !== "string") addIssue(ctx, "INVALID_FIELD", `${path}.label`, "برچسب باید متن باشد.");
  else {
    const r = canonicalSubpartLabel(rec["label"]);
    if (r.ok) label = r.value;
    else addIssue(ctx, "INVALID_FIELD", `${path}.label`, r.error.message);
  }
  return { kind, label, text: reqText(ctx, rec, "text", path, { multiline: true }) };
}

function readVersion(ctx: Ctx, v: unknown, path: string): ArticleVersion {
  const empty: ArticleVersion = { validFrom: "1900-01-01", validTo: null, text: "", subparts: [], provenance: NO_PROVENANCE };
  const rec = record(ctx, v, path, ["validFrom", "validTo", "text", "subparts", "provenance"]);
  if (!rec) return empty;
  const subparts = readArray(ctx, rec, "subparts", path, KB_LIMITS.subpartsPerVersion, false).map((s, i) => readSubpart(ctx, s, `${path}.subparts[${i}]`));
  return {
    validFrom: reqDate(ctx, rec, "validFrom", path),
    validTo: explicitNullableDate(ctx, rec, "validTo", path),
    text: reqText(ctx, rec, "text", path, { multiline: true }),
    subparts,
    provenance: readProvenance(ctx, rec["provenance"], `${path}.provenance`),
  };
}

function readArticle(ctx: Ctx, v: unknown, path: string): Article {
  const rec = record(ctx, v, path, ["label", "versions"]);
  if (!rec) return { label: "", versions: [] };
  const label = rec["label"] === undefined ? (addIssue(ctx, "MISSING_FIELD", `${path}.label`, "این کلید الزامی است."), "") : articleLabelValue(ctx, rec["label"], `${path}.label`);
  const raw = readArray(ctx, rec, "versions", path, KB_LIMITS.versionsPerArticle, true);
  if (Array.isArray(rec["versions"]) && rec["versions"].length === 0) {
    addIssue(ctx, "MISSING_FIELD", `${path}.versions`, "هر ماده حداقل یک نسخه لازم دارد.");
  }
  return { label, versions: raw.map((x, i) => readVersion(ctx, x, `${path}.versions[${i}]`)) };
}

function readDocument(ctx: Ctx, v: unknown, path: string): LawDocument {
  const rec = record(ctx, v, path, ["id", "kind", "title", "shortTitle", "enactedOn", "provenance", "articles"]);
  const empty = (): LawDocument => ({ id: "", kind: "statute", title: "", shortTitle: null, enactedOn: null, provenance: NO_PROVENANCE, articles: [] });
  if (!rec) return empty();
  const id = readRecordId(ctx, rec, "id", path);
  const articles = readArray(ctx, rec, "articles", path, KB_LIMITS.articlesPerDocument, true).map((a, i) => readArticle(ctx, a, `${path}.articles[${i}]`));
  return {
    id,
    kind: reqEnum(ctx, rec, "kind", path, DOCUMENT_KINDS, "statute"),
    title: reqText(ctx, rec, "title", path, { max: 300 }),
    shortTitle: optText(ctx, rec, "shortTitle", path, { max: 100 }),
    enactedOn: optDate(ctx, rec, "enactedOn", path),
    provenance: readProvenance(ctx, rec["provenance"], `${path}.provenance`),
    articles,
  };
}

function readRecordId(ctx: Ctx, rec: Rec, key: string, path: string): string {
  const p = `${path}.${key}`;
  const v = rec[key];
  if (v === undefined) {
    addIssue(ctx, "MISSING_FIELD", p, "این کلید الزامی است.");
    return "";
  }
  if (!isValidRecordId(v)) {
    addIssue(ctx, "INVALID_FIELD", p, "شناسه باید لاتین کوچک (حرف، عدد و خط تیره، مثل sample-law) و حداکثر ۶۴ نویسه باشد.");
    return "";
  }
  return v;
}

function readNodeRef(ctx: Ctx, v: unknown, path: string): NodeRef {
  const rec = record(ctx, v, path, ["documentId", "article"]);
  if (!rec) return { documentId: "", article: null };
  const documentId = readRecordId(ctx, rec, "documentId", path);
  const a = rec["article"];
  const article = a === undefined || a === null ? null : articleLabelValue(ctx, a, `${path}.article`);
  return { documentId, article };
}

function readRelation(ctx: Ctx, v: unknown, path: string): Relation {
  const rec = record(ctx, v, path, ["type", "from", "to", "effectiveFrom", "note", "provenance"]);
  if (!rec) return { type: "refers-to", from: { documentId: "", article: null }, to: { documentId: "", article: null }, effectiveFrom: null, note: null, provenance: NO_PROVENANCE };
  return {
    type: reqEnum(ctx, rec, "type", path, RELATION_TYPES, "refers-to"),
    from: rec["from"] === undefined ? (addIssue(ctx, "MISSING_FIELD", `${path}.from`, "این کلید الزامی است."), { documentId: "", article: null }) : readNodeRef(ctx, rec["from"], `${path}.from`),
    to: rec["to"] === undefined ? (addIssue(ctx, "MISSING_FIELD", `${path}.to`, "این کلید الزامی است."), { documentId: "", article: null }) : readNodeRef(ctx, rec["to"], `${path}.to`),
    effectiveFrom: explicitNullableDate(ctx, rec, "effectiveFrom", path),
    note: optText(ctx, rec, "note", path, { multiline: true, max: 2000 }),
    provenance: readProvenance(ctx, rec["provenance"], `${path}.provenance`),
  };
}

function readRuling(ctx: Ctx, v: unknown, path: string): Ruling {
  const rec = record(ctx, v, path, ["id", "kind", "number", "issuer", "issuedOn", "title", "text", "cites", "provenance"]);
  if (!rec) return { id: "", kind: "judgment", number: "", issuer: "", issuedOn: "1900-01-01", title: null, text: "", cites: [], provenance: NO_PROVENANCE };
  return {
    id: readRecordId(ctx, rec, "id", path),
    kind: reqEnum(ctx, rec, "kind", path, RULING_KINDS, "judgment"),
    number: reqText(ctx, rec, "number", path, { max: 100 }),
    issuer: reqText(ctx, rec, "issuer", path, { max: 300 }),
    issuedOn: reqDate(ctx, rec, "issuedOn", path),
    title: optText(ctx, rec, "title", path, { max: 300 }),
    text: reqText(ctx, rec, "text", path, { multiline: true }),
    cites: readArray(ctx, rec, "cites", path, KB_LIMITS.citesPerRuling, false).map((c, i) => readNodeRef(ctx, c, `${path}.cites[${i}]`)),
    provenance: readProvenance(ctx, rec["provenance"], `${path}.provenance`),
  };
}

export function readCorpus(ctx: Ctx, input: unknown): Corpus | null {
  const rec = record(ctx, input, "$", ["documents", "relations", "rulings"]);
  if (!rec) return null;
  return {
    documents: readArray(ctx, rec, "documents", "$", KB_LIMITS.documents, true).map((d, i) => readDocument(ctx, d, `documents[${i}]`)),
    relations: readArray(ctx, rec, "relations", "$", KB_LIMITS.relations, false).map((r, i) => readRelation(ctx, r, `relations[${i}]`)),
    rulings: readArray(ctx, rec, "rulings", "$", KB_LIMITS.rulings, false).map((r, i) => readRuling(ctx, r, `rulings[${i}]`)),
  };
}
