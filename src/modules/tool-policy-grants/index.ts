/**
 * رابط عمومی tool-policy-grants (CT‑5c‑2c‑4، ADR-0081): CLIِ رسمیِ حقوقِ نقشِ زمانِ اجرای سیاستِ ابزار — `plan` (بی‌اتصال)، `verify` (فقط‌خواندنی؛
 * سنجشِ حقوقِ مؤثر در برابرِ قرارداد) و `apply` (REVOKE/GRANTِ همگراکننده در یک تراکنش و خواندنِ دوباره)، با کدهای خروجِ بسته و گزارشِ JSONِ بی‌نشت.
 * هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود.
 */
export { runToolPolicyGrants } from "./cli";
export { parseGrantsArgs, USAGE as TOOL_POLICY_GRANTS_USAGE } from "./args";
export { planStatements } from "./plan";
export { GRANTS_EXIT } from "./types";
export { RUNTIME_CONTRACT, CONTRACT_TABLES, parseRole as parseRuntimeRole } from "./contract";
export type {
  ArgsResult,
  GrantsCode,
  GrantsExitCode,
  GrantsInput,
  GrantsOutcome,
  GrantsPhase,
  GrantsPorts,
  GrantsReport,
  GrantsSettings,
  GrantsTimer,
  OpenedGrantsDatabase,
  QueryPort,
  TransactPort,
} from "./types";
