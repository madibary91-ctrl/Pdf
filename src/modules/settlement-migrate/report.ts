/** ساختِ گزارشِ بسته (خالص، داخلی). گزارش همیشه یک شیءِ JSONِ تخت با کلیدهای ثابت است؛ هیچ مقدارِ محیط/خطا در آن نیست. */
import { MIGRATE_EXIT } from "./types";
import type { MigrateCode, MigrateCommandName, MigrateOutcome, MigrateReport, MigratePhase, MigrateStage, StoreState } from "./types";

export type ReportParts = Readonly<{
  command: MigrateCommandName | "help" | "unknown";
  code: MigrateCode;
  phase?: MigratePhase | undefined;
  stage?: MigrateStage | undefined;
  pgCode?: string | undefined;
  ledger?: StoreState | undefined;
  settlement?: StoreState | undefined;
  issues?: readonly string[] | undefined;
  usage?: readonly string[] | undefined;
  retries?: number | undefined;
  closed?: boolean | undefined;
}>;

export function buildOutcome(p: ReportParts): MigrateOutcome {
  const exitCode = MIGRATE_EXIT[p.code];
  const report: MigrateReport = Object.freeze({
    tool: "settlement-migrate" as const,
    command: p.command,
    ok: p.code === "OK",
    code: p.code,
    exitCode,
    ...(p.phase === undefined ? {} : { phase: p.phase }),
    ...(p.stage === undefined ? {} : { stage: p.stage }),
    ...(p.pgCode === undefined ? {} : { pgCode: p.pgCode }),
    ...(p.ledger === undefined ? {} : { ledger: p.ledger }),
    ...(p.settlement === undefined ? {} : { settlement: p.settlement }),
    ...(p.issues === undefined ? {} : { issues: p.issues }),
    ...(p.usage === undefined ? {} : { usage: p.usage }),
    ...(p.retries === undefined || p.retries === 0 ? {} : { retries: p.retries }),
    ...(p.closed === undefined ? {} : { closed: p.closed }),
  });
  return Object.freeze({ exitCode, report });
}
