/** جدولِ خطاهای قرارداد و پیام‌های ثابت. چیزی از ورودی، پاسخ مدل یا پیامِ پورت‌ها در این پیام‌ها نمی‌آید. */
import type { LoopError, LoopErrorCode, LoopResult } from "./types";

const MESSAGES: Readonly<Record<LoopErrorCode, string>> = {
  INVALID_CONFIG: "پیکربندیِ حلقهٔ ابزار نامعتبر است.",
  INVALID_INPUT: "ورودیِ شروعِ حلقهٔ ابزار نامعتبر است.",
  INVALID_STATE: "حالتِ حلقهٔ ابزار نامعتبر است یا این رویداد در این مرحله مجاز نیست.",
  INVALID_EVENT: "نتیجهٔ گامِ مدل برای حلقهٔ ابزار نامعتبر است.",
  INVALID_RESULTS: "نتیجهٔ اجرای ابزارها نامعتبر است.",
};

export const LOOP_ERROR_CODES: readonly LoopErrorCode[] = Object.freeze(Object.keys(MESSAGES) as LoopErrorCode[]);

const MAX_ISSUES = 10;

export function fail(code: LoopErrorCode, issues: readonly string[] = []): LoopResult<never> {
  const error: LoopError = Object.freeze({ code, message: MESSAGES[code], issues: Object.freeze(issues.slice(0, MAX_ISSUES)) });
  return Object.freeze({ ok: false as const, error });
}
