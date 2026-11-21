/**
 * رابط عمومی settlement-pending-migrate (م۳‑ه‑۴‑الف‑۲‑۴‑ب‑۲‑۱، ADR-0047): CLIِ رسمیِ نمایهٔ «مرده‌های در انتظارِ تأیید» — `status` (فقط‌خواندنی)،
 * `up` (نصبِ اختیاری + راستی‌آزمایی) و `verify` (سنجشِ نمایه در برابر حقیقت)، با کدهای خروجِ بسته، گزارشِ JSONِ بی‌نشت و مهلتِ کل.
 * هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود.
 */
export { runPendingMigrate } from "./cli";
export { parsePendingMigrateArgs, USAGE as PENDING_MIGRATE_USAGE } from "./args";
export { PENDING_MIGRATE_EXIT } from "./types";
export type {
  ArgsResult,
  IndexResult,
  MigrationState,
  OpenedPendingDatabase,
  PendingCommandName,
  PendingMigratable,
  PendingMigrateCode,
  PendingMigrateExitCode,
  PendingMigrateInput,
  PendingMigrateOutcome,
  PendingMigratePorts,
  PendingMigrateReport,
  PendingMigrateSettings,
  PendingPhase,
} from "./types";
