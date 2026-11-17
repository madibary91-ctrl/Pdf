/**
 * نوع‌های رابط `ai-orchestrator` (برش ۱: ستون فقرات پرسش‌وپاسخ مستند؛ ADR-0016). هرچه `index.ts` صادر نکند داخلی است.
 *
 * اصل: ورودی‌های بیرونی (درخواست، پیکربندی) `unknown` فرض و روی مرز اعتبارسنجی می‌شوند؛ هیچ پیش‌فرضِ پنهانی دربارهٔ
 * ایمنی یا پول نیست؛ خطا و خروجی هرگز متن پرسش، متن بند، پاسخ خام مدل یا پیام خام پورت‌ها را نمی‌آورند.
 */
import type { Gateway, GatewayErrorCode, GatewayWarning, FinishReason, Usage, Cost } from "@/modules/ai-gateway";
import type { RetrievalErrorCode, Searcher } from "@/modules/retrieval";

// ───────────── پورت راستی‌آزمایی ─────────────

/** ادعای «این منبع (با همین ارجاع ساختاریافته) پشتوانهٔ ادعاست» + نقل‌قول اختیاری. */
export type SourceClaim = Readonly<{
  citation: Readonly<{ documentId: string; article: string; subpart: null }>;
  quote: string | null;
}>;

/** حکم یک ادعا. فقط `accepted: true` همراه `code: "valid"` پذیرفته می‌شود (دفاع در برابر آداپتور نادرست‌پیکربندی‌شده). */
export type ClaimVerdict = Readonly<{ accepted: boolean; code: string }>;

export type TextGuardOptions = Readonly<{ defaultDocumentId: string | null; marker: string }>;

/** نتیجهٔ نگهبان متن: متنِ پس از حذف ارجاع‌های آزادِ ردشده. */
export type TextGuardOutcome = Readonly<{ text: string; found: number; rejected: readonly Readonly<{ code: string }>[] }>;

/**
 * یک «نشست» = یک نمایهٔ ثابت برای کل یک درخواست. روش‌ها ممکن است پرتاب کنند؛ ارکستراتور پرتاب را
 * «راستی‌آزمایی ناممکن» می‌گیرد و هرگز آن را «پذیرفته» نمی‌شمارد.
 */
export type CitationSession = Readonly<{
  verifyClaims(claims: readonly SourceClaim[], asOf: string): readonly ClaimVerdict[];
  guardText(text: string, asOf: string, options: TextGuardOptions): TextGuardOutcome;
}>;

export type CitationChecker = Readonly<{ open(): CitationSession | Promise<CitationSession> }>;

// ───────────── پیکربندی ─────────────

export type RejectedCitationPolicy = "redact" | "withhold";

/**
 * ترمیم کنترل‌شده (ADR-0017). **اختیاری و صریح**: نبودنش = بی‌تلاش دوم (رفتار برش ۱). هیچ مقدار پیش‌فرضی ندارد.
 * `maxFirstAttemptSpendMicros`: سقفِ هزینهٔ **تا پیش از تلاش دوم** (واحد خرد؛ نه سقف کل). نامعلوم یا ارز دیگر ⇒ ترمیم نمی‌شود.
 */
export type RepairPolicy = Readonly<{ maxFirstAttemptSpendMicros: number; currency: string }>;

/** **بی‌پیش‌فرض**: `onRejectedCitation` و `requireQuotes` الزامی‌اند. توصیه برای رو به کاربر: `withhold` + `requireQuotes: true`. `repair` اختیاری است. */
export type AnswerPolicy = Readonly<{ onRejectedCitation: RejectedCitationPolicy; requireQuotes: boolean; repair?: RepairPolicy }>;

export type OrchestratorConfig = Readonly<{
  searcher: Searcher;
  /** هم `createGateway` و هم `createResilientGateway` (زیرنوع). اگر نتیجه `report` داشته باشد حسابداری از آن می‌آید. */
  gateway: Gateway;
  checker: CitationChecker;
  policy: AnswerPolicy;
}>;

// ───────────── ورودی ─────────────

export type RetrievalOptions = Readonly<{ limit?: number; maxTerms?: number; minCoverage?: number; maxQueries?: number }>;

/** ورودی `ask`. کلید ناشناخته رد می‌شود. `verifiedOnly` و `temperature` گزینه نیستند (همیشه `true` و `0`). */
export type AskInput = Readonly<{
  /** پرسش (۱…۲۰۰۰ نویسه). */
  question: string;
  /** **الزامی** (تاریخ تقویمی معتبر ISO)؛ ساعت سیستم پیش‌فرض ندارد. */
  asOf: string;
  /** **الزامی**: نام منطقی مدل در دروازه. */
  model: string;
  /** **الزامی**: سقف هزینهٔ خروجی پنهان نمی‌ماند. */
  maxOutputTokens: number;
  /** محدودکردن بازیابی به یک سند؛ همان سند «پیش‌فرض» نگهبان متن هم می‌شود. */
  documentId?: string;
  /** سقف نویسهٔ زمینه؛ ۲۰۰…۲۰۰٬۰۰۰؛ پیش‌فرض ۶۰۰۰ (پیش‌فرض خودِ `retrieval`). با حدّ ورودی مدل هم کوچک‌تر می‌شود. */
  contextMaxChars?: number;
  retrieval?: RetrievalOptions;
  /** شناسهٔ همبستگی؛ ساخته نمی‌شود و بی‌تغییر به دروازه می‌رسد. */
  requestId?: string;
  timeoutMs?: number;
}>;

export type ParsedAsk = Readonly<{
  question: string;
  asOf: string;
  model: string;
  maxOutputTokens: number;
  documentId: string | null;
  contextMaxChars: number;
  retrieval: RetrievalOptions;
  requestId: string | null;
  timeoutMs: number | null;
}>;

// ───────────── خطا ─────────────

export type OrchestratorErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_INPUT"
  | "UNKNOWN_MODEL"
  | "PROMPT_BUDGET"
  | "RETRIEVAL_FAILED"
  | "VERIFIER_UNAVAILABLE"
  | "GENERATION_FAILED"
  | "MODEL_OUTPUT_INVALID"
  | "VERIFICATION_FAILED"
  | "ABORTED"
  | "INTERNAL_ERROR";

export type OutputInvalidReason = "finish-reason" | "empty" | "too-large" | "bad-fence" | "not-json" | "not-object" | "missing-answer" | "bad-field";

/** حسابداریِ صادقانه؛ «نامعلوم» هرگز صفر نیست. `micros: null` = جمع از `2⁵³−1` گذشت. */
export type Accounting = Readonly<{
  /** `report`: از گزارش تاب‌آور؛ `completion`: فقط هزینهٔ تلاش موفق؛ `unknown`: شکستِ بی‌گزارش. */
  source: "report" | "completion" | "unknown";
  providerCalls: number | null;
  spend: readonly Readonly<{ currency: string; micros: number | null }>[];
  costUnknownCalls: number | null;
  retried: boolean;
  fellBack: boolean;
}>;

export type OrchestratorError = Readonly<{
  code: OrchestratorErrorCode;
  /** پیام فارسیِ ثابت؛ هرگز پرسش، متن بند، پاسخ خام مدل یا پیام خام پورت‌ها را نمی‌آورد. */
  message: string;
  /** تلاش دوباره بی‌دوباره‌خرجی ممکن است؟ نامطمئن ⇒ `false`. */
  retryable: boolean;
  /** فقط نام فیلد؛ هرگز محتوا. */
  issues?: readonly string[];
  gatewayCode?: GatewayErrorCode;
  retrievalCode?: RetrievalErrorCode;
  retryAfterMs?: number;
  reason?: OutputInvalidReason;
  /** `null` = پیش از هر فراخوانی مدل (هزینه‌ای نبوده) یا ناشناخته (`source: "unknown"` سخن می‌گوید). */
  accounting: Accounting | null;
}>;

export type OrchResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: OrchestratorError }>;

// ───────────── خروجی ─────────────

export type OrchestratorWarning =
  | "RETRIEVAL_INCOMPLETE"
  | "RETRIEVAL_RELAXED"
  | "CONTEXT_OMITTED"
  | "CONTEXT_TRUNCATED"
  | "MODEL_OUTPUT_FENCED"
  | "MODEL_OUTPUT_EXTRA_FIELDS"
  | "CITATION_REJECTED"
  | "TEXT_MENTION_REJECTED"
  | "UNMARKED_CITATION"
  | "UNSUPPORTED_NUMBERS"
  | "REPAIRED"
  | "REPAIR_FAILED";

export type AnswerStatus = "answered" | "answered-redacted" | "no-sources" | "model-abstained" | "withheld";
export type WithheldReason = "no-valid-citation" | "citation-rejected";

/** ارجاعِ پذیرفته‌شده و حاضر در متن نهایی. */
export type AnswerCitation = Readonly<{
  /** `S1`، `S2`، … همان شناسهٔ زمینه. */
  id: string;
  documentId: string;
  article: string;
  /** برچسب نمایشی همان زمینه (سند، ماده، بازهٔ اعتبار) بدون شناسه. */
  label: string;
  /** نقل‌قول‌های راستی‌آزمایی‌شدهٔ مدل (ممکن است تهی باشد وقتی `requireQuotes: false`). */
  quotes: readonly string[];
}>;

export type RejectionKind = "claim" | "marker" | "mention";

/** هرگز متن ردشده را ندارد: فقط نوع، شناسهٔ پاک‌سازی‌شده، کد و پیام ثابت. */
export type Rejection = Readonly<{ kind: RejectionKind; id: string | null; code: string; message: string }>;

export type RetrievalSummary = Readonly<{
  passages: number;
  sources: number;
  omitted: number;
  omittedUnverified: number;
  relaxed: boolean;
  incomplete: boolean;
  hasMore: boolean;
  budgetExhausted: boolean;
  queriesRun: number;
}>;

export type GenerationSummary = Readonly<{
  model: string;
  provider: string;
  servedModel: string | null;
  requestId: string | null;
  finishReason: FinishReason;
  /** مالِ **آخرین تلاش** است؛ کل در `accounting.spend`. */
  usage: Usage | null;
  cost: Cost | null;
  latencyMs: number;
  warnings: readonly GatewayWarning[];
}>;

export type Answer = Readonly<{
  status: AnswerStatus;
  /** `null` ⇔ نمایش پاسخی در کار نیست. هرگز متنِ بی‌ارجاعِ پذیرفته نیست. */
  text: string | null;
  withheldReason: WithheldReason | null;
  citations: readonly AnswerCitation[];
  rejections: readonly Rejection[];
  /** عددهای متنِ نهایی که در بندهای زمینه یا پرسش نیستند (هشدار؛ مسدودکننده نیست). */
  unsupportedNumbers: readonly string[];
  retrieval: RetrievalSummary;
  /** `null` وقتی مدل فراخوانی نشد. */
  generation: GenerationSummary | null;
  accounting: Accounting | null;
  warnings: readonly OrchestratorWarning[];
  asOf: string;
  promptVersion: string;
  /** فقط با `policy.repair`؛ بدون آن این کلید وجود ندارد (برش ۱ بی‌تغییر). */
  repair?: RepairSummary;
}>;

/** چرا تلاش دوم لازم دیده شد (ADR-0017 §۳). */
export type RepairTrigger = "citation-rejected" | "no-valid-citation" | "output-invalid";

/**
 * سرانجام ترمیم. `adopted`: نتیجهٔ تلاش دوم نمایش داده می‌شود · `not-improved`: انجام شد ولی اکیداً بهتر نبود · `failed`: تلاش دوم شکست خورد.
 * `skipped-*`: شرط پول یا لغو اجازه نداد؛ `not-needed`: چیزی برای ترمیم نبود (یا امتناع مدل، که هرگز ترمیم نمی‌شود)؛
 * `not-repairable`: علتِ ردّ از پایگاه است و بازنویسیِ مدل آن را درست نمی‌کند.
 */
export type RepairOutcome =
  | "not-needed"
  | "not-repairable"
  | "skipped-cost-cap"
  | "skipped-cost-unknown"
  | "skipped-aborted"
  | "adopted"
  | "not-improved"
  | "failed";

/** فقط وقتی `policy.repair` پیکربندی شده در `Answer` می‌آید. `attempts` = شمار فراخوانی‌های تولیدِ ارکستراتور (۰: مدل فراخوانی نشد). */
export type RepairSummary = Readonly<{ outcome: RepairOutcome; trigger: RepairTrigger | null; attempts: 0 | 1 | 2; promptVersion: string | null }>;

export type AskResult = OrchResult<Answer>;

export type Orchestrator = Readonly<{
  /** هرگز پرتاب نمی‌کند، حتی اگر هر پورتی پرتاب کند. */
  ask(input: unknown, options?: Readonly<{ signal?: AbortSignal }>): Promise<AskResult>;
}>;
