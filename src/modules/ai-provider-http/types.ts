/**
 * نوع‌های ارائه‌دهندهٔ HTTPِ ابزار (ADR-0057، برش CT‑3c‑1). این ماژول **انتقال** است: بدنهٔ درخواست را به قالبِ سیمِ ارائه‌دهنده
 * می‌سازد، می‌فرستد و بدنهٔ **خامِ** پاسخ را برمی‌گرداند؛ تفسیرِ پاسخ کارِ `ai-gateway` (`decodeToolReply`) است.
 */
import type { ToolModelProvider, ToolWireFormat } from "@/modules/ai-gateway";

/**
 * پورتِ شبکه. `globalThis.fetch` عیناً با آن سازگار است؛ ماژول هرگز خودش `fetch` را برنمی‌دارد تا آزمون‌ها و ترکیب‌گر
 * (ریشهٔ برنامه) تعیین کنند چه چیزی به شبکه می‌رسد.
 */
export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/** نام کلید برای سقفِ توکنِ خروجی در قالبِ OpenAI (سرورهای سازگار `max_tokens` را می‌فهمند؛ مدل‌های تازه `max_completion_tokens`). */
export type OpenAiMaxTokensField = "max_tokens" | "max_completion_tokens";

export type HttpToolProviderOptions = Readonly<{
  format: ToolWireFormat;
  /** نشانیِ کاملِ POST (مثلاً `https://api.openai.com/v1/chat/completions` یا `https://api.anthropic.com/v1/messages`). */
  endpoint: string;
  /**
   * تأمین‌کنندهٔ کلید. کلید هرگز در پیکربندی/شیء ارائه‌دهنده ذخیره نمی‌شود و **در هر تماس** خوانده می‌شود (چرخش کلید بی‌بازسازی).
   * پرتابِ استثنا یا کلیدِ نامعتبر ⇒ `ProviderFailure("auth")` بی‌آن‌که درخواستی فرستاده شود.
   */
  getApiKey: () => string | Promise<string>;
  fetch: FetchFn;
  /** فقط برای آزمون/توسعه: `http://` را **فقط** برای `localhost`/`127.0.0.1`/`[::1]` مجاز می‌کند. پیش‌فرض `false`. */
  allowInsecureLoopback?: boolean;
  /** سقفِ بایتِ بدنهٔ پاسخ (پیش‌فرض ۱ MiB). */
  maxResponseBytes?: number;
  /** سرایند `anthropic-version` (پیش‌فرض `2023-06-01`)؛ فقط برای قالبِ Anthropic. */
  anthropicVersion?: string;
  /** پیش‌فرض `max_tokens`؛ فقط برای قالبِ OpenAI. */
  openaiMaxTokensField?: OpenAiMaxTokensField;
  /** ساعتِ تزریقی برای `Retry-After` به‌صورتِ تاریخ (پیش‌فرض `Date.now`). */
  now?: () => number;
}>;

export type HttpProviderConfigError = Readonly<{
  code: "INVALID_CONFIG";
  /** پیامِ ثابت؛ هرگز مقدارِ ورودی (نشانی/کلید) را بازتاب نمی‌دهد. */
  message: string;
  /** فقط نامِ فیلد و قاعده؛ حداکثر ۱۰ مورد. */
  issues: readonly string[];
}>;

export type HttpProviderResult = Readonly<{ ok: true; value: ToolModelProvider }> | Readonly<{ ok: false; error: HttpProviderConfigError }>;

/** پیکربندیِ سنجیده‌شده (داخلی؛ از `resolveOptions`). */
export type ResolvedHttpOptions = Readonly<{
  format: ToolWireFormat;
  endpoint: string;
  getApiKey: () => string | Promise<string>;
  fetch: FetchFn;
  maxResponseBytes: number;
  anthropicVersion: string;
  openaiMaxTokensField: OpenAiMaxTokensField;
  now: () => number;
}>;
