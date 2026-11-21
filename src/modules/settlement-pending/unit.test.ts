/**
 * settlement-pending · واحد (بی‌پایگاه): اعتبارسنجی مرزی، هم‌ارزی با آداپتورِ settlement، شکلِ مهاجرت، دفترِ مهاجرت، نگاشتِ خطا، ردیفِ خراب.
 * پایگاهِ جعلی هر تماس را می‌شمارد تا «ورودیِ نامعتبر هیچ تراکنشی نمی‌سازد» اثبات شود.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { LedgerDatabase } from "@/modules/ledger";
import { createPgSettlementOutbox } from "@/modules/settlement";
import { PendingStoreError, mapDbError } from "./errors";
import { createPendingDeadIndex } from "./index";
import { MIGRATIONS, migrationChecksum, renderStatement } from "./migrations";
import { reconcile } from "./migrate";
import { parseSchemaName } from "./naming";
import { PENDING_READ_STATEMENT_TIMEOUT_LIMITS, deadEntryFromRow, parseReadStatementTimeout } from "./read";

type Fake = Readonly<{ db: LedgerDatabase; calls: () => number }>;
function fakeDb(mode: "throw" | "empty"): Fake {
  let n = 0;
  const execute = (): Promise<{ rows: Record<string, unknown>[] }> => {
    n++;
    if (mode === "throw") return Promise.reject(new Error("secret-connection-detail host=db user=u"));
    return Promise.resolve({ rows: [] });
  };
  const db = {
    execute,
    transaction: async <T>(run: (tx: unknown) => Promise<T>): Promise<T> => {
      n++;
      return run({ execute });
    },
  } as unknown as LedgerDatabase;
  return { db, calls: () => n };
}

const BAD_SCHEMAS: readonly unknown[] = ["", "Public", "public", "information_schema", "pg_catalog", "1abc", "a-b", "a b", "a".repeat(41), 'a"b', "a;drop", "ä", undefined, null, 5, {}, []];
const GOOD_SCHEMAS: readonly string[] = ["settlement", "a", "a_1", "x".repeat(40), "tenant_a_settlement"];

describe("settlement-pending · نام شِما هم‌ارزِ آداپتورِ settlement", () => {
  it.each(BAD_SCHEMAS.map((v) => [JSON.stringify(v) ?? String(v), v] as const))("رد: %s", (_label, v) => {
    const mine = parseSchemaName(v);
    expect(mine.ok).toBe(false);
    // آداپتورِ settlement همان ورودی را با همان کد رد می‌کند (یک تعریف، دو مصرف‌کننده).
    const theirs = createPgSettlementOutbox(fakeDb("empty").db, { schema: v as string });
    if (v === undefined || v === null) {
      // `??` در هر دو: undefined و null به پیش‌فرض می‌رسند (رفتارِ هم‌ارز، نه رد)
      expect(createPendingDeadIndex(fakeDb("empty").db, { schema: v as unknown as string }).ok).toBe(theirs.ok);
      return;
    }
    expect(theirs.ok).toBe(false);
    if (!mine.ok && !theirs.ok) expect(mine.error.code).toBe(theirs.error.code);
    expect(createPendingDeadIndex(fakeDb("empty").db, { schema: v as string }).ok).toBe(false);
  });

  it.each(GOOD_SCHEMAS)("پذیرش: %s", (v) => {
    expect(parseSchemaName(v).ok).toBe(true);
    expect(createPgSettlementOutbox(fakeDb("empty").db, { schema: v }).ok).toBe(true);
    expect(createPendingDeadIndex(fakeDb("empty").db, { schema: v }).ok).toBe(true);
  });

  it("پیش‌فرضِ شِما همان `settlement` است (بی‌خطا)", () => {
    expect(createPendingDeadIndex(fakeDb("empty").db).ok).toBe(true);
  });
});

describe("settlement-pending · سقفِ زمانِ سمتِ پایگاه (هم‌ارزِ ADR-0045)", () => {
  const CASES: readonly unknown[] = [undefined, null, 0, 1, 2, 7_199_999, 7_200_000, 7_200_001, -1, 1.5, Number.NaN, Infinity, "5", "", true, {}, [], 1e21, Number.MAX_SAFE_INTEGER];
  it.each(CASES.map((v) => [String(v), v] as const))("%s ⇒ همان پذیرش/ردِ آداپتورِ settlement", (_l, v) => {
    const mine = parseReadStatementTimeout(v);
    const theirs = createPgSettlementOutbox(fakeDb("empty").db, { readStatementTimeoutMs: v as number });
    expect(mine.ok).toBe(theirs.ok);
    const viaStore = createPendingDeadIndex(fakeDb("empty").db, { readStatementTimeoutMs: v as number });
    expect(viaStore.ok).toBe(theirs.ok);
    if (!mine.ok && !theirs.ok) expect(mine.error.code).toBe(theirs.error.code);
  });

  it("حدها ثابت و منجمدند", () => {
    expect(PENDING_READ_STATEMENT_TIMEOUT_LIMITS).toEqual({ minMs: 1, maxMs: 7_200_000 });
    expect(Object.isFrozen(PENDING_READ_STATEMENT_TIMEOUT_LIMITS)).toBe(true);
  });

  it("بی‌گزینه (undefined) ⇒ بی‌سقف (null)؛ عدد ⇒ همان", () => {
    expect(parseReadStatementTimeout(undefined)).toEqual({ ok: true, value: null });
    expect(parseReadStatementTimeout(1300)).toEqual({ ok: true, value: 1300 });
  });

  it("پیامِ رد فقط نامِ گزینه را دارد، نه مقدارِ ورودی", () => {
    const r = parseReadStatementTimeout("secret-value-xyz");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).not.toContain("secret-value-xyz");
  });

  it("ورودیِ نامعتبرِ db/options ⇒ INVALID_INPUT بی‌تماس", () => {
    for (const bad of [null, undefined, {}, { execute: () => 1 }, { transaction: () => 1 }, 5, "db"]) {
      const r = createPendingDeadIndex(bad as unknown as LedgerDatabase);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
    }
    const r = createPendingDeadIndex(fakeDb("empty").db, null as unknown as object);
    expect(r.ok).toBe(false);
  });
});

describe("settlement-pending · listUnacknowledgedDead مرزی و بی‌پرتاب", () => {
  const mk = (mode: "throw" | "empty") => {
    const f = fakeDb(mode);
    const made = createPendingDeadIndex(f.db);
    if (!made.ok) throw new Error("create failed");
    return { index: made.value, f };
  };

  const BAD_QUERIES: readonly unknown[] = [undefined, null, 5, "x", [], {}, { limit: 0 }, { limit: -1 }, { limit: 1001 }, { limit: 1.5 }, { limit: "5" }, { limit: Number.NaN }, { limit: Infinity }, { limit: null }, { limit: true }];
  it.each(BAD_QUERIES.map((v) => [JSON.stringify(v) ?? String(v), v] as const))("نامعتبر %s ⇒ INVALID_INPUT و صفر تماس با پایگاه", async (_l, q) => {
    const { index, f } = mk("empty");
    const r = await index.listUnacknowledgedDead(q as { limit: number });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
    expect(f.calls()).toBe(0);
  });

  it("گیرندهٔ پرتاب‌کنندهٔ limit ⇒ INVALID_INPUT (نه پرتاب)", async () => {
    const { index } = mk("empty");
    const evil = {
      get limit(): number {
        throw new Error("boom");
      },
    };
    const r = await index.listUnacknowledgedDead(evil as unknown as { limit: number });
    expect(r.ok).toBe(false);
  });

  it("پایگاهِ در حال پرتاب ⇒ STORE_FAILURE با پیامِ ثابت؛ هیچ رازی بیرون نمی‌آید", async () => {
    const { index } = mk("throw");
    const r = await index.listUnacknowledgedDead({ limit: 10 });
    expect(r).toEqual({ ok: false, error: { code: "STORE_FAILURE", message: "ذخیرهٔ outbox در دسترس نیست." } });
    expect(JSON.stringify(r)).not.toMatch(/secret|host=db/);
  });

  it("مرز ۱ و ۱۰۰۰ پذیرفته می‌شود (تماس با پایگاه می‌رسد)", async () => {
    for (const limit of [1, 1000]) {
      const { index, f } = mk("empty");
      await index.listUnacknowledgedDead({ limit });
      expect(f.calls()).toBeGreaterThan(0);
    }
  });

  it("verify/migrate/status روی پایگاهِ خراب بی‌پرتاب و بی‌نشتِ راز برمی‌گردانند", async () => {
    const { index } = mk("throw");
    for (const r of [await index.verify(), await index.migrate(), await index.status()]) {
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toMatch(/secret|host=db/);
    }
  });
});

describe("settlement-pending · ردیفِ outbox سخت‌گیرانه اعتبارسنجی می‌شود", () => {
  const good = (): Record<string, unknown> => ({
    tenant_id: "t1", account_id: "a1", reservation_id: "r1", unit: "IRR_MICROS", reserved: "500", created_at_ms: "1000", expires_at_ms: "61000", due_at_ms: "11000",
    orphan_remainder: "forfeit", state: "dead", charge_attempt_id: null, charge_amount: null, close_remainder: null, close_origin: null,
    attempts: "2", last_error_code: "E_X", dead_reason: "ATTEMPTS_EXHAUSTED", settled_at_ms: "20000",
  });

  it("ردیفِ سالم به رکوردِ منجمدِ dead نگاشت می‌شود", () => {
    const e = deadEntryFromRow(good());
    expect(e).toEqual({
      tenantId: "t1", accountId: "a1", reservationId: "r1", unit: "IRR_MICROS", reserved: 500, createdAtMs: 1000, expiresAtMs: 61000, dueAtMs: 11000,
      orphanRemainder: "forfeit", state: "dead", charge: null, close: null, attempts: 2, lastErrorCode: "E_X", deadReason: "ATTEMPTS_EXHAUSTED", settledAtMs: 20000,
    });
    expect(Object.isFrozen(e)).toBe(true);
  });

  it("قصدِ مصرف و بستن (کامل) درست نگاشت می‌شوند", () => {
    const e = deadEntryFromRow({ ...good(), charge_attempt_id: "att", charge_amount: "70", close_remainder: "release", close_origin: "sweeper" });
    expect(e.charge).toEqual({ attemptId: "att", amount: 70 });
    expect(e.close).toEqual({ remainder: "release", origin: "sweeper" });
  });

  const BAD: readonly (readonly [string, Record<string, unknown>])[] = [
    ["غیرِ dead", { state: "settling" }],
    ["done", { state: "done" }],
    ["بی‌دلیلِ مرگ", { dead_reason: null }],
    ["دلیلِ ناشناخته", { dead_reason: "WHATEVER" }],
    ["بی‌زمانِ مرگ", { settled_at_ms: null }],
    ["زمانِ منفی", { settled_at_ms: "-1" }],
    ["زمانِ ناصحیح", { settled_at_ms: "1.5" }],
    ["زمانِ غیرِ‌ایمن", { settled_at_ms: "9007199254740993" }],
    ["قصدِ مصرفِ نیم‌کاره", { charge_attempt_id: "att" }],
    ["مبلغِ بی‌شناسه", { charge_amount: "5" }],
    ["قصدِ بستنِ نیم‌کاره", { close_remainder: "release" }],
    ["مبدأِ بستنِ بی‌مانده", { close_origin: "caller" }],
    ["مبدأِ ناشناخته", { close_remainder: "release", close_origin: "hacker" }],
    ["مانده‌ی ناشناخته", { close_remainder: "burn", close_origin: "caller" }],
    ["orphan ناشناخته", { orphan_remainder: "keep" }],
    ["شناسهٔ عددی", { tenant_id: 5 }],
    ["مبلغِ رزرو متنی", { reserved: "abc" }],
    ["تلاشِ منفی", { attempts: "-3" }],
    ["unit نبود", { unit: undefined }],
  ];
  it.each(BAD)("خراب: %s ⇒ CORRUPT_DATA", (_l, patch) => {
    let thrown: unknown = null;
    try {
      deadEntryFromRow({ ...good(), ...patch });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PendingStoreError);
    expect((thrown as PendingStoreError).error.code).toBe("CORRUPT_DATA");
  });
});

describe("settlement-pending · مهاجرت (ایستا)", () => {
  const m = MIGRATIONS[0];
  it("دقیقاً یک مهاجرتِ 0001_dead_pending با checksum پایدار (قفلِ نسخه)", () => {
    expect(MIGRATIONS.map((x) => x.name)).toEqual(["0001_dead_pending"]);
    const expected = createHash("sha256").update(JSON.stringify([m?.name, m?.statements])).digest("hex");
    expect(migrationChecksum(m as NonNullable<typeof m>)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("checksum قفل‌شدهٔ literal: هر ویرایشِ مهاجرتِ اعمال‌شده قرمز می‌شود (تغییر = مهاجرتِ تازه، نه ویرایش)", () => {
    expect(migrationChecksum(m as NonNullable<typeof m>)).toBe("10a544ef62bbeedc3237cc58ec596cf4cc618a8173cd563c8715f4db45676620");
  });

  const idx = (re: RegExp): number => (m?.statements ?? []).findIndex((s) => re.test(s));

  it("ترتیبِ ایمن: lock_timeout ← LOCK TABLE ← جدول ← TRIGGERهای نگهداری ← backfill ← نگهبانِ نمایه", () => {
    const order = [
      idx(/^SET LOCAL lock_timeout/),
      idx(/^LOCK TABLE/),
      idx(/^CREATE TABLE/),
      idx(/CREATE TRIGGER settlement_pending_dead_ins/),
      idx(/CREATE TRIGGER settlement_pending_dead_upd/),
      idx(/CREATE TRIGGER settlement_pending_ack/),
      idx(/^INSERT INTO .*settlement_dead_pending/),
      idx(/CREATE TRIGGER settlement_dead_pending_guard/),
      idx(/CREATE TRIGGER settlement_dead_pending_no_truncate/),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("قفلِ backfill از نوعِ SHARE ROW EXCLUSIVE روی هر دو جدول (نویسنده‌ها منتظر، خواننده‌ها نه)", () => {
    const s = m?.statements[idx(/^LOCK TABLE/)] ?? "";
    expect(s).toMatch(/IN SHARE ROW EXCLUSIVE MODE$/);
    expect(s).toContain("settlement_outbox");
    expect(s).toContain("settlement_dead_ack");
    expect(s).not.toMatch(/ACCESS EXCLUSIVE|NOWAIT/);
  });

  it("هیچ دستوری outbox یا تأییدها را تغییر نمی‌دهد: DML فقط روی جدولِ نمایه است و هیچ DDLِ مخرب (DROP/ALTER/TRUNCATE) نیست", () => {
    for (const s of m?.statements ?? []) {
      expect(s, s.slice(0, 60)).not.toMatch(/^\s*(UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i);
      expect(s, s.slice(0, 60)).not.toMatch(/\b(DROP|ALTER)\s+(TABLE|TRIGGER|FUNCTION|DOMAIN|SCHEMA)\b/i);
      for (const t of s.matchAll(/\b(INSERT\s+INTO|DELETE\s+FROM)\s+(\{\{schema\}\}\.\w+)/gi)) expect(t[2], s.slice(0, 60)).toBe("{{schema}}.settlement_dead_pending");
      for (const t of s.matchAll(/(?<!AFTER |BEFORE )\bUPDATE\s+(\{\{schema\}\}\.\w+)\s+SET\b/gi)) expect(t[1], s.slice(0, 60)).toBe("{{schema}}.settlement_dead_pending");
    }
  });

  it("نگهبانِ نمایه با pg_trigger_depth کار می‌کند و پیامِ RAISE ASCII و بی‌داده است", () => {
    const g = m?.statements[idx(/CREATE FUNCTION .*settlement_pending_guard/)] ?? "";
    expect(g).toContain("pg_trigger_depth() < 2");
    for (const s of m?.statements ?? []) for (const raise of s.matchAll(/RAISE EXCEPTION '([^']*)'/g)) expect(raise[1]).toMatch(/^[\x20-\x7e]+$/);
  });

  it("TRIGGERِ ورود به dead فقط وقتی شلیک می‌کند که NEW.state = 'dead' (و در UPDATE: پیش‌تر dead نبوده)", () => {
    expect(m?.statements[idx(/CREATE TRIGGER settlement_pending_dead_ins/)]).toMatch(/AFTER INSERT ON .*settlement_outbox\s+FOR EACH ROW WHEN \(NEW\.state = 'dead'\)/);
    expect(m?.statements[idx(/CREATE TRIGGER settlement_pending_dead_upd/)]).toMatch(/AFTER UPDATE ON .*settlement_outbox\s+FOR EACH ROW WHEN \(NEW\.state = 'dead' AND OLD\.state IS DISTINCT FROM 'dead'\)/);
  });

  it("ستون‌ها از دامنه‌های settlement‌اند (ترتیبِ COLLATE C یکسان)", () => {
    const t = m?.statements[idx(/^CREATE TABLE/)] ?? "";
    expect(t.match(/\{\{schema\}\}\.settlement_id/g)).toHaveLength(3);
    expect(t.match(/\{\{schema\}\}\.settlement_count/g)).toHaveLength(1);
    expect(t).not.toMatch(/\btext\b|\bbigint\b/);
  });

  it("renderStatement همهٔ جایگاه‌ها را نقل‌قول‌شده جایگزین می‌کند و اثری از {{schema}} نمی‌ماند", () => {
    for (const s of m?.statements ?? []) {
      const out = renderStatement(s, "tenant_a");
      expect(out).not.toContain("{{schema}}");
      if (s.includes("{{schema}}")) expect(out).toContain('"tenant_a".');
    }
    expect(renderStatement("{{schema}}.x {{schema}}.y", "s1")).toBe('"s1".x "s1".y');
  });
});

describe("settlement-pending · دفترِ مهاجرت (reconcile)", () => {
  const good = { name: "0001_dead_pending", checksum: migrationChecksum(MIGRATIONS[0] as NonNullable<(typeof MIGRATIONS)[number]>) };
  const code = (fn: () => unknown): string | null => {
    try {
      fn();
      return null;
    } catch (e) {
      return e instanceof PendingStoreError ? e.error.code : "other";
    }
  };
  it("دفترِ خالی ⇒ همه معلق؛ دفترِ درست ⇒ همه اعمال‌شده", () => {
    expect(reconcile([])).toEqual({ applied: [], pending: ["0001_dead_pending"] });
    expect(reconcile([good])).toEqual({ applied: ["0001_dead_pending"], pending: [] });
  });
  it("مهاجرتِ ناشناخته ⇒ MIGRATION_UNKNOWN؛ checksum ناهمخوان ⇒ MIGRATION_TAMPERED", () => {
    expect(code(() => reconcile([good, { name: "0002_future", checksum: "x" }]))).toBe("MIGRATION_UNKNOWN");
    expect(code(() => reconcile([{ ...good, checksum: "0".repeat(64) }]))).toBe("MIGRATION_TAMPERED");
  });
  it("حفره (مهاجرتِ دوم بی‌اولی) ⇒ MIGRATION_TAMPERED", () => {
    const m1: (typeof MIGRATIONS)[number] = { name: "0001_a", statements: ["x"] };
    const m2: (typeof MIGRATIONS)[number] = { name: "0002_b", statements: ["y"] };
    expect(code(() => reconcile([{ name: "0002_b", checksum: migrationChecksum(m2) }], [m1, m2]))).toBe("MIGRATION_TAMPERED");
  });
});

describe("settlement-pending · نگاشتِ خطا", () => {
  it("42P01 و 3F000 ⇒ NOT_MIGRATED؛ کلاس ۲۳ ⇒ COMMIT_REJECTED؛ دیگر ⇒ DB_ERROR؛ بی‌کد ⇒ DB_ERROR", () => {
    const wrap = (code: string, constraint?: string) => ({ cause: { code, ...(constraint ? { constraint } : {}) } });
    expect(mapDbError(wrap("42P01")).code).toBe("NOT_MIGRATED");
    expect(mapDbError(wrap("3F000")).code).toBe("NOT_MIGRATED");
    expect(mapDbError(wrap("23000")).code).toBe("COMMIT_REJECTED");
    expect(mapDbError(wrap("23505", "settlement_dead_pending_pk")).constraint).toBe("settlement_dead_pending_pk");
    expect(mapDbError(wrap("57014")).code).toBe("DB_ERROR");
    expect(mapDbError(new Error("x")).code).toBe("DB_ERROR");
    expect(mapDbError(null).code).toBe("DB_ERROR");
  });
  it("پیامِ خطا هرگز متنِ خطای خام را نمی‌آورد", () => {
    const e = mapDbError({ message: "SELECT secret FROM x WHERE pw='abc'", cause: { code: "XX000" } });
    expect(JSON.stringify(e)).not.toMatch(/secret|abc/);
  });
});
