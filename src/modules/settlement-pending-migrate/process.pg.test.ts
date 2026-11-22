/**
 * CLIِ نمایه به‌صورتِ فرایندِ واقعی (ADR-0047): `npm run settlement:pending` — همان مسیری که استقرار می‌زند — روی PostgreSQL واقعی.
 * چیزی که آزمونِ درون‌فرایندی نمی‌گیرد: حلقهٔ resolve (`@/` و `.ts`)، اجرای بومیِ TypeScript در Node، stdout یک‌خطی، stderr خالی (بی‌هشدار)، کدِ خروجِ واقعیِ فرایند،
 * پایانِ سخت پس از مهلت/SIGTERM و اینکه با مرگِ فرایند **هیچ مهاجرتی اعمال نمی‌شود** (هر دستورِ مهاجرت یک رفت‌وبرگشتِ جدا از کلاینت است).
 * شِمای یک‌بارمصرفِ `pp_<تصادفی>`؛ بودجهٔ اتصال (ADR-0024): همه بسته می‌شوند.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
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

dbDescribe("settlement-pending-migrate · فرایندِ واقعی (npm run settlement:pending)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  async function rig(migrateSettlement = true) {
    const schema = `pp_${randomBytes(5).toString("hex")}`;
    const admin = new Pool({ connectionString: DB_URL, max: 2, idleTimeoutMillis: IDLE_MS });
    cleanups.push(async () => {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    });
    let bury = async (_id: string): Promise<void> => {
      throw new Error("settlement migrate نشده است");
    };
    if (migrateSettlement) {
      const pool = new Pool({ connectionString: DB_URL, max: 2, idleTimeoutMillis: IDLE_MS });
      cleanups.push(() => pool.end());
      const made = createPgSettlementOutbox(drizzle(pool) as unknown as LedgerDatabase, { schema });
      if (!made.ok) throw new Error("createPgSettlementOutbox failed");
      const m = await made.value.migrate();
      if (!m.ok) throw new Error("settlement migrate failed");
      const outbox = made.value;
      bury = async (id: string): Promise<void> => {
        const ref = { tenantId: "t1", accountId: "a1", reservationId: id };
        const b = await outbox.begin({ ...ref, unit: "IRR_MICROS", reserved: 500, createdAtMs: 1_000, expiresAtMs: 61_000, dueAtMs: 11_000, orphanRemainder: "forfeit" as const });
        const d = await outbox.bury(ref, { reason: "LEDGER_REJECTED", errorCode: null, atMs: 20_000 });
        if (!b.ok || !d.ok) throw new Error("seed failed");
      };
    }
    /** `url: null` یعنی بی‌`DATABASE_URL`. */
    const env = (url: string | null = DB_URL ?? null, extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
      ({ PATH: process.env["PATH"], HOME: process.env["HOME"], ...(url === null ? {} : { DATABASE_URL: url }), SETTLEMENT_OUTBOX_SCHEMA: schema, ...extra }) as unknown as NodeJS.ProcessEnv;
    const run = (args: string[], e: NodeJS.ProcessEnv = env()): Run => {
      const r = spawnSync("npm", ["run", "-s", "settlement:pending", "--", ...args], { cwd: ROOT, env: e, encoding: "utf8", timeout: 60_000 });
      const stdout = r.stdout ?? "";
      expect(stdout.endsWith("\n")).toBe(true);
      expect(stdout.trimEnd().split("\n")).toHaveLength(1); // دقیقاً یک خطِ JSON
      return { code: r.status, stdout, stderr: r.stderr ?? "", report: JSON.parse(stdout) as PendingMigrateReport };
    };
    const present = async (): Promise<boolean> => (await admin.query(`SELECT to_regclass($1) IS NOT NULL AS p`, [`"${schema}".settlement_dead_pending`])).rows[0]?.["p"] === true;
    return { schema, admin, env, run, present, bury };
  }

  it("اسکریپتِ package.json همان فرمانِ مستند است (حلقهٔ resolve + بی‌هشدار + بی‌وابستگیِ تازه)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.scripts["settlement:pending"]).toBe(`node ${NODE_ARGS.join(" ")}`);
    for (const bad of ["tsx", "ts-node", "vite-node", "esbuild-register", "@swc-node/register"]) {
      expect(pkg.dependencies[bad], bad).toBeUndefined();
      expect(pkg.devDependencies[bad], bad).toBeUndefined();
    }
  });

  it("status ← up ← status ← up ← verify: کدهای خروجِ واقعی ۳،۰،۰،۰،۰؛ stdout یک‌خطی و stderr خالی", async () => {
    const r = await rig();
    const s1 = r.run(["status"]);
    expect([s1.code, s1.stderr]).toEqual([3, ""]);
    expect(s1.report).toMatchObject({ tool: "settlement-pending-migrate", code: "PENDING", command: "status", exitCode: 3 });
    expect(await r.present()).toBe(false);
    const up = r.run(["up"]);
    expect([up.code, up.stderr]).toEqual([0, ""]);
    expect(up.report).toMatchObject({ code: "OK", phase: "verify", closed: true, verify: { consistent: true } });
    expect(up.report.migrations?.appliedNow).toEqual(s1.report.migrations?.pending);
    expect(await r.present()).toBe(true);
    expect(r.run(["status"]).code).toBe(0);
    const up2 = r.run(["up"]);
    expect([up2.code, up2.stderr]).toEqual([0, ""]);
    expect(up2.report).toMatchObject({ phase: "check", migrations: { appliedNow: [] } });
    const v = r.run(["verify"]);
    expect([v.code, v.stderr]).toEqual([0, ""]);
  });

  it("پیش‌نیاز: بی‌مهاجرتِ settlement ⇒ up ⇒ ۸ و چیزی ساخته نمی‌شود", async () => {
    const r = await rig(false);
    const up = r.run(["up"]);
    expect([up.code, up.report.code, up.stderr]).toEqual([8, "PREREQUISITE", ""]);
    expect(await r.present()).toBe(false);
  });

  it("خطای آرگومان/env ⇒ ۲ بی‌اتصال؛ --help ⇒ ۰؛ غلط‌یابِ نام؛ متغیرهای پایش با همان envِ برنامه پذیرفته", async () => {
    const r = await rig();
    const noUrl = r.run(["up"], r.env(null));
    expect([noUrl.code, noUrl.stderr]).toEqual([2, ""]);
    expect(noUrl.report.issues).toContain("DATABASE_URL الزامی است.");
    expect(r.run(["up"], r.env(DB_URL, { SETTLEMENT_OUTBOX_SCHEMAA: "x" })).code).toBe(2);
    expect(r.run(["up", "--force"]).code).toBe(2);
    expect(r.run(["down"]).code).toBe(2);
    const help = r.run(["--help"], { PATH: process.env["PATH"] } as unknown as NodeJS.ProcessEnv);
    expect([help.code, help.stderr, help.report.command]).toEqual([0, "", "help"]);
    const withWatch = r.run(["status"], r.env(DB_URL, { SETTLEMENT_HOST: "on", SETTLEMENT_BACKLOG_WATCH: "on" }));
    expect(withWatch.code).toBe(3); // پذیرفته شد (نه ۲)
  });

  it("پایگاهِ در دسترس‌نبود ⇒ ۴؛ نه رشتهٔ اتصال، نه رمز، نه میزبان در stdout/stderr", async () => {
    const r = await rig();
    for (const cmd of ["status", "up", "verify"]) {
      const o = r.run([cmd], r.env(SECRET_URL));
      expect(o.code, cmd).toBe(4);
      expect(o.report.code).toBe("UNAVAILABLE");
      for (const text of [o.stdout, o.stderr]) {
        expect(text).not.toContain(CANARY);
        expect(text).not.toContain("127.0.0.1");
      }
      expect(o.stderr).toBe("");
    }
  });

  it("verify ناهمخوان ⇒ ۹ (کدِ خروجِ واقعیِ فرایند)", async () => {
    const r = await rig();
    expect(r.run(["up"]).code).toBe(0);
    await r.admin.query(`ALTER TABLE "${r.schema}".settlement_outbox DISABLE TRIGGER settlement_pending_dead_ins`);
    await r.admin.query(`ALTER TABLE "${r.schema}".settlement_outbox DISABLE TRIGGER settlement_pending_dead_upd`);
    await r.bury("silent");
    const v = r.run(["verify"]);
    expect([v.code, v.stderr]).toEqual([9, ""]);
    expect(v.report).toMatchObject({ code: "INCONSISTENT", phase: "verify", verify: { consistent: false, expected: 1, indexed: 0, missing: 1, stale: 0 } });
  });

  it("دفترِ دست‌کاری‌شده ⇒ ۵ و up چیزی نمی‌نویسد", async () => {
    const r = await rig();
    expect(r.run(["up"]).code).toBe(0);
    await r.admin.query(`UPDATE "${r.schema}".settlement_pending_migration_ledger SET checksum = 'tampered'`);
    const o = r.run(["up"]);
    expect([o.code, o.report.code]).toEqual([5, "SCHEMA_MISMATCH"]);
  });

  it("مهلتِ کل: قفلِ مشورتیِ مهاجرتِ settlement ⇒ ۷ در مهلت، پایانِ سخت، بی‌اعمال؛ پس از آزادیِ قفل هنوز بی‌اعمال، سپس up ⇒ ۰", async () => {
    const r = await rig();
    const holder = new Client({ connectionString: DB_URL });
    await holder.connect();
    cleanups.push(() => holder.end());
    await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`settlement:migrate:${r.schema}`]);
    const t0 = Date.now();
    const blocked = r.run(["up", "--timeout-ms=1000"]);
    const took = Date.now() - t0;
    expect([blocked.code, blocked.report.code, blocked.report.phase]).toEqual([7, "TIMEOUT", "apply"]);
    expect(blocked.stderr).toBe("");
    expect(took).toBeLessThan(30_000);
    await holder.query("SELECT pg_advisory_unlock_all()");
    await new Promise((res) => setTimeout(res, 1500)); // بک‌اندِ رهاشده (اگر مانده بود) فرصت دارد؛ نباید چیزی اعمال کند.
    expect(await r.present()).toBe(false);
    const ok = r.run(["up"]);
    expect([ok.code, ok.report.code]).toEqual([0, "OK"]);
  }, 90_000);

  it("SIGTERM به CLIِ در انتظارِ قفل: فرایند می‌میرد و تراکنشِ آویزان چیزی اعمال نمی‌کند", async () => {
    const r = await rig();
    const holder = new Client({ connectionString: DB_URL });
    await holder.connect();
    cleanups.push(() => holder.end());
    await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`settlement:migrate:${r.schema}`]);
    const child = spawn("node", [...NODE_ARGS, "up", "--timeout-ms=600000"], { cwd: ROOT, env: r.env(), stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
    let parked = false;
    for (let i = 0; i < 100 && !parked; i++) {
      parked = ((await r.admin.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1 AND ((classid::bigint << 32) | objid::bigint) = ANY (SELECT hashtextextended(k, 0) FROM unnest($1::text[]) AS k)", [[`settlement:migrate:${r.schema}`, `settlement-pending:migrate:${r.schema}`]])).rowCount ?? 0) > 0;
      if (!parked) await new Promise((res) => setTimeout(res, 100));
    }
    expect(parked).toBe(true);
    child.kill("SIGTERM");
    await exited;
    await holder.query("SELECT pg_advisory_unlock_all()");
    let waiting = true;
    for (let i = 0; i < 100 && waiting; i++) {
      waiting = ((await r.admin.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1 AND ((classid::bigint << 32) | objid::bigint) = ANY (SELECT hashtextextended(k, 0) FROM unnest($1::text[]) AS k)", [[`settlement:migrate:${r.schema}`, `settlement-pending:migrate:${r.schema}`]])).rowCount ?? 0) > 0;
      if (waiting) await new Promise((res) => setTimeout(res, 100));
    }
    expect(waiting).toBe(false);
    expect(await r.present()).toBe(false);
  }, 90_000);
});
