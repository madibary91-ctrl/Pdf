/**
 * رابط عمومی settlement-runtime (م۳‑ه‑۲، ADR-0031): ریشهٔ ترکیبِ رفتگرِ تسویه — زمان‌سنجِ Node، ساعتِ سیستم، چرخهٔ عمرِ مرتب و سلامتِ همگام.
 * هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود.
 */
export { createSettlementRuntime } from "./runtime";
export { createPgSettlementRuntime } from "./pg-runtime";
export { createNodeTimer } from "./node-timer";
export { createSystemClock } from "./clock";
export { SETTLEMENT_RUNTIME_LIMITS } from "./assemble";
export type {
  NodeTimerOptions,
  PgSettlementRuntime,
  PgSettlementRuntimeConfig,
  PreflightCode,
  PreflightResult,
  RuntimeConfigError,
  RuntimeDeadLetters,
  RuntimeHealth,
  RuntimeMigrateResult,
  RuntimePorts,
  RuntimeResult,
  RuntimeStartResult,
  RuntimeState,
  RuntimeStatus,
  RuntimeTuning,
  SettlementRuntime,
  SettlementRuntimeConfig,
  StartFailureReason,
} from "./types";
