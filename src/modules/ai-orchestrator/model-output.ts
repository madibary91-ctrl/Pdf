/**
 * تحلیل خروجی مدل (خالص). سخت‌گیر و شکست‌به‌سمت‌ایمنی: هر انحراف از قالب = رد. هرگز محتوای خروجی را در `reason` نمی‌آورد.
 * شکل: JSON خام، یا دقیقاً یک بلوک ``` (با/بی `json`) — `{ answer, insufficient?, citations? }`.
 */
import type { OutputInvalidReason } from "./types";

export const OUTPUT_LIMITS = Object.freeze({ maxRawChars: 200_000, maxAnswerChars: 20_000, maxCitations: 32, maxQuoteChars: 2000, maxSourceIdChars: 32 });

export type ModelCitationEntry = Readonly<{ source: string; quote: string | null }>;

export type ParsedModelOutput = Readonly<{
  insufficient: boolean;
  answer: string;
  citations: readonly ModelCitationEntry[];
  /** خروجی در بلوک ``` پیچیده بود. */
  fenced: boolean;
  /** کلیدهایی جز `answer`/`insufficient`/`citations` داشت (نادیده گرفته شد). */
  extraFields: boolean;
}>;

export type ParseOutcome = Readonly<{ ok: true; value: ParsedModelOutput }> | Readonly<{ ok: false; reason: OutputInvalidReason }>;

const bad = (reason: OutputInvalidReason): ParseOutcome => ({ ok: false, reason });
const KNOWN: ReadonlySet<string> = new Set(["answer", "insufficient", "citations"]);
const FENCE_RE = /^```[ \t]*(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i;

export function parseModelOutput(raw: string): ParseOutcome {
  if (typeof raw !== "string") return bad("empty");
  if (raw.length > OUTPUT_LIMITS.maxRawChars) return bad("too-large");
  // `trim` خودش BOM (U+FEFF) را هم برمی‌دارد.
  let body = raw.trim();
  if (body === "") return bad("empty");
  let fenced = false;
  if (body.startsWith("```")) {
    const m = FENCE_RE.exec(body);
    if (m === null) return bad("bad-fence");
    body = (m[1] as string).trim();
    fenced = true;
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return bad("not-json");
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return bad("not-object");
  const rec = json as Record<string, unknown>;
  const extraFields = Object.keys(rec).some((k) => !KNOWN.has(k));

  const insRaw = rec["insufficient"];
  if (insRaw !== undefined && typeof insRaw !== "boolean") return bad("bad-field");
  const insufficient = insRaw === true;

  const citRaw = rec["citations"];
  const citations: ModelCitationEntry[] = [];
  if (citRaw !== undefined) {
    if (!Array.isArray(citRaw)) return bad("bad-field");
    if (citRaw.length > OUTPUT_LIMITS.maxCitations) return bad("too-large");
    for (const e of citRaw as unknown[]) {
      if (typeof e !== "object" || e === null || Array.isArray(e)) return bad("bad-field");
      const entry = e as Record<string, unknown>;
      const source = entry["source"];
      if (typeof source !== "string" || source === "" || source.length > OUTPUT_LIMITS.maxSourceIdChars) return bad("bad-field");
      const q = entry["quote"];
      let quote: string | null = null;
      if (q !== undefined && q !== null) {
        if (typeof q !== "string") return bad("bad-field");
        if (q.length > OUTPUT_LIMITS.maxQuoteChars) return bad("too-large");
        quote = q.trim() === "" ? null : q;
      }
      citations.push({ source, quote });
    }
  }

  if (insufficient) return { ok: true, value: { insufficient: true, answer: "", citations, fenced, extraFields } };
  const answer = rec["answer"];
  if (typeof answer !== "string" || answer.trim() === "") return bad("missing-answer");
  if (answer.length > OUTPUT_LIMITS.maxAnswerChars) return bad("too-large");
  return { ok: true, value: { insufficient: false, answer, citations, fenced, extraFields } };
}
