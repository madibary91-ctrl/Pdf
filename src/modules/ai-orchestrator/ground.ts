/**
 * مستندسازی و راستی‌آزمایی (قلب برش؛ ADR-0016 §۶–۷). خالص: همهٔ I/O پشت `CitationSession` است.
 * ناوردا: متنِ خروجی **همیشه** آخرین گام را از `rewriteMarkers` می‌گیرد؛ پس هر شناسهٔ باقی‌مانده پذیرفته‌شده است،
 * حتی اگر نگهبان متن خراب باشد. هر ناسازگاریِ قرارداد پورت پرتاب می‌کند (⇒ `VERIFICATION_FAILED`)، نه «پذیرفته».
 */
import { lookupSource, type Context, type ContextSource } from "@/modules/retrieval";
import { rejectionMessage, safeCode } from "./errors";
import { idsOf, REDACTION_MARK, rewriteMarkers, scanMarkers } from "./markers";
import type { ParsedModelOutput } from "./model-output";
import { auditNumbers } from "./numbers";
import type { AnswerCitation, AnswerPolicy, CitationSession, OrchestratorWarning, Rejection, RejectionKind, SourceClaim, WithheldReason } from "./types";

export type GroundInput = Readonly<{
  question: string;
  output: ParsedModelOutput;
  context: Context;
  session: CitationSession;
  asOf: string;
  policy: AnswerPolicy;
  defaultDocumentId: string | null;
}>;

export type Grounded = Readonly<{
  status: "answered" | "answered-redacted" | "withheld";
  text: string | null;
  withheldReason: WithheldReason | null;
  citations: readonly AnswerCitation[];
  rejections: readonly Rejection[];
  unsupportedNumbers: readonly string[];
  warnings: readonly OrchestratorWarning[];
}>;

/** شناسهٔ ادعاشدهٔ مدل را برای گزارش پاک می‌کند: فقط شکل `S<n>`، وگرنه `null` (رشتهٔ دلخواهِ مدل به خروجی نمی‌رسد). */
const cleanId = (id: string): string | null => (/^S[0-9]{1,3}$/.test(id) ? id : null);

export function ground(input: GroundInput): Grounded {
  const { output, context, session, asOf, policy } = input;
  const rejections: Rejection[] = [];
  const warnings: OrchestratorWarning[] = [];
  const warn = (w: OrchestratorWarning): void => {
    if (!warnings.includes(w)) warnings.push(w);
  };
  const reject = (kind: RejectionKind, id: string | null, code: unknown): void => {
    const c = safeCode(code);
    rejections.push({ kind, id, code: c, message: rejectionMessage(c) });
    warn(kind === "mention" ? "TEXT_MENTION_REJECTED" : "CITATION_REJECTED");
  };

  const markers = scanMarkers(output.answer);
  for (const m of markers) if (m.ids === null) reject("marker", null, "malformed-marker");
  const used = idsOf(markers);

  // ورودی‌های فهرست `citations` مدل، به تفکیک شناسه (هر منبع می‌تواند چند نقل‌قول داشته باشد).
  const listed = new Map<string, (string | null)[]>();
  for (const e of output.citations) {
    const l = listed.get(e.source);
    if (l === undefined) listed.set(e.source, [e.quote]);
    else l.push(e.quote);
  }
  const allIds = [...used, ...[...listed.keys()].filter((id) => !used.includes(id))];

  const bad = new Set<string>();
  const sources = new Map<string, ContextSource>();
  const claims: SourceClaim[] = [];
  const owners: string[] = [];
  for (const id of allIds) {
    const src = lookupSource(context, id);
    if (src === null) {
      reject("claim", cleanId(id), "unknown-source");
      bad.add(id);
      continue;
    }
    sources.set(id, src);
    for (const quote of listed.get(id) ?? [null]) {
      if (policy.requireQuotes && quote === null) {
        reject("claim", id, "missing-quote");
        bad.add(id);
        continue;
      }
      claims.push({ citation: src.citation, quote });
      owners.push(id);
    }
  }

  const acceptedQuotes = new Map<string, string[]>();
  if (claims.length > 0) {
    const verdicts = session.verifyClaims(claims, asOf);
    if (!Array.isArray(verdicts) || verdicts.length !== claims.length) throw new Error("verifier returned a verdict count different from the claim count");
    verdicts.forEach((v, i) => {
      const id = owners[i] as string;
      const good = typeof v === "object" && v !== null && v.accepted === true && v.code === "valid";
      if (good) {
        const q = (claims[i] as SourceClaim).quote;
        if (q !== null) {
          const l = acceptedQuotes.get(id) ?? [];
          if (!l.includes(q)) l.push(q);
          acceptedQuotes.set(id, l);
        }
      } else {
        bad.add(id);
        reject("claim", id, typeof v === "object" && v !== null ? v.code : undefined);
      }
    });
  }
  const accepted: ReadonlySet<string> = new Set(used.filter((id) => !bad.has(id)));
  if (allIds.some((id) => !used.includes(id) && sources.has(id) && !bad.has(id))) warn("UNMARKED_CITATION");

  // خط دوم: ارجاع‌های آزادِ درون متن. روی متنِ پس از بازنویسی نشانه‌ها (تا بازه‌ها با همان متن بخوانند).
  const text1 = rewriteMarkers(output.answer, markers, accepted);
  const guard = session.guardText(text1, asOf, { defaultDocumentId: input.defaultDocumentId, marker: REDACTION_MARK });
  if (typeof guard !== "object" || guard === null || typeof guard.text !== "string" || !Array.isArray(guard.rejected)) throw new Error("text guard returned an invalid outcome");
  for (const r of guard.rejected) reject("mention", null, typeof r === "object" && r !== null ? r.code : undefined);

  // گام آخر همیشه از خودِ ماست (ناوردا): نشانهٔ ناپذیرفته‌ای که نگهبان بازگردانده باشد هم حذف می‌شود.
  const finalText = rewriteMarkers(guard.text, scanMarkers(guard.text), accepted);
  const present = idsOf(scanMarkers(finalText));
  const citations: AnswerCitation[] = present.map((id) => {
    const s = sources.get(id) as ContextSource;
    return { id, documentId: s.citation.documentId, article: s.citation.article, label: s.header.replace(/^\[S[0-9]+\]\s*/, ""), quotes: acceptedQuotes.get(id) ?? [] };
  });

  let withheldReason: WithheldReason | null = null;
  if (citations.length === 0) withheldReason = "no-valid-citation";
  else if (rejections.length > 0 && policy.onRejectedCitation === "withhold") withheldReason = "citation-rejected";
  if (withheldReason !== null) {
    return { status: "withheld", text: null, withheldReason, citations: [], rejections, unsupportedNumbers: [], warnings };
  }

  const unsupportedNumbers = auditNumbers(finalText, [...context.sources.map((s) => s.body), input.question]);
  if (unsupportedNumbers.length > 0) warn("UNSUPPORTED_NUMBERS");
  return {
    status: finalText === output.answer ? "answered" : "answered-redacted",
    text: finalText,
    withheldReason: null,
    citations,
    rejections,
    unsupportedNumbers,
    warnings,
  };
}
