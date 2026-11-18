/**
 * حلقهٔ رفتگر روی PostgreSQL واقعی (ADR-0023). «فرایند» = استخرِ اتصالِ جدا + دفتر و outbox PostgreSQL روی یک شِما؛ «مرگ» = بستنِ اتصال‌ها یا رها کردنِ گذرِ آویزان.
 * زمان مجازی است ولی I/O واقعی است؛ پس برای پیشروی `pump` پس از هر `advance` منتظر پایانِ واقعیِ گذر می‌ماند.
 * ثابت می‌کند: (۱) فرایندِ تازه با حلقه همهٔ رزروهای رهاشدهٔ فرایندِ مرده را می‌بندد؛ (۲) دو حلقهٔ هم‌زمان روی یک outbox هیچ رزروی را دوبار نمی‌بندند؛
 * (۳) مرگ وسط گذرِ حلقه بی‌ضرر است و هزینه دقیقاً یک بار گرفته می‌شود؛ (۴) قطعِ پایگاه حلقه را نمی‌کشد: عقب‌می‌نشیند و خطا اعلام می‌کند.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, expect, it } from "vitest";
import { createLedger, createPgAccountStore } from "@/modules/ledger";
import type { Ledger } from "@/modules/ledger";
import { createDurableLedger, createPgSettlementOutbox, createSweepLoop, createSettlementSweeper } from "./index";
import type { BuriedItem, LoopFault, SettlementOutbox, SweepLoop } from "./index";
import { GRACE, KEY, UNIT, WORST, auditLedger, chargeInput, journal, manualTimer, ok, refOf, reserveInput } from "./test-kit";
import type { ManualTimer, MutableClock } from "./test-kit";
import { TEST_DB_URL, dbDescribe, openPgOutbox } from "./pg/test-db";
import type { TestOutbox } from "./pg/test-db";

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
const hang = (): Promise<never> => new Promise(() => undefined);
const HALF = GRACE / 2;

async function until(cond: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 2500; i++) {
    if (await cond()) return;
    await sleep(2);
  }
  throw new Error(`انتظار برای «${what}» به پایان رسید`);
}

dbDescribe("settlement · حلقهٔ رفتگر روی PostgreSQL", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  async function spawn(t: TestOutbox, timer: ManualTimer) {
    const pool = new Pool({ connectionString: TEST_DB_URL, max: 3 });
    const db = drizzle(pool);
    const store = createPgAccountStore(db, { schema: t.schema });
    const ob = createPgSettlementOutbox(db, { schema: t.schema });
    if (!store.ok || !ob.ok) throw new Error("spawn failed");
    const made = createLedger({ store: store.value, clock: timer.clock });
    if (!made.ok) throw new Error("ledger failed");
    let ended = false;
    const kill = async () => {
      if (ended) return;
      ended = true;
      await pool.end();
    };
    cleanups.push(kill);
    return { ledger: made.value as Ledger, store: store.value, outbox: ob.value as SettlementOutbox, kill };
  }
  type Proc = Awaited<ReturnType<typeof spawn>>;

  async function world(funds = 1_000_000) {
    const t = await openPgOutbox(4);
    cleanups.push(t.dispose);
    const timer = manualTimer();
    const boot = createPgAccountStore(t.db, { schema: t.schema });
    if (!boot.ok) throw new Error("boot");
    const m = await boot.value.migrate();
    if (!m.ok) throw new Error(`ledger migrate: ${m.error.code}`);
    const a = await spawn(t, timer);
    ok(await a.ledger.openAccount({ ...KEY, unit: UNIT }));
    ok(await a.ledger.grant({ ...KEY, grantId: "g0", unit: UNIT, amount: funds, source: "purchase" }));
    return { t, timer, a, spawn: () => spawn(t, timer) };
  }

  function durableOf(p: Proc, timer: ManualTimer, policy: "forfeit" | "release" = "forfeit", ledger: Ledger = p.ledger): Ledger {
    const d = createDurableLedger({ ledger, outbox: p.outbox, clock: timer.clock, graceMs: GRACE, onUnknownCost: policy });
    if (!d.ok) throw new Error(d.error.issues.join(";"));
    return d.value;
  }

  function loopOf(p: Proc, timer: ManualTimer, over: Record<string, unknown> = {}, ledger: Ledger = p.ledger) {
    const buried: BuriedItem[] = [];
    const faults: LoopFault[] = [];
    const sw = createSettlementSweeper({ ledger, outbox: p.outbox, clock: timer.clock, limit: 5 });
    if (!sw.ok) throw new Error(sw.error.issues.join(";"));
    const made = createSweepLoop({
      sweeper: sw.value,
      timer,
      clock: timer.clock,
      graceMs: GRACE,
      intervalMs: 1000,
      observer: { onBuried: (i: readonly BuriedItem[]) => void buried.push(...i), onFault: (f: LoopFault) => void faults.push(f) },
      ...over,
    });
    if (!made.ok) throw new Error(made.error.issues.join(";"));
    return { loop: made.value as SweepLoop, buried, faults };
  }

  /** زمانِ مجازی را جلو می‌برد و پس از هر گام منتظر پایانِ واقعیِ گذرِ در حال اجرا می‌ماند، تا `cond` برقرار شود. */
  async function pump(timer: ManualTimer, loops: readonly SweepLoop[], cond: () => Promise<boolean>, what: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      await timer.advance(1000);
      await until(() => loops.every((l) => !l.status().busy), "پایانِ گذر");
      if (await cond()) return;
    }
    throw new Error(`pump: «${what}» برقرار نشد`);
  }

  const counts = async (o: SettlementOutbox) => ok(await o.counts());

  it("فرایندِ نخست با رزروهای رها‌شده (بی‌قصد و با قصدِ مصرف) می‌میرد؛ حلقهٔ فرایندِ تازه همه را می‌بندد و هزینه دقیقاً یک بار گرفته می‌شود", async () => {
    const w = await world();
    const dur = durableOf(w.a, w.timer);
    let expected = 0;
    for (let i = 0; i < 12; i++) {
      ok(await dur.reserve(reserveInput(`p${i}`)));
      if (i % 3 === 0) {
        ok(await dur.charge(chargeInput(`p${i}`, 10 + i)));
        expected += 10 + i;
      }
    }
    await w.a.kill(); // مرگ
    const b = await w.spawn();
    const x = loopOf(b, w.timer);
    expect(x.loop.start()).toEqual({ started: true });
    await pump(w.timer, [x.loop], async () => (await counts(b.outbox)).done === 12, "۱۲ رکورد done");
    expect(await counts(b.outbox)).toEqual({ open: 0, settling: 0, done: 12, dead: 0 });
    const audit = await auditLedger(b.store);
    expect(audit).toMatchObject({ held: 0, charged: expected });
    const terminal = (await journal(b.ledger)).filter((e) => e.type === "release" || e.type === "forfeit" || e.type === "expire");
    expect(new Set(terminal.map((e) => e.reservationId)).size).toBe(12);
    expect(terminal).toHaveLength(12);
    expect((await journal(b.ledger)).filter((e) => e.type === "charge")).toHaveLength(4);
    expect(x.buried).toEqual([]);
    expect(x.faults).toEqual([]);
    expect(x.loop.status().totals.settled).toBe(12);
    await x.loop.stop();
  });

  it("دو حلقهٔ زندهٔ هم‌زمان (دو فرایند) روی یک outbox: ۴۰ رزرو، هر کدام دقیقاً یک بار بسته می‌شود", async () => {
    const w = await world();
    const dur = durableOf(w.a, w.timer, "forfeit");
    for (let i = 0; i < 40; i++) ok(await dur.reserve(reserveInput(`q${i}`)));
    const b = await w.spawn();
    const c = await w.spawn();
    const lb = loopOf(b, w.timer);
    const lc = loopOf(c, w.timer);
    lb.loop.start();
    lc.loop.start();
    await pump(w.timer, [lb.loop, lc.loop], async () => (await counts(w.a.outbox)).done === 40, "۴۰ رکورد done");
    expect(await counts(w.a.outbox)).toEqual({ open: 0, settling: 0, done: 40, dead: 0 });
    expect(await auditLedger(w.a.store)).toMatchObject({ held: 0, forfeited: 40 * WORST, charged: 0 });
    const terminal = (await journal(w.a.ledger)).filter((e) => e.type === "forfeit" || e.type === "release" || e.type === "expire");
    expect(terminal).toHaveLength(40);
    expect(new Set(terminal.map((e) => e.reservationId)).size).toBe(40);
    // هر دو حلقه واقعاً کار کردند یا یکی همه را برد؛ جمعِ تسویه‌ها ۴۰ و مرگی نیست
    const total = lb.loop.status().totals.settled + lc.loop.status().totals.settled;
    expect(total).toBeGreaterThanOrEqual(40);
    expect(lb.buried.length + lc.buried.length).toBe(0);
    await Promise.all([lb.loop.stop(), lc.loop.stop()]);
  });

  it("مرگ وسط گذرِ حلقه (دفتر آویزان پس از ثبتِ قصدِ مصرف): حلقهٔ فرایندِ تازه هزینه را دقیقاً یک بار می‌گیرد؛ گذرِ آویزان هیچ زنگِ غلطی نمی‌زند", async () => {
    const w = await world();
    const dur = durableOf(w.a, w.timer, "forfeit");
    ok(await dur.reserve(reserveInput("d1")));
    ok(await w.a.outbox.recordCharge(refOf("d1"), { attemptId: "a1", amount: 77 })); // قصد ثبت شد؛ دفتر هنوز نه
    w.timer.delays.length = 0;
    const stuck: Ledger = { ...w.a.ledger, charge: hang };
    const x = loopOf(w.a, w.timer, { stopTimeoutMs: 50 }, stuck);
    x.loop.start();
    await w.timer.advance(GRACE + 1000); // گذرِ حلقه می‌رسد، رکورد سررسید است، ledger.charge آویزان می‌شود
    await until(() => x.loop.status().busy, "گذر در دفترِ آویزان گیر کرد");
    const stopping = x.loop.stop();
    await w.timer.advance(50);
    await expect(stopping).resolves.toEqual({ clean: false });
    await w.a.kill(); // مرگِ فرایندِ نخست
    expect((await w.t.raw("SELECT state FROM {{s}}.settlement_outbox"))[0]).toMatchObject({ state: "settling" });

    const b = await w.spawn();
    const y = loopOf(b, w.timer);
    y.loop.start();
    await pump(w.timer, [y.loop], async () => (await counts(b.outbox)).done === 1, "رکورد done");
    expect(await auditLedger(b.store)).toMatchObject({ charged: 77, held: 0 });
    expect((await journal(b.ledger)).filter((e) => e.type === "charge")).toHaveLength(1);
    expect(x.buried).toEqual([]);
    expect(y.buried).toEqual([]);
    await y.loop.stop();
  });

  it("قطعِ پایگاه (استخرِ بسته‌شده): حلقه نمی‌میرد، عقب می‌نشیند تا سقفِ ⌊grace/2⌋، LIST_FAILED اعلام می‌کند و بی‌نشت است", async () => {
    const w = await world();
    const b = await w.spawn();
    const x = loopOf(b, w.timer);
    x.loop.start();
    await pump(w.timer, [x.loop], async () => x.loop.status().runs >= 2, "دو گذرِ سالم");
    expect(x.faults).toEqual([]);
    await b.kill(); // پایگاه از دید این فرایند قطع شد
    w.timer.delays.length = 0;
    for (let i = 0; i < 12; i++) {
      await w.timer.advance(HALF);
      await until(() => !x.loop.status().busy, "پایانِ گذرِ ناموفق");
    }
    const st = x.loop.status();
    expect(st.state).toBe("running");
    expect(st.lastFault).toBe("LIST_FAILED");
    expect(st.consecutiveFailures).toBeGreaterThanOrEqual(5);
    expect(x.faults.length).toBe(st.totals.faults);
    expect(Math.max(...w.timer.delays)).toBe(HALF);
    expect(JSON.stringify([st, x.faults])).not.toMatch(/postgres|connection|ECONN|password|Cannot use a pool/i);
    await expect(x.loop.stop()).resolves.toEqual({ clean: true });
  });

  it("رزروِ منقضی‌شده پیش از دیدنِ حلقه ⇒ dead در PostgreSQL و فقط یک بار زنگ، حتی پس از ریستارتِ حلقه", async () => {
    const w = await world();
    const dur = durableOf(w.a, w.timer);
    ok(await dur.reserve(reserveInput("e1", WORST, 2 * GRACE)));
    await w.timer.advance(3 * GRACE);
    const b = await w.spawn();
    const x = loopOf(b, w.timer);
    x.loop.start();
    await pump(w.timer, [x.loop], async () => (await counts(b.outbox)).dead === 1, "رکورد dead");
    expect(x.buried).toEqual([{ tenantId: KEY.tenantId, accountId: KEY.accountId, reservationId: "e1", reason: "EXPIRED_UNBILLED", errorCode: "RESERVATION_EXPIRED" }]);
    await x.loop.stop();
    const c = await w.spawn();
    const y = loopOf(c, w.timer);
    y.loop.start();
    for (let i = 0; i < 5; i++) {
      await w.timer.advance(1000);
      await until(() => !y.loop.status().busy, "پایانِ گذر");
    }
    expect(y.buried).toEqual([]); // مرده‌ها دوباره زنگ نمی‌زنند (ثبتِ زنگِ ماندگار کارِ برش بعدی است)
    expect(await counts(c.outbox)).toEqual({ open: 0, settling: 0, done: 0, dead: 1 });
    await y.loop.stop();
  });
});
