/**
 * نگهبانِ `error`ِ استخرِ مشترکِ `@/db` روی PostgreSQL واقعی (ADR-0084؛ بستنِ یافتهٔ ۰۰۸۲ بند ۴-۱).
 * ثابت می‌شود:
 *  - **اثبات در سطحِ فرایند (کنترلِ منفی + مثبت):** فرایندِ فرزندِ بدونِ شنونده با `pg_terminate_backend` روی اتصالِ بی‌کار **می‌میرد**
 *    (کدِ خروجِ غیرصفر و `57P01`)، و فرایندِ فرزندِ با `@/db` زنده می‌ماند، `RECOVERED` می‌دهد و رویدادِ بسته را لاگ می‌کند.
 *  - اتصالِ بی‌کارِ کشته‌شده ⇒ یک رویدادِ `db.pool.error` با کدِ `57P01`؛ پرسشِ بعدی روی همان استخر موفق (اتصالِ تازه).
 *  - اتصالِ **اجاره‌شده وسطِ تراکنش** (بینِ دو دستور) کشته شود ⇒ فرایند نمی‌افتد (`db.pool.error`)؛ دستورِ بعدیِ اجاره‌دار **شکست می‌خورد**
 *    (خطا بلعیده نمی‌شود)؛ `release(err)` کلاینت را دور می‌اندازد و استخر دوباره سالم است.
 *  - لاگ‌ها رمزِ رشتهٔ اتصال را ندارند.
 * فرایندِ آزمون به‌خاطرِ `Unhandled Errors` خودِ Vitest هم شاهدِ حذفِ نگهبان است (جهشِ دستی در ADR).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { config } from "dotenv";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { installPoolErrorGuard, type DbPoolEvent } from "../src/db/pool-error-guard";

config({ quiet: true });
const DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const dbDescribe = typeof DB_URL === "string" && DB_URL !== "" ? describe : describe.skip;
const ROOT = path.resolve(__dirname, "..");
const hex = (): string => randomBytes(5).toString("hex");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, label: string, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(10);
  }
}

type Child = Readonly<{ stdout: () => string; stderr: () => string; ready: Promise<void>; exited: Promise<number | null> }>;
function runChild(mode: "guarded" | "bare", appName: string): Child {
  const child = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", "--import", "./tooling/cli/register.mjs", "tooling/db-pool-error-guard.child.ts"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: DB_URL, CHILD_MODE: mode, PGAPPNAME: appName },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d: Buffer) => void (out += d.toString("utf8")));
  child.stderr.on("data", (d: Buffer) => void (err += d.toString("utf8")));
  const ready = (async () => {
    const end = Date.now() + 30_000;
    while (!out.includes("READY")) {
      if (Date.now() > end || child.exitCode !== null) throw new Error(`child not ready: ${err}`);
      await sleep(20);
    }
  })();
  const exited = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  return { stdout: () => out, stderr: () => err, ready, exited };
}

dbDescribe("@/db · نگهبانِ error روی PostgreSQL واقعی", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  async function rig() {
    const app = `pg_guard_${hex()}`;
    const admin = new Pool({ connectionString: DB_URL, max: 2, application_name: `admin_${app}` });
    const events: DbPoolEvent[] = [];
    const pool = new Pool({ connectionString: DB_URL, max: 3, application_name: app });
    installPoolErrorGuard(pool, (e) => events.push(e));
    cleanups.push(async () => {
      await pool.end().catch(() => undefined);
      await admin.end();
    });
    const kill = async (): Promise<number> =>
      (await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()", [app])).rowCount ?? 0;
    return { app, admin, pool, events, kill };
  }

  it("اتصالِ بی‌کارِ کشته‌شده: یک رویدادِ db.pool.error با ۵۷P۰۱؛ پرسشِ بعدی موفق (اتصالِ تازه)", async () => {
    const r = await rig();
    await r.pool.query("SELECT 1");
    expect(r.pool.idleCount).toBe(1);
    expect(await r.kill()).toBe(1);
    await until(() => r.events.length > 0, "event");
    await sleep(100);
    expect(r.events).toEqual([{ type: "db.pool.error", code: "57P01" }]);
    expect((await r.pool.query("SELECT 7 AS n")).rows[0]).toEqual({ n: 7 });
    expect(r.pool.totalCount).toBe(1);
  });

  it("اتصالِ اجاره‌شده وسطِ تراکنش کشته شود: فرایند نمی‌افتد، دستورِ بعدی شکست می‌خورد، release(err) استخر را سالم می‌گذارد", async () => {
    const r = await rig();
    const client = await r.pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT 1");
    expect(await r.kill()).toBe(1);
    await until(() => r.events.length > 0, "client event");
    expect(r.events[0]).toEqual({ type: "db.pool.error", code: "57P01" });
    let failure: unknown = null;
    try {
      await client.query("SELECT 2");
    } catch (e) {
      failure = e;
    }
    expect(failure, "اجاره‌دار باید شکست را ببیند").toBeInstanceOf(Error);
    client.release(failure as Error);
    await sleep(50);
    // `pg` پس از خطای سرور («۵۷P۰۱») یک خطای دومِ بی‌کد هم روی همان کلاینت می‌فرستد («Connection terminated unexpectedly») ⇒ دو رویداد، دومی UNKNOWN.
    expect(r.events.length).toBeLessThanOrEqual(2);
    expect(r.events.slice(1)).toEqual(r.events.slice(1).map(() => ({ type: "db.pool.error", code: "UNKNOWN" })));
    expect((await r.pool.query("SELECT 3 AS n")).rows[0]).toEqual({ n: 3 });
    expect(r.pool.totalCount).toBe(1);
  });

  it("چند اتصالِ بی‌کار هم‌زمان کشته شوند: هر خطا دقیقاً یک‌بار و فقط کد", async () => {
    const r = await rig();
    const [a, b, c] = await Promise.all([r.pool.connect(), r.pool.connect(), r.pool.connect()]);
    a.release();
    b.release();
    c.release();
    expect(r.pool.idleCount).toBe(3);
    expect(await r.kill()).toBe(3);
    await until(() => r.events.length >= 3, "three events");
    await sleep(100);
    expect(r.events).toEqual([1, 2, 3].map(() => ({ type: "db.pool.error", code: "57P01" })));
    expect((await r.pool.query("SELECT 1 AS n")).rows[0]).toEqual({ n: 1 });
  });

  it("رمزِ رشتهٔ اتصال هرگز در رویدادها نیست", async () => {
    const r = await rig();
    await r.pool.query("SELECT 1");
    await r.kill();
    await until(() => r.events.length > 0, "event");
    const pw = new URL(DB_URL as string).password;
    if (pw.length >= 4) expect(JSON.stringify(r.events)).not.toContain(pw);
    expect(Object.keys(r.events[0] as object).sort()).toEqual(["code", "type"]);
  });

  describe("فرایندِ واقعی (کنترلِ منفی و مثبت)", () => {
    it("کنترلِ منفی: استخرِ بدونِ شنونده با قطعِ اتصالِ بی‌کار فرایند را می‌اندازد (۵۷P۰۱)", async () => {
      const r = await rig();
      const app = `child_bare_${hex()}`;
      const child = runChild("bare", app);
      await child.ready;
      const killed = (await r.admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1", [app])).rowCount ?? 0;
      expect(killed).toBeGreaterThanOrEqual(1);
      const code = await child.exited;
      expect(code).not.toBe(0);
      expect(child.stdout()).not.toContain("RECOVERED");
      expect(child.stderr()).toContain("57P01");
    }, 60_000);

    it("مثبت: با @/db فرایند زنده می‌ماند، RECOVERED می‌دهد و فقط رویدادِ بستهٔ db.pool.error را لاگ می‌کند", async () => {
      const r = await rig();
      const app = `child_guarded_${hex()}`;
      const child = runChild("guarded", app);
      await child.ready;
      const killed = (await r.admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1", [app])).rowCount ?? 0;
      expect(killed).toBeGreaterThanOrEqual(1);
      const code = await child.exited;
      expect(child.stderr()).toContain('{"scope":"db","type":"db.pool.error","code":"57P01"}');
      expect(code).toBe(0);
      expect(child.stdout()).toContain("RECOVERED");
      const pw = new URL(DB_URL as string).password;
      if (pw.length >= 4) expect(child.stderr() + child.stdout()).not.toContain(pw);
    }, 60_000);
  });
});
