/**
 * رابط عمومی settlement-bootstrap (م۳‑ه‑۳‑ب، ADR-0033): مرزِ برنامه برای رفتگرِ تسویه — سیاستِ env، بوتِ بی‌مسدودی، پاسخ HTTP پروب‌ها.
 * هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود.
 */
import { ENV_BOOT_ATTEMPTS, ENV_BOOT_RETRY_DELAY_MS, ENV_GRACE_MS, ENV_HOST, ENV_LEDGER_SCHEMA, ENV_OUTBOX_SCHEMA, ENV_SHUTDOWN_TIMEOUT_MS } from "./env";

export { startSettlementBootstrap } from "./bootstrap";
export { parseBootstrapEnv } from "./env";
export { probeHttpResponse } from "./http";
/** نامِ متغیرهای محیطِ شناخته‌شده (مستند؛ مقدار ندارد). */
export const SETTLEMENT_BOOTSTRAP_ENV = Object.freeze({
  host: ENV_HOST,
  graceMs: ENV_GRACE_MS,
  shutdownTimeoutMs: ENV_SHUTDOWN_TIMEOUT_MS,
  bootAttempts: ENV_BOOT_ATTEMPTS,
  bootRetryDelayMs: ENV_BOOT_RETRY_DELAY_MS,
  ledgerSchema: ENV_LEDGER_SCHEMA,
  outboxSchema: ENV_OUTBOX_SCHEMA,
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
