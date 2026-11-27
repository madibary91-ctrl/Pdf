/** ساختِ گزارشِ بسته (خالص، داخلی). گزارش همیشه یک شیءِ JSONِ تخت با کلیدهای ثابت است؛ هیچ مقدارِ محیط/خطا در آن نیست. */
import { MIGRATE_EXIT } from "./types";
import type { MigrateCode, MigrateCommandName, MigrateOutcome, MigrateReport, MigratePhase, PolicyState } from "./types";

export type ReportParts = Readonly<{
  command: MigrateCommandName | "help" | "unknown";
  code: MigrateCode;
  phase?: MigratePhase | undefined;
  pgCode?: string | undefined;
  state?: PolicyState | undefined;
  schemaCreated?: boolean | undefined;
  issues?: readonly string[] | undefined;
  usage?: readonly string[] | undefined;
  retries?: number | undefined;
  closed?: boolean | undefined;
}>;

export function buildOutcome(p: ReportParts): MigrateOutcome {
  const exitCode = MIGRATE_EXIT[p.code];
  const report: MigrateReport = Object.freeze({
    tool: "tool-policy-migrate" as const,
    command: p.command,
    ok: p.code === "OK",
    code: p.code,
    exitCode,
    ...(p.phase === undefined ? {} : { phase: p.phase }),
    ...(p.pgCode === undefined ? {} : { pgCode: p.pgCode }),
    ...(p.state === undefined ? {} : { state: p.state }),
    ...(p.schemaCreated === true ? { schemaCreated: true } : {}),
    ...(p.issues === undefined ? {} : { issues: p.issues }),
    ...(p.usage === undefined ? {} : { usage: p.usage }),
    ...(p.retries === undefined || p.retries === 0 ? {} : { retries: p.retries }),
    ...(p.closed === undefined ? {} : { closed: p.closed }),
  });
  return Object.freeze({ exitCode, report });
}
