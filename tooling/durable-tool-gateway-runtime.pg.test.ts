/**
 * آزمونِ سرتاسریِ **حلقه‌دار** (ADR-0065): دروازهٔ ابزارِ ماندگار (`durable-tool-gateway`) + ریشهٔ ترکیبِ رفتگر (`settlement-runtime`، حلقهٔ واقعیِ
 * `start/stop`) روی **PostgreSQL واقعی**. ADR-0064 فقط `sweep()` را مستقیم صدا می‌زد؛ این‌جا «رفتگرِ خودکار» است که رزروِ یتیم را می‌بندد.
 * «فرایند» = استخرِ جدا + `createPgSettlementRuntime` (`ports.ledger`/`ports.outbox` همان چیزی‌اند که برنامه به دروازه می‌دهد)؛
 * فرایندِ برنامه (دروازه) روی استخرِ اصلیِ `openPg` است و «مرگ» = `killPrimary()`؛ حلقه‌ها روی استخرهای `another()` اجرا می‌شوند.
 * زمانِ مجازی (`manualTimer`، مشترک بینِ ساعت و حلقه) + I/O واقعی؛ جز دو دودیِ زمانِ واقعی (ساعتِ سیستم + `setTimeout`، با `SMOKE_GRACE_MS`؛ ADR-0041).
 * هیچ کدِ تولیدی تغییر نکرده؛ قیمت‌ها و هزینه‌ها ساختگیِ test-kit ماژول‌اند. بدونِ پایگاه رد می‌شود (دروازهٔ صفر-ردِ CI قرمز می‌کند).
 */
import { afterEach, expect, it } from "vitest";
import { createDurableToolGateway } from "@/modules/durable-tool-gateway";
import { GRACE, KEY, STEP, UNIT, WORST, configFor, ok, prng, refOf, stepErr, stepOk, stubGateway } from "@/modules/durable-tool-gateway/test-kit";
import type { StepReply } from "@/modules/durable-tool-gateway/test-kit";
import { createPgAccountStore } from "@/modules/ledger";
import type { Clock } from "@/modules/ledger";
import { createNodeTimer, createPgSettlementRuntime, createSystemClock } from "@/modules/settlement-runtime";
import type { PgSettlementRuntime, PgSettlementRuntimeConfig } from "@/modules/settlement-runtime";
import { dbDescribe, openPg } from "@/modules/settlement-runtime/test-db";
import { SMOKE_GRACE_MS, healthDiagnostics, manualTimer } from "@/modules/settlement-runtime/test-kit";
import type { ManualTimer } from "@/modules/settlement-runtime/test-kit";

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

  /** فرایندِ برنامه با گامِ دوم آویزان؛ سپس مرگِ فرایند. */
  async function hungThenDead(w: World, policy: "forfeit" | "release") {
    const { gw, stub } = gatewayOn(w.app, w.timer.clock, (_i, n) => (n === 0 ? stepOk(100) : hang()), { onUnknownCost: policy });
    expect((await gw.completeStep(STEP)).ok).toBe(true);
    void gw.completeStep(STEP);
    await until(() => stub.inputs.length === 2, "تماسِ دوم");
    expect(await counts(w.app)).toEqual({ open: 1, settling: 0, done: 1, dead: 0 });
    await w.t.killPrimary(); // مرگِ فرایندِ برنامه؛ هیچ sweep اجرا نشده
  }

  it.each(["forfeit", "release"] as const)("فرایندِ برنامه وسطِ تماس می‌میرد (سیاست %s): حلقهٔ خودکارِ فرایندِ دیگر پیش از مهلت دست نمی‌زند و پس از آن رزروِ یتیم را طبق سیاست می‌بندد؛ سلامت ok", async (policy) => {
    const w = await world();
    await hungThenDead(w, policy);
    const b = w.loop();
    await startAll(b);
    await settle([b], w.timer, GRACE - 1);
    expect(await bal(b)).toMatchObject({ held: WORST }); // هنوز در مهلتِ تماس
    expect(await counts(b)).toEqual({ open: 1, settling: 0, done: 1, dead: 0 });
    await settle([b], w.timer, 1 + 2 * INTERVAL);
    const totals = policy === "forfeit" ? { charged: 100, forfeited: WORST } : { charged: 100, forfeited: 0 };
    expect(await bal(b)).toMatchObject({ held: 0, openReservations: 0, totals: expect.objectContaining(totals) });
    expect(await counts(b)).toEqual({ open: 0, settling: 0, done: 2, dead: 0 });
    expect(ok(await b.ports.outbox.get(refOf("scope-1.r2")))).toMatchObject({ state: "done" });
    okHealth(b);
    const snapshot = await money(b);
    await settle([b], w.timer, 4 * INTERVAL); // گذرهای بعدی بی‌اثرند (idempotent)
    expect(await money(b)).toEqual(snapshot);
    await w.audit(b);
    await stopAll(b);
  });

  it("گامِ زنده در مهلت: حلقهٔ در حالِ اجرا (دو فرایند) رزروِ ۱۲ گامِ هم‌زمان را نمی‌بندد؛ پس از پایانِ گام‌ها هزینهٔ دقیق ثبت و بی‌سوخت می‌ماند", async () => {
    const w = await world();
    const g = gate();
    const { gw, stub } = gatewayOn(w.app, w.timer.clock, async () => {
      await g.wait;
      return stepOk(50);
    });
    const b = w.loop({ limit: 4 });
    const c = w.loop({ limit: 4 });
    await startAll(b, c);
    const calls = Array.from({ length: 12 }, () => gw.completeStep(STEP));
    await until(() => stub.inputs.length === 12, "۱۲ تماس");
    await settle([b, c], w.timer, GRACE - 1);
    expect(await bal(b)).toMatchObject({ held: 12 * WORST, totals: expect.objectContaining({ forfeited: 0, charged: 0 }) });
    expect(await counts(b)).toEqual({ open: 12, settling: 0, done: 0, dead: 0 });
    g.open();
    const rs = await Promise.all(calls);
    expect(rs.every((r) => r.ok)).toBe(true);
    await settle([b, c], w.timer, 6 * INTERVAL);
    expect(await bal(b)).toMatchObject({ available: FUNDS - 600, held: 0, openReservations: 0, totals: expect.objectContaining({ charged: 600, forfeited: 0 }) });
    expect(await counts(b)).toEqual({ open: 0, settling: 0, done: 12, dead: 0 });
    okHealth(b);
    okHealth(c);
    await w.audit(b);
    await stopAll(b, c);
  });

  /** گامِ زامبی: تماس از مهلتِ حلقه می‌گذرد (حلقه رزرو را می‌بندد) و سپس زنده برمی‌گردد. */
  async function zombie(policy: "forfeit" | "release") {
    const w = await world();
    const g = gate();
    const { gw, stub } = gatewayOn(
      w.app,
      w.timer.clock,
      async () => {
        await g.wait;
        return stepOk(100);
      },
      { onUnknownCost: policy },
    );
    const b = w.loop();
    await startAll(b);
    const call = gw.completeStep(STEP);
    await until(() => stub.inputs.length === 1, "ورودِ تماس");
    await settle([b], w.timer, GRACE + 3 * INTERVAL);
    const before = await money(b);
    g.open();
    const result = await call;
    await settle([b], w.timer, 4 * INTERVAL);
    return { w, b, gw, result, before };
  }

  it.each(["forfeit", "release"] as const)("گامِ زامبی (سیاست %s): پاسخِ دیرهنگام پولِ دفتر را عوض نمی‌کند، رکوردِ done را زنده نمی‌کند و دقیقاً یک رکوردِ پایانی در ژورنال می‌ماند", async (policy) => {
    const { w, b, gw, result, before } = await zombie(policy);
    expect(before).toMatchObject({ held: 0, openReservations: 0, totals: expect.objectContaining(policy === "forfeit" ? { forfeited: WORST, charged: 0 } : { forfeited: 0, charged: 0 }) });
    expect(await money(b)).toEqual(before); // پاسخِ دیرهنگام و گذرهای بعدی: بی‌اثر
    expect(await counts(b)).toEqual({ open: 0, settling: 0, done: 1, dead: 0 });
    expect(ok(await b.ports.outbox.get(refOf("scope-1.r1")))).toMatchObject({ state: "done" });
    const j = ok(await b.ports.ledger.journal(KEY));
    expect(j.filter((e) => e.type === "forfeit" || e.type === "release" || e.type === "expire")).toHaveLength(1);
    expect(j.filter((e) => e.type === "charge")).toHaveLength(0);
    const m = await money(b);
    expect(m.totals.charged + m.totals.forfeited).toBeLessThanOrEqual(WORST); // کاربر هرگز بیش از رزرو نمی‌پردازد
    expect(m.available + m.held + m.totals.charged + m.totals.forfeited).toBe(FUNDS); // بقا
    expect(result.ok).toBe(true); // پاسخ به تماس‌گیرنده می‌رسد
    expect(JSON.stringify([result, gw.receipts(), gw.summary()])).not.toMatch(PG_TEXT);
    await w.audit(b);
    await stopAll(b);
  });

  /**
   * توصیفِ وضعِ موجود (یافتهٔ ADR-0065؛ باز «الف»): گامِ زامبی «settlement-failed» با هشدارِ SETTLEMENT_PENDING گزارش می‌شود، در حالی که
   * رفتگر پیش‌تر رزرو را بسته و رکورد done است ⇒ وعدهٔ «رفتگر تسویه می‌کند» هرگز وفا نمی‌شود و هزینهٔ معلومِ ۱۰۰ ثبت نمی‌شود
   * (forfeit: کاربر ۴۹۳ می‌پردازد؛ release: پاسخ را مجانی می‌گیرد). با اصلاحِ آینده فقط همین آزمون تغییر می‌کند.
   */
  it.each(["forfeit", "release"] as const)("توصیفِ وضعِ موجود — گامِ زامبی (سیاست %s): نتیجه settlement-failed با SETTLEMENT_PENDING؛ هزینهٔ معلوم ثبت نمی‌شود (باز ۰۰۶۵-الف)", async (policy) => {
    const { w, b, result } = await zombie(policy);
    expect(meta(result)).toMatchObject({ outcome: "settlement-failed", charged: 0, alarms: ["SETTLEMENT_PENDING"] });
    expect(ok(await b.ports.outbox.get(refOf("scope-1.r1")))).toMatchObject({ state: "done" });
    expect((await money(b)).totals.charged).toBe(0);
    await w.audit(b);
    await stopAll(b);
  });

  it("خرابیِ واقعیِ outbox وسطِ اجرای حلقه: حلقه نمی‌میرد، پول دست‌نخورده، سلامت از ok خارج و بی‌نشتِ متنِ PG؛ پس از بازگشتِ جدول خودکار بهبود و رزرو بسته می‌شود", async () => {
    const w = await world();
    await hungThenDead(w, "forfeit");
    const b = w.loop();
    await startAll(b);
    await settle([b], w.timer, 2 * INTERVAL);
    okHealth(b);
    await w.t.raw("ALTER TABLE {{s}}.settlement_outbox RENAME TO settlement_outbox_gone");
    await settle([b], w.timer, GRACE + 3 * INTERVAL); // رکورد سررسید است ولی outbox زیرِ پای حلقه نیست
    expect(await bal(b)).toMatchObject({ held: WORST, openReservations: 1 }); // پول دست‌نخورده
    expect(b.status().loop.state).toBe("running");
    expect(b.health().health.status).not.toBe("ok");
    expect(JSON.stringify([b.health(), b.status()])).not.toMatch(PG_TEXT);
    await w.t.raw("ALTER TABLE {{s}}.settlement_outbox_gone RENAME TO settlement_outbox");
    await settle([b], w.timer, 4 * INTERVAL);
    expect(await bal(b)).toMatchObject({ held: 0, openReservations: 0, totals: expect.objectContaining({ charged: 100, forfeited: WORST }) });
    expect(await counts(b)).toEqual({ open: 0, settling: 0, done: 2, dead: 0 });
    okHealth(b);
    await w.audit(b);
    await stopAll(b);
  });

  it("توقف و شروعِ دوباره: بی‌حلقه رزروِ یتیم می‌ماند (هیچ‌چیز پنهانی نمی‌بندد)؛ حلقهٔ تازه روی استخرِ تازه می‌بندد", async () => {
    const w = await world();
    await hungThenDead(w, "release");
    const b = w.loop();
    await startAll(b);
    await settle([b], w.timer, 2 * INTERVAL);
    await stopAll(b);
    expect(w.timer.pending()).toBe(0); // حلقهٔ متوقف زمان‌سنجِ آویزان ندارد
    await w.timer.advance(3 * GRACE); // مهلت می‌گذرد، ولی هیچ حلقه‌ای نیست
    expect(await bal(b)).toMatchObject({ held: WORST, openReservations: 1 });
    expect(await counts(b)).toEqual({ open: 1, settling: 0, done: 1, dead: 0 });
    const c = w.loop();
    await startAll(c);
    await settle([c], w.timer, 2 * INTERVAL);
    expect(await bal(c)).toMatchObject({ held: 0, openReservations: 0, available: FUNDS - 100, totals: expect.objectContaining({ charged: 100, forfeited: 0 }) });
    expect(await counts(c)).toEqual({ open: 0, settling: 0, done: 2, dead: 0 });
    okHealth(c);
    await w.audit(c);
    await stopAll(c);
  });

  it.each([11, 28, 47, 84])("ویژگی (بذر %i): ۱۶ گامِ هم‌زمانِ آمیخته + مرگِ فرایندِ برنامه + دو حلقهٔ خودکار ⇒ حفظِ پول و هزینهٔ دقیقِ داورِ مستقل", async (seed) => {
    const rnd = prng(seed);
    const N = 16;
    const policy = seed % 2 === 1 ? "forfeit" : "release";
    type Kind = { kind: "ok" | "errCost" | "unknown" | "hang"; micros: number };
    const plan: Kind[] = Array.from({ length: N }, () => {
      const r = rnd();
      return { kind: r < 0.35 ? "ok" : r < 0.55 ? "errCost" : r < 0.75 ? "unknown" : "hang", micros: 1 + Math.floor(rnd() * 400) };
    });
    expect(new Set(plan.map((s) => s.kind))).toEqual(new Set(["ok", "errCost", "unknown", "hang"])); // ادعای پوشش
    const reply = async (input: unknown): Promise<unknown> => {
      const content = (input as { messages: { content: string }[] }).messages[0]!.content;
      const spec = plan[Number(content.slice(1))] as Kind;
      await sleep(Math.floor(rnd() * 4));
      if (spec.kind === "hang") return hang();
      if (spec.kind === "unknown") return stepOk(null);
      if (spec.kind === "errCost") return stepErr("PROVIDER_ERROR", { cost: { micros: spec.micros, currency: "IRR", priceVersion: "test-v1" } });
      return stepOk(spec.micros);
    };
    const w = await world();
    const { gw, stub } = gatewayOn(w.app, w.timer.clock, reply, { onUnknownCost: policy });
    const live: Promise<unknown>[] = [];
    plan.forEach((spec, i) => {
      const call = gw.completeStep({ ...STEP, messages: [{ role: "user", content: `s${String(i).padStart(3, "0")}` }] });
      if (spec.kind !== "hang") live.push(call);
    });
    await Promise.all(live);
    await until(() => stub.inputs.length === N, "همهٔ تماس‌ها");
    await w.t.killPrimary();
    const b = w.loop({ limit: 3 });
    const c = w.loop({ limit: 3 });
    await startAll(b, c);
    await settle([b, c], w.timer, GRACE + 6 * INTERVAL);
    const known = plan.filter((s) => s.kind === "ok" || s.kind === "errCost").reduce((a, s) => a + s.micros, 0);
    const burned = plan.filter((s) => s.kind === "unknown" || s.kind === "hang").length;
    const forfeited = policy === "forfeit" ? burned * WORST : 0;
    expect(await bal(b)).toMatchObject({ held: 0, openReservations: 0, available: FUNDS - known - forfeited, totals: expect.objectContaining({ charged: known, forfeited }) });
    expect(await counts(b)).toEqual({ open: 0, settling: 0, done: N, dead: 0 });
    okHealth(b);
    okHealth(c);
    await w.audit(b);
    await stopAll(b, c);
  });

  /** زمانِ واقعی (ساعتِ سیستم + setTimeout)؛ فقط دود، با `SMOKE_GRACE_MS` (ADR-0041). */
  it.each(["forfeit", "release"] as const)("دودیِ زمانِ واقعی (سیاست %s): حلقهٔ واقعی رزروِ گامِ آویزانِ فرایندِ مرده را خودکار می‌بندد و سلامت ok می‌ماند", async (policy) => {
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
    const { gw, stub } = gatewayOn(app, createSystemClock(), (_i, n) => (n === 0 ? stepOk(100) : hang()), { onUnknownCost: policy, graceMs: SMOKE_GRACE_MS });
    expect((await gw.completeStep(STEP)).ok).toBe(true);
    void gw.completeStep(STEP);
    await until(() => stub.inputs.length === 2, "تماسِ دوم");
    expect(await counts(app)).toEqual({ open: 1, settling: 0, done: 1, dead: 0 });
    await t.killPrimary(); // مرگِ فرایندِ برنامه
    const p = t.another();
    cleanups.push(p.close);
    const loop = mk(p.db as Db);
    expect((await loop.start()).started).toBe(true);
    cleanups.push(async () => void (await loop.stop()));
    await until(async () => (await bal(loop)).held === 0, "بسته‌شدنِ رزرو با زمانِ واقعی", 4000);
    expect(await bal(loop)).toMatchObject({ held: 0, openReservations: 0, totals: expect.objectContaining(policy === "forfeit" ? { charged: 100, forfeited: WORST } : { charged: 100, forfeited: 0 }) });
    expect(await counts(loop)).toEqual({ open: 0, settling: 0, done: 2, dead: 0 });
    okHealth(loop);
    expect(await loop.stop()).toEqual({ clean: true });
  });
});
