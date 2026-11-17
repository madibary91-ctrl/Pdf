/**
 * راستی‌آزمایی ارجاع ساختاریافته در برابر پایگاه دانش (خالص و قطعی؛ «امروز» از بیرون می‌آید).
 *
 * هرگز پرتاب نمی‌کند: ورودی بد = حکم `malformed`. تنها `valid` (و در حالت صریح `allowUnverified`، `unverified-source`)
 * پذیرفته می‌شود؛ بقیه رد.
 */
import { resolveCitation, type CorpusIndex, type IsoDate, type VersionLookup } from "@/modules/legal-kb-schema";
import { checkQuote } from "./tokens";
import type { CitationClaim, CitationReport, CitationVerdict, Evidence, VerdictCode, VerifyPolicy } from "./types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** بررسی شکلِ زمان اجرا (ادعا ممکن است از JSON مدل آمده باشد، نه از TypeScript). `null` = سالم. */
function shapeProblem(claim: unknown): string | null {
  if (!isRecord(claim)) return "ادعای ارجاع باید شیء باشد.";
  const ref = claim["ref"];
  if (!isRecord(ref)) return "ref ارجاع باید شیء باشد.";
  if (typeof ref["documentId"] !== "string" || ref["documentId"] === "") return "documentId باید متن غیرتهی باشد.";
  if (typeof ref["article"] !== "string") return "article باید متن باشد.";
  const sub = ref["subpart"];
  if (sub !== null && sub !== undefined) {
    if (!isRecord(sub) || typeof sub["kind"] !== "string" || typeof sub["label"] !== "string") return "subpart باید {kind,label} یا null باشد.";
  }
  const quote = claim["quote"];
  if (quote !== undefined && quote !== null && typeof quote !== "string") return "quote باید متن یا null باشد.";
  return null;
}

const reject = (code: VerdictCode, claim: CitationClaim, message: string, lookup: VersionLookup | null = null, evidence: Evidence | null = null): CitationVerdict => ({
  code,
  accepted: false,
  claim,
  message,
  lookup,
  evidence,
});

export function verifyCitation(index: CorpusIndex, claim: CitationClaim, onDate: IsoDate, policy: VerifyPolicy = {}): CitationVerdict {
  const problem = shapeProblem(claim);
  if (problem !== null) return reject("malformed", claim, problem);

  // subpart: undefined ⇒ null (شکل متعارف برای resolveCitation)
  const ref = { ...claim.ref, subpart: claim.ref.subpart ?? null };
  const r = resolveCitation(index, ref, onDate);
  if (!r.ok) return reject("malformed", claim, r.error.message);
  const found = r.value;

  switch (found.status) {
    case "unknown-document":
      return reject("unknown-document", claim, `سندی با شناسهٔ «${ref.documentId}» در پایگاه دانش نیست.`, found);
    case "unknown-article":
      return reject("unknown-article", claim, `ماده «${ref.article}» در سند «${ref.documentId}» نیست.`, found);
    case "unknown-subpart":
      return reject("unknown-subpart", claim, "تبصره/بند ادعاشده در متن معتبر این ماده (در تاریخ مورد نظر) نیست.", found);
    case "not-yet-in-force":
      return reject("not-yet-in-force", claim, `این ماده در ${onDate} هنوز معتبر نبوده؛ نخستین اعتبار: ${found.firstValidFrom}.`, found);
    case "no-longer-in-force":
      return reject("no-longer-in-force", claim, `این ماده در ${onDate} دیگر معتبر نیست؛ آخرین اعتبار تا ${found.lastValidTo}.`, found);
    case "gap":
      return reject("gap", claim, `در ${onDate} هیچ نسخه‌ای از این ماده معتبر نیست (شکاف از ${found.previousValidTo} تا ${found.nextValidFrom}).`, found);
    case "found": {
      const evidence: Evidence = {
        documentId: found.documentId,
        article: found.article,
        validFrom: found.version.validFrom,
        validTo: found.version.validTo,
        subpart: found.subpart === null ? null : { kind: found.subpart.kind, label: found.subpart.label },
        verified: found.verified,
      };
      if (claim.quote !== undefined && claim.quote !== null) {
        // ارجاع به تبصره/بند ⇒ نقل‌قول فقط از همان بخش؛ ارجاع به ماده ⇒ از متن ماده یا بخش‌های همان نسخه (نه ماده‌ای دیگر).
        const texts = found.subpart !== null ? [found.subpart.text] : [found.version.text, ...found.version.subparts.map((s) => s.text)];
        const q = checkQuote(claim.quote, texts);
        if (!q.ok) return reject("quote-mismatch", claim, q.reason, found, evidence);
      }
      if (!found.verified) {
        const allowed = policy.allowUnverified === true;
        return {
          code: "unverified-source",
          accepted: allowed,
          claim,
          message: allowed ? "نسخه هنوز توسط حقوقدان تأیید نشده؛ فقط با برچسب «تأییدنشده» نمایش داده شود." : "نسخهٔ این ماده هنوز توسط حقوقدان تأیید نشده و قابل‌استناد به کاربر نیست.",
          lookup: found,
          evidence,
        };
      }
      return { code: "valid", accepted: true, claim, message: "ارجاع معتبر، تأییدشده و هم‌خوان با پایگاه دانش است.", lookup: found, evidence };
    }
  }
}

export function verifyCitations(index: CorpusIndex, claims: readonly CitationClaim[], onDate: IsoDate, policy: VerifyPolicy = {}): CitationReport {
  const verdicts = claims.map((c) => verifyCitation(index, c, onDate, policy));
  const accepted = verdicts.filter((v) => v.accepted);
  const rejected = verdicts.filter((v) => !v.accepted);
  return { verdicts, accepted, rejected, allAccepted: rejected.length === 0 };
}
