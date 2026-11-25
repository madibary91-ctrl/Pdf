/**
 * رابطه‌های ساختاریِ سیاست (ADR-0067): **تنها منبعِ حقیقت** برای «کدام آستانه‌ها با هم سازگارند». سه رابطهٔ زمانیِ پول را `checkTimingRelations`
 * (tool-call-deadline) می‌دهد و این‌جا کپی نمی‌شود؛ چهار رابطهٔ سیاستی روی آن افزوده می‌شود. خالص، بی‌پرتاب؛ فقط نامِ فیلد، هرگز مقدار.
 */
import { checkTimingRelations } from "@/modules/tool-call-deadline";
import { POLICY_LIMITS } from "./policy";
import type { PolicyRelationInput } from "./types";

const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

/** فهرستِ مشکل‌ها؛ خالی ⇒ سازگار. بی‌تکرار و به ترتیبِ ثابت. رابطه‌های سیاستی فقط وقتی سنجیده می‌شوند که ورودی‌هایشان عددِ صحیحِ مثبت باشد. */
export function checkPolicyRelations(input: PolicyRelationInput): readonly string[] {
  const issues: string[] = [];
  try {
    const { maxCallMs, graceMs, reservationTtlMs, modelTimeoutMs, totalTimeoutMs } = input;
    for (const i of checkTimingRelations({ maxCallMs, graceMs, reservationTtlMs })) if (!issues.includes(i)) issues.push(i);
    // کفِ graceMs و حاشیهٔ تسویه: پس از سقفِ تماس باید زمانِ I/Oِ دفتر و outbox بماند.
    if (isPosInt(graceMs) && graceMs < POLICY_LIMITS.minGraceMs) issues.push(`graceMs باید دست‌کم ${POLICY_LIMITS.minGraceMs} میلی‌ثانیه باشد.`);
    // `x > y/2` به‌جای `2x > y`: تقسیم بر دو دقیق است و برای عددهای نزدیکِ سقفِ ایمن سرریزِ دقت ندارد.
    if (isPosInt(maxCallMs) && isPosInt(graceMs) && maxCallMs < graceMs && maxCallMs > graceMs / POLICY_LIMITS.maxCallShareDenominator) {
      issues.push("graceMs باید دست‌کم دو برابر maxCallMs باشد (حاشیهٔ تسویه).");
    }
    // مهلتِ خودِ دروازه باید زودتر از سقفِ سخت برسد تا هزینهٔ گزارش‌شده گم نشود.
    if (isPosInt(modelTimeoutMs) && isPosInt(maxCallMs) && modelTimeoutMs >= maxCallMs) issues.push("model.timeoutMs باید کمتر از maxCallMs باشد.");
    // یک گام باید در مهلتِ کلِ اجرا جا شود.
    if (isPosInt(totalTimeoutMs) && isPosInt(maxCallMs) && totalTimeoutMs < maxCallMs) issues.push("totalTimeoutMs باید دست‌کم برابرِ maxCallMs باشد.");
  } catch {
    return Object.freeze(["خواندن آستانه‌های سیاست ناموفق بود."]);
  }
  return Object.freeze(issues);
}
