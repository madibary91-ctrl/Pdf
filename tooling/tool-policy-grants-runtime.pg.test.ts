/**
 * tool-policy-grants روی PostgreSQL واقعی، درون‌فرایندی (ADR-0081): کفایت، ضرورت و دقتِ قراردادِ حقوقِ نقشِ زمانِ اجرا.
 *  - **کفایت:** ذخیره‌سازِ واقعیِ tool-policy-store-pg با نقشِ بی‌امتیاز (`-c role=…`؛ ابَرکاربری رها می‌شود) همهٔ عملیاتش را انجام می‌دهد.
 *  - **ضرورت:** حذفِ هر یک از چهار حقِ قرارداد ⇒ دستِ‌کم یک عملیاتِ ذخیره‌ساز می‌شکند و `verify` همان حق را `missing` می‌گوید.
 *  - **دقت:** هر حقِ زیادی (همهٔ هفت حقِ جدولی روی هر دو جدول + `CREATE` روی شِما)، حقِ از راهِ PUBLIC/عضویت، رابطهٔ ناشناخته، نقشِ خطرناک و مالک
 *    دیده می‌شود؛ `apply` آنچه با REVOKE از نقش رفتنی است را می‌برد و آنچه نیست را `APPLY_FAILED` می‌داند.
 * پورت‌ها همان گلوی `tooling/cli/grants-pg.ts` است که CLI اجرا می‌کند. شِماها و نقش‌های یک‌بارمصرفِ `tpg_<تصادفی>`؛ به `public` یا `tool_policy` دست نمی‌زند.
 * نقش‌ساختن فقط وقتی ادعا می‌شود که کاربرِ آزمون `CREATE ROLE` دارد (CI: postgres)؛ وگرنه صریحاً بی‌ادعا برمی‌گردد (نه `skip`).
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { GRANTS_EXIT, planStatements, runToolPolicyGrants, type GrantsOutcome } from "@/modules/tool-policy-grants";
import { createPgPolicyVersionStore } from "@/modules/tool-policy-store-pg";
import { grantsQuery, grantsTransact, openGrantsDatabase } from "./cli/grants-pg";

config({ quiet: true });
const DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const dbDescribe = typeof DB_URL === "string" && DB_URL !== "" ? describe : describe.skip;
const IDLE_MS = 50;
const realTimer = { after: (fn: () => void, ms: number): unknown => setTimeout(fn, ms), cancel: (h: unknown): void => clearTimeout(h as NodeJS.Timeout) };
const hex = (): string => randomBytes(5).toString("hex");
const POLICY = { timing: { graceMs: 90_000 }, model: { timeoutMs: 30_000 } };
const TABLE_PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;
const TABLES = ["tool_policy_versions", "tool_policy_migration_ledger"] as const;

const sqlstate = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? "NOCODE";
  }
};

dbDescribe("tool-policy-grants · PostgreSQL واقعی (درون‌فرایندی)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  async function rig(opts: Readonly<{ migrate?: boolean; createSchema?: boolean }> = {}) {
    const schema = `tpg_${hex()}`;
    const role = `tpg_rt_${hex()}`;
    const admin = new Pool({ connectionString: DB_URL, max: 3, idleTimeoutMillis: IDLE_MS });
    const roles: string[] = [role];
    const pools: Pool[] = [];
    const me = (await admin.query("SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user")).rows[0] as { rolsuper: boolean; rolcreaterole: boolean };
    const canRole = me.rolsuper || me.rolcreaterole;
    cleanups.push(async () => {
      try {
        for (const p of pools) await p.end();
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        for (const r of roles) await admin.query(`DROP ROLE IF EXISTS "${r}"`);
      } finally {
        await admin.end();
      }
    });
    const q = (text: string, params: unknown[] = []) => admin.query(text.split("{s}").join(`"${schema}"`), params);
    if (canRole) {
      await q(`CREATE ROLE "${role}" NOLOGIN`);
      if (opts.createSchema !== false) await q("CREATE SCHEMA {s}");
      if (opts.createSchema !== false && opts.migrate !== false) {
        const made = createPgPolicyVersionStore(drizzle(admin), { schema });
        if (!made.ok) throw new Error("store");
        const m = await made.value.migrate();
        if (!m.ok) throw new Error(`migrate ${m.error.code}`);
      }
    }
    const newRole = async (extra = ""): Promise<string> => {
      const name = `tpg_x_${hex()}`;
      roles.push(name);
      await admin.query(`CREATE ROLE "${name}" NOLOGIN ${extra}`);
      return name;
    };
    async function run(command: string, who: string = role, extra: string[] = [], env: Record<string, string> = {}): Promise<GrantsOutcome & { lines: string[] }> {
      const lines: string[] = [];
      const out = await runToolPolicyGrants({
        argv: [command, `--role=${who}`, ...extra],
        env: { DATABASE_URL: DB_URL as string, TOOL_POLICY_SCHEMA: schema, ...env },
        ports: { open: () => openGrantsDatabase(DB_URL, IDLE_MS), query: grantsQuery, transact: grantsTransact, timer: realTimer, write: (l: string) => lines.push(l) },
      });
      return { ...out, lines };
    }
    /** حقوقِ مؤثرِ واقعی از دیدِ پایگاه (مستقل از ماژول). */
    const has = async (who: string, table: string, priv: string): Promise<boolean> =>
      (await q(`SELECT has_table_privilege($1::name, '{s}.${table}'::regclass, $2) AS g`, [who, priv])).rows[0].g as boolean;
    /** یک استخرِ بی‌امتیاز: ابَرکاربری با `-c role` رها می‌شود. */
    const asRole = (who: string): Pool => {
      const p = new Pool({ connectionString: DB_URL, max: 1, idleTimeoutMillis: IDLE_MS, options: `-c role=${who}` });
      p.on("error", () => undefined);
      pools.push(p);
      return p;
    };
    const nextVersion = async (): Promise<number> => Number((await q("SELECT coalesce(max(version), 0) + 1 AS n FROM {s}.tool_policy_versions")).rows[0].n);
    /** هر سه عملیاتِ ذخیره‌ساز با نقشِ زمانِ اجرا. */
    async function exercise(pool: Pool): Promise<Readonly<{ status: boolean; latest: boolean; append: boolean }>> {
      const made = createPgPolicyVersionStore(drizzle(pool), { schema, statementTimeoutMs: 5000 });
      if (!made.ok) throw new Error("store");
      const store = made.value;
      const st = await store.status();
      const latest = await store.latest();
      const version = await nextVersion();
      const append = await store.append({ version, overrides: {}, policy: POLICY as never, changes: [], source: { kind: "set" }, actor: "admin:alice", reason: "دلیل آزمون", createdAtMs: 1000 + version });
      return { status: st.ok && st.value.ready, latest: latest.ok, append: append.ok };
    }
    return { schema, role, admin, q, canRole, newRole, run, has, asRole, exercise };
  }

  const exact = (o: GrantsOutcome): void => expect({ code: o.report.code, exit: o.exitCode, findings: o.report.findings }).toEqual({ code: "OK", exit: 0, findings: undefined });

  it("کدهای خروجِ بسته قفل است", () => {
    expect(GRANTS_EXIT).toEqual({ OK: 0, INTERNAL: 1, USAGE: 2, PENDING: 3, UNAVAILABLE: 4, DRIFT: 5, APPLY_FAILED: 6, TIMEOUT: 7, ROLE_UNUSABLE: 8 });
  });

  it("کاملیت: هر رابطهٔ شِمای مهاجرت‌شده در قرارداد است (مهاجرتِ تازهٔ بی‌قرارداد این آزمون را قرمز می‌کند)", async () => {
    const r = await rig();
    if (!r.canRole) return;
    const rels = (await r.q("SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f','S') ORDER BY 1", [r.schema])).rows.map((x) => x.relname);
    expect(rels).toEqual([...TABLES].sort());
  });

  it("پیش از مهاجرت: شِمای ناموجود ⇒ PENDING (۳) بی‌نوشتن؛ شِمای بی‌جدول ⇒ PENDING با نامِ جدول‌ها", async () => {
    const none = await rig({ createSchema: false });
    if (!none.canRole) return;
    for (const cmd of ["verify", "apply"]) {
      const o = await none.run(cmd);
      expect({ code: o.report.code, findings: o.report.findings, wrote: o.report.wrote }).toEqual({ code: "PENDING", findings: ["schema_missing"], wrote: undefined });
    }
    const bare = await rig({ migrate: false });
    const o = await bare.run("apply");
    expect(o.exitCode).toBe(3);
    expect(o.report.findings).toEqual(["relation_missing:tool_policy_versions", "relation_missing:tool_policy_migration_ledger"]);
    expect((await bare.q("SELECT has_schema_privilege($1::name, $2::name, 'USAGE') AS g", [bare.role, bare.schema])).rows[0].g).toBe(false);
  });

  it("نقشِ تازه بی‌حق: verify ⇒ DRIFT (۵) با چهار missing و هیچ excess؛ هیچ نوشتنی", async () => {
    const r = await rig();
    if (!r.canRole) return;
    const o = await r.run("verify");
    expect(o.exitCode).toBe(5);
    expect(o.report.findings).toEqual(["missing:schema:USAGE", "missing:tool_policy_versions:SELECT", "missing:tool_policy_versions:INSERT", "missing:tool_policy_migration_ledger:SELECT"]);
    expect(o.report.wrote).toBeUndefined();
    expect(o.lines).toHaveLength(1);
  });

  it("apply: ۰ با wrote؛ بار دوم ۰ بی‌نوشتن؛ verify ۰؛ و برنامه با همین نقش واقعاً کار می‌کند (کفایت)", async () => {
    const r = await rig();
    if (!r.canRole) return;
    const first = await r.run("apply");
    exact(first);
    expect(first.report).toMatchObject({ phase: "verify", wrote: true, role: r.role, schema: r.schema });
    const again = await r.run("apply");
    expect(again.report.wrote).toBeUndefined();
    expect(again.report.phase).toBe("check");
    exact(await r.run("verify"));

    const pool = r.asRole(r.role);
    expect((await pool.query("SELECT current_user AS u, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS s")).rows[0]).toEqual({ u: r.role, s: false });
    expect(await r.exercise(pool)).toEqual({ status: true, latest: true, append: true });
    expect(await r.exercise(pool)).toEqual({ status: true, latest: true, append: true });
    const made = createPgPolicyVersionStore(drizzle(pool), { schema: r.schema });
    if (!made.ok) throw new Error("store");
    const latest = await made.value.latest();
    expect(latest.ok && latest.value?.version).toBe(2);
    const list = await made.value.list({ beforeVersion: null, limit: 10 });
    expect(list.ok && list.value.map((x) => x.version)).toEqual([2, 1]);
  });

  it("دقت از سمتِ برنامه: با همین نقش UPDATE/DELETE/TRUNCATE، نوشتنِ دفتر، DDL، خاموشیِ تریگر و session_replication_role همه ۴۲۵۰۱‌اند", async () => {
    const r = await rig();
    if (!r.canRole) return;
    exact(await r.run("apply"));
    const pool = r.asRole(r.role);
    expect((await r.exercise(pool)).append).toBe(true);
    const attempts: Record<string, string> = {
      update: `UPDATE "${r.schema}".tool_policy_versions SET reason = 'x'`,
      delete: `DELETE FROM "${r.schema}".tool_policy_versions`,
      truncate: `TRUNCATE "${r.schema}".tool_policy_versions`,
      ledgerInsert: `INSERT INTO "${r.schema}".tool_policy_migration_ledger (name, checksum) VALUES ('x', 'y')`,
      ledgerDelete: `DELETE FROM "${r.schema}".tool_policy_migration_ledger`,
      createTable: `CREATE TABLE "${r.schema}".t (a int)`,
      dropTable: `DROP TABLE "${r.schema}".tool_policy_versions`,
      disableTrigger: `ALTER TABLE "${r.schema}".tool_policy_versions DISABLE TRIGGER ALL`,
      replicaRole: "SET session_replication_role = replica",
      changeOwner: `ALTER TABLE "${r.schema}".tool_policy_versions OWNER TO CURRENT_USER`,
    };
    for (const [name, text] of Object.entries(attempts)) expect(await sqlstate(pool.query(text)), name).toBe("42501");
    expect(Number((await r.q("SELECT count(*) AS n FROM {s}.tool_policy_versions")).rows[0].n)).toBe(1);
  });

  it("ضرورت: حذفِ هر یک از چهار حق ⇒ دستِ‌کم یک عملیاتِ ذخیره‌ساز می‌شکند، verify همان حق را missing می‌گوید و apply دوباره درست می‌کند", async () => {
    const r = await rig();
    if (!r.canRole) return;
    exact(await r.run("apply"));
    const cases: ReadonlyArray<Readonly<{ revoke: (s: string) => string; finding: string }>> = [
      { revoke: (s) => `REVOKE USAGE ON SCHEMA "${s}" FROM "${r.role}"`, finding: "missing:schema:USAGE" },
      { revoke: (s) => `REVOKE SELECT ON "${s}".tool_policy_versions FROM "${r.role}"`, finding: "missing:tool_policy_versions:SELECT" },
      { revoke: (s) => `REVOKE INSERT ON "${s}".tool_policy_versions FROM "${r.role}"`, finding: "missing:tool_policy_versions:INSERT" },
      { revoke: (s) => `REVOKE SELECT ON "${s}".tool_policy_migration_ledger FROM "${r.role}"`, finding: "missing:tool_policy_migration_ledger:SELECT" },
    ];
    for (const c of cases) {
      await r.admin.query(c.revoke(r.schema));
      const pool = r.asRole(r.role);
      const ex = await r.exercise(pool);
      expect(Object.values(ex).includes(false), c.finding).toBe(true);
      const v = await r.run("verify");
      expect([v.exitCode, v.report.findings], c.finding).toEqual([5, [c.finding]]);
      exact(await r.run("apply"));
      expect(await r.exercise(r.asRole(r.role)), c.finding).toEqual({ status: true, latest: true, append: true });
    }
  });

  it("دقت: هر حقِ زیادیِ جدولی روی هر دو جدول (۱۱ حالت) و CREATE روی شِما ⇒ excess و apply آن را می‌برد", async () => {
    const r = await rig();
    if (!r.canRole) return;
    exact(await r.run("apply"));
    const contract: Record<string, string[]> = { tool_policy_versions: ["SELECT", "INSERT"], tool_policy_migration_ledger: ["SELECT"] };
    const extras: Array<{ grant: string; finding: string; table?: string; priv?: string }> = [];
    for (const t of TABLES) for (const p of TABLE_PRIVS) if (!(contract[t] as string[]).includes(p)) extras.push({ grant: `GRANT ${p} ON {s}.${t} TO "${r.role}"`, finding: `excess:${t}:${p}`, table: t, priv: p });
    extras.push({ grant: `GRANT CREATE ON SCHEMA {s} TO "${r.role}"`, finding: "excess:schema:CREATE" });
    expect(extras).toHaveLength(12); // ۵ حقِ زیادِ نسخه‌ها + ۶ حقِ زیادِ دفتر + CREATE روی شِما
    for (const e of extras) {
      await r.q(e.grant);
      const v = await r.run("verify");
      expect([v.exitCode, v.report.findings], e.finding).toEqual([5, [e.finding]]);
      const a = await r.run("apply");
      expect([a.exitCode, a.report.wrote, a.report.phase], e.finding).toEqual([0, true, "verify"]);
      if (e.table !== undefined) expect(await r.has(r.role, e.table, e.priv as string), e.finding).toBe(false);
    }
    exact(await r.run("verify"));
  });

  it("حقِ زیاد از راهِ PUBLIC یا عضویت با REVOKE از نقش رفتنی نیست ⇒ APPLY_FAILED (۶) با همان یافته؛ پس از رفعِ ریشه ⇒ ۰", async () => {
    const r = await rig();
    if (!r.canRole) return;
    exact(await r.run("apply"));
    await r.q("GRANT UPDATE ON {s}.tool_policy_versions TO PUBLIC");
    const pub = await r.run("apply");
    expect([pub.exitCode, pub.report.phase, pub.report.wrote, pub.report.findings]).toEqual([6, "verify", true, ["excess:tool_policy_versions:UPDATE"]]);
    await r.q("REVOKE UPDATE ON {s}.tool_policy_versions FROM PUBLIC");
    exact(await r.run("apply"));

    const group = await r.newRole();
    await r.q(`GRANT DELETE, TRUNCATE ON {s}.tool_policy_versions TO "${group}"`);
    await r.admin.query(`GRANT "${group}" TO "${r.role}"`);
    const member = await r.run("apply");
    expect([member.exitCode, member.report.findings]).toEqual([6, ["excess:tool_policy_versions:DELETE", "excess:tool_policy_versions:TRUNCATE"]]);
    await r.admin.query(`REVOKE "${group}" FROM "${r.role}"`);
    exact(await r.run("apply"));
  });

  it("رابطهٔ ناشناخته با حق ⇒ unexpected_relation_access و apply آن را می‌برد؛ نما/دنبالهٔ بی‌حق خطا نیست و اسمی از آن‌ها در گزارش نمی‌آید", async () => {
    const r = await rig();
    if (!r.canRole) return;
    exact(await r.run("apply"));
    await r.q("CREATE SEQUENCE {s}.canary_seq_leak_xyz");
    await r.q("CREATE VIEW {s}.canary_view_leak_xyz AS SELECT 1 AS a");
    exact(await r.run("verify")); // رابطه‌های ناشناختهٔ بی‌حق: بی‌یافته
    await r.q(`GRANT SELECT ON {s}.canary_view_leak_xyz TO "${r.role}"`);
    const v = await r.run("verify");
    expect([v.exitCode, v.report.findings]).toEqual([5, ["unexpected_relation_access"]]);
    expect(v.lines.join("")).not.toContain("canary_view_leak_xyz");
    await r.q(`GRANT USAGE ON SEQUENCE {s}.canary_seq_leak_xyz TO "${r.role}"`);
    exact(await r.run("apply"));
    expect((await r.q(`SELECT has_table_privilege($1::name, '{s}.canary_view_leak_xyz'::regclass, 'SELECT') AS g`, [r.role])).rows[0].g).toBe(false);
  });

  it("نقشِ نامناسب ⇒ ROLE_UNUSABLE (۸) بی‌نوشتن: ناموجود، CREATEROLE، CREATEDB، SUPERUSER، مالکِ شِما، مالکِ جدول، عضوِ مالک", async () => {
    const r = await rig();
    if (!r.canRole) return;
    const missing = await r.run("apply", `tpg_none_${hex()}`);
    expect([missing.exitCode, missing.report.findings, missing.report.wrote]).toEqual([8, ["role_missing"], undefined]);

    const cr = await r.newRole("CREATEROLE");
    expect((await r.run("apply", cr)).report.findings).toEqual(["role_createrole"]);
    const cd = await r.newRole("CREATEDB");
    expect((await r.run("verify", cd)).report.findings).toEqual(["role_createdb"]);
    const me = (await r.admin.query("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")).rows[0] as { rolsuper: boolean };
    if (me.rolsuper) {
      const su = await r.newRole("SUPERUSER");
      const o = await r.run("apply", su);
      expect([o.exitCode, o.report.findings, o.report.wrote]).toEqual([8, ["role_superuser"], undefined]);
    }

    const owner = await r.newRole();
    await r.q(`ALTER SCHEMA {s} OWNER TO "${owner}"`);
    const o1 = await r.run("apply", owner);
    expect([o1.exitCode, o1.report.findings, o1.report.wrote]).toEqual([8, ["owner:schema"], undefined]);
    await r.q(`ALTER SCHEMA {s} OWNER TO CURRENT_USER`);

    const tblOwner = await r.newRole();
    await r.q(`GRANT USAGE, CREATE ON SCHEMA {s} TO "${tblOwner}"`);
    await r.q(`ALTER TABLE {s}.tool_policy_versions OWNER TO "${tblOwner}"`);
    const o2 = await r.run("verify", tblOwner);
    expect(o2.exitCode).toBe(8);
    expect(o2.report.findings).toEqual(["owner:tool_policy_versions"]);
    const heir = await r.newRole();
    await r.admin.query(`GRANT "${tblOwner}" TO "${heir}"`);
    expect((await r.run("apply", heir)).report.findings).toEqual(["owner:tool_policy_versions"]);
  });

  it("پیش‌نمایش = اجرا: دستورهای plan را دستی اجرا کنیم ⇒ verify ۰؛ و plan اتصالی نمی‌سازد", async () => {
    const r = await rig();
    if (!r.canRole) return;
    let opened = 0;
    const lines: string[] = [];
    const plan = await runToolPolicyGrants({
      argv: ["plan", `--role=${r.role}`],
      env: { TOOL_POLICY_SCHEMA: r.schema },
      ports: { open: () => (opened++, { db: null, close: () => undefined }), query: () => ({ rows: [] }), transact: () => undefined, timer: realTimer, write: (l: string) => lines.push(l) },
    });
    expect(opened).toBe(0);
    expect(plan.report.statements).toEqual(planStatements(r.schema, r.role, 60_000));
    const client = await r.admin.connect();
    try {
      await client.query("BEGIN");
      for (const s of plan.report.statements as string[]) await client.query(s);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    exact(await r.run("verify"));
  });

  it("چهار apply هم‌زمان ⇒ همه ۰ و حقوقِ نهایی دقیقاً قرارداد", async () => {
    const r = await rig();
    if (!r.canRole) return;
    const outs = await Promise.all([r.run("apply"), r.run("apply"), r.run("apply"), r.run("apply")]);
    for (const o of outs) expect(o.exitCode).toBe(0);
    exact(await r.run("verify"));
  });

  it("مهلت: اجراکنندهٔ دیگر قفلِ مشورتیِ apply را دارد ⇒ TIMEOUT (۷)، هیچ حقی داده نشده؛ پس از آزادی ⇒ ۰", async () => {
    const r = await rig();
    if (!r.canRole) return;
    const holder = await r.admin.connect();
    try {
      await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`tool-policy-grants:apply:${r.schema}`]);
      const t0 = Date.now();
      const o = await r.run("apply", r.role, ["--timeout-ms=1000"]);
      expect([o.exitCode, o.report.code, o.report.phase, o.report.wrote]).toEqual([7, "TIMEOUT", "apply", undefined]);
      expect(["55P03", "57014"]).toContain(o.report.pgCode); // سقفِ سمتِ سرور (قفل/دستور) پیش از مهلتِ کلاینت
      expect(Date.now() - t0).toBeLessThan(15_000);
      expect(o.report.closed).toBe(true);
      expect(await r.has(r.role, "tool_policy_versions", "SELECT")).toBe(false);
      await holder.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`tool-policy-grants:apply:${r.schema}`]);
    } finally {
      holder.release();
    }
    exact(await r.run("apply"));
  });

  it("پایگاهِ نیافتنی ⇒ UNAVAILABLE (۴)؛ هیچ نشتی از رشتهٔ اتصال", async () => {
    const lines: string[] = [];
    const canary = ["LEAK", "CANARY", "grants", hex()].join("-");
    const url = ["postgres", "://u:", canary, "@127.0.0.1:1/db"].join("");
    const out = await runToolPolicyGrants({
      argv: ["verify", "--role=tpg_rt_none"],
      env: { DATABASE_URL: url },
      ports: { open: () => openGrantsDatabase(url, IDLE_MS), query: grantsQuery, transact: grantsTransact, timer: realTimer, write: (l: string) => lines.push(l) },
    });
    expect([out.exitCode, out.report.phase, out.report.closed]).toEqual([4, "check", true]);
    expect(lines.join("")).not.toContain(canary);
  });
});
