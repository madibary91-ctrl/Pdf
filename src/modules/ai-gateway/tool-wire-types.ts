/**
 * نوع‌های رمزگذارِ «ابزار روی سیم» (ADR-0054، برش CT‑3a). این‌جا فقط شکل‌ها هستند؛ هیچ I/O و هیچ وابستگی به ماژول دیگر نیست.
 *
 * ai-gateway طبقِ registry فقط به shared-types وابسته است و `calc-tools` را نمی‌شناسد؛ پس «توصیفِ ابزار» را ساختاری
 * (`ToolSpec`) تعریف می‌کنیم و `CalcToolDescriptor` عیناً با آن سازگار است (آزمونِ tooling این را می‌سنجد).
 */

/** قالب‌های سیمِ پشتیبانی‌شده. */
export type ToolWireFormat = "openai-chat" | "anthropic-messages";

/** توصیفِ مستقل از ارائه‌دهندهٔ یک ابزار؛ `parameters` باید JSON Schemaِ از نوع `object` باشد. */
export type ToolSpec = Readonly<{
  name: string;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
}>;

/** `none` = مدل ابزار نخواند؛ `required` = دست‌کم یک ابزار؛ `{ name }` = دقیقاً همین ابزار. پیش‌فرض: `auto`. */
export type ToolChoice = "auto" | "none" | "required" | Readonly<{ name: string }>;

export type EncodeToolsOptions = Readonly<{
  choice?: ToolChoice;
  /** پیش‌فرض `false`: یک ابزار در هر گام (قطعی‌تر و ساده‌تر برای ممیزی). */
  allowParallel?: boolean;
}>;

/** یک فراخوانیِ ابزار از مدل. `argumentsJson` متنِ خام است و **اعتبارسنجی نشده** (نه حتی لزوماً JSON)؛ مرزِ اجرا آن را می‌سنجد. */
export type ToolCall = Readonly<{ id: string; name: string; argumentsJson: string }>;

/** پایانِ تولید؛ همان `FinishReason`ِ دروازه به‌علاوهٔ `tool_calls`. */
export type ToolFinish = "stop" | "length" | "content_filter" | "other" | "tool_calls";

export type ToolWireUsage = Readonly<{ inputTokens: number; outputTokens: number }>;

/** پیامِ دستیار به قالبِ سیمِ همان ارائه‌دهنده (از دادهٔ سنجیده‌شده ساخته می‌شود، نه عبورِ خام) برای افزودن به گفت‌وگوی گام بعد. */
export type WireMessage = Readonly<Record<string, unknown>>;

export type DecodedToolReply = Readonly<{
  /** متنِ دستیار؛ ممکن است تهی باشد (فقط ابزار صدا زده). */
  text: string;
  /** برای `finish: "tool_calls"` ناتهی است و برای بقیه تهی. */
  toolCalls: readonly ToolCall[];
  finish: ToolFinish;
  /** `null` = ناشناخته (نه صفر)؛ هرگز حدس زده نمی‌شود. */
  usage: ToolWireUsage | null;
  servedModel: string | null;
  /** پیامِ دستیار برای بازگرداندن به مدل در گام بعد (پیش از نتیجهٔ ابزارها). */
  assistantMessage: WireMessage;
}>;

export type ToolWireErrorCode = "INVALID_TOOLS" | "INVALID_TOOL_RESULTS" | "BAD_RESPONSE" | "TRUNCATED_TOOL_CALL";

export type ToolWireError = Readonly<{
  code: ToolWireErrorCode;
  /** پیامِ فارسیِ ثابت؛ هرگز محتوای مدل/کاربر را بازتاب نمی‌دهد. */
  message: string;
  /** فقط نامِ فیلد و محدودیت (نامِ کلید تا ۴۰ نویسه)؛ حداکثر ۱۰ مورد. */
  issues: readonly string[];
  /** فقط برای خطاهای رمزگشایی: مصرفِ معتبرِ گزارش‌شده حتی وقتی پاسخ خراب است (برای ثبتِ هزینه). */
  usage: ToolWireUsage | null;
}>;

export type ToolWireResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: ToolWireError }>;

/** نتیجهٔ اجرای یک ابزار برای بازگرداندن به مدل. */
export type ToolResultInput = Readonly<{ id: string; content: string; isError?: boolean }>;
