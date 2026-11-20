/**
 * رابط عمومی settlement-backlog-watch (م۳‑ه‑۴‑الف‑۲‑۱، ADR-0042): پایشِ زندهٔ پسماندِ زنگ — حلقهٔ پس‌زمینهٔ نمونه‌گیری با کش، نمای همگام برای پروب‌ها،
 * پیش‌فرض‌های امنِ قابل‌تنظیم و سیاستِ «liveness هرگز ۵۰۳ نمی‌شود». هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود.
 */
export { createBacklogWatch } from "./watch";
export { projectBacklogForProbe } from "./probe";
export { parseBacklogWatchEnv, SETTLEMENT_BACKLOG_WATCH_ENV } from "./env";
export { SETTLEMENT_BACKLOG_WATCH_DEFAULTS, SETTLEMENT_BACKLOG_WATCH_LIMITS } from "./config";
export type {
  BacklogEnvError,
  BacklogEnvOverrides,
  BacklogEnvResult,
  BacklogProbeProjection,
  BacklogProbeSection,
  BacklogReadyPolicy,
  BacklogView,
  BacklogViewStatus,
  BacklogWatch,
  BacklogWatchConfig,
  BacklogWatchConfigError,
  BacklogWatchPhase,
  WatchResult,
  WatchStartResult,
  WatchStopResult,
} from "./types";
