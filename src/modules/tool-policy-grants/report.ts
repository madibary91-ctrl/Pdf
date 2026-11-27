/** ساختِ گزارشِ بسته (خالص، داخلی). گزارش همیشه یک شیءِ JSONِ تخت با کلیدهای ثابت است؛ هیچ مقدارِ محیط/خطا در آن نیست. */
import { GRANTS_EXIT } from "./types";
import type { GrantsCode, GrantsCommandName, GrantsOutcome, GrantsPhase, GrantsReport } from "./types";

export type ReportParts = Readonly<{
  command: GrantsCommandName | "help" | "unknown";
  code: GrantsCode;
  phase?: GrantsPhase | undefined;
  pgCode?: string | undefined;
  role?: string | undefined;
  schema?: string | undefined;
  findings?: readonly string[] | undefined;
  wrote?: boolean | undefined;
  statements?: readonly string[] | undefined;
  issues?: readonly string[] | undefined;
  usage?: readonly string[] | undefined;
  closed?: boolean | undefined;
}>;

export function buildOutcome(p: ReportParts): GrantsOutcome {
  const exitCode = GRANTS_EXIT[p.code];
  const report: GrantsReport = Object.freeze({
    tool: "tool-policy-grants" as const,
    command: p.command,
    ok: p.code === "OK",
    code: p.code,
    exitCode,
    ...(p.phase === undefined ? {} : { phase: p.phase }),
    ...(p.pgCode === undefined ? {} : { pgCode: p.pgCode }),
    ...(p.role === undefined ? {} : { role: p.role }),
    ...(p.schema === undefined ? {} : { schema: p.schema }),
    ...(p.findings === undefined || p.findings.length === 0 ? {} : { findings: p.findings }),
    ...(p.wrote === true ? { wrote: true } : {}),
    ...(p.statements === undefined ? {} : { statements: p.statements }),
    ...(p.issues === undefined ? {} : { issues: p.issues }),
    ...(p.usage === undefined ? {} : { usage: p.usage }),
    ...(p.closed === undefined ? {} : { closed: p.closed }),
  });
  return Object.freeze({ exitCode, report });
}
