/** متن‌های ثابتِ فارسیِ رابط. هیچ‌کدام از ورودی (مدل/ابزار) ساخته نمی‌شود و هیچ مقدارِ ورودی را بازتاب نمی‌دهد. */
import type { CalcToolName } from "@/modules/calc-tools";

/** `Record` تا افزودنِ ابزارِ تازه به calc-tools بی‌عنوان کامپایل نشود. */
export const TOOL_TITLES: Readonly<Record<CalcToolName, string>> = {
  court_fee: "محاسبهٔ هزینهٔ دادرسی",
  late_payment: "محاسبهٔ خسارت تأخیر تأدیه",
};

export const REVIEW_PENDING_LABEL = "تأییدنشده: این نتیجه هنوز به تأیید حقوقدان نرسیده است.";
export const reviewedLabel = (by: string, on: string): string => `تأییدشده توسط ${by} در تاریخ ${on}.`;

export const NOTICES = {
  reviewPending: "توجه: دست‌کم یکی از نتایجِ محاسبه هنوز تأیید حقوقدان ندارد و فقط جنبهٔ راهنما دارد؛ پیش از هر اقدام حقوقی باید بازبینی شود.",
  cardPrecedence: "عدد و هشدارهای رسمیِ محاسبه فقط در کارت‌های محاسبه آمده است؛ اگر متنِ پاسخ با کارت اختلاف داشت، کارت معتبر است.",
} as const;

export const COMPOSE_MESSAGES = {
  INVALID_REPORT: "گزارشِ اجرای ابزار نامعتبر است.",
  CARD_MISSING: "برای دست‌کم یک اجرای موفقِ ابزار کارتِ محاسبه ثبت نشده است؛ پاسخ نمایش داده نمی‌شود.",
  TOOL_MISMATCH: "نامِ ابزارِ گزارش با کارتِ ثبت‌شده نمی‌خواند؛ پاسخ نمایش داده نمی‌شود.",
  DUPLICATE_CALL_ID: "شناسهٔ فراخوانیِ ابزار در گزارش تکراری است؛ پاسخ نمایش داده نمی‌شود.",
} as const;

export const OBSERVE_FAILURE = "ثبتِ کارتِ محاسبه ممکن نشد.";
export const OPTIONS_MESSAGE = "گزینه‌های جمع‌آورندهٔ کارتِ محاسبه نامعتبرند.";
