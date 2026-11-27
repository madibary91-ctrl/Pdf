/**
 * CLIِ رسمی به‌صورت فرایندِ واقعی (ADR-0081): `npm run policy:grants` — همان مسیری که استقرار می‌زند — روی PostgreSQL واقعی.
 * چیزی که آزمونِ درون‌فرایندی نمی‌گیرد: حلقهٔ resolve (`@/` و پسوندِ `.ts`)، اجرای بومیِ TypeScript در Node، stdout یک‌خطی، stderr خالی (بی‌هشدار)،
 * کدِ خروجِ واقعیِ فرایند و `plan` بی‌`DATABASE_URL`. شِما/نقشِ یک‌بارمصرفِ `tpgp_<تصادفی>`؛ نقش‌ساختن فقط با اجازهٔ `CREATE ROLE` ادعا می‌شود.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import type { GrantsReport } from "@/modules/tool-policy-grants";
import { createPgPolicyVersionStore } from "@/modules/tool-policy-store-pg";

config({ quiet: true });
const DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const dbDescribe = typeof DB_URL === "string" && DB_URL !== "" ? describe : describe.skip;
const ROOT = join(__dirname, "..");
const IDLE_MS = 50;
type Run = Readonly<{ code: number | null; stdout: string; stderr: string; report: GrantsReport }>;

dbDescribe("tool-policy-grants · فرایندِ واقعی (npm run policy:grants)", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  async function rig() {
    const id = randomBytes(5).toString("hex");
    const schema = `tpgp_${id}`;
    const role = `tpgp_rt_${id}`;
    const admin = new Pool({ connectionString: DB_URL, max: 2, idleTimeoutMillis: IDLE_MS });
    cleanups.push(async () => {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      } finally {
        await admin.end();
      }
    });
    const me = (await admin.query("SELECT rolsuper OR rolcreaterole AS ok FROM pg_roles WHERE rolname = current_user")).rows[0] as { ok: boolean };
    if (me.ok) {
      await admin.query(`CREATE ROLE "${role}" NOLOGIN`);
      await admin.query(`CREATE SCHEMA "${schema}"`);
      const made = createPgPolicyVersionStore(drizzle(admin), { schema });
      if (!made.ok) throw new Error("store");
      const m = await made.value.migrate();
      if (!m.ok) throw new Error("migrate");
    }
    const env = (url: string | null = DB_URL ?? null, extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
      ({ PATH: process.env["PATH"], HOME: process.env["HOME"], ...(url === null ? {} : { DATABASE_URL: url }), TOOL_POLICY_SCHEMA: schema, ...extra }) as unknown as NodeJS.ProcessEnv;
    const run = (args: string[], e: NodeJS.ProcessEnv = env()): Run => {
      const r = spawnSync("npm", ["run", "-s", "policy:grants", "--", ...args], { cwd: ROOT, env: e, encoding: "utf8", timeout: 60_000 });
      const stdout = r.stdout ?? "";
      expect(stdout.endsWith("\n")).toBe(true);
      expect(stdout.trimEnd().split("\n")).toHaveLength(1); // دقیقاً یک خطِ JSON
      return { code: r.status, stdout, stderr: r.stderr ?? "", report: JSON.parse(stdout) as GrantsReport };
    };
    return { schema, role, admin, env, run, can: me.ok };
  }

  it("اسکریپتِ package.json همان فرمانِ مستند است و وابستگیِ تازه نیامده", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string>; dependencies: Record<string, string> };
    expect(pkg.scripts["policy:grants"]).toBe("node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./tooling/cli/register.mjs tooling/cli/tool-policy-grants.ts");
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@fontsource-variable/vazirmatn", "dotenv", "drizzle-orm", "next", "pg", "react", "react-dom", "vitest"]);
  });

  it("plan بی‌DATABASE_URL: ۰، یک خطِ JSON، stderr خالی؛ آرگومانِ بد ⇒ ۲ بی‌پژواکِ رشتهٔ اتصال", async () => {
    const r = await rig();
    const plan = r.run(["plan", "--role=policy_runtime"], r.env(null));
    expect([plan.code, plan.stderr]).toEqual([0, ""]);
    expect(plan.report).toMatchObject({ ok: true, command: "plan", role: "policy_runtime", schema: r.schema });
    expect(plan.report.statements).toHaveLength(9);
    const canary = `LEAK-CANARY-grants-proc-${randomBytes(3).toString("hex")}`;
    const usage = r.run(["verify", `postgres://u:${canary}@h/db`], r.env(null));
    expect([usage.code, usage.stderr]).toEqual([2, ""]);
    expect(usage.stdout).not.toContain(canary);
    const help = r.run(["--help"], r.env(null));
    expect(help.code).toBe(0);
  });

  it("چرخهٔ کامل: verify ⇒ ۵، apply ⇒ ۰، verify ⇒ ۰؛ نقشِ ناموجود ⇒ ۸؛ بی‌stderr", async () => {
    const r = await rig();
    if (!r.can) return;
    const a = r.run(["verify", `--role=${r.role}`]);
    expect([a.code, a.stderr, a.report.code]).toEqual([5, "", "DRIFT"]);
    const b = r.run(["apply", `--role=${r.role}`]);
    expect([b.code, b.stderr, b.report.wrote, b.report.closed]).toEqual([0, "", true, true]);
    const c = r.run(["verify", `--role=${r.role}`]);
    expect([c.code, c.report.findings]).toEqual([0, undefined]);
    const d = r.run(["apply", `--role=tpgp_none_${randomBytes(3).toString("hex")}`]);
    expect([d.code, d.report.findings]).toEqual([8, ["role_missing"]]);
    expect((await r.admin.query("SELECT has_table_privilege($1::name, $2::regclass, 'UPDATE') AS g", [r.role, `"${r.schema}".tool_policy_versions`])).rows[0].g).toBe(false);
  });

  it("پایگاهِ نیافتنی ⇒ ۴ و هیچ نشتی از رشتهٔ اتصال در stdout/stderr", async () => {
    const r = await rig();
    const canary = `LEAK-CANARY-grants-url-${randomBytes(3).toString("hex")}`;
    const url = ["postgres", "://user:", canary, "@127.0.0.1:1/db"].join("");
    const out = r.run(["verify", "--role=policy_runtime"], r.env(url));
    expect(out.code).toBe(4);
    expect(out.stdout + out.stderr).not.toContain(canary);
    expect(out.stderr).toBe("");
  });
});
