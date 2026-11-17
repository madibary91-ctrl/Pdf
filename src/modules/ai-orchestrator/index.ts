/** رابط عمومی ai-orchestrator (برش ۱: ستون فقرات پرسش‌وپاسخ مستند)؛ هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود. */
export { createOrchestrator } from "./orchestrator";
export { createCitationChecker } from "./checker";
export type { CorpusIndexSource } from "./checker";
export { resolveConfig } from "./config";
export { parseAskRequest, isCalendarDate, REQUEST_LIMITS } from "./request";
export { buildPrompt, neutralizeFences, PROMPT_VERSION, SYSTEM_PROMPT } from "./prompt";
export { parseModelOutput, OUTPUT_LIMITS } from "./model-output";
export type { ModelCitationEntry, ParsedModelOutput, ParseOutcome } from "./model-output";
export { scanMarkers, rewriteMarkers, idsOf, REDACTION_MARK } from "./markers";
export type { Marker } from "./markers";
export { auditNumbers, extractNumbers } from "./numbers";
export { ground } from "./ground";
export type { GroundInput, Grounded } from "./ground";
export { ERROR_CODES } from "./errors";
export type {
  Accounting,
  Answer,
  AnswerCitation,
  AnswerPolicy,
  AnswerStatus,
  AskInput,
  AskResult,
  CitationChecker,
  CitationSession,
  ClaimVerdict,
  GenerationSummary,
  Orchestrator,
  OrchestratorConfig,
  OrchestratorError,
  OrchestratorErrorCode,
  OrchestratorWarning,
  OrchResult,
  OutputInvalidReason,
  ParsedAsk,
  Rejection,
  RejectionKind,
  RejectedCitationPolicy,
  RetrievalOptions,
  RetrievalSummary,
  SourceClaim,
  TextGuardOptions,
  TextGuardOutcome,
  WithheldReason,
} from "./types";
