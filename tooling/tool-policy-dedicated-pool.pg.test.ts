/**
 * استخرِ اختصاصیِ میزبانِ سیاستِ ابزار روی PostgreSQL واقعی با **نقشِ LOGIN بی‌امتیازِ واقعی** (ADR-0083؛ بستنِ شکافِ ADR-0082).
 * فرقِ این آزمون با `tool-policy-bootstrap-role.pg.test.ts`: آن‌جا استخر را آزمون با `-c role=…` می‌ساخت؛ این‌جا استخر را همان
 * `selectPolicyDatabaseOpener` (کدِ تولیدی) از `POLICY_DATABASE_URL` می‌سازد و کاربرِ اتصال خودِ نقش است، نه ابَرکاربریِ رهاشده.
 * ثابت می‌شود:
 *  - اتصال‌های میزبان در `pg_stat_activity` با `usename` = نقش و `application_name` ثابت، حداکثر ۲ تا؛ هیچ اتصالِ ابَرکاربری با آن نام نیست؛
 *    استخرِ مشترک هرگز باز نمی‌شود؛ همین استخر نمی‌تواند بنویسد (۴۲۵۰۱) ⇒ `ready` ۲۰۰.
 *  - خاموشیِ تمیز همهٔ اتصال‌ها را می‌بندد (نشتی نیست).
 *  - **شکست‌بسته:** رمزِ غلط ⇒ `UNAVAILABLE` بازتلاش‌شده؛ هیچ اتصالِ ابَرکاربری ساخته نمی‌شود و استخرِ مشترک صدا زده نمی‌شود. رشتهٔ نامعتبر ⇒ `DATABASE_UNAVAILABLE`.
 *  - قطعِ اتصالِ بی‌کارِ پایگاه (`pg_terminate_backend`) فرایند را نمی‌اندازد (`pool.on("error")`)، فقط کدِ `57P01` لاگ می‌شود و میزبان `ready` می‌ماند/برمی‌گردد.
 *  - هیچ‌یک از لاگ‌ها رمزِ نقش را ندارند.
 * نقش‌ساختن فقط وقتی ادعا می‌شود که کاربرِ آزمون `CREATE ROLE` دارد (CI: postgres)؛ وگرنه صریحاً بی‌ادعا برمی‌گردد (نه `skip`).
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { POLICY_APPLICATION_NAME, POLICY_POOL_MAX, nodePostgresDriver, selectPolicyDatabaseOpener, type PolicyPoolDriver, type PolicyPoolEvent, type PolicyPoolLike } from "../src/instrumentation-policy-db";
import { probeHttpResponse, startToolPolicyBootstrap } from "@/modules/tool-policy-bootstrap";
import { getToolPolicyHost } from "@/modules/tool-policy-host";
import { runToolPolicyGrants } from "@/modules/tool-policy-grants";
import { createPgPolicyVersionStore } from "@/modules/tool-policy-store-pg";
import { grantsQuery, grantsTransact, openGrantsDatabase } from "./cli/grants-pg";

config({ quiet: true });
const DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const dbDescribe = typeof DB_URL === "string" && DB_URL !== "" ? describe : describe.skip;
const IDLE_MS = 50;
const realTimer = { after: (fn: () => void, ms: number): unknown => setTimeout(fn, ms), cancel: (h: unknown): void => clearTimeout(h as NodeJS.Timeout) };
const hex = (): string => randomBytes(5).toString("hex");
const BOOT_ATTEMPTS = 3;
const TUNING_ENV = {
  TOOL_POLICY_HOST: "on",
  TOOL_POLICY_INTERVAL_MS: "10000",
  TOOL_POLICY_RETRY_MS: "2000",
  TOOL_POLICY_ATTEMPT_DEADLINE_MS: "6000",
  TOOL_POLICY_REFRESH_TIMEOUT_MS: "5000",
  TOOL_POLICY_MAX_STALE_MS: "30000",
  TOOL_POLICY_BOOT_ATTEMPTS: String(BOOT_ATTEMPTS),
  TOOL_POLICY_BOOT_RETRY_DELAY_MS: "10",
};
const POLICY = { timing: { graceMs: 90_000 }, model: { timeoutMs: 30_000 } };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, label: string, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(10);
  }
}
const sqlstate = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? "NOCODE";
  }
};

dbDescribe("tool-policy · استخرِ اختصاصی با نقشِ LOGINِ واقعی (PostgreSQL)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  async function rig() {
    const schema = `tpd_${hex()}`;
    const admin = new Pool({ connectionString: DB_URL, max: 3, idleTimeoutMillis: IDLE_MS });
    const roles: string[] = [];
    const me = (await admin.query("SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user")).rows[0] as { rolsuper: boolean; rolcreaterole: boolean };
    const canRole = me.rolsuper || me.rolcreaterole;
    cleanups.push(async () => {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        for (const r of roles) await admin.query(`DROP ROLE IF EXISTS "${r}"`);
      } finally {
        await admin.end();
      }
    });
    const q = (text: string, params: unknown[] = []) => admin.query(text.split("{s}").join(`"${schema}"`), params);
    const adminStore = (() => {
      const made = createPgPolicyVersionStore(drizzle(admin), { schema });
      if (!made.ok) throw new Error("store");
      return made.value;
    })();
    if (canRole) {
      await q("CREATE SCHEMA {s}");
      const m = await adminStore.migrate();
      if (!m.ok) throw new Error(`migrate ${m.error.code}`);
    }
    const password = `pw_${hex()}${hex()}`;
    /** نقشِ LOGINِ واقعی با رمز؛ grants با همان `policy:grants apply`. */
    async function loginRole(): Promise<string> {
      const name = `tpd_rt_${hex()}`;
      roles.push(name);
      await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${password}'`);
      const out = await runToolPolicyGrants({
        argv: ["apply", `--role=${name}`],
        env: { DATABASE_URL: DB_URL as string, TOOL_POLICY_SCHEMA: schema },
        ports: { open: () => openGrantsDatabase(DB_URL, IDLE_MS), query: grantsQuery, transact: grantsTransact, timer: realTimer, write: () => undefined },
      });
      if (out.exitCode !== 0) throw new Error(`grants ${out.exitCode}`);
      return name;
    }
    const urlFor = (role: string, pw: string = password): string => {
      const u = new URL(DB_URL as string);
      u.username = role;
      u.password = pw;
      return u.toString();
    };
    /** فعالیتِ اتصال‌های میزبان در پایگاه (از دیدِ مدیر). */
    const activity = async (role: string) =>
      (await admin.query("SELECT usename, application_name FROM pg_stat_activity WHERE usename = $1 AND datname = current_database()", [role])).rows as Array<{ usename: string; application_name: string }>;
    const appBackends = async (): Promise<Array<{ usename: string }>> =>
      (await admin.query("SELECT usename FROM pg_stat_activity WHERE application_name = $1 AND datname = current_database()", [POLICY_APPLICATION_NAME])).rows as Array<{ usename: string }>;

    /** میزبانِ واقعی؛ استخر را `selectPolicyDatabaseOpener` (کدِ تولیدی) می‌سازد. */
    async function host(envExtra: Record<string, unknown>, tuning: Record<string, string> = {}) {
      const events: PolicyPoolEvent[] = [];
      const sharedCalls = vi.fn();
      const captured: PolicyPoolLike[] = [];
      const real = await nodePostgresDriver();
      const driver = async (): Promise<PolicyPoolDriver> => ({
        ...real,
        createPool: (o) => {
          const p = real.createPool({ ...o });
          captured.push(p);
          return p;
        },
      });
      const store: Record<symbol, unknown> = {};
      cleanups.push(async () => void (await getToolPolicyHost(store)?.shutdown()));
      const env = { ...TUNING_ENV, ...tuning, TOOL_POLICY_SCHEMA: schema, ...envExtra };
      const out = await startToolPolicyBootstrap({
        store,
        processOwner: "next",
        signals: false,
        env,
        openDatabase: selectPolicyDatabaseOpener({
          env,
          shared: async () => {
            sharedCalls();
            throw new Error("shared pool must never be used");
          },
          log: (e) => void events.push(e),
          driver,
        }),
      });
      const boot = out.status === "started" ? await out.booting : null;
      const ready = (): number => probeHttpResponse(store, "ready").status;
      const logsText = (): string => JSON.stringify(events);
      return { out, boot, store, events, sharedCalls, captured, ready, logsText };
    }
    return { schema, admin, q, adminStore, canRole, loginRole, urlFor, activity, appBackends, host, password };
  }

  it("اتصال‌ها با نقشِ واقعی و application_name ثابت (≤ ۲)؛ ready ۲۰۰؛ استخرِ مشترک صدا زده نمی‌شود؛ همین استخر نمی‌تواند بنویسد؛ خاموشیِ تمیز همه را می‌بندد", async () => {
    const r = await rig();
    if (!r.canRole) return;
    expect((await r.adminStore.append({ version: 1, overrides: {}, policy: POLICY as never, changes: [], source: { kind: "set" }, actor: "admin:alice", reason: "دلیل آزمون", createdAtMs: 1001 })).ok).toBe(true);
    const role = await r.loginRole();
    const h = await r.host({ POLICY_DATABASE_URL: r.urlFor(role) });
    expect(h.boot).toEqual({ booted: true, attempts: 1 });
    await until(() => h.ready() === 200, "ready");
    expect(h.sharedCalls).not.toHaveBeenCalled();
    expect(h.captured).toHaveLength(1);

    const act = await r.activity(role);
    expect(act.length).toBeGreaterThanOrEqual(1);
    expect(act.length).toBeLessThanOrEqual(POLICY_POOL_MAX);
    expect(new Set(act.map((a) => a.application_name))).toEqual(new Set([POLICY_APPLICATION_NAME]));
    expect((await r.appBackends()).every((b) => b.usename === role)).toBe(true);

    // همین استخرِ اختصاصی واقعاً بی‌امتیاز است.
    const pool = h.captured[0] as unknown as Pool;
    const who = (await pool.query("SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su")).rows[0];
    expect(who).toEqual({ u: role, su: false });
    expect(await sqlstate(pool.query(`UPDATE "${r.schema}".tool_policy_versions SET actor = 'x'`))).toBe("42501");
    expect(await sqlstate(pool.query(`DELETE FROM "${r.schema}".tool_policy_versions`))).toBe("42501");
    expect(await sqlstate(pool.query(`CREATE TABLE "${r.schema}".t_evil (a int)`))).toBe("42501");
    expect(Number((await r.q("SELECT count(*) AS n FROM {s}.tool_policy_versions")).rows[0].n)).toBe(1);

    expect(await getToolPolicyHost(h.store)?.shutdown()).toMatchObject({ ok: true, clean: true, closed: "ok" });
    await until(async () => (await r.activity(role)).length === 0, "همهٔ اتصال‌ها بسته شدند");
    expect(h.events.map((e) => e.type)).toEqual(["pool.opened", "pool.closed"]);
    expect(h.logsText()).not.toContain(r.password);
  });

  it("شکست‌بسته: رمزِ غلط ⇒ UNAVAILABLE با همهٔ تلاش‌ها، ready ۵۰۳، live ۲۰۰؛ هیچ اتصالِ ابَرکاربری ساخته نمی‌شود و استخرِ مشترک صدا زده نمی‌شود", async () => {
    const r = await rig();
    if (!r.canRole) return;
    const role = await r.loginRole();
    const h = await r.host({ POLICY_DATABASE_URL: r.urlFor(role, "wrong-password") });
    expect(h.boot).toEqual({ booted: false, reason: "UNAVAILABLE", attempts: BOOT_ATTEMPTS });
    expect(h.ready()).toBe(503);
    expect(probeHttpResponse(h.store, "live").status).toBe(200);
    expect(h.sharedCalls).not.toHaveBeenCalled();
    expect(await r.appBackends()).toEqual([]);
    expect(h.logsText()).not.toContain("wrong-password");
    expect(h.logsText()).not.toContain(r.password);
  });

  it("شکست‌بسته: رشتهٔ نامعتبر ⇒ DATABASE_UNAVAILABLE، بی‌هیچ اتصال و بی‌استخرِ مشترک؛ لاگِ config-invalid بی‌مقدار", async () => {
    const r = await rig();
    if (!r.canRole) return;
    const h = await r.host({ POLICY_DATABASE_URL: "mysql://leaky:topsecret@h/db" });
    expect(h.out).toMatchObject({ status: "failed", code: "DATABASE_UNAVAILABLE" });
    expect(h.sharedCalls).not.toHaveBeenCalled();
    expect(h.events).toEqual([{ type: "pool.config-invalid", env: "POLICY_DATABASE_URL" }]);
    expect(h.logsText()).not.toContain("topsecret");
    expect(await r.appBackends()).toEqual([]);
  });

  it("مهاجرت‌نشده با نقشِ واقعی ⇒ NOT_MIGRATED بی‌بازتلاش؛ پس از خاموشی هیچ اتصالِ نشتی نمی‌ماند", async () => {
    const r = await rig();
    if (!r.canRole) return;
    const role = await r.loginRole();
    await r.q("DROP SCHEMA {s} CASCADE");
    const h = await r.host({ POLICY_DATABASE_URL: r.urlFor(role) });
    expect(h.boot).toEqual({ booted: false, reason: "NOT_MIGRATED", attempts: 1 });
    expect(h.ready()).toBe(503);
    await getToolPolicyHost(h.store)?.shutdown();
    await until(async () => (await r.activity(role)).length === 0, "هیچ اتصالِ نشتی");
    expect(h.sharedCalls).not.toHaveBeenCalled();
  });

  it("قطعِ اتصالِ بی‌کارِ پایگاه (pg_terminate_backend) فرایند را نمی‌اندازد؛ فقط کدِ 57P01 لاگ می‌شود و ready ۲۰۰ می‌ماند (با رفرشِ بعدی اتصالِ تازه)", async () => {
    const r = await rig();
    if (!r.canRole) return;
    const role = await r.loginRole();
    const fast = { TOOL_POLICY_INTERVAL_MS: "1000", TOOL_POLICY_RETRY_MS: "100", TOOL_POLICY_ATTEMPT_DEADLINE_MS: "1500", TOOL_POLICY_REFRESH_TIMEOUT_MS: "1500", TOOL_POLICY_MAX_STALE_MS: "8000" };
    const h = await r.host({ POLICY_DATABASE_URL: r.urlFor(role) }, fast);
    expect(h.boot).toEqual({ booted: true, attempts: 1 });
    await until(() => h.ready() === 200, "ready");
    // اتصالِ بی‌کار را می‌کُشیم؛ بدونِ شنوندهٔ error این رویداد «uncaught» می‌شد و آزمون را می‌انداخت.
    await until(async () => {
      await r.admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1 AND pid <> pg_backend_pid()", [role]);
      return h.events.some((e) => e.type === "pool.error");
    }, "رویدادِ pool.error");
    const err = h.events.find((e) => e.type === "pool.error");
    expect(err).toEqual({ type: "pool.error", code: "57P01" });
    await until(async () => h.ready() === 200 && (await r.activity(role)).length > 0, "ready ۲۰۰ با اتصالِ تازه", 15_000);
    expect(h.sharedCalls).not.toHaveBeenCalled();
    expect(h.logsText()).not.toContain(r.password);
  }, 40_000);
});
