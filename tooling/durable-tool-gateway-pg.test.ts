/**
 * ترکیبِ `durable-tool-gateway` روی **PostgreSQL واقعی** (ADR-0064؛ بستنِ بازِ «ب» از ADR-0063): دفترِ اعتبارِ PG + outbox PG در یک شِما،
 * «فرایند» = استخرِ اتصالِ جدا + دفتر + outbox + رفتگرِ همان شِما، و «مرگ» = بستنِ استخر (گامِ آویزان هرگز برنمی‌گردد).
 * پیش‌تر این ترکیب فقط روی ذخیرهٔ حافظه‌ای آزموده بود (outbox و دفترِ PG جدا آزموده‌اند)؛ این‌جا چیزهایی سنجیده می‌شوند که حافظه نشان نمی‌دهد:
 * ماندگاریِ واقعی بین فرایندها، رقابتِ واقعیِ قفلِ ردیف زیرِ گام‌های هم‌زمان، دو رفتگرِ زندهٔ هم‌زمان، و **خرابیِ واقعیِ پایگاه** (جدولِ outbox
 * زیرِ پای دروازه ناپدید می‌شود) بی‌نشتِ متنِ خطای PostgreSQL.
 * هیچ کدِ تولیدی تغییر نکرده؛ قیمت‌ها و هزینه‌ها ساختگیِ آزمون‌اند (test-kit ماژول). زمان مجازی است ولی I/O واقعی.
 * بدونِ `KB_TEST_DATABASE_URL`/`DATABASE_URL` رد می‌شود (دروازهٔ صفر-ردِ CI آن را قرمز می‌کند).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, expect, it } from "vitest";
import { createDurableToolGateway } from "@/modules/durable-tool-gateway";
import { GRACE, KEY, STEP, UNIT, WORST, audit, balance, configFor, flakyLedger, mutableClock, ok, prng, refOf, stepErr, stepOk, stubGateway } from "@/modules/durable-tool-gateway/test-kit";
import type { MutableClock, StepReply } from "@/modules/durable-tool-gateway/test-kit";
import { createLedger, createPgAccountStore } from "@/modules/ledger";
import type { Ledger, PgAccountStore } from "@/modules/ledger";
import { createPgSettlementOutbox, createSettlementSweeper } from "@/modules/settlement";
import type { PgSettlementOutbox, Sweeper } from "@/modules/settlement";
import { TEST_DB_URL, dbDescribe, openPgOutbox } from "@/modules/settlement/pg/test-db";
import type { TestOutbox } from "@/modules/settlement/pg/test-db";

const FUNDS = 1_000_000;
const hang = (): Promise<never> => new Promise(() => undefined);
const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
const meta = (r: { ok: boolean; value?: { metering: unknown }; error?: { metering: unknown } }): Record<string, unknown> => (r.ok ? r.value!.metering : r.error!.metering) as Record<string, unknown>;
const PG_TEXT = /settlement_outbox|relation|does not exist|42P01|LEAK-CANARY/i;

async function until(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 3000; i++) {
    if (await cond()) return;
    await sleep(2);
  }
  throw new Error(`انتظار برای «${what}» به پایان رسید`);
}

dbDescribe("durable-tool-gateway · ترکیب روی PostgreSQL واقعی", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  type Proc = Readonly<{ ledger: Ledger; store: PgAccountStore; outbox: PgSettlementOutbox; sweeper: Sweeper; kill(): Promise<void> }>;

  /** یک «فرایند»: استخرِ جدا + دفترِ خام + outbox + رفتگر روی همان شِما. */
  function spawn(t: TestOutbox, clock: MutableClock, poolSize = 4): Proc {
    const pool = new Pool({ connectionString: TEST_DB_URL, max: poolSize, idleTimeoutMillis: 50 });
    const db = drizzle(pool);
    const store = createPgAccountStore(db, { schema: t.schema });
    const outbox = createPgSettlementOutbox(db, { schema: t.schema });
    if (!store.ok || !outbox.ok) throw new Error("spawn failed");
    const ledger = createLedger({ store: store.value, clock });
    if (!ledger.ok) throw new Error("ledger failed");
    const sweeper = createSettlementSweeper({ ledger: ledger.value, outbox: outbox.value, clock });
    if (!sweeper.ok) throw new Error(sweeper.error.issues.join(";"));
    let ended = false;
    const kill = async (): Promise<void> => {
      if (ended) return;
      ended = true;
      await pool.end();
    };
    cleanups.push(kill);
    return { ledger: ledger.value, store: store.value, outbox: outbox.value, sweeper: sweeper.value, kill };
  }

  async function world(funds = FUNDS) {
    const t = await openPgOutbox(4);
    cleanups.push(t.dispose);
    const clock = mutableClock();
    const boot = createPgAccountStore(t.db, { schema: t.schema });
    if (!boot.ok) throw new Error("boot");
    const m = await boot.value.migrate();
    if (!m.ok) throw new Error(`ledger migrate: ${m.error.code}`);
    const a = spawn(t, clock);
    ok(await a.ledger.openAccount({ ...KEY, unit: UNIT }));
    ok(await a.ledger.grant({ ...KEY, grantId: "g0", unit: UNIT, amount: funds, source: "purchase" }));
    return { t, clock, a, spawn: (n = 4) => spawn(t, clock, n) };
  }

  function gatewayOf(p: Proc, clock: MutableClock, reply: StepReply | ((input: unknown, index: number) => unknown), over: Record<string, unknown> = {}, ledger: Ledger = p.ledger) {
    const stub = stubGateway(reply);
    const made = createDurableToolGateway(configFor(ledger, stub.gateway, p.outbox, clock, over));
    if (!made.ok) throw new Error(made.error.issues.join(";"));
    return { gw: made.value, stub };
  }

  const counts = async (p: Proc) => ok(await p.outbox.counts());
  /** PG ممیزی: ناوردا + بازپخشِ ژورنال = حالت (در یک اسنپ‌شات). */
  const pgAudit = async (p: Proc) => {
    const r = ok(await p.store.audit(KEY));
    expect(r).toMatchObject({ exists: true, ok: true, problems: [] });
    return r;
  };
  /** تا آرامش (بی‌رکوردِ باز/در حالِ تسویه) رفتگرها را می‌چرخاند. */
  async function drain(procs: readonly Proc[], clock: MutableClock): Promise<void> {
    clock.advance(GRACE);
    for (let i = 0; i < 12; i++) {
      await Promise.all(procs.map((p) => p.sweeper.sweep()));
      const c = await counts(procs[0] as Proc);
      if (c.open === 0 && c.settling === 0) return;
      clock.advance(60_000);
    }
    throw new Error("drain: outbox آرام نشد");
  }

  it("گام‌های پیاپیِ موفق: مصرف، رزرو آزاد، رکوردهای done؛ پس از مرگِ فرایند فرایندِ تازه همان حالت را از PostgreSQL می‌بیند", async () => {
    const w = await world();
    const costs = [100, 70, 30];
    const { gw } = gatewayOf(w.a, w.clock, (_i, n) => stepOk(costs[n] as number));
    for (let i = 0; i < 3; i++) expect((await gw.completeStep(STEP)).ok).toBe(true);
    expect(gw.receipts().map((r) => r.reservationId)).toEqual(["scope-1.r1", "scope-1.r2", "scope-1.r3"]);
    expect(await audit(w.a.ledger)).toMatchObject({ available: FUNDS - 200, held: 0, charged: 200, forfeited: 0, openReservations: 0 });
    expect(await counts(w.a)).toEqual({ open: 0, settling: 0, done: 3, dead: 0 });
    await w.a.kill(); // مرگِ فرایند
    const b = w.spawn();
    expect(await audit(b.ledger)).toMatchObject({ available: FUNDS - 200, held: 0, charged: 200, forfeited: 0 });
    expect(await counts(b)).toEqual({ open: 0, settling: 0, done: 3, dead: 0 });
    for (const n of [1, 2, 3]) expect(ok(await b.outbox.get(refOf(`scope-1.r${n}`)))).toMatchObject({ state: "done" });
    expect(await b.sweeper.sweep()).toMatchObject({ examined: 0 });
    await pgAudit(b);
  });

  it("۱۲ گامِ هم‌زمان روی استخرِ ۴ اتصالی (رقابتِ واقعیِ قفلِ ردیفِ یک حساب): رزرو و رکوردِ یکتا، هزینهٔ دقیق، بی‌گمشدنِ پول", async () => {
    const w = await world();
    const { gw } = gatewayOf(w.a, w.clock, async () => {
      await sleep(5);
      return stepOk(50);
    });
    const rs = await Promise.all(Array.from({ length: 12 }, () => gw.completeStep(STEP)));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(new Set(gw.receipts().map((r) => r.reservationId)).size).toBe(12);
    expect(await audit(w.a.ledger)).toMatchObject({ available: FUNDS - 600, held: 0, charged: 600, forfeited: 0, openReservations: 0 });
    expect(await counts(w.a)).toEqual({ open: 0, settling: 0, done: 12, dead: 0 });
    expect(await w.a.sweeper.sweep()).toMatchObject({ examined: 0 });
    await pgAudit(w.a);
  });

  it("پیش از تماس، رکوردِ outbox روی PostgreSQL باز و رزرو نگه‌داشته شده است (ترتیبِ begin ⇒ تماس ⇒ done)", async () => {
    const w = await world();
    const seen: { open: number; held: number }[] = [];
    const { gw } = gatewayOf(w.a, w.clock, async () => {
      seen.push({ open: (await counts(w.a)).open, held: (await balance(w.a.ledger)).held });
      return stepOk(10);
    });
    expect((await gw.completeStep(STEP)).ok).toBe(true);
    expect(seen).toEqual([{ open: 1, held: WORST }]);
    expect(await counts(w.a)).toEqual({ open: 0, settling: 0, done: 1, dead: 0 });
  });

  it.each(["forfeit", "release"] as const)("فرایند وسط تماسِ گام می‌میرد (سیاست %s): رفتگرِ فرایندِ تازه روی PostgreSQL رزروِ یتیم را طبق سیاست می‌بندد؛ گامِ پیشین دست‌نخورده", async (policy) => {
    const w = await world();
    const { gw, stub } = gatewayOf(w.a, w.clock, (_i, n) => (n === 0 ? stepOk(100) : hang()), { onUnknownCost: policy });
    expect((await gw.completeStep(STEP)).ok).toBe(true);
    void gw.completeStep(STEP); // رها شد: فرایند مرد
    await until(() => stub.inputs.length === 2, "تماسِ دوم");
    expect(await counts(w.a)).toEqual({ open: 1, settling: 0, done: 1, dead: 0 });
    expect((await balance(w.a.ledger)).held).toBe(WORST);
    await w.a.kill();
    const b = w.spawn();
    expect((await balance(b.ledger)).held).toBe(WORST); // رزرو از مرگ جان به‌در برد
    expect(await b.sweeper.sweep()).toMatchObject({ examined: 0 }); // هنوز در مهلتِ تماس
    w.clock.advance(GRACE);
    expect(await b.sweeper.sweep()).toMatchObject({ examined: 1, settled: 1, buried: [] });
    const a = await audit(b.ledger);
    if (policy === "forfeit") expect(a).toMatchObject({ held: 0, charged: 100, forfeited: WORST, available: FUNDS - 100 - WORST, openReservations: 0 });
    else expect(a).toMatchObject({ held: 0, charged: 100, forfeited: 0, available: FUNDS - 100, openReservations: 0 });
    expect(await counts(b)).toEqual({ open: 0, settling: 0, done: 2, dead: 0 });
    expect(await b.sweeper.sweep()).toMatchObject({ examined: 0 }); // idempotent
    expect(await audit(b.ledger)).toEqual(a);
    await pgAudit(b);
  });

  it("شکستِ charge در دفترِ PostgreSQL (۳ بار): SETTLEMENT_PENDING؛ رفتگرِ فرایندِ دیگر هزینه را دقیقاً یک بار ثبت می‌کند", async () => {
    const w = await world();
    const { gw } = gatewayOf(w.a, w.clock, stepOk(100), {}, flakyLedger(w.a.ledger, { charge: { fail: 3 } }));
    const r = await gw.completeStep(STEP);
    expect(meta(r)).toMatchObject({ outcome: "settlement-failed", alarms: ["SETTLEMENT_PENDING"] });
    expect(JSON.stringify([r, gw.receipts(), gw.summary()])).not.toMatch(PG_TEXT);
    expect(await balance(w.a.ledger)).toMatchObject({ held: WORST, totals: { charged: 0 } });
    const b = w.spawn();
    w.clock.advance(GRACE);
    expect(await b.sweeper.sweep()).toMatchObject({ examined: 1, settled: 1, buried: [] });
    expect(await audit(b.ledger)).toMatchObject({ available: FUNDS - 100, held: 0, charged: 100, forfeited: 0 });
    expect(await b.sweeper.sweep()).toMatchObject({ examined: 0 });
    expect(await audit(b.ledger)).toMatchObject({ charged: 100 });
    await pgAudit(b);
  });

  it("هزینه ثبت و close شکست (CLOSE_PENDING): رفتگر باقیمانده را آزاد می‌کند و هزینه دوباره گرفته نمی‌شود", async () => {
    const w = await world();
    const { gw } = gatewayOf(w.a, w.clock, stepOk(100), {}, flakyLedger(w.a.ledger, { close: { fail: 3 } }));
    expect(meta(await gw.completeStep(STEP))).toMatchObject({ outcome: "billed", charged: 100, alarms: ["CLOSE_PENDING"] });
    expect((await balance(w.a.ledger)).held).toBe(WORST - 100);
    const b = w.spawn();
    w.clock.advance(GRACE);
    expect(await b.sweeper.sweep()).toMatchObject({ settled: 1 });
    expect(await audit(b.ledger)).toMatchObject({ available: FUNDS - 100, held: 0, charged: 100, forfeited: 0 });
    await pgAudit(b);
  });

  it("گامِ شکست‌خورده با error.cost معتبر: فقط همان هزینه مصرف می‌شود، نه سوختنِ کلِ رزرو (روی PostgreSQL)", async () => {
    const w = await world();
    const { gw } = gatewayOf(w.a, w.clock, stepErr("PROVIDER_ERROR", { cost: { micros: 70, currency: "IRR", priceVersion: "test-v1" } }));
    const r = await gw.completeStep(STEP);
    expect(r.ok).toBe(false);
    expect(meta(r)).toMatchObject({ outcome: "billed", charged: 70 });
    expect(await audit(w.a.ledger)).toMatchObject({ charged: 70, forfeited: 0, held: 0, available: FUNDS - 70 });
    expect(await counts(w.a)).toEqual({ open: 0, settling: 0, done: 1, dead: 0 });
  });

  it.each(["forfeit", "release"] as const)("هزینهٔ نامعلوم (سیاست %s): رکورد done با origin=caller، زنگِ COST_UNKNOWN، و رفتگر بی‌کار می‌ماند", async (policy) => {
    const w = await world();
    const { gw } = gatewayOf(w.a, w.clock, stepOk(null), { onUnknownCost: policy });
    const r = await gw.completeStep(STEP);
    expect(meta(r)).toMatchObject({ outcome: policy === "forfeit" ? "forfeited" : "released", alarms: ["COST_UNKNOWN"] });
    expect(ok(await w.a.outbox.get(refOf("scope-1.r1")))).toMatchObject({ state: "done", close: { remainder: policy, origin: "caller" } });
    expect(await w.a.sweeper.sweep()).toMatchObject({ examined: 0 });
    const a = await audit(w.a.ledger);
    if (policy === "forfeit") expect(a).toMatchObject({ forfeited: WORST, held: 0, available: FUNDS - WORST });
    else expect(a).toMatchObject({ forfeited: 0, held: 0, available: FUNDS });
    await pgAudit(w.a);
  });

  it("اعتبار ناکافی روی PostgreSQL ⇒ ردّ؛ نه رزرو، نه رکورد، نه تماس", async () => {
    const w = await world(100);
    const { gw, stub } = gatewayOf(w.a, w.clock, stepOk(10));
    const r = await gw.completeStep(STEP);
    expect(r.ok).toBe(false);
    expect(stub.inputs).toHaveLength(0);
    expect(await counts(w.a)).toEqual({ open: 0, settling: 0, done: 0, dead: 0 });
    expect(await audit(w.a.ledger)).toMatchObject({ available: 100, held: 0, charged: 0, forfeited: 0 });
  });

  it("دروازهٔ دومی با همان scopeId روی همان outbox: ردّ؛ رکوردِ پیشین دست‌نخورده و پولِ دومی برنمی‌دارد", async () => {
    const w = await world();
    const first = gatewayOf(w.a, w.clock, stepOk(100));
    expect((await first.gw.completeStep(STEP)).ok).toBe(true);
    const again = gatewayOf(w.a, w.clock, stepOk(100)); // همان scope-1
    const r = await again.gw.completeStep(STEP);
    expect(r.ok).toBe(false);
    expect(again.stub.inputs).toHaveLength(0);
    expect(await audit(w.a.ledger)).toMatchObject({ charged: 100, held: 0, forfeited: 0, available: FUNDS - 100 });
    expect(await counts(w.a)).toEqual({ open: 0, settling: 0, done: 1, dead: 0 });
    expect(ok(await w.a.outbox.get(refOf("scope-1.r1")))).toMatchObject({ state: "done" });
  });

  it("جدولِ outbox پیش از گام ناپدید می‌شود (خرابیِ واقعیِ PG): تماسی نمی‌رود، رزرو برمی‌گردد، متنِ خطای PG نشت نمی‌کند؛ پس از بازگشت گامِ بعدی کار می‌کند", async () => {
    const w = await world();
    const { gw, stub } = gatewayOf(w.a, w.clock, stepOk(100));
    await w.t.raw("ALTER TABLE {{s}}.settlement_outbox RENAME TO settlement_outbox_gone");
    const r = await gw.completeStep(STEP);
    expect(r.ok).toBe(false);
    expect(meta(r)).toMatchObject({ outcome: "refused", refusal: { code: "RESERVE_FAILED" } });
    expect(JSON.stringify([r, gw.receipts(), gw.summary()])).not.toMatch(PG_TEXT);
    expect(stub.inputs).toHaveLength(0);
    expect(await audit(w.a.ledger)).toMatchObject({ available: FUNDS, held: 0, charged: 0, forfeited: 0, openReservations: 0 });
    await w.t.raw("ALTER TABLE {{s}}.settlement_outbox_gone RENAME TO settlement_outbox");
    expect((await gw.completeStep(STEP)).ok).toBe(true);
    expect(await audit(w.a.ledger)).toMatchObject({ available: FUNDS - 100, charged: 100, held: 0 });
    expect(await counts(w.a)).toEqual({ open: 0, settling: 0, done: 1, dead: 0 });
    await pgAudit(w.a);
  });

  it("جدولِ outbox وسطِ تماس ناپدید می‌شود (ثبتِ مصرف شکست می‌خورد): دفتر دست‌نخورده می‌ماند؛ پس از بازگشتِ جدول رفتگر کفِ امن (forfeit) را می‌گیرد", async () => {
    const w = await world();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((res) => void (release = res));
    const { gw, stub } = gatewayOf(w.a, w.clock, async () => {
      await gate;
      return stepOk(100);
    });
    const p = gw.completeStep(STEP);
    await until(() => stub.inputs.length === 1, "ورودِ تماس");
    await w.t.raw("ALTER TABLE {{s}}.settlement_outbox RENAME TO settlement_outbox_gone");
    release?.();
    const r = await p;
    expect(meta(r)).toMatchObject({ outcome: "settlement-failed", charged: 0 });
    expect(JSON.stringify([r, gw.receipts(), gw.summary()])).not.toMatch(PG_TEXT);
    expect(await balance(w.a.ledger)).toMatchObject({ held: WORST, totals: { charged: 0 } });
    await w.t.raw("ALTER TABLE {{s}}.settlement_outbox_gone RENAME TO settlement_outbox");
    const b = w.spawn();
    w.clock.advance(GRACE);
    expect(await b.sweeper.sweep()).toMatchObject({ examined: 1, settled: 1, buried: [] });
    expect(await audit(b.ledger)).toMatchObject({ held: 0, charged: 0, forfeited: WORST, available: FUNDS - WORST });
    await pgAudit(b);
  });

  it("۸ گامِ هم‌زمانِ آویزان + ۳ گامِ کامل؛ پس از مرگ دو رفتگرِ زنده (دو فرایند) هم‌زمان: هر رزرو دقیقاً یک بار بسته می‌شود", async () => {
    const w = await world();
    const { gw, stub } = gatewayOf(w.a, w.clock, (_i, n) => (n < 3 ? stepOk(100) : hang()));
    for (let i = 0; i < 3; i++) expect((await gw.completeStep(STEP)).ok).toBe(true);
    for (let i = 0; i < 8; i++) void gw.completeStep(STEP);
    await until(() => stub.inputs.length === 11, "۸ تماسِ آویزان");
    expect(await counts(w.a)).toEqual({ open: 8, settling: 0, done: 3, dead: 0 });
    expect((await balance(w.a.ledger)).held).toBe(8 * WORST);
    await w.a.kill();
    const b = w.spawn(3);
    const c = w.spawn(3);
    await drain([b, c], w.clock);
    expect(await counts(b)).toEqual({ open: 0, settling: 0, done: 11, dead: 0 });
    expect(await audit(b.ledger)).toMatchObject({ held: 0, charged: 300, forfeited: 8 * WORST, available: FUNDS - 300 - 8 * WORST, openReservations: 0 });
    const j = ok(await b.ledger.journal(KEY));
    const terminal = j.filter((e) => e.type === "forfeit" || e.type === "release" || e.type === "expire");
    expect(terminal).toHaveLength(11);
    expect(new Set(terminal.map((e) => e.reservationId)).size).toBe(11);
    expect(j.filter((e) => e.type === "charge")).toHaveLength(3);
    expect(j.filter((e) => e.type === "forfeit")).toHaveLength(8);
    await pgAudit(b);
  });

  it.each([11, 28, 47, 84, 101, 130])("ویژگی (بذر %i): ۱۶ گامِ هم‌زمانِ آمیخته (موفق، error.cost، نامعلوم، آویزان) + مرگ + دو رفتگر ⇒ حفظِ پول و هزینهٔ دقیق", async (seed) => {
    const rnd = prng(seed);
    const N = 16;
    const policy = seed % 2 === 1 ? "forfeit" : "release";
    type Kind = { kind: "ok" | "errCost" | "unknown" | "hang"; micros: number };
    const plan: Kind[] = Array.from({ length: N }, () => {
      const r = rnd();
      return { kind: r < 0.35 ? "ok" : r < 0.55 ? "errCost" : r < 0.75 ? "unknown" : "hang", micros: 1 + Math.floor(rnd() * 400) };
    });
    // ادعای پوشش: بذر باید هر چهار نوع را شامل شود (وگرنه ویژگی تهی است).
    expect(new Set(plan.map((s) => s.kind))).toEqual(new Set(["ok", "errCost", "unknown", "hang"]));
    // محتوای پیام شمارهٔ گام را می‌رساند (طولِ ثابتِ ۴ بایت ⇒ بدترین‌هزینهٔ یکسان)؛ ترتیبِ رسیدنِ تماس‌ها قطعی نیست.
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
    const { gw, stub } = gatewayOf(w.a, w.clock, reply, { onUnknownCost: policy });
    const live: Promise<unknown>[] = [];
    plan.forEach((spec, i) => {
      const call = gw.completeStep({ ...STEP, messages: [{ role: "user", content: `s${String(i).padStart(3, "0")}` }] });
      if (spec.kind !== "hang") live.push(call);
    });
    await Promise.all(live);
    await until(() => stub.inputs.length === N, "همهٔ تماس‌ها");
    await w.a.kill();
    const b = w.spawn(3);
    const c = w.spawn(3);
    await drain([b, c], w.clock);
    const known = plan.filter((s) => s.kind === "ok" || s.kind === "errCost").reduce((a, s) => a + s.micros, 0);
    const burned = plan.filter((s) => s.kind === "unknown" || s.kind === "hang").length;
    const forfeited = policy === "forfeit" ? burned * WORST : 0;
    expect(await audit(b.ledger)).toMatchObject({ held: 0, openReservations: 0, charged: known, forfeited, available: FUNDS - known - forfeited });
    expect(await counts(b)).toEqual({ open: 0, settling: 0, done: N, dead: 0 });
    await pgAudit(b);
  });
});
