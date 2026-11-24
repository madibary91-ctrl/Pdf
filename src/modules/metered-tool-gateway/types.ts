/**
 * نوع‌های «دروازهٔ ابزارِ اندازه‌گیرشده» (ADR-0062، برش MT-1). این ماژول **خودش یک `ToolGateway`** است و پیش از هر گامِ مدل با ابزار
 * بدترین‌هزینه را در دفتر اعتبار رزرو و پس از آن هزینهٔ واقعی را تسویه می‌کند. دفتر و دروازهٔ درونی از بیرون تزریق می‌شوند.
 */
import type { ModelLimits, ToolGateway, ToolStepCompletion, ToolStepError } from "@/modules/ai-gateway";
import type { AccountKey, Ledger } from "@/modules/ledger";
import type { MeteredModel, MeteringAlarm, MeteringConfigError, MeteringOutcome, MeteringReceipt, OnUnknownCost } from "@/modules/metering";

/** گزینه‌ها: همان کلیدهای `MeteringConfig` جز `fallbacks`/`maxProviderCalls` (دروازهٔ ابزار تلاشِ دوباره و جایگزین ندارد؛ هر گام دقیقاً یک تماس است). */
export type MeteredToolGatewayOptions = Readonly<{
  /** دروازهٔ ابزارِ درونی (`createToolGateway`). فقط پس از رزروِ موفق و تازه صدا زده می‌شود. */
  gateway: ToolGateway;
  ledger: Ledger;
  /** حساب باید از پیش باز و با واحد `<ارز>_MICROS` باشد. */
  account: AccountKey;
  /** کد سه‌حرفیِ بزرگ (مثل `IRR`). */
  currency: string;
  /** **همان** جدولِ مدل‌های دروازه (قیمت و سقفِ خروجی)؛ ناهمخوانی با `gateway.limits` در ساخت رد می‌شود. */
  models: Readonly<Record<string, MeteredModel>>;
  /** دامنهٔ یکتایی؛ رزرو `<scopeId>.r<n>`. **برای هر پرسش یک شناسهٔ تازه**؛ استفادهٔ دوباره ⇒ `SCOPE_REUSED`. */
  scopeId: string;
  /** عمر رزرو؛ باید از زمانِ کلِ یک گام بیشتر باشد. */
  reservationTtlMs: number;
  /** سربارِ قالبِ هر پیام/بخش (توکن)؛ **بی‌پیش‌فرض**. برای ابزارها گشاده‌دستانه بگذارید (قالبِ ابزارِ ارائه‌دهنده دیده نمی‌شود). */
  perMessageOverheadTokens: number;
  onUnknownCost: OnUnknownCost;
}>;

export type MeteredStepCompletion = ToolStepCompletion & Readonly<{ metering: MeteringReceipt }>;
export type MeteredStepError = ToolStepError & Readonly<{ metering: MeteringReceipt }>;
export type MeteredStepResult = Readonly<{ ok: true; value: MeteredStepCompletion }> | Readonly<{ ok: false; error: MeteredStepError }>;

/** جمعِ رسیدهای یک نمونه (= یک پرسش). مبلغ‌ها در سرریز به `Number.MAX_SAFE_INTEGER` می‌چسبند و `needsAttention` را برمی‌افرازد. */
export type MeterSummary = Readonly<{
  calls: number;
  reserved: number;
  charged: number;
  shortfall: number;
  outcomes: Readonly<Record<MeteringOutcome, number>>;
  /** یکتا و مرتب. */
  alarms: readonly MeteringAlarm[];
  /** هر زنگ، یا نتیجهٔ `unbilled`/`settlement-failed`/`forfeited`، یا سرریزِ جمع. */
  needsAttention: boolean;
  /** فهرستِ `receipts()` از سقف گذشته و فقط قدیمی‌ترین‌ها نگه داشته شده‌اند؛ جمع‌ها همچنان کامل‌اند. */
  receiptsTruncated: boolean;
}>;

/** ساختاراً زیرنوعِ `ToolGateway`: `calc-answer-service`/`tool-runner` بی‌تغییر آن را می‌گیرند. */
export type MeteredToolGateway = Readonly<{
  completeStep(input: unknown, options?: Readonly<{ signal?: AbortSignal }>): Promise<MeteredStepResult>;
  toolFormat: ToolGateway["toolFormat"];
  limits(model: string): ModelLimits | null;
  /** رسیدهای بی‌متن به ترتیبِ شروعِ گام‌ها (کپیِ یخ‌زده). */
  receipts(): readonly MeteringReceipt[];
  summary(): MeterSummary;
}>;

export type MeteredToolGatewayResult = Readonly<{ ok: true; value: MeteredToolGateway }> | Readonly<{ ok: false; error: MeteringConfigError }>;
