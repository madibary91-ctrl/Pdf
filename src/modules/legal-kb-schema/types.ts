/**
 * legal-kb-schema — شکل داده‌ی پایگاه دانش قانون (فقط نوع؛ بدون منطق و بدون داده‌ی حقوقی).
 *
 * اصل‌های طراحی (جزئیات: docs/adr/0003-legal-kb-schema.md):
 *  - تاریخ‌ها در مدل **فقط میلادیِ ISO** (`YYYY-MM-DD`) هستند؛ تبدیل از/به جلالی کار مرز (ingest/رابط) است.
 *  - شناسهٔ ماده و نسخه **محاسبه‌شده** است، نه ورودی: «سند + برچسب ماده» و «ماده + تاریخ شروع». پس شناسهٔ ناسازگار ممکن نیست.
 *  - هر رکورد منبع و وضعیت بازبینی دارد؛ پیش‌فرض همیشه «تأییدنشده» است.
 */

/** تاریخ میلادی با قالب `YYYY-MM-DD` (اعتبارسنجی‌شده؛ مقایسهٔ رشته‌ای = مقایسهٔ زمانی). */
export type IsoDate = string;

/** نوع سند حقوقی. فهرست بسته؛ افزودن نوع = تغییر شما (ADR-0003). */
export type DocumentKind =
  | "constitution" // قانون اساسی (واحد: «اصل»)
  | "statute" // قانون (مصوب مجلس)
  | "regulation" // آیین‌نامه
  | "directive" // دستورالعمل / بخشنامه
  | "approval"; // مصوبه (شورای عالی … و مانند آن)

export const DOCUMENT_KINDS: readonly DocumentKind[] = ["constitution", "statute", "regulation", "directive", "approval"];

export type RulingKind =
  | "unity-ruling" // رأی وحدت رویه
  | "constitutional-opinion" // نظر شورای نگهبان
  | "advisory-opinion" // نظریهٔ مشورتی
  | "judgment"; // رأی دادگاه

export const RULING_KINDS: readonly RulingKind[] = ["unity-ruling", "constitutional-opinion", "advisory-opinion", "judgment"];

/** نوع رابطه؛ جهت: `from` ← کنشگر، `to` ← هدف. */
export type RelationType =
  | "amends" // from متنِ to را اصلاح می‌کند
  | "repeals" // from، to را نسخ می‌کند
  | "replaces" // from جایگزین to می‌شود
  | "refers-to" // from به to ارجاع می‌دهد
  | "implements" // from (مثلاً آیین‌نامه) برای اجرای to است
  | "interprets"; // from (مثلاً رأی/نظر) to را تفسیر می‌کند

export const RELATION_TYPES: readonly RelationType[] = ["amends", "repeals", "replaces", "refers-to", "implements", "interprets"];

export type ReviewStatus = "pending-legal-review" | "legally-verified";

export type Review = Readonly<{
  status: ReviewStatus;
  /** فقط وقتی `legally-verified` است پر می‌شود. */
  reviewedBy: string | null;
  reviewedOn: IsoDate | null;
}>;

export type SourceKind =
  /** متن رسمی (روزنامهٔ رسمی، پایگاه رسمی مجلس/مرکز پژوهش‌ها و مانند آن) */
  | "official"
  /** نقل ثانویه (سایت‌های حقوقی، کتاب، …)؛ تا تأیید حقوقدان معتبر نیست */
  | "secondary";

export type Provenance = Readonly<{
  sourceName: string;
  sourceUrl: string | null;
  sourceKind: SourceKind;
  /** تاریخ دریافت از منبع (از بیرون می‌آید؛ ماژول ساعت ندارد). */
  retrievedOn: IsoDate | null;
  review: Review;
}>;

/** بخش درون ماده: تبصره یا بند. برچسب: عدد لاتین (`1`) یا حروف فارسی (`الف`). */
export type SubpartKind = "note" | "clause";

export const SUBPART_KINDS: readonly SubpartKind[] = ["note", "clause"];

export type Subpart = Readonly<{ kind: SubpartKind; label: string; text: string }>;

/**
 * یک نسخهٔ متن ماده. بازهٔ اعتبار **نیم‌باز** است: `[validFrom, validTo)`.
 *  - `validFrom`: نخستین روزی که این متن معتبر است.
 *  - `validTo`: نخستین روزی که دیگر معتبر نیست (= `validFrom` نسخهٔ بعدی)؛ `null` یعنی هنوز معتبر.
 * نسخهٔ «نسخ‌شده» متن ندارد: فقط بازهٔ نسخهٔ آخر بسته می‌شود (و رابطهٔ `repeals` ثبت می‌شود).
 */
export type ArticleVersion = Readonly<{
  validFrom: IsoDate;
  validTo: IsoDate | null;
  text: string;
  subparts: readonly Subpart[];
  provenance: Provenance;
}>;

/** `label`: شکل متعارفِ برچسب ماده، مثل `10`، `10 مکرر`، `10 مکرر 2` یا `واحده`. */
export type Article = Readonly<{
  label: string;
  /** حداقل یک نسخه؛ مرتب بر اساس `validFrom`. */
  versions: readonly ArticleVersion[];
}>;

export type LawDocument = Readonly<{
  /** شناسهٔ لاتین کوتاه، مثل `sample-law`؛ حروف کوچک، عدد و خط تیره. */
  id: string;
  kind: DocumentKind;
  title: string;
  shortTitle: string | null;
  enactedOn: IsoDate | null;
  provenance: Provenance;
  articles: readonly Article[];
}>;

/** اشاره به یک سند یا یک ماده؛ `article = null` یعنی کل سند. */
export type NodeRef = Readonly<{ documentId: string; article: string | null }>;

export type Relation = Readonly<{
  type: RelationType;
  from: NodeRef;
  to: NodeRef;
  /** تاریخ اثر رابطه (مثلاً شروع اعتبار اصلاح)؛ صریح و در صورت ناشناخته `null`. */
  effectiveFrom: IsoDate | null;
  note: string | null;
  provenance: Provenance;
}>;

export type Ruling = Readonly<{
  /** شناسهٔ لاتین یکتا */
  id: string;
  kind: RulingKind;
  /** شمارهٔ رأی/نظر؛ متن آزاد کوتاه */
  number: string;
  issuer: string;
  issuedOn: IsoDate;
  title: string | null;
  text: string;
  /** مواد/اسنادی که رأی به آن‌ها ارجاع دارد (باید در پایگاه موجود باشند). */
  cites: readonly NodeRef[];
  provenance: Provenance;
}>;

export type Corpus = Readonly<{
  documents: readonly LawDocument[];
  relations: readonly Relation[];
  rulings: readonly Ruling[];
}>;

/** ارجاع دقیق به ماده (و در صورت نیاز تبصره/بند) برای راستی‌آزمایی. */
export type CitationRef = Readonly<{
  documentId: string;
  /** برچسب متعارف ماده */
  article: string;
  subpart: Readonly<{ kind: SubpartKind; label: string }> | null;
}>;

export type IssueCode =
  | "INVALID_FIELD" // نوع یا مقدار نادرست
  | "MISSING_FIELD"
  | "UNKNOWN_FIELD" // کلید ناشناخته (غلط املایی را بی‌صدا نمی‌پذیریم)
  | "LIMIT_EXCEEDED"
  | "DUPLICATE"
  | "DANGLING_REF"
  | "INVALID_INTERVAL"
  | "VERSION_OVERLAP"
  | "REVIEW_INCONSISTENT"
  | "CONTRADICTORY_RELATION";

export type CorpusIssue = Readonly<{
  code: IssueCode;
  /** مسیر در ورودی، مثل `documents[0].articles[2].versions[1].validFrom` */
  path: string;
  /** پیام فارسی */
  message: string;
}>;

/** نتیجهٔ جست‌وجوی نسخهٔ معتبر در یک تاریخ. همهٔ حالت‌ها صریح‌اند؛ هیچ‌کدام «حدس» نیست. */
export type VersionLookup =
  | Readonly<{
      status: "found";
      documentId: string;
      article: string;
      version: ArticleVersion;
      subpart: Subpart | null;
      /** آیا این نسخه توسط حقوقدان تأیید شده؟ (`false` = قابل استناد به کاربر نیست.) */
      verified: boolean;
    }>
  | Readonly<{ status: "unknown-document" }>
  | Readonly<{ status: "unknown-article" }>
  | Readonly<{ status: "unknown-subpart"; version: ArticleVersion }>
  | Readonly<{ status: "not-yet-in-force"; firstValidFrom: IsoDate }>
  | Readonly<{ status: "no-longer-in-force"; lastValidTo: IsoDate }>
  | Readonly<{ status: "gap"; previousValidTo: IsoDate; nextValidFrom: IsoDate }>;
