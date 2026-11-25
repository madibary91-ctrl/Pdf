/**
 * رابطه‌های ساختاریِ زمان (ADR-0066): **تنها منبعِ حقیقت** برای «چه زمان‌هایی با هم سازگارند» تا ریشهٔ I/O و تنظیماتِ ادمین نتوانند آن را بشکنند:
 *   ۱) هر سه عددِ صحیحِ مثبت و ایمن‌اند؛
 *   ۲) `maxCallMs < graceMs` — تماسِ زنده پیش از آنکه رفتگر رزرو را «یتیم» بداند بسته می‌شود (گامِ زامبی ناممکن)؛
 *   ۳) `reservationTtlMs ≥ ۲ × graceMs` — دفترِ ماندگار وگرنه هر رزرو را رد می‌کند (همان قاعدهٔ `durable-tool-gateway`).
 * نتیجهٔ تلویحی: `maxCallMs < graceMs ≤ ttl/۲` ⇒ ttl همیشه از زمانِ کلِ یک گام بزرگ‌تر است. خالص: بی‌I/O و بی‌پرتاب؛ فقط نامِ فیلد گزارش می‌شود، هرگز مقدار.
 */
import type { TimingRelationInput } from "./types";

const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

/** فهرستِ مشکل‌ها؛ خالی ⇒ سازگار. بی‌تکرار و به ترتیبِ ثابت. */
export function checkTimingRelations(input: TimingRelationInput): readonly string[] {
  const issues: string[] = [];
  try {
    const { maxCallMs, graceMs, reservationTtlMs } = input;
    const okCall = isPosInt(maxCallMs);
    const okGrace = isPosInt(graceMs);
    const okTtl = isPosInt(reservationTtlMs);
    if (!okCall) issues.push("maxCallMs باید عدد صحیحِ مثبت باشد.");
    if (!okGrace) issues.push("graceMs باید عدد صحیحِ مثبت باشد.");
    if (!okTtl) issues.push("reservationTtlMs باید عدد صحیحِ مثبت باشد.");
    if (okCall && okGrace && maxCallMs >= graceMs) issues.push("maxCallMs باید کمتر از graceMs باشد.");
    if (okGrace && okTtl && reservationTtlMs < 2 * graceMs) issues.push("reservationTtlMs باید دست‌کم دو برابر graceMs باشد.");
  } catch {
    return Object.freeze(["خواندن آستانه‌های زمانی ناموفق بود."]);
  }
  return Object.freeze(issues);
}
