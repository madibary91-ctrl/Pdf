/**
 * جمعِ مصرف و هزینهٔ چندگامی (ADR-0055 §۵). خالص و بی‌پرتاب. اصل‌ها: نامعلوم **صفر نیست** و حدس زده نمی‌شود؛ جمع به‌تفکیکِ
 * (ارز، نسخهٔ قیمت) است تا دو نسخهٔ قیمت یا دو ارز هرگز در یک عدد ادغام نشوند؛ سرریزِ `2⁵³−1` ⇒ `micros: null` (نه گرد‌شده).
 */
import type { StepSpend } from "./tool-step-types";

const MAX_TOKENS = 1_000_000_000;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIntIn = (v: unknown, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= hi;

type Bucket = { currency: string; priceVersion: string; micros: number | null };

export function sumStepSpend(entries: unknown): StepSpend {
  const list: readonly unknown[] = Array.isArray(entries) ? (entries as readonly unknown[]) : [];
  let input = 0;
  let output = 0;
  let unknownUsage = 0;
  let unknownCost = 0;
  let overflow = false;
  const buckets = new Map<string, Bucket>();
  for (const e of list) {
    let usage: unknown = null;
    let cost: unknown = null;
    try {
      if (isRecord(e)) {
        usage = e["usage"];
        cost = e["cost"];
      }
    } catch {
      // مدخلِ بدجنس (getter پرتابگر) نامعلوم حساب می‌شود.
    }
    if (isRecord(usage) && isIntIn(usage["inputTokens"], MAX_TOKENS) && isIntIn(usage["outputTokens"], MAX_TOKENS)) {
      input += usage["inputTokens"];
      output += usage["outputTokens"];
      if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || !Number.isSafeInteger(input + output)) overflow = true;
    } else unknownUsage++;
    if (isRecord(cost) && typeof cost["currency"] === "string" && typeof cost["priceVersion"] === "string" && isIntIn(cost["micros"], Number.MAX_SAFE_INTEGER)) {
      const key = `${cost["currency"]}\u0000${cost["priceVersion"]}`;
      const b = buckets.get(key) ?? { currency: cost["currency"], priceVersion: cost["priceVersion"], micros: 0 };
      if (b.micros !== null) {
        const next = b.micros + cost["micros"];
        b.micros = Number.isSafeInteger(next) ? next : null;
      }
      buckets.set(key, b);
    } else unknownCost++;
  }
  const costs = [...buckets.values()].sort((a, b) => (a.currency + a.priceVersion < b.currency + b.priceVersion ? -1 : 1)).map((b) => Object.freeze({ ...b }));
  const usage = Object.freeze({ inputTokens: input, outputTokens: output, totalTokens: input + output });
  const complete = unknownUsage === 0 && unknownCost === 0 && !overflow && costs.every((c) => c.micros !== null);
  return Object.freeze({ steps: list.length, usage, unknownUsageSteps: unknownUsage, cost: Object.freeze(costs), unknownCostSteps: unknownCost, complete });
}
