/**
 * رابط عمومی tool-policy-binding (ADR-0077، برش CT‑5c‑2c‑2b‑2a): پین‌کردنِ سیاستِ معتبر به‌ازای هر درخواست، شکست‌بسته.
 * هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود.
 */
export { createPolicyBinding } from "./binding";
export type {
  AcquireResult,
  BindingConfigError,
  BindingCreateResult,
  BindingEvent,
  BindingStatus,
  PolicyBinding,
  PolicyBindingOptions,
  PolicyLease,
  PolicyUnavailable,
  PolicyUnavailableReason,
  SnapshotPort,
} from "./types";
