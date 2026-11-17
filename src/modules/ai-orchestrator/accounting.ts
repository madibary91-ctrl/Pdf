/**
 * حسابداریِ صادقانه از نتیجهٔ دروازه (خالص). `report` (از `createResilientGateway`) در صورت وجود و معتبر بودن منبع حقیقت است؛
 * بدون آن فقط هزینهٔ تلاش موفق را داریم و برای شکست «نامعلوم» می‌گوییم، نه صفر. ورودی از پورت است؛ پس شکلش دوباره سنجیده می‌شود.
 */
import type { Accounting } from "./types";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `report` معتبر یا `null`. شکل نامعتبر = بی‌گزارش (هرگز حدس نمی‌زنیم). */
function fromReport(holder: unknown): Accounting | null {
  if (!isRecord(holder) || !("report" in holder)) return null;
  const r = holder["report"];
  if (!isRecord(r) || !Array.isArray(r["attempts"]) || !Array.isArray(r["spend"]) || typeof r["costUnknownAttempts"] !== "number") return null;
  const spend: { currency: string; micros: number | null }[] = [];
  for (const s of r["spend"] as unknown[]) {
    if (!isRecord(s) || typeof s["currency"] !== "string" || !(s["micros"] === null || typeof s["micros"] === "number")) return null;
    spend.push({ currency: s["currency"], micros: s["micros"] });
  }
  const attempts = (r["attempts"] as unknown[]).filter(isRecord);
  const requested = r["requestedModel"];
  const reached = attempts.filter((a) => a["reachedProvider"] === true);
  return {
    source: "report",
    providerCalls: reached.length,
    spend,
    costUnknownCalls: r["costUnknownAttempts"],
    retried: attempts.some((a) => typeof a["modelAttempt"] === "number" && a["modelAttempt"] > 1),
    fellBack: reached.some((a) => a["model"] !== requested),
  };
}

export function accountingOfCompletion(completion: unknown): Accounting {
  const rep = fromReport(completion);
  if (rep !== null) return rep;
  const cost = isRecord(completion) ? completion["cost"] : null;
  if (isRecord(cost) && typeof cost["currency"] === "string" && typeof cost["micros"] === "number") {
    return { source: "completion", providerCalls: 1, spend: [{ currency: cost["currency"], micros: cost["micros"] }], costUnknownCalls: 0, retried: false, fellBack: false };
  }
  return { source: "completion", providerCalls: 1, spend: [], costUnknownCalls: 1, retried: false, fellBack: false };
}

export function accountingOfFailure(error: unknown): Accounting {
  return fromReport(error) ?? unknownAccounting();
}

/** شکستِ بی‌گزارش: ممکن است هزینه شده باشد؛ نه صفر. */
export function unknownAccounting(): Accounting {
  return { source: "unknown", providerCalls: null, spend: [], costUnknownCalls: null, retried: false, fellBack: false };
}
