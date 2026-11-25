/**
 * رابط عمومی tool-call-deadline (سقفِ سختِ مهلتِ تماسِ مدل؛ ADR-0066، برش MT-2d).
 * هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود.
 */
export { createDeadlineToolGateway, DEADLINE_MESSAGES } from "./deadline";
export { checkTimingRelations } from "./relations";
export { CALL_DEADLINE_LIMITS } from "./config";
export type { CallDeadlineError, CallDeadlineErrorCode, CallDeadlineOptions, CallDeadlineResult, DeadlineEvent, TimingRelationInput } from "./types";
