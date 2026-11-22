/**
 * `npm run settlement:pending -- down --yes` به‌صورتِ فرایندِ واقعی (ADR-0049) روی PostgreSQL واقعی: همان مسیری که استقرار می‌زند.
 * چیزی که آزمونِ درون‌فرایندی نمی‌گیرد: کدِ خروجِ واقعیِ فرایند، stdout یک‌خطی و stderr خالی، و اینکه با مهلت/SIGTERM
 * **برگشتِ نیمه‌کار هرگز اعمال نمی‌شود** (فرایند می‌میرد؛ نصب تا آخر دست‌نخورده می‌ماند). شِمای یک‌بارمصرفِ `pq_<تصادفی>`.
 * آزمون‌های قفل‌شدهٔ ۰۰۴۷ دست‌نخورده‌اند؛ این فایل فقط افزوده شده است.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import type { LedgerDatabase } from "@/modules/ledger";
import { createPgSettlementOutbox } from "@/modules/settlement";
import { CANARY, SECRET_URL } from "./test-kit";
import type { PendingMigrateReport } from "./types";

config({ quiet: true });
const DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const dbDescribe = typeof DB_URL === "string" && DB_URL !== "" ? describe : describe.skip;
const ROOT = join(__dirname, "..", "..", "..");
const IDLE_MS = 50;
const NODE_ARGS = ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--import", "./tooling/cli/register.mjs", "tooling/cli/settlement-pending-migrate.ts"];

type Run = Readonly<{ code: number | null; stdout: string; stderr: string; report: PendingMigrateReport }>;

dbDescribe("settlement-pending-migrate down · فرایندِ واقعی (npm run settlement:pending -- down --yes)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  async function rig() {
    const schema = `pq_${randomBytes(5).toString("hex")}`;
    const admin = new Pool({ connectionString: DB_URL, max: 2, idleTimeoutMillis: IDLE_MS });
    cleanups.push(async () => {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    });
    const pool = new Pool({ connectionString: DB_URL, max: 2, idleTimeoutMillis: IDLE_MS });
    cleanups.push(() => pool.end());
    const made = createPgSettlementOutbox(drizzle(pool) as unknown as LedgerDatabase, { schema });
    if (!made.ok) throw new Error("createPgSettlementOutbox failed");
    const m = await made.value.migrate();
    if (!m.ok) throw new Error("settlement migrate failed");

    const env = (url: string | null = DB_URL ?? null): NodeJS.ProcessEnv =>
      ({ PATH: process.env["PATH"], HOME: process.env["HOME"], ...(url === null ? {} : { DATABASE_URL: url }), SETTLEMENT_OUTBOX_SCHEMA: schema }) as unknown as NodeJS.ProcessEnv;
    const run = (args: string[], e: NodeJS.ProcessEnv = env()): Run => {
      const r = spawnSync("npm", ["run", "-s", "settlement:pending", "--", ...args], { cwd: ROOT, env: e, encoding: "utf8", timeout: 60_000 });
      const stdout = r.stdout ?? "";
      expect(stdout.endsWith("\n")).toBe(true);
      expect(stdout.trimEnd().split("\n")).toHaveLength(1); // دقیقاً یک خطِ JSON
      return { code: r.status, stdout, stderr: r.stderr ?? "", report: JSON.parse(stdout) as PendingMigrateReport };
    };
    const present = async (): Promise<boolean> => (await admin.query(`SELECT to_regclass($1) IS NOT NULL AS p`, [`"${schema}".settlement_dead_pending`])).rows[0]?.["p"] === true;
    const ledger = async (): Promise<boolean> => (await admin.query(`SELECT to_regclass($1) IS NOT NULL AS p`, [`"${schema}".settlement_pending_migration_ledger`])).rows[0]?.["p"] === true;
    const parked = async (): Promise<boolean> => {
      for (let i = 0; i < 100; i++) {
        if (((await admin.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rowCount ?? 0) > 0) return true;
        await new Promise((res) => setTimeout(res, 100));
      }
      return false;
    };
    const drained = async (): Promise<boolean> => {
      for (let i = 0; i < 100; i++) {
        if (((await admin.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rowCount ?? 0) === 0) return true;
        await new Promise((res) => setTimeout(res, 100));
      }
      return false;
    };
    return { schema, admin, env, run, present, ledger, parked, drained };
  }

  it("جریانِ استقرار: up ← down بی‌--yes ⇒ ۲ (نصب دست‌نخورده) ← down --yes ⇒ ۰ ← status ⇒ ۳ ← verify ⇒ ۳ ← down ⇒ ۰ بی‌کار ← up ⇒ ۰ ← verify ⇒ ۰؛ stderr همیشه خالی", async () => {
    {
      const r = await rig();
      expect(r.run(["up"]).code).toBe(0);
      expect(await r.present()).toBe(true);

      const noYes = r.run(["down"]);
      expect([noYes.code, noYes.stderr, noYes.report.code]).toEqual([2, "", "USAGE"]);
      expect(noYes.report.issues).toContain("دستورِ down مخرب است و تأییدِ صریح می‌خواهد (--yes).");
      expect(await r.present()).toBe(true);

      const down = r.run(["down", "--yes"]);
      expect([down.code, down.stderr]).toEqual([0, ""]);
      expect(down.report).toMatchObject({ command: "down", ok: true, code: "OK", phase: "verify", closed: true, migrations: { applied: [], pending: ["0001_dead_pending"], appliedNow: [], revertedNow: ["0001_dead_pending"] } });
      expect(down.stdout).not.toContain(DB_URL ?? "<none>");
      expect(await r.present()).toBe(false);
      expect(await r.ledger()).toBe(false);

      const status = r.run(["status"]);
      expect([status.code, status.report.code, status.stderr]).toEqual([3, "PENDING", ""]);
      const verify = r.run(["verify"]);
      expect([verify.code, verify.report.code, verify.stderr]).toEqual([3, "PENDING", ""]);

      const again = r.run(["down", "--yes", "--timeout-ms=5000"]);
      expect([again.code, again.report.phase, again.stderr]).toEqual([0, "check", ""]);

      expect(r.run(["up"]).code).toBe(0);
      expect(r.run(["verify"]).code).toBe(0);
    }
  }, 120_000);

  it("بی‌--yes، --yes با دستورِ دیگر و --yes=1 ⇒ ۲ بی‌اتصال؛ پایگاهِ در دسترس‌نبود ⇒ ۴ بی‌نشت", async () => {
    const r = await rig();
    expect(r.run(["up"]).code).toBe(0);
    for (const argv of [["down"], ["up", "--yes"], ["status", "--yes"], ["down", "--yes=1"], ["down", "--yes", "--yes"]]) {
      const o = r.run(argv);
      expect([o.code, o.stderr, o.report.code], JSON.stringify(argv)).toEqual([2, "", "USAGE"]);
    }
    expect(await r.present()).toBe(true);
    const o = r.run(["down", "--yes"], r.env(SECRET_URL));
    expect([o.code, o.report.code, o.stderr]).toEqual([4, "UNAVAILABLE", ""]);
    for (const text of [o.stdout, o.stderr]) {
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain("127.0.0.1");
    }
    expect(await r.present()).toBe(true);
  }, 90_000);

  it("مهلتِ کل: قفلِ مشورتیِ مهاجرتِ نمایه در دستِ دیگری ⇒ ۷ در مهلت و پایانِ سخت؛ پس از آزادیِ قفل هنوز بی‌برگشت (نصب سالم)، سپس down ⇒ ۰", async () => {
    const r = await rig();
    expect(r.run(["up"]).code).toBe(0);
    const holder = new Client({ connectionString: DB_URL });
    await holder.connect();
    cleanups.push(() => holder.end());
    await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`settlement-pending:migrate:${r.schema}`]);
    const t0 = Date.now();
    const blocked = r.run(["down", "--yes", "--timeout-ms=1000"]);
    expect([blocked.code, blocked.report.code, blocked.report.phase, blocked.stderr]).toEqual([7, "TIMEOUT", "apply", ""]);
    expect(Date.now() - t0).toBeLessThan(30_000);
    await holder.query("SELECT pg_advisory_unlock_all()");
    await new Promise((res) => setTimeout(res, 1500)); // بک‌اندِ رهاشده (اگر مانده بود) فرصت دارد؛ نباید چیزی برگرداند.
    expect(await r.present()).toBe(true);
    expect(r.run(["verify"]).code).toBe(0);
    const ok = r.run(["down", "--yes"]);
    expect([ok.code, ok.report.code]).toEqual([0, "OK"]);
    expect(await r.present()).toBe(false);
  }, 90_000);

  it("SIGTERM به down در انتظارِ قفل: فرایند می‌میرد و تراکنشِ آویزان چیزی برنمی‌گرداند (نصب سالم می‌ماند)", async () => {
    const r = await rig();
    expect(r.run(["up"]).code).toBe(0);
    const holder = new Client({ connectionString: DB_URL });
    await holder.connect();
    cleanups.push(() => holder.end());
    await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`settlement-pending:migrate:${r.schema}`]);
    const child = spawn("node", [...NODE_ARGS, "down", "--yes", "--timeout-ms=600000"], { cwd: ROOT, env: r.env(), stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
    expect(await r.parked()).toBe(true);
    child.kill("SIGTERM");
    await exited;
    await holder.query("SELECT pg_advisory_unlock_all()");
    expect(await r.drained()).toBe(true);
    expect(await r.present()).toBe(true);
    expect(r.run(["verify"]).code).toBe(0);
  }, 90_000);
});
