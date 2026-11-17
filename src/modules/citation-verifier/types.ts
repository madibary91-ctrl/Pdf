/**
 * citation-verifier — نوع‌های عمومی.
 *
 * اصل: «ارجاع نامعتبر هرگز خروجی نمی‌شود». هر ارجاع یکی از حکم‌های بسته‌ی زیر را می‌گیرد و فقط `accepted: true`
 * اجازهٔ نمایش به کاربر دارد. هر چیزِ نامعلوم، مبهم یا نفهمیده = رد (شکست‌به‌سمت‌ایمنی)، نه «احتمالاً درست».
 */
import type { CitationRef, IsoDate, VersionLookup } from "@/modules/legal-kb-schema";

/** ارجاعی که یک مدل/کاربر ادعا کرده است. */
export type CitationClaim = Readonly<{
  ref: CitationRef;
  /**
   * نقل‌قول ادعایی از متن همان ماده/تبصره/بند (اختیاری). `null`/نبودن = بدون سنجش نقل‌قول.
   * اگر داده شود باید (پس از هم‌سان‌سازی نگارش) واژه‌به‌واژه در متن همان نسخهٔ معتبر باشد؛ «…» بخش‌ها را جدا می‌کند.
   */
  quote?: string | null;
}>;

export type VerifyPolicy = Readonly<{
  /**
   * پیش‌فرض `false`: نسخهٔ تأییدنشده توسط حقوقدان قابل‌استناد به کاربر نیست (ADR-0003).
   * `true` فقط برای ابزارهای داخلی/بازبینی (نمایش «تأییدنشده» با برچسب) است.
   */
  allowUnverified?: boolean;
}>;

/** حکم‌ها (فهرست بسته؛ مصرف‌کننده روی آن switch می‌کند). */
export type VerdictCode =
  | "valid" // ماده/تبصره/بند هست، در تاریخ معتبر است، تأییدشده است، و نقل‌قول (اگر هست) درست است
  | "unverified-source" // همه‌چیز هست ولی هنوز حقوقدان تأیید نکرده
  | "unknown-document"
  | "unknown-article"
  | "unknown-subpart"
  | "not-yet-in-force"
  | "no-longer-in-force"
  | "gap" // شکاف اعتبار: در این روز هیچ نسخه‌ای معتبر نیست
  | "quote-mismatch" // نقل‌قول در متن آن ماده/تبصره/بند نیست (یا بیش از حد کوتاه است)
  | "malformed"; // ارجاع/تاریخ/نقل‌قول از نظر شکل نامعتبر است

export type Evidence = Readonly<{
  documentId: string;
  article: string;
  validFrom: IsoDate;
  validTo: IsoDate | null;
  subpart: Readonly<{ kind: "note" | "clause"; label: string }> | null;
  verified: boolean;
}>;

export type CitationVerdict = Readonly<{
  code: VerdictCode;
  /** فقط وقتی `true` است ارجاع اجازهٔ نمایش دارد. */
  accepted: boolean;
  claim: CitationClaim;
  /** پیام فارسی قابل‌نمایش به بازبین/توسعه‌دهنده */
  message: string;
  /** نتیجهٔ خام جست‌وجو (اگر ارجاع از نظر شکل معتبر بوده) */
  lookup: VersionLookup | null;
  /** مدرکِ تطبیق؛ فقط وقتی ارجاع به یک نسخهٔ واقعی رسیده (حتی اگر رد شده) */
  evidence: Evidence | null;
}>;

export type CitationReport = Readonly<{
  verdicts: readonly CitationVerdict[];
  accepted: readonly CitationVerdict[];
  rejected: readonly CitationVerdict[];
  /** همهٔ ارجاع‌ها پذیرفته شده‌اند (برای فهرست تهی هم `true`) */
  allAccepted: boolean;
}>;

// ───────────── متن آزاد ─────────────

export type MentionStatus =
  | "resolved" // شکل ارجاع فهمیده شد و به یک سندِ شناخته‌شده نسبت یافت (هنوز با پایگاه سنجیده نشده)
  | "no-document" // «ماده ۱۰» بدون نام قانون و بدون سند پیش‌فرض ⇒ نسبت‌ناپذیر
  | "ambiguous-document" // نام قانون به بیش از یک سند می‌خورد
  | "unknown-document" // قانونی نام برده شد که در پایگاه نیست
  | "malformed" // شمارهٔ ماده/برچسب تبصره‌وبند معتبر نیست
  | "unsupported-form"; // شکلی که نمی‌فهمیم (مثل «مواد ۱۰ و ۱۱»)؛ رد می‌شود، نادیده گرفته نمی‌شود

export type Mention = Readonly<{
  /** بازهٔ نیم‌باز `[start, end)` در متن اصلی (واحد: واحد کد UTF-16، مثل `String.slice`) */
  start: number;
  end: number;
  text: string;
  status: MentionStatus;
  /** فقط برای `resolved` */
  claim: CitationClaim | null;
  reason: string;
}>;

export type CheckedMention = Readonly<{
  mention: Mention;
  /** فقط برای `resolved`؛ برای بقیه `null` (و همیشه رد) */
  verdict: CitationVerdict | null;
  accepted: boolean;
}>;

export type TextCheck = Readonly<{
  mentions: readonly CheckedMention[];
  rejected: readonly CheckedMention[];
  /** همهٔ ارجاع‌های یافت‌شده پذیرفته شدند (متن بی‌ارجاع هم `true`) */
  ok: boolean;
}>;

export type TextCheckOptions = Readonly<
  VerifyPolicy & {
    /** سندی که «ماده ۱۰» بی‌نام‌قانون به آن نسبت داده می‌شود (مثلاً وقتی پرسش دربارهٔ یک قانون است). */
    defaultDocumentId?: string | null;
  }
>;
