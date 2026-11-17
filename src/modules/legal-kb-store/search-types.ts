/**
 * جست‌وجوی کلمه‌ای (بخش ۴ب‑۳) — نوع‌های رابط. داخلی به‌جز آنچه index.ts صادر می‌کند.
 */
import type { IsoDate, Provenance, Subpart } from "@/modules/legal-kb-schema";
import type { VersionRef } from "./types";

/** ورودی جست‌وجو. `asOf` **الزامی** است: «کدام متن در این تاریخ معتبر بود؟» هرگز پیش‌فرضِ پنهان (ساعت سیستم) ندارد. */
export type SearchInput = Readonly<{
  /** متن پرسش؛ با همان `searchKey` نمایه نرمال می‌شود (ی/ک، ارقام، همزه، اعراب، نیم‌فاصله). همهٔ واژه‌ها باید در متن باشند (AND). */
  text: string;
  asOf: IsoDate;
  /** پیش‌فرض `true` (ایمنِ پیش‌فرض): فقط نسخه‌های تأییدشدهٔ حقوقدان. `false` = شامل «در انتظار بازبینی» (با `verified: false` در هر نتیجه). */
  verifiedOnly?: boolean;
  /** فقط در یک سند (شناسهٔ سند). */
  documentId?: string;
  /** ۱…۱۰۰؛ پیش‌فرض ۲۰. */
  limit?: number;
}>;

export type SearchHit = Readonly<{
  ref: VersionRef;
  documentTitle: string;
  validTo: IsoDate | null;
  /** متن و تبصره/بندها **از جدول اصلی** خوانده می‌شوند، نه از نمایه. */
  text: string;
  subparts: readonly Subpart[];
  provenance: Provenance;
  verified: boolean;
  /** `versionContentHash` متنی که نتیجه بر پایهٔ آن است (برای `markVerified`/`correctVersion`). */
  contentHash: string;
  /**
   * امتیاز = جمع دفعات ظاهر شدنِ واژه‌های پرسش در متن (و تبصره/بندها). ترتیب: امتیاز نزولی، سپس ترتیب سند و ماده (قطعی).
   * امتیاز معیار «ربط حقوقی» نیست؛ فقط ترتیبِ قابل‌توضیح است.
   */
  matches: number;
}>;

export type SearchResult = Readonly<{
  /** واژه‌های نرمال‌شدهٔ پرسش (یکتا، به ترتیب ورود). */
  tokens: readonly string[];
  asOf: IsoDate;
  verifiedOnly: boolean;
  hits: readonly SearchHit[];
  /** بیش از `limit` نتیجه بوده است. */
  hasMore: boolean;
  /**
   * شمار نتیجه‌هایی که **حذف شدند** چون نمایه با متن فعلی نمی‌خواند (متن اصلاح شده و `reindexSearch` اجرا نشده، یا قاعدهٔ نرمال‌سازی عوض شده).
   * اگر > ۰ است، بازیابی ناقص است: `reindexSearch()` را اجرا کنید. متنِ کهنه هرگز برگردانده نمی‌شود.
   */
  staleSkipped: number;
}>;

export type ReindexReport = Readonly<{
  /** نسخه‌هایی که تازه نمایه شدند. */
  indexed: number;
  /** نمایه‌هایی که بازسازی شدند (متن عوض شده یا قاعدهٔ نرمال‌سازی عوض شده). */
  updated: number;
  unchanged: number;
  /** نمایه‌های یتیم (نسخه‌ای که دیگر نیست) که پاک شدند. */
  removed: number;
  /** کل نسخه‌های پایگاه دانش. */
  totalVersions: number;
}>;

export type SearchStatus = Readonly<{
  totalVersions: number;
  indexed: number;
  /** نسخه‌ای که نمایه ندارد (در نتیجهٔ جست‌وجو دیده نمی‌شود). */
  missing: number;
  /** نمایه‌ای که با متن/قاعدهٔ فعلی نمی‌خواند. */
  stale: number;
  /** نمایه‌ای که نسخه‌اش نیست. */
  orphans: number;
  /** `true` فقط وقتی `missing = stale = orphans = 0`. */
  upToDate: boolean;
  /** اثر انگشتِ قاعدهٔ نرمال‌سازیِ کد فعلی. */
  keyFingerprint: string;
  migrations: readonly string[];
}>;
