/**
 * settlement-backlog-watch — سیاستِ پروب (تصمیمِ مالک، ADR-0042): «پسماند هرگز liveness را ۵۰۳ نکند و فقط در ready و startup گزارش شود».
 * تابعِ خالص، همگام، بی‌پرتاب؛ ورودیِ `view` ناقابل‌اعتماد است (از کش/سریال‌سازی/ماژولِ دیگر می‌آید) و از نو اعتبارسنجی می‌شود.
 *  - `live` (و هر نوعِ ناشناخته): **هیچ‌وقت** گزارش نمی‌شود و **هیچ‌وقت** مسدود نمی‌کند. «پسماندِ پیر» با ریستارتِ فرایند درست نمی‌شود.
 *  - `startup`: گزارش می‌شود، **هیچ‌وقت** مسدود نمی‌کند (راه‌اندازی چسبنده است؛ پسماند به بوت ربطی ندارد).
 *  - `ready`: گزارش می‌شود؛ فقط با سیاستِ صریحِ `gate_down` و وضعیتِ `down` مسدود می‌کند (ترافیک برداشته می‌شود، فرایند نه).
 * نمای ناقابل‌خواندن ⇒ بخشِ `unknown` و **عدمِ مسدودسازی** (مثلِ `SAMPLE_UNREADABLE`: «نمی‌دانم» ۵۰۳ نمی‌سازد). بدنه بی‌نشت است: فقط وضعیت/عدد/کد.
 */
import type { BacklogReasonCode } from "@/modules/settlement-backlog";
import type { BacklogProbeProjection, BacklogProbeSection, BacklogReadyPolicy, BacklogViewStatus } from "./types";

const STATUSES: readonly string[] = ["ok", "degraded", "down", "unknown"];
const POLICIES: readonly string[] = ["report", "gate_down"];
const CODES: readonly string[] = [
  "INPUT_INVALID",
  "SAMPLE_UNREADABLE",
  "SAMPLE_STALE",
  "CLOCK_BEHIND",
  "COUNT_HIGH",
  "COUNT_CRITICAL",
  "OLDEST_AGED",
  "OLDEST_STUCK",
  "AGE_UNKNOWN",
];
const MAX_REASONS = 16;

const NONE: BacklogProbeProjection = Object.freeze({ section: null, blocks: false });
const UNKNOWN_SECTION: BacklogProbeSection = Object.freeze({ status: "unknown" as const, count: null, truncated: null, oldestAgeMs: null, reasons: Object.freeze([]), policy: "report" as const });

const isNat = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function parseSection(view: unknown): BacklogProbeSection | null {
  try {
    if (typeof view !== "object" || view === null || Array.isArray(view)) return null;
    const v = view as Record<string, unknown>;
    const status = v["status"];
    const policy = v["readyPolicy"];
    const count = v["count"];
    const truncated = v["truncated"];
    const oldestAgeMs = v["oldestAgeMs"];
    const reasonsRaw = v["reasons"];
    if (typeof status !== "string" || !STATUSES.includes(status)) return null;
    if (typeof policy !== "string" || !POLICIES.includes(policy)) return null;
    if (!(count === null || isNat(count)) || !(truncated === null || typeof truncated === "boolean") || !(oldestAgeMs === null || isNat(oldestAgeMs))) return null;
    if (!Array.isArray(reasonsRaw) || reasonsRaw.length > MAX_REASONS) return null;
    const codes: BacklogReasonCode[] = [];
    for (const r of reasonsRaw as unknown[]) {
      if (typeof r !== "object" || r === null) return null;
      const code = (r as Record<string, unknown>)["code"];
      if (typeof code !== "string" || !CODES.includes(code)) return null;
      codes.push(code as BacklogReasonCode);
    }
    return Object.freeze({
      status: status as BacklogViewStatus,
      count,
      truncated,
      oldestAgeMs,
      reasons: Object.freeze(codes),
      policy: policy as BacklogReadyPolicy,
    });
  } catch {
    return null;
  }
}

export function projectBacklogForProbe(kind: unknown, view: unknown): BacklogProbeProjection {
  try {
    if (kind !== "ready" && kind !== "startup") return NONE;
    const parsed = parseSection(view);
    const section = parsed ?? UNKNOWN_SECTION;
    const blocks = kind === "ready" && parsed !== null && parsed.status === "down" && parsed.policy === "gate_down";
    return Object.freeze({ section, blocks });
  } catch {
    return NONE;
  }
}
