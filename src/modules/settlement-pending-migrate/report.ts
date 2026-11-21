/** ساختِ گزارشِ بسته (خالص، داخلی). گزارش همیشه یک شیءِ JSONِ تخت با کلیدهای ثابت است؛ هیچ مقدارِ محیط/خطا در آن نیست. */
import type { PendingVerifyReport } from "@/modules/settlement-pending";
import { PENDING_MIGRATE_EXIT } from "./types";
import type { MigrationState, PendingCommandName, PendingMigrateCode, PendingMigrateOutcome, PendingMigrateReport, PendingPhase } from "./types";

export type ReportParts = Readonly<{
  command: PendingCommandName | "help" | "unknown";
  code: PendingMigrateCode;
  phase?: PendingPhase | undefined;
  pgCode?: string | undefined;
  migrations?: MigrationState | undefined;
  verify?: PendingVerifyReport | undefined;
  issues?: readonly string[] | undefined;
  usage?: readonly string[] | undefined;
  retries?: number | undefined;
  closed?: boolean | undefined;
}>;

export function buildOutcome(p: ReportParts): PendingMigrateOutcome {
  const exitCode = PENDING_MIGRATE_EXIT[p.code];
  const report: PendingMigrateReport = Object.freeze({
    tool: "settlement-pending-migrate" as const,
    command: p.command,
    ok: p.code === "OK",
    code: p.code,
    exitCode,
    ...(p.phase === undefined ? {} : { phase: p.phase }),
    ...(p.pgCode === undefined ? {} : { pgCode: p.pgCode }),
    ...(p.migrations === undefined ? {} : { migrations: p.migrations }),
    ...(p.verify === undefined ? {} : { verify: p.verify }),
    ...(p.issues === undefined ? {} : { issues: p.issues }),
    ...(p.usage === undefined ? {} : { usage: p.usage }),
    ...(p.retries === undefined || p.retries === 0 ? {} : { retries: p.retries }),
    ...(p.closed === undefined ? {} : { closed: p.closed }),
  });
  return Object.freeze({ exitCode, report });
}
