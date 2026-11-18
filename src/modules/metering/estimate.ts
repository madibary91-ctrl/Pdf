/**
 * برآوردِ بدترین‌حالتِ رزرو (ADR-0020 تصمیم ۴؛ خالص). هر عددِ پولی با همان `computeCost`ِ صحیحِ دروازه ساخته می‌شود؛ هیچ اعشاری نیست.
 */
import { computeCost, REQUEST_LIMITS } from "@/modules/ai-gateway";
import type { RefusalCode, ResolvedModel } from "./types";

/** واحد حساب = خرد-واحدِ ارز (ADR-0020 تصمیم ۲). */
export function unitForCurrency(currency: string): string {
  return `${currency}_MICROS`;
}

const enc = new TextEncoder();

/**
 * کرانِ بالای توکن ورودی: بایت‌های UTF‑8 همهٔ پیام‌ها + سربار هر پیام. توکنایزر بایت‌سطح بیش از یک توکن برای هر بایت نمی‌دهد.
 * (نویسهٔ تنها-جانشین به U+FFFD رمز می‌شود: سه بایت، یعنی هرگز کمتر از واقع.)
 */
export function inputTokenBound(contents: readonly string[], perMessageOverheadTokens: number): number {
  let bytes = 0;
  for (const c of contents) bytes += enc.encode(c).length;
  return bytes + perMessageOverheadTokens * contents.length;
}

export type EstimateInput = Readonly<{
  model: string;
  contents: readonly string[];
  maxOutputTokens: number;
  models: ReadonlyMap<string, ResolvedModel>;
  fallbacks: ReadonlyMap<string, readonly string[]>;
  currency: string;
  maxProviderCalls: number;
  perMessageOverheadTokens: number;
}>;

export type Estimate = Readonly<{ amount: number; perCall: number; inputBound: number }>;
export type EstimateResult = Readonly<{ ok: true; value: Estimate }> | Readonly<{ ok: false; code: RefusalCode }>;

const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

export function estimateReservation(i: EstimateInput): EstimateResult {
  if (!isPosInt(i.maxOutputTokens)) return { ok: false, code: "INVALID_REQUEST" };
  if (i.contents.length < 1 || i.contents.length > REQUEST_LIMITS.maxMessages) return { ok: false, code: "INVALID_REQUEST" };
  for (const c of i.contents) if (typeof c !== "string" || c.length > REQUEST_LIMITS.maxMessageChars) return { ok: false, code: "INVALID_REQUEST" };
  const primary = i.models.get(i.model);
  if (primary === undefined) return { ok: false, code: "UNKNOWN_MODEL" };
  if (i.maxOutputTokens > primary.maxOutputTokens) return { ok: false, code: "INVALID_REQUEST" };

  const inputBound = inputTokenBound(i.contents, i.perMessageOverheadTokens);
  let perCall = 0;
  for (const name of [i.model, ...(i.fallbacks.get(i.model) ?? [])]) {
    const spec = i.models.get(name);
    if (spec === undefined) return { ok: false, code: "UNKNOWN_MODEL" };
    if (spec.price === null) return { ok: false, code: "UNPRICED_MODEL" };
    if (spec.price.currency !== i.currency) return { ok: false, code: "CURRENCY_MISMATCH" };
    // جایگزین ممکن است سقف خروجیِ کمتری داشته باشد؛ دروازه آن را رد می‌کند (هزینه‌ای نیست). برای سقفِ ایمن همان maxOutputTokens درخواست را می‌سنجیم.
    const cost = computeCost({ inputTokens: inputBound, outputTokens: i.maxOutputTokens, totalTokens: inputBound + i.maxOutputTokens }, spec.price).micros;
    if (!Number.isSafeInteger(cost) || cost < 0) return { ok: false, code: "ESTIMATE_OVERFLOW" };
    if (cost > perCall) perCall = cost;
  }
  const total = perCall * i.maxProviderCalls;
  if (!Number.isSafeInteger(total)) return { ok: false, code: "ESTIMATE_OVERFLOW" };
  return { ok: true, value: { amount: Math.max(1, total), perCall, inputBound } };
}
