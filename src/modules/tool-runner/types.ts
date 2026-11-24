/**
 * نوع‌های «مجریِ حلقهٔ ابزار» (ADR-0058، برش CT‑4b). مجری همان حلقهٔ `while`ای است که `tool-loop` عمداً ننوشت:
 * کنش‌های کنترل‌گر را اجرا می‌کند (فراخوانیِ دروازه، اجرای ابزار) و هیچ سیاستی از خودش ندارد؛ سیاستِ ایست فقط در `tool-loop` است.
 */
import type { Timers, ToolCall, ToolGateway, ToolStepRequest } from "@/modules/ai-gateway";
import type { LoopOutcome, ToolLoop } from "@/modules/tool-loop";

export type RunnerErrorCode = "INVALID_CONFIG" | "INVALID_INPUT" | "MODEL_UNSUPPORTED" | "CONTRACT_VIOLATION" | "INTERNAL_ERROR";

/** خطای قرارداد/ساخت (باگِ مجری یا ورودیِ نادرست)، نه «ایستِ حلقه» (آن در `outcome` می‌آید). هرگز محتوای مدل/ابزار را بازتاب نمی‌دهد. */
export type RunnerError = Readonly<{
  code: RunnerErrorCode;
  /** پیامِ فارسیِ ثابت. */
  message: string;
  /** فقط نامِ فیلد و محدودیت؛ حداکثر ۱۰ مورد. */
  issues: readonly string[];
  /**
   * اگر خطا میانِ اجرا رخ داد و حلقه بسته شد: نتیجهٔ بسته‌شدهٔ حلقه (`CANCELLED`) با هزینهٔ تاکنون؛ پولِ خرج‌شده گم نمی‌شود.
   * پیش از شروعِ حلقه `null` است (هیچ هزینه‌ای نشده).
   */
  partial: LoopOutcome | null;
}>;

export type RunnerResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: RunnerError }>;

/** نتیجهٔ اجرای یک ابزار؛ آن را مجریِ ابزار (پورت) می‌سازد. `reviewPending` برای نتیجهٔ موفق **الزامی و بی‌پیش‌فرض** است. */
export type ToolExecution = Readonly<{ ok: true; content: string; reviewPending: boolean }> | Readonly<{ ok: false; content: string }>;

export type ToolExecutorContext = Readonly<{
  /** لغو می‌شود اگر مهلتِ ابزار گذشت یا فراخواننده/مهلتِ کلِ اجرا لغو کرد. اجراکننده باید آن را رعایت کند، ولی مجری به آن تکیه نمی‌کند. */
  signal: AbortSignal;
  callId: string;
}>;

/**
 * پورتِ اجرای ابزار. `call.argumentsJson` **اعتبارسنجی‌نشده** است و مرزِ اجرا (مثلاً calc-tools) آن را می‌سنجد.
 * می‌تواند پرتاب کند؛ پیامِ استثنا هرگز به مدل نمی‌رسد.
 */
export type ToolExecutor = (call: ToolCall, context: ToolExecutorContext) => Promise<ToolExecution> | ToolExecution;

export type ToolRunnerOptions = Readonly<{
  gateway: ToolGateway;
  /** کنترل‌گرِ از پیش ساخته‌شده؛ آستانه‌ها (گام، هزینه، …) را مالک با `createToolLoop` می‌دهد. */
  loop: ToolLoop;
  executeTool: ToolExecutor;
  /** مهلتِ کلِ یک اجرا (گام‌ها و ابزارها)؛ **الزامی و بی‌پیش‌فرض**. */
  totalTimeoutMs: number;
  /** مهلتِ هر ابزار؛ **الزامی و بی‌پیش‌فرض**. */
  toolTimeoutMs: number;
  /** سقفِ نویسهٔ نتیجهٔ هر ابزار؛ بزرگ‌تر ⇒ خطای ابزار (به مدل نمی‌رسد)؛ **الزامی و بی‌پیش‌فرض**. */
  maxResultChars: number;
  /** پیش‌فرض: تایمرِ جهانی. */
  timers?: Timers;
}>;

/**
 * درخواستِ پایه: همهٔ کلیدهای `ToolStepRequest` به‌جز `continuation` (آن را حلقه می‌سازد). `maxOutputTokens` سقفِ گام‌های عادی است.
 * فهرستِ `tools` هم به مدل می‌رود و هم **فهرستِ مجازِ نام** است: فراخوانیِ ابزارِ بیرون از آن اجرا نمی‌شود.
 */
export type ToolRunInput = Omit<ToolStepRequest, "continuation">;

export type ToolRunOptions = Readonly<{ signal?: AbortSignal }>;

/** چرایی شکستِ یک اجرای ابزار؛ فهرستِ بسته. */
export type ToolFailureCode = "UNKNOWN_TOOL" | "TOOL_TIMEOUT" | "TOOL_ABORTED" | "TOOL_FAILED" | "TOOL_RESULT_INVALID" | "TOOL_RESULT_TOO_LARGE" | "TOOL_REPORTED_ERROR";

/** رکوردِ ممیزیِ یک فراخوانی؛ **بی‌آرگومان و بی‌نتیجه** (ممکن است دادهٔ پروندهٔ کاربر باشد). */
export type ToolRunRecord = Readonly<{
  id: string;
  name: string;
  status: "ok" | "error";
  /** برای `ok` ⇒ `null`. */
  code: ToolFailureCode | null;
  reviewPending: boolean;
}>;

export type RunReport = Readonly<{
  outcome: LoopOutcome;
  /** چه کسی اجرا را لغو کرد (اولین علت)؛ `null` = لغوی نبود. با `outcome.reason === "CANCELLED"` یکی نیست (لغو حینِ گام ⇒ `STEP_FAILED/ABORTED`). */
  abortedBy: "caller" | "deadline" | null;
  /** فراخوانی‌هایی که شروع شدند، به ترتیبِ اجرا (شاملِ ابزارِ لغوشده حین اجرا: `TOOL_ABORTED`). */
  toolRuns: readonly ToolRunRecord[];
}>;

export type ToolRunner = Readonly<{
  /** هرگز پرتاب نمی‌کند و هرگز نمی‌ماند؛ حتی با مدلِ/ابزارِ بی‌پایان بعد از `totalTimeoutMs` بسته می‌شود. */
  run(input: unknown, options?: ToolRunOptions): Promise<RunnerResult<RunReport>>;
}>;
