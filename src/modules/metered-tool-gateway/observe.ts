/**
 * خواندنِ هزینهٔ واقعیِ یک گام از `ToolStepResult` (خالص؛ ورودی از پورت است و دوباره سنجیده می‌شود). «نامعلوم» هرگز صفر نیست؛
 * «هیچ» فقط اثباتاً بی‌تماس است. تفاوت با `observeCost`ِ metering: دروازهٔ ابزار هزینهٔ **گامِ شکست‌خورده** را هم در `error.cost` می‌دهد
 * (پاسخِ بریده یا خراب هزینه شده است) و گزارشِ تلاش ندارد.
 */
import { NEVER_REACHED_CODES, type Observed } from "@/modules/metering";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const unknown = (reason: Extract<Observed, { kind: "unknown" }>["reason"]): Observed => ({ kind: "unknown", reason, lowerBound: 0 });

function fromCost(cost: unknown, currency: string): Observed | null {
  if (cost === null || cost === undefined) return null;
  if (!isRecord(cost) || typeof cost["currency"] !== "string") return unknown("no-cost");
  if (!isCount(cost["micros"])) return unknown("bad-amount");
  if (cost["currency"] !== currency) return unknown("currency");
  return { kind: "known", micros: cost["micros"] };
}

export function observeStep(result: unknown, currency: string): Observed {
  if (!isRecord(result) || typeof result["ok"] !== "boolean") return unknown("no-result");
  const holder = result["ok"] ? result["value"] : result["error"];
  if (!isRecord(holder)) return unknown("no-result");
  const known = fromCost(holder["cost"], currency);
  if (known !== null) return known;
  if (result["ok"]) return unknown("no-cost");
  // بی‌هزینه‌ی گزارش‌شده: فقط خطاهایی که پیش از رسیدن به ارائه‌دهنده‌اند «هیچ»اند؛ بقیه (مهلت، لغو، شکستِ ارائه‌دهنده) ممکن است هزینه داشته باشند.
  return typeof holder["code"] === "string" && NEVER_REACHED_CODES.has(holder["code"]) ? { kind: "none" } : unknown("no-report");
}
