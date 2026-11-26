/**
 * رابط عمومی tool-policy-refresher (حلقهٔ تازه‌سازیِ دوره‌ایِ سیاستِ ابزار؛ ADR-0072، برش CT‑5c‑2c‑2a).
 * هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود.
 */
export { createPolicyRefresher } from "./refresher";
export { REFRESHER_LIMITS } from "./config";
export type {
  AttemptOutcome,
  PolicyRefresher,
  RefreshableSource,
  RefreshTimer,
  RefresherConfigError,
  RefresherFailureCode,
  RefresherOptions,
  RefresherResult,
  RefresherStartResult,
  RefresherState,
  RefresherStatus,
  RefresherStopResult,
  StartFailureReason,
} from "./types";
