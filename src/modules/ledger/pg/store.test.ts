/**
 * آزمون‌های ویژهٔ PostgreSQL (ADR-0019) روی پایگاه واقعی و پیکربندی محصول: مهاجرت و سپر، ماندگاری، هم‌زمانی روی سرویس،
 * رد شدنِ دورزدن‌ها توسط خودِ پایگاه، اتمی‌بودن، دادهٔ خراب (شکست بسته)، ممیزی و مرزها.
 * هر فایل شِمای یک‌بارمصرف دارد؛ به `public` و شِمای واقعی `ledger` دست نمی‌زند.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { ID_RE, UNIT_RE } from "../validate";
import type { AccountKey, AccountState, Commit, Processed, Reservation, TransactOutcome } from "../types";
import { A, T, UNIT, code, mutableClock, must, openFunded, run, setup, val } from "../test-kit";
import { LedgerStoreError } from "./errors";
import { createPgAccountStore } from "./index";
import { buildPgStore } from "./store";
import { TEST_DB_URL, dbDescribe, openTestLedgerDb, type OpenOptions, type TestLedgerDb } from "./test-db";

const KEY: AccountKey = { tenantId: T, accountId: A };
const base = { tenantId: T, accountId: A } as const;

async function thrown(p: Promise<unknown>): Promise<LedgerStoreError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(LedgerStoreError);
    return e as LedgerStoreError;
  }
  throw new Error("انتظار رد شدن می‌رفت");
}

const pgCode = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};

const count = async (t: TestLedgerDb, table: string, where = "true"): Promise<number> => Number((await t.raw(`SELECT count(*) AS n FROM {{schema}}.${table} WHERE ${where}`))[0]?.["n"]);

/** حساب با اعطا، دو رزرو (یکی باز با مصرف و بازگشت، یکی بسته)، برای آزمون‌های دفاع پایگاه. */
async function scenario(t: TestLedgerDb) {
  const clock = mutableClock();
  const { ledger } = setup(t.store, clock);
  await openFunded(ledger, 1000);
  val(await ledger.reserve({ ...base, reservationId: "r1", unit: UNIT, amount: 300, ttlMs: 60_000 }));
  val(await ledger.charge({ ...base, reservationId: "r1", attemptId: "x1", unit: UNIT, amount: 120 }));
  val(await ledger.reserve({ ...base, reservationId: "r2", unit: UNIT, amount: 100, ttlMs: 60_000 }));
  val(await ledger.close({ ...base, reservationId: "r2", remainder: "release" }));
  val(await ledger.refund({ ...base, refundId: "f1", reservationId: "r1", attemptId: "x1", unit: UNIT, amount: 20 }));
  // رزروِ بسته‌ای که تلاشِ مصرف‌شده دارد (بازگشت پس از بسته‌شدن مجاز است).
  val(await ledger.reserve({ ...base, reservationId: "r3", unit: UNIT, amount: 50, ttlMs: 60_000 }));
  val(await ledger.charge({ ...base, reservationId: "r3", attemptId: "x9", unit: UNIT, amount: 30 }));
  val(await ledger.close({ ...base, reservationId: "r3", remainder: "release" }));
  // رزروِ بسته با forfeit (totals.forfeited > 0) و رزروی که مصرفش از رزرو بیشتر شد (totals.shortfall > 0).
  val(await ledger.reserve({ ...base, reservationId: "r4", unit: UNIT, amount: 40, ttlMs: 60_000 }));
  val(await ledger.charge({ ...base, reservationId: "r4", attemptId: "x1", unit: UNIT, amount: 25 }));
  val(await ledger.close({ ...base, reservationId: "r4", remainder: "forfeit" }));
  // رزروی که کاملاً مصرف و سپس بسته شد (باقیمانده و closed_amount صفر): بازکردنش را فقط «بسته نهایی است» می‌تواند بگیرد.
  val(await ledger.reserve({ ...base, reservationId: "r6", unit: UNIT, amount: 10, ttlMs: 60_000 }));
  val(await ledger.charge({ ...base, reservationId: "r6", attemptId: "x1", unit: UNIT, amount: 10 }));
  val(await ledger.close({ ...base, reservationId: "r6", remainder: "release" }));
  val(await ledger.reserve({ ...base, reservationId: "r5", unit: UNIT, amount: 10, ttlMs: 60_000 }));
  val(await ledger.charge({ ...base, reservationId: "r5", attemptId: "x1", unit: UNIT, amount: 25 }));
  return { ledger, clock };
}

function tracker() {
  const opened: TestLedgerDb[] = [];
  const pools: Pool[] = [];
  afterAll(async () => {
    for (const p of pools) await p.end();
    for (const t of opened) await t.drop();
  });
  return {
    open: async (o: OpenOptions = {}) => {
      const t = await openTestLedgerDb(o);
      opened.push(t);
      return t;
    },
    /** فرایند دومِ مستقل: استخر اتصال تازه روی همان شِما. */
    second: (schema: string, semantic = true) => {
      const pool = new Pool({ connectionString: TEST_DB_URL, max: 5 });
      pools.push(pool);
      return buildPgStore(drizzle(pool), schema, semantic);
    },
  };
}

dbDescribe("ledger/pg · مهاجرت و سپر مهاجرت", () => {
  const { open } = tracker();

  it("پیش از migrate همه معلق؛ migrate اعمال می‌کند؛ بار دوم بی‌کار (idempotent)", async () => {
    const t = await open({ migrate: false });
    expect(await t.store.status()).toEqual({ ok: true, value: { applied: [], pending: ["0001_init"] } });
    expect(await t.store.migrate()).toEqual({ ok: true, value: { applied: ["0001_init"], alreadyApplied: [] } });
    expect(await t.store.migrate()).toEqual({ ok: true, value: { applied: [], alreadyApplied: ["0001_init"] } });
    expect(await t.store.status()).toEqual({ ok: true, value: { applied: ["0001_init"], pending: [] } });
    expect(await count(t, "migration_ledger")).toBe(1);
  });

  it("۶ migrate هم‌زمان روی شِمای تازه: همه موفق، دقیقاً یکی اعمال می‌کند", async () => {
    const t = await open({ migrate: false });
    const rs = await Promise.all(Array.from({ length: 6 }, () => t.store.migrate()));
    expect(rs.every((r) => r.ok)).toBe(true);
    const applied = rs.map((r) => (r.ok ? r.value.applied.length : -1));
    expect(applied.filter((n) => n === 1)).toHaveLength(1);
    expect(applied.filter((n) => n === 0)).toHaveLength(5);
    expect(await count(t, "migration_ledger")).toBe(1);
  });

  it("پس از migrate، همهٔ جدول‌ها فقط در شِمای خودش‌اند (به public هیچ‌چیز اضافه نمی‌شود)", async () => {
    const t = await open();
    const rows = await t.raw("SELECT table_schema, table_name FROM information_schema.tables WHERE table_name IN ('account','reservation','processed','journal','migration_ledger') AND table_schema = $1", [t.schema]);
    expect(rows.map((r) => r["table_name"]).sort()).toEqual(["account", "journal", "migration_ledger", "processed", "reservation"]);
    const leaked = await t.raw("SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('journal','processed','reservation')");
    expect(leaked).toEqual([]);
  });

  it("دست‌کاریِ checksum ⇒ MIGRATION_TAMPERED در migrate/status و در **هر** عملیات؛ سرویس STORE_FAILURE", async () => {
    const t = await open();
    await t.raw("UPDATE {{schema}}.migration_ledger SET checksum = 'tampered'");
    const m = await t.store.migrate();
    expect(m).toMatchObject({ ok: false, error: { code: "MIGRATION_TAMPERED" } });
    expect(await t.store.status()).toMatchObject({ ok: false, error: { code: "MIGRATION_TAMPERED" } });
    expect((await thrown(t.store.transact(KEY, () => ({ commit: null, value: 1 })))).error.code).toBe("MIGRATION_TAMPERED");
    expect((await thrown(t.store.read(KEY))).error.code).toBe("MIGRATION_TAMPERED");
    expect((await thrown(t.store.journal(KEY))).error.code).toBe("MIGRATION_TAMPERED");
    expect(await t.store.audit(KEY)).toMatchObject({ ok: false, error: { code: "MIGRATION_TAMPERED" } });
    const { ledger } = setup(t.store, mutableClock());
    expect(code(await ledger.openAccount({ ...base, unit: UNIT }))).toBe("STORE_FAILURE");
    expect(await count(t, "account")).toBe(0);
  });

  it("پایگاهِ از آینده (مهاجرتِ ناشناخته) ⇒ MIGRATION_UNKNOWN؛ فروشگاه چیزی نمی‌نویسد", async () => {
    const t = await open();
    await t.raw("INSERT INTO {{schema}}.migration_ledger (name, checksum) VALUES ('9999_future', 'x')");
    expect(await t.store.migrate()).toMatchObject({ ok: false, error: { code: "MIGRATION_UNKNOWN" } });
    expect((await thrown(t.store.transact(KEY, () => ({ commit: null, value: 1 })))).error.code).toBe("MIGRATION_UNKNOWN");
  });

  it("بدون migrate: هر عملیات NOT_MIGRATED (فروشگاه خودش مهاجرت نمی‌کند)؛ سرویس STORE_FAILURE و هیچ شِمایی ساخته نمی‌شود", async () => {
    const t = await open({ migrate: false });
    expect((await thrown(t.store.transact(KEY, () => ({ commit: null, value: 1 })))).error.code).toBe("NOT_MIGRATED");
    expect((await thrown(t.store.read(KEY))).error.code).toBe("NOT_MIGRATED");
    expect((await thrown(t.store.journal(KEY))).error.code).toBe("NOT_MIGRATED");
    expect(await t.store.audit(KEY)).toMatchObject({ ok: false, error: { code: "NOT_MIGRATED" } });
    const { ledger } = setup(t.store, mutableClock());
    expect(code(await ledger.openAccount({ ...base, unit: UNIT }))).toBe("STORE_FAILURE");
    expect(await t.raw("SELECT 1 FROM information_schema.schemata WHERE schema_name = $1", [t.schema])).toEqual([]);
  });

  it("مهاجرت معلق (دفتر خالیِ موجود) ⇒ NOT_MIGRATED با پیام مهاجرت معلق", async () => {
    const t = await open({ migrate: false });
    await t.raw("CREATE SCHEMA {{schema}}");
    await t.raw("CREATE TABLE {{schema}}.migration_ledger (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    const e = await thrown(t.store.read(KEY));
    expect(e.error.code).toBe("NOT_MIGRATED");
    expect(e.error.message).toContain("0001_init");
  });

  it("migrate روی مجوزِ ناکافی/اتصال خراب رشتهٔ اتصال یا SQL را نشت نمی‌دهد", async () => {
    const pool = new Pool({ host: "127.0.0.1", port: 1, user: "nobody", password: "nopass", database: "none", max: 1, connectionTimeoutMillis: 500 });
    const made = createPgAccountStore(drizzle(pool));
    expect(made.ok).toBe(true);
    if (made.ok) {
      const r = await made.value.migrate();
      expect(r).toMatchObject({ ok: false, error: { code: "DB_ERROR" } });
      expect(JSON.stringify(r)).not.toMatch(/nopass|nobody|127\.0\.0\.1|postgresql:/);
      const e = await thrown(made.value.read(KEY));
      expect(e.error.code).toBe("DB_ERROR");
      expect(JSON.stringify(e.error)).not.toMatch(/nopass|nobody|127\.0\.0\.1|postgresql:/);
    }
    await pool.end().catch(() => undefined);
  });
});

dbDescribe("ledger/pg · createPgAccountStore (مرز ورودی)", () => {
  const { open } = tracker();
  it("db و options نامعتبر یا شِمای نامعتبر ⇒ INVALID_INPUT بی‌پرتاب و بی‌پژواک", async () => {
    const t = await open();
    for (const bad of [undefined, null, 1, "x", {}, { execute: () => 1 }, { transaction: () => 1 }]) {
      expect(createPgAccountStore(bad as never)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    }
    expect(createPgAccountStore(t.db, null as never)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    for (const schema of ["public", "Ledger", "pg_x", "a;b", "", 5]) {
      expect(createPgAccountStore(t.db, { schema: schema as never })).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    }
  });
  it("پیش‌فرض شِمای `ledger` است و ساختنِ فروشگاه هیچ SQL اجرا نمی‌کند", async () => {
    const t = await open();
    const made = createPgAccountStore(t.db);
    expect(made.ok).toBe(true);
    const other = createPgAccountStore(t.db, { schema: t.schema });
    expect(other.ok).toBe(true);
    if (other.ok) expect(await other.value.status()).toEqual({ ok: true, value: { applied: ["0001_init"], pending: [] } });
  });
  it("کلید نامعتبر در پورت ⇒ INVALID_INPUT و fn هرگز صدا زده نمی‌شود؛ تزریق SQL به پایگاه نمی‌رسد", async () => {
    const t = await open();
    let called = 0;
    for (const bad of [
      { tenantId: "t'; DROP TABLE x;--", accountId: "a" },
      { tenantId: "t", accountId: "a b" },
      { tenantId: "", accountId: "a" },
      { tenantId: "t", accountId: "a".repeat(129) },
      { tenantId: 1, accountId: "a" },
      { tenantId: "t" },
      null,
      undefined,
      "t/a",
    ]) {
      expect((await thrown(t.store.transact(bad as never, () => (called++, { commit: null, value: 0 })))).error.code).toBe("INVALID_INPUT");
      expect((await thrown(t.store.read(bad as never))).error.code).toBe("INVALID_INPUT");
      expect((await thrown(t.store.journal(bad as never))).error.code).toBe("INVALID_INPUT");
      expect(await t.store.audit(bad as never)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    }
    expect(called).toBe(0);
    expect(await count(t, "account")).toBe(0);
  });
});

dbDescribe("ledger/pg · ماندگاری (ریستارت)", () => {
  const { open, second } = tracker();

  it("حالت، ژورنال و رسیدهای بازتکرار با فروشگاه و اتصالِ تازه دست‌نخورده‌اند؛ بازتکرار بی‌اثر است", async () => {
    const t = await open();
    const { ledger, clock } = await scenario(t);
    const stateBefore = (await t.store.read(KEY)) as AccountState;
    const journalBefore = await t.store.journal(KEY);
    expect(checkInvariantsOk(stateBefore)).toBe(true);

    const store2 = second(t.schema);
    const ledger2 = setup(store2, clock).ledger;
    expect(await store2.read(KEY)).toEqual(stateBefore);
    expect(await store2.journal(KEY)).toEqual(journalBefore);

    // همان فرمان‌ها با همان شناسه ⇒ همان رسید، replayed: true، بی‌هیچ اثر.
    const r1 = val(await ledger2.reserve({ ...base, reservationId: "r1", unit: UNIT, amount: 300, ttlMs: 60_000 }));
    expect(r1.replayed).toBe(true);
    const c1 = val(await ledger2.charge({ ...base, reservationId: "r1", attemptId: "x1", unit: UNIT, amount: 120 }));
    expect(c1).toMatchObject({ replayed: true, charged: 120, shortfall: 0 });
    expect(code(await ledger2.close({ ...base, reservationId: "r2", remainder: "release" }))).toBe("ok");
    expect(code(await ledger2.refund({ ...base, refundId: "f1", reservationId: "r1", attemptId: "x1", unit: UNIT, amount: 21 }))).toBe("IDEMPOTENCY_CONFLICT");
    expect(await store2.read(KEY)).toEqual(stateBefore);
    expect(await store2.journal(KEY)).toEqual(journalBefore);
    expect(val(await ledger.balance(KEY))).toEqual(val(await ledger2.balance(KEY)));
    expect(await store2.audit(KEY)).toEqual({ ok: true, value: { exists: true, ok: true, journalEntries: journalBefore.length, problems: [] } });
  });

  it("پس از ریستارت ادامهٔ کار روی همان حالت ممکن است و seq پیوسته می‌ماند", async () => {
    const t = await open();
    const { clock } = await scenario(t);
    const before = (await t.store.journal(KEY)).length;
    const ledger2 = setup(second(t.schema), clock).ledger;
    clock.advance(10);
    val(await ledger2.grant({ ...base, grantId: "g-late", unit: UNIT, amount: 7, source: "promo" }));
    const j = await t.store.journal(KEY);
    expect(j.map((e) => e.seq)).toEqual(Array.from({ length: before + 1 }, (_, i) => i + 1));
    expect(await t.store.audit(KEY)).toMatchObject({ ok: true, value: { ok: true } });
  });
});

function checkInvariantsOk(s: AccountState): boolean {
  // کوچک‌ترین بررسی مستقل: بقا (همان رابطه‌ای که CHECK پایگاه اجرا می‌کند).
  return s.totals.granted + s.totals.refunded === s.available + s.held + s.totals.charged + s.totals.forfeited;
}

dbDescribe("ledger/pg · هم‌زمانی روی سرویس واقعی", () => {
  const { open, second } = tracker();

  it("۵۰ reserve موازی با مبلغ ۱۰۰ روی موجودی ۱۰۰۰ ⇒ دقیقاً ۱۰ موفق، ۴۰ INSUFFICIENT_CREDIT؛ موجودی هرگز منفی نمی‌شود", async () => {
    const t = await open();
    const { ledger } = setup(t.store, mutableClock());
    await openFunded(ledger, 1000);
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => ledger.reserve({ ...base, reservationId: `r${i}`, unit: UNIT, amount: 100, ttlMs: 60_000 })));
    expect(rs.filter((r) => r.ok)).toHaveLength(10);
    expect(rs.filter((r) => !r.ok && r.error.code === "INSUFFICIENT_CREDIT")).toHaveLength(40);
    expect(val(await ledger.balance(KEY))).toMatchObject({ available: 0, held: 1000, openReservations: 10 });
    expect(await t.store.audit(KEY)).toMatchObject({ ok: true, value: { ok: true } });
  });

  it("دو فرایند مستقل (دو استخر اتصال): ۴۰ reserve موازی ⇒ باز هم دقیقاً ۱۰ موفق", async () => {
    const t = await open();
    const clock = mutableClock();
    const a = setup(t.store, clock).ledger;
    const b = setup(second(t.schema), clock).ledger;
    await openFunded(a, 1000);
    const rs = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? a : b).reserve({ ...base, reservationId: `r${i}`, unit: UNIT, amount: 100, ttlMs: 60_000 })));
    expect(rs.filter((r) => r.ok)).toHaveLength(10);
    expect(rs.filter((r) => !r.ok && r.error.code === "INSUFFICIENT_CREDIT")).toHaveLength(30);
    expect(val(await a.balance(KEY))).toMatchObject({ available: 0, held: 1000 });
    expect(await t.store.audit(KEY)).toMatchObject({ ok: true, value: { ok: true } });
  });

  it("۳۰ charge موازی با (reservationId, attemptId) یکسان ⇒ دقیقاً یک اثر و ۲۹ بازتکرار", async () => {
    const t = await open();
    const { ledger } = setup(t.store, mutableClock());
    await openFunded(ledger, 1000);
    val(await ledger.reserve({ ...base, reservationId: "r1", unit: UNIT, amount: 500, ttlMs: 60_000 }));
    const rs = await Promise.all(Array.from({ length: 30 }, () => ledger.charge({ ...base, reservationId: "r1", attemptId: "x1", unit: UNIT, amount: 40 })));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(rs.filter((r) => r.ok && !r.value.replayed)).toHaveLength(1);
    expect(rs.filter((r) => r.ok && r.value.replayed)).toHaveLength(29);
    expect(await count(t, "journal", "type = 'charge'")).toBe(1);
    const s = (await t.store.read(KEY)) as AccountState;
    expect(s.totals.charged).toBe(40);
    expect(s.reservations["r1"]).toMatchObject({ charged: 40, remaining: 460 });
  });

  it("تلاش‌های متفاوتِ هم‌زمان روی یک رزرو همگی شمرده می‌شوند و مصرف کل از رزرو بیشتر نمی‌شود (کسری ثبت می‌شود)", async () => {
    const t = await open();
    const { ledger } = setup(t.store, mutableClock());
    await openFunded(ledger, 1000);
    val(await ledger.reserve({ ...base, reservationId: "r1", unit: UNIT, amount: 100, ttlMs: 60_000 }));
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => ledger.charge({ ...base, reservationId: "r1", attemptId: `x${i}`, unit: UNIT, amount: 30 })));
    const oks = rs.filter((r) => r.ok);
    // حداکثر ۱۶ تلاش مجاز است؛ ۱۰ تلاش همه ثبت می‌شوند.
    expect(oks).toHaveLength(10);
    const s = (await t.store.read(KEY)) as AccountState;
    expect(s.totals.charged).toBe(100);
    expect(s.totals.shortfall).toBe(10 * 30 - 100);
    expect(s.held).toBe(0);
    expect(Object.keys((s.reservations["r1"] as { attempts: object }).attempts)).toHaveLength(10);
    expect(await t.store.audit(KEY)).toMatchObject({ ok: true, value: { ok: true } });
  });

  it("۱۰ openAccount هم‌زمان برای یک حسابِ نو ⇒ یک حساب، یکی replayed: false و بقیه replayed: true", async () => {
    const t = await open();
    const { ledger } = setup(t.store, mutableClock());
    const rs = await Promise.all(Array.from({ length: 10 }, () => ledger.openAccount({ ...base, unit: UNIT })));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(rs.filter((r) => r.ok && !r.value.replayed)).toHaveLength(1);
    expect(await count(t, "account")).toBe(1);
  });

  it("openAccount هم‌زمان با واحدِ متفاوت ⇒ یک برنده؛ بقیه IDEMPOTENCY_CONFLICT یا بازتکرار؛ واحد حساب هرگز عوض نمی‌شود", async () => {
    const t = await open();
    const { ledger } = setup(t.store, mutableClock());
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => ledger.openAccount({ ...base, unit: i % 2 === 0 ? "AAA" : "BBB" })));
    const winners = rs.filter((r) => r.ok && !r.value.replayed);
    expect(winners).toHaveLength(1);
    const unit = ((await t.store.read(KEY)) as AccountState).unit;
    expect(["AAA", "BBB"]).toContain(unit);
    for (const r of rs) {
      if (!r.ok) expect(r.error.code).toBe("IDEMPOTENCY_CONFLICT");
    }
  });

  it("حساب‌های مستقل موازی هیچ‌وقت روی هم صف نمی‌کشند و هرکدام سالم می‌ماند (بدون بن‌بست)", async () => {
    const t = await open();
    const { ledger } = setup(t.store, mutableClock());
    const accts = Array.from({ length: 6 }, (_, i) => ({ tenantId: i % 2 === 0 ? "ta" : "tb", accountId: `acct${i}` }));
    for (const k of accts) await openFunded(ledger, 500, k.tenantId, k.accountId);
    const all = accts.flatMap((k) => Array.from({ length: 12 }, (_, i) => ledger.reserve({ ...k, reservationId: `r${i}`, unit: UNIT, amount: 50, ttlMs: 60_000 })));
    const rs = await Promise.all(all);
    expect(rs.filter((r) => r.ok)).toHaveLength(accts.length * 10);
    for (const k of accts) {
      expect(val(await ledger.balance(k))).toMatchObject({ available: 0, held: 500 });
      expect(await t.store.audit(k)).toMatchObject({ ok: true, value: { ok: true } });
    }
  });

  it("ترکیب تصادفیِ هم‌زمانِ grant/reserve/charge/close/refund/balance روی یک حساب: ناوردا و بازپخش ژورنال سالم", async () => {
    const t = await open();
    const clock = mutableClock();
    const { ledger } = setup(t.store, clock);
    await openFunded(ledger, 5000);
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 12; i++) {
      ops.push(ledger.reserve({ ...base, reservationId: `r${i}`, unit: UNIT, amount: 200, ttlMs: 60_000 }));
      ops.push(ledger.charge({ ...base, reservationId: `r${i}`, attemptId: `x${i}`, unit: UNIT, amount: 150 }));
      ops.push(ledger.grant({ ...base, grantId: `g${i}`, unit: UNIT, amount: 25, source: "promo" }));
      ops.push(ledger.close({ ...base, reservationId: `r${i}`, remainder: i % 2 === 0 ? "release" : "forfeit" }));
      ops.push(ledger.refund({ ...base, refundId: `f${i}`, reservationId: `r${i}`, attemptId: `x${i}`, unit: UNIT, amount: 10 }));
      ops.push(ledger.balance(KEY));
    }
    await Promise.all(ops);
    const audit = await t.store.audit(KEY);
    expect(audit).toMatchObject({ ok: true, value: { ok: true, problems: [] } });
    const s = (await t.store.read(KEY)) as AccountState;
    expect(s.seq).toBe((await t.store.journal(KEY)).length);
  });
});

dbDescribe("ledger/pg · پایگاه هر دورزدن را رد می‌کند (دفاع در عمق)", () => {
  const { open } = tracker();
  const withScenario = async () => {
    const t = await open();
    await scenario(t);
    return t;
  };
  const entry = (seq: number) =>
    `INSERT INTO {{schema}}.journal (tenant_id, account_id, seq, at_ms, type, amount, shortfall, available_after, held_after) VALUES ('${T}', '${A}', ${seq}, 1, 'grant', 1, 0, 1, 0)`;

  it("ژورنال: UPDATE / DELETE / TRUNCATE ممنوع (حتی برای SQL مستقیم)", async () => {
    const t = await withScenario();
    const n = await count(t, "journal");
    expect(await pgCode(t.raw("UPDATE {{schema}}.journal SET amount = amount + 1"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.journal SET seq = seq + 100"))).toBe("23000");
    expect(await pgCode(t.raw("DELETE FROM {{schema}}.journal"))).toBe("23000");
    expect(await pgCode(t.raw("DELETE FROM {{schema}}.journal WHERE seq = 1"))).toBe("23000");
    expect(await pgCode(t.raw("TRUNCATE {{schema}}.journal"))).toBe("23000");
    expect(await count(t, "journal")).toBe(n);
  });

  it("کلیدهای یکتایی عملیات: UPDATE / DELETE / TRUNCATE ممنوع", async () => {
    const t = await withScenario();
    const n = await count(t, "processed");
    expect(n).toBeGreaterThan(3);
    expect(await pgCode(t.raw("UPDATE {{schema}}.processed SET fingerprint = 'x'"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.processed SET receipt = '{\"kind\":\"grant\"}'::jsonb"))).toBe("23000");
    expect(await pgCode(t.raw("DELETE FROM {{schema}}.processed"))).toBe("23000");
    expect(await pgCode(t.raw("TRUNCATE {{schema}}.processed"))).toBe("23000");
    expect(await count(t, "processed")).toBe(n);
  });

  it("حساب و رزرو: TRUNCATE و DELETE ممنوع", async () => {
    const t = await withScenario();
    const [a, r] = [await count(t, "account"), await count(t, "reservation")];
    for (const stmt of ["TRUNCATE {{schema}}.account", "TRUNCATE {{schema}}.reservation", "DELETE FROM {{schema}}.account", "DELETE FROM {{schema}}.reservation", "DELETE FROM {{schema}}.reservation WHERE status = 'closed'"]) {
      expect(await pgCode(t.raw(stmt)), stmt).toBeDefined();
    }
    expect([await count(t, "account"), await count(t, "reservation")]).toEqual([a, r]);
  });

  it("ورودیِ ژورنال با seq حفره‌دار، تکراری یا بازگشتی رد می‌شود؛ دقیقاً max+1 پذیرفته می‌شود", async () => {
    const t = await withScenario();
    const max = Number((await t.raw("SELECT max(seq) AS m FROM {{schema}}.journal"))[0]?.["m"]);
    expect(await pgCode(t.raw(entry(max + 2)))).toBe("23000"); // حفره
    expect(await pgCode(t.raw(entry(max)))).toBe("23000"); // تکرار
    expect(await pgCode(t.raw(entry(1)))).toBe("23000"); // بازگشت
    expect(await pgCode(t.raw(entry(0)))).toBeDefined(); // seq ≥ ۱
    expect(await count(t, "journal")).toBe(max);
    await t.raw(entry(max + 1)); // مسیر خوشحال: خودِ SQL مستقیم هم اگر بی‌حفره باشد می‌گذرد (ناورداهای بقا را CHECK حساب نگه می‌دارد)
    expect(await count(t, "journal")).toBe(max + 1);
    // ... ولی ممیزی ناسازگاریِ ژورنال با حالت را می‌گیرد.
    const audit = await t.store.audit(KEY);
    expect(audit).toMatchObject({ ok: true, value: { ok: false } });
  });

  it("ورودیِ ژورنال: نوع نامعتبر و shortfall غیر charge رد می‌شود", async () => {
    const t = await withScenario();
    const max = Number((await t.raw("SELECT max(seq) AS m FROM {{schema}}.journal"))[0]?.["m"]);
    const row = (type: string, shortfall: number) =>
      `INSERT INTO {{schema}}.journal (tenant_id, account_id, seq, at_ms, type, amount, shortfall, available_after, held_after) VALUES ('${T}', '${A}', ${max + 1}, 1, '${type}', 1, ${shortfall}, 1, 0)`;
    expect(await pgCode(t.raw(row("steal", 0)))).toBe("23514");
    expect(await pgCode(t.raw(row("grant", 5)))).toBe("23514");
    expect(await count(t, "journal")).toBe(max);
  });

  it("حساب: شکستن بقا (ساختن اعتبار از هیچ) رد می‌شود", async () => {
    const t = await withScenario();
    expect(await pgCode(t.raw("UPDATE {{schema}}.account SET available = available + 1"))).toBe("23514");
    expect(await pgCode(t.raw("UPDATE {{schema}}.account SET held = held + 1"))).toBe("23514");
    expect(await pgCode(t.raw("UPDATE {{schema}}.account SET available = available - 1"))).toBe("23514");
    expect(await pgCode(t.raw("UPDATE {{schema}}.account SET charged = charged + 1"))).toBe("23514");
    expect(await pgCode(t.raw("UPDATE {{schema}}.account SET available = -1"))).toBeDefined();
    const c = await t.raw("SELECT conname FROM pg_constraint WHERE conname = 'account_conservation_ck' AND connamespace = $1::regnamespace", [t.schema]);
    expect(c).toHaveLength(1);
  });

  it("حساب: seq/ساعت/totals هرگز کم نمی‌شوند حتی اگر بقا حفظ شود؛ unit و زمان ساخت و کلید تغییرناپذیرند؛ حذف ممنوع", async () => {
    const t = await withScenario();
    expect(await pgCode(t.raw("UPDATE {{schema}}.account SET seq = seq - 1"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.account SET last_at_ms = last_at_ms - 1"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.account SET granted = granted - 1, available = available - 1"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.account SET refunded = refunded - 1, available = available - 1"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.account SET charged = charged - 1, available = available + 1"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.account SET forfeited = forfeited - 1, available = available + 1"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.account SET shortfall = shortfall - 1"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.account SET shortfall = shortfall"))).toBeUndefined(); // بی‌تغییر کاهش نیست
    expect(await pgCode(t.raw("UPDATE {{schema}}.account SET unit = 'OTHER'"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.account SET created_at_ms = created_at_ms + 1"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.account SET account_id = 'zzz'"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.account SET tenant_id = 'zzz'"))).toBe("23000");
    expect(await pgCode(t.raw("DELETE FROM {{schema}}.account"))).toBe("23000");
  });

  it("رزرو: حسابداری درونی، تغییرناپذیری مبلغ/سررسید، «بسته نهایی است»، و بازکردن رزرو بسته رد می‌شود", async () => {
    const t = await withScenario();
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET remaining = remaining + 1 WHERE reservation_id = 'r1'"))).toBe("23514");
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET amount = amount + 1, remaining = remaining + 1 WHERE reservation_id = 'r1'"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET expires_at_ms = expires_at_ms + 1000 WHERE reservation_id = 'r1'"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET created_at_ms = 0"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET reservation_id = 'zzz'"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET charged = charged - 20, remaining = remaining + 20 WHERE reservation_id = 'r1'"))).toBe("23000");
    // بسته نهایی است: هر تغییری (حتی بی‌اثر) رد می‌شود.
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET attempts = '{}'::jsonb WHERE status = 'closed'"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET status = 'open', closed_by = NULL, closed_at_ms = NULL, remaining = closed_amount, closed_amount = 0 WHERE status = 'closed'"))).toBe("23000");
    // رزروِ بستهٔ کاملاً مصرف‌شده را فقط TRIGGER می‌تواند از بازشدن نگه دارد (قیدهای ستونی آن را مجاز می‌دانند).
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET status = 'open', closed_by = NULL, closed_at_ms = NULL WHERE reservation_id = 'r6'"))).toBe("23000");
    // حسابداری: مجموع کمتر از مبلغ هم رد می‌شود (برابری، نه نابرابری).
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET remaining = remaining - 1 WHERE reservation_id = 'r1'"))).toBe("23514");
    // ساختار باز/بسته: رزروِ باز نشانهٔ بستن ندارد؛ بسته‌شدنِ ناقص (بی‌closed_by) رد می‌شود.
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET closed_amount = 1, remaining = remaining - 1 WHERE reservation_id = 'r1'"))).toBe("23514");
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET closed_at_ms = 5 WHERE reservation_id = 'r1'"))).toBe("23514");
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET closed_by = 'release' WHERE reservation_id = 'r1'"))).toBe("23514");
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET status = 'closed', closed_amount = remaining, remaining = 0 WHERE reservation_id = 'r1'"))).toBe("23514");
  });

  it("رزروِ بسته: فقط رشدِ refunded یک تلاش مجاز است؛ هر تغییر دیگر (کاهش، charged، افزودن/حذف تلاش، remaining) رد می‌شود", async () => {
    const t = await withScenario();
    const setRefunded = (n: number) => `UPDATE {{schema}}.reservation SET attempts = jsonb_set(attempts, '{x9,refunded}', '${n}') WHERE reservation_id = 'r3'`;
    expect(await pgCode(t.raw(setRefunded(5)))).toBeUndefined(); // رشد: مجاز
    expect(await pgCode(t.raw(setRefunded(5)))).toBeUndefined(); // بی‌تغییر: مجاز
    expect(await pgCode(t.raw(setRefunded(4)))).toBe("23000"); // کاهش: ممنوع
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET attempts = jsonb_set(attempts, '{x9,charged}', '31') WHERE reservation_id = 'r3'"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET attempts = jsonb_set(attempts, '{x9,requested}', '31') WHERE reservation_id = 'r3'"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET attempts = jsonb_set(attempts, '{x9,shortfall}', '1') WHERE reservation_id = 'r3'"))).toBe("23000");
    expect(await pgCode(t.raw(`UPDATE {{schema}}.reservation SET attempts = attempts || '{"x8":{"requested":1,"charged":1,"shortfall":0,"refunded":0}}'::jsonb WHERE reservation_id = 'r3'`))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET attempts = '{}'::jsonb WHERE reservation_id = 'r3'"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET attempts = jsonb_build_object('x7', attempts -> 'x9') WHERE reservation_id = 'r3'"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET remaining = 1, closed_amount = closed_amount - 1 WHERE reservation_id = 'r3'"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET closed_by = 'forfeit' WHERE reservation_id = 'r3'"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET closed_at_ms = closed_at_ms + 1 WHERE reservation_id = 'r3'"))).toBe("23000");
    expect(await pgCode(t.raw("UPDATE {{schema}}.reservation SET charged = charged + 1, amount = amount + 1 WHERE reservation_id = 'r3'"))).toBe("23000");
  });

  it("refund پس از بسته‌شدنِ رزرو از مسیر سرویس ماندگار می‌شود و ممیزی سالم می‌ماند", async () => {
    const t = await open();
    const { ledger } = await scenario(t);
    const r = val(await ledger.refund({ ...base, refundId: "f-late", reservationId: "r3", attemptId: "x9", unit: UNIT, amount: 10 }));
    expect(r).toMatchObject({ replayed: false, amount: 10 });
    const s = (await t.store.read(KEY)) as AccountState;
    expect(s.reservations["r3"]).toMatchObject({ status: "closed", attempts: { x9: { charged: 30, refunded: 10 } } });
    expect(code(await ledger.refund({ ...base, refundId: "f-late2", reservationId: "r3", attemptId: "x9", unit: UNIT, amount: 21 }))).toBe("REFUND_EXCEEDS_CHARGE");
    expect(await t.store.audit(KEY)).toMatchObject({ ok: true, value: { ok: true } });
  });

  it("فرزندها بی‌حساب درج نمی‌شوند (FK) و شناسه/واحد/مبلغ نامعتبر از هر مسیری رد می‌شود", async () => {
    const t = await withScenario();
    const acct = (over: { tenant?: string; unit?: string; amount?: string }) =>
      `INSERT INTO {{schema}}.account (tenant_id, account_id, unit, created_at_ms, last_at_ms, seq, available, held, granted, charged, forfeited, refunded, shortfall)
       VALUES ('${over.tenant ?? "tx"}', 'ax', '${over.unit ?? "UNIT"}', 1, 1, 0, ${over.amount ?? "0"}, 0, ${over.amount ?? "0"}, 0, 0, 0, 0)`;
    expect(await pgCode(t.raw(acct({ tenant: "bad#id" })))).toBe("23514");
    expect(await pgCode(t.raw(acct({ tenant: "_x" })))).toBe("23514");
    expect(await pgCode(t.raw(acct({ tenant: "a/b" })))).toBe("23514");
    expect(await pgCode(t.raw(acct({ unit: "lower" })))).toBe("23514");
    expect(await pgCode(t.raw(acct({ unit: "A" })))).toBe("23514");
    expect(await pgCode(t.raw(acct({ amount: "-1" })))).toBe("23514");
    expect(await pgCode(t.raw(acct({ amount: "9007199254740992" })))).toBe("23514");
    expect(await pgCode(t.raw(acct({})))).toBeUndefined(); // معتبر می‌گذرد
    expect(await pgCode(t.raw(`INSERT INTO {{schema}}.journal (tenant_id, account_id, seq, at_ms, type, amount, shortfall, available_after, held_after) VALUES ('nobody', 'x', 1, 1, 'grant', 1, 0, 1, 0)`))).toBeDefined();
    expect(await pgCode(t.raw(`INSERT INTO {{schema}}.processed (tenant_id, account_id, op_key, fingerprint, receipt) VALUES ('nobody', 'x', 'grant:g', 'f', '{"kind":"grant"}')`))).toBeDefined();
  });

  it("کلید یکتایی: op_key خارج از قالب، رسید بی‌kind یا kind ناشناخته رد می‌شود؛ کلید تکراری رد می‌شود", async () => {
    const t = await withScenario();
    const ins = (opKey: string, receipt: string) =>
      `INSERT INTO {{schema}}.processed (tenant_id, account_id, op_key, fingerprint, receipt) VALUES ('${T}', '${A}', '${opKey}', 'f', '${receipt}'::jsonb)`;
    expect(await pgCode(t.raw(ins("hack:g9", '{"kind":"grant"}')))).toBe("23514");
    expect(await pgCode(t.raw(ins("grant:", '{"kind":"grant"}')))).toBe("23514");
    expect(await pgCode(t.raw(ins("grant:g9", '{"kind":"steal"}')))).toBe("23514");
    expect(await pgCode(t.raw(ins("grant:g9", '{"x":1}')))).toBe("23514");
    expect(await pgCode(t.raw(ins("grant:g9", "[]")))).toBe("23514");
    expect(await pgCode(t.raw(ins("grant:g-init", '{"kind":"grant"}')))).toBe("23505");
  });

  it("قیدهای ستونی: closed_by ناشناخته، attempts غیرشیء، اثرانگشت تهی/بلند و op_key بلند رد می‌شود (و نمونهٔ معتبر می‌گذرد)", async () => {
    const t = await withScenario();
    const res = (id: string, closedBy: string, attempts: string) =>
      `INSERT INTO {{schema}}.reservation (tenant_id, account_id, reservation_id, amount, remaining, charged, closed_amount, status, closed_by, created_at_ms, expires_at_ms, closed_at_ms, attempts)
       VALUES ('${T}', '${A}', '${id}', 0, 0, 0, 0, 'closed', '${closedBy}', 1, 2, 3, '${attempts}'::jsonb)`;
    expect(await pgCode(t.raw(res("rz1", "steal", "{}")))).toBe("23514");
    expect(await pgCode(t.raw(res("rz2", "release", "[]")))).toBe("23514");
    expect(await pgCode(t.raw(res("rz3", "release", "{}")))).toBeUndefined();
    const proc = (opKey: string, fp: string) =>
      `INSERT INTO {{schema}}.processed (tenant_id, account_id, op_key, fingerprint, receipt) VALUES ('${T}', '${A}', '${opKey}', '${fp}', '{"kind":"grant"}'::jsonb)`;
    expect(await pgCode(t.raw(proc("grant:gq1", "")))).toBe("23514");
    expect(await pgCode(t.raw(proc("grant:gq2", "x".repeat(2001))))).toBe("23514");
    expect(await pgCode(t.raw(proc("grant:gq3", "x".repeat(2000))))).toBeUndefined();
    expect(await pgCode(t.raw(proc(`grant:${"a".repeat(295)}`, "f")))).toBe("23514"); // ۳۰۱ نویسه
    expect(await pgCode(t.raw(proc(`grant:${"a".repeat(294)}`, "f")))).toBeUndefined(); // ۳۰۰ نویسه
  });

  it("شناسه‌ها و واحد در دامنه‌ها دقیقاً هم‌ارز ID_RE و UNIT_RE هستند (نمونه‌های مرزی و یونیکد)", async () => {
    const t = await open();
    const ids = ["a", "A1", "a.b-c_d:e", "0", "_a", "-a", ".a", ":a", "a#b", "a/b", "a b", "a\n", "\na", "é", "ا", "٣", "İ", "a\u00a0", "", "x".repeat(128), "x".repeat(129), "a'b", 'a"b', "a;b", "a\\b", "a%", "a\tb"];
    for (const v of ids) {
      const accepted = await t.raw("SELECT $1::{{schema}}.ledger_id AS v", [v]).then(() => true, () => false);
      expect(accepted, JSON.stringify(v)).toBe(ID_RE.test(v));
    }
    const units = ["IRR", "IR", "I", "irr", "Irr", "iRR", "iR1", "IRR_MICROS", "A".repeat(16), "A".repeat(17), "1AB", "_AB", "AB-C", "AB C", "ÀB", "AB\n", "MSG", "A_"];
    for (const v of units) {
      const accepted = await t.raw("SELECT $1::{{schema}}.unit_code AS v", [v]).then(() => true, () => false);
      expect(accepted, JSON.stringify(v)).toBe(UNIT_RE.test(v));
    }
  });
});

dbDescribe("ledger/pg · اتمی‌بودن و رد commit نامعتبر (فروشگاه)", () => {
  const { open } = tracker();

  /** commit ساخته‌شده با خودِ موتور (grant تازه) روی حالت فعلی؛ `mutate` عمداً آن را خراب می‌کند. */
  async function grantCommit(t: TestLedgerDb, grantId: string): Promise<{ before: AccountState; commit: Commit }> {
    const before = (await t.store.read(KEY)) as AccountState;
    const out = must(run(before, "grant", { grantId, unit: UNIT, amount: 5, source: "promo" }, before.lastAtMs + 1));
    return { before, commit: { state: out.state, entries: out.entries } };
  }
  const unchanged = async (t: TestLedgerDb, before: AccountState, journalLen: number, processedCount: number): Promise<void> => {
    expect(await t.store.read(KEY)).toEqual(before);
    expect((await t.store.journal(KEY)).length).toBe(journalLen);
    expect(await count(t, "processed")).toBe(processedCount);
  };

  it("commit سالم اتمی و کامل ماندگار می‌شود (حساب، کلید یکتایی، ژورنال با هم)", async () => {
    const t = await open();
    await scenario(t);
    const { commit } = await grantCommit(t, "gx");
    const [p, j] = [await count(t, "processed"), (await t.store.journal(KEY)).length];
    await t.store.transact(KEY, () => ({ commit, value: 0 }));
    expect(await count(t, "processed")).toBe(p + 1);
    expect((await t.store.journal(KEY)).length).toBe(j + 1);
    expect(((await t.store.read(KEY)) as AccountState).available).toBe(commit.state.available);
  });

  it("شکست وسط commit (ژورنالِ حفره‌دار پس از نوشتن حساب و کلید) ⇒ همه‌چیز برمی‌گردد", async () => {
    const t = await open();
    await scenario(t);
    const [p, j] = [await count(t, "processed"), (await t.store.journal(KEY)).length];
    const { before, commit } = await grantCommit(t, "gx");
    const bad: Commit = { state: commit.state, entries: commit.entries.map((e) => ({ ...e, seq: e.seq + 3 })) };
    const e = await thrown(t.store.transact(KEY, () => ({ commit: bad, value: 0 })));
    expect(e.error).toMatchObject({ code: "COMMIT_REJECTED", pgCode: "23000" });
    await unchanged(t, before, j, p);
  });

  it("fn پرتاب کند ⇒ همان خطای خودش بالا می‌آید (بی‌پیچیدن) و هیچ‌چیز نوشته نمی‌شود؛ اتصال سالم می‌ماند", async () => {
    const t = await open();
    await scenario(t);
    const [p, j] = [await count(t, "processed"), (await t.store.journal(KEY)).length];
    const before = (await t.store.read(KEY)) as AccountState;
    const boom = new Error("boom");
    await expect(t.store.transact(KEY, () => { throw boom; })).rejects.toBe(boom);
    await unchanged(t, before, j, p);
    expect(await t.store.transact(KEY, () => ({ commit: null, value: "still-works" }))).toBe("still-works");
  });

  it("fn که حالتِ دریافتی را درجا تغییر می‌دهد و همان را commit می‌کند، دقیق و کامل ماندگار می‌شود (تفاضل از حالتِ اولیه محاسبه می‌شود)", async () => {
    const t = await open();
    await scenario(t);
    const before = (await t.store.read(KEY)) as AccountState;
    await t.store.transact(KEY, (cur) => {
      const s = cur as AccountState;
      const a = (s.reservations["r3"] as Reservation).attempts["x9"] as { refunded: number };
      a.refunded += 5; // رزروِ بسته: فقط رشدِ refunded
      (s.reservations["r1"] as Reservation).attempts["x1"]!.refunded += 2;
      s.totals.refunded += 7;
      s.available += 7;
      s.seq += 1;
      s.lastAtMs += 1;
      s.processed["refund:f-inplace"] = { fingerprint: "[\"refund\"]", receipt: { kind: "refund", refundId: "f-inplace", reservationId: "r3", attemptId: "x9", amount: 7, availableAfter: s.available } };
      const entry = { seq: s.seq, atMs: s.lastAtMs, type: "refund" as const, amount: 7, shortfall: 0, reservationId: "r3", attemptId: "x9", refId: "f-inplace", availableAfter: s.available, heldAfter: s.held };
      return { commit: { state: s, entries: [entry] }, value: 0 };
    });
    const after = (await t.store.read(KEY)) as AccountState;
    expect((after.reservations["r3"] as Reservation).attempts["x9"]!.refunded).toBe(5);
    expect((after.reservations["r1"] as Reservation).attempts["x1"]!.refunded).toBe(before.reservations["r1"]!.attempts["x1"]!.refunded + 2);
    expect(after.available).toBe(before.available + 7);
    expect(Object.keys(after.processed)).toContain("refund:f-inplace");
    expect(await t.store.audit(KEY)).toMatchObject({ ok: true, value: { ok: true } });
  });

  it("نویسندهٔ بیرون از فروشگاه که ردیف حساب را قفل کرده، transact را منتظر نگه می‌دارد (FOR UPDATE)؛ پس از آزادسازی ادامه می‌دهد", async () => {
    const t = await open();
    await scenario(t);
    const outside = await t.pool.connect();
    try {
      await outside.query("BEGIN");
      await outside.query(`SELECT 1 FROM "${t.schema}".account WHERE tenant_id = $1 AND account_id = $2 FOR UPDATE`, [T, A]);
      let done = false;
      const p = t.store.transact(KEY, () => ({ commit: null, value: 1 })).then((v) => ((done = true), v));
      await new Promise((r) => setTimeout(r, 400));
      expect(done).toBe(false); // مسدود است: ردیف قفل است
      await outside.query("COMMIT");
      expect(await p).toBe(1);
    } finally {
      outside.release();
    }
  });

  it("قفل مشورتیِ یک حساب، حسابِ دیگر را مسدود نمی‌کند", async () => {
    const t = await open();
    await scenario(t);
    const k2: AccountKey = { tenantId: T, accountId: "other-acct" };
    const holder = await t.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`ledger:${t.schema}:${T.length}:${T}:${A}`]);
      let done = false;
      const same = t.store.transact(KEY, () => ({ commit: null, value: 1 })).then(() => (done = true));
      const other = await t.store.transact(k2, () => ({ commit: null, value: 2 })); // حسابِ دیگر آزاد است
      expect(other).toBe(2);
      await new Promise((r) => setTimeout(r, 300));
      expect(done).toBe(false); // همان حساب: منتظر قفل مشورتی
      await holder.query("COMMIT");
      await same;
      expect(done).toBe(true);
    } finally {
      holder.release();
    }
  });

  it("کارخانهٔ عمومی createPgAccountStore همیشه نگهبان معنایی دارد: بقای شکسته در ذخیره ⇒ CORRUPT_DATA", async () => {
    const t = await open();
    await scenario(t);
    const made = createPgAccountStore(t.db, { schema: t.schema });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(await made.value.read(KEY)).not.toBeNull();
    await t.raw("ALTER TABLE {{schema}}.account DROP CONSTRAINT account_conservation_ck");
    await t.raw("UPDATE {{schema}}.account SET available = available + 1, held = held - 0");
    expect((await thrown(made.value.read(KEY))).error.code).toBe("CORRUPT_DATA");
    expect((await thrown(made.value.transact(KEY, () => ({ commit: null, value: 0 })))).error.code).toBe("CORRUPT_DATA");
  });

  it("fn دقیقاً یک بار صدا زده می‌شود و تغییرِ حالتِ دریافتی بی‌commit ماندگار نمی‌شود", async () => {
    const t = await open();
    await scenario(t);
    const before = (await t.store.read(KEY)) as AccountState;
    let calls = 0;
    await t.store.transact(KEY, (cur) => {
      calls++;
      const s = cur as AccountState;
      s.available += 999;
      s.reservations["r1"] = { ...(s.reservations["r1"] as Reservation), remaining: 0 };
      delete s.processed["grant:g-init"];
      return { commit: null, value: 0 };
    });
    expect(calls).toBe(1);
    expect(await t.store.read(KEY)).toEqual(before);
  });

  const rejects = async (t: TestLedgerDb, store: { transact: typeof t.store.transact }, mutate: (c: Commit) => Commit, expectCode: string, extra: object = {}): Promise<{ code: string; pgCode?: string }> => {
    const [p, j] = [await count(t, "processed"), (await t.store.journal(KEY)).length];
    const { before, commit } = await grantCommit(t, "gx");
    const e = await thrown(store.transact(KEY, () => ({ commit: mutate(commit), value: 0 })));
    expect(e.error.code).toBe(expectCode);
    expect(e.error).toMatchObject(extra);
    await unchanged(t, before, j, p);
    return e.error;
  };

  it("commit با کلید دیگر، یا بدون رعایت ناوردا، یا با unit دیگر ⇒ COMMIT_REJECTED و بی‌اثر", async () => {
    const t = await open();
    await scenario(t);
    await rejects(t, t.store, (c) => ({ ...c, state: { ...c.state, accountId: "other" } }), "COMMIT_REJECTED");
    await rejects(t, t.store, (c) => ({ ...c, state: { ...c.state, tenantId: "other" } }), "COMMIT_REJECTED");
    await rejects(t, t.store, (c) => ({ ...c, state: { ...c.state, available: c.state.available + 1 } }), "COMMIT_REJECTED"); // بقا (نگهبان معنایی)
    await rejects(t, t.store, (c) => ({ ...c, state: { ...c.state, held: c.state.held + 1 } }), "COMMIT_REJECTED");
    // ناوردایی که CHECK پایگاه نمی‌بیند (بقا برقرار، ولی held ≠ Σ باقیمانده‌ها): فقط نگهبان معنایی فروشگاه می‌گیرد ⇒ بی‌pgCode.
    {
      const { before, commit } = await grantCommit(t, "gx");
      const e = await thrown(t.store.transact(KEY, () => ({ commit: { ...commit, state: { ...commit.state, available: commit.state.available - 1, held: commit.state.held + 1 } }, value: 0 })));
      expect(e.error.code).toBe("COMMIT_REJECTED");
      expect(e.error.pgCode).toBeUndefined();
      expect(await t.store.read(KEY)).toEqual(before);
    }
    await rejects(t, t.store, (c) => ({ ...c, state: { ...c.state, unit: "OTHER" } }), "COMMIT_REJECTED");
    await rejects(t, t.store, (c) => ({ ...c, state: { ...c.state, createdAtMs: c.state.createdAtMs + 1 } }), "COMMIT_REJECTED");
  });

  it("بدون نگهبان معنایی هم پایگاه جلو را می‌گیرد: بقا (CHECK)، کاهش seq (TRIGGER)، حذف رزرو/کلید و تغییر سابقه (فروشگاه)", async () => {
    const t = await open();
    await scenario(t);
    const lax = t.another({ semanticGuards: false });
    // بقا را فقط CHECK پایگاه می‌گیرد.
    await rejects(t, lax, (c) => ({ ...c, state: { ...c.state, available: c.state.available + 1 } }), "COMMIT_REJECTED", { pgCode: "23514", constraint: "account_conservation_ck" });
    // کاهش seq را TRIGGER می‌گیرد.
    await rejects(t, lax, (c) => ({ ...c, state: { ...c.state, seq: 0 } }), "COMMIT_REJECTED", { pgCode: "23000" });
    // حذف رزروی (بستهٔ بی‌مصرف) که ناوردا را نمی‌شکند: فقط بررسیِ سابقهٔ فروشگاه می‌گیرد.
    await rejects(t, lax, (c) => {
      const { r2: _gone, ...rest } = c.state.reservations;
      return { ...c, state: { ...c.state, reservations: rest } };
    }, "COMMIT_REJECTED");
    await rejects(t, lax, (c) => {
      const { ["grant:g-init"]: _gone, ...rest } = c.state.processed;
      return { ...c, state: { ...c.state, processed: rest } };
    }, "COMMIT_REJECTED");
    await rejects(t, lax, (c) => ({ ...c, state: { ...c.state, processed: { ...c.state.processed, "grant:g-init": { ...(c.state.processed["grant:g-init"] as Processed), fingerprint: "tampered" } } } }), "COMMIT_REJECTED");
    await rejects(t, lax, (c) => ({ ...c, state: { ...c.state, reservations: { ...c.state.reservations, r1: { ...(c.state.reservations["r1"] as Reservation), amount: 301, remaining: 181 } } } }), "COMMIT_REJECTED");
    await rejects(t, lax, (c) => ({ ...c, state: { ...c.state, reservations: { ...c.state.reservations, r1: { ...(c.state.reservations["r1"] as Reservation), expiresAtMs: 5 } } } }), "COMMIT_REJECTED");
  });

  it("شناسهٔ رزرو باید با کلیدش در state.reservations یکی باشد (بی‌آنکه کار به PK پایگاه برسد)", async () => {
    const t = await open();
    await scenario(t);
    const lax = t.another({ semanticGuards: false });
    const { before, commit } = await grantCommit(t, "gx");
    const r1 = commit.state.reservations["r1"] as Reservation;
    const bad: Commit = { ...commit, state: { ...commit.state, reservations: { ...commit.state.reservations, rX: { ...r1 } } } };
    const e = await thrown(lax.transact(KEY, () => ({ commit: bad, value: 0 })));
    expect(e.error.code).toBe("COMMIT_REJECTED");
    expect(e.error.pgCode).toBeUndefined();
    expect(await t.store.read(KEY)).toEqual(before);
  });

  it("مقدار عددیِ نامعتبر (NaN، منفی، اعشار، > 2^53−1) هرگز به SQL نمی‌رسد", async () => {
    const t = await open();
    await scenario(t);
    const lax = t.another({ semanticGuards: false });
    for (const bad of [Number.NaN, -1, 1.5, 2 ** 53, Number.POSITIVE_INFINITY, "5" as unknown as number]) {
      // رد شدن باید از خودِ فروشگاه باشد، نه از دامنهٔ پایگاه (بی‌pgCode) — یعنی مقدار هرگز به SQL نرسیده است.
      const e1 = await rejects(t, lax, (c) => ({ ...c, state: { ...c.state, available: bad } }), "COMMIT_REJECTED", { message: expect.not.stringContaining("SELECT") });
      const e2 = await rejects(t, lax, (c) => ({ ...c, entries: c.entries.map((e) => ({ ...e, amount: bad })) }), "COMMIT_REJECTED");
      expect([e1.pgCode, e2.pgCode], String(bad)).toEqual([undefined, undefined]);
    }
  });

  it("ورودی ژورنال با شناسهٔ نامعتبر یا نوع نامعتبر ⇒ COMMIT_REJECTED و بی‌اثر", async () => {
    const t = await open();
    await scenario(t);
    await rejects(t, t.store, (c) => ({ ...c, entries: c.entries.map((e) => ({ ...e, refId: "bad#id" })) }), "COMMIT_REJECTED", { pgCode: "23514" });
    await rejects(t, t.store, (c) => ({ ...c, entries: c.entries.map((e) => ({ ...e, type: "steal" as never })) }), "COMMIT_REJECTED", { pgCode: "23514" });
  });

  it("خطای خام pg هرگز بیرون نمی‌آید: پیام ثابت است و SQL/پارامتر/نام جدول ندارد", async () => {
    const t = await open();
    await scenario(t);
    const { commit } = await grantCommit(t, "gx");
    const e = await thrown(t.store.transact(KEY, () => ({ commit: { ...commit, entries: commit.entries.map((x) => ({ ...x, seq: x.seq + 9 })) }, value: 0 })));
    expect(e.message).toBe("COMMIT_REJECTED");
    expect(e.error.message).not.toMatch(/INSERT|SELECT|journal|gx|\$1/);
    expect(JSON.stringify(e.error)).not.toMatch(/INSERT|SELECT|gx/);
  });

  it("درج‌هایی که حساب را نمی‌سازند: commit برای حسابِ ناموجود با entries بی‌حساب (seq ناهماهنگ) رد می‌شود", async () => {
    const t = await open();
    const k: AccountKey = { tenantId: "new", accountId: "acct" };
    const out = must(run(null, "open", { unit: UNIT }, 5));
    const open0: TransactOutcome<number> = { commit: { state: { ...out.state, tenantId: k.tenantId, accountId: k.accountId }, entries: [] }, value: 0 };
    await t.store.transact(k, () => open0);
    expect(await t.store.read(k)).toMatchObject({ seq: 0, unit: UNIT });
    // حسابِ دوباره‌ساخته‌شده روی ردیفِ موجود: INSERT نمی‌شود چون before ≠ null؛ unit/زمان ساخت سنجیده می‌شود.
    const again = await thrown(t.store.transact(k, (cur) => ({ commit: { state: { ...(cur as AccountState), unit: "OTHER" }, entries: [] }, value: 0 })));
    expect(again.error.code).toBe("COMMIT_REJECTED");
  });
});

dbDescribe("ledger/pg · دادهٔ خراب ⇒ شکست بسته", () => {
  const { open } = tracker();

  it("بقای شکسته در ذخیره (قید از مسیر ادمین برداشته شده) ⇒ read/transact/سرویس می‌پرتابند؛ fn هرگز صدا نمی‌خورد؛ هیچ‌چیز نوشته نمی‌شود؛ audit گزارش می‌دهد", async () => {
    const t = await open();
    const { ledger } = await scenario(t);
    await t.raw("ALTER TABLE {{schema}}.account DROP CONSTRAINT account_conservation_ck");
    await t.raw("UPDATE {{schema}}.account SET available = available + 5");
    const [p, j] = [await count(t, "processed"), await count(t, "journal")];

    expect((await thrown(t.store.read(KEY))).error.code).toBe("CORRUPT_DATA");
    let called = 0;
    expect((await thrown(t.store.transact(KEY, () => (called++, { commit: null, value: 0 })))).error.code).toBe("CORRUPT_DATA");
    expect(called).toBe(0);
    expect(code(await ledger.balance(KEY))).toBe("STORE_FAILURE");
    expect(code(await ledger.grant({ ...base, grantId: "gz", unit: UNIT, amount: 1, source: "promo" }))).toBe("STORE_FAILURE");
    expect(code(await ledger.reserve({ ...base, reservationId: "rz", unit: UNIT, amount: 1, ttlMs: 5000 }))).toBe("STORE_FAILURE");
    expect([await count(t, "processed"), await count(t, "journal")]).toEqual([p, j]);

    const audit = await t.store.audit(KEY);
    expect(audit).toMatchObject({ ok: true, value: { exists: true, ok: false } });
    if (audit.ok) {
      expect(audit.value.problems.join("|")).toContain("ناوردای بقا");
      expect(audit.value.problems.join("|")).toContain("بازپخش ژورنال");
    }
  });

  it("ردیف با شکل نادرست (attempts خراب) ⇒ CORRUPT_DATA بی‌پژواکِ داده", async () => {
    const t = await open();
    await scenario(t);
    await t.raw(`UPDATE {{schema}}.reservation SET attempts = '{"x1":{"secret-looking-field":1}}'::jsonb WHERE status = 'open'`);
    const e = await thrown(t.store.read(KEY));
    expect(e.error.code).toBe("CORRUPT_DATA");
    expect(JSON.stringify(e.error)).not.toContain("secret-looking-field");
  });

  it("ژورنالِ دست‌کاری‌شده (با خاموش‌کردن TRIGGER) ⇒ audit ناسازگاری را می‌گیرد و حالت دست‌نخورده می‌ماند", async () => {
    const t = await open();
    await scenario(t);
    expect(await t.store.audit(KEY)).toMatchObject({ ok: true, value: { ok: true } });
    await t.raw("ALTER TABLE {{schema}}.journal DISABLE TRIGGER journal_append_only");
    await t.raw("UPDATE {{schema}}.journal SET amount = amount + 1 WHERE seq = 2");
    const audit = await t.store.audit(KEY);
    expect(audit).toMatchObject({ ok: true, value: { ok: false } });
    if (audit.ok) expect(audit.value.problems.length).toBeGreaterThan(0);
    expect(await t.store.read(KEY)).not.toBeNull();
  });

  it("ژورنالِ کوتاه‌شده (ورودیِ آخر حذف) ⇒ audit: seq با شمار ورودی‌ها نمی‌خواند", async () => {
    const t = await open();
    await scenario(t);
    await t.raw("ALTER TABLE {{schema}}.journal DISABLE TRIGGER journal_append_only");
    await t.raw("DELETE FROM {{schema}}.journal WHERE seq = (SELECT max(seq) FROM {{schema}}.journal)");
    const audit = await t.store.audit(KEY);
    expect(audit).toMatchObject({ ok: true, value: { ok: false } });
    if (audit.ok) expect(audit.value.problems.join("|")).toContain("بازپخش ژورنال");
  });
});

dbDescribe("ledger/pg · ممیزی (audit)", () => {
  const { open } = tracker();
  it("حساب سالم ⇒ ok؛ شمار ورودی‌ها = seq؛ گزارش هیچ مبلغی ندارد", async () => {
    const t = await open();
    await scenario(t);
    const r = await t.store.audit(KEY);
    const s = (await t.store.read(KEY)) as AccountState;
    expect(r).toEqual({ ok: true, value: { exists: true, ok: true, journalEntries: s.seq, problems: [] } });
  });
  it("ورودیِ ژورنالِ بی‌اثر (charge با مبلغ ۰) فقط seq را از حالت جدا می‌کند ⇒ audit دقیقاً همان را می‌گوید", async () => {
    const t = await open();
    await scenario(t);
    const s = (await t.store.read(KEY)) as AccountState;
    await t.raw(`INSERT INTO {{schema}}.journal (tenant_id, account_id, seq, at_ms, type, amount, shortfall, available_after, held_after) VALUES ('${T}', '${A}', ${s.seq + 1}, 1, 'charge', 0, 0, ${s.available}, ${s.held})`);
    expect(await t.store.audit(KEY)).toEqual({ ok: true, value: { exists: true, ok: false, journalEntries: s.seq + 1, problems: ["بازپخش ژورنال: seq با حالت نمی‌خواند."] } });
  });

  it("ورودیِ ژورنال با کسری (charge با shortfall) totals.shortfall و seq را از حالت جدا می‌کند ⇒ audit هر دو را می‌گوید", async () => {
    const t = await open();
    await scenario(t);
    const s = (await t.store.read(KEY)) as AccountState;
    await t.raw(`INSERT INTO {{schema}}.journal (tenant_id, account_id, seq, at_ms, type, amount, shortfall, available_after, held_after) VALUES ('${T}', '${A}', ${s.seq + 1}, 1, 'charge', 0, 7, ${s.available}, ${s.held})`);
    const r = await t.store.audit(KEY);
    expect(r).toMatchObject({ ok: true, value: { ok: false } });
    if (r.ok) expect([...r.value.problems].sort()).toEqual(["بازپخش ژورنال: seq با حالت نمی‌خواند.", "بازپخش ژورنال: totals.shortfall با حالت نمی‌خواند."].sort());
  });

  it("انحرافِ حالت از ژورنال در held (با حفظ بقا) ⇒ audit دقیقاً همان ناسازگاری را هم می‌گوید", async () => {
    const t = await open();
    await scenario(t);
    await t.raw("UPDATE {{schema}}.account SET held = held + 1, granted = granted + 1");
    const r = await t.store.audit(KEY);
    expect(r).toMatchObject({ ok: true, value: { ok: false } });
    if (r.ok) {
      expect(r.value.problems).toContain("بازپخش ژورنال: held با حالت نمی‌خواند.");
      expect(r.value.problems).toContain("بازپخش ژورنال: totals.granted با حالت نمی‌خواند.");
      expect(r.value.problems.join("|")).toContain("held ≠ Σ باقیمانده");
    }
  });

  it("حسابِ ناموجود ⇒ exists: false و ok: true", async () => {
    const t = await open();
    expect(await t.store.audit({ tenantId: "x", accountId: "y" })).toEqual({ ok: true, value: { exists: false, ok: true, journalEntries: 0, problems: [] } });
  });
  it("حسابِ تازه‌باز بی‌ژورنال سالم است", async () => {
    const t = await open();
    const { ledger } = setup(t.store, mutableClock());
    val(await ledger.openAccount({ ...base, unit: UNIT }));
    expect(await t.store.audit(KEY)).toEqual({ ok: true, value: { exists: true, ok: true, journalEntries: 0, problems: [] } });
  });
});

dbDescribe("ledger/pg · جداسازی مستأجر و مرزهای عددی", () => {
  const { open, second } = tracker();

  it("مستأجرِ دیگر ACCOUNT_NOT_FOUND می‌بیند؛ شناسهٔ یکسان در دو مستأجر/حساب مستقل است", async () => {
    const t = await open();
    const { ledger } = setup(t.store, mutableClock());
    await openFunded(ledger, 100, "t1", "acct");
    await openFunded(ledger, 700, "t2", "acct");
    await openFunded(ledger, 5, "t1", "acct2");
    expect(val(await ledger.balance({ tenantId: "t1", accountId: "acct" })).available).toBe(100);
    expect(val(await ledger.balance({ tenantId: "t2", accountId: "acct" })).available).toBe(700);
    expect(val(await ledger.balance({ tenantId: "t1", accountId: "acct2" })).available).toBe(5);
    expect(code(await ledger.balance({ tenantId: "t3", accountId: "acct" }))).toBe("ACCOUNT_NOT_FOUND");
    expect(code(await ledger.grant({ tenantId: "t3", accountId: "acct", grantId: "g", unit: UNIT, amount: 1, source: "promo" }))).toBe("ACCOUNT_NOT_FOUND");
    for (const [tenantId, accountId] of [["t1", "acct"], ["t2", "acct"], ["t1", "acct2"]] as const) {
      val(await ledger.reserve({ tenantId, accountId, reservationId: "r", unit: UNIT, amount: 1, ttlMs: 5000 }));
    }
    expect(await count(t, "reservation")).toBe(3);
    // کلیدهای مرزیِ الحاق: ('a','bc') با ('ab','c') یکی نیستند.
    val(await ledger.openAccount({ tenantId: "a", accountId: "bc", unit: UNIT }));
    expect(code(await ledger.balance({ tenantId: "ab", accountId: "c" }))).toBe("ACCOUNT_NOT_FOUND");
  });

  it("مبلغ تا 2^53−1: دقیق ماندگار می‌شود، سرریز OVERFLOW می‌دهد، بقا و ممیزی سالم می‌ماند", async () => {
    const t = await open();
    const MAX = Number.MAX_SAFE_INTEGER;
    const clock = mutableClock();
    const { ledger } = setup(t.store, clock);
    await openFunded(ledger, MAX);
    expect(val(await ledger.balance(KEY)).available).toBe(MAX);
    expect(code(await ledger.grant({ ...base, grantId: "g2", unit: UNIT, amount: 1, source: "promo" }))).toBe("OVERFLOW");
    val(await ledger.reserve({ ...base, reservationId: "big", unit: UNIT, amount: MAX, ttlMs: 60_000 }));
    expect(val(await ledger.charge({ ...base, reservationId: "big", attemptId: "x", unit: UNIT, amount: MAX })).charged).toBe(MAX);
    val(await ledger.refund({ ...base, refundId: "f", reservationId: "big", attemptId: "x", unit: UNIT, amount: MAX }));
    const store2 = second(t.schema);
    const s = (await store2.read(KEY)) as AccountState;
    expect(s).toMatchObject({ available: MAX, held: 0, totals: { granted: MAX, charged: MAX, refunded: MAX } });
    expect(await store2.audit(KEY)).toMatchObject({ ok: true, value: { ok: true } });
  });

  it("شکست‌ها ثبت نمی‌شوند: INSUFFICIENT_CREDIT را پس از grant می‌شود با همان شناسه دوباره امتحان کرد", async () => {
    const t = await open();
    const { ledger } = setup(t.store, mutableClock());
    await openFunded(ledger, 10);
    const p = await count(t, "processed");
    expect(code(await ledger.reserve({ ...base, reservationId: "r1", unit: UNIT, amount: 50, ttlMs: 5000 }))).toBe("INSUFFICIENT_CREDIT");
    expect(await count(t, "processed")).toBe(p);
    expect(await count(t, "reservation")).toBe(0);
    val(await ledger.grant({ ...base, grantId: "g2", unit: UNIT, amount: 100, source: "purchase" }));
    expect(val(await ledger.reserve({ ...base, reservationId: "r1", unit: UNIT, amount: 50, ttlMs: 5000 })).replayed).toBe(false);
  });

  it("انقضای تنبل ماندگار می‌شود (آزادسازی، نه مصرف) و ساعت یکنوا است", async () => {
    const t = await open();
    const clock = mutableClock();
    const { ledger } = setup(t.store, clock);
    await openFunded(ledger, 100);
    val(await ledger.reserve({ ...base, reservationId: "r1", unit: UNIT, amount: 60, ttlMs: 5000 }));
    clock.advance(6000);
    expect(val(await ledger.balance(KEY))).toMatchObject({ available: 100, held: 0 }); // balance بی‌ماندگارسازی
    expect(((await t.store.read(KEY)) as AccountState).held).toBe(60);
    val(await ledger.grant({ ...base, grantId: "g2", unit: UNIT, amount: 1, source: "promo" })); // فرمان تغییردهنده انقضا را ماندگار می‌کند
    const s = (await t.store.read(KEY)) as AccountState;
    expect(s).toMatchObject({ available: 101, held: 0 });
    expect(s.reservations["r1"]).toMatchObject({ status: "closed", closedBy: "expiry", closedAmount: 60 });
    clock.set(1); // ساعتِ عقب‌رفته
    expect(code(await ledger.charge({ ...base, reservationId: "r1", attemptId: "x", unit: UNIT, amount: 1 }))).toBe("RESERVATION_EXPIRED");
    expect(((await t.store.read(KEY)) as AccountState).lastAtMs).toBeGreaterThanOrEqual(clock.nowMs());
    expect(await t.store.audit(KEY)).toMatchObject({ ok: true, value: { ok: true } });
  });
});
