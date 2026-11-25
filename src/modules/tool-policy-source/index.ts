/**
 * رابط عمومی tool-policy-source (منبعِ تازه‌شوندهٔ سیاستِ ابزار؛ ADR-0071، برش CT‑5c‑2c‑1).
 * هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود.
 */
export { createPolicySource } from "./source";
export { SOURCE_LIMITS } from "./config";
export type {
  PolicyReader,
  PolicySnapshot,
  PolicySource,
  PolicySourceOptions,
  RefreshErrorCode,
  RefreshOutcome,
  RefreshResult,
  SnapshotErrorCode,
  SnapshotResult,
  SourceConfigError,
  SourceHealth,
  SourceState,
} from "./types";
