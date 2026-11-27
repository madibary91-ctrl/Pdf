/**
 * `runToolPolicyGrants` — CLIِ رسمیِ حقوقِ نقشِ زمانِ اجرای سیاستِ ابزار (CT‑5c‑2c‑4، ADR-0081). **هرگز نمی‌پرتابد و رد نمی‌شود.**
 * جریان: آرگومان/env ← (خطا ⇒ `USAGE` بی‌اتصال) ← `plan`: چاپِ دستورها بی‌اتصال ← `verify`/`apply`: `execute` زیرِ مهلتِ کل ← بستنِ کران‌دارِ اتصال ← یک خط JSON.
 * خروجی: `{exitCode, report}`؛ گلو `exitCode` را به فرایند می‌دهد و اگر `report.closed === false` باشد فرایند را سخت می‌بُرد.
 */
import { DEFAULT_TIMEOUT_MS, USAGE, parseGrantsArgs } from "./args";
import { DEFAULT_POLICY_SCHEMA } from "./contract";
import { bounded } from "./deadline";
import { execute, type Progress } from "./execute";
import { createLazyDatabase } from "./lazy-database";
import { planStatements } from "./plan";
import { buildOutcome } from "./report";
import type { GrantsOutcome, GrantsPorts } from "./types";

const isFn = (v: unknown): boolean => typeof v === "function";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function emit(write: unknown, outcome: GrantsOutcome): void {
  if (!isFn(write)) return;
  try {
    (write as (line: string) => unknown)(`${JSON.stringify(outcome.report)}\n`);
  } catch {
    // نوشتنِ ناموفق کدِ خروج را عوض نمی‌کند.
  }
}

export async function runToolPolicyGrants(raw: unknown): Promise<GrantsOutcome> {
  let write: unknown;
  try {
    if (!isObj(raw)) return buildOutcome({ command: "unknown", code: "INTERNAL", issues: ["ورودی باید شیء باشد."] });
    const ports = raw["ports"];
    write = isObj(ports) ? ports["write"] : undefined;
    const timer = isObj(ports) ? ports["timer"] : undefined;
    const portIssues: string[] = [];
    if (!isObj(ports) || !isFn(ports["open"])) portIssues.push("ports.open باید تابع باشد.");
    if (!isObj(ports) || !isFn(ports["query"])) portIssues.push("ports.query باید تابع باشد.");
    if (!isObj(ports) || !isFn(ports["transact"])) portIssues.push("ports.transact باید تابع باشد.");
    if (!isFn(write)) portIssues.push("ports.write باید تابع باشد.");
    if (!isObj(timer) || !isFn(timer["after"]) || !isFn(timer["cancel"])) portIssues.push("ports.timer باید after و cancel داشته باشد.");
    if (portIssues.length > 0) {
      const out = buildOutcome({ command: "unknown", code: "INTERNAL", issues: Object.freeze(portIssues) });
      emit(write, out);
      return out;
    }
    const p = ports as unknown as GrantsPorts;

    const parsed = parseGrantsArgs(raw["argv"], raw["env"]);
    if (!parsed.ok) {
      const out = buildOutcome({ command: parsed.command ?? "unknown", code: "USAGE", issues: parsed.issues, usage: USAGE });
      emit(write, out);
      return out;
    }
    if (parsed.value.command === "help") {
      const out = buildOutcome({ command: "help", code: "OK", usage: USAGE });
      emit(write, out);
      return out;
    }
    const settings = parsed.value;
    const schema = settings.schema ?? DEFAULT_POLICY_SCHEMA;

    if (settings.command === "plan") {
      const out = buildOutcome({ command: "plan", code: "OK", role: settings.role, schema, statements: planStatements(schema, settings.role, DEFAULT_TIMEOUT_MS) });
      emit(write, out);
      return out;
    }

    const lazy = createLazyDatabase(p.open);
    const progress: Progress = { phase: "check", findings: undefined, wrote: false, cancelled: false };
    const run = await bounded(p.timer, settings.timeoutMs, () => execute(settings, schema, p, lazy.get, progress));
    if (run.kind !== "done") progress.cancelled = true;
    const closed = await lazy.close(p.timer);

    let out: GrantsOutcome;
    if (run.kind === "done") {
      const v = run.value;
      const bad = lazy.invalid();
      out = buildOutcome({
        command: settings.command,
        code: bad ? "INTERNAL" : v.code,
        phase: v.phase,
        pgCode: bad ? undefined : v.pgCode,
        role: settings.role,
        schema,
        findings: progress.findings,
        wrote: progress.wrote,
        closed,
      });
    } else {
      out = buildOutcome({
        command: settings.command,
        code: run.kind === "timeout" ? "TIMEOUT" : "INTERNAL",
        phase: progress.phase,
        role: settings.role,
        schema,
        findings: progress.findings,
        wrote: progress.wrote,
        closed,
      });
    }
    emit(write, out);
    return out;
  } catch {
    const out = buildOutcome({ command: "unknown", code: "INTERNAL" });
    emit(write, out);
    return out;
  }
}
