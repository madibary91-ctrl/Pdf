/**
 * رابط عمومی settlement-backlog (م۳‑ه‑۴‑الف‑۱، ADR-0039): پایشِ پسماندِ زنگِ ماندگار — شمارِ مرده‌های تأییدنشده و سنِ قدیمی‌ترینشان،
 * ارزیابیِ خالصِ `ok/degraded/down` با آستانه‌های الزامیِ مالک. هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود.
 */
export { createDeadLetterBacklogMonitor } from "./monitor";
export { SETTLEMENT_BACKLOG_LIMITS } from "./config";
export type {
  BacklogByReason,
  BacklogClock,
  BacklogConfigError,
  BacklogHealth,
  BacklogMonitor,
  BacklogMonitorConfig,
  BacklogOutbox,
  BacklogReason,
  BacklogReasonCode,
  BacklogResult,
  BacklogSample,
  BacklogSampleFailure,
  BacklogThresholds,
} from "./types";
