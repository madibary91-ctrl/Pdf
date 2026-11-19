/**
 * settlement-runtime روی PostgreSQL واقعی (ADR-0031): پیش‌بازرسیِ مهاجرت، مهاجرتِ صریح، بستنِ رزروهای یتیم از ریشهٔ ترکیب،
 * چندنمونه‌ایِ ایمن با استخرهای جدا («فرایندها») و دودیِ زمانِ واقعی (ساعتِ سیستم + setTimeout).
 * زمانِ مجازی + I/O واقعی ⇒ پس از هر پیشروی منتظرِ پایانِ واقعیِ گذر می‌مانیم (`settle`).
 */
import { afterEach, expect, it } from "vitest";
import { createLedger, createPgAccountStore } from "@/modules/ledger";
import { createDurableLedger } from "@/modules/settlement";
import { createNodeTimer, createPgSettlementRuntime, createSystemClock } from "./index";
import type { PgSettlementRuntime } from "./index";
import { KEY, UNIT, WORST, manualTimer, must, reserveInput } from "./test-kit";
import type { ManualTimer } from "./test-kit";
import { dbDescribe, openPg } from "./test-db";
import type { TestPg } from "./test-db";

const GRACE = 10_000;
const INTERVAL = GRACE / 4;
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

async function until(cond: () => Promise<boolean> | boolean, what: string, tries = 1500): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await cond()) return;
    await sleep(4);
  }
  throw new Error(`انتظار برای «${what}» به پایان رسید`);
}

dbDescribe("settlement-runtime · PostgreSQL", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  async function pg(): Promise<TestPg> {
    const t = await openPg();
    cleanups.push(t.dispose);
    return t;
  }

  function build(t: Pick<TestPg, "db" | "ledgerSchema" | "settlementSchema">, timer: ManualTimer, over: Record<string, unknown> = {}): PgSettlementRuntime {
    const r = createPgSettlementRuntime({ db: t.db, ledgerSchema: t.ledgerSchema, settlementSchema: t.settlementSchema, clock: timer.clock, timer, graceMs: GRACE, deadLetters: false, ...over });
    if (!r.ok) throw new Error(r.error.issues.join("; "));
    return r.value;
  }

  /** پیشروی در گام‌های فاصلهٔ گذر؛ پس از هر گام تا پایانِ واقعیِ گذرِ جاری صبر می‌کند. */
  async function settle(rt: PgSettlementRuntime, timer: ManualTimer, ms: number, step = INTERVAL): Promise<void> {
    for (let done = 0; done < ms; done += step) {
      await timer.advance(Math.min(step, ms - done));
      await sleep(0);
      await until(() => !rt.status().loop.busy, "پایانِ گذر");
    }
  }

  async function fund(rt: PgSettlementRuntime, funds = 1_000_000): Promise<void> {
    must(await rt.ports.ledger.openAccount({ ...KEY, unit: UNIT }));
    must(await rt.ports.ledger.grant({ ...KEY, grantId: "g0", unit: UNIT, amount: funds, source: "purchase" }));
  }

  function durable(rt: PgSettlementRuntime, timer: { clock: { nowMs(): number } }) {
    const d = createDurableLedger({ ledger: rt.ports.ledger, outbox: rt.ports.outbox, clock: timer.clock, graceMs: GRACE, onUnknownCost: "forfeit" });
    if (!d.ok) throw new Error(d.error.issues.join(";"));
    return d.value;
  }

  async function migrated(rt: PgSettlementRuntime): Promise<void> {
    const m = await rt.migrate();
    if (!m.ok) throw new Error(`migrate: ${m.stage}/${m.code}`);
  }

  async function bal(rt: PgSettlementRuntime) {
    const b = must(await rt.ports.ledger.balance(KEY));
    return b;
  }

  it("بدونِ مهاجرت: start ⇒ NOT_MIGRATED، health=down و هیچ شِمایی ساخته نمی‌شود (start مهاجرت نمی‌کند)", async () => {
    const t = await pg();
    const timer = manualTimer();
    const rt = build(t, timer);
    expect(await rt.start()).toEqual({ started: false, reason: "PREFLIGHT_FAILED", code: "NOT_MIGRATED" });
    expect(rt.health()).toMatchObject({ httpStatus: 503, health: { status: "down" } });
    expect(timer.pending()).toBe(0);
    expect(await t.raw("SELECT 1 FROM pg_namespace WHERE nspname = $1 OR nspname = $2", [t.ledgerSchema, t.settlementSchema])).toHaveLength(0);
  });

  it("مهاجرتِ صریح: دفتر و outbox؛ دوباره اجرا idempotent؛ سپس start موفق است", async () => {
    const t = await pg();
    const timer = manualTimer();
    const rt = build(t, timer);
    const m1 = await rt.migrate();
    expect(m1.ok).toBe(true);
    if (m1.ok) {
      expect(m1.applied.ledger.length).toBeGreaterThan(0);
      expect(m1.applied.settlement).toEqual(["0001_init", "0002_dead_ack"]);
    }
    expect(await rt.migrate()).toMatchObject({ ok: true, applied: { ledger: [], settlement: [] } });
    expect((await rt.start()).started).toBe(true);
    await rt.stop();
  });

  it("مهاجرتِ ناقص (فقط دفتر): outbox NOT_MIGRATED؛ پس از تکمیل می‌شود start کرد", async () => {
    const t = await pg();
    const timer = manualTimer();
    const store = createPgAccountStore(t.db, { schema: t.ledgerSchema });
    if (!store.ok) throw new Error("store");
    must(await store.value.migrate());
    const rt = build(t, timer);
    expect(await rt.start()).toEqual({ started: false, reason: "PREFLIGHT_FAILED", code: "NOT_MIGRATED" });
    expect((await rt.migrate()).ok).toBe(true);
    expect((await rt.start()).started).toBe(true);
    await rt.stop();
  });

  it("مهاجرتِ دست‌کاری‌شده (checksum) ⇒ SCHEMA_MISMATCH و حلقه شروع نمی‌شود", async () => {
    const t = await pg();
    const timer = manualTimer();
    const rt = build(t, timer);
    await rt.migrate();
    await t.raw("UPDATE {{s}}.settlement_migration_ledger SET checksum = $1", ["0".repeat(64)]);
    expect(await rt.start()).toEqual({ started: false, reason: "PREFLIGHT_FAILED", code: "SCHEMA_MISMATCH" });
    expect(timer.pending()).toBe(0);
  });

  it("مهاجرتِ معلق (ردیفِ ۰۰۰۲ برداشته شد) ⇒ NOT_MIGRATED", async () => {
    const t = await pg();
    const timer = manualTimer();
    const rt = build(t, timer);
    await migrated(rt);
    await t.raw("DELETE FROM {{s}}.settlement_migration_ledger WHERE name = $1", ["0002_dead_ack"]);
    expect(await rt.start()).toEqual({ started: false, reason: "PREFLIGHT_FAILED", code: "NOT_MIGRATED" });
  });

  it("مهاجرتِ معلقِ دفتر (با outboxِ کامل) هم جلوی start را می‌گیرد ⇒ NOT_MIGRATED", async () => {
    const t = await pg();
    const timer = manualTimer();
    const rt = build(t, timer);
    await migrated(rt);
    await t.raw("DELETE FROM {{l}}.migration_ledger WHERE name = (SELECT name FROM {{l}}.migration_ledger ORDER BY name DESC LIMIT 1)");
    expect(await rt.start()).toEqual({ started: false, reason: "PREFLIGHT_FAILED", code: "NOT_MIGRATED" });
    expect(timer.pending()).toBe(0);
  });

  it("migrate: شکست در هر مرحله با نامِ مرحله و کدِ بسته گزارش می‌شود (دفتر / outbox)", async () => {
    const t = await pg();
    const timer = manualTimer();
    const rt = build(t, timer);
    await migrated(rt);
    await t.raw("UPDATE {{s}}.settlement_migration_ledger SET checksum = $1", ["0".repeat(64)]);
    expect(await rt.migrate()).toEqual({ ok: false, stage: "settlement", code: "MIGRATION_TAMPERED" });
    await t.raw("UPDATE {{l}}.migration_ledger SET checksum = $1", ["0".repeat(64)]);
    expect(await rt.migrate()).toEqual({ ok: false, stage: "ledger", code: "MIGRATION_TAMPERED" });
  });

  it("پایگاهِ قطع (استخر بسته) ⇒ start: UNAVAILABLE و migrate: DB_ERROR، هر دو بی‌پرتاب و بی‌نشتِ رشتهٔ اتصال", async () => {
    const t = await pg();
    const timer = manualTimer();
    const rt = build(t, timer);
    await rt.migrate();
    await t.killPrimary();
    const s = await rt.start();
    expect(s).toEqual({ started: false, reason: "PREFLIGHT_FAILED", code: "UNAVAILABLE" });
    const m = await rt.migrate();
    expect(m.ok).toBe(false);
    expect(JSON.stringify([s, m, rt.health()])).not.toMatch(/postgres(ql)?:\/\//);
  });

  it("رزروِ یتیم از ریشهٔ ترکیب بسته می‌شود؛ ممیزیِ ledger و outbox done", async () => {
    const t = await pg();
    const timer = manualTimer();
    const rt = build(t, timer);
    await migrated(rt);
    await fund(rt);
    const d = durable(rt, timer);
    must(await d.reserve(reserveInput("r1")));
    expect((await rt.start()).started).toBe(true);
    await settle(rt, timer, GRACE - 1);
    expect((await bal(rt)).held).toBe(WORST);
    await settle(rt, timer, 1 + 2 * INTERVAL);
    expect(await bal(rt)).toMatchObject({ held: 0, available: 1_000_000 - WORST, totals: { forfeited: WORST, charged: 0 } });
    expect(must(await rt.ports.outbox.get({ ...KEY, reservationId: "r1" }))).toMatchObject({ state: "done" });
    const store = createPgAccountStore(t.db, { schema: t.ledgerSchema });
    if (!store.ok) throw new Error("store");
    expect(must(await store.value.audit(KEY))).toMatchObject({ exists: true, ok: true, problems: [] });
    expect(rt.health()).toMatchObject({ httpStatus: 200, health: { status: "ok" } });
    await rt.stop();
  });

  it("ریستارتِ فرایند: اجرای تازه (استخرِ تازه) رزروهای فرایندِ مرده را می‌بندد", async () => {
    const t = await pg();
    const timer = manualTimer();
    const a = build(t, timer);
    await migrated(a);
    await fund(a);
    const d = durable(a, timer);
    for (let i = 0; i < 6; i++) must(await d.reserve(reserveInput(`r${i}`)));
    await t.killPrimary(); // «فرایند» مرد؛ هیچ sweep اجرا نشده
    const proc = t.another();
    cleanups.push(proc.close);
    const b = build({ db: proc.db, ledgerSchema: t.ledgerSchema, settlementSchema: t.settlementSchema }, timer);
    expect((await b.start()).started).toBe(true);
    await settle(b, timer, GRACE + 3 * INTERVAL);
    expect(await bal(b)).toMatchObject({ held: 0, totals: { forfeited: 6 * WORST } });
    await b.stop();
  });

  it("دو فرایندِ هم‌زمان (استخرهای جدا) هیچ رزروی را دوبار نمی‌بندند", async () => {
    const t = await pg();
    const timer = manualTimer();
    const a = build(t, timer, { limit: 4 });
    await migrated(a);
    await fund(a);
    const d = durable(a, timer);
    for (let i = 0; i < 16; i++) must(await d.reserve(reserveInput(`r${i}`)));
    const other = t.another();
    cleanups.push(other.close);
    const b = build({ db: other.db, ledgerSchema: t.ledgerSchema, settlementSchema: t.settlementSchema }, timer, { limit: 4 });
    expect((await a.start()).started).toBe(true);
    expect((await b.start()).started).toBe(true);
    for (let i = 0; i < 12; i++) {
      await timer.advance(GRACE / 8 + (i === 0 ? GRACE : 0));
      await sleep(0);
      await until(() => !a.status().loop.busy && !b.status().loop.busy, "پایانِ گذرها");
    }
    expect(await bal(a)).toMatchObject({ held: 0, totals: { forfeited: 16 * WORST, charged: 0 } });
    const store = createPgAccountStore(t.db, { schema: t.ledgerSchema });
    if (!store.ok) throw new Error("store");
    expect(must(await store.value.audit(KEY))).toMatchObject({ ok: true });
    await a.stop();
    await b.stop();
  });

  it("پایگاه وسطِ کار قطع می‌شود: حلقه نمی‌میرد، سلامت به degraded/down می‌رود", async () => {
    const t = await pg();
    const timer = manualTimer();
    const rt = build(t, timer);
    await migrated(rt);
    await fund(rt);
    expect((await rt.start()).started).toBe(true);
    await settle(rt, timer, INTERVAL * 2);
    expect(rt.health().health.status).toBe("ok");
    await t.killPrimary();
    await settle(rt, timer, GRACE / 2 + 1, 1000);
    expect(rt.health().health.status).not.toBe("ok");
    expect(rt.status().loop.state).toBe("running");
    await settle(rt, timer, GRACE, 1000);
    expect(rt.health()).toMatchObject({ httpStatus: 503, health: { status: "down" } });
    await rt.stop();
  });

  it("دودیِ زمانِ واقعی: ساعتِ سیستم + setTimeout (پیش‌فرض‌ها) رزروِ یتیم را می‌بندد و سلامت ok است", async () => {
    const t = await pg();
    const rt = createPgSettlementRuntime({ db: t.db, ledgerSchema: t.ledgerSchema, settlementSchema: t.settlementSchema, graceMs: 120, deadLetters: false, timer: createNodeTimer() });
    if (!rt.ok) throw new Error(rt.error.issues.join(";"));
    const run = rt.value;
    await migrated(run);
    must(await run.ports.ledger.openAccount({ ...KEY, unit: UNIT }));
    must(await run.ports.ledger.grant({ ...KEY, grantId: "g0", unit: UNIT, amount: 100_000, source: "purchase" }));
    const clock = createSystemClock();
    const d = createDurableLedger({ ledger: run.ports.ledger, outbox: run.ports.outbox, clock, graceMs: 120, onUnknownCost: "forfeit" });
    if (!d.ok) throw new Error("durable");
    must(await d.value.reserve(reserveInput("r1")));
    expect((await run.start()).started).toBe(true);
    await until(async () => (must(await run.ports.ledger.balance(KEY)) as { held: number }).held === 0, "بسته‌شدنِ رزرو با زمانِ واقعی", 1500);
    expect(must(await run.ports.ledger.balance(KEY))).toMatchObject({ held: 0, totals: { forfeited: WORST } });
    expect(run.health().health.status).toBe("ok");
    expect(await run.stop()).toEqual({ clean: true });
  });
});
