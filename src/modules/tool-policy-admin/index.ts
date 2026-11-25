/**
 * رابط عمومی tool-policy-admin (مدیریتِ نسخه‌دارِ سیاستِ دروازهٔ ابزار؛ ADR-0069، برش CT‑5c‑2b‑1).
 * هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود.
 */
export { createToolPolicyAdmin } from "./admin";
export { createMemoryPolicyStore } from "./memory-store";
export { ADMIN_LIMITS, ACTOR_RE } from "./validate";
/** مرزِ رکورد برای آداپتورهای ذخیره‌ساز (ADR-0070): بازسازیِ مستقل و عمیق‌یخ‌زده؛ `null` = خراب. */
export { parseRecord as parsePolicyRecord } from "./validate";
export type {
  AdminError,
  AdminErrorCode,
  AdminResult,
  AppliedVersion,
  CurrentPolicy,
  HistoryPage,
  PolicyChange,
  PolicyClock,
  PolicyVersionRecord,
  PolicyVersionSource,
  PolicyVersionStore,
  StoreErrorCode,
  StoreResult,
  ToolPolicyAdmin,
} from "./types";
