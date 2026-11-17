/**
 * نوع‌های رابط `ai-gateway` (برش ۱: هسته). هرچه `index.ts` صادر نکند داخلی است.
 *
 * اصل: همهٔ ورودی‌های بیرونی (درخواست، پیکربندی، پاسخ ارائه‌دهنده) `unknown` فرض و روی مرز اعتبارسنجی می‌شوند؛
 * هیچ پیش‌فرضِ پنهانی دربارهٔ پول یا ایمنی نیست (قیمت، ساعت و مدل‌های مجاز همه صریح‌اند).
 */

export type Role = "system" | "user" | "assistant";
export type ChatMessage = Readonly<{ role: Role; content: string }>;

/** دلیل پایان تولید؛ ارائه‌دهنده‌ها باید مقدارشان را به یکی از این‌ها بنگارند. `length` = پاسخ بریده شده. */
export type FinishReason = "stop" | "length" | "content_filter" | "other";

/**
 * درخواست تکمیل. کلید ناشناخته رد می‌شود (غلط املایی مثل `temprature` نباید بی‌صدا پیش‌فرض را بگذارد).
 * مقدار بیرون از بازه **رد** می‌شود، هرگز بی‌صدا «کوتاه» نمی‌شود.
 */
export type CompletionRequest = Readonly<{
  /** نام منطقی مدل؛ باید در `GatewayConfig.models` باشد. */
  model: string;
  /** حداکثر ۶۴ پیام؛ `system` فقط اولی و آخرین پیام `user`. */
  messages: readonly ChatMessage[];
  /** **الزامی**: سقف هزینهٔ خروجی پنهان نمی‌ماند؛ ۱…سقف مدل. */
  maxOutputTokens: number;
  /** ۰…۲؛ پیش‌فرض **۰** (قطعی‌ترین؛ نرم‌افزار حقوقی) و همیشه صریحاً به ارائه‌دهنده می‌رسد. */
  temperature?: number;
  /** حداکثر ۴ رشتهٔ یکتا، هر کدام ۱…۶۴ نویسه. */
  stopSequences?: readonly string[];
  /** شناسهٔ همبستگی (فقط `[A-Za-z0-9._:-]`، ≤۱۲۸)؛ دروازه خودش نمی‌سازد. */
  requestId?: string;
  /** ۱…۶۰۰٬۰۰۰ میلی‌ثانیه؛ پیش‌فرض: مهلت مدل، وگرنه مهلت پیش‌فرض دروازه. */
  timeoutMs?: number;
}>;

/** درخواست اعتبارسنجی‌شده با همهٔ پیش‌فرض‌های اِعمال‌شده. */
export type ParsedRequest = Readonly<{
  model: string;
  messages: readonly ChatMessage[];
  maxOutputTokens: number;
  temperature: number;
  stopSequences: readonly string[];
  requestId: string | null;
  timeoutMs: number;
}>;

/** آنچه به ارائه‌دهنده داده می‌شود: نام مدلِ خودِ ارائه‌دهنده و سیگنال لغو (در مهلت/لغو فعال می‌شود). */
export type ProviderCall = Readonly<{
  model: string;
  messages: readonly ChatMessage[];
  maxOutputTokens: number;
  temperature: number;
  stopSequences: readonly string[];
  signal: AbortSignal;
}>;

export type ProviderReply = Readonly<{
  text: string;
  finishReason: FinishReason;
  /** اگر ارائه‌دهنده گزارش نکند، مصرف «ناشناخته» است (`USAGE_MISSING`) و هرگز حدس زده نمی‌شود. */
  usage?: Readonly<{ inputTokens: number; outputTokens: number }>;
  /** مدلی که واقعاً پاسخ داد (برای ممیزی). */
  model?: string;
}>;

/**
 * پورت ارائه‌دهندهٔ مدل. پیاده‌سازی (مثلاً HTTP) در برش‌های بعدی است؛ هسته فقط این پورت را می‌شناسد.
 * ارائه‌دهنده می‌تواند پرتاب کند: `ProviderFailure` برای شکست‌های شناخته‌شده، هر چیز دیگر `PROVIDER_ERROR`.
 */
export type ModelProvider = Readonly<{ complete(call: ProviderCall): Promise<ProviderReply> }>;

/** قیمت‌گذاری نسخه‌دار؛ **هیچ قیمت واقعی‌ای در مخزن نیست**، همه از پیکربندی می‌آیند. */
export type PriceSpec = Readonly<{
  /** کد سه‌حرفی بزرگ مثل IRR. */
  currency: string;
  /** خرد-واحد (۱۰⁻⁶ واحد پول) به‌ازای هر یک میلیون توکن ورودی؛ صحیح، ۰…۱۰¹². */
  inputMicrosPerMTok: number;
  outputMicrosPerMTok: number;
  /** نسخهٔ جدول قیمت؛ در هر هزینه ثبت می‌شود تا ردیابی‌پذیر بماند. */
  version: string;
}>;

export type ModelSpec = Readonly<{
  /** کلید ارائه‌دهنده در `GatewayConfig.providers`. */
  provider: string;
  /** نامی که به ارائه‌دهنده فرستاده می‌شود. */
  providerModel: string;
  /** سقف مجموع نویسه‌های (UTF-16) همهٔ پیام‌ها. */
  maxInputChars: number;
  maxOutputTokens: number;
  /** **صریح**: `null` یعنی بدون قیمت (هزینه `null` + هشدار `UNPRICED`)؛ نبودن کلید خطاست. */
  price: PriceSpec | null;
  timeoutMs?: number;
}>;

export type Clock = Readonly<{ nowMs(): number }>;
export type Timers = Readonly<{ setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }>;

/** رویداد مصرف: هرگز متن پیام/پاسخ ندارد. */
export type UsageEvent = Readonly<{
  requestId: string | null;
  model: string;
  provider: string;
  providerModel: string;
  /** مدلی که ارائه‌دهنده گزارش کرد؛ ناشناخته ⇒ `null`. */
  servedModel: string | null;
  startedAtMs: number;
  latencyMs: number;
  /** `"ok"` یا کد خطا. شکست‌ها هم ثبت می‌شوند (ممکن است مصرف شده باشد). */
  outcome: "ok" | GatewayErrorCode;
  finishReason: FinishReason | null;
  /** `null` = ناشناخته (نه صفر). */
  usage: Usage | null;
  cost: Cost | null;
}>;

/** `record` باید سریع باشد؛ دروازه با مهلت `sinkTimeoutMs` منتظرش می‌ماند. */
export type UsageSink = Readonly<{ record(event: UsageEvent): void | Promise<void> }>;

export type GatewayConfig = Readonly<{
  providers: Readonly<Record<string, ModelProvider>>;
  models: Readonly<Record<string, ModelSpec>>;
  /** **الزامی**: ساعت سیستم پیش‌فرض ندارد. */
  clock: Clock;
  timers?: Timers;
  usageSink?: UsageSink;
  /** پیش‌فرض ۶۰٬۰۰۰. */
  defaultTimeoutMs?: number;
  /** پیش‌فرض ۵۰۰۰. */
  sinkTimeoutMs?: number;
}>;

export type Usage = Readonly<{ inputTokens: number; outputTokens: number; totalTokens: number }>;

/** هزینه به خرد-واحد (صحیح، رو به بالا گرد می‌شود: هیچ‌گاه کمتر از واقع). */
export type Cost = Readonly<{ micros: number; currency: string; priceVersion: string }>;

export type GatewayWarning =
  | "USAGE_MISSING"
  | "UNPRICED"
  | "OUTPUT_TRUNCATED"
  | "EMPTY_OUTPUT"
  | "USAGE_SINK_FAILED"
  | "USAGE_SINK_TIMEOUT"
  /** برش ۲: پیش از نتیجه دست‌کم یک تلاش دوباره بر همان مدل رفت؛ `cost`/`usage` فقط مالِ آخرین تلاش است (کل در `report.spend`). */
  | "RETRIED"
  /** برش ۲: دست‌کم یک تلاش بر مدل/ارائه‌دهندهٔ جایگزین رسید (داده به ارائه‌دهندهٔ دیگری رفته). */
  | "FELL_BACK";

export type Completion = Readonly<{
  text: string;
  finishReason: FinishReason;
  model: string;
  provider: string;
  servedModel: string | null;
  requestId: string | null;
  usage: Usage | null;
  cost: Cost | null;
  latencyMs: number;
  /** هیچ ناهنجاری‌ای پنهان نمی‌ماند: مثلاً بریده‌شدن پاسخ یا نبودن مصرف. */
  warnings: readonly GatewayWarning[];
}>;

export type GatewayErrorCode =
  | "INVALID_CONFIG"
  | "INVALID_REQUEST"
  | "UNKNOWN_MODEL"
  | "TIMEOUT"
  | "ABORTED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_AUTH"
  | "PROVIDER_REJECTED"
  | "PROVIDER_ERROR"
  | "PROVIDER_BAD_RESPONSE"
  | "INTERNAL_ERROR";

export type GatewayError = Readonly<{
  code: GatewayErrorCode;
  /** پیام فارسیِ ثابت؛ هرگز متن پیام کاربر، پیام خامِ ارائه‌دهنده، کلید یا نشانی نمی‌آورد. */
  message: string;
  /** تلاش دوباره (در برش‌های بعدی با سیاست تلاش) معنا دارد؟ نامطمئن ⇒ `false` (پرهیز از دوباره‌خرجی). */
  retryable: boolean;
  /** فقط وقتی ارائه‌دهنده عدد معتبر داد. */
  retryAfterMs?: number;
  /** فقط نام فیلد و محدودیت؛ هرگز محتوا. */
  issues?: readonly string[];
  warnings: readonly GatewayWarning[];
}>;

export type GatewayResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: GatewayError }>;

export type ModelLimits = Readonly<{ maxInputChars: number; maxOutputTokens: number; priced: boolean }>;

export type Gateway = Readonly<{
  /** هرگز پرتاب نمی‌کند، حتی اگر ارائه‌دهنده/ساعت/مقصد مصرف پرتاب کند. */
  complete(input: unknown, options?: Readonly<{ signal?: AbortSignal }>): Promise<GatewayResult<Completion>>;
  /** حدهای یک مدل (برای اندازه‌گیری زمینه)؛ مدل ناشناخته ⇒ `null`. */
  limits(model: string): ModelLimits | null;
}>;
