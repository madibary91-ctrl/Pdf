/**
 * جدول خطاها و `ProviderFailure`. پیام‌ها **ثابت‌اند**: چیزی از ورودی کاربر، پیام خامِ ارائه‌دهنده (که ممکن است
 * کلید/نشانی/متن پرسش را بازتاب دهد) یا استثنای داخلی در خروجی نمی‌آید.
 */
import type { GatewayError, GatewayErrorCode, GatewayResult, GatewayWarning } from "./types";

export type ProviderFailureKind = "rate_limited" | "unavailable" | "auth" | "rejected";

/** بالاترین `retryAfterMs` قابل‌اعتماد (۱ ساعت)؛ بیشتر از آن نادیده گرفته می‌شود. */
export const MAX_RETRY_AFTER_MS = 3_600_000;

/**
 * شکستِ شناخته‌شدهٔ ارائه‌دهنده؛ تنها چیزی که آداپتورها باید پرتاب کنند. پیام خام و `cause` فقط برای لاگِ خودِ آداپتور است
 * و هرگز به نتیجهٔ دروازه نمی‌رسد.
 */
export class ProviderFailure extends Error {
  readonly kind: ProviderFailureKind;
  readonly retryAfterMs: number | null;
  constructor(kind: ProviderFailureKind, options: Readonly<{ retryAfterMs?: number; cause?: unknown }> = {}) {
    super(`provider failure: ${kind}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderFailure";
    this.kind = kind;
    const r = options.retryAfterMs;
    this.retryAfterMs = typeof r === "number" && Number.isInteger(r) && r >= 0 && r <= MAX_RETRY_AFTER_MS ? r : null;
  }
}

const TABLE: Readonly<Record<GatewayErrorCode, Readonly<{ message: string; retryable: boolean }>>> = {
  INVALID_CONFIG: { message: "پیکربندی دروازهٔ مدل نامعتبر است.", retryable: false },
  INVALID_REQUEST: { message: "درخواست مدل نامعتبر است.", retryable: false },
  UNKNOWN_MODEL: { message: "مدل درخواستی در دروازه تعریف نشده است.", retryable: false },
  TIMEOUT: { message: "ارائه‌دهندهٔ مدل در مهلت مقرر پاسخ نداد.", retryable: true },
  ABORTED: { message: "درخواست مدل لغو شد.", retryable: false },
  PROVIDER_RATE_LIMITED: { message: "ارائه‌دهندهٔ مدل درخواست را به‌دلیل محدودیت نرخ نپذیرفت.", retryable: true },
  PROVIDER_UNAVAILABLE: { message: "ارائه‌دهندهٔ مدل در دسترس نیست.", retryable: true },
  PROVIDER_AUTH: { message: "احراز هویت نزد ارائه‌دهندهٔ مدل پذیرفته نشد.", retryable: false },
  PROVIDER_REJECTED: { message: "ارائه‌دهندهٔ مدل درخواست را رد کرد.", retryable: false },
  PROVIDER_ERROR: { message: "ارائه‌دهندهٔ مدل با خطای پیش‌بینی‌نشده شکست خورد.", retryable: false },
  PROVIDER_BAD_RESPONSE: { message: "پاسخ ارائه‌دهندهٔ مدل معتبر نبود.", retryable: false },
  INTERNAL_ERROR: { message: "دروازهٔ مدل با خطای داخلی شکست خورد.", retryable: false },
};

export const ERROR_CODES: readonly GatewayErrorCode[] = Object.freeze(Object.keys(TABLE) as GatewayErrorCode[]);

export function makeError(
  code: GatewayErrorCode,
  extra: Readonly<{ retryAfterMs?: number | null; issues?: readonly string[]; warnings?: readonly GatewayWarning[] }> = {},
): GatewayError {
  const row = TABLE[code];
  return {
    code,
    message: row.message,
    retryable: row.retryable,
    ...(extra.retryAfterMs === undefined || extra.retryAfterMs === null ? {} : { retryAfterMs: extra.retryAfterMs }),
    ...(extra.issues === undefined || extra.issues.length === 0 ? {} : { issues: [...extra.issues] }),
    warnings: extra.warnings === undefined ? [] : [...extra.warnings],
  };
}

export function fail(code: GatewayErrorCode, extra?: Parameters<typeof makeError>[1]): GatewayResult<never> {
  return { ok: false, error: makeError(code, extra) };
}

/** نگاشت استثنای ارائه‌دهنده به خطای دروازه؛ هر چیزِ ناشناخته `PROVIDER_ERROR` (نه قابل‌تلاش: ممکن است هزینه شده باشد). */
export function classifyThrown(e: unknown): Readonly<{ code: GatewayErrorCode; retryAfterMs: number | null }> {
  if (e instanceof ProviderFailure) {
    switch (e.kind) {
      case "rate_limited":
        return { code: "PROVIDER_RATE_LIMITED", retryAfterMs: e.retryAfterMs };
      case "unavailable":
        return { code: "PROVIDER_UNAVAILABLE", retryAfterMs: e.retryAfterMs };
      case "auth":
        return { code: "PROVIDER_AUTH", retryAfterMs: null };
      case "rejected":
        return { code: "PROVIDER_REJECTED", retryAfterMs: null };
    }
  }
  return { code: "PROVIDER_ERROR", retryAfterMs: null };
}
