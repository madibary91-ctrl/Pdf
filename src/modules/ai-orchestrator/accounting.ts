/**
 * حسابداریِ صادقانه از نتیجهٔ دروازه (خالص). `report` (از `createResilientGateway`) در صورت وجود و معتبر بودن منبع حقیقت است؛
 * بدون آن فقط هزینهٔ تلاش موفق را داریم و برای شکست «نامعلوم» می‌گوییم، نه صفر. ورودی از پورت است؛ پس شکلش دوباره سنجیده می‌شود.
 */
import type { Accounting, RepairPolicy } from "./types";

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

type SpendEntry = Accounting["spend"][number];

/** جمع هزینه به‌تفکیک ارز؛ `null` یا سرریز `2⁵³−1` ⇒ `micros: null` (هرگز عددِ ساختگی). ترتیبِ نخستین دیدنِ ارز حفظ می‌شود. */
function mergeSpend(a: readonly SpendEntry[], b: readonly SpendEntry[]): SpendEntry[] {
  const order: string[] = [];
  const total = new Map<string, number | null>();
  for (const s of [...a, ...b]) {
    if (!total.has(s.currency)) {
      order.push(s.currency);
      total.set(s.currency, s.micros);
      continue;
    }
    const cur = total.get(s.currency) as number | null;
    if (cur === null || s.micros === null) total.set(s.currency, null);
    else {
      const sum = cur + s.micros;
      total.set(s.currency, Number.isSafeInteger(sum) ? sum : null);
    }
  }
  return order.map((currency) => ({ currency, micros: total.get(currency) as number | null }));
}

const SOURCE_RANK: Readonly<Record<Accounting["source"], number>> = { report: 0, completion: 1, unknown: 2 };

/**
 * حسابداریِ تجمیعیِ دو تلاش (ADR-0017 §۶؛ خالص). نامعلوم سرایت می‌کند و هرگز صفر نمی‌شود:
 * `null` در شمارنده‌ها ⇒ `null`؛ `source` بدترین (`unknown` > `completion` > `report`).
 */
export function mergeAccounting(a: Accounting, b: Accounting): Accounting {
  return {
    source: SOURCE_RANK[a.source] >= SOURCE_RANK[b.source] ? a.source : b.source,
    providerCalls: a.providerCalls === null || b.providerCalls === null ? null : a.providerCalls + b.providerCalls,
    spend: mergeSpend(a.spend, b.spend),
    costUnknownCalls: a.costUnknownCalls === null || b.costUnknownCalls === null ? null : a.costUnknownCalls + b.costUnknownCalls,
    retried: a.retried || b.retried,
    fellBack: a.fellBack || b.fellBack,
  };
}

export type SpendGate = "ok" | "cost-cap" | "cost-unknown";

/**
 * دروازهٔ هزینهٔ ترمیم (ADR-0017 §۲؛ خالص): هزینه تا همین لحظه باید **کاملاً معلوم**، هم‌ارز با `policy.currency` و `≤ سقف` باشد.
 * هر نامعلومی (منبع `unknown`، تماسِ بی‌هزینهٔ‌شناخته‌نشده، `micros: null`، ارز دیگر، نبودنِ هزینه) = `cost-unknown`، نه «مجاز».
 */
export function spendGate(accounting: Accounting, policy: RepairPolicy): SpendGate {
  if (accounting.source === "unknown" || accounting.providerCalls === null || accounting.costUnknownCalls !== 0 || accounting.spend.length === 0) return "cost-unknown";
  let total = 0;
  for (const s of accounting.spend) {
    if (s.micros === null || s.currency !== policy.currency) return "cost-unknown";
    total += s.micros;
  }
  return total <= policy.maxFirstAttemptSpendMicros ? "ok" : "cost-cap";
}
