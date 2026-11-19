/**
 * نقطهٔ ورودیِ Next برای کارهای زمانِ بوتِ سرور (م۳‑ه‑۳‑ب، ADR-0033). منطق‌ی این‌جا نیست: فقط نگهبانِ زمانِ‌اجرا و واگذاری.
 *  - فقط runtime «nodejs» (لبه: بی‌پایگاه و بی‌process)؛ در ساختِ تولید (`next build`) اجرا نمی‌شود، ولی نگهبانِ صریح هم داریم.
 *  - وارد کردنِ فایلِ Node به‌صورت پویا تا بستهٔ لبه آن را نکشد (الگوی رسمیِ Next).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { registerSettlement } = await import("./instrumentation-node");
  await registerSettlement();
}
