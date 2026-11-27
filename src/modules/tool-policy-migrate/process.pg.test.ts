/**
 * CLIِ رسمی به‌صورت فرایندِ واقعی (ADR-0080): `npm run policy:migrate` — همان مسیری که استقرار می‌زند — روی PostgreSQL واقعی.
 * چیزی که آزمونِ درون‌فرایندی نمی‌گیرد: حلقهٔ resolve (`@/` و پسوندِ `.ts`)، اجرای بومیِ TypeScript در Node، stdout یک‌خطی، stderr خالی (بی‌هشدار)،
 * کدِ خروجِ واقعیِ فرایند، پایانِ سخت پس از مهلت و رها‌شدنِ اتصال (تراکنشِ نیمه‌کار برمی‌گردد).
 * شِماهای یک‌بارمصرفِ `tpp_<تصادفی>`؛ بودجهٔ اتصال (ADR-0024): همه بسته می‌شوند.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import { Client, Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { CANARY, SECRET_URL } from "./test-kit";
import type { MigrateReport } from "./types";

config({ quiet: true });
const DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const dbDescribe = typeof DB_URL === "string" && DB_URL !== "" ? describe : describe.skip;
const ROOT = join(__dirname, "..", "..", "..");
const IDLE_MS = 50;
/** انتظارِ قفلِ مشورتی فقط روی کلیدهای همین آزمون (ADR-0052؛ pg_locks سراسریِ پایگاه است). */
const WAITERS_SQL = "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1 AND ((classid::bigint << 32) | objid::bigint) = ANY (SELECT hashtextextended(k, 0) FROM unnest($1::text[]) AS k)";

type Run = Readonly<{ code: number | null; stdout: string; stderr: string; report: MigrateReport }>;

dbDescribe("tool-policy-migrate · فرایندِ واقعی (npm run policy:migrate)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  function rig() {
    const schema = `tpp_${randomBytes(5).toString("hex")}`;
    const admin = new Pool({ connectionString: DB_URL, max: 2, idleTimeoutMillis: IDLE_MS });
    cleanups.push(async () => {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    });
    /** `url: null` یعنی بی‌`DATABASE_URL`. */
    const env = (url: string | null = DB_URL ?? null, extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
      ({ PATH: process.env["PATH"], HOME: process.env["HOME"], ...(url === null ? {} : { DATABASE_URL: url }), TOOL_POLICY_SCHEMA: schema, ...extra }) as unknown as NodeJS.ProcessEnv;
    const run = (args: string[], e: NodeJS.ProcessEnv = env()): Run => {
      const r = spawnSync("npm", ["run", "-s", "policy:migrate", "--", ...args], { cwd: ROOT, env: e, encoding: "utf8", timeout: 60_000 });
      const stdout = r.stdout ?? "";
      expect(stdout.endsWith("\n")).toBe(true);
      expect(stdout.trimEnd().split("\n")).toHaveLength(1); // دقیقاً یک خطِ JSON
      return { code: r.status, stdout, stderr: r.stderr ?? "", report: JSON.parse(stdout) as MigrateReport };
    };
    const schemaExists = async (): Promise<boolean> => (await admin.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema])).rowCount === 1;
    const lockKey = `tool-policy-store:migrate:${schema}`;
    const waiters = async (): Promise<number> => (await admin.query(WAITERS_SQL, [[lockKey]])).rowCount ?? 0;
    return { schema, admin, env, run, schemaExists, lockKey, waiters };
  }

  it("اسکریپتِ package.json همان فرمانِ مستند است (حلقهٔ resolve + بی‌هشدار + بی‌وابستگیِ تازه)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.scripts["policy:migrate"]).toBe("node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tooling/cli/register.mjs tooling/cli/tool-policy-migrate.ts");
    for (const bad of ["tsx", "ts-node", "vite-node", "esbuild-register", "@swc-node/register"]) {
      expect(pkg.dependencies[bad], bad).toBeUndefined();
      expect(pkg.devDependencies[bad], bad).toBeUndefined();
    }
  });

  it("status ← up بی‌فلگ ← up --create-schema ← status ← up: کدهای خروجِ واقعی ۳،۸،۰،۰،۰؛ stdout یک‌خطی و stderr خالی", async () => {
    const r = rig();
    const s1 = r.run(["status"]);
    expect([s1.code, s1.stderr]).toEqual([3, ""]);
    expect(s1.report).toMatchObject({ tool: "tool-policy-migrate", code: "PENDING", command: "status", exitCode: 3 });
    const noFlag = r.run(["up"]);
    expect([noFlag.code, noFlag.stderr, noFlag.report.code]).toEqual([8, "", "SCHEMA_MISSING"]);
    expect(await r.schemaExists()).toBe(false);
    const up = r.run(["up", "--create-schema"]);
    expect([up.code, up.stderr]).toEqual([0, ""]);
    expect(up.report).toMatchObject({ code: "OK", phase: "verify", schemaCreated: true, closed: true });
    expect(up.report.state?.appliedNow).toEqual(s1.report.state?.pending);
    const s2 = r.run(["status"]);
    expect([s2.code, s2.stderr]).toEqual([0, ""]);
    const up2 = r.run(["up", "--create-schema"]);
    expect([up2.code, up2.stderr]).toEqual([0, ""]);
    expect(up2.report).toMatchObject({ phase: "check", state: { appliedNow: [] } });
  });

  it("خطای آرگومان/env ⇒ ۲ بی‌اتصال؛ --help ⇒ ۰", () => {
    const r = rig();
    const noUrl = r.run(["up"], r.env(null));
    expect([noUrl.code, noUrl.stderr]).toEqual([2, ""]);
    expect(noUrl.report.issues).toContain("DATABASE_URL الزامی است.");
    expect(r.run(["up"], r.env(DB_URL, { TOOL_POLICY_SCHEMAA: "x" })).code).toBe(2);
    expect(r.run(["up", "--force"]).code).toBe(2);
    expect(r.run(["status", "--create-schema"]).code).toBe(2);
    const help = r.run(["--help"], { PATH: process.env["PATH"] } as unknown as NodeJS.ProcessEnv);
    expect([help.code, help.stderr, help.report.command]).toEqual([0, "", "help"]);
  });

  it("پایگاهِ در دسترس‌نبود ⇒ ۴؛ نه رشتهٔ اتصال، نه رمز، نه میزبان در stdout/stderr", () => {
    const r = rig();
    for (const cmd of ["status", "up"]) {
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

  it("دفترِ دست‌کاری‌شده ⇒ ۵ و چیزی تغییر نمی‌کند", async () => {
    const r = rig();
    expect(r.run(["up", "--create-schema"]).code).toBe(0);
    await r.admin.query(`UPDATE "${r.schema}".tool_policy_migration_ledger SET checksum = 'tampered'`);
    const up = r.run(["up"]);
    expect([up.code, up.report.code]).toEqual([5, "SCHEMA_MISMATCH"]);
    expect((await r.admin.query(`SELECT checksum FROM "${r.schema}".tool_policy_migration_ledger`)).rows[0].checksum).toBe("tampered");
  });

  it("مهلتِ کل: قفلِ مشورتیِ مهاجرتِ دیگر ⇒ ۷ در مهلت، پایانِ سخت، بی‌اعمال؛ پس از آزادیِ قفل ۰ و اعمال", async () => {
    const r = rig();
    await r.admin.query(`CREATE SCHEMA "${r.schema}"`);
    const holder = new Client({ connectionString: DB_URL });
    await holder.connect();
    cleanups.push(() => holder.end());
    await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [r.lockKey]);
    const t0 = Date.now();
    const blocked = r.run(["up", "--timeout-ms=1000"]);
    const took = Date.now() - t0;
    expect([blocked.code, blocked.report.code, blocked.report.phase]).toEqual([7, "TIMEOUT", "apply"]);
    expect(blocked.stderr).toBe("");
    expect(took).toBeLessThan(30_000);
    // اتصالِ کشته‌شده ⇒ تراکنشِ منتظرِ قفل برگشته؛ هیچ جدولی ساخته نشده است.
    expect((await r.admin.query("SELECT to_regclass($1) AS t", [`"${r.schema}".tool_policy_migration_ledger`])).rows[0].t).toBeNull();
    await holder.query("SELECT pg_advisory_unlock_all()");
    const ok = r.run(["up"]);
    expect([ok.code, ok.report.code]).toEqual([0, "OK"]);
    expect(ok.report.state?.appliedNow.length).toBeGreaterThan(0);
  }, 90_000);

  it("SIGTERM به CLIِ در انتظارِ قفل: فرایند می‌میرد و تراکنشِ آویزان نمی‌ماند (بی‌اعمال)", async () => {
    const r = rig();
    await r.admin.query(`CREATE SCHEMA "${r.schema}"`);
    const holder = new Client({ connectionString: DB_URL });
    await holder.connect();
    cleanups.push(() => holder.end());
    await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [r.lockKey]);
    const child = spawn("node", ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--import", "./tooling/cli/register.mjs", "tooling/cli/tool-policy-migrate.ts", "up", "--timeout-ms=600000"], { cwd: ROOT, env: r.env(), stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
    let parked = false;
    for (let i = 0; i < 100 && !parked; i++) {
      parked = (await r.waiters()) > 0;
      if (!parked) await new Promise((res) => setTimeout(res, 100));
    }
    expect(parked).toBe(true);
    child.kill("SIGTERM");
    await exited;
    // بک‌اندِ «زامبی» تا آزادیِ قفل می‌ماند ولی دستورِ بعدی نمی‌گیرد؛ lock_timeout سمتِ سرور آن را کران‌دار می‌کند (tooling/cli/tool-policy-migrate.ts).
    await holder.query("SELECT pg_advisory_unlock_all()");
    let waiting = true;
    for (let i = 0; i < 100 && waiting; i++) {
      waiting = (await r.waiters()) > 0;
      if (waiting) await new Promise((res) => setTimeout(res, 100));
    }
    expect(waiting).toBe(false);
    expect((await r.admin.query("SELECT to_regclass($1) AS t", [`"${r.schema}".tool_policy_migration_ledger`])).rows[0].t).toBeNull();
  }, 90_000);
});
