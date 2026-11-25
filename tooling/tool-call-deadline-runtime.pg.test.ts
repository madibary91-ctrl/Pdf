/**
 * رفعِ «گامِ زامبی» (ADR-0066) روی **PostgreSQL واقعی** و حلقهٔ واقعیِ `settlement-runtime`: دروازهٔ ابزارِ ماندگار روی `ports`ِ یک فرایند، با
 * `tool-call-deadline` (سقفِ سختِ مهلتِ تماس) زیرِ آن. ADR-0065 نشان داد تماسِ زنده‌ای که از `graceMs` بگذرد رزروش را حلقه می‌بندد و پاسخش
 * `settlement-failed`/`SETTLEMENT_PENDING` می‌شود؛ این‌جا همان سناریو با `maxCallMs < graceMs` ناممکن می‌شود: خودِ دروازه پیش از مهلت می‌بندد و
 * حلقه هرگز چیزی برای بستن نمی‌یابد. زمانِ مجازیِ مشترکِ ساعتِ دفتر، حلقه و تایمرِ سقف (`manualTimer`) + I/O واقعی؛ یک دودیِ زمانِ واقعی
 * (تایمرِ پیش‌فرضِ ماژول + `createNodeTimer`، با `SMOKE_GRACE_MS`؛ ADR-0041). قیمت‌ها ساختگیِ test-kit ماژول‌اند. بدونِ پایگاه رد می‌شود.
 */
import { afterEach, expect, it } from "vitest";
import { createDurableToolGateway } from "@/modules/durable-tool-gateway";
import { GRACE, KEY, STEP, UNIT, WORST, configFor, ok, refOf, stepOk, stubGateway } from "@/modules/durable-tool-gateway/test-kit";
import type { StepReply } from "@/modules/durable-tool-gateway/test-kit";
import { createPgAccountStore } from "@/modules/ledger";
import type { Clock } from "@/modules/ledger";
import { createNodeTimer, createPgSettlementRuntime, createSystemClock } from "@/modules/settlement-runtime";
import type { PgSettlementRuntime, PgSettlementRuntimeConfig } from "@/modules/settlement-runtime";
import { dbDescribe, openPg } from "@/modules/settlement-runtime/test-db";
import { SMOKE_GRACE_MS, healthDiagnostics, manualTimer } from "@/modules/settlement-runtime/test-kit";
import type { ManualTimer } from "@/modules/settlement-runtime/test-kit";
import { checkTimingRelations, createDeadlineToolGateway } from "@/modules/tool-call-deadline";
import type { DeadlineEvent } from "@/modules/tool-call-deadline";

const FUNDS = 1_000_000;
const INTERVAL = GRACE / 4;
const hang = (): Promise<never> => new Promise(() => undefined);
const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
const meta = (r: { ok: boolean; value?: { metering: unknown }; error?: { metering: unknown } }): Record<string, unknown> => (r.ok ? r.value!.metering : r.error!.metering) as Record<string, unknown>;
const PG_TEXT = /settlement_outbox|relation|does not exist|42P01|LEAK-CANARY/i;

async function until(cond: () => boolean | Promise<boolean>, what: string, tries = 3000): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (await cond()) return;
    await sleep(2);
  }
  throw new Error(`انتظار برای «${what}» به پایان رسید`);
}

function gate(): { wait: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((res) => void (open = res));
  return { wait, open: () => open() };
}

dbDescribe("durable-tool-gateway + settlement-runtime · حلقهٔ خودکار روی PostgreSQL واقعی", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  type Db = PgSettlementRuntimeConfig["db"];

  /** دنیا: شِماهای یک‌بارمصرفِ دفتر و outbox، یک ساعتِ مجازیِ مشترک، فرایندِ برنامه (ports) و سازندهٔ فرایندهای حلقه‌دار. */
  async function world(funds = FUNDS) {
    const t = await openPg(4);
    cleanups.push(t.dispose);
    const timer = manualTimer();
    const mk = (db: Db, clock: Clock = timer.clock, over: Record<string, unknown> = {}): PgSettlementRuntime => {
      const r = createPgSettlementRuntime({ db, ledgerSchema: t.ledgerSchema, settlementSchema: t.settlementSchema, clock, timer, graceMs: GRACE, deadLetters: false, ...over });
      if (!r.ok) throw new Error(r.error.issues.join(";"));
      return r.value;
    };
    const app = mk(t.db);
    const m = await app.migrate();
    if (!m.ok) throw new Error(`migrate: ${m.stage}/${m.code}`);
    ok(await app.ports.ledger.openAccount({ ...KEY, unit: UNIT }));
    ok(await app.ports.ledger.grant({ ...KEY, grantId: "g0", unit: UNIT, amount: funds, source: "purchase" }));
    /** فرایندِ حلقه‌دارِ تازه (استخرِ جدا)؛ هنوز start نشده. */
    const loop = (over: Record<string, unknown> = {}): PgSettlementRuntime => {
      const p = t.another();
      cleanups.push(p.close);
      return mk(p.db as Db, timer.clock, over);
    };
    const audit = async (rt: PgSettlementRuntime) => {
      const p = t.another();
      cleanups.push(p.close);
      const store = createPgAccountStore(p.db, { schema: t.ledgerSchema });
      if (!store.ok) throw new Error("store");
      const a = ok(await store.value.audit(KEY));
      expect(a, healthDiagnostics(rt)).toMatchObject({ exists: true, ok: true, problems: [] });
    };
    return { t, timer, app, mk, loop, audit };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** دروازه روی `ports`ِ یک فرایند (همان سیم‌کشیِ برنامه). */
  function gatewayOn(rt: PgSettlementRuntime, clock: Clock, reply: StepReply | ((input: unknown, index: number) => unknown), over: Record<string, unknown> = {}) {
    const stub = stubGateway(reply);
    const made = createDurableToolGateway(configFor(rt.ports.ledger, stub.gateway, rt.ports.outbox, clock, over));
    if (!made.ok) throw new Error(made.error.issues.join(";"));
    return { gw: made.value, stub };
  }

  /** پیشروی در گام‌های فاصلهٔ گذر؛ پس از هر گام تا پایانِ واقعیِ گذرهای جاری صبر می‌کند (مثلِ runtime.pg.test). */
  async function settle(rts: readonly PgSettlementRuntime[], timer: ManualTimer, ms: number, step = INTERVAL): Promise<void> {
    for (let done = 0; done < ms; done += step) {
      await timer.advance(Math.min(step, ms - done));
      await sleep(0);
      await until(() => rts.every((r) => !r.status().loop.busy), "پایانِ گذر");
    }
  }

  const bal = async (rt: PgSettlementRuntime) => ok(await rt.ports.ledger.balance(KEY));
  /** موجودی بی‌`asOfMs` (زمانِ مجازی با هر گذر جلو می‌رود؛ مقایسهٔ پول نباید به آن وابسته باشد). */
  const money = async (rt: PgSettlementRuntime) => {
    const { asOfMs: _asOf, ...rest } = await bal(rt);
    void _asOf;
    return rest;
  };
  const counts = async (rt: PgSettlementRuntime) => ok(await rt.ports.outbox.counts());
  const okHealth = (rt: PgSettlementRuntime) => expect(rt.health().health.status, healthDiagnostics(rt)).toBe("ok");

  async function startAll(...rts: PgSettlementRuntime[]): Promise<void> {
    for (const r of rts) expect((await r.start()).started).toBe(true);
  }
  async function stopAll(...rts: PgSettlementRuntime[]): Promise<void> {
    for (const r of rts) expect(await r.stop()).toEqual({ clean: true });
  }

  const MAX_CALL = 4000;
  const terminals = async (rt: PgSettlementRuntime) => ok(await rt.ports.ledger.journal(KEY)).filter((e) => e.type === "forfeit" || e.type === "release" || e.type === "expire");
  const virtualTimers = (timer: ManualTimer) => ({ setTimeout: (fn: () => void, ms: number) => timer.after(fn, ms), clearTimeout: (h: unknown) => timer.cancel(h) });

  /** دروازهٔ ماندگار روی `ports`ِ یک فرایند با `tool-call-deadline` زیرِ آن (همان ترتیبِ سیم‌کشیِ ریشهٔ I/O). */
  function guardedOn(rt: PgSettlementRuntime, clock: Clock, reply: StepReply | ((input: unknown, index: number) => unknown), policy: "forfeit" | "release", deadline: Record<string, unknown>, graceMs = GRACE) {
    const stub = stubGateway(reply);
    const events: DeadlineEvent[] = [];
    const d = createDeadlineToolGateway({ gateway: stub.gateway, onEvent: (e: DeadlineEvent) => void events.push(e), ...deadline });
    if (!d.ok) throw new Error(d.error.issues.join(";"));
    const made = createDurableToolGateway(configFor(rt.ports.ledger, d.value, rt.ports.outbox, clock, { onUnknownCost: policy, graceMs }));
    if (!made.ok) throw new Error(made.error.issues.join(";"));
    return { gw: made.value, stub, events };
  }

  it("مقدارهای این آزمون با رابطه‌های ساختاری سازگارند", () => {
    expect(checkTimingRelations({ maxCallMs: MAX_CALL, graceMs: GRACE, reservationTtlMs: 60_000 })).toEqual([]);
  });

  it.each(["forfeit", "release"] as const)("گامِ زامبی رفع شد (سیاست %s): خودِ دروازه پیش از مهلت می‌بندد؛ حلقهٔ واقعی هرگز چیزی برای بستن ندارد؛ پاسخِ دیرهنگام بی‌اثر است", async (policy) => {
    const w = await world();
    const g = gate();
    const { gw, stub, events } = guardedOn(
      w.app,
      w.timer.clock,
      async () => {
        await g.wait;
        return stepOk(100);
      },
      policy,
      { maxCallMs: MAX_CALL, timers: virtualTimers(w.timer) },
    );
    const b = w.loop();
    await startAll(b);
    const call = gw.completeStep(STEP);
    await until(() => stub.inputs.length === 1, "ورودِ تماس");
    await settle([b], w.timer, MAX_CALL - 1, 500);
    expect(await bal(b)).toMatchObject({ held: WORST, openReservations: 1 }); // هنوز زنده
    expect(await counts(b)).toEqual({ open: 1, settling: 0, done: 0, dead: 0 });
    await w.timer.advance(1); // سقف می‌رسد
    const result = await call;
    expect(result.ok).toBe(false);
    expect(meta(result)).toMatchObject({ outcome: policy === "forfeit" ? "forfeited" : "released", charged: 0, alarms: ["COST_UNKNOWN"] });
    expect(JSON.stringify(meta(result))).not.toContain("SETTLEMENT_PENDING");
    await settle([b], w.timer, GRACE + 3 * INTERVAL); // از مهلتِ حلقه می‌گذریم؛ رفتگر چیزی برای بستن ندارد
    const closed = await money(b);
    expect(closed).toMatchObject({ held: 0, openReservations: 0, totals: expect.objectContaining({ charged: 0, forfeited: policy === "forfeit" ? WORST : 0 }) });
    expect(await counts(b)).toEqual({ open: 0, settling: 0, done: 1, dead: 0 });
    expect(ok(await b.ports.outbox.get(refOf("scope-1.r1")))).toMatchObject({ state: "done" });
    expect(await terminals(b)).toHaveLength(1);
    g.open(); // تماسِ لغوشده دیر جواب می‌دهد
    await until(() => events.length === 2, "رویدادِ جوابِ دیرهنگام");
    await settle([b], w.timer, 4 * INTERVAL);
    expect(await money(b)).toEqual(closed);
    expect(await terminals(b)).toHaveLength(1);
    expect(events).toEqual([{ kind: "deadline", maxCallMs: MAX_CALL }, { kind: "late-result", ok: true, cost: { currency: "IRR", micros: 100 } }]);
    expect(JSON.stringify([result, gw.receipts(), gw.summary(), events])).not.toMatch(PG_TEXT);
    okHealth(b);
    await w.audit(b);
    await stopAll(b);
  });

  it.each(["forfeit", "release"] as const)("۱۲ گامِ هم‌زمانِ آمیخته با دو حلقهٔ زنده (سیاست %s): نیمی در مهلت، نیمی آویزان؛ هیچ رزروی را حلقه نمی‌بندد و پول دقیق است", async (policy) => {
    const w = await world();
    const g = gate();
    const N = 12;
    const idx = (input: unknown): number => Number(((input as { messages: Array<{ content: string }> }).messages[0] as { content: string }).content.slice(1));
    const { gw, stub } = guardedOn(
      w.app,
      w.timer.clock,
      async (input) => {
        const i = idx(input);
        if (i % 2 === 0) return stepOk(10 + i);
        await g.wait;
        return stepOk(1);
      },
      policy,
      { maxCallMs: MAX_CALL, timers: virtualTimers(w.timer) },
    );
    const b = w.loop({ limit: 4 });
    const c = w.loop({ limit: 4 });
    await startAll(b, c);
    const calls = Array.from({ length: N }, (_, i) => gw.completeStep({ ...STEP, messages: [{ role: "user", content: `s${String(i).padStart(3, "0")}` }] }));
    await until(() => stub.inputs.length === N, "همهٔ تماس‌ها");
    await until(async () => (await counts(b)).done === N / 2, "تسویهٔ گام‌های درمهلت"); // I/Oِ واقعی؛ زمانِ مجازی هنوز نرفته
    await settle([b, c], w.timer, MAX_CALL - 1, 500);
    expect(await bal(b)).toMatchObject({ held: (N / 2) * WORST, openReservations: N / 2 }); // آویزان‌ها هنوز زنده‌اند و حلقه به آن‌ها دست نزده
    await w.timer.advance(1);
    const results = await Promise.all(calls);
    results.forEach((r, i) => expect(meta(r), `i=${i}`).toMatchObject(i % 2 === 0 ? { outcome: "billed", charged: 10 + i } : { outcome: policy === "forfeit" ? "forfeited" : "released", charged: 0 }));
    await settle([b, c], w.timer, GRACE + 4 * INTERVAL);
    const known = [0, 2, 4, 6, 8, 10].reduce((a, i) => a + 10 + i, 0);
    expect(await bal(b)).toMatchObject({ held: 0, openReservations: 0, totals: expect.objectContaining({ charged: known, forfeited: policy === "forfeit" ? (N / 2) * WORST : 0 }) });
    expect(await counts(b)).toEqual({ open: 0, settling: 0, done: N, dead: 0 });
    // دقیقاً یک رکوردِ پایانی برای هر رزرو (گامِ درمهلت: آزادسازیِ باقیمانده؛ گامِ آویزان: سوخت/آزادسازیِ خودِ دروازه)؛ هیچ رزروی دو بار بسته نشده
    const term = await terminals(b);
    expect(term).toHaveLength(N);
    expect(new Set(term.map((e) => (e as unknown as { reservationId: string }).reservationId)).size).toBe(N);
    g.open();
    await settle([b, c], w.timer, 4 * INTERVAL);
    expect(await counts(b)).toEqual({ open: 0, settling: 0, done: N, dead: 0 });
    okHealth(b);
    okHealth(c);
    await w.audit(b);
    await stopAll(b, c);
  });

  /** زمانِ واقعی؛ با تایمرِ **پیش‌فرضِ** ماژول (نه مجازی) و `SMOKE_GRACE_MS` (ADR-0041). */
  it.each(["forfeit", "release"] as const)("دودیِ زمانِ واقعی (سیاست %s): تایمرِ پیش‌فرض تماسِ آویزان را پیش از graceMs می‌بندد و حلقهٔ واقعی پس از مهلت هم چیزی را دوباره نمی‌بندد", async (policy) => {
    const REAL_MAX = 300;
    expect(checkTimingRelations({ maxCallMs: REAL_MAX, graceMs: SMOKE_GRACE_MS, reservationTtlMs: 60_000 })).toEqual([]);
    const t = await openPg(4);
    cleanups.push(t.dispose);
    const mk = (db: Db): PgSettlementRuntime => {
      const r = createPgSettlementRuntime({ db, ledgerSchema: t.ledgerSchema, settlementSchema: t.settlementSchema, graceMs: SMOKE_GRACE_MS, deadLetters: false, timer: createNodeTimer() });
      if (!r.ok) throw new Error(r.error.issues.join(";"));
      return r.value;
    };
    const app = mk(t.db);
    const m = await app.migrate();
    if (!m.ok) throw new Error(`migrate: ${m.stage}/${m.code}`);
    ok(await app.ports.ledger.openAccount({ ...KEY, unit: UNIT }));
    ok(await app.ports.ledger.grant({ ...KEY, grantId: "g0", unit: UNIT, amount: FUNDS, source: "purchase" }));
    const { gw, stub } = guardedOn(app, createSystemClock(), () => hang(), policy, { maxCallMs: REAL_MAX }, SMOKE_GRACE_MS);
    const p = t.another();
    cleanups.push(p.close);
    const loop = mk(p.db as Db);
    expect((await loop.start()).started).toBe(true);
    cleanups.push(async () => void (await loop.stop()));
    const r = await gw.completeStep(STEP);
    expect(stub.inputs).toHaveLength(1);
    expect(meta(r)).toMatchObject({ outcome: policy === "forfeit" ? "forfeited" : "released", charged: 0 });
    expect(await counts(loop)).toEqual({ open: 0, settling: 0, done: 1, dead: 0 });
    const closed = await money(loop);
    await sleep(SMOKE_GRACE_MS + 800); // حلقهٔ واقعی از مهلتِ رکورد می‌گذرد (رفتارِ منفی: فقط انتظارِ واقعی می‌تواند «هیچ‌چیز» را نشان دهد)
    expect(await money(loop)).toEqual(closed);
    expect(await terminals(loop)).toHaveLength(1);
    okHealth(loop);
    expect(await loop.stop()).toEqual({ clean: true });
  });
});
