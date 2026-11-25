/**
 * رابط عمومی tool-policy-store-pg (آداپتور PostgreSQL ذخیره‌سازِ نسخه‌های سیاستِ ابزار؛ ADR-0070، برش CT‑5c‑2b‑2).
 * هر چیز دیگرِ این پوشه داخلی است و از بیرونِ ماژول نباید import شود.
 */
export { createPgPolicyVersionStore, STORE_LIMITS } from "./store";
export { TOOL_POLICY_DEFAULT_SCHEMA } from "./naming";
export type {
  PgPolicyError,
  PgPolicyErrorCode,
  PgPolicyMigrationReport,
  PgPolicyResult,
  PgPolicyStoreOptions,
  PgPolicyStoreStatus,
  PgPolicyVersionStore,
  PolicyPgDatabase,
  PolicyPgExecutor,
} from "./types";
