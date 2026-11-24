/**
 * نوع‌های «کنترل‌گرِ خالصِ حلقهٔ ابزار» (ADR-0056، برش CT‑4a). این‌جا فقط شکل‌ها هستند.
 *
 * کنترل‌گر یک **ماشینِ حالتِ خالص** است: هیچ مدلی را صدا نمی‌زند، هیچ ابزاری را اجرا نمی‌کند و ساعت/تصادف/I/O ندارد.
 * «مجری» (برشِ بعد) هر `action` را اجرا می‌کند و نتیجه را به کنترل‌گر برمی‌گرداند؛ تمامِ سیاستِ ایست (سقفِ گام، سقفِ فراخوانی،
 * سقفِ هزینه، تکرارِ بی‌پایان، بریدگیِ فراخوانی) این‌جا و فقط این‌جا تصمیم‌گیری می‌شود.
 */
import type { StepSpend, ToolCall, ToolWireFormat, WireMessage } from "@/modules/ai-gateway";

/** کدِ خطای قرارداد (سوءاستفاده از کنترل‌گر)، نه «ایستِ حلقه». هرگز محتوای مدل را بازتاب نمی‌دهد. */
export type LoopErrorCode = "INVALID_CONFIG" | "INVALID_INPUT" | "INVALID_STATE" | "INVALID_EVENT" | "INVALID_RESULTS";

export type LoopError = Readonly<{
  code: LoopErrorCode;
  /** پیامِ فارسیِ ثابت. */
  message: string;
  /** فقط نامِ فیلد و محدودیت؛ هرگز محتوا. حداکثر ۱۰ مورد. */
  issues: readonly string[];
}>;

export type LoopResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: LoopError }>;

/** ورودیِ برآوردگرِ بدترین هزینهٔ گامِ بعد (مجری آن را از `metering` می‌سازد؛ کنترل‌گر قیمت نمی‌شناسد). */
export type StepEstimateInput = Readonly<{
  /** شمارهٔ گامی که قرار است شروع شود (۱‑مبنا). */
  step: number;
  /** سقفِ خروجیِ همین گام (در تلاشِ دوبارهٔ بریدگی بزرگ‌تر از پایه است). */
  maxOutputTokens: number;
  /** اندازهٔ JSONِ `continuation` تا این لحظه (نویسه)؛ ورودیِ گامِ بعد با آن رشد می‌کند. */
  continuationChars: number;
}>;

/**
 * سیاستِ هزینه. **الزامی و بی‌پیش‌فرض** است (تصمیمِ مالک): یا صریحاً `none` یا سقف.
 * `cap`: پیش از هر گامِ مدل باید «هزینهٔ معلومِ تاکنون + بدترین هزینهٔ این گام ≤ maxMicros» ثابت شود، وگرنه ایست.
 */
export type BudgetPolicy =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "cap";
      /** کدِ سه‌حرفیِ ارز (مثل IRR)؛ هزینهٔ هر ارزِ دیگر قابل‌مقایسه نیست و ⇒ `SPEND_UNKNOWN`. */
      currency: string;
      /** سقفِ کلِ حلقه به خرد-واحد؛ صحیحِ مثبت و ≤ ۲⁵³−۱. */
      maxMicros: number;
      /** برآوردگرِ بدترین هزینهٔ یک گام؛ باید عددِ صحیحِ نامنفی (خرد-واحدِ همان ارز) بدهد؛ پرتاب/مقدارِ نامعتبر ⇒ `SPEND_UNKNOWN`. */
      estimateStepMicros: (input: StepEstimateInput) => number;
    }>;

export type ToolLoopConfig = Readonly<{
  /** سقفِ تعدادِ فراخوانیِ مدل (شاملِ تلاشِ دوبارهٔ بریدگی)؛ ۱ تا ۱۶. */
  maxSteps: number;
  /** سقفِ کلِ فراخوانی‌های ابزار در کلِ حلقه؛ ۱ تا ۶۴. */
  maxToolCalls: number;
  /** حداکثرِ دفعاتی که یک فراخوانیِ یکسان (نام + آرگومانِ هم‌ارز) در کلِ حلقه مجاز است؛ ۱ تا ۱۶. */
  maxIdenticalCalls: number;
  /** حداکثرِ تلاشِ دوبارهٔ «فراخوانیِ بریده» با سقفِ خروجیِ بزرگ‌تر؛ ۰ تا ۲. ۰ = هرگز. */
  truncationRetries: number;
  budget: BudgetPolicy;
}>;

/** ورودیِ شروعِ حلقه. */
export type LoopStartInput = Readonly<{
  /** قالبِ سیمِ مدل (`toolGateway.toolFormat(model)`). */
  format: ToolWireFormat;
  /** سقفِ خروجیِ گام‌های عادی. */
  maxOutputTokens: number;
  /** سقفِ خروجیِ مدل (`toolGateway.limits(model).maxOutputTokens`)؛ تلاشِ دوباره از آن فراتر نمی‌رود. */
  modelMaxOutputTokens: number;
}>;

export type LoopPhase = "awaiting-step" | "awaiting-tools" | "done";

/** حالتِ حلقه؛ **تغییرناپذیر** و فقط توسطِ `ToolLoop` ساخته می‌شود. */
export type ToolLoopState = Readonly<{
  phase: LoopPhase;
  format: ToolWireFormat;
  baseMaxOutputTokens: number;
  modelMaxOutputTokens: number;
  /** سقفِ خروجیِ گامِ جاری/بعدی. */
  maxOutputTokens: number;
  steps: number;
  toolCalls: number;
  truncationRetriesUsed: number;
  continuation: readonly WireMessage[];
  /** مصرف/هزینهٔ هر گامِ رسیده به ارائه‌دهنده (موفق یا ناموفق). */
  entries: readonly Readonly<{ usage: unknown; cost: unknown }>[];
  /** شمارشِ فراخوانی‌های یکسان: `[کلیدِ هم‌ارز, تعداد]`. */
  callCounts: readonly (readonly [string, number])[];
  seenCallIds: readonly string[];
  pending: Readonly<{ calls: readonly ToolCall[]; assistantMessage: WireMessage }> | null;
  reviewPending: boolean;
}>;

/** دلیلِ ایستِ حلقه بی‌پاسخِ نهایی. */
export type StopReason =
  | "MAX_STEPS"
  | "MAX_TOOL_CALLS"
  | "BUDGET_EXCEEDED"
  | "SPEND_UNKNOWN"
  | "REPEATED_CALL"
  | "DUPLICATE_CALL_ID"
  | "TRUNCATED_TOOL_CALL"
  | "OUTPUT_TRUNCATED"
  | "MODEL_FILTERED"
  | "UNEXPECTED_FINISH"
  | "EMPTY_ANSWER"
  | "STEP_FAILED"
  | "CONTINUATION_LIMIT"
  | "CANCELLED";

type OutcomeBase = Readonly<{
  /** گام‌های رسیده به ارائه‌دهنده. */
  steps: number;
  /** فراخوانی‌های ابزاری که به مجری سپرده شد (فراخوانیِ ردشده یا بی‌اجرا ایست‌شده شمرده نمی‌شود). */
  toolCalls: number;
  /** جمعِ هزینه حتی در ایست: پولِ خرج‌شده گم نمی‌شود. */
  spend: StepSpend;
  /**
   * `true` اگر دست‌کم یک نتیجهٔ موفقِ ابزار از دادهٔ «تأییدنشده» بود. مصرف‌کننده **باید** کنارِ پاسخ نشانش دهد.
   * در ایست هم گزارش می‌شود (نتیجهٔ جزئی ممکن است در جای دیگر دیده شده باشد).
   */
  reviewPending: boolean;
}>;

export type LoopOutcome =
  | (OutcomeBase & Readonly<{ status: "answered"; text: string }>)
  /** هیچ متنی نمی‌دهد: پاسخِ ناتمام/نامطمئن هرگز به‌عنوان پاسخ عبور نمی‌کند. `errorCode` فقط برای `STEP_FAILED` (فهرستِ بسته) وگرنه `null`. */
  | (OutcomeBase & Readonly<{ status: "stopped"; reason: StopReason; errorCode: string | null }>);

export type LoopAction =
  | Readonly<{ kind: "call-model"; step: number; continuation: readonly WireMessage[]; maxOutputTokens: number }>
  | Readonly<{ kind: "run-tools"; calls: readonly ToolCall[] }>
  | Readonly<{ kind: "done"; outcome: LoopOutcome }>;

export type LoopTransition = Readonly<{ state: ToolLoopState; action: LoopAction }>;

/** نتیجهٔ اجرای یک ابزار؛ مجری آن را می‌سازد. `reviewPending` برای نتیجهٔ موفق **الزامی** است (بی‌پیش‌فرض). */
export type LoopToolResult = Readonly<{ id: string; content: string; isError?: boolean; reviewPending?: boolean }>;

export type ToolLoop = Readonly<{
  /** هرگز پرتاب نمی‌کند. */
  start(input: unknown): LoopResult<LoopTransition>;
  /** نتیجهٔ `ToolGateway.completeStep` (ToolStepResult) را می‌پذیرد. */
  onStep(state: ToolLoopState, result: unknown): LoopResult<LoopTransition>;
  onToolResults(state: ToolLoopState, results: unknown): LoopResult<LoopTransition>;
  /** لغوِ مجری (مثلاً `AbortSignal`): حلقه با `CANCELLED` و هزینهٔ تاکنون بسته می‌شود. */
  cancel(state: ToolLoopState): LoopResult<LoopTransition>;
}>;
