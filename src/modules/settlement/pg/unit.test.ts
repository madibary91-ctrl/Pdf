/**
 * آزمون‌های واحدِ آداپتور PostgreSQL بدون پایگاه (ADR-0022): اعتبارسنجی مرز، نگاشت خطا، رمزگشایی ردیف، مهاجرت‌ها (checksum قفل‌شده، reconcile)،
 * و رفتارِ آداپتور روی یک `db` جعلی (ورودیِ بد هرگز به پایگاه نمی‌رسد؛ خطای پایگاه ⇒ STORE_FAILURE بی‌نشتِ جزئیات؛ مقدارها پارامتر پیوندی‌اند).
 */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { LedgerDatabase, LedgerTransactionConfig } from "@/modules/ledger";
import { SettlementStoreError, mapDbError, toStoreError } from "./errors";
import { MIGRATIONS, migrationChecksum, renderStatement } from "./migrations";
import { reconcile } from "./migrate";
import { SETTLEMENT_DEFAULT_SCHEMA, parseSchemaName } from "./naming";
import { countsFromRows, entryFromRow, readCount } from "./rows";
import { createPgSettlementOutbox } from "./store";
import { createPgSettlementOutbox as fromIndex } from "../index";

const dialect = new PgDialect();

/** `db` جعلی: هر دستور را (متن + پارامتر) ثبت می‌کند و `reply` پاسخ می‌دهد. سپرِ مهاجرت پیش‌فرض سبز است. */
function stubDb(reply: (text: string, params: readonly unknown[]) => readonly Record<string, unknown>[] = () => []) {
  const log: { text: string; params: unknown[] }[] = [];
  const configs: (LedgerTransactionConfig | undefined)[] = [];
  let transactions = 0;
  const execute = async (query: SQL) => {
    const q = dialect.sqlToQuery(query);
    log.push({ text: q.sql, params: [...q.params] });
    if (q.sql.includes("settlement_migration_ledger")) return { rows: MIGRATIONS.map((m) => ({ name: m.name, checksum: migrationChecksum(m) })) };
    return { rows: [...reply(q.sql, q.params)] };
  };
  const db: LedgerDatabase = {
    execute,
    transaction: async (run, config) => {
      transactions += 1;
      configs.push(config);
      return run({ execute });
    },
  };
  return { db, log, configs, transactions: () => transactions };
}

const REF = { tenantId: "tenant-x", accountId: "acct-x", reservationId: "res-x" };
const BEGIN = { ...REF, unit: "IRR_MICROS", reserved: 5, createdAtMs: 1, expiresAtMs: 100, dueAtMs: 50, orphanRemainder: "forfeit" as const };

function outboxOn(db: LedgerDatabase) {
  const made = createPgSettlementOutbox(db);
  if (!made.ok) throw new Error(made.error.code);
  return made.value;
}

describe("settlement/pg · نام شِما", () => {
  it("پیش‌فرض settlement؛ نام‌های معتبر پذیرفته می‌شوند (ledger هم، چون جدول‌ها پیشوند دارند)", () => {
    expect(SETTLEMENT_DEFAULT_SCHEMA).toBe("settlement");
    for (const n of ["settlement", "ledger", "a", "a_1", "x".repeat(40)]) expect(parseSchemaName(n)).toEqual({ ok: true, value: n });
  });
  it.each([["public"], ["information_schema"], ["pg_catalog"], ["pg_x"], [""], ["A"], ["1a"], ["a-b"], ["a b"], ["x".repeat(41)], ['a"; DROP SCHEMA x; --'], [null], [undefined], [1]])("نام نامعتبر %j ⇒ INVALID_INPUT", (n) => {
    const r = parseSchemaName(n);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
  });
});

describe("settlement/pg · createPgSettlementOutbox", () => {
  it("از index ماژول هم همین کارخانه صادر می‌شود", () => {
    expect(fromIndex).toBe(createPgSettlementOutbox);
  });
  it.each([[null], [undefined], [{}], [{ execute: () => 1 }], [{ transaction: () => 1 }], [{ execute: 1, transaction: 2 }], ["db"]])("db نامعتبر %j ⇒ INVALID_INPUT", (bad) => {
    const r = createPgSettlementOutbox(bad as never);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
  });
  it("options و نام شِمای نامعتبر ⇒ INVALID_INPUT؛ نمونهٔ ساخته‌شده منجمد است و migrate/status دارد", () => {
    const { db } = stubDb();
    for (const options of [null, { schema: "public" }, { schema: "Bad" }]) {
      const r = createPgSettlementOutbox(db, options as never);
      expect(r.ok).toBe(false);
    }
    const made = createPgSettlementOutbox(db);
    expect(made.ok && Object.isFrozen(made.value)).toBe(true);
    expect(made.ok && Object.keys(made.value).sort()).toEqual(["acknowledgeDead", "begin", "bury", "claimDue", "counts", "finish", "get", "listDead", "listDue", "listUnacknowledgedDead", "migrate", "recordCharge", "recordClose", "recordFailure", "resolveClose", "status"]);
  });
});

describe("settlement/pg · مرز: ورودی نامعتبر هرگز به پایگاه نمی‌رسد", () => {
  it("همهٔ متدها با ورودی بد ⇒ INVALID_INPUT و صفر تراکنش", async () => {
    const s = stubDb();
    const o = outboxOn(s.db);
    const bad = [
      await o.begin({ ...BEGIN, reserved: 0 }),
      await o.begin(null as never),
      await o.recordCharge({ ...REF, tenantId: "bad id" }, { attemptId: "a", amount: 1 }),
      await o.recordCharge(REF, { attemptId: "a", amount: -1 }),
      await o.recordClose(REF, { remainder: "keep" as never, origin: "caller" }),
      await o.resolveClose({ tenantId: "t" } as never),
      await o.finish(REF, -1),
      await o.finish(REF, 1.5),
      await o.recordFailure(REF, { errorCode: "lower", dueAtMs: 1 }),
      await o.bury(REF, { reason: "NOPE" as never, errorCode: null, atMs: 1 }),
      await o.get(null as never),
      await o.listDue({ nowMs: 1, limit: 0 }),
      await o.listDue({ nowMs: 1, limit: 1001 }),
      await o.listDead({ limit: 0 }),
    ];
    for (const r of bad) expect(r).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(s.transactions()).toBe(0);
    expect(s.log).toHaveLength(0);
  });
});

describe("settlement/pg · خطای پایگاه ⇒ STORE_FAILURE (بی‌پرتاب، بی‌نشت)", () => {
  const CANARY = "LEAK-CANARY-9c1 connection-details-and-credentials SELECT secret";
  const calls: [string, (o: ReturnType<typeof outboxOn>) => Promise<unknown>][] = [
    ["begin", (o) => o.begin(BEGIN)],
    ["recordCharge", (o) => o.recordCharge(REF, { attemptId: "a1", amount: 1 })],
    ["recordClose", (o) => o.recordClose(REF, { remainder: "release", origin: "caller" })],
    ["resolveClose", (o) => o.resolveClose(REF)],
    ["finish", (o) => o.finish(REF, 5)],
    ["recordFailure", (o) => o.recordFailure(REF, { errorCode: "STORE_FAILURE", dueAtMs: 9 })],
    ["bury", (o) => o.bury(REF, { reason: "LEDGER_REJECTED", errorCode: null, atMs: 9 })],
    ["get", (o) => o.get(REF)],
    ["listDue", (o) => o.listDue({ nowMs: 1, limit: 5 })],
    ["listDead", (o) => o.listDead({ limit: 5 })],
    ["counts", (o) => o.counts()],
  ];
  it.each(calls)("%s: پرتابِ پایگاه با متنِ حساس ⇒ پیام ثابت و بی‌پژواک", async (_name, call) => {
    const s = stubDb(() => {
      throw Object.assign(new Error(CANARY), { code: "08006", detail: CANARY });
    });
    const r = (await call(outboxOn(s.db))) as { ok: boolean; error: { code: string; message: string } };
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("STORE_FAILURE");
    expect(JSON.stringify(r)).not.toMatch(/LEAK|credentials|SELECT|secret/);
  });
  it("خودِ transaction بپرتابد (اتصال قطع) ⇒ STORE_FAILURE", async () => {
    const o = outboxOn({
      execute: async () => ({ rows: [] }),
      transaction: async () => {
        throw new Error(CANARY);
      },
    });
    const r = await o.counts();
    expect(r).toEqual({ ok: false, error: { code: "STORE_FAILURE", message: "ذخیرهٔ outbox در دسترس نیست." } });
  });
  it("ردیفِ خراب (شکلِ ناسازگار با مدل) ⇒ STORE_FAILURE، نه رکوردِ نادرست", async () => {
    const s = stubDb((text) => (text.includes("FOR UPDATE") ? [{ ...goodRow(), state: "weird" }] : []));
    expect(await outboxOn(s.db).resolveClose(REF)).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
  });
  it("پایگاهِ مهاجرت‌نشده یا checksum ناهمخوان ⇒ همهٔ عملیات STORE_FAILURE (سپر مهاجرت)", async () => {
    const empty = { execute: async () => ({ rows: [] }), transaction: async (run: (tx: never) => Promise<unknown>) => run({ execute: async () => ({ rows: [] }) } as never) } as unknown as LedgerDatabase;
    expect(await outboxOn(empty).get(REF)).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
    const tampered = {
      execute: async () => ({ rows: [] }),
      transaction: async (run: (tx: never) => Promise<unknown>) => run({ execute: async () => ({ rows: [{ name: "0001_init", checksum: "0".repeat(64) }] }) } as never),
    } as unknown as LedgerDatabase;
    expect(await outboxOn(tampered).counts()).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
  });
});

describe("settlement/pg · ساختارِ دستورها (روی db جعلی)", () => {
  it("هیچ مقدارِ داده‌ای در متنِ SQL نمی‌آید؛ همه پارامتر پیوندی‌اند", async () => {
    const s = stubDb(() => []);
    const o = outboxOn(s.db);
    await o.begin(BEGIN);
    await o.recordCharge(REF, { attemptId: "attempt-77", amount: 123456 });
    await o.recordFailure(REF, { errorCode: "STORE_FAILURE", dueAtMs: 987654 });
    await o.listDue({ nowMs: 424242, limit: 7 });
    const writes = s.log.filter((l) => !l.text.includes("migration_ledger"));
    expect(writes.length).toBeGreaterThan(0);
    for (const l of writes) expect(l.text).not.toMatch(/tenant-x|acct-x|res-x|attempt-77|123456|987654|424242|STORE_FAILURE/);
    const flat = JSON.stringify(writes.map((l) => l.params));
    expect(flat).toContain("tenant-x");
    expect(flat).toContain("424242");
    expect(writes.some((l) => l.params.includes(7))).toBe(true);
  });
  it("نام شِما فقط به‌صورت شناسهٔ نقل‌قول‌شده در SQL می‌آید", async () => {
    const s = stubDb(() => []);
    const made = createPgSettlementOutbox(s.db, { schema: "my_schema" });
    if (!made.ok) throw new Error("x");
    await made.value.get(REF);
    expect(s.log.some((l) => l.text.includes('"my_schema"."settlement_outbox"'))).toBe(true);
    expect(s.log.some((l) => l.text.includes('"my_schema"."settlement_migration_ledger"'))).toBe(true);
  });
  it("بی‌options شِمای پیش‌فرض settlement است (نه public و نه ledger)", async () => {
    const s = stubDb(() => []);
    await outboxOn(s.db).get(REF);
    expect(s.log.some((l) => l.text.includes('"settlement"."settlement_outbox"'))).toBe(true);
    expect(s.log.every((l) => !l.text.includes('"public"') && !l.text.includes('"ledger"'))).toBe(true);
  });
  it("خواندن‌ها فقط‌خواندنی‌اند و نوشتن‌ها نه؛ خواندنِ مستقل قفل نمی‌گیرد، نوشتن FOR UPDATE می‌گیرد", async () => {
    const s = stubDb(() => []);
    const o = outboxOn(s.db);
    await o.get(REF);
    await o.listDue({ nowMs: 1, limit: 1 });
    await o.listDead({ limit: 1 });
    await o.counts();
    expect(s.configs).toEqual([{ accessMode: "read only" }, { accessMode: "read only" }, { accessMode: "read only" }, { accessMode: "read only" }]);
    expect(s.log.some((l) => l.text.includes("FOR UPDATE"))).toBe(false);
    const w = stubDb(() => []);
    await outboxOn(w.db).resolveClose(REF);
    expect(w.configs).toEqual([undefined]);
    expect(w.log.some((l) => l.text.includes("FOR UPDATE"))).toBe(true);
  });
  it("ترتیبِ listDue/listDead در SQL صریح است (سررسید یا زمان مرگ، سپس شناسه)", async () => {
    const s = stubDb(() => []);
    const o = outboxOn(s.db);
    await o.listDue({ nowMs: 1, limit: 1 });
    await o.listDead({ limit: 1 });
    const texts = s.log.map((l) => l.text);
    expect(texts.some((t) => /ORDER BY due_at_ms, tenant_id, account_id, reservation_id/.test(t) && /due_at_ms <= \$1/.test(t))).toBe(true);
    expect(texts.some((t) => /state = 'dead'/.test(t) && /ORDER BY settled_at_ms, tenant_id, account_id, reservation_id/.test(t))).toBe(true);
  });
});

describe("settlement/pg · نگاشت خطا", () => {
  it("بی‌کد pg ⇒ DB_ERROR با پیامِ ثابت (متنِ خطا نمی‌آید)", () => {
    const e = mapDbError(new Error("LEAK-CANARY connection-details"));
    expect(e.code).toBe("DB_ERROR");
    expect(JSON.stringify(e)).not.toMatch(/LEAK|connection-details/);
    expect(mapDbError("boom").code).toBe("DB_ERROR");
    expect(mapDbError(null).code).toBe("DB_ERROR");
  });
  it("42P01 و 3F000 ⇒ NOT_MIGRATED؛ کلاس ۲۳ ⇒ COMMIT_REJECTED با نامِ قید؛ سایر ⇒ DB_ERROR با pgCode", () => {
    expect(mapDbError({ code: "42P01" })).toMatchObject({ code: "NOT_MIGRATED", pgCode: "42P01" });
    expect(mapDbError({ code: "3F000" })).toMatchObject({ code: "NOT_MIGRATED" });
    expect(mapDbError({ code: "23514", constraint: "settlement_outbox_state_shape_ck" })).toMatchObject({ code: "COMMIT_REJECTED", constraint: "settlement_outbox_state_shape_ck" });
    expect(mapDbError({ code: "23505" })).toMatchObject({ code: "COMMIT_REJECTED" });
    expect(mapDbError({ code: "40001" })).toMatchObject({ code: "DB_ERROR", pgCode: "40001" });
    expect(mapDbError({ code: "xx" })).toEqual({ code: "DB_ERROR", message: expect.any(String) });
  });
  it("خطای pg در cause (drizzle) پیدا می‌شود؛ عمقِ بی‌نهایت/چرخه گیر نمی‌کند", () => {
    expect(mapDbError({ message: "q", cause: { cause: { code: "23514", constraint: "c" } } })).toMatchObject({ code: "COMMIT_REJECTED" });
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(mapDbError(loop).code).toBe("DB_ERROR");
  });
  it("SettlementStoreError دست‌نخورده می‌ماند؛ toStoreError همیشه SettlementStoreError می‌دهد", () => {
    const own = new SettlementStoreError({ code: "CORRUPT_DATA", message: "m" });
    expect(toStoreError(own)).toBe(own);
    expect(mapDbError(own)).toEqual({ code: "CORRUPT_DATA", message: "m" });
    expect(toStoreError(new Error("x"))).toBeInstanceOf(SettlementStoreError);
  });
});

const goodRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  tenant_id: "t",
  account_id: "a",
  reservation_id: "r",
  unit: "IRR_MICROS",
  reserved: "500",
  created_at_ms: "1000",
  expires_at_ms: "61000",
  due_at_ms: "11000",
  orphan_remainder: "forfeit",
  state: "open",
  charge_attempt_id: null,
  charge_amount: null,
  close_remainder: null,
  close_origin: null,
  attempts: "0",
  last_error_code: null,
  dead_reason: null,
  settled_at_ms: null,
  ...over,
});

describe("settlement/pg · رمزگشایی ردیف", () => {
  it("رشته‌های bigint به عدد؛ خروجی منجمد با همهٔ میدان‌ها", () => {
    const e = entryFromRow(goodRow({ state: "settling", charge_attempt_id: "a1", charge_amount: "42", close_remainder: "release", close_origin: "sweeper", attempts: "3", last_error_code: "STORE_FAILURE" }));
    expect(e).toEqual({
      tenantId: "t",
      accountId: "a",
      reservationId: "r",
      unit: "IRR_MICROS",
      reserved: 500,
      createdAtMs: 1000,
      expiresAtMs: 61000,
      dueAtMs: 11000,
      orphanRemainder: "forfeit",
      state: "settling",
      charge: { attemptId: "a1", amount: 42 },
      close: { remainder: "release", origin: "sweeper" },
      attempts: 3,
      lastErrorCode: "STORE_FAILURE",
      deadReason: null,
      settledAtMs: null,
    });
    expect(Object.isFrozen(e) && Object.isFrozen(e.charge) && Object.isFrozen(e.close)).toBe(true);
  });
  it("مرده با دلیل و زمان؛ عددِ بزرگِ ایمن می‌ماند؛ عددِ JS هم پذیرفته می‌شود", () => {
    const e = entryFromRow(goodRow({ state: "dead", dead_reason: "EXPIRED_UNBILLED", settled_at_ms: "9007199254740991", due_at_ms: 5 }));
    expect(e).toMatchObject({ state: "dead", deadReason: "EXPIRED_UNBILLED", settledAtMs: Number.MAX_SAFE_INTEGER, dueAtMs: 5 });
  });
  it.each([
    [{ state: "weird" }],
    [{ state: null }],
    [{ dead_reason: "NOPE" }],
    [{ tenant_id: 5 }],
    [{ tenant_id: null }],
    [{ reserved: "-1" }],
    [{ reserved: "1.5" }],
    [{ reserved: "9007199254740993" }],
    [{ reserved: "abc" }],
    [{ reserved: null }],
    [{ reserved: Number.NaN }],
    [{ orphan_remainder: "keep" }],
    [{ charge_attempt_id: "a1" }],
    [{ charge_amount: "1" }],
    [{ close_remainder: "release" }],
    [{ close_origin: "caller" }],
    [{ close_remainder: "keep", close_origin: "caller" }],
    [{ close_remainder: "release", close_origin: "someone" }],
    [{ last_error_code: 7 }],
    [{ settled_at_ms: "x" }],
  ])("ردیفِ خراب %j ⇒ پرتاب CORRUPT_DATA", (over) => {
    expect(() => entryFromRow(goodRow(over))).toThrowError(SettlementStoreError);
    try {
      entryFromRow(goodRow(over));
    } catch (e) {
      expect((e as SettlementStoreError).error.code).toBe("CORRUPT_DATA");
    }
  });
  it("readCount و countsFromRows", () => {
    expect(readCount("0")).toBe(0);
    expect(readCount(7)).toBe(7);
    expect(() => readCount("12345678901234567")).toThrow();
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "", "-0", " 1", "1 ", null, undefined, {}, true]) expect(() => readCount(bad), String(bad)).toThrow();
    expect(readCount(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(countsFromRows([])).toEqual({ open: 0, settling: 0, done: 0, dead: 0 });
    expect(countsFromRows([{ state: "done", n: "3" }, { state: "dead", n: "1" }])).toEqual({ open: 0, settling: 0, done: 3, dead: 1 });
    expect(Object.isFrozen(countsFromRows([]))).toBe(true);
    expect(() => countsFromRows([{ state: "zzz", n: "1" }])).toThrow();
    expect(() => countsFromRows([{ state: "done", n: "-1" }])).toThrow();
  });
});

describe("settlement/pg · مهاجرت‌ها", () => {
  it("فهرست و checksum قفل‌شده است: مهاجرتِ اعمال‌شده هرگز ویرایش نمی‌شود (تغییر = مهاجرت تازه)", () => {
    expect(MIGRATIONS.map((m) => m.name)).toEqual(["0001_init", "0002_dead_ack"]);
    expect(MIGRATIONS[0]?.statements).toHaveLength(12);
    expect(migrationChecksum(MIGRATIONS[0] as never)).toBe("83f50b96a70d576f9497a281c83c83a77dfd59faf40a6bef19847a16740de860");
  });
  it("checksum به نام و به هر دستور حساس است", () => {
    const a = { name: "0001_x", statements: ["A", "B"] };
    expect(migrationChecksum(a)).not.toBe(migrationChecksum({ ...a, name: "0002_x" }));
    expect(migrationChecksum(a)).not.toBe(migrationChecksum({ ...a, statements: ["A", "C"] }));
    expect(migrationChecksum(a)).not.toBe(migrationChecksum({ ...a, statements: ["B", "A"] }));
    expect(migrationChecksum(a)).toBe(migrationChecksum({ ...a }));
  });
  it("renderStatement همهٔ {{schema}} را با نامِ نقل‌قول‌شده جایگزین می‌کند", () => {
    expect(renderStatement("a {{schema}}.t b {{schema}}.u", "s_1")).toBe('a "s_1".t b "s_1".u');
    for (const m of MIGRATIONS) for (const st of m.statements) expect(renderStatement(st, "zz")).not.toContain("{{schema}}");
  });
  it("هر دستورِ مهاجرت به شِما وابسته است و هیچ مقدارِ داده‌ای یا now() در منطق نیست", () => {
    for (const m of MIGRATIONS) for (const st of m.statements) expect(st).toMatch(/\{\{schema\}\}/);
    expect(MIGRATIONS.flatMap((m) => m.statements).join("\n")).not.toMatch(/\bnow\s*\(/i);
  });
  it("شکلِ هر وضعیت، نوشتن‌یک‌بار، نهایی‌بودن و بی‌حذف در خودِ SQL اعلام شده است", () => {
    const all = (MIGRATIONS[0] as { statements: readonly string[] }).statements.join("\n");
    for (const needle of ["settlement_outbox_state_shape_ck", "settlement_outbox_charge_shape_ck", "settlement_outbox_close_shape_ck", "write-once", "finished record is final", "never deleted", "never truncated", "WHERE state IN ('open', 'settling')", 'COLLATE "C"', "BEFORE TRUNCATE", "BEFORE UPDATE OR DELETE"]) {
      expect(all, needle).toContain(needle);
    }
  });

  const mig = (name: string) => ({ name, statements: [`S ${name}`] });
  const list = [mig("0001_a"), mig("0002_b"), mig("0003_c")];
  const row = (m: { name: string; statements: readonly string[] }, checksum = migrationChecksum(m)) => ({ name: m.name, checksum });
  it("reconcile: خالی ⇒ همه معلق؛ پیشوندِ اعمال‌شده ⇒ بقیه معلق؛ کامل ⇒ هیچ معلق", () => {
    expect(reconcile([], list)).toEqual({ applied: [], pending: ["0001_a", "0002_b", "0003_c"] });
    expect(reconcile([row(list[0] as never)], list)).toEqual({ applied: ["0001_a"], pending: ["0002_b", "0003_c"] });
    expect(reconcile(list.map((m) => row(m)), list)).toEqual({ applied: ["0001_a", "0002_b", "0003_c"], pending: [] });
  });
  it("reconcile: مهاجرتِ ناشناخته ⇒ MIGRATION_UNKNOWN (پایگاه از نسخهٔ جدیدتر)", () => {
    try {
      reconcile([row(list[0] as never), row(mig("0009_future"))], list);
      throw new Error("باید می‌پرتابید");
    } catch (e) {
      expect((e as SettlementStoreError).error.code).toBe("MIGRATION_UNKNOWN");
    }
  });
  it("reconcile: checksum ناهمخوان و حفره ⇒ MIGRATION_TAMPERED", () => {
    for (const rows of [[row(list[0] as never, "0".repeat(64))], [row(list[0] as never), row(list[2] as never)]]) {
      try {
        reconcile(rows, list);
        throw new Error("باید می‌پرتابید");
      } catch (e) {
        expect((e as SettlementStoreError).error.code).toBe("MIGRATION_TAMPERED");
      }
    }
  });
});
