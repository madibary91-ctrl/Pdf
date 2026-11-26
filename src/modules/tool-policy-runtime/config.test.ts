import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { classifyStoreCode, createPgToolPolicyRuntime, effectiveStatementTimeoutMs, preflightOf } from "./pg-runtime";
import { SECRET, fakeTimer } from "./test-kit";

const TUNING = { intervalMs: 10_000, retryMs: 2_000, attemptDeadlineMs: 6_000, refreshTimeoutMs: 5_000, maxStaleMs: 30_000 };
const dialect = new PgDialect();

/** پایگاهِ ساختگی: هر execute را ثبت می‌کند (پارامترها با PgDialect) و می‌شکند؛ ساخت نباید هیچ‌کدام را صدا بزند. */
function fakeDb() {
  const calls: { sql: string; params: unknown[] }[] = [];
  let transactions = 0;
  const exec = async (q: SQL): Promise<{ rows: Record<string, unknown>[] }> => {
    const r = dialect.sqlToQuery(q);
    calls.push({ sql: r.sql, params: r.params });
    throw new Error(SECRET);
  };
  const db = {
    execute: exec,
    transaction: async <T>(run: (tx: { execute: typeof exec }) => Promise<T>): Promise<T> => {
      transactions += 1;
      return run({ execute: exec });
    },
  };
  return { db, calls, transactions: (): number => transactions };
}

const cfg = (over: Record<string, unknown> = {}) => ({ db: fakeDb().db, tuning: { ...TUNING }, timer: fakeTimer().timer, ...over });
const issues = (raw: unknown): readonly string[] => {
  const r = createPgToolPolicyRuntime(raw);
  if (r.ok) throw new Error("expected failure");
  return r.error.issues;
};

describe("tool-policy-runtime · پیکربندیِ PG", () => {
  it("پیکربندیِ درست ساخته می‌شود و ساخت هیچ پایگاه/زمان‌سنجی را صدا نمی‌زند", () => {
    const f = fakeDb();
    const ft = fakeTimer();
    const r = createPgToolPolicyRuntime({ db: f.db, tuning: TUNING, timer: ft.timer });
    expect(r.ok).toBe(true);
    expect(f.calls).toHaveLength(0);
    expect(f.transactions()).toBe(0);
    expect(ft.log).toHaveLength(0);
  });

  it("پیش‌فرض‌ها: ساعتِ یکنوا، ساعتِ دیواری و زمان‌سنجِ Node (ساخت بی‌گزینه‌های اختیاری)", () => {
    expect(createPgToolPolicyRuntime({ db: fakeDb().db, tuning: TUNING }).ok).toBe(true);
  });

  it("ورودیِ غیرشیء/آرایه/کلیدِ ناشناخته", () => {
    for (const v of [null, undefined, 1, "x", []]) expect(issues(v)).toEqual(["options"]);
    expect(issues(cfg({ extra: 1 }))).toContain("unknown:extra");
    expect(issues(cfg({ ["x".repeat(80)]: 1 }))).toContain("unknown:?");
  });

  it("db: باید execute و transaction داشته باشد", () => {
    expect(issues(cfg({ db: undefined }))).toContain("db");
    expect(issues(cfg({ db: { execute: () => 1 } }))).toContain("db");
    expect(issues(cfg({ db: { transaction: () => 1 } }))).toContain("db");
    expect(issues(cfg({ db: "pg" }))).toContain("db");
  });

  it("schema: غیررشته یا نامِ نامعتبر رد می‌شود (بی‌پژواکِ مقدار)", () => {
    expect(issues(cfg({ schema: 5 }))).toContain("schema");
    const bad = issues(cfg({ schema: 'x"; DROP TABLE users; --' }));
    expect(bad).toContain("schema");
    expect(JSON.stringify(bad)).not.toContain("DROP");
    expect(createPgToolPolicyRuntime(cfg({ schema: "my_policy" })).ok).toBe(true);
  });

  it("ساعت‌ها و زمان‌سنج: بی‌nowMs/after/cancel رد می‌شوند", () => {
    expect(issues(cfg({ clock: {} }))).toContain("clock");
    expect(issues(cfg({ wallClock: { nowMs: 1 } }))).toContain("wallClock");
    expect(issues(cfg({ timer: { after: () => 1 } }))).toContain("timer");
    expect(issues(cfg({ timer: null }))).toContain("timer");
  });

  it("tuning: نبودن، غیرشیء، کلیدِ ناشناخته و هر فیلدِ ناقص/نامعتبر (با پیشوندِ tuning)", () => {
    expect(issues(cfg({ tuning: undefined }))).toContain("tuning");
    expect(issues(cfg({ tuning: [] }))).toContain("tuning");
    expect(issues(cfg({ tuning: { ...TUNING, graceMs: 1 } }))).toContain("tuning.unknown:graceMs");
    for (const key of Object.keys(TUNING)) {
      const t: Record<string, unknown> = { ...TUNING };
      delete t[key];
      expect(issues(cfg({ tuning: t })), key).toContain(`tuning:${key}`);
      expect(issues(cfg({ tuning: { ...TUNING, [key]: "100" } })), key).toContain(`tuning:${key}`);
      expect(issues(cfg({ tuning: { ...TUNING, [key]: 1.5 } })), key).toContain(`tuning:${key}`);
    }
  });

  it("رابطهٔ تحمل در ساخت: interval + ۳·deadline + retry ≤ maxStale (مرزِ دقیق)", () => {
    expect(createPgToolPolicyRuntime(cfg({ tuning: { ...TUNING, maxStaleMs: 30_000 } })).ok).toBe(true);
    const r = issues(cfg({ tuning: { ...TUNING, maxStaleMs: 29_999 } }));
    expect(r.some((i) => i.startsWith("tuning:"))).toBe(true);
    expect(issues(cfg({ tuning: { ...TUNING, retryMs: 10_001 } })).some((i) => i.startsWith("tuning:"))).toBe(true);
    expect(issues(cfg({ tuning: { ...TUNING, refreshTimeoutMs: 6_001 } })).some((i) => i.startsWith("tuning:"))).toBe(true);
  });

  it("statementTimeoutMs: کرانِ ۱۰۰..۶۰٬۰۰۰ و رابطهٔ ≤ refreshTimeoutMs (مرزِ دقیق)", () => {
    expect(createPgToolPolicyRuntime(cfg({ statementTimeoutMs: 5_000 })).ok).toBe(true);
    expect(issues(cfg({ statementTimeoutMs: 5_001 }))).toContain("relation:statementTimeoutMs<=refreshTimeoutMs");
    for (const v of [99, 60_001, 1.5, "100", Number.NaN]) expect(issues(cfg({ statementTimeoutMs: v })), String(v)).toContain("statementTimeoutMs");
    expect(createPgToolPolicyRuntime(cfg({ statementTimeoutMs: 100 })).ok).toBe(true);
  });

  it("همهٔ مشکل‌ها یک‌جا گزارش می‌شوند و مقدارِ پیکربندی (رمزِ ساختگی) هرگز بازتاب نمی‌شود", () => {
    const r = createPgToolPolicyRuntime({ db: SECRET, tuning: { ...TUNING, intervalMs: SECRET }, schema: "Bad-Schema", clock: SECRET, timer: SECRET, wallClock: SECRET });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.issues).toEqual(expect.arrayContaining(["db", "schema", "clock", "wallClock", "timer", "tuning:intervalMs"]));
      expect(JSON.stringify(r)).not.toContain("s3cr3t");
    }
  });

  it("getterِ پرتاب‌کننده روی پیکربندی/tuning ⇒ شکستِ بسته بی‌نشت و بی‌استثنا", () => {
    const hostile = cfg();
    Object.defineProperty(hostile, "db", {
      enumerable: true,
      get() {
        throw new Error(SECRET);
      },
    });
    const r1 = createPgToolPolicyRuntime(hostile);
    expect(r1.ok).toBe(false);
    expect(JSON.stringify(r1)).not.toContain("s3cr3t");
    const t = { ...TUNING };
    Object.defineProperty(t, "retryMs", {
      enumerable: true,
      get() {
        throw new Error(SECRET);
      },
    });
    const r2 = createPgToolPolicyRuntime(cfg({ tuning: t }));
    expect(r2.ok).toBe(false);
    expect(JSON.stringify(r2)).not.toContain("s3cr3t");
  });

  it("هر کلیدِ tuning دقیقاً یک بار خوانده می‌شود (عددِ واحد برای منبع و حلقه؛ بی‌TOCTOU)", () => {
    const reads: Record<string, number> = {};
    const t: Record<string, number> = {};
    for (const [k, v] of Object.entries(TUNING)) {
      Object.defineProperty(t, k, {
        enumerable: true,
        get() {
          reads[k] = (reads[k] ?? 0) + 1;
          return v;
        },
      });
    }
    expect(createPgToolPolicyRuntime(cfg({ tuning: t })).ok).toBe(true);
    expect(reads).toEqual({ intervalMs: 1, retryMs: 1, attemptDeadlineMs: 1, refreshTimeoutMs: 1, maxStaleMs: 1 });
  });
});

describe("tool-policy-runtime · statementTimeout مؤثر و پیش‌بازرسیِ شکست‌خورده", () => {
  it("پیش‌فرض min(۵۰۰۰، refreshTimeoutMs)؛ صریح همان را می‌گیرد (سیم‌کشیِ واقعی در آزمونِ PG)", () => {
    expect(effectiveStatementTimeoutMs(undefined, 5_000)).toBe(5_000);
    expect(effectiveStatementTimeoutMs(undefined, 3_000)).toBe(3_000);
    expect(effectiveStatementTimeoutMs(undefined, 8_000)).toBe(5_000);
    expect(effectiveStatementTimeoutMs(undefined, 100)).toBe(100);
    expect(effectiveStatementTimeoutMs(undefined, 300_000)).toBe(5_000);
    expect(effectiveStatementTimeoutMs(1_234, 8_000)).toBe(1_234);
  });

  it("پایگاهِ خراب: start ⇒ UNAVAILABLE، حلقه راه نمی‌افتد، نگهبان لغو شده، بی‌نشت", async () => {
    const f = fakeDb();
    const ft = fakeTimer();
    const r = createPgToolPolicyRuntime({ db: f.db, tuning: TUNING, timer: ft.timer });
    if (!r.ok) throw new Error("config");
    const res = await r.value.start();
    expect(res).toEqual({ started: false, reason: "UNAVAILABLE" });
    expect(ft.pending()).toBe(0);
    expect(ft.log).toEqual([{ ms: 6_000, cancelled: true }]);
    expect(r.value.health()).toMatchObject({ state: "IDLE", ready: false, reason: "NOT_STARTED" });
    expect(JSON.stringify([res, r.value.health(), r.value.snapshot()])).not.toContain("s3cr3t");
    expect(r.value.snapshot()).toMatchObject({ ok: false, error: { code: "NOT_LOADED" } });
  });
});

describe("tool-policy-runtime · نگاشتِ پیش‌بازرسی (ورودیِ ناشناخته)", () => {
  const status = (over: Record<string, unknown> = {}) => ({ ok: true, value: { schemaExists: true, applied: ["001"], pending: [], problems: [], rows: 0, latestVersion: null, contiguous: true, ready: true, ...over } });
  const run = (v: unknown) => preflightOf({ status: () => Promise.resolve(v) });

  it("classifyStoreCode: جدولِ کدها؛ ناشناخته/prototype/غیررشته ⇒ UNAVAILABLE", () => {
    expect(classifyStoreCode("NOT_MIGRATED")).toBe("NOT_MIGRATED");
    for (const c of ["MIGRATION_TAMPERED", "MIGRATION_UNKNOWN", "CORRUPT_DATA", "UNSAFE_SESSION"]) expect(classifyStoreCode(c), c).toBe("SCHEMA_MISMATCH");
    for (const c of ["DB_ERROR", "INVALID_INPUT", "constructor", "toString", "", 5, null, undefined, {}]) expect(classifyStoreCode(c), String(c)).toBe("UNAVAILABLE");
  });

  it("سالم ⇒ ok؛ خطای ذخیره‌ساز با کد ⇒ نگاشتِ همان کد", async () => {
    expect(await run(status())).toEqual({ ok: true });
    expect(await run({ ok: false, error: { code: "NOT_MIGRATED" } })).toEqual({ ok: false, code: "NOT_MIGRATED" });
    expect(await run({ ok: false, error: { code: "MIGRATION_TAMPERED" } })).toEqual({ ok: false, code: "SCHEMA_MISMATCH" });
    expect(await run({ ok: false, error: { code: "UNSAFE_SESSION" } })).toEqual({ ok: false, code: "SCHEMA_MISMATCH" });
    expect(await run({ ok: false, error: { code: "DB_ERROR" } })).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(await run({ ok: false, error: {} })).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(await run({ ok: false })).toEqual({ ok: false, code: "UNAVAILABLE" });
  });

  it("شِمای ناموجود یا مهاجرتِ معلق ⇒ NOT_MIGRATED (حتی اگر ready=false هم باشد)", async () => {
    expect(await run(status({ schemaExists: false, ready: false }))).toEqual({ ok: false, code: "NOT_MIGRATED" });
    expect(await run(status({ pending: ["002"], ready: false }))).toEqual({ ok: false, code: "NOT_MIGRATED" });
    expect(await run(status({ pending: ["002"] }))).toEqual({ ok: false, code: "NOT_MIGRATED" });
  });

  it("مشکل، ناپیوستگی یا ready=false ⇒ SCHEMA_MISMATCH (هر کدام به‌تنهایی)", async () => {
    expect(await run(status({ problems: ["trigger"] }))).toEqual({ ok: false, code: "SCHEMA_MISMATCH" });
    expect(await run(status({ contiguous: false }))).toEqual({ ok: false, code: "SCHEMA_MISMATCH" });
    expect(await run(status({ ready: false }))).toEqual({ ok: false, code: "SCHEMA_MISMATCH" });
  });

  it("شکلِ ناشناخته/پرتاب/ردّ ⇒ UNAVAILABLE و بی‌نشت", async () => {
    const samples: unknown[] = [null, undefined, 5, "x", {}, { ok: "true" }, { ok: true }, { ok: true, value: null }, { ok: "true", value: status().value }, { value: status().value }, { ok: 1, value: status().value }, status({ pending: "none" }), status({ problems: null }), status({ schemaExists: "yes" }), status({ ready: 1 }), status({ contiguous: undefined })];
    for (const [i, v] of samples.entries()) expect(await run(v), `sample ${i}`).toEqual({ ok: false, code: "UNAVAILABLE" });
    const threw = await preflightOf({
      status: () => {
        throw new Error(SECRET);
      },
    });
    const rejected = await preflightOf({ status: () => Promise.reject(new Error(SECRET)) });
    expect(threw).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(rejected).toEqual({ ok: false, code: "UNAVAILABLE" });
    expect(JSON.stringify([threw, rejected])).not.toContain("s3cr3t");
  });
});
