/**
 * `runPendingMigrate` — CLIِ رسمیِ نصب/وضعیت/راستی‌آزماییِ نمایهٔ «مرده‌های در انتظارِ تأیید» (م۳‑ه‑۴‑الف‑۲‑۴‑ب‑۲‑۱، ADR-0047). **هرگز نمی‌پرتابد و رد نمی‌شود.**
 * جریان: آرگومان/env ← (خطا ⇒ `USAGE` بی‌اتصال) ← نمایه (شِمای نامعتبر ⇒ `USAGE` بی‌اتصال) ← `execute` زیرِ مهلتِ کل ← بستنِ کران‌دارِ اتصال ← یک خط JSON روی `write`.
 * مهلتِ کل با زمان‌سنجِ تزریقی: پایگاهِ آویزان یا قفلِ مشورتی نباید استقرار را بی‌پایان نگه دارد؛ تراکنشِ نیمه‌کار با بسته‌شدنِ اتصال برمی‌گردد.
 * خروجی: `{exitCode, report}`؛ گلو `exitCode` را به فرایند می‌دهد و اگر `report.closed === false` باشد فرایند را سخت می‌بُرد.
 */
import { bounded } from "./deadline";
import { parsePendingMigrateArgs, USAGE } from "./args";
import { execute, type Progress } from "./execute";
import { createLazyDatabase } from "./lazy-database";
import { buildOutcome } from "./report";
import { createRealIndex } from "./stores";
import type { PendingMigrateOutcome, PendingMigratePorts } from "./types";

const isFn = (v: unknown): boolean => typeof v === "function";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function emit(write: unknown, outcome: PendingMigrateOutcome): void {
  if (!isFn(write)) return;
  try {
    (write as (line: string) => unknown)(`${JSON.stringify(outcome.report)}\n`);
  } catch {
    // نوشتنِ ناموفق کدِ خروج را عوض نمی‌کند.
  }
}

export async function runPendingMigrate(raw: unknown): Promise<PendingMigrateOutcome> {
  let write: unknown;
  try {
    if (!isObj(raw)) return buildOutcome({ command: "unknown", code: "INTERNAL", issues: ["ورودی باید شیء باشد."] });
    const ports = raw["ports"];
    write = isObj(ports) ? ports["write"] : undefined;
    const timer = isObj(ports) ? ports["timer"] : undefined;
    const portIssues: string[] = [];
    if (!isObj(ports) || !isFn(ports["open"])) portIssues.push("ports.open باید تابع باشد.");
    if (!isFn(write)) portIssues.push("ports.write باید تابع باشد.");
    if (!isObj(timer) || !isFn(timer["after"]) || !isFn(timer["cancel"])) portIssues.push("ports.timer باید after و cancel داشته باشد.");
    if (isObj(ports) && ports["createIndex"] !== undefined && !isFn(ports["createIndex"])) portIssues.push("ports.createIndex باید تابع باشد.");
    if (portIssues.length > 0) {
      const out = buildOutcome({ command: "unknown", code: "INTERNAL", issues: Object.freeze(portIssues) });
      emit(write, out);
      return out;
    }
    const p = ports as unknown as PendingMigratePorts;

    const parsed = parsePendingMigrateArgs(raw["argv"], raw["env"]);
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

    const lazy = createLazyDatabase(p.open);
    const made = (p.createIndex ?? createRealIndex)(lazy.db, { schema: settings.schema, readStatementTimeoutMs: settings.timeoutMs });
    if (!made.ok) {
      const out = buildOutcome({ command: settings.command, code: "USAGE", issues: made.issues, usage: USAGE });
      emit(write, out);
      return out;
    }

    const progress: Progress = { phase: "check", migrations: undefined, verify: undefined, cancelled: false, retries: 0 };
    const run = await bounded(p.timer, settings.timeoutMs, () => execute(settings.command, made.index, progress));
    if (run.kind !== "done") progress.cancelled = true;
    const closed = await lazy.close(p.timer);

    let out: PendingMigrateOutcome;
    if (run.kind === "done") {
      const v = run.value;
      out = buildOutcome({
        command: settings.command,
        code: lazy.invalid() ? "INTERNAL" : v.code,
        phase: v.phase,
        pgCode: lazy.invalid() ? undefined : v.pgCode,
        migrations: progress.migrations,
        verify: progress.verify,
        retries: progress.retries,
        closed,
      });
    } else {
      out = buildOutcome({
        command: settings.command,
        code: run.kind === "timeout" ? "TIMEOUT" : "INTERNAL",
        phase: progress.phase,
        migrations: progress.migrations,
        verify: progress.verify,
        retries: progress.retries,
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
