/**
 * ترکیبِ کارت‌های دیده‌شده با `RunReport` (ADR-0060). قاعده‌ها:
 *  - هر اجرای **موفقِ** ابزار باید کارت داشته باشد؛ وگرنه خطا (پاسخی که بر نتیجه‌ای بنا شده که کاربر نمی‌بیند نمایش داده نمی‌شود).
 *  - کارتی که ناظر دید ولی اجرایش موفق نبود (نتیجه به مدل نرسید) نمایش داده نمی‌شود و شمرده می‌شود.
 *  - تأییدنشدگی فقط بالا می‌رود: هر نشانه‌ای (کارت، رکورد، نتیجهٔ حلقه) بگوید «تأییدنشده» ⇒ تأییدنشده.
 */
import type { CalcCard, ComposeError, ComposeErrorCode, ComposeResult, ComposedAnswer } from "./types";
import { COMPOSE_MESSAGES, NOTICES, REVIEW_PENDING_LABEL } from "./messages";
import { deepFreeze, isRecord } from "./card";

const fail = (code: ComposeErrorCode, issues: readonly string[] = []): ComposeResult => {
  const error: ComposeError = { code, message: COMPOSE_MESSAGES[code], issues: issues.slice(0, 10) };
  return { ok: false, error };
};
const idName = (id: string): string => (id.length > 60 ? `${id.slice(0, 60)}…` : id);

type Run = Readonly<{ id: string; name: string; ok: boolean; reviewPending: boolean }>;
type Parsed = Readonly<{ status: "answered" | "stopped"; text: string | null; stopReason: string | null; abortedBy: ComposedAnswer["abortedBy"]; outcomePending: boolean; runs: readonly Run[] }>;

/** خواندنِ گزارش با اعتبارسنجیِ مرزی. شیءِ بدجنس (Proxy/getter) ⇒ `null`، نه پرتاب. */
function parseReport(report: unknown): Parsed | string {
  try {
    if (!isRecord(report)) return "report";
    const outcome = report["outcome"];
    if (!isRecord(outcome)) return "outcome";
    const status = outcome["status"];
    if (typeof outcome["reviewPending"] !== "boolean") return "outcome.reviewPending";
    let text: string | null = null;
    let stopReason: string | null = null;
    if (status === "answered") {
      if (typeof outcome["text"] !== "string") return "outcome.text";
      text = outcome["text"];
    } else if (status === "stopped") {
      if (typeof outcome["reason"] !== "string") return "outcome.reason";
      stopReason = outcome["reason"];
    } else return "outcome.status";
    const abortedBy = report["abortedBy"];
    if (abortedBy !== null && abortedBy !== "caller" && abortedBy !== "deadline") return "abortedBy";
    const rawRuns = report["toolRuns"];
    if (!Array.isArray(rawRuns)) return "toolRuns";
    const runs: Run[] = [];
    for (const r of rawRuns) {
      if (!isRecord(r) || typeof r["id"] !== "string" || r["id"].length === 0 || typeof r["name"] !== "string") return "toolRuns[]";
      if ((r["status"] !== "ok" && r["status"] !== "error") || typeof r["reviewPending"] !== "boolean") return "toolRuns[]";
      runs.push({ id: r["id"], name: r["name"], ok: r["status"] === "ok", reviewPending: r["reviewPending"] });
    }
    return { status, text, stopReason, abortedBy, outcomePending: outcome["reviewPending"], runs };
  } catch {
    return "report";
  }
}

export function composeAnswer(seen: readonly CalcCard[], report: unknown): ComposeResult {
  const p = parseReport(report);
  if (typeof p === "string") return fail("INVALID_REPORT", [p]);

  const seenIds = new Set<string>();
  const dup = new Set<string>();
  for (const r of p.runs) {
    if (seenIds.has(r.id)) dup.add(r.id);
    seenIds.add(r.id);
  }
  if (dup.size > 0) return fail("DUPLICATE_CALL_ID", [...dup].map(idName));

  const byId = new Map(seen.map((c) => [c.callId, c]));
  const missing: string[] = [];
  const mismatched: string[] = [];
  const cards: CalcCard[] = [];
  let anyRunPending = false;
  for (const r of p.runs) {
    if (!r.ok) continue;
    anyRunPending = anyRunPending || r.reviewPending;
    const c = byId.get(r.id);
    if (c === undefined) missing.push(idName(r.id));
    else if (c.tool !== r.name) mismatched.push(idName(r.id));
    else cards.push(r.reviewPending && !c.reviewPending ? { ...c, reviewPending: true, reviewLabel: REVIEW_PENDING_LABEL } : c);
  }
  if (missing.length > 0) return fail("CARD_MISSING", missing);
  if (mismatched.length > 0) return fail("TOOL_MISMATCH", mismatched);

  const reviewPending = p.outcomePending || anyRunPending || cards.some((c) => c.reviewPending);
  const notices: string[] = [];
  if (reviewPending) notices.push(NOTICES.reviewPending);
  if (p.status === "answered" && cards.length > 0) notices.push(NOTICES.cardPrecedence);

  return {
    ok: true,
    value: deepFreeze({
      status: p.status,
      text: p.text,
      stopReason: p.stopReason,
      abortedBy: p.abortedBy,
      cards,
      reviewPending,
      notices,
      droppedCards: seen.length - cards.length,
    }),
  };
}
