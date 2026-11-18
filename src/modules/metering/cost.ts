/**
 * خواندنِ هزینهٔ واقعیِ یک تماس از نتیجهٔ دروازه (ADR-0020 تصمیم ۵؛ خالص). ورودی از پورت است: شکل دوباره سنجیده می‌شود.
 * `report` (دروازهٔ تاب‌آور) منبع حقیقت است؛ بی‌آن فقط `cost` تکمیل. «نامعلوم» هرگز صفر نیست؛ «هیچ» فقط اثباتاً بی‌تماس است.
 */
export type UnknownReason = "no-result" | "report-unknown" | "report-inconsistent" | "currency" | "no-cost" | "no-report" | "bad-amount";

export type Observed =
  /** هزینهٔ دقیقِ همهٔ تماس‌ها (ممکن است ۰ باشد: قیمت صفر). */
  | Readonly<{ kind: "known"; micros: number }>
  /** اثباتاً هیچ تماسی به ارائه‌دهنده نرسید. */
  | Readonly<{ kind: "none" }>
  /** `lowerBound`: مجموعِ هزینه‌های **معلومِ** همین ارز (کفِ هزینهٔ واقعی؛ نه برآورد): همان همیشه مصرف می‌شود و باقیمانده طبق سیاست. */
  | Readonly<{ kind: "unknown"; reason: UnknownReason; lowerBound: number }>;

/** خطاهایی که دروازهٔ ساده **پیش از** رسیدن به ارائه‌دهنده می‌دهد (اعتبارسنجی)؛ بقیهٔ کدها ممکن است هزینه داشته باشند. */
export const NEVER_REACHED_CODES: ReadonlySet<string> = new Set(["INVALID_REQUEST", "UNKNOWN_MODEL", "INVALID_CONFIG"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const unknown = (reason: UnknownReason, lowerBound = 0): Observed => ({ kind: "unknown", reason, lowerBound });

/** مجموع ردیف‌های هزینهٔ معلومِ هم‌ارز؛ هر ناهنجاری یا سرریز ⇒ ۰ (۰ همیشه کفِ معتبر است). */
function knownLowerBound(spend: readonly unknown[], currency: string): number {
  let t = 0;
  for (const s of spend) {
    if (!isRecord(s) || s["currency"] !== currency || !isCount(s["micros"])) continue;
    t += s["micros"];
    if (!Number.isSafeInteger(t)) return 0;
  }
  return t;
}

function fromReport(holder: Record<string, unknown>, currency: string): Observed | null {
  if (!("report" in holder)) return null;
  const r = holder["report"];
  if (!isRecord(r) || !Array.isArray(r["attempts"]) || !Array.isArray(r["spend"]) || !isCount(r["costUnknownAttempts"])) return null;
  const lb = knownLowerBound(r["spend"] as unknown[], currency);
  if (r["costUnknownAttempts"] > 0) return unknown("report-unknown", lb);
  let total = 0;
  for (const s of r["spend"] as unknown[]) {
    if (!isRecord(s) || typeof s["currency"] !== "string") return unknown("report-inconsistent", lb);
    if (s["micros"] === null) return unknown("report-unknown", lb);
    if (!isCount(s["micros"])) return unknown("bad-amount", lb);
    if (s["currency"] !== currency) return unknown("currency", lb);
    total += s["micros"];
    if (!Number.isSafeInteger(total)) return unknown("bad-amount", lb);
  }
  const reached = (r["attempts"] as unknown[]).filter((a) => isRecord(a) && a["reachedProvider"] === true).length;
  if (reached === 0 && (r["spend"] as unknown[]).length === 0) return { kind: "none" };
  // تماسِ رسیده بدون هیچ ردیفِ هزینه با costUnknownAttempts=0 ناسازگار است: ندانستن، نه صفر.
  if ((r["spend"] as unknown[]).length === 0) return unknown("report-inconsistent", 0);
  return { kind: "known", micros: total };
}

export function observeCost(result: unknown, currency: string): Observed {
  if (!isRecord(result) || typeof result["ok"] !== "boolean") return unknown("no-result");
  const holder = result["ok"] ? result["value"] : result["error"];
  if (!isRecord(holder)) return unknown("no-result");
  const rep = fromReport(holder, currency);
  if (rep !== null) return rep;
  if (result["ok"]) {
    const cost = holder["cost"];
    if (!isRecord(cost) || typeof cost["currency"] !== "string") return unknown("no-cost");
    if (!isCount(cost["micros"])) return unknown("bad-amount");
    if (cost["currency"] !== currency) return unknown("currency");
    return { kind: "known", micros: cost["micros"] };
  }
  return typeof holder["code"] === "string" && NEVER_REACHED_CODES.has(holder["code"]) ? { kind: "none" } : unknown("no-report");
}
