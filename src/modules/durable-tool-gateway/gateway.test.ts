import { describe, expect, it } from "vitest";
import { createMemoryOutbox } from "@/modules/settlement";
import { createDurableToolGateway } from "./index";
import { GRACE, STEP, TTL, WORST, audit, balance, configFor, flakyLedger, flakyOutbox, fundedLedger, mutableClock, ok, refOf, stepErr, stepOk, stubGateway, world } from "./test-kit";

const meta = (r: { ok: boolean; value?: { metering: unknown }; error?: { metering: unknown } }): Record<string, unknown> => (r.ok ? r.value!.metering : r.error!.metering) as Record<string, unknown>;
const FUNDS = 100_000;

describe("durable-tool-gateway · مسیر موفق و ثبتِ ماندگارِ هر گام", () => {
  it("گامِ موفق: مصرف، رزرو آزاد، رکورد done؛ رفتگر کاری ندارد", async () => {
    const t = await world(stepOk(100));
    const r = await t.gw.completeStep(STEP);
    expect(r.ok).toBe(true);
    expect(meta(r)).toMatchObject({ outcome: "billed", reserved: WORST, charged: 100, alarms: [] });
    expect(ok(await t.outbox.counts())).toEqual({ open: 0, settling: 0, done: 1, dead: 0 });
    expect(await t.sweeper.sweep()).toMatchObject({ examined: 0 });
    expect(await audit(t.ledger)).toMatchObject({ available: FUNDS - 100, held: 0, charged: 100, forfeited: 0, openReservations: 0 });
  });

  it("چند گامِ پیاپی: هر گام یک رکوردِ جدا (`scope.r<n>`)", async () => {
    const t = await world(stepOk(100));
    for (let i = 0; i < 3; i++) expect((await t.gw.completeStep(STEP)).ok).toBe(true);
    expect(ok(await t.outbox.counts())).toEqual({ open: 0, settling: 0, done: 3, dead: 0 });
    for (const n of [1, 2, 3]) expect(ok(await t.outbox.get(refOf(`scope-1.r${n}`)))).toMatchObject({ state: "done" });
    expect(t.gw.receipts().map((x) => x.reservationId)).toEqual(["scope-1.r1", "scope-1.r2", "scope-1.r3"]);
    expect(await audit(t.ledger)).toMatchObject({ charged: 300, held: 0 });
  });

  it("گام‌های هم‌زمان: رزرو و رکوردِ جدا و بی‌تداخل", async () => {
    const t = await world(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return stepOk(50);
    });
    const rs = await Promise.all([t.gw.completeStep(STEP), t.gw.completeStep(STEP), t.gw.completeStep(STEP), t.gw.completeStep(STEP)]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(new Set(t.gw.receipts().map((x) => x.reservationId)).size).toBe(4);
    expect(ok(await t.outbox.counts())).toEqual({ open: 0, settling: 0, done: 4, dead: 0 });
    expect(await audit(t.ledger)).toMatchObject({ charged: 200, held: 0 });
  });

  it("رکورد پیش از تماس باز و با تسویه بسته می‌شود (ترتیبِ begin ⇒ تماس ⇒ done)", async () => {
    let seenOpen = -1;
    const ref: { counts?: () => Promise<{ ok: true; value: { open: number } } | { ok: false; error: unknown }> } = {};
    const t = await world(async () => {
      seenOpen = ok(await ref.counts!()).open;
      return stepOk(10);
    });
    ref.counts = () => t.outbox.counts();
    await t.gw.completeStep(STEP);
    expect(seenOpen).toBe(1);
    expect(ok(await t.outbox.counts()).done).toBe(1);
  });
});

describe("durable-tool-gateway · مرگ و شکست (رفتگر تسویه را کامل می‌کند)", () => {
  it.each(["forfeit", "release"] as const)("فرایند وسط تماسِ گام می‌میرد (سیاست %s): رفتگر رزروِ یتیم را طبق سیاست می‌بندد؛ گام‌های پیشین دست‌نخورده", async (policy) => {
    const t = await world((_i, n) => (n === 0 ? stepOk(100) : new Promise(() => undefined)), { policy });
    expect((await t.gw.completeStep(STEP)).ok).toBe(true);
    void t.gw.completeStep(STEP); // رها شد: فرایند مرد
    for (let i = 0; i < 2000 && t.stub.inputs.length < 2; i++) await new Promise((res) => setTimeout(res, 1));
    expect(t.stub.inputs).toHaveLength(2);
    expect(ok(await t.outbox.counts())).toEqual({ open: 1, settling: 0, done: 1, dead: 0 });
    expect((await balance(t.ledger)).held).toBe(WORST);
    expect(await t.sweeper.sweep()).toMatchObject({ examined: 0 }); // هنوز در مهلتِ تماس
    t.clock.advance(GRACE);
    expect(await t.sweeper.sweep()).toMatchObject({ examined: 1, settled: 1, buried: [] });
    const b = await audit(t.ledger);
    if (policy === "forfeit") expect(b).toMatchObject({ held: 0, charged: 100, forfeited: WORST, available: FUNDS - 100 - WORST });
    else expect(b).toMatchObject({ held: 0, charged: 100, forfeited: 0, available: FUNDS - 100 });
    expect(ok(await t.outbox.counts())).toEqual({ open: 0, settling: 0, done: 2, dead: 0 });
  });

  it("شکستِ charge (۳ بار): SETTLEMENT_PENDING؛ رفتگر هزینه را دقیقاً یک بار ثبت می‌کند", async () => {
    const t = await world(stepOk(100), { ledger: (l) => flakyLedger(l, { charge: { fail: 3 } }) });
    const r = await t.gw.completeStep(STEP);
    expect(meta(r)).toMatchObject({ outcome: "settlement-failed", alarms: ["SETTLEMENT_PENDING"] });
    expect(t.gw.summary()).toMatchObject({ needsAttention: true });
    expect(await balance(t.ledger)).toMatchObject({ held: WORST, totals: { charged: 0 } });
    t.clock.advance(GRACE);
    expect(await t.sweeper.sweep()).toMatchObject({ examined: 1, settled: 1, buried: [] });
    expect(await audit(t.ledger)).toMatchObject({ available: FUNDS - 100, held: 0, charged: 100, forfeited: 0 });
    expect(await t.sweeper.sweep()).toMatchObject({ examined: 0 }); // idempotent
    expect(await audit(t.ledger)).toMatchObject({ charged: 100 });
  });

  it("هزینه ثبت و close شکست (CLOSE_PENDING): رفتگر باقیمانده را آزاد می‌کند و هزینه دوباره گرفته نمی‌شود", async () => {
    const t = await world(stepOk(100), { ledger: (l) => flakyLedger(l, { close: { fail: 3 } }) });
    const r = await t.gw.completeStep(STEP);
    expect(meta(r)).toMatchObject({ outcome: "billed", charged: 100, alarms: ["CLOSE_PENDING"] });
    expect((await balance(t.ledger)).held).toBe(WORST - 100);
    t.clock.advance(GRACE);
    expect(await t.sweeper.sweep()).toMatchObject({ settled: 1 });
    expect(await audit(t.ledger)).toMatchObject({ available: FUNDS - 100, held: 0, charged: 100, forfeited: 0 });
  });

  it("outbox هنگام ثبتِ مصرف خراب است: دفتر دست‌نخورده، رفتگر کفِ امن (forfeit) را می‌گیرد", async () => {
    const t = await world(stepOk(100), { outbox: (m) => flakyOutbox(m, { recordCharge: { fail: 99 } }) });
    const r = await t.gw.completeStep(STEP);
    expect(meta(r)).toMatchObject({ outcome: "settlement-failed", charged: 0 });
    expect(await balance(t.ledger)).toMatchObject({ held: WORST, totals: { charged: 0 } });
    t.clock.advance(GRACE);
    expect(await t.sweeper.sweep()).toMatchObject({ settled: 1 });
    expect(await audit(t.ledger)).toMatchObject({ held: 0, forfeited: WORST });
  });

  it("outbox هنگام begin خراب است ⇒ تماسی انجام نمی‌شود و رزرو برمی‌گردد (بی‌ردّ ماندگار، بی‌تماس پولی)", async () => {
    const t = await world(stepOk(100), { outbox: (m) => flakyOutbox(m, { begin: { fail: 1 } }) });
    const r = await t.gw.completeStep(STEP);
    expect(r.ok).toBe(false);
    expect(meta(r)).toMatchObject({ outcome: "refused", refusal: { code: "RESERVE_FAILED" } });
    expect(t.stub.inputs).toHaveLength(0);
    expect(await audit(t.ledger)).toMatchObject({ available: FUNDS, held: 0, charged: 0, forfeited: 0 });
    // گامِ بعدی (outbox سالم) درست کار می‌کند.
    expect((await t.gw.completeStep(STEP)).ok).toBe(true);
  });

  it("پیام‌های خطا و نتیجه هیچ‌گاه متنِ استثنای outbox/دفتر را نشت نمی‌دهند", async () => {
    const t = await world(stepOk(100), { outbox: (m) => flakyOutbox(m, { begin: { fail: 1 } }), ledger: (l) => flakyLedger(l, { close: { fail: 3 } }) });
    const r = await t.gw.completeStep(STEP);
    expect(JSON.stringify(r)).not.toContain("LEAK-CANARY-9c1");
    expect(JSON.stringify(t.gw.receipts())).not.toContain("LEAK-CANARY-9c1");
    expect(JSON.stringify(t.gw.summary())).not.toContain("LEAK-CANARY-9c1");
  });
});

describe("durable-tool-gateway · هزینهٔ گامِ ابزار (تفاوت با دروازهٔ ساده)", () => {
  it("گامِ شکست‌خورده با error.cost معتبر: هزینه مصرف می‌شود (نه سوختنِ کلِ رزرو) و رکورد done", async () => {
    const t = await world(stepErr("PROVIDER_ERROR", { cost: { micros: 70, currency: "IRR", priceVersion: "test-v1" } }));
    const r = await t.gw.completeStep(STEP);
    expect(r.ok).toBe(false);
    expect(meta(r)).toMatchObject({ outcome: "billed", charged: 70 });
    expect(await audit(t.ledger)).toMatchObject({ charged: 70, forfeited: 0, held: 0 });
    expect(ok(await t.outbox.counts()).done).toBe(1);
  });

  it("هزینهٔ نامعلوم + forfeit: سوخت و زنگ COST_UNKNOWN؛ رکورد done با origin=caller (بی‌کارِ رفتگر)", async () => {
    const t = await world(stepOk(null));
    const r = await t.gw.completeStep(STEP);
    expect(meta(r)).toMatchObject({ outcome: "forfeited", alarms: ["COST_UNKNOWN"] });
    expect(ok(await t.outbox.get(refOf("scope-1.r1")))).toMatchObject({ state: "done", close: { remainder: "forfeit", origin: "caller" } });
    expect(await t.sweeper.sweep()).toMatchObject({ examined: 0 });
    expect(await audit(t.ledger)).toMatchObject({ forfeited: WORST, held: 0 });
  });

  it("هزینهٔ نامعلوم + release: دفتر سالم می‌ماند ولی زنگ می‌ماند", async () => {
    const t = await world(stepOk(null), { policy: "release" });
    expect(meta(await t.gw.completeStep(STEP))).toMatchObject({ outcome: "released", alarms: ["COST_UNKNOWN"] });
    expect(await audit(t.ledger)).toMatchObject({ available: FUNDS, held: 0, forfeited: 0 });
  });

  it("اثباتاً بی‌تماس (INVALID_REQUEST): release درون‌خطی و رکورد done", async () => {
    const t = await world(stepErr("INVALID_REQUEST"));
    expect(meta(await t.gw.completeStep(STEP))).toMatchObject({ outcome: "released", charged: 0 });
    expect(ok(await t.outbox.counts()).done).toBe(1);
    expect(await audit(t.ledger)).toMatchObject({ available: FUNDS, held: 0 });
  });
});

describe("durable-tool-gateway · ردّها پیش از رزرو", () => {
  it("اعتبار ناکافی ⇒ ردّ؛ نه رزرو، نه رکورد، نه تماس", async () => {
    const t = await world(stepOk(1), { funds: 100 });
    const r = await t.gw.completeStep(STEP);
    expect(meta(r)).toMatchObject({ outcome: "refused", refusal: { code: "INSUFFICIENT_CREDIT" } });
    expect(ok(await t.outbox.counts())).toEqual({ open: 0, settling: 0, done: 0, dead: 0 });
    expect(t.stub.inputs).toHaveLength(0);
    expect(await audit(t.ledger)).toMatchObject({ available: 100, held: 0 });
  });

  it("درخواست نامعتبر یا مدلِ ناشناخته ⇒ ردّ بی‌رکورد", async () => {
    const t = await world(stepOk(1));
    expect((await t.gw.completeStep({ nope: 1 })).ok).toBe(false);
    expect((await t.gw.completeStep({ ...STEP, model: "ghost" })).ok).toBe(false);
    expect(ok(await t.outbox.counts())).toEqual({ open: 0, settling: 0, done: 0, dead: 0 });
    expect(t.stub.inputs).toHaveLength(0);
  });

  it("استفادهٔ دوبارهٔ scopeId ⇒ SCOPE_REUSED؛ رکوردِ تازه نمی‌سازد و تماسی نیست", async () => {
    const t = await world(stepOk(10), { scopeId: "dup" });
    expect((await t.gw.completeStep(STEP)).ok).toBe(true);
    const second = stubGateway(stepOk(10));
    const again = createDurableToolGateway(configFor(t.raw, second.gateway, t.outbox, t.clock, { scopeId: "dup" }));
    if (!again.ok) throw new Error("x");
    expect(meta(await again.value.completeStep(STEP))).toMatchObject({ outcome: "refused", refusal: { code: "SCOPE_REUSED" } });
    expect(second.inputs).toHaveLength(0);
    expect(ok(await t.outbox.counts())).toEqual({ open: 0, settling: 0, done: 1, dead: 0 });
  });

  it("ttl < ۲×graceMs در ساخت رد می‌شود (نه در هر گام)", async () => {
    const f = await fundedLedger(1000, undefined, mutableClock());
    const r = createDurableToolGateway(configFor(f.ledger, stubGateway(stepOk(1)).gateway, createMemoryOutbox(), f.clock, { reservationTtlMs: TTL / 10 }));
    expect(r.ok).toBe(false);
  });
});
