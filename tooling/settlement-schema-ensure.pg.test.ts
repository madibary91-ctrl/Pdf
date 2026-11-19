/**
 * پذیرشِ سرتاسریِ م۳‑ه‑۳‑د (ADR-0035) با **فرایندهای واقعیِ** CLIِ رسمی روی PostgreSQL واقعی.
 * پیش از اصلاح: دو `up`ِ هم‌زمان روی شِمای تازه تقریباً همیشه یکی را به `23505 pg_namespace_nspname_index` می‌رساندند و فقط بازتلاشِ
 * کران‌دارِ CLI آن را می‌پوشاند (۱۹ بازتلاش در ۲۰ دور). این آزمون قرارداد را قفل می‌کند: **هیچ بازتلاشی** (`retries`) مصرف نمی‌شود؛
 * یعنی ریشه درست است و بازتلاش دیگر دفاعِ لایه‌ایِ بی‌کار است، نه پوششِ یک باگِ همیشگی.
 * شِماهای یک‌بارمصرفِ `se_l_*`/`se_s_*`؛ هر فرایند یک اتصال (بودجهٔ اتصال، ADR-0024).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { Client } from "pg";
import { describe, expect, it } from "vitest";

config({ quiet: true });
const DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const dbDescribe = typeof DB_URL === "string" && DB_URL !== "" ? describe : describe.skip;
const ROUNDS = 6;

type Run = Readonly<{ code: number | null; stdout: string; stderr: string }>;

function runUp(env: Readonly<Record<string, string>>): Promise<Run> {
  // محیطِ حداقلی: هیچ SETTLEMENT_* یا اسراری از محیطِ آزمون به فرایند نمی‌رسد.
  const childEnv = { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...env } as unknown as NodeJS.ProcessEnv;
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--import", "./tooling/cli/register.mjs", "tooling/cli/settlement-migrate.ts", "up", "--timeout-ms=60000"],
      { env: childEnv, cwd: process.cwd() },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

dbDescribe("tooling · دو up هم‌زمانِ فرایندِ واقعی روی شِمای تازه (PostgreSQL)", () => {
  it(`${ROUNDS} دور: هر دو خروج ۰، هر مهاجرت دقیقاً یک بار اعمال می‌شود و هیچ بازتلاشی مصرف نمی‌شود`, async () => {
    const admin = new Client({ connectionString: DB_URL, application_name: "schema-ensure-e2e-admin" });
    await admin.connect();
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const tag = randomBytes(5).toString("hex");
        const ledger = `se_l_${tag}`;
        const outbox = `se_s_${tag}`;
        const env = { DATABASE_URL: DB_URL as string, SETTLEMENT_LEDGER_SCHEMA: ledger, SETTLEMENT_OUTBOX_SCHEMA: outbox };
        try {
          const [a, b] = await Promise.all([runUp(env), runUp(env)]);
          for (const r of [a, b]) {
            expect(r.stderr, `دور ${round}`).toBe("");
            expect(r.code, `دور ${round}: ${r.stdout}`).toBe(0);
          }
          const reports = [a, b].map((r) => JSON.parse(r.stdout.trim()) as Record<string, unknown> & { ledger: { appliedNow: string[]; applied: string[] }; settlement: { appliedNow: string[]; applied: string[] } });
          for (const rep of reports) {
            expect(rep["code"], `دور ${round}`).toBe("OK");
            // کلیدِ retries فقط وقتی بازتلاش مصرف شده در گزارش می‌آید (report.ts): نبودنش یعنی مسابقه‌ای رخ نداده.
            expect("retries" in rep, `دور ${round}: بازتلاش مصرف شد: ${JSON.stringify(rep)}`).toBe(false);
          }
          const [ra, rb] = reports as [(typeof reports)[number], (typeof reports)[number]];
          expect(ra.ledger.appliedNow.length + rb.ledger.appliedNow.length, `دور ${round}`).toBe(ra.ledger.applied.length);
          expect(ra.settlement.appliedNow.length + rb.settlement.appliedNow.length, `دور ${round}`).toBe(ra.settlement.applied.length);
          const rows = await admin.query(`SELECT count(*)::int AS n FROM "${ledger}".migration_ledger`);
          expect((rows.rows[0] as { n: number }).n).toBe(ra.ledger.applied.length);
        } finally {
          await admin.query(`DROP SCHEMA IF EXISTS "${ledger}" CASCADE`);
          await admin.query(`DROP SCHEMA IF EXISTS "${outbox}" CASCADE`);
        }
      }
    } finally {
      await admin.end();
    }
  }, 180_000);
});
