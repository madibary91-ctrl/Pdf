/**
 * آداپتور واقعیِ پورت `CitationChecker` روی `citation-verifier`. نمایه به‌ازای هر نشست از «منبعِ نمایه» گرفته می‌شود
 * (نه یک‌بار برای همیشه)؛ سیاست همیشه سخت است: بندِ تأییدنشده پذیرفته نمی‌شود (`allowUnverified: false`).
 * نوع نمایه از امضای `verifyCitations` استخراج می‌شود تا `legal-kb-schema` (که اعلام وابستگی نشده) import نشود.
 */
import { checkText, redactRejected, verifyCitations } from "@/modules/citation-verifier";
import type { CitationChecker, ClaimVerdict, SourceClaim, TextGuardOutcome, TextGuardOptions } from "./types";

type CorpusIndex = Parameters<typeof verifyCitations>[0];
type IsoDate = Parameters<typeof verifyCitations>[2];

export type CorpusIndexSource = Readonly<{ current(): CorpusIndex | Promise<CorpusIndex> }>;

export function createCitationChecker(source: CorpusIndexSource): CitationChecker {
  const current = source.current.bind(source);
  return {
    async open() {
      const index = await current();
      return {
        verifyClaims(claims: readonly SourceClaim[], asOf: string): readonly ClaimVerdict[] {
          const report = verifyCitations(
            index,
            claims.map((c) => ({ ref: c.citation, ...(c.quote === null ? {} : { quote: c.quote }) })),
            asOf as IsoDate,
            { allowUnverified: false },
          );
          return report.verdicts.map((v) => ({ accepted: v.accepted, code: v.code }));
        },
        guardText(text: string, asOf: string, options: TextGuardOptions): TextGuardOutcome {
          const check = checkText(index, text, asOf as IsoDate, { allowUnverified: false, defaultDocumentId: options.defaultDocumentId });
          const redacted = redactRejected(text, check, options.marker);
          if (!redacted.ok) throw new Error("text guard: redaction failed");
          return { text: redacted.value, found: check.mentions.length, rejected: check.rejected.map((r) => ({ code: r.verdict === null ? r.mention.status : r.verdict.code })) };
        },
      };
    },
  };
}
