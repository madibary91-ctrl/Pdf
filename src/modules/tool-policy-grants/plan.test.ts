import { describe, expect, it } from "vitest";
import { CONTRACT_TABLES, RUNTIME_CONTRACT, TABLE_PRIVILEGES, parseRole, parseSchema } from "./contract";
import { assessObjects, assessRole, planStatements, RELATIONS_SQL, ROLE_SQL, SCHEMA_SQL, serverTimeoutMs } from "./plan";
import { relationRows, safeRole, schemaRows } from "./test-kit";

describe("tool-policy-grants · قرارداد", () => {
  it("قرارداد دقیقاً همین است (قفلِ کمترین امتیاز): USAGE؛ SELECT+INSERT؛ فقط SELECT", () => {
    expect(RUNTIME_CONTRACT.schema).toEqual(["USAGE"]);
    expect(RUNTIME_CONTRACT.tables).toEqual({ tool_policy_versions: ["SELECT", "INSERT"], tool_policy_migration_ledger: ["SELECT"] });
    expect([...CONTRACT_TABLES]).toEqual(["tool_policy_versions", "tool_policy_migration_ledger"]);
    for (const t of CONTRACT_TABLES) for (const p of ["UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) expect(RUNTIME_CONTRACT.tables[t]).not.toContain(p);
    expect(Object.isFrozen(RUNTIME_CONTRACT)).toBe(true);
    expect(Object.isFrozen(RUNTIME_CONTRACT.tables)).toBe(true);
    expect(Object.isFrozen(RUNTIME_CONTRACT.tables.tool_policy_versions)).toBe(true);
  });

  it("parseRole/parseSchema: فهرست‌سفیدِ سخت‌گیرانه", () => {
    expect(parseRole("policy_runtime")).toEqual({ ok: true, value: "policy_runtime" });
    for (const v of [undefined, null, 5, {}, "", "Aa", "a b", "postgres", "public", "pg_monitor", "none", "x".repeat(64)]) expect(parseRole(v).ok, String(v)).toBe(false);
    expect(parseSchema("tool_policy").ok).toBe(true);
    for (const v of [undefined, "public", "information_schema", "pg_temp", "A", "x".repeat(41)]) expect(parseSchema(v).ok, String(v)).toBe(false);
  });
});

describe("tool-policy-grants · planStatements", () => {
  it("فهرستِ دقیق و ترتیبِ ثابت: قفل ← REVOKE ALL (شِما، جدول‌ها، دنباله‌ها) ← GRANTِ قرارداد", () => {
    expect(planStatements("tp", "rt", 60_000)).toEqual([
      "SET LOCAL lock_timeout = 30000",
      "SET LOCAL statement_timeout = 30000",
      "SELECT pg_advisory_xact_lock(hashtextextended('tool-policy-grants:apply:tp', 0))",
      'REVOKE ALL ON SCHEMA "tp" FROM "rt"',
      'REVOKE ALL ON ALL TABLES IN SCHEMA "tp" FROM "rt"',
      'REVOKE ALL ON ALL SEQUENCES IN SCHEMA "tp" FROM "rt"',
      'GRANT USAGE ON SCHEMA "tp" TO "rt"',
      'GRANT SELECT, INSERT ON TABLE "tp"."tool_policy_versions" TO "rt"',
      'GRANT SELECT ON TABLE "tp"."tool_policy_migration_ledger" TO "rt"',
    ]);
  });

  it("سقفِ سمتِ سرور: نیمِ مهلت با کفِ ۵۰۰؛ مهلتِ نامعتبر ⇒ پیش‌فرضِ ۶۰٬۰۰۰", () => {
    expect(serverTimeoutMs(60_000)).toBe(30_000);
    expect(serverTimeoutMs(1_000)).toBe(500);
    expect(serverTimeoutMs(1)).toBe(500);
    expect(serverTimeoutMs(600_000)).toBe(300_000);
    expect(planStatements("tp", "rt", 1000)[0]).toBe("SET LOCAL lock_timeout = 500");
    for (const bad of [Number.NaN, -1, 0, 1.5, Infinity]) expect(planStatements("tp", "rt", bad)[0], String(bad)).toBe("SET LOCAL lock_timeout = 30000");
  });

  it("ویژگی: برای ۵۰۰ (شِما، نقش)ِ معتبر، هر دستور از فهرستِ سفیدِ الگوها است؛ هیچ GRANT بیش از قرارداد، CREATE، DROP، ALTER، PUBLIC یا WITH GRANT OPTION نیست", () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789_";
    let seed = 7;
    const rnd = (n: number): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const name = (max: number): string => "a" + Array.from({ length: rnd(max) }, () => alphabet[rnd(alphabet.length)]).join("");
    const patterns = [
      /^SET LOCAL (lock|statement)_timeout = \d+$/,
      /^SELECT pg_advisory_xact_lock\(hashtextextended\('tool-policy-grants:apply:[a-z0-9_]+', 0\)\)$/,
      /^REVOKE ALL ON SCHEMA "[a-z0-9_]+" FROM "[a-z0-9_]+"$/,
      /^REVOKE ALL ON ALL (TABLES|SEQUENCES) IN SCHEMA "[a-z0-9_]+" FROM "[a-z0-9_]+"$/,
      /^GRANT USAGE ON SCHEMA "[a-z0-9_]+" TO "[a-z0-9_]+"$/,
      /^GRANT SELECT, INSERT ON TABLE "[a-z0-9_]+"\."tool_policy_versions" TO "[a-z0-9_]+"$/,
      /^GRANT SELECT ON TABLE "[a-z0-9_]+"\."tool_policy_migration_ledger" TO "[a-z0-9_]+"$/,
    ];
    let checked = 0;
    for (let i = 0; i < 500; i++) {
      const schema = name(39);
      const role = name(62);
      if (!parseSchema(schema).ok || !parseRole(role).ok) continue;
      const stmts = planStatements(schema, role, 1000 + rnd(599_000));
      expect(stmts).toHaveLength(9);
      for (const s of stmts) {
        expect(patterns.some((p) => p.test(s)), s).toBe(true);
        expect(s).not.toMatch(/\b(CREATE|DROP|ALTER|PUBLIC|OPTION|ALL PRIVILEGES|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)\b/);
        if (s.startsWith("GRANT")) expect(s).not.toMatch(/ALL\b/);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(400);
  });

  it("پرس‌وجوهای سنجش فقط SELECT‌اند، تک‌دستورند و نقش را با ::name می‌گیرند (پارامترِ پیوندی، نه الحاق)", () => {
    for (const text of [ROLE_SQL, SCHEMA_SQL, RELATIONS_SQL]) {
      expect(text).toMatch(/^SELECT /);
      expect(text).not.toContain(";");
      expect(text.replace(/'[^']*'/g, "''")).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|DROP|ALTER|GRANT|REVOKE)\b/); // نامِ حق‌ها فقط به‌صورتِ literal
      expect(text).toContain("$1::name");
    }
    expect(SCHEMA_SQL).toContain("$2::name");
    expect(RELATIONS_SQL).toContain("$2::name");
    expect(ROLE_SQL).not.toContain("$2");
    for (const p of TABLE_PRIVILEGES) expect(RELATIONS_SQL).toContain(`'${p}'`);
  });
});

describe("tool-policy-grants · assessRole", () => {
  it("نقشِ امن ⇒ []؛ نبودن ⇒ role_missing؛ هر امتیازِ خطرناک یک یافته", () => {
    expect(assessRole({ rows: [safeRole] })).toEqual([]);
    expect(assessRole({ rows: [] })).toEqual(["role_missing"]);
    expect(assessRole({ rows: [{ ...safeRole, super: true, createdb: true, replication: true }] })).toEqual(["role_superuser", "role_createdb", "role_replication"]);
    for (const [k, f] of [["createrole", "role_createrole"], ["bypassrls", "role_bypassrls"]] as const) expect(assessRole({ rows: [{ ...safeRole, [k]: true }] })).toEqual([f]);
  });

  it("پاسخِ بدشکل ⇒ null (هرگز «امن» نیست)", () => {
    const { super: _s, ...noSuper } = safeRole;
    void _s;
    for (const v of [undefined, null, 5, "x", {}, { rows: "no" }, { rows: [safeRole, safeRole] }, { rows: [5] }, { rows: [null] }, { rows: [noSuper] }, { rows: [{ ...safeRole, super: "f" }] }, { rows: [{ ...safeRole, super: 0 }] }, { rows: [{ ...safeRole, replication: null }] }]) {
      expect(assessRole(v), JSON.stringify(v)).toBeNull();
    }
  });
});

describe("tool-policy-grants · assessObjects", () => {
  const ass = (schema: unknown, rel: unknown) => assessObjects({ rows: schema }, { rows: rel });
  const clean = { pending: [], owner: [], drift: [] };

  it("دقیقاً قرارداد ⇒ بی‌یافته", () => {
    expect(ass(schemaRows(), relationRows())).toEqual(clean);
  });

  it("هر حقِ کم ⇒ missing، هر حقِ زیاد ⇒ excess (به ترتیبِ شِما، سپس جدول‌ها)", () => {
    expect(ass(schemaRows([]), relationRows({ tool_policy_versions: ["SELECT"], tool_policy_migration_ledger: [] }))).toEqual({
      ...clean,
      drift: ["missing:schema:USAGE", "missing:tool_policy_versions:INSERT", "missing:tool_policy_migration_ledger:SELECT"],
    });
    expect(ass(schemaRows(["USAGE", "CREATE"]), relationRows({ tool_policy_versions: ["SELECT", "INSERT", "UPDATE", "TRIGGER"], tool_policy_migration_ledger: ["SELECT", "TRUNCATE"] }))).toEqual({
      ...clean,
      drift: ["excess:schema:CREATE", "excess:tool_policy_versions:UPDATE", "excess:tool_policy_versions:TRIGGER", "excess:tool_policy_migration_ledger:TRUNCATE"],
    });
  });

  it("مالک (شِما یا جدول) جدا از drift گزارش می‌شود", () => {
    expect(ass(schemaRows(["USAGE"], true), relationRows())).toEqual({ ...clean, owner: ["owner:schema"] });
    expect(ass(schemaRows(), relationRows(undefined, { owner: ["tool_policy_migration_ledger"] }))).toEqual({ ...clean, owner: ["owner:tool_policy_migration_ledger"] });
  });

  it("شِمای ناموجود ⇒ pending=schema_missing؛ جدولِ ناموجود/غیرجدول ⇒ relation_missing", () => {
    expect(ass([], [])).toEqual({ ...clean, pending: ["schema_missing"] });
    expect(ass(schemaRows(), relationRows({ tool_policy_versions: ["SELECT", "INSERT"] }))).toEqual({ ...clean, pending: ["relation_missing:tool_policy_migration_ledger"] });
    expect(ass(schemaRows(), [])).toEqual({ ...clean, pending: ["relation_missing:tool_policy_versions", "relation_missing:tool_policy_migration_ledger"] });
    const asView = relationRows(undefined, { kinds: { tool_policy_versions: "v" } });
    expect(ass(schemaRows(), asView)?.pending).toEqual(["relation_missing:tool_policy_versions"]);
  });

  it("رابطهٔ ناشناخته: فقط با حق/مالکیت یک یافتهٔ بی‌نام؛ بی‌حق ⇒ هیچ", () => {
    const base = Object.fromEntries(CONTRACT_TABLES.map((t) => [t, [...RUNTIME_CONTRACT.tables[t]]]));
    expect(ass(schemaRows(), relationRows({ ...base, secret_t: [] }))).toEqual(clean);
    expect(ass(schemaRows(), relationRows({ ...base, secret_t: ["SELECT"], other_t: ["UPDATE"] }))).toEqual({ ...clean, drift: ["unexpected_relation_access"] });
    expect(ass(schemaRows(), relationRows({ ...base, secret_t: [] }, { owner: ["secret_t"] }))).toEqual({ ...clean, drift: ["unexpected_relation_access"] });
    expect(JSON.stringify(ass(schemaRows(), relationRows({ ...base, secret_t: ["SELECT"] })))).not.toContain("secret_t");
  });

  it("پاسخِ بدشکل ⇒ null: بی‌rows، ردیفِ تکراری/ناقص، حقِ ناشناخته، نوعِ غلط، شِمای ناموجود با رابطهٔ موجود", () => {
    const rel = relationRows();
    const sch = schemaRows();
    expect(assessObjects(undefined, { rows: rel })).toBeNull();
    expect(assessObjects({ rows: sch }, null)).toBeNull();
    expect(ass(sch, rel.slice(1))).toBeNull(); // یک حقِ ازقلم‌افتاده
    expect(ass(sch, [...rel, rel[0]])).toBeNull(); // تکراری
    expect(ass(sch.slice(1), rel)).toBeNull();
    expect(ass([...sch, sch[0]], rel)).toBeNull();
    expect(ass(sch, rel.map((r, i) => (i === 0 ? { ...r, privilege: "MAINTAIN" } : r)))).toBeNull();
    expect(ass(sch, rel.map((r, i) => (i === 0 ? { ...r, granted: "t" } : r)))).toBeNull();
    expect(ass(sch, rel.map((r, i) => (i === 0 ? { ...r, owner: 1 } : r)))).toBeNull();
    expect(ass(sch, rel.map((r, i) => (i === 0 ? { ...r, relation: "" } : r)))).toBeNull();
    expect(ass(sch.map((r, i) => (i === 0 ? { ...r, granted: null } : r)), rel)).toBeNull();
    expect(ass(sch, rel.map((r, i) => (i === 1 ? { ...r, owner: true } : r)))).toBeNull(); // مالکِ ناسازگار در یک رابطه
    expect(ass([], rel)).toBeNull();
    expect(ass(sch, ["x"])).toBeNull();
  });
});
