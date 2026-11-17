/** نوع‌های رابط `retrieval`. داخلی به‌جز آنچه `index.ts` صادر می‌کند. */
import type { HitSubpart, SearchInput, SearchResult, StoreErrorCode, StoreResult } from "./store-types";

/**
 * «پورت» جست‌وجو: هر چیزی که `searchArticles` را به‌شکل `KbStore` داشته باشد (خودِ `KbStore` یا یک ساختگی در تست).
 * بازیابی هرگز به پایگاه یا ساعت سیستم دست نمی‌زند؛ همه‌چیز از همین پورت و ورودی می‌آید.
 */
export type Searcher = Readonly<{ searchArticles(input: SearchInput): Promise<StoreResult<SearchResult>> }>;

export type RetrievalErrorCode = "INVALID_INPUT" | "EMPTY_QUERY" | "STORE_ERROR";

export type RetrievalError = Readonly<{
  code: RetrievalErrorCode;
  /** پیام فارسی؛ هرگز متن رکورد، SQL یا رشتهٔ اتصال نمی‌آورد. */
  message: string;
  /** برای `STORE_ERROR`: کد خطای ذخیره‌گاه. */
  storeCode?: StoreErrorCode;
}>;

export type RetrievalResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: RetrievalError }>;

/** ورودی `retrieve`. کلید ناشناخته `INVALID_INPUT` است (غلط املایی نباید پیش‌فرضِ ایمن را بی‌صدا دور بزند). */
export type RetrieveRequest = Readonly<{
  /** پرسش به زبان طبیعی (≤ ۲۰۰۰ نویسه). */
  question: string;
  /** **الزامی** (تاریخ ISO)؛ ساعت سیستم پیش‌فرض ندارد. */
  asOf: string;
  /** پیش‌فرض `true`: فقط نسخه‌های تأییدشدهٔ حقوقدان. */
  verifiedOnly?: boolean;
  documentId?: string;
  /** ۱…۱۰۰؛ پیش‌فرض ۱۰. */
  limit?: number;
  /** سقف واژه‌های محتوایی پرسش، ۱…۱۲؛ پیش‌فرض ۸. */
  maxTerms?: number;
  /** کمترین نسبت واژه‌های پرسش که یک نتیجه باید داشته باشد، (۰،۱]؛ پیش‌فرض ۰٫۶. ۱ = آرام‌سازی ندارد. */
  minCoverage?: number;
  /** سقف شمار فراخوانی‌های جست‌وجو برای یک پرسش، ۱…۶۴؛ پیش‌فرض ۱۲. */
  maxQueries?: number;
}>;

/** نتیجهٔ برنامه‌ریزی پرسش (خالص). */
export type QueryPlan = Readonly<{
  /** واژه‌های محتوایی نرمال‌شده، یکتا، به ترتیب ورود. */
  tokens: readonly string[];
  /** واژه‌های ربطی/پرکاربردی که کنار گذاشته شدند. */
  stopwords: readonly string[];
  /** واژه‌های بیش از ۶۴ نویسه: هرگز نمایه نمی‌شوند و پیدا نمی‌شوند. */
  unsearchable: readonly string[];
  /** واژه‌های محتوایی که به‌خاطر سقف `maxTerms` افتادند (کوتاه‌ترین‌ها؛ هرگز بی‌صدا). */
  truncated: readonly string[];
}>;

/** یک بند بازیابی‌شده؛ فقط داده‌ای از پایگاه (تأییدشده/نشده با `verified`). */
export type Passage = Readonly<{
  ref: Readonly<{ documentId: string; article: string; validFrom: string }>;
  /** ارجاعِ ساختاریافته‌ای که مستقیم به راستی‌آزمایی استناد (citation-verifier) داده می‌شود. */
  citation: Readonly<{ documentId: string; article: string; subpart: null }>;
  documentTitle: string;
  validTo: string | null;
  text: string;
  subparts: readonly HitSubpart[];
  verified: boolean;
  contentHash: string;
  /** واژه‌های پرسش که در متن (و تبصره/بندها) هست / نیست — محاسبهٔ محلی با همان `searchKey`ِ نمایه. */
  matchedTerms: readonly string[];
  missingTerms: readonly string[];
  /** `matchedTerms / همهٔ واژه‌های پرسش` در (۰،۱]. */
  coverage: number;
  /** جمع دفعات ظاهر شدن واژه‌های پرسش (همان تعریف store). معیار «ربط حقوقی» نیست. */
  score: number;
}>;

export type Retrieval = Readonly<{
  asOf: string;
  verifiedOnly: boolean;
  plan: QueryPlan;
  passages: readonly Passage[];
  /** نتیجهٔ بیشتری هم بود (سقف `limit` یا سقف ذخیره‌گاه). */
  hasMore: boolean;
  /** شمار فراخوانی‌های جست‌وجو. */
  queriesRun: number;
  /** آرام‌سازی (کم‌کردن واژه‌ها) به کار رفت؛ نتیجه‌های با `coverage < 1` ممکن است باشد. */
  relaxed: boolean;
  /** سقف `maxQueries` جلوی بررسی همهٔ گونه‌های آرام‌سازی را گرفت. */
  budgetExhausted: boolean;
  /** بیشترین `staleSkipped` گزارش‌شده (نمایهٔ کهنه). */
  staleSkipped: number;
  /** `staleSkipped > 0`: بازیابی ناقص است؛ `reindexSearch()` را اجرا کنید. */
  incomplete: boolean;
}>;

export type ContextOptions = Readonly<{
  /** سقف نویسهٔ کل متن زمینه؛ ۲۰۰…۲۰۰٬۰۰۰؛ پیش‌فرض ۶۰۰۰. */
  maxChars?: number;
  /** پیش‌فرض `false`: بند «تأییدنشده» وارد زمینه نمی‌شود (دفاع دوم؛ بازیابی هم پیش‌فرضش فقط‌تأییدشده است). */
  allowUnverified?: boolean;
}>;

export type ContextSource = Readonly<{
  /** `S1`، `S2`، … به ترتیب رتبه. مدل باید با همین شناسه ارجاع دهد، نه با متن آزاد. */
  id: string;
  citation: Passage["citation"];
  verified: boolean;
  header: string;
  body: string;
  /** متن این منبع به‌خاطر سقف برش خورد (علامت صریح در متن هم هست). */
  truncated: boolean;
}>;

export type Context = Readonly<{
  /** متن آمادهٔ پرامپت. */
  text: string;
  sources: readonly ContextSource[];
  /** شمار بندهایی که جا نشدند. */
  omitted: number;
  /** شمار بندهای تأییدنشده که طبق سیاست کنار گذاشته شدند. */
  omittedUnverified: number;
}>;
