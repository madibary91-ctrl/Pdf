/**
 * settlement-pending · برگشتِ رسمی (`down`) روی PostgreSQL واقعی (ADR-0048، ب‑۲‑۲‑۱):
 *  ۱) **رفت‌وبرگشتِ کاتالوگ:** پس از `down` همهٔ جدول‌ها/ستون‌ها/قیدها/ایندکس‌ها/TRIGGERها/توابعِ شِما با پیش از نصب یکسان است (و پس از `up` متفاوت — آزمون پوچ نیست)؛
 *  ۲) **هم‌ارزیِ رفتاری:** همان دنبالهٔ عملیات روی یک شِمای «هرگز نصب‌نشده» و یک شِمای «نصب ← down» رکوردهای outbox/تأییدِ یکسان می‌سازد؛ down به رکورد دست نمی‌زند؛
 *  ۳) idempotent، بازنصبِ سالم، شکست‌بسته با دفترِ دست‌کاری، **اتمی‌بودن** (وابستگیِ بیرونی ⇒ برگشتِ کامل)، انتظار برای نویسنده، `lock_timeout` ۱۵ثانیه، هم‌زمانی با up و نویسنده‌ها، جداییِ شِما‌ها.
 */
import { afterAll, describe, expect, it } from "vitest";
import { BEGIN_FACTS, dbDescribe, makeDead, must, openPendingKit, ref, type PendingKit, type Raw } from "./pg-kit";
import { MIGRATIONS, migrationChecksum } from "./migrations";

const opened: PendingKit[] = [];
afterAll(async () => {
  for (const k of opened) await k.dispose();
});
async function fresh(opts: Parameters<typeof openPendingKit>[0] = {}): Promise<PendingKit> {
  const k = await openPendingKit(opts);
  opened.push(k);
  return k;
}
const first = MIGRATIONS[0] as NonNullable<(typeof MIGRATIONS)[number]>;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** کاتالوگِ کاملِ شِما (ساختار، نه داده): تغییرِ هر شیء — حتی ترتیبِ ستون یا متنِ تابع — در مقایسه دیده می‌شود. */
async function catalog(k: PendingKit): Promise<Record<string, unknown>> {
  const s = [k.schema];
  const rows = async (statement: string): Promise<unknown[]> => (await k.raw(statement, s)).map((r) => Object.values(r));
  return {
    relations: await rows(`SELECT c.relname, c.relkind, coalesce(c.reloptions::text, '') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 ORDER BY 1`),
    columns: await rows(`SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull::text, a.attnum::text FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r','i') ORDER BY 1, a.attnum`),
    indexes: await rows(`SELECT indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY indexdef`),
    triggers: await rows(`SELECT c.relname, t.tgname, pg_get_triggerdef(t.oid), t.tgenabled::text FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal ORDER BY 1, 2`),
    functions: await rows(`SELECT p.proname, pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 ORDER BY 1`),
    constraints: await rows(`SELECT conrelid::regclass::text, conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1) ORDER BY 1, 2`),
    types: await rows(`SELECT t.typname, t.typtype::text FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 ORDER BY 1`),
  };
}
const present = async (raw: Raw, name: string): Promise<boolean> => (await raw(`SELECT to_regclass('{{s}}.${name}') IS NOT NULL AS p`))[0]?.["p"] === true;
const count = async (raw: Raw, statement: string): Promise<number> => Number((await raw(statement))[0]?.["n"]);
const pendingTriggers = (raw: Raw): Promise<number> =>
  count(raw, `SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace = '{{s}}'::regnamespace AND (t.tgname LIKE 'settlement_pending_%' OR t.tgname LIKE 'settlement_dead_pending_%')`);
const pendingFunctions = (raw: Raw): Promise<number> => count(raw, `SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = '{{s}}'::regnamespace AND proname LIKE 'settlement_pending_%'`);
const tables = async (k: PendingKit): Promise<{ outbox: readonly unknown[]; ack: readonly unknown[] }> => ({
  outbox: await k.raw("SELECT * FROM {{s}}.settlement_outbox ORDER BY tenant_id, account_id, reservation_id"),
  ack: await k.raw("SELECT * FROM {{s}}.settlement_dead_ack ORDER BY tenant_id, account_id, reservation_id"),
});
async function waitForLockWait(k: PendingKit, like: string): Promise<void> {
  for (let i = 0; i < 150; i++) {
    const n = await count(k.raw, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '${like}' AND query LIKE '%${k.schema}%'`);
    if (n > 0) return;
    await sleep(20);
  }
  throw new Error("قفل‌انتظاری دیده نشد");
}

dbDescribe("settlement-pending · down: برگشتِ رسمی", () => {
  it("رفت‌وبرگشتِ کاتالوگ: پس از down همهٔ ساختارِ شِما با پیش از نصب یکسان است؛ پس از up متفاوت (آزمون پوچ نیست)", async () => {
    const k = await fresh();
    const before = await catalog(k);
    expect((await k.index.migrate()).ok).toBe(true);
    const installed = await catalog(k);
    expect(installed).not.toEqual(before);
    expect(JSON.stringify(installed)).toContain("settlement_dead_pending");
    expect(JSON.stringify(installed)).toContain("settlement_pending_migration_ledger");
    expect(await k.index.down()).toEqual({ ok: true, value: { reverted: [first.name] } });
    expect(await catalog(k)).toEqual(before);
    // دو دور دیگر: نصب ← برگشت هر بار به همان حالتِ پایه برمی‌گردد
    for (let i = 0; i < 2; i++) {
      expect((await k.index.migrate()).ok).toBe(true);
      expect(await catalog(k)).toEqual(installed);
      expect((await k.index.down()).ok).toBe(true);
      expect(await catalog(k)).toEqual(before);
    }
  });

  it("پس از down: مثلِ هرگز-نصب‌نشده — همان دنبالهٔ عملیات روی هر دو، رکوردهای outbox/تأییدِ یکسان (عمیق)", async () => {
    const control = await fresh(); // هرگز نصب نمی‌شود
    const subject = await fresh({ migratePending: true });
    const script = async (k: PendingKit, phase: "pre" | "post"): Promise<void> => {
      const o = k.outbox;
      if (phase === "pre") {
        await makeDead(o, "d1", 30);
        await makeDead(o, "d2", 20);
        await makeDead(o, "d3", 10, { tenantId: "t2" });
        must(await o.acknowledgeDead(ref("d2"), { atMs: 40 }));
        must(await o.begin({ ...ref("live"), ...BEGIN_FACTS }));
        must(await o.recordCharge(ref("live"), { attemptId: "x", amount: 5 }));
      } else {
        await makeDead(o, "d4", 55);
        must(await o.acknowledgeDead(ref("d1"), { atMs: 60 }));
        must(await o.recordFailure(ref("live"), { errorCode: "E", dueAtMs: 9 }));
        must(await o.bury(ref("live"), { reason: "ATTEMPTS_EXHAUSTED", errorCode: "E", atMs: 70 }));
        must(await o.acknowledgeDead(ref("d3", { tenantId: "t2" }), { atMs: 71 }));
      }
    };
    await script(control, "pre");
    await script(subject, "pre");
    const beforeDown = await tables(subject);
    expect(await subject.index.verify()).toMatchObject({ ok: true, value: { consistent: true, expected: 2 } });

    expect(await subject.index.down()).toMatchObject({ ok: true });
    // down به رکوردِ مالی دست نمی‌زند (outbox و تأییدها بایت‌به‌بایت همان‌اند)
    expect(await tables(subject)).toEqual(beforeDown);
    // …و خواندنِ settlement همچنان همان پاسخ را می‌دهد
    expect(must(await subject.outbox.listUnacknowledgedDead({ limit: 100 })).map((e) => e.reservationId)).toEqual(["d3", "d1"]);

    await script(control, "post");
    await script(subject, "post");
    expect(await tables(subject)).toEqual(await tables(control));
    expect(must(await subject.outbox.listUnacknowledgedDead({ limit: 100 }))).toEqual(must(await control.outbox.listUnacknowledgedDead({ limit: 100 })));
  });

  it("نصب‌نشده ⇒ بی‌کار و بی‌اثر (دفتر ساخته نمی‌شود)؛ برگشتِ دوم بی‌کار؛ status پس از آن «معلق»", async () => {
    const k = await fresh();
    await makeDead(k.outbox, "x", 5);
    const before = await catalog(k);
    expect(await k.index.down()).toEqual({ ok: true, value: { reverted: [] } });
    expect(await catalog(k)).toEqual(before);
    expect(await present(k.raw, "settlement_pending_migration_ledger")).toBe(false);

    expect((await k.index.migrate()).ok).toBe(true);
    expect(await k.index.down()).toEqual({ ok: true, value: { reverted: [first.name] } });
    expect(await k.index.down()).toEqual({ ok: true, value: { reverted: [] } });
    expect(await catalog(k)).toEqual(before);
    expect(await k.index.status()).toEqual({ ok: true, value: { applied: [], pending: [first.name] } });
  });

  it("پس از down: جدول و دفتر و توابع و TRIGGERها نیستند؛ نگهبان هم رفته (DML مستقیم به outbox آزاد، جدولِ نمایه ناموجود)", async () => {
    const k = await fresh({ migratePending: true });
    await makeDead(k.outbox, "a", 1);
    expect((await k.index.down()).ok).toBe(true);
    expect(await present(k.raw, "settlement_dead_pending")).toBe(false);
    expect(await present(k.raw, "settlement_pending_migration_ledger")).toBe(false);
    expect(await pendingFunctions(k.raw)).toBe(0);
    expect(await count(k.raw, `SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace = '{{s}}'::regnamespace AND (t.tgname LIKE 'settlement_pending_%' OR t.tgname LIKE 'settlement_dead_pending_%')`)).toBe(0);
    // بی‌TRIGGER: درجِ مستقیمِ dead و تأیید بی‌مانع و بی‌اثرِ جانبی
    await k.raw(
      `INSERT INTO {{s}}.settlement_outbox (tenant_id, account_id, reservation_id, unit, reserved, created_at_ms, expires_at_ms, due_at_ms, orphan_remainder, state, dead_reason, settled_at_ms)
       VALUES ('t9', 'a9', 'direct', 'IRR_MICROS', 3, 1, 2, 3, 'release', 'dead', 'EXPIRED_UNBILLED', 42)`,
    );
    await k.raw("INSERT INTO {{s}}.settlement_dead_ack (tenant_id, account_id, reservation_id, acked_at_ms) VALUES ('t9', 'a9', 'direct', 1)");
    await expect(k.raw("DELETE FROM {{s}}.settlement_dead_pending")).rejects.toMatchObject({ code: "42P01" });
    // نمایه‌ی نصب‌نشده: خواندن از آن «شکست» است نه «پسماندِ خالی»؛ خواندنِ settlement درست است
    expect(await k.index.listUnacknowledgedDead({ limit: 5 })).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
    expect(must(await k.outbox.listUnacknowledgedDead({ limit: 5 })).map((e) => e.reservationId)).toEqual(["a"]);
  });

  it("پس از down، up دوباره نصب می‌کند و backfill رکوردهایی را که در نبودِ نمایه مرده‌اند می‌گیرد؛ verify سازگار", async () => {
    const k = await fresh({ migratePending: true });
    await makeDead(k.outbox, "before", 10);
    expect((await k.index.down()).ok).toBe(true);
    await makeDead(k.outbox, "while-absent-1", 20);
    await makeDead(k.outbox, "while-absent-2", 30);
    must(await k.outbox.acknowledgeDead(ref("before"), { atMs: 40 }));
    expect(await k.index.migrate()).toEqual({ ok: true, value: { applied: [first.name], alreadyApplied: [] } });
    expect(await k.index.verify()).toEqual({ ok: true, value: { consistent: true, expected: 2, indexed: 2, missing: 0, stale: 0 } });
    expect(must(await k.index.listUnacknowledgedDead({ limit: 10 })).map((e) => e.reservationId)).toEqual(["while-absent-1", "while-absent-2"]);
    expect(await pendingTriggers(k.raw)).toBeGreaterThan(0);
  });

  it("پایگاهِ پرحجم: ۲۰٬۰۰۰ مردهٔ بی‌تأیید در نمایه ⇒ down موفق؛ هیچ رکوردِ outbox کم نمی‌شود و بازنصب همه را می‌یابد", async () => {
    const k = await fresh({ migratePending: true });
    await k.raw(
      `INSERT INTO {{s}}.settlement_outbox (tenant_id, account_id, reservation_id, unit, reserved, created_at_ms, expires_at_ms, due_at_ms, orphan_remainder, state, dead_reason, settled_at_ms)
       SELECT 't1', 'a1', 'bulk' || g, 'IRR_MICROS', 3, 1, 2, 3, 'release', 'dead', 'EXPIRED_UNBILLED', g FROM generate_series(1, 20000) g`,
    );
    expect(await count(k.raw, "SELECT count(*)::int AS n FROM {{s}}.settlement_dead_pending")).toBe(20000);
    expect(await k.index.down()).toEqual({ ok: true, value: { reverted: [first.name] } });
    expect(await count(k.raw, "SELECT count(*)::int AS n FROM {{s}}.settlement_outbox")).toBe(20000);
    expect((await k.index.migrate()).ok).toBe(true);
    expect(await k.index.verify()).toMatchObject({ ok: true, value: { consistent: true, expected: 20000, indexed: 20000 } });
  });
});

dbDescribe("settlement-pending · down: شکست‌بسته و اتمی‌بودن", () => {
  it("دفترِ دست‌کاری‌شده یا ناشناخته ⇒ شکست‌بسته؛ نصب کاملاً سر جایش و TRIGGERها هنوز کار می‌کنند؛ پس از اصلاحِ دفتر down موفق", async () => {
    const k = await fresh({ migratePending: true });
    const before = await catalog(k);
    await k.raw("UPDATE {{s}}.settlement_pending_migration_ledger SET checksum = $1", ["0".repeat(64)]);
    const tamperedCatalog = await catalog(k);
    expect(await k.index.down()).toMatchObject({ ok: false, error: { code: "MIGRATION_TAMPERED" } });
    expect(await catalog(k)).toEqual(tamperedCatalog);
    await makeDead(k.outbox, "still-tracked", 5);
    expect(await count(k.raw, "SELECT count(*)::int AS n FROM {{s}}.settlement_dead_pending")).toBe(1);

    await k.raw("UPDATE {{s}}.settlement_pending_migration_ledger SET checksum = $1", [migrationChecksum(first)]);
    await k.raw("INSERT INTO {{s}}.settlement_pending_migration_ledger (name, checksum) VALUES ('0002_from_the_future', 'x')");
    expect(await k.index.down()).toMatchObject({ ok: false, error: { code: "MIGRATION_UNKNOWN" } });
    expect(await present(k.raw, "settlement_dead_pending")).toBe(true);
    expect(await pendingFunctions(k.raw)).toBe(3);

    await k.raw("DELETE FROM {{s}}.settlement_pending_migration_ledger WHERE name = '0002_from_the_future'");
    expect(await catalog(k)).toEqual(before);
    expect(await k.index.down()).toEqual({ ok: true, value: { reverted: [first.name] } });
  });

  it("اتمی: وابستگیِ بیرونی (view روی جدولِ نمایه) ⇒ DROP شکست می‌خورد (2BP01)، کلِ تراکنش برمی‌گردد؛ بی‌CASCADE؛ پیام بی‌نشت؛ پس از حذفِ view موفق", async () => {
    const k = await fresh({ migratePending: true });
    await makeDead(k.outbox, "a", 1);
    await k.raw("CREATE VIEW {{s}}.someone_elses_view AS SELECT reservation_id FROM {{s}}.settlement_dead_pending");
    const before = await catalog(k);

    const r = await k.index.down();
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: "DB_ERROR", pgCode: "2BP01" });
    for (const leak of [k.schema, "someone_elses_view", "DROP TABLE", "settlement_dead_pending"]) expect(JSON.stringify(r.error)).not.toContain(leak);

    // برگشتِ کامل: TRIGGERهای outbox/ack که پیش از DROP TABLE حذف شده بودند، دوباره‌اند؛ ردیفِ دفتر هست
    expect(await catalog(k)).toEqual(before);
    expect(await count(k.raw, "SELECT count(*)::int AS n FROM {{s}}.settlement_pending_migration_ledger")).toBe(1);
    // نمایه هنوز کار می‌کند: مردهٔ تازه در همان تراکنشِ نویسنده وارد نمایه می‌شود و verify سازگار است
    await makeDead(k.outbox, "b", 2);
    expect(await k.index.verify()).toEqual({ ok: true, value: { consistent: true, expected: 2, indexed: 2, missing: 0, stale: 0 } });
    expect(must(await k.index.listUnacknowledgedDead({ limit: 10 })).map((e) => e.reservationId)).toEqual(["a", "b"]);

    await k.raw("DROP VIEW {{s}}.someone_elses_view");
    expect(await k.index.down()).toEqual({ ok: true, value: { reverted: [first.name] } });
    expect(await present(k.raw, "settlement_dead_pending")).toBe(false);
  });

  it("نصبِ ناقص (TRIGGERِ حذف‌شده با دست): down آن را هم پاک می‌کند (IF EXISTS) و به حالتِ پایه برمی‌گردد", async () => {
    const k = await fresh();
    const base = await catalog(k);
    expect((await k.index.migrate()).ok).toBe(true);
    await k.raw("DROP TRIGGER settlement_pending_dead_upd ON {{s}}.settlement_outbox");
    expect(await k.index.verify()).toMatchObject({ ok: true });
    expect(await k.index.down()).toEqual({ ok: true, value: { reverted: [first.name] } });
    expect(await catalog(k)).toEqual(base);
  });
});

dbDescribe("settlement-pending · down: قفل، انتظار و هم‌زمانی", () => {
  it("نویسنده با تراکنشِ باز: down منتظر می‌ماند (LOCK TABLE) و پس از commit موفق می‌شود؛ رکوردِ نویسنده می‌ماند و نمایه‌ای نیست", async () => {
    const k = await fresh({ migratePending: true });
    must(await k.outbox.begin({ ...ref("racer"), ...BEGIN_FACTS }));
    const holder: { done?: ReturnType<typeof k.index.down> } = {};
    await k.session(async (q, commit) => {
      await q("UPDATE {{s}}.settlement_outbox SET state = 'dead', dead_reason = 'LEDGER_REJECTED', settled_at_ms = 5 WHERE reservation_id = 'racer'");
      holder.done = k.index.down();
      await waitForLockWait(k, "LOCK TABLE%");
      // تا commit نشده، چیزی برنگشته است
      expect(await present(k.raw, "settlement_dead_pending")).toBe(true);
      await commit();
    });
    expect(await holder.done).toEqual({ ok: true, value: { reverted: [first.name] } });
    expect(await present(k.raw, "settlement_dead_pending")).toBe(false);
    expect(await count(k.raw, "SELECT count(*)::int AS n FROM {{s}}.settlement_outbox WHERE reservation_id = 'racer' AND state = 'dead'")).toBe(1);
    expect(must(await k.outbox.listUnacknowledgedDead({ limit: 5 })).map((e) => e.reservationId)).toEqual(["racer"]);
  });

  it("lock_timeout ۱۵ثانیه: نویسنده‌ای که رها نمی‌کند ⇒ 55P03 پس از ≈۱۵ثانیه، هیچ‌چیز عوض نمی‌شود و بازتلاشی نیست؛ پس از آزادی موفق", async () => {
    const k = await fresh({ migratePending: true });
    must(await k.outbox.begin({ ...ref("holder"), ...BEGIN_FACTS }));
    const before = await catalog(k);
    let result: Awaited<ReturnType<typeof k.index.down>> | undefined;
    let elapsed = 0;
    await k.session(async (q) => {
      await q("UPDATE {{s}}.settlement_outbox SET reserved = reserved WHERE reservation_id = 'holder'");
      const t0 = Date.now();
      result = await k.index.down();
      elapsed = Date.now() - t0;
      // پس از شکست، هیچ پرسشِ LOCKِ رهاشده‌ای در پایگاه نمانده است
      expect(await count(k.raw, `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE 'LOCK TABLE%' AND query LIKE '%${k.schema}%'`)).toBe(0);
    });
    expect(result).toMatchObject({ ok: false, error: { code: "DB_ERROR", pgCode: "55P03" } });
    expect(elapsed).toBeGreaterThanOrEqual(14_000);
    expect(elapsed).toBeLessThan(25_000);
    expect(await catalog(k)).toEqual(before);
    expect(await k.index.verify()).toMatchObject({ ok: true, value: { consistent: true } });
    expect(await k.index.down()).toEqual({ ok: true, value: { reverted: [first.name] } });
  }, 60_000);

  it("هم‌زمانیِ down با up و نویسنده‌های موازی (۶ دور): حالتِ نهایی یا کاملاً نصب‌شده و سازگار یا کاملاً نصب‌نشده — هرگز نیمه", async () => {
    let installedRounds = 0;
    let absentRounds = 0;
    for (let round = 0; round < 6; round++) {
      const k = await fresh({ migratePending: true });
      for (let i = 0; i < 5; i++) await makeDead(k.outbox, `pre${i}`, 100 + i);
      const a = k.indexWith({}, 2);
      const b = k.indexWith({}, 2);
      const w = k.outboxWith();
      const writers = Array.from({ length: 12 }, async (_unused, i) => {
        const r = ref(`w${round}_${i}`);
        await w.begin({ ...r, ...BEGIN_FACTS });
        await w.bury(r, { reason: "LEDGER_REJECTED", errorCode: null, atMs: 500 + i });
        if (i % 3 === 0) await w.acknowledgeDead(r, { atMs: 900 + i });
      });
      const settled = await Promise.allSettled([k.index.down(), a.index.migrate(), b.index.down(), k.index.migrate(), ...writers]);
      for (const s of settled) expect(s.status).toBe("fulfilled"); // هیچ‌چیز پرتاب نمی‌شود (Result)
      await a.close();
      await b.close();

      const parts = {
        table: await present(k.raw, "settlement_dead_pending"),
        ledger: await present(k.raw, "settlement_pending_migration_ledger"),
        functions: await pendingFunctions(k.raw),
        triggers: await count(k.raw, `SELECT count(*)::int AS n FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN ('{{s}}.settlement_outbox'::regclass, '{{s}}.settlement_dead_ack'::regclass) AND t.tgname LIKE 'settlement_pending_%'`),
      };
      const installed = parts.table && parts.ledger && parts.functions === 3 && parts.triggers === 3;
      const absent = !parts.table && !parts.ledger && parts.functions === 0 && parts.triggers === 0;
      expect(installed || absent, `دور ${round}: حالتِ نیمه ${JSON.stringify(parts)}`).toBe(true);
      if (installed) {
        installedRounds++;
        expect(await k.index.verify(), `دور ${round}`).toMatchObject({ ok: true, value: { consistent: true } });
      } else {
        absentRounds++;
      }
      // نویسنده‌ها هر چه کردند، حقیقتِ مالی کامل است: ۵ مردهٔ پیشین + ۱۲ نوشته‌شده (بن‌بستِ احتمالیِ یک نویسنده فقط آن را ناکام می‌کند، نه چیز دیگری را)
      expect(await count(k.raw, "SELECT count(*)::int AS n FROM {{s}}.settlement_outbox WHERE reservation_id LIKE 'pre%'")).toBe(5);
      // و بازنصبِ نهایی همیشه سالم است
      expect((await k.index.migrate()).ok).toBe(true);
      expect(await k.index.verify(), `دور ${round} پس از بازنصب`).toMatchObject({ ok: true, value: { consistent: true } });
    }
    expect(installedRounds + absentRounds).toBe(6);
  }, 120_000);

  it("جداییِ شِما‌ها: down ی یک شِما به نمایهٔ شِمای دیگر دست نمی‌زند", async () => {
    const a = await fresh({ migratePending: true });
    const b = await fresh({ migratePending: true });
    await makeDead(b.outbox, "b1", 1);
    const bBefore = await catalog(b);
    expect(await a.index.down()).toEqual({ ok: true, value: { reverted: [first.name] } });
    expect(await catalog(b)).toEqual(bBefore);
    await makeDead(b.outbox, "b2", 2);
    expect(await b.index.verify()).toEqual({ ok: true, value: { consistent: true, expected: 2, indexed: 2, missing: 0, stale: 0 } });
    expect(await a.index.verify()).toMatchObject({ ok: false, error: { code: "NOT_MIGRATED" } });
  });

  it("پیش‌نیاز: دفتر هست ولی جدول‌های settlement نیست ⇒ NOT_MIGRATED و دفتر دست‌نخورده", async () => {
    const k = await fresh({ migratePending: true });
    await k.raw("ALTER TABLE {{s}}.settlement_dead_ack RENAME TO settlement_dead_ack_moved");
    expect(await k.index.down()).toMatchObject({ ok: false, error: { code: "NOT_MIGRATED" } });
    expect(await count(k.raw, "SELECT count(*)::int AS n FROM {{s}}.settlement_pending_migration_ledger")).toBe(1);
    await k.raw("ALTER TABLE {{s}}.settlement_dead_ack_moved RENAME TO settlement_dead_ack");
    expect(await k.index.down()).toEqual({ ok: true, value: { reverted: [first.name] } });
  });
});
