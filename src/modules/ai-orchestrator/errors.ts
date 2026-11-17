/** جدول خطاها و پیام‌های ثابت. چیزی از ورودی، پاسخ مدل یا پیام پورت‌ها در این پیام‌ها نمی‌آید. */
import type { Accounting, OrchestratorError, OrchestratorErrorCode, OrchResult } from "./types";

const TABLE: Readonly<Record<OrchestratorErrorCode, Readonly<{ message: string; retryable: boolean }>>> = {
  INVALID_CONFIG: { message: "پیکربندی ارکستراتور نامعتبر است.", retryable: false },
  INVALID_INPUT: { message: "درخواست پرسش‌وپاسخ نامعتبر است.", retryable: false },
  UNKNOWN_MODEL: { message: "مدل درخواستی در دروازه تعریف نشده است.", retryable: false },
  PROMPT_BUDGET: { message: "پرسش با حدّ ورودی مدل جا نمی‌شود و جایی برای منابع نمی‌ماند.", retryable: false },
  // پیش از هر هزینهٔ مدل: تلاش دوباره دوباره‌خرجی ندارد.
  RETRIEVAL_FAILED: { message: "بازیابی از پایگاه دانش شکست خورد.", retryable: true },
  VERIFIER_UNAVAILABLE: { message: "راستی‌آزمایی استناد در دسترس نیست؛ بدون آن پاسخی داده نمی‌شود.", retryable: true },
  // `retryable` را از خطای دروازه می‌گیرد.
  GENERATION_FAILED: { message: "تولید پاسخ توسط مدل شکست خورد.", retryable: false },
  MODEL_OUTPUT_INVALID: { message: "خروجی مدل با قالب مورد انتظار نمی‌خواند و پذیرفته نشد.", retryable: false },
  VERIFICATION_FAILED: { message: "راستی‌آزمایی استنادِ پاسخ ناممکن بود؛ پاسخ نمایش داده نمی‌شود.", retryable: false },
  ABORTED: { message: "درخواست لغو شد.", retryable: false },
  INTERNAL_ERROR: { message: "ارکستراتور با خطای داخلی شکست خورد.", retryable: false },
};

export const ERROR_CODES: readonly OrchestratorErrorCode[] = Object.freeze(Object.keys(TABLE) as OrchestratorErrorCode[]);

export function fail(
  code: OrchestratorErrorCode,
  extra: Readonly<Partial<Omit<OrchestratorError, "code" | "message" | "accounting">>> & Readonly<{ accounting?: Accounting | null }> = {},
): OrchResult<never> {
  const row = TABLE[code];
  const error: OrchestratorError = { code, message: row.message, retryable: row.retryable, accounting: null, ...extra };
  return { ok: false, error };
}

/** پیام‌های ثابتِ ردِّ ارجاع (کلید = کد حکم)؛ کدِ ناشناخته پیام عمومی می‌گیرد. */
const REJECTION_MESSAGES: Readonly<Record<string, string>> = {
  "malformed-marker": "نشانهٔ ارجاع مخدوش بود و حذف شد.",
  "unknown-source": "شناسهٔ منبع در زمینهٔ این پرسش وجود ندارد.",
  "missing-quote": "ارجاع بدون نقل‌قول پذیرفته نمی‌شود.",
  "unverified-source": "منبع هنوز توسط حقوقدان تأیید نشده است.",
  "unknown-document": "سند در پایگاه دانش نیست.",
  "unknown-article": "ماده در پایگاه دانش نیست.",
  "unknown-subpart": "تبصره/بند در پایگاه دانش نیست.",
  "not-yet-in-force": "ماده در تاریخ مورد نظر هنوز لازم‌الاجرا نیست.",
  "no-longer-in-force": "ماده در تاریخ مورد نظر دیگر معتبر نیست.",
  gap: "در تاریخ مورد نظر هیچ نسخهٔ معتبری از ماده نیست.",
  "quote-mismatch": "نقل‌قول در متن همان ماده نیست.",
  malformed: "شکل ارجاع نامعتبر است.",
  "no-document": "ارجاع بدون نام قانون به سند معینی نسبت نمی‌یابد.",
  "ambiguous-document": "نام قانون به بیش از یک سند می‌خورد.",
  "unsupported-form": "شکل ارجاع پشتیبانی نمی‌شود.",
  "invalid-verdict": "حکم راستی‌آزمایی نامعتبر بود.",
};
const GENERIC_REJECTION = "ارجاع از راستی‌آزمایی نگذشت.";

/** کد رسیده از پورت را به یک رشتهٔ کوتاهِ امن (کوچک لاتین و خط‌تیره) محدود می‌کند. */
export function safeCode(code: unknown): string {
  return typeof code === "string" && /^[a-z][a-z-]{0,39}$/.test(code) ? code : "invalid-verdict";
}

export function rejectionMessage(code: string): string {
  return Object.prototype.hasOwnProperty.call(REJECTION_MESSAGES, code) ? (REJECTION_MESSAGES[code] as string) : GENERIC_REJECTION;
}
