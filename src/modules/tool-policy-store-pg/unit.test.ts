import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createPgPolicyVersionStore, STORE_LIMITS, TOOL_POLICY_DEFAULT_SCHEMA } from "./index";
import { findPgError, mapDbError, PolicyPgError, toStoreCode } from "./errors";
import { EXPECTED_CONSTRAINTS, EXPECTED_TRIGGERS, MIGRATIONS, migrationChecksum, renderStatement } from "./migrations";
import { reconcile } from "./migrate";
import { parseSchemaName, regclassName } from "./naming";
import { rowToRecord } from "./rows";
import type { PolicyPgDatabase, PolicyPgExecutor } from "./types";

const dialect = new PgDialect();
const render = (q: SQL): { text: string; params: unknown[] } => {
  const r = dialect.sqlToQuery(q);
  return { text: r.sql, params: r.params };
};

const POLICY = { timing: { graceMs: 90_000 }, model: { timeoutMs: 30_000 } };
const goodRow = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: "2",
  overrides: { timing: { graceMs: 60_000 } },
  policy: POLICY,
  changes: [{ path: "timing.graceMs", from: 90_000, to: 60_000 }],
  source_kind: "set",
  source_to_version: null,
  actor: "admin:alice",
  reason: "دلیل آزمون",
  created_at_ms: "1700000000000",
  ...extra,
});

/** پایگاهِ ساختگی: همهٔ دستورها و تنظیمِ تراکنش ثبت می‌شود؛ `script` پاسخ یا پرتاب می‌دهد. */
function fakeDb(script: (i: number, text: string, params: unknown[]) => { rows: Record<string, unknown>[] } | Error) {
  const log: { text: string; params: unknown[] }[] = [];
  const configs: unknown[] = [];
  let txCount = 0;
  const ex: PolicyPgExecutor = {
    execute: async (q) => {
      const r = render(q);
      log.push(r);
      const out = script(log.length - 1, r.text, r.params);
      if (out instanceof Error) throw out;
      return out;
    },
  };
  const db: PolicyPgDatabase = {
    execute: ex.execute,
    transaction: async (run, config) => {
      txCount++;
      configs.push(config);
      return run(ex);
    },
  };
  return { db, log, configs, txCount: () => txCount };
}
const pgErr = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error("SECRET-pg-text password=hunter2 SELECT * FROM"), { code, ...extra });
const ledgerOk = [{ name: "0001_init", checksum: migrationChecksum(MIGRATIONS[0]!) }];

describe("tool-policy-store-pg · نام شِما", () => {
  it.each(["tool_policy", "a", "x9_y", "a".repeat(40)])("%s معتبر است", (s) => expect(parseSchemaName(s)).toEqual({ ok: true, value: s }));
  it.each(["", "Public", "public", "information_schema", "pg_catalog", "pg_x", "1abc", "a-b", "a b", "a;b", 'a"b', "a".repeat(41), "ش", "a.b"])("%j نامعتبر است", (s) => {
    const r = parseSchemaName(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
  });
  it.each([null, undefined, 1, {}, ["a"]])("نوعِ غیررشته (%j) نامعتبر است", (v) => expect(parseSchemaName(v).ok).toBe(false));
  it("regclassName نقل‌قول‌شده است", () => expect(regclassName("tool_policy", "tool_policy_versions")).toBe('"tool_policy".tool_policy_versions'));
});

describe("tool-policy-store-pg · ساخت و گزینه‌ها", () => {
  const { db } = fakeDb(() => ({ rows: [] }));
  it("پیش‌فرض: شِمای tool_policy", () => {
    const r = createPgPolicyVersionStore(db);
    expect(r.ok && r.value.schema).toBe(TOOL_POLICY_DEFAULT_SCHEMA);
    expect(TOOL_POLICY_DEFAULT_SCHEMA).toBe("tool_policy");
  });
  it("شِمای نامعتبر INVALID_INPUT", () => {
    const r = createPgPolicyVersionStore(db, { schema: "public" });
    expect(r.ok).toBe(false);
  });
  it.each([0, 99, 60_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY, -5])("statementTimeoutMs=%s رد می‌شود", (v) => {
    const r = createPgPolicyVersionStore(db, { statementTimeoutMs: v });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
  });
  it.each([STORE_LIMITS.minTimeoutMs, 5000, STORE_LIMITS.maxTimeoutMs])("statementTimeoutMs=%i پذیرفته می‌شود", (v) => expect(createPgPolicyVersionStore(db, { statementTimeoutMs: v }).ok).toBe(true));
  it("شیءِ برگشتی یخ‌زده است و چهار متدِ پورت + migrate/status را دارد", () => {
    const r = createPgPolicyVersionStore(db);
    if (!r.ok) throw new Error("x");
    expect(Object.isFrozen(r.value)).toBe(true);
    for (const k of ["latest", "get", "append", "list", "migrate", "status"]) expect(typeof (r.value as unknown as Record<string, unknown>)[k], k).toBe("function");
  });
});

describe("tool-policy-store-pg · نگاشتِ خطا", () => {
  it.each([
    ["23000", "CONFLICT"],
    ["23505", "CONFLICT"],
    ["23514", "INVALID"],
    ["23502", "INVALID"],
    ["22P05", "INVALID"],
    ["22021", "INVALID"],
    ["57014", "UNAVAILABLE"],
    ["55P03", "UNAVAILABLE"],
    ["53300", "UNAVAILABLE"],
    ["42P01", "UNAVAILABLE"],
    ["08006", "UNAVAILABLE"],
  ])("SQLSTATE %s ⇒ %s", (code, want) => expect(toStoreCode(pgErr(code))).toBe(want));

  it("خطای pg داخلِ cause (درایور drizzle) هم پیدا می‌شود", () => {
    const wrapped = Object.assign(new Error("Failed query: INSERT … params: …"), { cause: pgErr("23505", { constraint: "tool_policy_versions_pk" }) });
    expect(findPgError(wrapped)).toEqual({ code: "23505", constraint: "tool_policy_versions_pk" });
    expect(toStoreCode(wrapped)).toBe("CONFLICT");
  });
  it("چرخهٔ cause بی‌نهایت حلقه نمی‌زند", () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(findPgError(a)).toBeNull();
    expect(toStoreCode(a)).toBe("UNAVAILABLE");
  });
  it.each([null, undefined, "boom", 42, {}, { code: "econnrefused" }, { code: "ECONNREFUSED" }])("خطای نامعلوم (%j) ⇒ UNAVAILABLE", (e) => expect(toStoreCode(e)).toBe("UNAVAILABLE"));
  it("ردیفِ خراب INVALID؛ سایر خطاهای ماژول UNAVAILABLE", () => {
    expect(toStoreCode(new PolicyPgError({ code: "CORRUPT_DATA", message: "m" }))).toBe("INVALID");
    for (const code of ["NOT_MIGRATED", "MIGRATION_TAMPERED", "MIGRATION_UNKNOWN", "UNSAFE_SESSION", "DB_ERROR", "INVALID_INPUT"] as const) expect(toStoreCode(new PolicyPgError({ code, message: "m" })), code).toBe("UNAVAILABLE");
  });
  it("پیامِ mapDbError هرگز متنِ خطا، SQL یا رمز را نمی‌آورد", () => {
    const e = Object.assign(new Error("password=hunter2 INSERT INTO t VALUES ('secret')"), { code: "08006" });
    const m = mapDbError(e);
    expect(JSON.stringify(m)).not.toMatch(/hunter2|INSERT|secret/);
    expect(m).toMatchObject({ code: "DB_ERROR", pgCode: "08006" });
    expect(mapDbError(new Error("x"))).toMatchObject({ code: "DB_ERROR" });
    expect(mapDbError(pgErr("42P01")).code).toBe("NOT_MIGRATED");
    expect(mapDbError(pgErr("3F000")).code).toBe("NOT_MIGRATED");
  });
});

describe("tool-policy-store-pg · ردیف ← رکورد", () => {
  it("ردیفِ معتبر؛ bigintها رشته‌اند و عدد می‌شوند", () => {
    const r = rowToRecord(goodRow());
    expect(r).toMatchObject({ version: 2, createdAtMs: 1_700_000_000_000, source: { kind: "set" }, actor: "admin:alice" });
    expect(Object.isFrozen(r)).toBe(true);
  });
  it("rollback با toVersion", () => {
    expect(rowToRecord(goodRow({ version: "5", source_kind: "rollback", source_to_version: "3" })).source).toEqual({ kind: "rollback", toVersion: 3 });
  });
  it.each([
    ["set با toVersion", { source_to_version: "1" }],
    ["rollback بی‌toVersion", { source_kind: "rollback" }],
    ["منبعِ ناشناخته", { source_kind: "merge" }],
    ["rollback به آینده", { source_kind: "rollback", source_to_version: "3" }],
    ["version عدد (نه رشته)", { version: 2 }],
    ["version منفی", { version: "-1" }],
    ["version صفر", { version: "0" }],
    ["version اعشاری", { version: "1.5" }],
    ["version ناایمن", { version: "9007199254740993" }],
    ["version خیلی بلند", { version: "12345678901234567" }],
    ["زمانِ ناایمن", { created_at_ms: "9007199254740993" }],
    ["actor بد", { actor: "x y" }],
    ["reason کنترلی", { reason: "الف\u202Eب" }],
    ["policy غیرِ بخش‌بندی", { policy: { a: 1 } }],
    ["overrides آرایه", { overrides: [] }],
    ["overrides با __proto__", { overrides: JSON.parse('{"__proto__":{"x":1}}') }],
    ["changes غیرآرایه", { changes: {} }],
    ["ستونِ اضافه‌ایِ سیاست", { policy: { timing: { a: [1] } } }],
  ])("ردیفِ خراب: %s ⇒ CORRUPT_DATA", (_n, extra) => {
    expect(() => rowToRecord(goodRow(extra as Record<string, unknown>))).toThrow(PolicyPgError);
    try {
      rowToRecord(goodRow(extra as Record<string, unknown>));
    } catch (e) {
      expect((e as PolicyPgError).error.code).toBe("CORRUPT_DATA");
    }
  });
  it.each([undefined, null, 1, "x"])("ردیفِ غیرِ شیء (%j)", (v) => expect(() => rowToRecord(v as never)).toThrow(PolicyPgError));
});

describe("tool-policy-store-pg · مهاجرت‌ها (ایستا)", () => {
  it("checksumِ 0001_init قفل است (ویرایشِ مهاجرتِ اعمال‌شده ممنوع؛ مهاجرتِ تازه بسازید)", () => {
    expect(migrationChecksum(MIGRATIONS[0]!)).toBe("59b6dbf80a951a7afa1c683d1d9b0342a5053f5f34975e6ab80fee852fa8f5cf");
  });
  it("فهرستِ مهاجرت‌ها: نامِ یکتا، پیشوندِ شماره‌دار و مرتب", () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(names);
    for (const n of names) expect(n).toMatch(/^[0-9]{4}_[a-z0-9_]+$/);
  });
  it("هیچ CREATE SCHEMA و هیچ DROP در مهاجرت‌ها نیست؛ هر نامِ شیء با {{schema}} می‌آید", () => {
    for (const m of MIGRATIONS) for (const s of m.statements) {
      expect(s).not.toMatch(/CREATE\s+SCHEMA/i);
      expect(s).not.toMatch(/\bDROP\b/i);
      expect(s).toContain("{{schema}}");
    }
  });
  it("EXPECTED_TRIGGERS و EXPECTED_CONSTRAINTS دقیقاً همان‌هایی‌اند که مهاجرت می‌سازد", () => {
    const sqlText = MIGRATIONS.flatMap((m) => m.statements).join("\n");
    const triggers = [...sqlText.matchAll(/CREATE TRIGGER (\w+)/g)].map((m) => m[1]);
    const constraints = [...sqlText.matchAll(/CONSTRAINT (\w+)/g)].map((m) => m[1]);
    expect([...triggers].sort()).toEqual([...EXPECTED_TRIGGERS].sort());
    expect([...constraints].sort()).toEqual([...EXPECTED_CONSTRAINTS].sort());
  });
  it("renderStatement فقط {{schema}} را با نامِ نقل‌قول‌شده جایگزین می‌کند", () => {
    expect(renderStatement("A {{schema}}.t B {{schema}}.u", "tp")).toBe('A "tp".t B "tp".u');
  });
});

describe("tool-policy-store-pg · reconcile", () => {
  const m = MIGRATIONS[0]!;
  it("دفترِ خالی ⇒ همه معلق؛ دفترِ کامل ⇒ همه اعمال‌شده", () => {
    expect(reconcile([])).toEqual({ applied: [], pending: [m.name] });
    expect(reconcile(ledgerOk)).toEqual({ applied: [m.name], pending: [] });
  });
  it("checksum ناهمخوان ⇒ MIGRATION_TAMPERED", () => {
    expect(() => reconcile([{ name: m.name, checksum: "x" }])).toThrow(PolicyPgError);
    try {
      reconcile([{ name: m.name, checksum: "x" }]);
    } catch (e) {
      expect((e as PolicyPgError).error.code).toBe("MIGRATION_TAMPERED");
    }
  });
  it("مهاجرتِ ناشناخته (پایگاهِ از آینده) ⇒ MIGRATION_UNKNOWN", () => {
    try {
      reconcile([...ledgerOk, { name: "0002_future", checksum: "y" }]);
      throw new Error("باید می‌پرید");
    } catch (e) {
      expect((e as PolicyPgError).error.code).toBe("MIGRATION_UNKNOWN");
    }
  });
  it("حفره ⇒ MIGRATION_TAMPERED (مهاجرتِ دوم بی‌اولی)", () => {
    const two = [{ name: "0001_a", statements: ["x"] }, { name: "0002_b", statements: ["y"] }] as const;
    try {
      reconcile([{ name: "0002_b", checksum: migrationChecksum(two[1]) }], two);
      throw new Error("باید می‌پرید");
    } catch (e) {
      expect((e as PolicyPgError).error.code).toBe("MIGRATION_TAMPERED");
    }
  });
});

describe("tool-policy-store-pg · رفتارِ آداپتور با پایگاهِ ساختگی", () => {
  const mk = (script: Parameters<typeof fakeDb>[0], options = {}) => {
    const f = fakeDb(script);
    const made = createPgPolicyVersionStore(f.db, { schema: "tp", ...options });
    if (!made.ok) throw new Error("make");
    return { ...f, store: made.value };
  };
  const rec = (v: number) => ({ version: v, overrides: {}, policy: POLICY as never, changes: [], source: { kind: "set" as const }, actor: "admin:alice", reason: "دلیل", createdAtMs: 1000 + v });

  it("ورودیِ نامعتبر هرگز به پایگاه نمی‌رسد (حتی تراکنش باز نمی‌شود)", async () => {
    const t = mk(() => ({ rows: [] }));
    expect(await t.store.get(0)).toEqual({ ok: false, error: { code: "INVALID" } });
    expect(await t.store.get(Number.NaN)).toEqual({ ok: false, error: { code: "INVALID" } });
    expect(await t.store.list({ beforeVersion: null, limit: 0 })).toEqual({ ok: false, error: { code: "INVALID" } });
    expect(await t.store.list({ beforeVersion: 0, limit: 1 })).toEqual({ ok: false, error: { code: "INVALID" } });
    expect(await t.store.list({ beforeVersion: null, limit: STORE_LIMITS.maxListLimit + 1 })).toEqual({ ok: false, error: { code: "INVALID" } });
    expect(await t.store.append({ ...rec(1), actor: "x y" } as never)).toEqual({ ok: false, error: { code: "INVALID" } });
    expect(await t.store.append(null as never)).toEqual({ ok: false, error: { code: "INVALID" } });
    expect(t.txCount()).toBe(0);
  });

  it("هر عملیات: تنظیمِ مهلت ← بررسیِ مهاجرت ← (نوشتن: بررسیِ نگهبان) ← دستور؛ خواندن read only، نوشتن read write", async () => {
    const t = mk((i) => (i === 1 ? { rows: ledgerOk } : i === 2 ? { rows: [{ role: "origin", active: "3" }] } : { rows: [{ version: "1" }] }), { statementTimeoutMs: 777 });
    const r = await t.store.append(rec(1));
    expect(r).toEqual({ ok: true, value: null });
    expect(t.configs).toEqual([{ accessMode: "read write" }]);
    expect(t.log[0]!.text).toContain("set_config('statement_timeout'");
    expect(t.log[0]!.params).toEqual(["777", "777"]);
    expect(t.log[1]!.text).toContain("tool_policy_migration_ledger");
    expect(t.log[2]!.text).toContain("session_replication_role");
    expect(t.log[3]!.text).toMatch(/^INSERT INTO "tp"\."tool_policy_versions"/);
    expect(t.log[3]!.text).toContain("ON CONFLICT (version) DO NOTHING");

    const t2 = mk((i) => (i === 1 ? { rows: ledgerOk } : { rows: [] }));
    expect(await t2.store.latest()).toEqual({ ok: true, value: null });
    expect(t2.configs).toEqual([{ accessMode: "read only" }]);
    expect(t2.log).toHaveLength(3);
  });

  it("همهٔ مقدارهای رکورد پارامترِ پیوندی‌اند؛ متنِ SQL هرگز محتوای کاربر را ندارد", async () => {
    const evilReason = "x'); DROP TABLE tool_policy_versions; --";
    const t = mk((i) => (i === 1 ? { rows: ledgerOk } : i === 2 ? { rows: [{ role: "origin", active: "3" }] } : { rows: [{ version: "1" }] }));
    await t.store.append({ ...rec(1), reason: evilReason });
    const ins = t.log[3]!;
    expect(ins.text).not.toContain("DROP");
    expect(ins.text).not.toContain("admin:alice");
    expect(ins.params).toContain(evilReason);
    expect(ins.params).toContain("admin:alice");
  });

  it("شکستِ pg ⇒ فقط کدِ ثابت؛ متنِ خطا، رمز و SQL در نتیجه نیست", async () => {
    const t = mk((i) => (i === 1 ? { rows: ledgerOk } : i === 2 ? { rows: [{ role: "origin", active: "3" }] } : pgErr("08006")));
    const r = await t.store.append(rec(1));
    expect(r).toEqual({ ok: false, error: { code: "UNAVAILABLE" } });
    expect(JSON.stringify(r)).not.toMatch(/hunter2|SECRET|SELECT/);
  });

  it("append: نبودنِ ردیفِ RETURNING (ON CONFLICT DO NOTHING) ⇒ CONFLICT؛ تریگرِ زنجیره (23000) ⇒ CONFLICT", async () => {
    const lost = mk((i) => (i === 1 ? { rows: ledgerOk } : i === 2 ? { rows: [{ role: "origin", active: "3" }] } : { rows: [] }));
    expect(await lost.store.append(rec(1))).toEqual({ ok: false, error: { code: "CONFLICT" } });
    const gap = mk((i) => (i === 1 ? { rows: ledgerOk } : i === 2 ? { rows: [{ role: "origin", active: "3" }] } : pgErr("23000")));
    expect(await gap.store.append(rec(3))).toEqual({ ok: false, error: { code: "CONFLICT" } });
  });

  it("نگهبانِ نوشتن: role≠origin یا تریگرِ کم ⇒ UNAVAILABLE و INSERT اجرا نمی‌شود", async () => {
    for (const guard of [{ role: "replica", active: "3" }, { role: "origin", active: "2" }, { role: "origin", active: 3 }, {}]) {
      const t = mk((i) => (i === 1 ? { rows: ledgerOk } : { rows: [guard] }));
      expect(await t.store.append(rec(1))).toEqual({ ok: false, error: { code: "UNAVAILABLE" } });
      expect(t.log.some((q) => q.text.startsWith("INSERT"))).toBe(false);
    }
  });

  it("مهاجرتِ ناهمخوان یا معلق ⇒ UNAVAILABLE بی‌اجرای دستورِ اصلی", async () => {
    for (const ledger of [[], [{ name: "0001_init", checksum: "bad" }], [...ledgerOk, { name: "0009_x", checksum: "z" }]]) {
      const t = mk((i) => (i === 1 ? { rows: ledger } : { rows: [] }));
      expect(await t.store.latest()).toEqual({ ok: false, error: { code: "UNAVAILABLE" } });
      expect(t.log).toHaveLength(2);
    }
  });

  it("پاسخِ بدشکلِ دفتر ⇒ UNAVAILABLE", async () => {
    const t = mk((i) => (i === 1 ? { rows: [{ name: 1, checksum: null }] } : { rows: [] }));
    expect(await t.store.latest()).toEqual({ ok: false, error: { code: "UNAVAILABLE" } });
  });

  it("ردیفِ خراب INVALID: latest، get (نسخهٔ دیگر)، get (چند ردیف) و list (ترتیبِ غلط/بیش از limit)", async () => {
    const r2 = goodRow();
    const r1 = goodRow({ version: "1" });
    const pick = (rows: Record<string, unknown>[]) => (i: number) => (i === 1 ? { rows: ledgerOk } : { rows });
    expect(await mk(pick([{ ...r2, actor: "x y" }])).store.latest()).toEqual({ ok: false, error: { code: "INVALID" } });
    expect(await mk(pick([r2])).store.get(1)).toEqual({ ok: false, error: { code: "INVALID" } });
    expect(await mk(pick([r2, r2])).store.get(2)).toEqual({ ok: false, error: { code: "INVALID" } });
    expect(await mk(pick([r1, r2])).store.list({ beforeVersion: null, limit: 5 })).toEqual({ ok: false, error: { code: "INVALID" } });
    expect(await mk(pick([r2, r2])).store.list({ beforeVersion: null, limit: 5 })).toEqual({ ok: false, error: { code: "INVALID" } });
    expect(await mk(pick([r2, r1])).store.list({ beforeVersion: null, limit: 1 })).toEqual({ ok: false, error: { code: "INVALID" } });
    expect(await mk(pick([r2])).store.list({ beforeVersion: 2, limit: 5 })).toEqual({ ok: false, error: { code: "INVALID" } });
    const good = await mk(pick([r2, r1])).store.list({ beforeVersion: null, limit: 5 });
    expect(good.ok && good.value.map((x) => x.version)).toEqual([2, 1]);
  });

  it("migrate/status خطا را به Result می‌دهند و هرگز نمی‌پرتابند", async () => {
    const t = mk(() => pgErr("08006"));
    const m = await t.store.migrate();
    expect(m.ok).toBe(false);
    expect(JSON.stringify(m)).not.toMatch(/hunter2|SECRET/);
    const s = await t.store.status();
    expect(s.ok).toBe(false);
  });

  it("migrate: شِمای ناموجود ⇒ NOT_MIGRATED و هیچ CREATE SCHEMA/جدولی اجرا نمی‌شود", async () => {
    const t = mk(() => ({ rows: [] }));
    const m = await t.store.migrate();
    expect(m).toMatchObject({ ok: false, error: { code: "NOT_MIGRATED" } });
    expect(t.log.some((q) => /CREATE/i.test(q.text))).toBe(false);
  });

  it("status: شِمای ناموجود = همه معلق و ready=false (خطا نیست)", async () => {
    const t = mk(() => ({ rows: [] }));
    expect(await t.store.status()).toEqual({ ok: true, value: { schemaExists: false, applied: [], pending: ["0001_init"], problems: [], rows: 0, latestVersion: null, contiguous: true, ready: false } });
  });
});
