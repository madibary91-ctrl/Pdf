/**
 * نوع‌های «گامِ ابزار» در دروازه (ADR-0055، برش CT‑3b). **افزایشی**: `ModelProvider`، `CompletionRequest`، `Completion`،
 * `Gateway` و `GatewayErrorCode` دست نخورده‌اند؛ ابزار از راهِ یک پورت و یک دروازهٔ جدا می‌آید تا هیچ مصرف‌کنندهٔ موجود نشکند.
 */
import type { Cost, GatewayError, GatewayResult, GatewayWarning, ModelLimits, Usage } from "./types";
import type { ToolCall, ToolChoice, ToolFinish, ToolSpec, ToolWireFormat, WireMessage } from "./tool-wire-types";

type StepMessage = Readonly<{ role: "system" | "user" | "assistant"; content: string }>;

/** آنچه به ارائه‌دهندهٔ ابزار داده می‌شود؛ همهٔ بخش‌ها سنجیده و یخ‌زده‌اند. */
export type ToolProviderCall = Readonly<{
  /** نام مدل نزد ارائه‌دهنده. */
  model: string;
  format: ToolWireFormat;
  /** گفت‌وگوی عادی (همان قواعدِ `CompletionRequest`: آخرین پیام `user`). */
  messages: readonly StepMessage[];
  /** بخشِ ابزارِ بدنهٔ درخواست (خروجیِ `encodeTools`)؛ ارائه‌دهنده آن را با بدنه ادغام می‌کند. */
  tools: WireMessage;
  /** ادامهٔ گفت‌وگو پس از `messages`: پیامِ دستیارِ گام قبل + نتیجهٔ ابزارها، به قالبِ سیمِ همین ارائه‌دهنده. */
  continuation: readonly WireMessage[];
  maxOutputTokens: number;
  temperature: number;
  stopSequences: readonly string[];
  signal: AbortSignal;
}>;

/**
 * پورتِ ارائه‌دهندهٔ ابزار. **بدنهٔ خامِ پاسخ** (JSONِ نامطمئن در قالبِ `format`) را برمی‌گرداند؛ تفسیرِ آن کارِ دروازه است
 * (`decodeToolReply`)، نه آداپتور. می‌تواند پرتاب کند: `ProviderFailure` برای شکستِ شناخته‌شده، هر چیزِ دیگر `PROVIDER_ERROR`.
 */
export type ToolModelProvider = Readonly<{ completeWithTools(call: ToolProviderCall): Promise<unknown> }>;

/** نگاشتِ مدلِ منطقی به قالبِ سیم و ارائه‌دهندهٔ ابزار؛ مدلِ منطقی باید در پیکربندیِ پایهٔ دروازه هم باشد (قیمت/حد/مهلت از آن‌جا). */
export type ToolModelSpec = Readonly<{ format: ToolWireFormat; provider: ToolModelProvider }>;
export type ToolSetup = Readonly<{ models: Readonly<Record<string, ToolModelSpec>> }>;

/** درخواستِ یک گام: همهٔ کلیدهای `CompletionRequest` (همان سخت‌گیری) + چهار کلیدِ ابزار. */
export type ToolStepRequest = Readonly<{
  model: string;
  messages: readonly StepMessage[];
  maxOutputTokens: number;
  temperature?: number;
  stopSequences?: readonly string[];
  requestId?: string;
  timeoutMs?: number;
  /** ۱ تا ۱۶ ابزار. */
  tools: readonly ToolSpec[];
  toolChoice?: ToolChoice;
  /** پیش‌فرض `false`. */
  allowParallel?: boolean;
  /** پیام‌های گام‌های پیشین (قالبِ سیم). با پیامِ `assistant` شروع و نه با آن تمام می‌شود. */
  continuation?: readonly WireMessage[];
}>;

export type ToolStepCompletion = Readonly<{
  text: string;
  toolCalls: readonly ToolCall[];
  /** `tool_calls` ⇔ `toolCalls` ناتهی. */
  finish: ToolFinish;
  /** برای افزودن به `continuation`ِ گام بعد (پیش از نتیجهٔ ابزارها). */
  assistantMessage: WireMessage;
  format: ToolWireFormat;
  model: string;
  provider: string;
  servedModel: string | null;
  requestId: string | null;
  usage: Usage | null;
  cost: Cost | null;
  latencyMs: number;
  warnings: readonly GatewayWarning[];
}>;

/**
 * خطای یک گام. ساختاراً زیرنوعِ `GatewayError` است؛ `usage`/`cost` مصرفِ **این گام** را حتی در شکست می‌دهد
 * (پاسخِ بریده یا خراب هزینه شده است). پیش از رسیدن به ارائه‌دهنده هر دو `null` است.
 */
export type ToolStepError = GatewayError & Readonly<{ usage: Usage | null; cost: Cost | null }>;
export type ToolStepResult = Readonly<{ ok: true; value: ToolStepCompletion }> | Readonly<{ ok: false; error: ToolStepError }>;

export type ToolGateway = Readonly<{
  /** هرگز پرتاب نمی‌کند. */
  completeStep(input: unknown, options?: Readonly<{ signal?: AbortSignal }>): Promise<ToolStepResult>;
  /** قالبِ سیمِ یک مدلِ منطقی (برای `encodeToolResults` در حلقه)؛ مدلِ بی‌ابزار ⇒ `null`. */
  toolFormat(model: string): ToolWireFormat | null;
  limits(model: string): ModelLimits | null;
}>;

export type ToolGatewayResult = GatewayResult<ToolGateway>;

/** ورودیِ جمعِ هزینهٔ چندگامی (هر `ToolStepCompletion` یا `ToolStepError` با آن سازگار است). */
export type StepSpendInput = Readonly<{ usage: Usage | null; cost: Cost | null }>;

export type StepSpend = Readonly<{
  steps: number;
  /** جمعِ مصرفِ گام‌های **معلوم**؛ گام‌های نامعلوم در `unknownUsageSteps` می‌آیند و حدس زده نمی‌شوند. */
  usage: Usage;
  unknownUsageSteps: number;
  /** جمعِ هزینه به‌تفکیکِ ارز و نسخهٔ قیمت؛ `micros: null` = جمع از `2⁵³−1` گذشت. */
  cost: readonly Readonly<{ currency: string; priceVersion: string; micros: number | null }>[];
  unknownCostSteps: number;
  /** همهٔ گام‌ها مصرف و هزینهٔ معلوم داشتند و هیچ جمعی سرریز نشد. */
  complete: boolean;
}>;
