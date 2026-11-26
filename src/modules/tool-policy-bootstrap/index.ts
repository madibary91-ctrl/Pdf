/**
 * رابط عمومی tool-policy-bootstrap (ADR-0076، برش CT‑5c‑2c‑2b‑3b): مرزِ برنامه برای میزبانِ سیاستِ ابزار — سیاستِ env، بوتِ بی‌مسدودی، پاسخ HTTP پروب‌ها.
 * هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود.
 */
import {
  ENV_ATTEMPT_DEADLINE_MS,
  ENV_BOOT_ATTEMPTS,
  ENV_BOOT_RETRY_DELAY_MS,
  ENV_HOST,
  ENV_INTERVAL_MS,
  ENV_MAX_STALE_MS,
  ENV_REFRESH_TIMEOUT_MS,
  ENV_RETRY_MS,
  ENV_SCHEMA,
  ENV_SHUTDOWN_TIMEOUT_MS,
  ENV_STATEMENT_TIMEOUT_MS,
} from "./env";

export { startToolPolicyBootstrap } from "./bootstrap";
export { parseBootstrapEnv } from "./env";
export { probeHttpResponse } from "./http";
/** نامِ متغیرهای محیطِ شناخته‌شده (مستند؛ مقدار ندارد). */
export const TOOL_POLICY_BOOTSTRAP_ENV = Object.freeze({
  host: ENV_HOST,
  intervalMs: ENV_INTERVAL_MS,
  retryMs: ENV_RETRY_MS,
  attemptDeadlineMs: ENV_ATTEMPT_DEADLINE_MS,
  refreshTimeoutMs: ENV_REFRESH_TIMEOUT_MS,
  maxStaleMs: ENV_MAX_STALE_MS,
  schema: ENV_SCHEMA,
  statementTimeoutMs: ENV_STATEMENT_TIMEOUT_MS,
  shutdownTimeoutMs: ENV_SHUTDOWN_TIMEOUT_MS,
  bootAttempts: ENV_BOOT_ATTEMPTS,
  bootRetryDelayMs: ENV_BOOT_RETRY_DELAY_MS,
});
export type {
  BootstrapConfig,
  BootstrapErrorCode,
  BootstrapEvent,
  BootstrapOutcome,
  BootstrapSettings,
  EnvResult,
  OpenedDatabase,
  ProcessOwner,
} from "./types";
