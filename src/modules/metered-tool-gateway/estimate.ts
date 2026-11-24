/**
 * برآوردِ بدترین‌حالتِ رزروِ یک گام (خالص). همان قاعدهٔ `estimateReservation`ی metering (کرانِ ورودی = بایت‌های UTF‑8 + سربار هر بخش،
 * هزینه با `computeCost`ِ صحیحِ دروازه) ولی روی **همهٔ بخش‌های ارسالی**: پیام‌ها + بدنهٔ ابزارها (خروجیِ `encodeTools`) + هر پیامِ `continuation`.
 * `estimateReservation` اینجا کافی نبود: شمارِ بخش‌ها را به ۶۴ پیام محدود می‌کند و ابزار/ادامه را نمی‌شناسد.
 */
import { computeCost } from "@/modules/ai-gateway";
import { inputTokenBound, type RefusalCode } from "@/modules/metering";

export type StepModel = Readonly<{ price: Parameters<typeof computeCost>[1] | null; maxOutputTokens: number }>;

export type StepEstimateInput = Readonly<{
  model: string;
  /** همهٔ بخش‌های ارسالی به ارائه‌دهنده (متن). */
  contents: readonly string[];
  maxOutputTokens: unknown;
  models: ReadonlyMap<string, StepModel>;
  currency: string;
  perMessageOverheadTokens: number;
}>;

export type StepEstimate = Readonly<{ ok: true; amount: number }> | Readonly<{ ok: false; code: RefusalCode }>;

export function estimateStep(i: StepEstimateInput): StepEstimate {
  const max = i.maxOutputTokens;
  if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1) return { ok: false, code: "INVALID_REQUEST" };
  const spec = i.models.get(i.model);
  if (spec === undefined) return { ok: false, code: "UNKNOWN_MODEL" };
  if (max > spec.maxOutputTokens) return { ok: false, code: "INVALID_REQUEST" };
  if (spec.price === null) return { ok: false, code: "UNPRICED_MODEL" };
  if (spec.price.currency !== i.currency) return { ok: false, code: "CURRENCY_MISMATCH" };
  const inputBound = inputTokenBound(i.contents, i.perMessageOverheadTokens);
  if (!Number.isSafeInteger(inputBound) || !Number.isSafeInteger(inputBound + max)) return { ok: false, code: "ESTIMATE_OVERFLOW" };
  const cost = computeCost({ inputTokens: inputBound, outputTokens: max, totalTokens: inputBound + max }, spec.price).micros;
  if (!Number.isSafeInteger(cost) || cost < 0) return { ok: false, code: "ESTIMATE_OVERFLOW" };
  return { ok: true, amount: Math.max(1, cost) };
}
