/** ساختِ کارت از رویدادِ ناظر. شکست‌بسته: «تأییدشده» فقط وقتی همهٔ نشانه‌ها موافق باشند. */
import { isCalcToolName } from "@/modules/calc-tools";
import type { CalcCard } from "./types";
import { OBSERVE_FAILURE, REVIEW_PENDING_LABEL, TOOL_TITLES, reviewedLabel } from "./messages";

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

export function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

/** `true` فقط اگر وضعیت `legally-verified` و بازبین و تاریخ هر دو پُر باشند و پرچمِ ناظر هم `false` باشد. */
export function isPending(reviewPendingFlag: boolean, status: string, reviewedBy: string | null, reviewedOn: string | null): boolean {
  return reviewPendingFlag || status !== "legally-verified" || !nonEmpty(reviewedBy) || !nonEmpty(reviewedOn);
}

export function labelFor(pending: boolean, reviewedBy: string | null, reviewedOn: string | null): string {
  return pending || reviewedBy === null || reviewedOn === null ? REVIEW_PENDING_LABEL : reviewedLabel(reviewedBy, reviewedOn);
}

/**
 * رویدادِ نامعتبر ⇒ پرتابِ پیامِ ثابت (عمدی؛ ADR-0059 بند ۵). مقدارِ رویداد هرگز در پیام نیست.
 * `result` با رفت‌وبرگشتِ JSON کپی می‌شود: تغییرِ بعدیِ منبع کارت را عوض نمی‌کند و مقدارِ غیرِ JSON (چرخه، BigInt) رد می‌شود.
 */
function build(o: unknown): CalcCard {
  if (!isRecord(o)) throw new Error(OBSERVE_FAILURE);
  const { callId, tool, result, review, reviewPending, notes } = o;
  if (!nonEmpty(callId) || !isCalcToolName(tool) || typeof reviewPending !== "boolean") throw new Error(OBSERVE_FAILURE);
  if (!isRecord(review) || !nonEmpty(review["status"])) throw new Error(OBSERVE_FAILURE);
  const by = review["reviewedBy"];
  const on = review["reviewedOn"];
  if ((by !== null && typeof by !== "string") || (on !== null && typeof on !== "string")) throw new Error(OBSERVE_FAILURE);
  if (!Array.isArray(notes) || !notes.every((n): n is string => typeof n === "string")) throw new Error(OBSERVE_FAILURE);
  const json = JSON.stringify(result);
  if (json === undefined) throw new Error(OBSERVE_FAILURE);
  const pending = isPending(reviewPending, review["status"], by, on);
  return deepFreeze({
    callId,
    tool,
    title: TOOL_TITLES[tool],
    result: JSON.parse(json) as CalcCard["result"],
    review: { status: review["status"], reviewedBy: by, reviewedOn: on },
    reviewPending: pending,
    reviewLabel: labelFor(pending, by, on),
    notes: [...notes],
  });
}

/**
 * هر پرتابِ داخلی (حتی استثنای بومیِ JSON/getter که ممکن است نامِ فیلد یا دادهٔ پرونده را در پیام بیاورد) به پیامِ ثابت تبدیل می‌شود.
 * پرتاب باقی می‌ماند (شکست‌بسته)؛ فقط متنش ثابت می‌شود.
 */
export function cardFromObservation(o: unknown): CalcCard {
  try {
    return build(o);
  } catch {
    throw new Error(OBSERVE_FAILURE);
  }
}
