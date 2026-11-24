/**
 * نوع‌های «سرویسِ پاسخِ محاسبه» (ADR-0061، برش CT‑5c‑1). این ماژول ریشهٔ ترکیبِ **بی‌I/O‌ی خودش** است:
 * هر وابستگیِ I/O (دروازه، تایمر) از بیرون تزریق می‌شود؛ `process.env`، کلید، آستانه‌های مالک و شبکه اینجا نیست.
 */
import type { ToolGateway, Timers } from "@/modules/ai-gateway";
import type { ComposedAnswer } from "@/modules/calc-answer-cards";
import type { CalcToolDeps } from "@/modules/calc-tools";
import type { ToolLoop, LoopOutcome } from "@/modules/tool-loop";

/** هزینهٔ اجرا (برای `metering` در برشِ بعد)؛ نسخهٔ ژرف‌یخ‌زده و جدا از گزارشِ اجرا. */
export type RunSpend = LoopOutcome["spend"];

export type CalcAnswerServiceOptions = Readonly<{
  /** دروازهٔ ابزار (از بیرون ساخته می‌شود: کلید و نقطهٔ پایانی با ریشهٔ I/O است). */
  gateway: ToolGateway;
  /** کنترل‌گرِ از پیش ساخته‌شده؛ آستانه‌های گام/هزینه را مالک می‌دهد. بی‌حالت است و میانِ اجراها مشترک. */
  loop: ToolLoop;
  /** نامِ مدلِ منطقی در دروازه؛ **الزامی و بی‌پیش‌فرض**. */
  model: string;
  /** سقفِ توکنِ خروجیِ هر گام؛ **الزامی و بی‌پیش‌فرض**. */
  maxOutputTokens: number;
  /** سقفِ کارت در هر اجرا (۱ تا `MAX_CARDS_CEILING`)؛ **الزامی و بی‌پیش‌فرض**. */
  maxCards: number;
  /** مهلتِ کلِ هر اجرا؛ **الزامی و بی‌پیش‌فرض**. */
  totalTimeoutMs: number;
  /** مهلتِ هر ابزار؛ **الزامی و بی‌پیش‌فرض**. */
  toolTimeoutMs: number;
  /** سقفِ نویسهٔ نتیجهٔ هر ابزار؛ **الزامی و بی‌پیش‌فرض**. */
  maxResultChars: number;
  /** جدول‌های تزریقی (پیش‌فرض: دادهٔ legal-calc). */
  deps?: CalcToolDeps;
  /** پیش‌فرض: تایمرِ جهانی. */
  timers?: Timers;
}>;

export type CreateErrorCode = "INVALID_OPTIONS";
export type CalcAnswerServiceError = Readonly<{ code: CreateErrorCode; message: string; /** فقط نامِ کلید و محدودیت؛ حداکثر ۱۰ مورد */ issues: readonly string[] }>;

export type AnswerErrorCode = "INVALID_INPUT" | "RUN_FAILED" | "NOT_DISPLAYABLE";

/**
 * پاسخِ ساخته‌نشدنی. **هرگز متنِ مدل، آرگومان یا نتیجهٔ ابزار را ندارد.** `spend` تا جایی که پولی خرج شده باقی می‌ماند
 * (برای `metering`)؛ پیش از هر تماس `null`.
 */
export type AnswerError = Readonly<{
  code: AnswerErrorCode;
  message: string;
  issues: readonly string[];
  /** کدِ ثابتِ لایهٔ زیرین (`RunnerErrorCode` یا `ComposeErrorCode`) یا `null`. */
  cause: string | null;
  spend: RunSpend | null;
}>;

export type CalcAnswer = Readonly<{
  /** آنچه رابط می‌تواند نمایش دهد (متنِ دست‌نخوردهٔ مدل + کارت‌ها + هشدارها). */
  answer: ComposedAnswer;
  /** هزینهٔ اجرا؛ حتی وقتی `answer.status === "stopped"`. */
  spend: RunSpend;
  steps: number;
  toolCalls: number;
}>;

export type AnswerInput = Readonly<{
  /** گفت‌وگوی عادی (همان قواعدِ دروازه: آخرین پیام `user`). فهرستِ ابزار و مدل را **فقط سرویس** می‌گذارد. */
  messages: readonly Readonly<{ role: "system" | "user" | "assistant"; content: string }>[];
  requestId?: string;
}>;

export type AnswerOptions = Readonly<{ signal?: AbortSignal }>;

export type AnswerResult = Readonly<{ ok: true; value: CalcAnswer }> | Readonly<{ ok: false; error: AnswerError }>;
export type CalcAnswerServiceResult = Readonly<{ ok: true; value: CalcAnswerService }> | Readonly<{ ok: false; error: CalcAnswerServiceError }>;

export type CalcAnswerService = Readonly<{
  /** هرگز پرتاب نمی‌کند. هر فراخوانی جمع‌آورنده، مجری و اجراگرِ تازهٔ خودش را دارد؛ فراخوانی‌های هم‌زمان با هم قاطی نمی‌شوند. */
  answer(input: unknown, options?: AnswerOptions): Promise<AnswerResult>;
}>;
