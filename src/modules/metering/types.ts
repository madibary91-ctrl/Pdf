/**
 * metering — نوع‌ها (ADR-0020). هرچه `index.ts` صادر نکند داخلی است.
 *
 * اصل: ورودی‌های بیرونی (پیکربندی، درخواست، نتیجهٔ دروازه) `unknown` فرض و روی مرز اعتبارسنجی می‌شوند؛ رسیدها هرگز متن پیام/پاسخ،
 * کلید، نشانی یا پیام خام پورت‌ها را نمی‌آورند؛ «هزینهٔ نامعلوم» هرگز صفر نیست.
 */
import type { Completion, Gateway, GatewayError, ModelLimits, PriceSpec } from "@/modules/ai-gateway";
import type { AccountKey, Ledger, LedgerErrorCode } from "@/modules/ledger";

/** سیاست هزینهٔ نامعلوم (ADR-0020 تصمیم ۵): **الزامی و بی‌پیش‌فرض**. `forfeit` = مصرف‌شدهٔ صریح؛ `release` = آزاد، هر دو با زنگ `COST_UNKNOWN`. */
export type OnUnknownCost = "forfeit" | "release";

/** هر مدلِ جدول: فقط `price` و `maxOutputTokens` خوانده می‌شود (پس همان `GatewayConfig.models` را می‌شود داد؛ میدان‌های دیگر نادیده‌اند). */
export type MeteredModel = Readonly<{ price: PriceSpec | null; maxOutputTokens: number }>;

export type MeteringConfig = Readonly<{
  /** دروازهٔ درونی: ساده یا تاب‌آور. فقط پس از رزروِ موفق و تازه صدا زده می‌شود. */
  gateway: Gateway;
  ledger: Ledger;
  /** حسابِ همین نمونه؛ مستأجر را لایهٔ هویت (م۲) از نشست می‌آورد. حساب باید از پیش باز و با واحد `unitForCurrency(currency)` باشد. */
  account: AccountKey;
  /** کد سه‌حرفی بزرگِ ارز (مثل `IRR`)؛ واحد حساب `<ارز>_MICROS`. */
  currency: string;
  /** همان جدول مدل‌های دروازه (برای قیمت و سقف خروجی). */
  models: Readonly<Record<string, MeteredModel>>;
  /** مدل اصلی ← جایگزین‌ها؛ باید با سیاست دروازهٔ تاب‌آور یکی باشد (بدترین حالت روی همهٔ زنجیره سنجیده می‌شود). پیش‌فرض: بی‌جایگزین. */
  fallbacks?: Readonly<Record<string, readonly string[]>>;
  /** دامنهٔ یکتایی (ADR-0020 تصمیم ۳): فراخواننده می‌دهد؛ رزرو `<scopeId>.r<n>`. استفادهٔ دوباره ⇒ `SCOPE_REUSED`. */
  scopeId: string;
  /** عمر رزرو؛ باید از زمان کل یک `complete` (شامل تلاش‌ها و انتظارها) بیشتر باشد. ۱ثانیه…۲۴ساعت. */
  reservationTtlMs: number;
  /** ۱…۲۰؛ سقف تماس‌های رسیده به ارائه‌دهنده در یک `complete` (= `maxTotalAttempts` دروازهٔ تاب‌آور؛ ساده: ۱). */
  maxProviderCalls: number;
  /** ۰…۱۰۰۰؛ سربار قالب پیام به ازای هر پیام (توکن). **بی‌پیش‌فرض** (هر ارائه‌دهنده فرق دارد). */
  perMessageOverheadTokens: number;
  onUnknownCost: OnUnknownCost;
}>;

export type ResolvedModel = Readonly<{ price: PriceSpec | null; maxOutputTokens: number }>;

export type ResolvedMeteringConfig = Readonly<{
  gateway: Gateway;
  ledger: Ledger;
  account: AccountKey;
  currency: string;
  unit: string;
  models: ReadonlyMap<string, ResolvedModel>;
  fallbacks: ReadonlyMap<string, readonly string[]>;
  scopeId: string;
  reservationTtlMs: number;
  maxProviderCalls: number;
  perMessageOverheadTokens: number;
  onUnknownCost: OnUnknownCost;
}>;

export type MeteringConfigError = Readonly<{ code: "INVALID_CONFIG"; message: string; issues: readonly string[] }>;
export type MeteringResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: MeteringConfigError }>;

/** چرایی ردِ پیش از تماس. */
export type RefusalCode =
  | "INVALID_REQUEST"
  | "UNKNOWN_MODEL"
  | "UNPRICED_MODEL"
  | "CURRENCY_MISMATCH"
  | "ESTIMATE_OVERFLOW"
  | "INSUFFICIENT_CREDIT"
  | "ACCOUNT_NOT_FOUND"
  | "TOO_MANY_OPEN_RESERVATIONS"
  | "SCOPE_REUSED"
  | "RESERVE_FAILED";

export type MeteringAlarm =
  /** مصرف از باقیماندهٔ رزرو بیشتر بود (کران ورودی کم بود): مازاد وصول‌نشده؛ زنگ عملیاتی. */
  | "SHORTFALL"
  /** هزینهٔ تماس نامعلوم بود و طبق `onUnknownCost` تسویه شد. */
  | "COST_UNKNOWN"
  /** تماس انجام و هزینه شد ولی رزرو پیش از تسویه منقضی شده بود (ttl کم). */
  | "UNBILLED"
  /** تسویه (charge/close) پس از تلاش‌ها ثبت نشد؛ رزرو باز مانده و با سررسید آزاد می‌شود (رفتگر/outbox: م۳). */
  | "SETTLEMENT_PENDING"
  /** هزینه ثبت شد ولی بستنِ رزرو نشد؛ باقیمانده تا سررسید نگه داشته می‌ماند. */
  | "CLOSE_PENDING";

export type MeteringOutcome = "billed" | "released" | "forfeited" | "refused" | "unbilled" | "settlement-failed";

/** رسید اندازه‌گیری: فقط شناسه، مبلغ و کد. */
export type MeteringReceipt = Readonly<{
  outcome: MeteringOutcome;
  unit: string;
  /** `null` وقتی رزروِ تازه‌ای نشد (رد پیش از رزرو، یا `SCOPE_REUSED`). */
  reservationId: string | null;
  reserved: number;
  charged: number;
  shortfall: number;
  refusal?: Readonly<{ code: RefusalCode; ledgerCode?: LedgerErrorCode }>;
  alarms: readonly MeteringAlarm[];
}>;

export type MeteredCompletion = Completion & Readonly<{ metering: MeteringReceipt }>;
export type MeteredError = GatewayError & Readonly<{ metering: MeteringReceipt }>;
export type MeteredResult = Readonly<{ ok: true; value: MeteredCompletion }> | Readonly<{ ok: false; error: MeteredError }>;

/** ساختاراً زیرنوعِ `Gateway`: هر جا `Gateway` می‌خواهند (مثلاً ارکستراتور) می‌نشیند. */
export type MeteredGateway = Readonly<{
  complete(input: unknown, options?: Readonly<{ signal?: AbortSignal }>): Promise<MeteredResult>;
  limits(model: string): ModelLimits | null;
}>;
