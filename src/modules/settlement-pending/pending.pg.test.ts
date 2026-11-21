/**
 * settlement-pending روی PostgreSQL واقعی (ADR-0046):
 *  ۱) مهاجرت: پیش‌نیاز، idempotent، هم‌زمانی، دفترِ دست‌کاری‌شده/ناشناخته، ارتقا از پایگاهِ دارای داده (backfill) و انتظارِ نویسنده؛
 *  ۲) TRIGGERها: ورود به dead (مسیر آداپتور و SQL مستقیم)، تأیید، تکرار؛ نگهبانِ نمایه جلوی دست‌کاریِ مستقیم را می‌گیرد؛
 *  ۳) آزمون تفاضلی: دنبالهٔ تصادفیِ عملیات ⇒ خروجیِ نمایه ≡ خروجیِ `listUnacknowledgedDead` ی آداپتورِ settlement (عمیق، با گره‌ها و ترتیبِ «C»)؛
 *  ۴) verify: ناسازگاری (گم‌شده/کهنه/زمانِ نادرست) را می‌یابد و خواندن ردیفِ کهنه را هرگز بیرون نمی‌دهد؛
 *  ۵) پذیرش هزینه (ADR-0044 ← ب): با EXPLAIN (ANALYZE, BUFFERS) روی **همان SQLِ ضبط‌شده**: کارِ نمایه با شمارِ تأییدشده‌ها رشد نمی‌کند (کنترل: پرسشِ قدیمی رشد می‌کند)؛
 *  ۶) سقفِ زمانِ سمتِ پایگاه و نشتِ‌نکردن به اتصال.
 */
import { afterAll, describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { LedgerDatabase, LedgerExecutor } from "@/modules/ledger";
import { createPgSettlementOutbox } from "@/modules/settlement";
import type { OutboxEntry, PgSettlementOutbox } from "@/modules/settlement";
import { createPendingDeadIndex } from "./index";
import { MIGRATIONS, migrationChecksum } from "./migrations";
import { BEGIN_FACTS, dbDescribe, makeDead, must, openPendingKit, ref, type PendingKit, type Raw } from "./pg-kit";

const opened: PendingKit[] = [];
afterAll(async () => {
  for (const k of opened) await k.dispose();
});
async function fresh(opts: Parameters<typeof openPendingKit>[0] = {}): Promise<PendingKit> {
  const k = await openPendingKit(opts);
  opened.push(k);
  return k;
}
const keys = (es: readonly OutboxEntry[]): string[] => es.map((e) => `${e.tenantId}/${e.accountId}/${e.reservationId}@${e.settledAtMs}`);
async function sqlState(raw: Raw, statement: string, params: readonly unknown[] = []): Promise<string | null> {
  try {
    await raw(statement, params);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "unknown";
  }
}
async function same(k: PendingKit, limits: readonly number[] = [1, 2, 5, 1000]): Promise<void> {
  for (const limit of limits) {
    const theirs = must(await k.outbox.listUnacknowledgedDead({ limit }));
    const mine = must(await k.index.listUnacknowledgedDead({ limit }));
    expect(mine, `limit=${limit}`).toEqual(theirs);
  }
}

dbDescribe("settlement-pending · مهاجرت", () => {
  it("پیش‌نیاز: بی‌جدول‌های settlement ⇒ NOT_MIGRATED و هیچ‌چیز ساخته نمی‌شود؛ status همه‌معلق", async () => {
    const k = await fresh();
    const lonely = k.indexWith({}, 1);
    // شِمایی که settlement در آن مهاجرت نکرده است
    const other = createPendingDeadIndex(lonely.db, { schema: `${k.schema}_none` });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(await other.value.status()).toEqual({ ok: true, value: { applied: [], pending: ["0001_dead_pending"] } });
    const m = await other.value.migrate();
    expect(m.ok).toBe(false);
    if (!m.ok) {
      expect(m.error.code).toBe("NOT_MIGRATED");
      expect(m.error.message).toContain("ابتدا مهاجرتِ settlement را اجرا کنید");
    }
    expect(await other.value.verify()).toMatchObject({ ok: false, error: { code: "NOT_MIGRATED" } });
    expect(await other.value.listUnacknowledgedDead({ limit: 5 })).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
    await lonely.close();
  });

  it("پیش از مهاجرتِ نمایه: status معلق، خواندن STORE_FAILURE؛ پس از migrate: اعمال‌شده و idempotent", async () => {
    const k = await fresh();
    expect(await k.index.status()).toEqual({ ok: true, value: { applied: [], pending: ["0001_dead_pending"] } });
    expect(await k.index.listUnacknowledgedDead({ limit: 5 })).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
    const m1 = await k.index.migrate();
    expect(m1).toEqual({ ok: true, value: { applied: ["0001_dead_pending"], alreadyApplied: [] } });
    const m2 = await k.index.migrate();
    expect(m2).toEqual({ ok: true, value: { applied: [], alreadyApplied: ["0001_dead_pending"] } });
    expect(await k.index.status()).toEqual({ ok: true, value: { applied: ["0001_dead_pending"], pending: [] } });
    expect(await k.index.verify()).toEqual({ ok: true, value: { consistent: true, expected: 0, indexed: 0, missing: 0, stale: 0 } });
    const rows = await k.raw("SELECT name, checksum FROM {{s}}.settlement_pending_migration_ledger");
    expect(rows).toEqual([{ name: "0001_dead_pending", checksum: migrationChecksum(MIGRATIONS[0] as NonNullable<(typeof MIGRATIONS)[number]>) }]);
  });

  it("دفترِ مهاجرتِ settlement دست‌نخورده می‌ماند و آداپتورِ settlement همچنان همه‌چیز را می‌پذیرد", async () => {
    const k = await fresh();
    const before = await k.raw("SELECT name, checksum FROM {{s}}.settlement_migration_ledger ORDER BY name");
    must(await k.outbox.begin({ ...ref("early"), ...BEGIN_FACTS }));
    expect((await k.index.migrate()).ok).toBe(true);
    expect(await k.raw("SELECT name, checksum FROM {{s}}.settlement_migration_ledger ORDER BY name")).toEqual(before);
    expect(await k.outbox.status()).toMatchObject({ ok: true, value: { pending: [] } });
    must(await k.outbox.bury(ref("early"), { reason: "EXPIRED_UNBILLED", errorCode: null, atMs: 5 }));
    expect(keys(must(await k.index.listUnacknowledgedDead({ limit: 10 })))).toEqual(["t1/a1/early@5"]);
  });

  it("ارتقا از پایگاهِ دارای داده: backfill فقط «مرده‌ی بی‌تأیید» را می‌گیرد (open/settling/done/ackشده نه)", async () => {
    const k = await fresh();
    const o = k.outbox;
    await makeDead(o, "d1", 30);
    await makeDead(o, "d2", 10);
    const acked = await makeDead(o, "d3-acked", 20);
    must(await o.acknowledgeDead(acked, { atMs: 99 }));
    must(await o.begin({ ...ref("open1"), ...BEGIN_FACTS }));
    must(await o.begin({ ...ref("settling1"), ...BEGIN_FACTS }));
    must(await o.recordCharge(ref("settling1"), { attemptId: "att1", amount: 5 }));
    must(await o.begin({ ...ref("done1"), ...BEGIN_FACTS }));
    must(await o.recordClose(ref("done1"), { remainder: "release", origin: "caller" }));
    must(await o.finish(ref("done1"), 77));
    await makeDead(o, "other-tenant", 10, { tenantId: "t2" });

    expect((await k.index.migrate()).ok).toBe(true);
    expect(await k.raw("SELECT reservation_id FROM {{s}}.settlement_dead_pending ORDER BY reservation_id")).toEqual([{ reservation_id: "d1" }, { reservation_id: "d2" }, { reservation_id: "other-tenant" }]);
    expect(await k.index.verify()).toEqual({ ok: true, value: { consistent: true, expected: 3, indexed: 3, missing: 0, stale: 0 } });
    await same(k);
    expect(keys(must(await k.index.listUnacknowledgedDead({ limit: 1000 })))).toEqual(["t1/a1/d2@10", "t2/a1/other-tenant@10", "t1/a1/d1@30"]);
  });

  it("مهاجرتِ هم‌زمانِ چند فرایند (و هم‌زمان با migrate ی settlement): فقط یکی اعمال می‌کند، نتیجه سازگار", async () => {
    const k = await fresh();
    await makeDead(k.outbox, "x1", 7);
    const a = k.indexWith({}, 2);
    const b = k.indexWith({}, 2);
    const rs = await Promise.all([k.index.migrate(), a.index.migrate(), b.index.migrate(), k.outbox.migrate(), k.index.migrate()]);
    for (const r of rs) expect(r.ok).toBe(true);
    const appliedCount = [rs[0], rs[1], rs[2], rs[4]].filter((r) => r.ok && r.value.applied.length === 1).length;
    expect(appliedCount).toBe(1);
    expect(await k.index.verify()).toMatchObject({ ok: true, value: { consistent: true, expected: 1, indexed: 1 } });
    await a.close();
    await b.close();
  });

  it("دفترِ دست‌کاری‌شده ⇒ MIGRATION_TAMPERED در migrate/status و STORE_FAILURE در خواندن؛ مهاجرتِ ناشناخته ⇒ MIGRATION_UNKNOWN", async () => {
    const k = await fresh({ migratePending: true });
    await k.raw("UPDATE {{s}}.settlement_pending_migration_ledger SET checksum = $1", ["0".repeat(64)]);
    expect(await k.index.status()).toMatchObject({ ok: false, error: { code: "MIGRATION_TAMPERED" } });
    expect(await k.index.migrate()).toMatchObject({ ok: false, error: { code: "MIGRATION_TAMPERED" } });
    expect(await k.index.listUnacknowledgedDead({ limit: 3 })).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
    expect(await k.index.verify()).toMatchObject({ ok: false, error: { code: "MIGRATION_TAMPERED" } });
    await k.raw("UPDATE {{s}}.settlement_pending_migration_ledger SET checksum = $1", [migrationChecksum(MIGRATIONS[0] as NonNullable<(typeof MIGRATIONS)[number]>)]);
    await k.raw("INSERT INTO {{s}}.settlement_pending_migration_ledger (name, checksum) VALUES ('0002_from_the_future', 'x')");
    expect(await k.index.status()).toMatchObject({ ok: false, error: { code: "MIGRATION_UNKNOWN" } });
    expect(await k.index.listUnacknowledgedDead({ limit: 3 })).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
  });

  it("backfill زیرِ قفل: نویسنده‌ای که تراکنشش باز است مهاجرت را منتظر نگه می‌دارد و پس از commit رکوردش در نمایه می‌آید", async () => {
    const k = await fresh();
    must(await k.outbox.begin({ ...ref("racer"), ...BEGIN_FACTS }));
    const holder: { migrated?: Promise<{ ok: boolean }> } = {};
    await k.session(async (q, commit) => {
      await q("UPDATE {{s}}.settlement_outbox SET state = 'dead', dead_reason = 'LEDGER_REJECTED', settled_at_ms = 5 WHERE reservation_id = 'racer'");
      holder.migrated = k.index.migrate();
      let waiting = 0;
      for (let i = 0; i < 100 && waiting === 0; i++) {
        const r = await k.raw("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE 'LOCK TABLE%' AND query LIKE '%' || $1 || '%'", [k.schema]);
        waiting = Number(r[0]?.["n"]);
        if (waiting === 0) await new Promise((res) => setTimeout(res, 20));
      }
      expect(waiting, "مهاجرت باید پشتِ قفلِ نویسنده منتظر بماند").toBe(1);
      await commit();
    });
    const r = await holder.migrated;
    expect(r?.ok).toBe(true);
    expect(keys(must(await k.index.listUnacknowledgedDead({ limit: 10 })))).toEqual(["t1/a1/racer@5"]);
    expect(await k.index.verify()).toMatchObject({ ok: true, value: { consistent: true, expected: 1, indexed: 1 } });
  });
});

dbDescribe("settlement-pending · TRIGGERها و نگهبانِ نمایه", () => {
  it("مسیرِ آداپتور: bury ⇒ در نمایه؛ تأیید ⇒ بیرون؛ تکرارِ هر دو بی‌اثر؛ done/open/settling هرگز وارد نمی‌شوند", async () => {
    const k = await fresh({ migratePending: true });
    const o = k.outbox;
    const pend = async (): Promise<string[]> => (await k.raw("SELECT reservation_id FROM {{s}}.settlement_dead_pending ORDER BY reservation_id")).map((r) => String(r["reservation_id"]));
    must(await o.begin({ ...ref("a"), ...BEGIN_FACTS }));
    expect(await pend()).toEqual([]);
    must(await o.recordCharge(ref("a"), { attemptId: "x", amount: 1 }));
    must(await o.recordFailure(ref("a"), { errorCode: "E", dueAtMs: 9 }));
    expect(await pend()).toEqual([]);
    must(await o.bury(ref("a"), { reason: "ATTEMPTS_EXHAUSTED", errorCode: "E", atMs: 50 }));
    expect(await pend()).toEqual(["a"]);
    expect(must(await o.bury(ref("a"), { reason: "ATTEMPTS_EXHAUSTED", errorCode: "E", atMs: 50 }))).toEqual({ replayed: true });
    expect(await pend()).toEqual(["a"]);
    must(await o.begin({ ...ref("fin"), ...BEGIN_FACTS }));
    must(await o.recordClose(ref("fin"), { remainder: "release", origin: "caller" }));
    must(await o.finish(ref("fin"), 60));
    expect(await pend()).toEqual(["a"]);
    expect(must(await o.acknowledgeDead(ref("a"), { atMs: 70 }))).toEqual({ replayed: false });
    expect(await pend()).toEqual([]);
    expect(must(await o.acknowledgeDead(ref("a"), { atMs: 71 }))).toEqual({ replayed: true });
    expect(await pend()).toEqual([]);
    // تاریخچه کامل می‌ماند: listDead هنوز آن را دارد، ولی نمایه نه.
    expect(must(await o.listDead({ limit: 10 })).map((e) => e.reservationId)).toEqual(["a"]);
    await same(k);
  });

  it("SQL مستقیم (بیرون از آداپتور): درجِ رکوردِ dead ⇒ در نمایه؛ درجِ تأیید ⇒ بیرون", async () => {
    const k = await fresh({ migratePending: true });
    await k.raw(
      `INSERT INTO {{s}}.settlement_outbox (tenant_id, account_id, reservation_id, unit, reserved, created_at_ms, expires_at_ms, due_at_ms, orphan_remainder, state, dead_reason, settled_at_ms)
       VALUES ('t9', 'a9', 'direct', 'IRR_MICROS', 3, 1, 2, 3, 'release', 'dead', 'EXPIRED_UNBILLED', 42)`,
    );
    expect(keys(must(await k.index.listUnacknowledgedDead({ limit: 5 })))).toEqual(["t9/a9/direct@42"]);
    await same(k);
    await k.raw("INSERT INTO {{s}}.settlement_dead_ack (tenant_id, account_id, reservation_id, acked_at_ms) VALUES ('t9', 'a9', 'direct', 1)");
    expect(must(await k.index.listUnacknowledgedDead({ limit: 5 }))).toEqual([]);
    expect(await k.index.verify()).toMatchObject({ ok: true, value: { consistent: true, expected: 0, indexed: 0 } });
  });

  it("رد شدنِ تأیید/درجِ نامعتبر (حذفِ نمایه تأثیری ندارد): تراکنشِ برگشت‌خورده نمایه را هم برمی‌گرداند", async () => {
    const k = await fresh({ migratePending: true });
    must(await k.outbox.begin({ ...ref("rb"), ...BEGIN_FACTS }));
    await k.session(async (q) => {
      await q("UPDATE {{s}}.settlement_outbox SET state = 'dead', dead_reason = 'LEDGER_REJECTED', settled_at_ms = 1 WHERE reservation_id = 'rb'");
      expect(await q("SELECT count(*)::int AS n FROM {{s}}.settlement_dead_pending")).toEqual([{ n: 1 }]);
    }); // پایانِ session = ROLLBACK
    expect(await k.raw("SELECT count(*)::int AS n FROM {{s}}.settlement_dead_pending")).toEqual([{ n: 0 }]);
    expect(await k.index.verify()).toMatchObject({ ok: true, value: { consistent: true, expected: 0, indexed: 0 } });
  });

  it("نگهبانِ نمایه: INSERT/UPDATE/DELETE/TRUNCATE مستقیم رد می‌شود (23000) و چیزی تغییر نمی‌کند", async () => {
    const k = await fresh({ migratePending: true });
    await makeDead(k.outbox, "g1", 5);
    expect(await sqlState(k.raw, "DELETE FROM {{s}}.settlement_dead_pending")).toBe("23000");
    expect(await sqlState(k.raw, "UPDATE {{s}}.settlement_dead_pending SET settled_at_ms = 1")).toBe("23000");
    expect(await sqlState(k.raw, "INSERT INTO {{s}}.settlement_dead_pending (tenant_id, account_id, reservation_id, settled_at_ms) VALUES ('t1', 'a1', 'forged', 5)")).toBe("23000");
    expect(await sqlState(k.raw, "TRUNCATE {{s}}.settlement_dead_pending")).toBe("23000");
    expect(await sqlState(k.raw, "TRUNCATE {{s}}.settlement_outbox")).toBe("23000"); // ناوردای اصلیِ settlement دست‌نخورده
    expect(await k.index.verify()).toEqual({ ok: true, value: { consistent: true, expected: 1, indexed: 1, missing: 0, stale: 0 } });
    await same(k);
  });

  it("نگهبانِ نمایه جلوی TRIGGERهای خودِ نمایه را نمی‌گیرد: ۲۰ رکورد با تأییدِ نیمی، سازگار", async () => {
    const k = await fresh({ migratePending: true });
    for (let i = 0; i < 20; i++) {
      const r = await makeDead(k.outbox, `bulk-${String(i).padStart(2, "0")}`, 100 + (i % 4));
      if (i % 2 === 0) must(await k.outbox.acknowledgeDead(r, { atMs: 500 }));
    }
    expect(await k.index.verify()).toEqual({ ok: true, value: { consistent: true, expected: 10, indexed: 10, missing: 0, stale: 0 } });
    await same(k);
  });
});

dbDescribe("settlement-pending · ساختار و کلیدِ سه‌بخشی", () => {
  it("تأییدِ یک رکورد، رکوردِ هم‌نامِ حساب/مستأجرِ دیگر را از نمایه بیرون نمی‌برد (کلیدِ سه‌بخشی در TRIGGER)", async () => {
    const k = await fresh({ migratePending: true });
    const a = await makeDead(k.outbox, "same-id", 10, { tenantId: "t1", accountId: "a1" });
    await makeDead(k.outbox, "same-id", 11, { tenantId: "t1", accountId: "a2" });
    await makeDead(k.outbox, "same-id", 12, { tenantId: "t2", accountId: "a1" });
    must(await k.outbox.acknowledgeDead(a, { atMs: 50 }));
    expect(keys(must(await k.index.listUnacknowledgedDead({ limit: 10 })))).toEqual(["t1/a2/same-id@11", "t2/a1/same-id@12"]);
    expect(await k.index.verify()).toMatchObject({ ok: true, value: { consistent: true, expected: 2, indexed: 2 } });
    await same(k);
  });

  it("ایندکسِ ترتیبِ خواندن با ستون‌های درست، و پارامترهای autovacuumِ جدولِ پرگردش وجود دارند", async () => {
    const k = await fresh({ migratePending: true });
    const idx = await k.raw("SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'settlement_dead_pending_order_idx'", [k.schema]);
    expect(idx).toHaveLength(1);
    expect(String(idx[0]?.["indexdef"])).toContain("(settled_at_ms, tenant_id, account_id, reservation_id)");
    const opts = await k.raw("SELECT reloptions FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'settlement_dead_pending'", [k.schema]);
    expect([...(opts[0]?.["reloptions"] as string[])].sort()).toEqual(["autovacuum_analyze_scale_factor=0", "autovacuum_analyze_threshold=200", "autovacuum_vacuum_scale_factor=0", "autovacuum_vacuum_threshold=200"]);
  });
});

dbDescribe("settlement-pending · verify و خواندنِ ایمن در برابر نمایهٔ دست‌کاری‌شده", () => {
  async function tampered(): Promise<PendingKit> {
    const k = await fresh({ migratePending: true });
    // مالکِ پایگاه (نه برنامه) می‌تواند نگهبان را خاموش کند؛ آزمون همین را برای شبیه‌سازیِ خرابی می‌کند.
    await k.raw("ALTER TABLE {{s}}.settlement_dead_pending DISABLE TRIGGER settlement_dead_pending_guard");
    return k;
  }

  it("ردیفِ گم‌شده: verify ⇒ missing=1 و ناسازگار (و نمایه آن را نمی‌بیند — دلیلِ وجودِ verify)", async () => {
    const k = await tampered();
    await makeDead(k.outbox, "m1", 5);
    await makeDead(k.outbox, "m2", 6);
    await k.raw("DELETE FROM {{s}}.settlement_dead_pending WHERE reservation_id = 'm1'");
    expect(await k.index.verify()).toEqual({ ok: true, value: { consistent: false, expected: 2, indexed: 1, missing: 1, stale: 0 } });
    expect(keys(must(await k.index.listUnacknowledgedDead({ limit: 10 })))).toEqual(["t1/a1/m2@6"]);
    expect(keys(must(await k.outbox.listUnacknowledgedDead({ limit: 10 })))).toEqual(["t1/a1/m1@5", "t1/a1/m2@6"]);
  });

  it("ردیفِ کهنه (تأییدشده): خواندن آن را هرگز بیرون نمی‌دهد؛ verify ⇒ stale=1", async () => {
    const k = await tampered();
    const r = await makeDead(k.outbox, "s1", 5);
    await k.raw("ALTER TABLE {{s}}.settlement_dead_ack DISABLE TRIGGER settlement_pending_ack");
    must(await k.outbox.acknowledgeDead(r, { atMs: 9 }));
    expect(await k.raw("SELECT count(*)::int AS n FROM {{s}}.settlement_dead_pending")).toEqual([{ n: 1 }]);
    expect(must(await k.index.listUnacknowledgedDead({ limit: 10 }))).toEqual([]);
    expect(await k.index.verify()).toEqual({ ok: true, value: { consistent: false, expected: 0, indexed: 1, missing: 0, stale: 1 } });
  });

  it("ردیفِ ساختگی برای رکوردِ ناموجود/غیرِ‌مرده: بیرون نمی‌آید؛ stale", async () => {
    const k = await tampered();
    must(await k.outbox.begin({ ...ref("live"), ...BEGIN_FACTS }));
    await k.raw("INSERT INTO {{s}}.settlement_dead_pending (tenant_id, account_id, reservation_id, settled_at_ms) VALUES ('t1', 'a1', 'live', 5), ('t1', 'a1', 'ghost', 6)");
    expect(must(await k.index.listUnacknowledgedDead({ limit: 10 }))).toEqual([]);
    expect(await k.index.verify()).toMatchObject({ ok: true, value: { consistent: false, missing: 0, stale: 2, indexed: 2 } });
  });

  it("ردیفِ ساختگی با زمانِ برابر برای رکوردِ done: بیرون نمی‌آید (خواندن «dead بودن» را از outbox دوباره می‌سنجد، نه STORE_FAILURE)", async () => {
    const k = await tampered();
    must(await k.outbox.begin({ ...ref("fin"), ...BEGIN_FACTS }));
    must(await k.outbox.recordClose(ref("fin"), { remainder: "release", origin: "caller" }));
    must(await k.outbox.finish(ref("fin"), 77));
    await k.raw("INSERT INTO {{s}}.settlement_dead_pending (tenant_id, account_id, reservation_id, settled_at_ms) VALUES ('t1', 'a1', 'fin', 77)");
    expect(must(await k.index.listUnacknowledgedDead({ limit: 10 }))).toEqual([]);
    expect(await k.index.verify()).toMatchObject({ ok: true, value: { consistent: false, missing: 0, stale: 1 } });
  });

  it("زمانِ مرگِ نادرست در نمایه: هم missing هم stale (رکوردِ واقعی از دیدِ خواندن پنهان است و verify آن را می‌گیرد)", async () => {
    const k = await tampered();
    await makeDead(k.outbox, "t1x", 5);
    await k.raw("UPDATE {{s}}.settlement_dead_pending SET settled_at_ms = 999");
    expect(must(await k.index.listUnacknowledgedDead({ limit: 10 }))).toEqual([]);
    expect(await k.index.verify()).toEqual({ ok: true, value: { consistent: false, expected: 1, indexed: 1, missing: 1, stale: 1 } });
  });

  it("خاموش‌کردنِ TRIGGERِ ورود به dead ⇒ رکوردِ تازه missing؛ verify می‌گیرد", async () => {
    const k = await tampered();
    await k.raw("ALTER TABLE {{s}}.settlement_outbox DISABLE TRIGGER settlement_pending_dead_upd");
    await makeDead(k.outbox, "silent", 5);
    expect(await k.index.verify()).toMatchObject({ ok: true, value: { consistent: false, expected: 1, indexed: 0, missing: 1, stale: 0 } });
  });
});

/** دنبالهٔ تصادفیِ قطعی (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

dbDescribe("settlement-pending · آزمون تفاضلی با آداپتورِ settlement", () => {
  const TENANTS = ["t1", "T1", "t_2", "A.b", "z:9", "0x", "m-n"];
  const IDS = ["r1", "R1", "r10", "r2", "r_a", "r.b", "r:c", "r-d", "9r", "Zr"];
  const REASONS = ["EXPIRED_UNBILLED", "ATTEMPTS_EXHAUSTED", "LEDGER_REJECTED"] as const;

  it.each([1, 2, 3, 4])("دنبالهٔ تصادفی (بذر %i): پس از هر گام‌گروه خروجی‌ها عمیقاً برابرند (گره‌های زمانِ مرگ و شناسه‌های حساس به locale)", async (seed) => {
    const k = await fresh({ migratePending: seed % 2 === 0 }); // نیمی با نمایهٔ از-قبل، نیمی با backfill
    const rnd = rng(seed * 7919);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const known: { r: ReturnType<typeof ref>; state: "open" | "dead" | "done" }[] = [];
    let mid = false;
    for (let step = 0; step < 90; step++) {
      const roll = rnd();
      const open = known.filter((x) => x.state === "open");
      const dead = known.filter((x) => x.state === "dead");
      if (roll < 0.35 || known.length < 4) {
        const r = ref(`${pick(IDS)}-${step}`, { tenantId: pick(TENANTS), accountId: pick(["a1", "A1", "a_2"]) });
        must(await k.outbox.begin({ ...r, ...BEGIN_FACTS }));
        known.push({ r, state: "open" });
      } else if (roll < 0.65 && open.length > 0) {
        const x = pick(open);
        must(await k.outbox.bury(x.r, { reason: pick(REASONS), errorCode: rnd() < 0.5 ? "E_1" : null, atMs: 100 + Math.floor(rnd() * 4) })); // گره‌های زیاد
        x.state = "dead";
      } else if (roll < 0.75 && open.length > 0) {
        const x = pick(open);
        must(await k.outbox.recordFailure(x.r, { errorCode: "E_2", dueAtMs: 50_000 }));
      } else if (roll < 0.8 && open.length > 0) {
        const x = pick(open);
        must(await k.outbox.recordCharge(x.r, { attemptId: `att-${step}`, amount: 3 }));
        must(await k.outbox.recordClose(x.r, { remainder: "release", origin: "sweeper" }));
        must(await k.outbox.finish(x.r, 200));
        x.state = "done";
      } else if (dead.length > 0) {
        const x = pick(dead);
        must(await k.outbox.acknowledgeDead(x.r, { atMs: 300 + step }));
      }
      if (!mid && step === 45 && seed % 2 === 1) {
        expect((await k.index.migrate()).ok).toBe(true); // مهاجرت میانهٔ داستان: backfill روی دادهٔ واقعیِ نیمه‌کاره
        mid = true;
      }
      if (step % 10 === 9 && (seed % 2 === 0 || mid)) await same(k);
    }
    if (seed % 2 === 1 && !mid) expect((await k.index.migrate()).ok).toBe(true);
    await same(k);
    expect(await k.index.verify()).toMatchObject({ ok: true, value: { consistent: true, missing: 0, stale: 0 } });
    const all = must(await k.outbox.listUnacknowledgedDead({ limit: 1000 }));
    expect(all.length).toBeGreaterThan(0);
    // ترتیب: (settledAtMs، سپس شناسه‌ها با ترتیبِ نقطه‌کد) بی‌تکرار
    const ks = all.map((e) => [e.settledAtMs, e.tenantId, e.accountId, e.reservationId] as const);
    const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
    for (let i = 1; i < ks.length; i++) {
      const p = ks[i - 1] as (typeof ks)[number];
      const c = ks[i] as (typeof ks)[number];
      const d = (p[0] as number) - (c[0] as number) || cmp(p[1], c[1]) || cmp(p[2], c[2]) || cmp(p[3], c[3]);
      expect(d).toBeLessThan(0);
    }
  });

  it("گره‌های زمانِ مرگ: ۱۲ رکورد با زمانِ یکسان و درجِ معکوس ⇒ ترتیبِ نقطه‌کد (مستأجر، حساب، رزرو) نه ترتیبِ درج", async () => {
    const k = await fresh({ migratePending: true });
    const ids = ["b", "B", "a", "A", "9", "_x", "z", "Z", "m.1", "m-1", "m:1", "M"].filter((x) => /^[A-Za-z0-9]/.test(x));
    const all = [...ids.map((id) => ({ tenantId: "t1", accountId: "a1", id })), ...ids.slice(0, 3).map((id) => ({ tenantId: "T0", accountId: "a1", id }))];
    for (const x of [...all].reverse()) await makeDead(k.outbox, x.id, 500, { tenantId: x.tenantId, accountId: x.accountId });
    const want = all.map((x) => `${x.tenantId}/${x.accountId}/${x.id}@500`).sort((p, q) => (p < q ? -1 : p > q ? 1 : 0));
    expect(keys(must(await k.index.listUnacknowledgedDead({ limit: 1000 })))).toEqual(want);
    expect(keys(must(await k.index.listUnacknowledgedDead({ limit: 4 })))).toEqual(want.slice(0, 4));
    await same(k, [1, 4, 1000]);
  });

  it("مرزهای limit روی پایگاهِ واقعی: ۱ و ۱۰۰۰ پذیرفته، ۰ و ۱۰۰۱ INVALID_INPUT — هم‌کدِ آداپتور", async () => {
    const k = await fresh({ migratePending: true });
    for (const limit of [0, 1001, -1, 1.5, Number.NaN]) {
      const mine = await k.index.listUnacknowledgedDead({ limit });
      const theirs = await k.outbox.listUnacknowledgedDead({ limit });
      expect(mine.ok).toBe(false);
      expect(theirs.ok).toBe(false);
      if (!mine.ok && !theirs.ok) expect(mine.error.code).toBe(theirs.error.code);
    }
    for (const limit of [1, 1000]) expect((await k.index.listUnacknowledgedDead({ limit })).ok).toBe(true);
  });

  it("هم‌زمانی: بُری و تأییدِ موازی از چند فرایند ⇒ نمایه سازگار و برابر با آداپتور", async () => {
    const k = await fresh({ migratePending: true, poolSize: 8 });
    const other = k.outboxWith();
    const refs = Array.from({ length: 36 }, (_, i) => ref(`c${String(i).padStart(2, "0")}`, { tenantId: i % 3 === 0 ? "ta" : "tb" }));
    for (const r of refs) must(await k.outbox.begin({ ...r, ...BEGIN_FACTS }));
    await Promise.all(refs.map((r, i) => (i % 2 === 0 ? k.outbox : other).bury(r, { reason: "ATTEMPTS_EXHAUSTED", errorCode: "E", atMs: 10 + (i % 5) })));
    await Promise.all(
      refs.flatMap((r, i) => [
        ...(i % 3 === 0 ? [(i % 2 === 0 ? other : k.outbox).acknowledgeDead(r, { atMs: 99 }), k.outbox.acknowledgeDead(r, { atMs: 100 })] : []),
        k.index.listUnacknowledgedDead({ limit: 50 }),
      ]),
    );
    expect(await k.index.verify()).toMatchObject({ ok: true, value: { consistent: true, expected: 24, indexed: 24 } });
    await same(k, [3, 1000]);
  });
});

/** SQL و پارامترهای ضبط‌شده از آداپتورها (همان فراخوانیِ واقعی؛ نسخهٔ کپی‌شده‌ای در آزمون نیست). */
function recorder(db: LedgerDatabase): { db: LedgerDatabase; texts: { text: string; params: unknown[] }[] } {
  const dialect = new PgDialect();
  const texts: { text: string; params: unknown[] }[] = [];
  const wrap = (tx: LedgerExecutor): LedgerExecutor => ({
    execute: ((q: Parameters<LedgerExecutor["execute"]>[0]) => {
      const built = dialect.sqlToQuery(q);
      texts.push({ text: built.sql, params: built.params });
      return tx.execute(q);
    }) as LedgerExecutor["execute"],
  });
  const rec = { execute: wrap(db).execute, transaction: <T,>(run: (tx: LedgerExecutor) => Promise<T>, cfg?: Parameters<LedgerDatabase["transaction"]>[1]) => db.transaction((tx) => run(wrap(tx)), cfg) } as LedgerDatabase;
  return { db: rec, texts };
}

type PlanNode = { "Node Type": string; "Relation Name"?: string; "Actual Rows"?: number; "Actual Loops"?: number; "Shared Hit Blocks"?: number; "Shared Read Blocks"?: number; Plans?: PlanNode[] };
function touched(node: PlanNode, into: Map<string, number> = new Map()): Map<string, number> {
  if (node["Relation Name"] !== undefined) into.set(node["Relation Name"], (into.get(node["Relation Name"]) ?? 0) + (node["Actual Rows"] ?? 0) * (node["Actual Loops"] ?? 1));
  for (const c of node.Plans ?? []) touched(c, into);
  return into;
}

dbDescribe("settlement-pending · پذیرش هزینه: کار با شمارِ مرده‌های تأییدشده رشد نمی‌کند (EXPLAIN ANALYZE)", () => {
  async function seed(k: PendingKit, acked: number, unacked: number): Promise<void> {
    await k.raw(
      `INSERT INTO {{s}}.settlement_outbox (tenant_id, account_id, reservation_id, unit, reserved, created_at_ms, expires_at_ms, due_at_ms, orphan_remainder, state, dead_reason, settled_at_ms)
       SELECT 't1', 'a1', 'acked-' || g, 'IRR_MICROS', 1, 1, 2, 3, 'forfeit', 'dead', 'LEDGER_REJECTED', g FROM generate_series(1, $1::int) g`,
      [acked],
    );
    await k.raw(`INSERT INTO {{s}}.settlement_dead_ack (tenant_id, account_id, reservation_id, acked_at_ms) SELECT 't1', 'a1', 'acked-' || g, 1 FROM generate_series(1, $1::int) g`, [acked]);
    await k.raw(
      `INSERT INTO {{s}}.settlement_outbox (tenant_id, account_id, reservation_id, unit, reserved, created_at_ms, expires_at_ms, due_at_ms, orphan_remainder, state, dead_reason, settled_at_ms)
       SELECT 't1', 'a1', 'pending-' || g, 'IRR_MICROS', 1, 1, 2, 3, 'forfeit', 'dead', 'EXPIRED_UNBILLED', 1000000 + g FROM generate_series(1, $1::int) g`,
      [unacked],
    );
    for (const t of ["settlement_outbox", "settlement_dead_ack", "settlement_dead_pending"]) await k.raw(`VACUUM (ANALYZE) {{s}}.${t}`);
  }

  async function measure(acked: number): Promise<{ mine: Map<string, number>; theirs: Map<string, number>; mineBlocks: number; theirsBlocks: number }> {
    const k = await fresh({ migratePending: true, poolSize: 3 });
    await seed(k, acked, 3);
    const recMine = recorder(k.db);
    const recTheirs = recorder(k.db);
    const mineIdx = createPendingDeadIndex(recMine.db, { schema: k.schema });
    const theirsOutbox = createPgSettlementOutbox(recTheirs.db, { schema: k.schema });
    if (!mineIdx.ok || !theirsOutbox.ok) throw new Error("setup");
    expect(must(await mineIdx.value.listUnacknowledgedDead({ limit: 1000 }))).toHaveLength(3);
    expect(must(await theirsOutbox.value.listUnacknowledgedDead({ limit: 1000 }))).toHaveLength(3);
    const pickSql = (texts: { text: string; params: unknown[] }[], needle: RegExp) => {
      const q = texts.find((t) => /^\s*SELECT\s+(o\.)?tenant_id/i.test(t.text) && needle.test(t.text));
      if (q === undefined) throw new Error("پرسشِ ضبط‌شده یافت نشد");
      return q;
    };
    const explain = async (q: { text: string; params: unknown[] }): Promise<{ plan: PlanNode; blocks: number }> => {
      const res = await k.session(async (run) => run(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q.text.split("$1").join(String(q.params[0]))}`, []));
      const plan = (res[0]?.["QUERY PLAN"] as { Plan: PlanNode }[])[0]?.Plan as PlanNode;
      return { plan, blocks: (plan["Shared Hit Blocks"] ?? 0) + (plan["Shared Read Blocks"] ?? 0) };
    };
    const a = await explain(pickSql(recMine.texts, /settlement_dead_pending/));
    const b = await explain(pickSql(recTheirs.texts, /NOT EXISTS/));
    return { mine: touched(a.plan), theirs: touched(b.plan), mineBlocks: a.blocks, theirsBlocks: b.blocks };
  }

  it("۳۰۰۰ تأییدشده + ۳ تأییدنشده: نمایه فقط به اندازهٔ تأییدنشده‌ها ردیف می‌خواند؛ پرسشِ قدیمی به اندازهٔ تأییدشده‌ها (کنترل)", async () => {
    const r = await measure(3000);
    // نمایه: هیچ ردیفِ outbox/تأییدِ اضافه‌ای لمس نمی‌شود (۳ جست‌وجوی کلیدی + ۳ جست‌وجوی ایندکسِ تأیید)
    expect(r.mine.get("settlement_dead_pending") ?? 0).toBeLessThanOrEqual(3);
    expect(r.mine.get("settlement_outbox") ?? 0).toBeLessThanOrEqual(3);
    expect(r.mine.get("settlement_dead_ack") ?? 0).toBeLessThanOrEqual(3);
    // کنترل: پرسشِ قدیمی مرده‌های تأییدشده را می‌پیماید (اگر این شکست بخورد، آزمونِ بالا بی‌معنا شده است)
    expect(r.theirs.get("settlement_outbox") ?? 0).toBeGreaterThanOrEqual(3000);
  }, 60_000);

  it("با ده برابر تأییدشده، کارِ منطقیِ نمایه (ردیف‌های لمس‌شده) دقیقاً ثابت می‌ماند ولی پرسشِ قدیمی ≈ ده برابر می‌شود", async () => {
    const small = await measure(1000);
    const big = await measure(10_000);
    for (const rel of ["settlement_dead_pending", "settlement_outbox", "settlement_dead_ack"]) expect(big.mine.get(rel) ?? 0, rel).toBe(small.mine.get(rel) ?? 0);
    expect(big.theirs.get("settlement_outbox") ?? 0).toBeGreaterThanOrEqual((small.theirs.get("settlement_outbox") ?? 0) * 9);
    // بلوک‌ها فقط اطلاعاتی‌اند (هیپِ پرگردش تا vacuum باد می‌کند؛ ADR-0046 یافتهٔ ۲)؛ ولی سقفی معقول دارند.
    expect(big.mineBlocks).toBeLessThan(400);
  }, 120_000);
});

dbDescribe("settlement-pending · سقفِ زمانِ سمتِ پایگاه", () => {
  it("بدون قفل: با گزینه عادی کار می‌کند؛ پس از آن `statement_timeout` به اتصال نشت نمی‌کند (SET LOCAL)", async () => {
    const k = await fresh({ migratePending: true });
    await makeDead(k.outbox, "tm1", 3);
    const p = k.indexWith({ readStatementTimeoutMs: 5000 }, 1);
    expect(keys(must(await p.index.listUnacknowledgedDead({ limit: 5 })))).toEqual(["t1/a1/tm1@3"]);
    expect(await p.index.verify()).toMatchObject({ ok: true });
    expect(await p.raw("SHOW statement_timeout")).toEqual([{ statement_timeout: "0" }]);
    await p.close();
  });

  it("پشتِ قفلِ نمایه: خواندن و verify در ≈ سقف لغو می‌شوند (STORE_FAILURE/57014) و پرسشِ رهاشده در پایگاه نمی‌ماند", async () => {
    const k = await fresh({ migratePending: true });
    const p = k.indexWith({ readStatementTimeoutMs: 300 }, 1);
    await k.session(async (q) => {
      await q("LOCK TABLE {{s}}.settlement_dead_pending IN ACCESS EXCLUSIVE MODE");
      const t0 = Date.now();
      const listed = await p.index.listUnacknowledgedDead({ limit: 5 });
      const dt = Date.now() - t0;
      expect(listed).toEqual({ ok: false, error: { code: "STORE_FAILURE", message: "ذخیرهٔ outbox در دسترس نیست." } });
      expect(dt).toBeGreaterThanOrEqual(250);
      expect(dt).toBeLessThan(3000);
      const v = await p.index.verify();
      expect(v).toMatchObject({ ok: false, error: { code: "DB_ERROR", pgCode: "57014" } });
      const lingering = await k.raw("SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'active' AND wait_event_type = 'Lock' AND query LIKE '%settlement_dead_pending%' AND query NOT LIKE 'LOCK%' AND query NOT LIKE '%pg_stat_activity%'");
      expect(lingering).toEqual([{ n: 0 }]);
    });
    expect(await p.raw("SHOW statement_timeout")).toEqual([{ statement_timeout: "0" }]);
    expect(must(await p.index.listUnacknowledgedDead({ limit: 5 }))).toEqual([]);
    await p.close();
  });
});
