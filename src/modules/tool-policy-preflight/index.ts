/**
 * رابط عمومی tool-policy-preflight (ADR-0078، برش CT‑5c‑2c‑2b‑2a′): پیش‌بازرسیِ انتشارِ سیاست با همان مسیرِ اجرا.
 * هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود.
 */
export { preflightToolPolicy } from "./preflight";
export { createPreflightedAdmin } from "./guarded-admin";
export type {
  PreflightConfigError,
  PreflightError,
  PreflightOptions,
  PreflightPassed,
  PreflightResult,
  PreflightStage,
  PreflightedAdmin,
  PreflightedAdminOptions,
  PreflightedAdminResult,
  PreflightedResult,
} from "./types";
