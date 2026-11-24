/** متن‌های ثابتِ فارسیِ سرویسِ پاسخِ محاسبه. هیچ‌کدام از ورودی (مدل/ابزار/کاربر) ساخته نمی‌شود و هیچ مقداری را بازتاب نمی‌دهد. */
import type { AnswerErrorCode } from "./types";

export const OPTIONS_MESSAGE = "پیکربندیِ سرویسِ پاسخِ محاسبه نامعتبر است.";

export const ANSWER_MESSAGES: Readonly<Record<AnswerErrorCode, string>> = {
  INVALID_INPUT: "ورودیِ درخواستِ پاسخ نامعتبر است.",
  RUN_FAILED: "اجرای پاسخ ناموفق بود؛ پاسخی نمایش داده نمی‌شود.",
  NOT_DISPLAYABLE: "پاسخ با کارت‌های محاسبه همخوان نیست؛ پاسخ نمایش داده نمی‌شود.",
};
