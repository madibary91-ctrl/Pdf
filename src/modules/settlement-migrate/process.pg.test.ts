/**
 * CLIِ رسمی به‌صورت فرایندِ واقعی (ADR-0034): `npm run settlement:migrate` — همان مسیری که استقرار می‌زند — روی PostgreSQL واقعی.
 * چیزی که آزمونِ درون‌فرایندی نمی‌گیرد: حلقهٔ resolve (`@/` و پسوندِ `.ts`)، اجرای بومیِ TypeScript در Node، stdout یک‌خطی، stderr خالی (بی‌هشدار)،
 * کدِ خروجِ واقعیِ فرایند، پایانِ سخت پس از مهلت و رها‌شدنِ اتصال (تراکنشِ نیمه‌کار برمی‌گردد).
 * شِماهای یک‌بارمصرفِ `mp_ledger_*`/`mp_settle_*`؛ بودجهٔ اتصال (ADR-0024): همه بسته می‌شوند.
 */
import { spawnSync, spawn } from "node:child_process";
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

type Run = Readonly<{ code: number | null; stdout: string; stderr: string; report: MigrateReport }>;

dbDescribe("settlement-migrate · فرایندِ واقعی (npm run settlement:migrate)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  function rig() {
    const tag = randomBytes(5).toString("hex");
    const ledgerSchema = `mp_ledger_${tag}`;
    const settlementSchema = `mp_settle_${tag}`;
    const admin = new Pool({ connectionString: DB_URL, max: 2, idleTimeoutMillis: IDLE_MS });
    cleanups.push(async () => {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${ledgerSchema}" CASCADE`);
        await admin.query(`DROP SCHEMA IF EXISTS "${settlementSchema}" CASCADE`);
      } finally {
        await admin.end();
      }
    });
    /** `url: null` یعنی بی‌`DATABASE_URL` (undefined پیش‌فرضِ پارامتر را فعال می‌کرد). */
    const env = (url: string | null = DB_URL ?? null, extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
      ({
        PATH: process.env["PATH"],
        HOME: process.env["HOME"],
        ...(url === null ? {} : { DATABASE_URL: url }),
        SETTLEMENT_LEDGER_SCHEMA: ledgerSchema,
        SETTLEMENT_OUTBOX_SCHEMA: settlementSchema,
        ...extra,
      }) as unknown as NodeJS.ProcessEnv;
    const run = (args: string[], e: NodeJS.ProcessEnv = env()): Run => {
      const r = spawnSync("npm", ["run", "-s", "settlement:migrate", "--", ...args], { cwd: ROOT, env: e, encoding: "utf8", timeout: 60_000 });
      const stdout = r.stdout ?? "";
      expect(stdout.endsWith("\n")).toBe(true);
      expect(stdout.trimEnd().split("\n")).toHaveLength(1); // دقیقاً یک خطِ JSON
      return { code: r.status, stdout, stderr: r.stderr ?? "", report: JSON.parse(stdout) as MigrateReport };
    };
    return { ledgerSchema, settlementSchema, admin, env, run };
  }

  it("اسکریپتِ package.json همان فرمانِ مستند است (حلقهٔ resolve + بی‌هشدار + بی‌وابستگیِ تازه)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string>; dependencies: Record<string, string>; devDependencies: Record<string, string> };
    expect(pkg.scripts["settlement:migrate"]).toBe("node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tooling/cli/register.mjs tooling/cli/settlement-migrate.ts");
    for (const bad of ["tsx", "ts-node", "vite-node", "esbuild-register", "@swc-node/register"]) {
      expect(pkg.dependencies[bad], bad).toBeUndefined();
      expect(pkg.devDependencies[bad], bad).toBeUndefined();
    }
  });

  it("status ← up ← status ← up: کدهای خروجِ واقعی ۳،۰،۰،۰؛ stdout یک‌خطی و stderr خالی", () => {
    const r = rig();
    const s1 = r.run(["status"]);
    expect([s1.code, s1.stderr]).toEqual([3, ""]);
    expect(s1.report).toMatchObject({ code: "PENDING", command: "status", exitCode: 3 });
    const up = r.run(["up"]);
    expect([up.code, up.stderr]).toEqual([0, ""]);
    expect(up.report).toMatchObject({ code: "OK", phase: "verify", closed: true });
    expect(up.report.ledger?.appliedNow).toEqual(s1.report.ledger?.pending);
    const s2 = r.run(["status"]);
    expect([s2.code, s2.stderr]).toEqual([0, ""]);
    const up2 = r.run(["up"]);
    expect([up2.code, up2.stderr]).toEqual([0, ""]);
    expect(up2.report).toMatchObject({ phase: "check", ledger: { appliedNow: [] }, settlement: { appliedNow: [] } });
  });

  it("خطای آرگومان/env ⇒ ۲ بی‌اتصال؛ --help ⇒ ۰", () => {
    const r = rig();
    const noUrl = r.run(["up"], r.env(null));
    expect([noUrl.code, noUrl.stderr]).toEqual([2, ""]);
    expect(noUrl.report.issues).toContain("DATABASE_URL الزامی است.");
    const typo = r.run(["up"], r.env(DB_URL, { SETTLEMENT_OUTBOX_SCHEMAA: "x" }));
    expect(typo.code).toBe(2);
    const badFlag = r.run(["up", "--force"]);
    expect(badFlag.code).toBe(2);
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

  it("دفترِ دست‌کاری‌شده ⇒ ۵ و outbox ساخته نمی‌شود", async () => {
    const r = rig();
    expect(r.run(["up"]).code).toBe(0);
    await r.admin.query(`DROP SCHEMA "${r.settlementSchema}" CASCADE`);
    await r.admin.query(`UPDATE "${r.ledgerSchema}".migration_ledger SET checksum = 'tampered'`);
    const up = r.run(["up"]);
    expect([up.code, up.report.code, up.report.stage]).toEqual([5, "SCHEMA_MISMATCH", "ledger"]);
    expect((await r.admin.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [r.settlementSchema])).rowCount).toBe(0);
  });

  it("مهلتِ کل: قفلِ مشورتیِ مهاجرتِ دیگر ⇒ ۷ در مهلت، پایانِ سخت، بی‌اعمال؛ پس از آزادی‌ِ قفل ۰ و اعمال", async () => {
    const r = rig();
    const holder = new Client({ connectionString: DB_URL });
    await holder.connect();
    cleanups.push(() => holder.end());
    await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`ledger:migrate:${r.ledgerSchema}`]);
    const t0 = Date.now();
    const blocked = r.run(["up", "--timeout-ms=1000"]);
    const took = Date.now() - t0;
    expect([blocked.code, blocked.report.code, blocked.report.phase, blocked.report.stage]).toEqual([7, "TIMEOUT", "apply", "ledger"]);
    expect(blocked.stderr).toBe("");
    expect(took).toBeLessThan(30_000);
    // اتصالِ کشته‌شده ⇒ تراکنشِ منتظرِ قفل برگشته؛ هیچ‌چیز اعمال نشده است.
    expect((await r.admin.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [r.ledgerSchema])).rowCount).toBe(0);
    await holder.query("SELECT pg_advisory_unlock_all()");
    const ok = r.run(["up"]);
    expect([ok.code, ok.report.code]).toEqual([0, "OK"]);
    expect(ok.report.ledger?.appliedNow.length).toBeGreaterThan(0);
  }, 90_000);

  it("SIGTERM به CLIِ در انتظارِ قفل: فرایند می‌میرد و تراکنشِ آویزان نمی‌ماند (بی‌اعمال)", async () => {
    const r = rig();
    const holder = new Client({ connectionString: DB_URL });
    await holder.connect();
    cleanups.push(() => holder.end());
    await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`ledger:migrate:${r.ledgerSchema}`]);
    const child = spawn("node", ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--import", "./tooling/cli/register.mjs", "tooling/cli/settlement-migrate.ts", "up", "--timeout-ms=600000"], { cwd: ROOT, env: r.env(), stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
    // منتظر می‌مانیم تا واقعاً پشتِ قفل برود (یک جلسهٔ منتظرِ قفل در pg_locks).
    let parked = false;
    for (let i = 0; i < 100 && !parked; i++) {
      parked = ((await r.admin.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rowCount ?? 0) > 0;
      if (!parked) await new Promise((res) => setTimeout(res, 100));
    }
    expect(parked).toBe(true);
    child.kill("SIGTERM");
    await exited;
    // PostgreSQL کلاینتِ مرده را تا بیدار‌شدنِ بک‌اندِ منتظرِ قفل نمی‌فهمد (client_connection_check_interval پیش‌فرض خاموش): بک‌اندِ «زامبی» تا آزادیِ قفل می‌ماند،
    // ولی هرگز دستورِ بعدی نمی‌گیرد؛ پس با آزادیِ قفل می‌میرد و هیچ مهاجرتی اعمال نمی‌شود. (lock_timeout سمتِ سرور آن را کران‌دار می‌کند: tooling/cli/settlement-migrate.ts)
    await holder.query("SELECT pg_advisory_unlock_all()");
    let waiting = true;
    for (let i = 0; i < 100 && waiting; i++) {
      waiting = ((await r.admin.query("SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted")).rowCount ?? 0) > 0;
      if (waiting) await new Promise((res) => setTimeout(res, 100));
    }
    expect(waiting).toBe(false);
    expect((await r.admin.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [r.ledgerSchema])).rowCount).toBe(0);
  }, 90_000);
});
