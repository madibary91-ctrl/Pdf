/**
 * settlement/pg · سقفِ زمانِ سمتِ پایگاه برای خواندن‌ها (ADR-0045، م۳‑ه‑۴‑الف‑۲‑۴‑آ) — بی‌پایگاهِ واقعی، روی `db`ِ جعلیِ ثبت‌کننده.
 * ثابت می‌کند: (۱) بدونِ گزینه هیچ دستورِ اضافه‌ای نیست؛ (۲) با گزینه، `set_config(..., is_local = true)` **نخستین** دستورِ هر تراکنشِ فقط‌خواندنی است،
 * مقدار پارامترِ پیوندی است و `SET` بی‌LOCAL هرگز نیست؛ (۳) هیچ نوشتنی سقف نمی‌گیرد؛ (۴) اعتبارسنجیِ گزینه شکست‌بسته و بی‌پژواکِ مقدار است؛
 * (۵) لغوِ پایگاه ⇒ `STORE_FAILURE` بی‌نشت. فایلِ تازه؛ هیچ آزمونِ موجودی دست نخورده. رفتارِ واقعیِ لغو در `read-timeout.pg.test.ts` است.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { LedgerDatabase, LedgerTransactionConfig } from "@/modules/ledger";
import { MIGRATIONS, migrationChecksum } from "./migrations";
import { PG_READ_STATEMENT_TIMEOUT_LIMITS, createPgSettlementOutbox, parseReadStatementTimeout } from "./store";
import type { PgSettlementOutboxOptions } from "./types";

const dialect = new PgDialect();
const CANARY = "LEAK-CANARY-readtimeout-7c1e";
/** رشتهٔ اتصالِ دارای قناری؛ عمداً تکه‌تکه ساخته می‌شود تا نگهبانِ اسرارِ مخزن آن را رمزِ واقعی نبیند. */
const SECRET = ["postgres", "://user:", CANARY, "@db.internal/prod"].join("");

type Logged = { text: string; params: unknown[]; tx: number };

/** `db` جعلی: هر دستور را با شمارهٔ تراکنشش ثبت می‌کند؛ `fail(text)` اگر پیام بدهد، همان پرتاب می‌شود. */
function stubDb(reply: (text: string) => readonly Record<string, unknown>[] = () => [], fail: (text: string) => string | null = () => null) {
  const log: Logged[] = [];
  const configs: (LedgerTransactionConfig | undefined)[] = [];
  let txCount = 0;
  const exec = (txNo: number) => async (query: SQL) => {
    const q = dialect.sqlToQuery(query);
    log.push({ text: q.sql, params: [...q.params], tx: txNo });
    const boom = fail(q.sql);
    if (boom !== null) throw new Error(boom);
    if (q.sql.includes("settlement_migration_ledger")) return { rows: MIGRATIONS.map((m) => ({ name: m.name, checksum: migrationChecksum(m) })) };
    return { rows: [...reply(q.sql)] };
  };
  const db: LedgerDatabase = {
    execute: exec(0),
    transaction: async (run, config) => {
      txCount += 1;
      configs.push(config);
      return run({ execute: exec(txCount) });
    },
  };
  return { db, log, configs };
}

const REF = { tenantId: "t1", accountId: "a1", reservationId: "r1" };
const BEGIN = { ...REF, unit: "IRR_MICROS", reserved: 5, createdAtMs: 1, expiresAtMs: 100, dueAtMs: 50, orphanRemainder: "forfeit" as const };

function outbox(db: LedgerDatabase, options: PgSettlementOutboxOptions = {}) {
  const made = createPgSettlementOutbox(db, options);
  if (!made.ok) throw new Error(made.error.code);
  return made.value;
}
const isBound = (l: Logged): boolean => l.text.includes("set_config");
const bound = (log: readonly Logged[]) => log.filter(isBound);

describe("settlement/pg · readStatementTimeoutMs · اعتبارسنجیِ گزینه", () => {
  it("حدها قفل‌اند: ۱ تا ۷٬۲۰۰٬۰۰۰ میلی‌ثانیه", () => {
    expect(PG_READ_STATEMENT_TIMEOUT_LIMITS).toEqual({ minMs: 1, maxMs: 7_200_000 });
    expect(Object.isFrozen(PG_READ_STATEMENT_TIMEOUT_LIMITS)).toBe(true);
  });
  it("نبودن ⇒ بی‌سقف (null)", () => {
    expect(parseReadStatementTimeout(undefined)).toEqual({ ok: true, value: null });
  });
  it.each([[1], [5_000], [6_000], [7_200_000]])("مقدارِ معتبر %j پذیرفته می‌شود", (v) => {
    expect(parseReadStatementTimeout(v)).toEqual({ ok: true, value: v });
  });
  it.each([[0], [-1], [7_200_001], [1.5], [Number.NaN], [Infinity], [2 ** 53], ["6000"], [null], [true], [{}], [[6000]], [() => 1]])(
    "مقدارِ نامعتبر %j ⇒ INVALID_INPUT و فقط نامِ گزینه در پیام",
    (v) => {
      const r = parseReadStatementTimeout(v);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("INVALID_INPUT");
        // پیامِ ثابت برای همهٔ ورودی‌ها ⇒ مقدار پژواک نمی‌شود.
        expect(r.error.message).toBe("readStatementTimeoutMs باید عددِ صحیحِ 1 تا 7200000 میلی‌ثانیه باشد.");
      }
    },
  );
  it("createPgSettlementOutbox گزینهٔ نامعتبر را رد می‌کند و هیچ دستوری به پایگاه نمی‌رود", () => {
    const s = stubDb();
    for (const bad of [0, -5, 1.2, "5", null, 10_000_000]) {
      const r = createPgSettlementOutbox(s.db, { readStatementTimeoutMs: bad as never });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
    }
    expect(s.log).toEqual([]);
  });
  it("نامِ شِمای نامعتبر هنوز پیش از گزینه رد می‌شود (ترتیبِ اعتبارسنجی بی‌تغییر)", () => {
    const r = createPgSettlementOutbox(stubDb().db, { schema: "public", readStatementTimeoutMs: 100 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("نام شِما");
  });
});

describe("settlement/pg · readStatementTimeoutMs · بدونِ گزینه رفتارِ امروز", () => {
  it("هیچ دستورِ set_config/statement_timeout در هیچ عملیاتی نیست", async () => {
    const s = stubDb();
    const o = outbox(s.db);
    await o.begin(BEGIN);
    await o.listDead({ limit: 5 });
    await o.listUnacknowledgedDead({ limit: 5 });
    await o.counts();
    await o.get(REF);
    expect(s.log.length).toBeGreaterThan(0);
    expect(s.log.some((l) => /statement_timeout|set_config/i.test(l.text))).toBe(false);
  });
  it("گزینهٔ undefined صریح هم بی‌سقف است", async () => {
    const s = stubDb();
    await outbox(s.db, { readStatementTimeoutMs: undefined }).listUnacknowledgedDead({ limit: 5 });
    expect(bound(s.log)).toEqual([]);
  });
});

describe("settlement/pg · readStatementTimeoutMs · فقط خواندن‌ها، نخستین دستور، پارامترِ پیوندی", () => {
  const reads: ReadonlyArray<readonly [string, (o: ReturnType<typeof outbox>) => Promise<unknown>]> = [
    ["listUnacknowledgedDead", (o) => o.listUnacknowledgedDead({ limit: 7 })],
    ["listDead", (o) => o.listDead({ limit: 7 })],
    ["counts", (o) => o.counts()],
    ["get", (o) => o.get(REF)],
  ];
  it.each(reads)("%s: نخستین دستورِ تراکنشِ فقط‌خواندنی set_config(statement_timeout, $1, true) است، پیش از سپرِ مهاجرت", async (_name, call) => {
    const s = stubDb();
    await call(outbox(s.db, { readStatementTimeoutMs: 6_000 }));
    expect(s.configs).toEqual([{ accessMode: "read only" }]);
    const first = s.log[0] as Logged;
    expect(first.tx).toBe(1);
    expect(first.text).toBe("SELECT set_config('statement_timeout', $1, true)");
    expect(first.params).toEqual(["6000"]);
    expect(bound(s.log)).toHaveLength(1);
    expect((s.log[1] as Logged).text).toContain("settlement_migration_ledger");
  });
  it("مقدار هرگز در متنِ SQL نیست (پارامترِ پیوندی) و SET بی‌LOCAL هرگز فرستاده نمی‌شود", async () => {
    const s = stubDb();
    const o = outbox(s.db, { readStatementTimeoutMs: 4_321 });
    for (const [, call] of reads) await call(o);
    await o.begin(BEGIN);
    for (const l of s.log) {
      expect(l.text).not.toContain("4321");
      expect(l.text).not.toMatch(/^\s*SET\s/i);
      expect(l.text).not.toMatch(/\bRESET\b/i);
    }
  });
  it("هر خواندن تراکنشِ خودش را دارد و سقفِ خودش را می‌گذارد (سقف از تراکنشِ قبلی به ارث نمی‌رسد)", async () => {
    const s = stubDb();
    const o = outbox(s.db, { readStatementTimeoutMs: 100 });
    await o.listUnacknowledgedDead({ limit: 5 });
    await o.listUnacknowledgedDead({ limit: 5 });
    const calls = bound(s.log);
    expect(calls.map((c) => c.tx)).toEqual([1, 2]);
  });
  it("حدِ بالا و پایین با همان مقدار فرستاده می‌شود", async () => {
    for (const ms of [1, 7_200_000]) {
      const s = stubDb();
      await outbox(s.db, { readStatementTimeoutMs: ms }).counts();
      expect((bound(s.log)[0] as Logged).params).toEqual([String(ms)]);
    }
  });
});

describe("settlement/pg · readStatementTimeoutMs · نوشتن‌ها هرگز سقف نمی‌گیرند", () => {
  it("begin/recordCharge/recordClose/resolveClose/finish/bury/acknowledgeDead: هیچ set_config و تراکنشِ read write", async () => {
    const row = {
      tenant_id: "t1",
      account_id: "a1",
      reservation_id: "r1",
      unit: "IRR_MICROS",
      reserved: "5",
      created_at_ms: "1",
      expires_at_ms: "100",
      due_at_ms: "50",
      orphan_remainder: "forfeit",
      state: "open",
    };
    const s = stubDb((text) => (/SELECT .* FROM/.test(text) || /RETURNING/.test(text) ? [row] : []));
    const o = outbox(s.db, { readStatementTimeoutMs: 6_000 });
    await o.begin(BEGIN);
    await o.recordCharge(REF, { attemptId: "att-1", amount: 3 });
    await o.recordClose(REF, { remainder: "release", origin: "caller" });
    await o.resolveClose(REF);
    await o.finish(REF, 60);
    await o.bury(REF, { reason: "LEDGER_REJECTED", errorCode: null, atMs: 70 });
    await o.acknowledgeDead(REF, { atMs: 80 });
    expect(s.log.length).toBeGreaterThan(7);
    expect(bound(s.log)).toEqual([]);
    expect(s.configs.every((c) => c === undefined)).toBe(true);
  });
});

describe("settlement/pg · readStatementTimeoutMs · لغوِ پایگاه ⇒ STORE_FAILURE بی‌نشت", () => {
  it("پرتابِ 57014 در پرسشِ اصلی ⇒ STORE_FAILURE با پیامِ ثابت (بی‌رشتهٔ اتصال و بی‌متنِ خطای پایگاه)", async () => {
    const s = stubDb(
      () => [],
      (text) => (text.includes('FROM "settlement"."settlement_outbox"') ? `57014 canceling statement due to statement timeout ${SECRET}` : null),
    );
    const r = await outbox(s.db, { readStatementTimeoutMs: 10 }).listUnacknowledgedDead({ limit: 5 });
    expect(r).toEqual({ ok: false, error: { code: "STORE_FAILURE", message: "ذخیرهٔ outbox در دسترس نیست." } });
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(JSON.stringify(r)).not.toContain("57014");
  });
  it("شکستِ خودِ set_config ⇒ STORE_FAILURE و پرسشِ اصلی هرگز فرستاده نمی‌شود (شکست‌بسته، نه بی‌سقف)", async () => {
    const s = stubDb(
      () => [],
      (text) => (text.includes("set_config") ? `boom ${SECRET}` : null),
    );
    const r = await outbox(s.db, { readStatementTimeoutMs: 10 }).listUnacknowledgedDead({ limit: 5 });
    expect(r).toEqual({ ok: false, error: { code: "STORE_FAILURE", message: "ذخیرهٔ outbox در دسترس نیست." } });
    expect(s.log.map((l) => l.text).some((t) => t.includes("settlement_outbox"))).toBe(false);
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });
  it("ورودیِ نامعتبرِ خواندن هیچ تراکنشی (و هیچ set_config) نمی‌سازد", async () => {
    const s = stubDb();
    const r = await outbox(s.db, { readStatementTimeoutMs: 10 }).listUnacknowledgedDead({ limit: 0 });
    expect(r.ok).toBe(false);
    expect(s.log).toEqual([]);
  });
});
