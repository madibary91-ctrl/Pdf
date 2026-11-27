/**
 * میزبانِ سیاستِ ابزار (tool-policy-bootstrap) با **نقشِ بی‌امتیازِ واقعی** روی PostgreSQL واقعی (ADR-0082؛ قرارداد: ADR-0081).
 * اتصالِ میزبان با `-c role=…` ساخته می‌شود (ابَرکاربری رها می‌شود)؛ پس آنچه می‌بینید همان است که در تولید با نقشِ زمانِ اجرا رخ می‌دهد. ثابت می‌شود:
 *  - **بعد از `policy:grants apply`:** میزبان بوت می‌شود، `ready` ۲۰۰ است، نسخه‌هایی که مدیر نوشته را می‌خواند، و خودِ همین اتصال نمی‌تواند بنویسد.
 *  - **میزبان فقط سه حقِ خواندن لازم دارد** (USAGE + SELECT روی دو جدول)؛ `INSERT` را لازم ندارد ولی `verify` آن را `missing` می‌گوید.
 *  - **میزبان حقِ زیاد را نمی‌بیند:** با `UPDATE` اضافه هم ۲۰۰ می‌دهد؛ فقط `verify` آن را `excess`/DRIFT می‌گیرد ⇒ دروازهٔ استقرار `verify` است نه میزبان.
 *  - **محدودیتِ شناخته‌شده:** نبودنِ هر یک از سه حقِ خواندن در میزبان `UNAVAILABLE` (گذرا ⇒ بازتلاش) دیده می‌شود، نه خطای مجوز؛ تشخیصِ دقیق با `verify` است و `apply` درمان می‌کند.
 *    (اگر روزی ریشه کدِ مجوزِ جدا داد این آزمون عمداً قرمز می‌شود تا ADR و راهنما هم‌زمان به‌روز شوند.)
 *  - **تمایزِ مهاجرت‌نشده از بی‌حقی:** شِمای ناموجود ⇒ `NOT_MIGRATED` (بی‌بازتلاش) حتی برای نقشِ بی‌حق.
 * نقش‌ساختن فقط وقتی ادعا می‌شود که کاربرِ آزمون `CREATE ROLE` دارد (CI: postgres)؛ وگرنه صریحاً بی‌ادعا برمی‌گردد (نه `skip`). شِما/نقش‌ها یک‌بارمصرف‌اند.
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { probeHttpResponse, startToolPolicyBootstrap } from "@/modules/tool-policy-bootstrap";
import { getToolPolicyHost } from "@/modules/tool-policy-host";
import { runToolPolicyGrants, type GrantsOutcome } from "@/modules/tool-policy-grants";
import { createPgPolicyVersionStore } from "@/modules/tool-policy-store-pg";
import { grantsQuery, grantsTransact, openGrantsDatabase } from "./cli/grants-pg";

config({ quiet: true });
const DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const dbDescribe = typeof DB_URL === "string" && DB_URL !== "" ? describe : describe.skip;
const IDLE_MS = 50;
const realTimer = { after: (fn: () => void, ms: number): unknown => setTimeout(fn, ms), cancel: (h: unknown): void => clearTimeout(h as NodeJS.Timeout) };
const hex = (): string => randomBytes(5).toString("hex");
const POLICY = { timing: { graceMs: 90_000 }, model: { timeoutMs: 30_000 } };
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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, label: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(5);
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

dbDescribe("tool-policy-bootstrap · با نقشِ بی‌امتیازِ واقعی (PostgreSQL)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  async function rig(opts: Readonly<{ createSchema?: boolean }> = {}) {
    const schema = `tpr_${hex()}`;
    const admin = new Pool({ connectionString: DB_URL, max: 3, idleTimeoutMillis: IDLE_MS });
    const roles: string[] = [];
    const pools: Pool[] = [];
    const me = (await admin.query("SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user")).rows[0] as { rolsuper: boolean; rolcreaterole: boolean };
    const canRole = me.rolsuper || me.rolcreaterole;
    cleanups.push(async () => {
      try {
        for (const p of pools) if (!p.ended) await p.end();
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
    if (canRole && opts.createSchema !== false) {
      await q("CREATE SCHEMA {s}");
      const m = await adminStore.migrate();
      if (!m.ok) throw new Error(`migrate ${m.error.code}`);
    }
    const newRole = async (): Promise<string> => {
      const name = `tpr_rt_${hex()}`;
      roles.push(name);
      await admin.query(`CREATE ROLE "${name}" NOLOGIN`);
      return name;
    };
    async function grants(command: string, who: string): Promise<GrantsOutcome & { lines: string[] }> {
      const lines: string[] = [];
      const out = await runToolPolicyGrants({
        argv: [command, `--role=${who}`],
        env: { DATABASE_URL: DB_URL as string, TOOL_POLICY_SCHEMA: schema },
        ports: { open: () => openGrantsDatabase(DB_URL, IDLE_MS), query: grantsQuery, transact: grantsTransact, timer: realTimer, write: (l: string) => lines.push(l) },
      });
      return { ...out, lines };
    }
    const grant = (stmt: string, who: string): Promise<unknown> => q(stmt.split("{r}").join(`"${who}"`));
    /** میزبانِ واقعی با اتصالِ بی‌امتیاز؛ `boot` نتیجهٔ بوت است. */
    async function hostAs(who: string, env: Record<string, string> = {}) {
      const pool = new Pool({ connectionString: DB_URL, max: 2, idleTimeoutMillis: IDLE_MS, options: `-c role=${who}` });
      pool.on("error", () => undefined);
      pools.push(pool);
      const store: Record<symbol, unknown> = {};
      const calls = { close: 0, release: 0 };
      cleanups.push(async () => void (await getToolPolicyHost(store)?.shutdown()));
      const out = await startToolPolicyBootstrap({
        store,
        processOwner: "next",
        signals: false,
        env: { ...TUNING_ENV, TOOL_POLICY_SCHEMA: schema, ...env },
        openDatabase: async () => ({ db: drizzle(pool), close: () => void (calls.close += 1), release: () => void (calls.release += 1) }),
      });
      if (out.status !== "started") throw new Error(`bootstrap ${out.status}`);
      const boot = await out.booting;
      const ready = (): number => probeHttpResponse(store, "ready").status;
      return { pool, store, calls, boot, ready, body: () => probeHttpResponse(store, "ready").json() };
    }
    return { schema, admin, q, adminStore, canRole, newRole, grants, grant, hostAs };
  }

  it("پس از apply: میزبان با نقشِ واقعی بوت می‌شود، ready ۲۰۰، نسخهٔ مدیر را می‌خواند؛ همین اتصال نمی‌تواند بنویسد و ledger دست‌نخورده می‌ماند", async () => {
    const r = await rig();
    if (!r.canRole) return;
    const appended = await r.adminStore.append({ version: 1, overrides: {}, policy: POLICY as never, changes: [], source: { kind: "set" }, actor: "admin:alice", reason: "دلیل آزمون", createdAtMs: 1001 });
    expect(appended.ok).toBe(true);
    const role = await r.newRole();
    expect((await r.grants("apply", role)).exitCode).toBe(0);
    const ledgerBefore = (await r.q("SELECT name, checksum FROM {s}.tool_policy_migration_ledger ORDER BY name")).rows;

    const h = await r.hostAs(role);
    expect(h.boot).toEqual({ booted: true, attempts: 1 });
    await until(() => h.ready() === 200, "ready");
    expect(await h.body()).toEqual({ probe: "ready", ok: true, state: "running", reason: null });

    // همین اتصال واقعاً بی‌امتیاز است (نه ابَرکاربری) و نمی‌تواند بنویسد.
    const who = (await h.pool.query("SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS su")).rows[0];
    expect(who).toEqual({ u: role, su: false });
    expect(await sqlstate(h.pool.query(`UPDATE "${r.schema}".tool_policy_versions SET actor = 'x'`))).toBe("42501");
    expect(await sqlstate(h.pool.query(`DELETE FROM "${r.schema}".tool_policy_versions`))).toBe("42501");
    expect(await sqlstate(h.pool.query(`INSERT INTO "${r.schema}".tool_policy_migration_ledger (name, checksum) VALUES ('x','y')`))).toBe("42501");

    expect((await r.q("SELECT name, checksum FROM {s}.tool_policy_migration_ledger ORDER BY name")).rows).toEqual(ledgerBefore);
    expect(Number((await r.q("SELECT count(*) AS n FROM {s}.tool_policy_versions")).rows[0].n)).toBe(1);
    expect(await getToolPolicyHost(h.store)?.shutdown()).toMatchObject({ ok: true, clean: true, closed: "ok" });
    expect(h.calls).toEqual({ close: 1, release: 0 });
  });

  it("حداقلِ میزبان: فقط USAGE + SELECT روی دو جدول (بی‌INSERT) ⇒ ready ۲۰۰؛ ولی verify همان INSERT را missing می‌گوید (دروازهٔ استقرار verify است)", async () => {
    const r = await rig();
    if (!r.canRole) return;
    const role = await r.newRole();
    await r.grant(`GRANT USAGE ON SCHEMA "${r.schema}" TO {r}`, role);
    await r.grant(`GRANT SELECT ON "${r.schema}".tool_policy_versions, "${r.schema}".tool_policy_migration_ledger TO {r}`, role);
    const h = await r.hostAs(role);
    expect(h.boot).toEqual({ booted: true, attempts: 1 });
    await until(() => h.ready() === 200, "ready");
    const v = await r.grants("verify", role);
    expect(v.exitCode).toBe(5);
    expect(v.report.findings).toEqual(["missing:tool_policy_versions:INSERT"]);
  });

  it("حقِ زیاد را میزبان نمی‌بیند: apply + UPDATE اضافه ⇒ ready ۲۰۰؛ verify ⇒ DRIFT با excess؛ apply دوباره برش می‌دارد", async () => {
    const r = await rig();
    if (!r.canRole) return;
    const role = await r.newRole();
    expect((await r.grants("apply", role)).exitCode).toBe(0);
    await r.grant(`GRANT UPDATE ON "${r.schema}".tool_policy_versions TO {r}`, role);
    const h = await r.hostAs(role);
    expect(h.boot).toEqual({ booted: true, attempts: 1 });
    await until(() => h.ready() === 200, "ready");
    const v = await r.grants("verify", role);
    expect({ exit: v.exitCode, code: v.report.code }).toEqual({ exit: 5, code: "DRIFT" });
    expect(v.report.findings).toEqual(["excess:tool_policy_versions:UPDATE"]);
    expect((await r.grants("apply", role)).exitCode).toBe(0);
    expect((await r.grants("verify", role)).exitCode).toBe(0);
  });

  const MISSING: ReadonlyArray<Readonly<{ name: string; keep: (s: string) => string[]; finding: string }>> = [
    { name: "بی‌هیچ حق", keep: () => [], finding: "missing:schema:USAGE" },
    { name: "فقط USAGE", keep: (s) => [`GRANT USAGE ON SCHEMA "${s}" TO {r}`], finding: "missing:tool_policy_versions:SELECT" },
    { name: "بی‌SELECT روی ledger", keep: (s) => [`GRANT USAGE ON SCHEMA "${s}" TO {r}`, `GRANT SELECT ON "${s}".tool_policy_versions TO {r}`], finding: "missing:tool_policy_migration_ledger:SELECT" },
    { name: "بی‌SELECT روی نسخه‌ها", keep: (s) => [`GRANT USAGE ON SCHEMA "${s}" TO {r}`, `GRANT SELECT ON "${s}".tool_policy_migration_ledger TO {r}`], finding: "missing:tool_policy_versions:SELECT" },
  ];
  for (const c of MISSING) {
    it(`محدودیتِ شناخته‌شده · ${c.name}: میزبان UNAVAILABLE (بازتلاش‌شده، ready ۵۰۳، live ۲۰۰)؛ verify حقِ گمشده را نام می‌برد؛ apply درمان می‌کند و میزبانِ تازه آماده می‌شود`, async () => {
      const r = await rig();
      if (!r.canRole) return;
      const role = await r.newRole();
      for (const s of c.keep(r.schema)) await r.grant(s, role);
      const bad = await r.hostAs(role);
      expect(bad.boot).toEqual({ booted: false, reason: "UNAVAILABLE", attempts: BOOT_ATTEMPTS });
      expect(bad.ready()).toBe(503);
      expect(probeHttpResponse(bad.store, "live").status).toBe(200);
      expect(bad.calls).toEqual({ close: 0, release: 0 });

      const v = await r.grants("verify", role);
      expect(v.exitCode).toBe(5);
      expect(v.report.findings).toContain(c.finding);
      expect((await r.grants("apply", role)).exitCode).toBe(0);

      const good = await r.hostAs(role);
      expect(good.boot).toEqual({ booted: true, attempts: 1 });
      await until(() => good.ready() === 200, "ready");
    });
  }

  it("لغوِ حق در حینِ اجرا: SELECT از نقش گرفته شود ⇒ ready ۵۰۳ (کهنگیِ سیاست، نه ادامهٔ بی‌صدا)، live ۲۰۰ می‌ماند؛ apply حق را برمی‌گرداند ⇒ ready ۲۰۰ بی‌ری‌استارت", async () => {
    const r = await rig();
    if (!r.canRole) return;
    const role = await r.newRole();
    expect((await r.grants("apply", role)).exitCode).toBe(0);
    const fast = {
      TOOL_POLICY_INTERVAL_MS: "1000",
      TOOL_POLICY_RETRY_MS: "100",
      TOOL_POLICY_ATTEMPT_DEADLINE_MS: "300",
      TOOL_POLICY_REFRESH_TIMEOUT_MS: "300",
      TOOL_POLICY_MAX_STALE_MS: "2000",
    };
    const h = await r.hostAs(role, fast);
    expect(h.boot).toEqual({ booted: true, attempts: 1 });
    await until(() => h.ready() === 200, "ready");

    await r.grant(`REVOKE SELECT ON "${r.schema}".tool_policy_versions FROM {r}`, role);
    await until(() => h.ready() === 503, "ready ⇒ ۵۰۳ پس از لغوِ حق", 20_000);
    expect(probeHttpResponse(h.store, "live").status).toBe(200);
    const body = (await h.body()) as { ok: boolean; state: string; reason: unknown };
    expect({ ok: body.ok, state: body.state, reasonIsString: typeof body.reason === "string" }).toEqual({ ok: false, state: "running", reasonIsString: true });

    expect((await r.grants("apply", role)).exitCode).toBe(0);
    await until(() => h.ready() === 200, "ready ⇒ ۲۰۰ پس از بازگشتِ حق", 20_000);
  }, 60_000);

  it("مهاجرت‌نشده ≠ بی‌حقی: شِمای ناموجود برای نقشِ بی‌حق ⇒ NOT_MIGRATED بی‌بازتلاش (attempts ۱)، ready ۵۰۳", async () => {
    const r = await rig({ createSchema: false });
    if (!r.canRole) return;
    const role = await r.newRole();
    const h = await r.hostAs(role);
    expect(h.boot).toEqual({ booted: false, reason: "NOT_MIGRATED", attempts: 1 });
    expect(h.ready()).toBe(503);
    expect(probeHttpResponse(h.store, "live").status).toBe(200);
  });
});
