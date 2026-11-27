/**
 * رابط عمومی tool-policy-migrate (CT‑5c‑2c‑3، ADR-0080): CLIِ رسمیِ مهاجرتِ زمانِ استقرارِ شِمای نسخه‌های سیاستِ ابزار — `status` (فقط‌خواندنی) و
 * `up` (با `--create-schema` اختیاری)، با کدهای خروجِ بسته، گزارشِ JSONِ بی‌نشت و مهلتِ کل. هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود.
 */
export { runToolPolicyMigrate } from "./cli";
export { parseMigrateArgs, USAGE as TOOL_POLICY_MIGRATE_USAGE } from "./args";
export { MIGRATE_EXIT } from "./types";
export type {
  ArgsResult,
  CreateSchemaPort,
  MigrateCode,
  MigrateExitCode,
  MigrateInput,
  MigrateOutcome,
  MigratePhase,
  MigratePorts,
  MigrateReport,
  MigrateSettings,
  MigrateTimer,
  OpenedMigrateDatabase,
  PolicyState,
} from "./types";
