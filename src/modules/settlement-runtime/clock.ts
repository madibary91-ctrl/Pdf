/**
 * ساعتِ سیستم برای ریشهٔ ترکیب. تنها فایلِ این ماژول که `Date` را می‌شناسد (نگهبانِ منبع این را می‌سنجد).
 * `now` تزریق‌پذیر است تا آزمون‌ها زمانِ مجازی بدهند؛ اعتبارسنجیِ مقدار با مصرف‌کننده است (حلقه/ارزیاب ساعتِ نامعتبر را شکستِ بسته می‌شمارند).
 */
import type { Clock } from "@/modules/ledger";

export function createSystemClock(now: () => number = Date.now): Clock {
  return Object.freeze({ nowMs: (): number => now() });
}
