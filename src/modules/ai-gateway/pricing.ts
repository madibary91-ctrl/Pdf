/**
 * مصرف و هزینه با **عدد صحیح** (BigInt در میانه)؛ هرگز اعشار شناور برای پول.
 * هزینه = ⌈(ورودی × قیمت‌ورودی + خروجی × قیمت‌خروجی) / ۱٬۰۰۰٬۰۰۰⌉ خرد-واحد: گردکردن رو به بالا تا هیچ‌گاه کمتر از واقع نشود.
 * سقف‌های اعتبارسنجی سرریز را ناممکن می‌کنند: ۲ × ۱۰⁹ × ۱۰¹² / ۱۰⁶ = ۲ × ۱۰¹⁵ < ۲⁵³.
 */
import type { Cost, PriceSpec, Usage } from "./types";

export const PRICE_LIMITS = Object.freeze({ maxMicrosPerMTok: 1_000_000_000_000, maxTokens: 1_000_000_000 });

const CURRENCY_RE = /^[A-Z]{3}$/;
const VERSION_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const PRICE_KEYS: ReadonlySet<string> = new Set(["currency", "inputMicrosPerMTok", "outputMicrosPerMTok", "version"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIntIn = (v: unknown, lo: number, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;

/** اعتبارسنجی قیمت؛ مشکل‌ها فقط نام فیلدند. */
export function parsePrice(v: unknown): Readonly<{ ok: true; value: PriceSpec }> | Readonly<{ ok: false; issues: readonly string[] }> {
  if (!isRecord(v)) return { ok: false, issues: ["price باید شیء یا null باشد."] };
  const issues: string[] = [];
  for (const k of Object.keys(v)) if (!PRICE_KEYS.has(k)) issues.push(`price: کلید ناشناخته ${JSON.stringify(k.slice(0, 40))}.`);
  if (typeof v["currency"] !== "string" || !CURRENCY_RE.test(v["currency"])) issues.push("price.currency باید کد سه‌حرفی بزرگ (مثل IRR) باشد.");
  for (const k of ["inputMicrosPerMTok", "outputMicrosPerMTok"] as const) {
    if (!isIntIn(v[k], 0, PRICE_LIMITS.maxMicrosPerMTok)) issues.push(`price.${k} باید عدد صحیح ۰ تا ${PRICE_LIMITS.maxMicrosPerMTok} باشد.`);
  }
  if (typeof v["version"] !== "string" || !VERSION_RE.test(v["version"])) issues.push("price.version الزامی است (۱ تا ۶۴ نویسه از A-Za-z0-9._:-).");
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: Object.freeze({
      currency: v["currency"] as string,
      inputMicrosPerMTok: v["inputMicrosPerMTok"] as number,
      outputMicrosPerMTok: v["outputMicrosPerMTok"] as number,
      version: v["version"] as string,
    }),
  };
}

/** مصرف سخت‌گیرانه: دو عدد صحیح ۰…۱۰⁹؛ هر چیز دیگر `null` (نه ۰). */
export function parseUsage(v: unknown): Usage | null {
  if (!isRecord(v)) return null;
  const i = v["inputTokens"];
  const o = v["outputTokens"];
  if (!isIntIn(i, 0, PRICE_LIMITS.maxTokens) || !isIntIn(o, 0, PRICE_LIMITS.maxTokens)) return null;
  return { inputTokens: i, outputTokens: o, totalTokens: i + o };
}

const MILLION = BigInt(1_000_000);

export function computeCost(usage: Usage, price: PriceSpec): Cost {
  const numerator = BigInt(usage.inputTokens) * BigInt(price.inputMicrosPerMTok) + BigInt(usage.outputTokens) * BigInt(price.outputMicrosPerMTok);
  const micros = Number((numerator + MILLION - BigInt(1)) / MILLION);
  return { micros, currency: price.currency, priceVersion: price.version };
}
