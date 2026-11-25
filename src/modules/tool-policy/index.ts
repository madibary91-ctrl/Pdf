/**
 * رابط عمومی tool-policy (سیاستِ آستانه‌های دروازهٔ ابزار؛ ADR-0067، برش CT‑5c‑2a).
 * هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود.
 */
export { DEFAULT_TOOL_POLICY, POLICY_LIMITS, POLICY_RATIOS } from "./policy";
export { resolveToolPolicy } from "./resolve";
export { checkPolicyRelations } from "./relations";
export { timingFromGrace } from "./derive";
export { projectToolPolicy } from "./project";
export { toolScopeId, SCOPE_PREFIX, MAX_REQUEST_ID_CHARS } from "./scope";
export type {
  OnUnknownCost,
  PolicyError,
  PolicyErrorCode,
  PolicyProjection,
  PolicyRelationInput,
  PolicyResult,
  ToolPolicy,
  ToolPolicyOverrides,
} from "./types";
