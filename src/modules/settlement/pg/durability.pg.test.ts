/**
 * ماندگاریِ واقعی (ADR-0022) — دلیلِ وجودِ این برش. «فرایند» = استخرِ اتصالِ جدا + دفترِ PostgreSQL + outbox PostgreSQL؛ «مرگ» = بستنِ همهٔ اتصال‌های آن
 * فرایند در نقطهٔ مشخص (تماسی که هرگز برنمی‌گردد). فرایندِ تازه (استخرِ تازه، نمونهٔ تازه، هیچ حافظهٔ مشترک) باید با رفتگر همه‌چیز را ببندد.
 * این همان چیزی است که `createMemoryOutbox` نمی‌توانست ثابت کند (تحویل ۰۰۲۱ «محدودیت‌های صادقانه»).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createLedger, createPgAccountStore } from "@/modules/ledger";
import type { Ledger } from "@/modules/ledger";
import { createDurableMeteredGateway } from "../durable-gateway";
import { createMemoryOutbox } from "../memory-outbox";
import { createSettlementSweeper } from "../sweeper";
import { GRACE, KEY, REQUEST, TTL, UNIT, WORST, auditLedger, durableConfig, fakeGateway, journal, mutableClock, okResult, refOf } from "../test-kit";
import type { OutboxEntry, OutboxResult, SettlementOutbox } from "../types";
import { createPgSettlementOutbox } from "./store";
import { TEST_DB_URL, dbDescribe, openPgOutbox, type TestOutbox } from "./test-db";
import type { LedgerDatabase } from "@/modules/ledger";

const must = <T>(r: OutboxResult<T>): T => {
  if (!r.ok) throw new Error(`انتظار موفقیت بود: ${r.error.code}`);
  return r.value;
};
const hang = (): Promise<never> => new Promise(() => undefined);
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
async function until(cond: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 1500; i++) {
    if (await cond()) return;
    await sleep(2);
  }
  throw new Error(`انتظار برای «${what}» به پایان رسید`);
}

dbDescribe("settlement/pg · بقا از مرگِ فرایند", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  /** یک «فرایند»: استخرِ جدا، ذخیرهٔ دفترِ PostgreSQL و outbox PostgreSQL روی همان شِما. */
  async function spawn(t: TestOutbox, clock: ReturnType<typeof mutableClock>) {
    const pool = new Pool({ connectionString: TEST_DB_URL, max: 6 });
    const db = drizzle(pool);
    const store = createPgAccountStore(db, { schema: t.schema });
    const ob = createPgSettlementOutbox(db, { schema: t.schema });
    if (!store.ok || !ob.ok) throw new Error("spawn failed");
    const ledger = createLedger({ store: store.value, clock });
    if (!ledger.ok) throw new Error("ledger failed");
    let ended = false;
    const kill = async () => {
      if (ended) return;
      ended = true;
      await pool.end();
    };
    cleanups.push(kill);
    return { ledger: ledger.value, store: store.value, outbox: ob.value as SettlementOutbox, kill };
  }
  type Proc = Awaited<ReturnType<typeof spawn>>;

  async function world(funds = 10_000) {
    const t = await openPgOutbox(4);
    cleanups.push(t.dispose);
    const clock = mutableClock();
    // دفتر در همان شِمای outbox migrate می‌شود (هم‌زیستی واقعی)
    const boot = createPgAccountStore(t.db, { schema: t.schema });
    if (!boot.ok) throw new Error("boot");
    const m = await boot.value.migrate();
    if (!m.ok) throw new Error(`ledger migrate: ${m.error.code}`);
    const a = await spawn(t, clock);
    const o = await a.ledger.openAccount({ ...KEY, unit: UNIT });
    if (!o.ok) throw new Error("open");
    const g = await a.ledger.grant({ ...KEY, grantId: "g0", unit: UNIT, amount: funds, source: "purchase" });
    if (!g.ok) throw new Error("grant");
    return { t, clock, a, spawn: () => spawn(t, clock) };
  }

  const sweeperOf = (p: Proc, clock: ReturnType<typeof mutableClock>) => {
    const s = createSettlementSweeper({ ledger: p.ledger, outbox: p.outbox, clock });
    if (!s.ok) throw new Error(s.error.issues.join(";"));
    return s.value;
  };
  const gatewayOf = (p: Proc, clock: ReturnType<typeof mutableClock>, steps: Parameters<typeof fakeGateway>[0], ledger: Ledger = p.ledger, policy: "forfeit" | "release" = "forfeit") => {
    const gateway = fakeGateway(steps);
    const made = createDurableMeteredGateway(durableConfig(ledger, gateway, p.outbox, clock, { onUnknownCost: policy }));
    if (!made.ok) throw new Error(made.error.issues.join(";"));
    return { gw: made.value, gateway };
  };

  it.each(["forfeit", "release"] as const)("فرایند وسط تماسِ مدل می‌میرد (سیاست %s): فرایندِ تازه با رفتگر رزروِ یتیم را می‌بندد؛ رکوردِ outbox از مرگ جان به‌در برده است", async (policy) => {
    const w = await world();
    const { gw, gateway } = gatewayOf(w.a, w.clock, hang, w.a.ledger, policy);
    void gw.complete(REQUEST);
    await until(async () => gateway.calls.length === 1, "تماس به دروازه رسید");
    expect(must(await w.t.outbox.counts())).toEqual({ open: 1, settling: 0, done: 0, dead: 0 });
    await w.a.kill(); // مرگِ فرایند: همهٔ اتصال‌ها بسته؛ هزینه‌ای که فقط در حافظه بود می‌رفت

    const b = await w.spawn();
    expect(must(await b.outbox.get(refOf("scope-1.r1")))).toMatchObject({ state: "open", orphanRemainder: policy });
    const sweeper = sweeperOf(b, w.clock);
    expect(await sweeper.sweep()).toMatchObject({ examined: 0 }); // هنوز سررسید نشده
    w.clock.advance(GRACE);
    expect(await sweeper.sweep()).toMatchObject({ examined: 1, settled: 1, buried: [] });
    const audit = await auditLedger(b.store);
    if (policy === "forfeit") expect(audit).toMatchObject({ held: 0, forfeited: WORST, available: 10_000 - WORST });
    else expect(audit).toMatchObject({ held: 0, forfeited: 0, available: 10_000 });
    expect(must(await b.outbox.counts())).toEqual({ open: 0, settling: 0, done: 1, dead: 0 });
  });

  it("مرگ پس از ثبتِ قصدِ مصرف و پیش از اجرای آن روی دفتر: فرایندِ تازه هزینه را دقیقاً یک بار می‌گیرد", async () => {
    const w = await world();
    const stuck: Ledger = { ...w.a.ledger, charge: hang };
    const { gw, gateway } = gatewayOf(w.a, w.clock, [okResult(100)], stuck);
    void gw.complete(REQUEST);
    await until(async () => (must(await w.t.outbox.get(refOf("scope-1.r1"))) as OutboxEntry | null)?.charge != null, "قصدِ مصرف ثبت شد");
    expect(gateway.calls).toHaveLength(1);
    expect((await journal(w.a.ledger)).filter((e) => e.type === "charge")).toHaveLength(0); // دفتر هنوز دست‌نخورده
    await w.a.kill();

    const b = await w.spawn();
    w.clock.advance(GRACE);
    expect(await sweeperOf(b, w.clock).sweep()).toMatchObject({ examined: 1, settled: 1 });
    expect(await auditLedger(b.store)).toMatchObject({ available: 10_000 - 100, held: 0, charged: 100, forfeited: 0 });
    expect((await journal(b.ledger)).filter((e) => e.type === "charge")).toHaveLength(1);
  });

  it("مرگ پس از ثبتِ قصدِ بستن و پیش از بستنِ دفتر (هزینه گرفته شده): بازپخش هزینه را دوباره نمی‌گیرد، باقیمانده آزاد می‌شود", async () => {
    const w = await world();
    const stuck: Ledger = { ...w.a.ledger, close: hang };
    const { gw } = gatewayOf(w.a, w.clock, [okResult(100)], stuck);
    void gw.complete(REQUEST);
    await until(async () => (must(await w.t.outbox.get(refOf("scope-1.r1"))) as OutboxEntry | null)?.close != null, "قصدِ بستن ثبت شد");
    expect((await journal(w.a.ledger)).filter((e) => e.type === "charge")).toHaveLength(1);
    await w.a.kill();

    const b = await w.spawn();
    const entry = must(await b.outbox.get(refOf("scope-1.r1"))) as OutboxEntry;
    expect(entry).toMatchObject({ state: "settling", charge: { amount: 100 }, close: { remainder: "release", origin: "caller" } });
    w.clock.advance(GRACE);
    expect(await sweeperOf(b, w.clock).sweep()).toMatchObject({ settled: 1 });
    expect(await auditLedger(b.store)).toMatchObject({ available: 10_000 - 100, held: 0, charged: 100 });
    expect((await journal(b.ledger)).filter((e) => e.type === "charge")).toHaveLength(1);
  });

  it("چند رفتگرِ پیاپی و موازی پس از بازیابی: بی‌اثرِ اضافه (دفتر و outbox دست‌نخورده می‌مانند)", async () => {
    const w = await world();
    const stuck: Ledger = { ...w.a.ledger, close: hang };
    const { gw } = gatewayOf(w.a, w.clock, [okResult(70)], stuck);
    void gw.complete(REQUEST);
    await until(async () => (must(await w.t.outbox.get(refOf("scope-1.r1"))) as OutboxEntry | null)?.close != null, "قصدِ بستن");
    await w.a.kill();
    const [b, c, d] = [await w.spawn(), await w.spawn(), await w.spawn()];
    w.clock.advance(GRACE);
    await Promise.all([sweeperOf(b, w.clock).sweep(), sweeperOf(c, w.clock).sweep(), sweeperOf(d, w.clock).sweep()]);
    const j = (await journal(b.ledger)).length;
    const audit = await auditLedger(b.store);
    expect(audit).toMatchObject({ charged: 70, held: 0, available: 10_000 - 70 });
    for (const p of [b, c, d, b]) expect(await sweeperOf(p, w.clock).sweep()).toMatchObject({ examined: 0 });
    expect((await journal(b.ledger)).length).toBe(j);
    expect(must(await b.outbox.counts())).toEqual({ open: 0, settling: 0, done: 1, dead: 0 });
  });

  it("۲۰ تماسِ هم‌زمان همه وسط کار می‌میرند؛ ۳ رفتگرِ موازی روی ۳ فرایندِ تازه همه را می‌بندند: نگه‌داشتهٔ دفتر صفر، سوختِ هر رزرو دقیقاً یک بار", async () => {
    const w = await world(10_000);
    const { gw, gateway } = gatewayOf(w.a, w.clock, hang);
    for (let i = 0; i < 20; i++) void gw.complete(REQUEST);
    await until(async () => gateway.calls.length === 20, "۲۰ تماس به دروازه رسید");
    expect(must(await w.t.outbox.counts())).toEqual({ open: 20, settling: 0, done: 0, dead: 0 });
    await w.a.kill();

    const procs = [await w.spawn(), await w.spawn(), await w.spawn()];
    w.clock.advance(GRACE);
    const reports = await Promise.all(procs.map((p) => sweeperOf(p, w.clock).sweep()));
    expect(reports.reduce((n, r) => n + r.buried.length, 0)).toBe(0);
    const p0 = procs[0] as Proc;
    expect(must(await p0.outbox.counts())).toEqual({ open: 0, settling: 0, done: 20, dead: 0 });
    expect(await auditLedger(p0.store)).toMatchObject({ held: 0, forfeited: 20 * WORST, available: 10_000 - 20 * WORST, charged: 0 });
    expect((await journal(p0.ledger)).filter((e) => e.type === "forfeit")).toHaveLength(20);
  });

  it("همهٔ حالت‌های رکورد (open/settling/done/dead) با همهٔ میدان‌ها از ریستارت جان به‌در می‌برند؛ listDead و counts هم", async () => {
    const t = await openPgOutbox(4);
    cleanups.push(t.dispose);
    const o = t.outbox;
    const base = { tenantId: "t1", accountId: "a1", unit: "IRR_MICROS", reserved: 500, createdAtMs: 1_000, expiresAtMs: 61_000, dueAtMs: 11_000, orphanRemainder: "forfeit" as const };
    for (const id of ["open1", "set1", "done1", "dead1", "dead2"]) must(await o.begin({ ...base, reservationId: id }));
    const ref = (id: string) => ({ tenantId: "t1", accountId: "a1", reservationId: id });
    must(await o.recordCharge(ref("set1"), { attemptId: "a1", amount: 42 }));
    must(await o.recordFailure(ref("set1"), { errorCode: "STORE_FAILURE", dueAtMs: 31_000 }));
    must(await o.recordCharge(ref("done1"), { attemptId: "a1", amount: 7 }));
    must(await o.recordClose(ref("done1"), { remainder: "release", origin: "caller" }));
    must(await o.finish(ref("done1"), 12_345));
    must(await o.bury(ref("dead1"), { reason: "EXPIRED_UNBILLED", errorCode: "RESERVATION_EXPIRED", atMs: 70_000 }));
    must(await o.bury(ref("dead2"), { reason: "ATTEMPTS_EXHAUSTED", errorCode: null, atMs: 70_000 }));
    const snap = async (x: SettlementOutbox) => ({ counts: must(await x.counts()), due: must(await x.listDue({ nowMs: 9e9, limit: 100 })), dead: must(await x.listDead({ limit: 100 })), all: await Promise.all(["open1", "set1", "done1", "dead1", "dead2"].map(async (id) => must(await x.get(ref(id))))) });
    const before = await snap(o);
    expect(before.counts).toEqual({ open: 1, settling: 1, done: 1, dead: 2 });

    await t.kill();
    const re = await t.reopen();
    cleanups.push(re.close);
    const after = await snap(re.outbox);
    expect(after).toEqual(before);
    expect(after.all[1]).toMatchObject({ state: "settling", charge: { attemptId: "a1", amount: 42 }, attempts: 1, lastErrorCode: "STORE_FAILURE", dueAtMs: 31_000 });
    expect(after.all[2]).toMatchObject({ state: "done", settledAtMs: 12_345, close: { remainder: "release", origin: "caller" } });
    expect(after.dead.map((e) => e.deadReason)).toEqual(["EXPIRED_UNBILLED", "ATTEMPTS_EXHAUSTED"]);
  });

  it("رفتگرِ دیرآمد در فرایندِ تازه: مرگِ مستند EXPIRED_UNBILLED در listDead می‌ماند و پس از ریستارتِ بعدی هم هست؛ هرگز حذف نمی‌شود", async () => {
    const w = await world();
    const { gw } = gatewayOf(w.a, w.clock, hang);
    void gw.complete(REQUEST);
    await until(async () => (must(await w.t.outbox.counts()) as { open: number }).open === 1, "رکورد ثبت شد");
    await w.a.kill();
    const b = await w.spawn();
    w.clock.advance(TTL + 1);
    const rep = await sweeperOf(b, w.clock).sweep();
    expect(rep.buried).toMatchObject([{ reservationId: "scope-1.r1", reason: "EXPIRED_UNBILLED" }]);
    expect(await auditLedger(b.store)).toMatchObject({ held: 0, charged: 0, forfeited: 0, available: 10_000 });
    await b.kill();
    const c = await w.spawn();
    const dead = must(await c.outbox.listDead({ limit: 10 }));
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ state: "dead", deadReason: "EXPIRED_UNBILLED" });
    expect(await sweeperOf(c, w.clock).sweep()).toMatchObject({ examined: 0 });
    await expect(w.t.raw("DELETE FROM {{s}}.settlement_outbox")).rejects.toThrow();
    expect(must(await c.outbox.counts()).dead).toBe(1);
  });

  it("مسیر موفق روی PostgreSQL (بی‌مرگ): رکوردِ done، دفتر درست، رفتگر کاری ندارد", async () => {
    const w = await world();
    const { gw } = gatewayOf(w.a, w.clock, [okResult(100)]);
    const r = await gw.complete(REQUEST);
    expect(r.ok).toBe(true);
    expect(must(await w.a.outbox.counts())).toEqual({ open: 0, settling: 0, done: 1, dead: 0 });
    expect(await sweeperOf(w.a, w.clock).sweep()).toMatchObject({ examined: 0 });
    expect(await auditLedger(w.a.store)).toMatchObject({ available: 10_000 - 100, held: 0, charged: 100 });
  });

  it("خرابیِ outbox در لحظهٔ begin (پایگاهِ outbox قطع): تماسِ پولی انجام نمی‌شود و رزرو برمی‌گردد (بسته‌شکست)", async () => {
    const w = await world();
    const dead = new Pool({ connectionString: TEST_DB_URL, max: 1 });
    await dead.end();
    const broken = createPgSettlementOutbox(drizzle(dead), { schema: w.t.schema });
    if (!broken.ok) throw new Error("x");
    const gateway = fakeGateway([okResult(100)]);
    const made = createDurableMeteredGateway(durableConfig(w.a.ledger, gateway, broken.value, w.clock, {}));
    if (!made.ok) throw new Error(made.error.issues.join(";"));
    const res = await made.value.complete(REQUEST);
    const meta = res.ok ? res.value.metering : res.error.metering;
    expect(meta).toMatchObject({ outcome: "refused", refusal: { code: "RESERVE_FAILED" } });
    expect(gateway.calls).toHaveLength(0);
    expect(await auditLedger(w.a.store)).toMatchObject({ available: 10_000, held: 0 });
  });

  describe("اتمی‌بودن: شکستِ پایگاه در هر دستورِ هر عملیات ⇒ هیچ‌چیز نوشته نمی‌شود و تکرار همان نتیجهٔ بی‌خطا را می‌دهد", () => {
    const BEGIN = (id: string) => ({ tenantId: "t1", accountId: "a1", reservationId: id, unit: "IRR_MICROS", reserved: 500, createdAtMs: 1_000, expiresAtMs: 61_000, dueAtMs: 11_000, orphanRemainder: "forfeit" as const });
    const ref = (id: string) => ({ tenantId: "t1", accountId: "a1", reservationId: id });
    type Case = { name: string; pre: (o: SettlementOutbox, id: string) => Promise<void>; op: (o: SettlementOutbox, id: string) => Promise<unknown> };
    const cases: Case[] = [
      { name: "begin", pre: async () => undefined, op: (o, id) => o.begin(BEGIN(id)) },
      { name: "recordCharge", pre: async (o, id) => void (await o.begin(BEGIN(id))), op: (o, id) => o.recordCharge(ref(id), { attemptId: "a1", amount: 9 }) },
      { name: "recordClose", pre: async (o, id) => void (await o.begin(BEGIN(id)), await o.recordCharge(ref(id), { attemptId: "a1", amount: 9 })), op: (o, id) => o.recordClose(ref(id), { remainder: "release", origin: "caller" }) },
      { name: "resolveClose", pre: async (o, id) => void (await o.begin(BEGIN(id)), await o.recordCharge(ref(id), { attemptId: "a1", amount: 9 })), op: (o, id) => o.resolveClose(ref(id)) },
      { name: "finish", pre: async (o, id) => void (await o.begin(BEGIN(id)), await o.recordClose(ref(id), { remainder: "forfeit", origin: "caller" })), op: (o, id) => o.finish(ref(id), 77) },
      { name: "recordFailure", pre: async (o, id) => void (await o.begin(BEGIN(id))), op: (o, id) => o.recordFailure(ref(id), { errorCode: "STORE_FAILURE", dueAtMs: 21_000 }) },
      { name: "bury", pre: async (o, id) => void (await o.begin(BEGIN(id))), op: (o, id) => o.bury(ref(id), { reason: "LEDGER_REJECTED", errorCode: "X", atMs: 5 }) },
    ];

    function failingAt(db: LedgerDatabase, k: number): LedgerDatabase & { statements: () => number } {
      let n = 0;
      return {
        execute: (q) => db.execute(q),
        transaction: (run, cfg) =>
          db.transaction(
            (tx) =>
              run({
                execute: async (q) => {
                  n += 1;
                  if (n === k) throw Object.assign(new Error("boom: LEAK-CANARY"), { code: "57P01" });
                  return tx.execute(q);
                },
              }),
            cfg,
          ),
        statements: () => n,
      };
    }

    it.each(cases)("$name", async ({ name, pre, op }) => {
      const t = await openPgOutbox(4);
      cleanups.push(t.dispose);
      const withFault = (k: number) => {
        const f = failingAt(t.db, k);
        const made = createPgSettlementOutbox(f, { schema: t.schema });
        if (!made.ok) throw new Error("x");
        return { outbox: made.value, f };
      };
      // ۱) شمارِ دستورهای عملیات (بی‌خطا) روی رکوردِ آزمایشی
      await pre(t.outbox, "probe");
      const probe = withFault(Number.MAX_SAFE_INTEGER);
      await op(probe.outbox, "probe");
      const total = probe.f.statements();
      expect(total, `${name}: دست‌کم سپرِ مهاجرت + یک دستور`).toBeGreaterThanOrEqual(2);

      for (let k = 1; k <= total; k++) {
        const id = `k${k}`;
        const twin = createMemoryOutbox();
        await pre(twin, id);
        const expected = await op(twin, id);
        const expectedState = await twin.get(ref(id));

        await pre(t.outbox, id);
        const before = await t.outbox.get(ref(id));
        const faulty = withFault(k);
        const failed = (await op(faulty.outbox, id)) as OutboxResult<unknown>;
        expect(failed, `${name} k=${k}`).toEqual({ ok: false, error: { code: "STORE_FAILURE", message: "ذخیرهٔ outbox در دسترس نیست." } });
        expect(JSON.stringify(failed)).not.toContain("LEAK");
        expect(await t.outbox.get(ref(id)), `${name} k=${k}: حالت پس از شکست باید دست‌نخورده باشد`).toEqual(before);

        const retried = await op(t.outbox, id);
        expect(retried, `${name} k=${k}: تکرار`).toEqual(expected);
        expect(await t.outbox.get(ref(id))).toEqual(expectedState);
      }
    });
  });
});
