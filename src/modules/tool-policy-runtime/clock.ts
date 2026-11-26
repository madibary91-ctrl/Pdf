/**
 * ساعتِ یکنوا برای سنِ تأییدِ منبع. تنها فایلِ این ماژول که `performance` را می‌شناسد (نگهبانِ منبع این را می‌سنجد).
 * چرا `performance.now()` و نه `Date.now()`؟ ساعتِ دیواری با NTP/تنظیمِ دستی عقب می‌پرد و منبع آن را `CLOCK_INVALID` (بسته) می‌کند؛
 * ساعتِ یکنوا این شکستِ کاذب را ندارد. خروجی عددِ صحیحِ ناپایین‌تر از صفر است (قرارداد منبع)؛ `now` فقط برای آزمون تزریق می‌شود.
 */
import type { PolicyClock } from "@/modules/tool-policy-admin";

export function createMonotonicClock(now: () => number = () => performance.now()): PolicyClock {
  return Object.freeze({ nowMs: (): number => Math.floor(now()) });
}
