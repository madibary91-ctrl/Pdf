/**
 * رابط عمومی settlement-migrate (م۳‑ه‑۳‑ج، ADR-0034): CLIِ رسمیِ مهاجرتِ زمانِ استقرار — `status` (فقط‌خواندنی) و `up` (دفتر ← outbox)،
 * با کدهای خروجِ بسته، گزارشِ JSONِ بی‌نشت و مهلتِ کل. هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود.
 */
export { runSettlementMigrate } from "./cli";
export { parseMigrateArgs, USAGE as SETTLEMENT_MIGRATE_USAGE } from "./args";
export { MIGRATE_EXIT } from "./types";
export type {
  ArgsResult,
  MigrateCode,
  MigrateExitCode,
  MigrateInput,
  MigrateOutcome,
  MigratePhase,
  MigratePorts,
  MigrateReport,
  MigrateSettings,
  MigrateStage,
  OpenedMigrateDatabase,
  StoreState,
} from "./types";
