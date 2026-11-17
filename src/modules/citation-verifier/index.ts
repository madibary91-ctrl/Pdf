/** رابط عمومی citation-verifier؛ هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود. */
export { verifyCitation, verifyCitations } from "./verify";
export { checkText, redactRejected, DEFAULT_REDACTION } from "./guard";
export { aliasTableFor, buildAliasTable, extractMentions } from "./extract";
export type { AliasTable } from "./extract";
export { checkQuote, MIN_QUOTE_CHARS } from "./tokens";
export type { QuoteCheck } from "./tokens";
export type {
  CheckedMention,
  CitationClaim,
  CitationReport,
  CitationVerdict,
  Evidence,
  Mention,
  MentionStatus,
  TextCheck,
  TextCheckOptions,
  VerdictCode,
  VerifyPolicy,
} from "./types";
