/**
 * tool-policy-migrate روی PostgreSQL واقعی، درون‌فرایندی (ADR-0080): ذخیره‌سازِ واقعیِ tool-policy-store-pg و drizzle.
 * شِماهای یک‌بارمصرفِ `tpm_<تصادفی>`؛ به `public` یا `tool_policy` دست نمی‌زند. بودجهٔ اتصال (ADR-0024): هر اجرا استخرِ خودش را می‌بندد.
 * نقشِ بی‌امتیاز (آزمونِ «نقشِ مهاجرتِ جدا») فقط وقتی ساخته می‌شود که کاربرِ آزمون اجازهٔ CREATE ROLE دارد (در CI: postgres/superuser).
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createPgPolicyVersionStore } from "@/modules/tool-policy-store-pg";
import { runToolPolicyMigrate } from "./cli";
import { CANARY } from "./test-kit";
import type { MigrateOutcome } from "./types";

config({ quiet: true });
const DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const dbDescribe = typeof DB_URL === "string" && DB_URL !== "" ? describe : describe.skip;
const IDLE_MS = 50;
/** هم‌ارزِ گلوی `tooling/cli/tool-policy-migrate.ts` (که خودش با `process.pg.test.ts` آزموده می‌شود). */
const createSchema = (db: unknown, schema: string): unknown => (db as { execute(q: ReturnType<typeof sql>): PromiseLike<unknown> }).execute(sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(schema)}`);
const realTimer = { after: (fn: () => void, ms: number): unknown => setTimeout(fn, ms), cancel: (h: unknown): void => clearTimeout(h as NodeJS.Timeout) };

dbDescribe("tool-policy-migrate · PostgreSQL واقعی (درون‌فرایندی)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  function rig() {
    const schema = `tpm_${randomBytes(5).toString("hex")}`;
    const admin = new Pool({ connectionString: DB_URL, max: 2, idleTimeoutMillis: IDLE_MS });
    cleanups.push(async () => {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    });
    const env = (extra: Record<string, string> = {}, url: string | undefined = DB_URL): Record<string, string> => ({ DATABASE_URL: url as string, TOOL_POLICY_SCHEMA: schema, ...extra });
    async function run(argv: string[], e: Record<string, string> = env()): Promise<MigrateOutcome & { lines: string[] }> {
      const pool = new Pool({ connectionString: e["DATABASE_URL"], max: 1, idleTimeoutMillis: IDLE_MS, connectionTimeoutMillis: 5_000 });
      pool.on("error", () => undefined);
      const lines: string[] = [];
      const out = await runToolPolicyMigrate({ argv, env: e, ports: { open: () => ({ db: drizzle(pool), close: () => pool.end() }), createSchema, timer: realTimer, write: (l: string) => lines.push(l) } });
      return { ...out, lines };
    }
    const schemaExists = async (): Promise<boolean> => (await admin.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema])).rowCount === 1;
    const ledgerRows = async (): Promise<number> => Number((await admin.query(`SELECT count(*)::int AS n FROM "${schema}".tool_policy_migration_ledger`)).rows[0].n);
    return { schema, admin, env, run, schemaExists, ledgerRows };
  }

  it("چرخهٔ کامل: status(3) ← up بی‌فلگ(8، چیزی ساخته نشد) ← up --create-schema(0) ← status(0) ← up(0، بی‌نوشتن)", async () => {
    const r = rig();
    const s1 = await r.run(["status"]);
    expect(s1.exitCode).toBe(3);
    expect(s1.report.state).toMatchObject({ schemaExists: false, ready: false, pending: ["0001_init"] });

    const u0 = await r.run(["up"]);
    expect(u0.exitCode).toBe(8);
    expect(u0.report.code).toBe("SCHEMA_MISSING");
    expect(await r.schemaExists()).toBe(false);

    const u1 = await r.run(["up", "--create-schema"]);
    expect(u1.exitCode).toBe(0);
    expect(u1.report).toMatchObject({ code: "OK", phase: "verify", schemaCreated: true, closed: true });
    expect(u1.report.state).toMatchObject({ ready: true, appliedNow: ["0001_init"], rows: 0, latestVersion: null, contiguous: true, problemCount: 0 });
    expect(await r.ledgerRows()).toBe(1);

    const s2 = await r.run(["status"]);
    expect([s2.exitCode, s2.report.state?.ready]).toEqual([0, true]);

    const u2 = await r.run(["up", "--create-schema"]);
    expect(u2.exitCode).toBe(0);
    expect(u2.report.phase).toBe("check");
    expect(u2.report.schemaCreated).toBeUndefined();
    expect(u2.report.state?.appliedNow).toEqual([]);
    expect(await r.ledgerRows()).toBe(1);
  });

  it("پس از up، خودِ ذخیره‌سازِ سیاست آماده است و ردیفِ نخست را می‌پذیرد و status شمارش می‌کند", async () => {
    const r = rig();
    await r.run(["up", "--create-schema"]);
    const pool = new Pool({ connectionString: DB_URL, max: 2, idleTimeoutMillis: IDLE_MS });
    cleanups.push(() => pool.end());
    const made = createPgPolicyVersionStore(drizzle(pool), { schema: r.schema });
    if (!made.ok) throw new Error("store");
    const st = await made.value.status();
    expect(st).toMatchObject({ ok: true, value: { ready: true, schemaExists: true, rows: 0 } });
    const s = await r.run(["status"]);
    expect(s.report.state).toMatchObject({ rows: 0, latestVersion: null });
  });

  it("شِما از پیش ساخته (مدیر) ⇒ up بی‌فلگ کافی است و schemaCreated ندارد", async () => {
    const r = rig();
    await r.admin.query(`CREATE SCHEMA "${r.schema}"`);
    const u = await r.run(["up"]);
    expect(u.exitCode).toBe(0);
    expect(u.report.schemaCreated).toBeUndefined();
    expect(u.report.state?.appliedNow).toEqual(["0001_init"]);
  });

  it("شِمای نامعتبر/ناشناخته در env ⇒ USAGE بی‌اتصال به پایگاه", async () => {
    const r = rig();
    const a = await r.run(["status"], r.env({ TOOL_POLICY_SCHEMA: "public" }));
    const b = await r.run(["status"], r.env({ TOOL_POLICY_SCHEMAA: "x" }));
    expect([a.exitCode, b.exitCode]).toEqual([2, 2]);
    expect(await r.schemaExists()).toBe(false);
  });

  it("دفترِ دست‌کاری‌شده (checksum) ⇒ status و up هر دو SCHEMA_MISMATCH(5) و هیچ تغییری نمی‌ماند", async () => {
    const r = rig();
    await r.run(["up", "--create-schema"]);
    await r.admin.query(`UPDATE "${r.schema}".tool_policy_migration_ledger SET checksum = 'tampered'`);
    const s = await r.run(["status"]);
    const u = await r.run(["up", "--create-schema"]);
    expect([s.exitCode, u.exitCode]).toEqual([5, 5]);
    expect((await r.admin.query(`SELECT checksum FROM "${r.schema}".tool_policy_migration_ledger`)).rows[0].checksum).toBe("tampered");
  });

  it("پایگاهِ «از آینده» (مهاجرتِ ناشناخته) ⇒ SCHEMA_MISMATCH بی‌نوشتن", async () => {
    const r = rig();
    await r.run(["up", "--create-schema"]);
    await r.admin.query(`INSERT INTO "${r.schema}".tool_policy_migration_ledger (name, checksum) VALUES ('9999_future', 'x')`);
    const u = await r.run(["up"]);
    expect(u.exitCode).toBe(5);
    expect(await r.ledgerRows()).toBe(2);
  });

  it("تریگرِ فقط‌افزودنیِ خاموش ⇒ SCHEMA_MISMATCH؛ up آن را «درست» نمی‌کند و خاموش می‌ماند", async () => {
    const r = rig();
    await r.run(["up", "--create-schema"]);
    await r.admin.query(`ALTER TABLE "${r.schema}".tool_policy_versions DISABLE TRIGGER tool_policy_versions_immutable`);
    const s = await r.run(["status"]);
    expect([s.exitCode, s.report.state?.problemCount]).toEqual([5, 1]);
    const u = await r.run(["up"]);
    expect(u.exitCode).toBe(5);
    expect(u.report.phase).toBe("check");
    const t = await r.admin.query(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'tool_policy_versions_immutable' AND tgrelid = '"${r.schema}".tool_policy_versions'::regclass`);
    expect(t.rows[0].tgenabled).toBe("D");
  });

  it("شکافِ نسخه‌ها (نسخه‌های ۱ و ۳؛ فقط تریگرِ زنجیره موقتاً خاموش بوده) ⇒ SCHEMA_MISMATCH در status و up؛ هیچ نوشتنی", async () => {
    const r = rig();
    await r.run(["up", "--create-schema"]);
    const t = `"${r.schema}".tool_policy_versions`;
    await r.admin.query(`ALTER TABLE ${t} DISABLE TRIGGER tool_policy_versions_chain`);
    for (const v of [1, 3]) {
      await r.admin.query(`INSERT INTO ${t} (version, overrides, policy, changes, source_kind, actor, reason, created_at_ms) VALUES ($1, '{}', '{}', '[]', 'set', 'tester', 'r', 0)`, [v]);
    }
    await r.admin.query(`ALTER TABLE ${t} ENABLE TRIGGER tool_policy_versions_chain`);
    const s = await r.run(["status"]);
    expect(s.exitCode).toBe(5);
    expect(s.report.state).toMatchObject({ rows: 2, latestVersion: 3, contiguous: false, problemCount: 0, pending: [] });
    const u = await r.run(["up"]);
    expect([u.exitCode, u.report.phase]).toEqual([5, "check"]);
    expect(await r.ledgerRows()).toBe(1);
  });

  it("چهار up --create-schema هم‌زمان روی شِمای تازه: همه OK، دقیقاً یک ردیفِ دفتر، دقیقاً یک نفر مهاجرت را اعمال کرده", async () => {
    const r = rig();
    const outs = await Promise.all([1, 2, 3, 4].map(() => r.run(["up", "--create-schema"])));
    expect(outs.map((o) => o.exitCode)).toEqual([0, 0, 0, 0]);
    expect(await r.ledgerRows()).toBe(1);
    const applied = outs.filter((o) => (o.report.state?.appliedNow.length ?? 0) > 0).length;
    expect(applied).toBe(1);
    for (const o of outs) expect(o.lines.join("")).not.toContain(CANARY);
    const s = await r.run(["status"]);
    expect(s.exitCode).toBe(0);
  });

  it("پایگاهِ در دسترس‌نبود ⇒ UNAVAILABLE(4) بی‌نشتِ رشتهٔ اتصال", async () => {
    const r = rig();
    const bad = ["postgres", "://nobody:", CANARY, "@127.0.0.1:1/none"].join("");
    const out = await r.run(["status"], r.env({}, bad));
    expect(out.exitCode).toBe(4);
    expect(out.lines.join("")).not.toContain(CANARY);
  });

  it("نقشِ مهاجرتِ بی‌امتیاز: بدونِ CREATE روی پایگاه، --create-schema ⇒ 6 با 42501؛ با شِمای ساخته‌شدهٔ مدیر و فقط حقِ شِما، up ⇒ OK", async () => {
    const r = rig();
    const me = (await r.admin.query("SELECT rolsuper OR rolcreaterole AS can FROM pg_roles WHERE rolname = current_user")).rows[0].can as boolean;
    if (!me) {
      // کاربرِ آزمون نمی‌تواند نقش بسازد (نه در CI: postgres/superuser)؛ فقط همین شاخه، آن هم صریح، بی‌ادعا.
      expect(me).toBe(false);
      return;
    }
    const role = `tpm_role_${randomBytes(4).toString("hex")}`;
    const pass = randomBytes(8).toString("hex");
    await r.admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${pass}'`);
    cleanups.push(async () => {
      const p = new Pool({ connectionString: DB_URL, max: 1, idleTimeoutMillis: IDLE_MS });
      try {
        await p.query(`DROP OWNED BY "${role}"`);
        await p.query(`DROP ROLE IF EXISTS "${role}"`);
      } finally {
        await p.end();
      }
    });
    const url = new URL(DB_URL as string);
    url.username = role;
    url.password = pass;
    const asRole = r.env({}, url.toString());

    const denied = await r.run(["up", "--create-schema"], asRole);
    expect(denied.exitCode).toBe(6);
    expect(denied.report).toMatchObject({ code: "MIGRATION_FAILED", phase: "schema", pgCode: "42501" });
    expect(await r.schemaExists()).toBe(false);

    const noFlag = await r.run(["up"], asRole);
    expect(noFlag.exitCode).toBe(8);

    await r.admin.query(`CREATE SCHEMA "${r.schema}" AUTHORIZATION "${role}"`);
    const ok = await r.run(["up"], asRole);
    expect(ok.exitCode).toBe(0);
    expect(ok.report.state?.ready).toBe(true);
    const st = await r.run(["status"], asRole);
    expect(st.exitCode).toBe(0);
  });
});
