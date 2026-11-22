/** رابط عمومی tool-loop (CT‑4a: کنترل‌گرِ خالصِ حلقهٔ ابزار)؛ هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود. */
export { createToolLoop } from "./loop";
export { resolveToolLoopConfig, LOOP_LIMITS } from "./config";
export { canonicalCallKey } from "./canonical";
export { budgetVerdict } from "./budget";
export type { BudgetVerdict } from "./budget";
export { LOOP_ERROR_CODES } from "./errors";
export type {
  BudgetPolicy,
  LoopAction,
  LoopError,
  LoopErrorCode,
  LoopOutcome,
  LoopPhase,
  LoopResult,
  LoopStartInput,
  LoopToolResult,
  LoopTransition,
  StepEstimateInput,
  StopReason,
  ToolLoop,
  ToolLoopConfig,
  ToolLoopState,
} from "./types";
