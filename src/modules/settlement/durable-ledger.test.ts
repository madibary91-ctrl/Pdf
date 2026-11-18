/**
 * دفتر تسویهٔ ماندگار (دکوراتور): ثبتِ قصد پیش از هر تغییرِ مالی، بسته‌شکستی، ترتیب، و عبور بی‌دخالتِ متدهای دیگر.
 */
import { describe, expect, it } from "vitest";
import { createDurableLedger, createMemoryOutbox } from "./index";
import { ACCOUNT, GRACE, KEY, TENANT, TTL, UNIT, WORST, balance, chargeInput, closeInput, flakyLedger, flakyOutbox, fundedLedger, journal, ok, refOf, reserveInput, rig, traceLedger } from "./test-kit";

describe("settlement · createDurableLedger · پیکربندی", () => {
  it("پیکربندی درست ساخته می‌شود و Ledger کامل می‌دهد", async () => {
    const f = await fundedLedger(100);
    const r = createDurableLedger({ ledger: f.ledger, outbox: createMemoryOutbox(), clock: f.clock, graceMs: GRACE, onUnknownCost: "forfeit" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.value).sort()).toEqual(["balance", "charge", "close", "grant", "journal", "openAccount", "refund", "reserve"]);
  });
  it.each([
    ["غیرشیء", null],
    ["بی‌ledger", { outbox: true, clock: true, graceMs: 1, onUnknownCost: "forfeit" }],
    ["graceMs صفر", { graceMs: 0 }],
    ["graceMs اعشاری", { graceMs: 1.5 }],
    ["graceMs بیش از نصف حداکثر عمر رزرو", { graceMs: 43_200_001 }],
    ["بی‌graceMs", { graceMs: undefined }],
    ["onUnknownCost بی‌پیش‌فرض", { onUnknownCost: undefined }],
    ["onUnknownCost نامعتبر", { onUnknownCost: "keep" }],
    ["outbox ناقص", { outbox: { begin: () => 1 } }],
    ["بی‌clock", { clock: undefined }],
    ["کلید ناشناخته", { extra: 1 }],
  ])("%s ⇒ INVALID_CONFIG با فهرست مشکل (بی‌پرتاب)", async (_n, over) => {
    const f = await fundedLedger(100);
    const base = { ledger: f.ledger, outbox: createMemoryOutbox(), clock: f.clock, graceMs: GRACE, onUnknownCost: "forfeit" };
    const raw = over === null ? null : { ...base, ...over };
    const r = createDurableLedger(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_CONFIG");
      expect(r.error.issues.length).toBeGreaterThan(0);
    }
  });
  it("دکوراتور را روی دکوراتور نمی‌پذیرد", async () => {
    const x = await rig();
    const r = createDurableLedger({ ledger: x.durable, outbox: createMemoryOutbox(), clock: x.clock, graceMs: GRACE, onUnknownCost: "forfeit" });
    expect(r.ok).toBe(false);
  });
  it("getter پرتاب‌کننده ⇒ INVALID_CONFIG، نه پرتاب", () => {
    const evil = {
      get ledger(): never {
        throw new Error("x");
      },
    };
    expect(createDurableLedger(evil).ok).toBe(false);
  });
});

describe("settlement · دفتر تسویهٔ ماندگار · reserve", () => {
  it("دفتر را رزرو می‌کند و سپس رکورد open با میدان‌های درست می‌سازد (ترتیب: ledger ← outbox)", async () => {
    const log: string[] = [];
    const f = await fundedLedger(1000);
    const outbox = flakyOutbox(createMemoryOutbox(), {});
    const x = await rig({ outbox, ledger: () => traceLedger(f.ledger, log), base: f });
    log.length = 0;
    outbox.log.length = 0;
    const r = ok(await x.durable.reserve(reserveInput("r1")));
    expect(r).toMatchObject({ amount: WORST, replayed: false });
    expect(log).toEqual(["ledger.reserve"]);
    expect(outbox.log).toEqual(["outbox.begin"]);
    const e = ok(await x.outbox.get(refOf("r1")));
    expect(e).toMatchObject({ state: "open", unit: UNIT, reserved: WORST, orphanRemainder: "forfeit", expiresAtMs: r.expiresAtMs, createdAtMs: x.clock.nowMs(), dueAtMs: x.clock.nowMs() + GRACE, charge: null, close: null });
  });
  it("سیاست یتیم از پیکربندی در رکورد ثبت می‌شود", async () => {
    const x = await rig({ policy: "release" });
    ok(await x.durable.reserve(reserveInput("r1")));
    expect(ok(await x.outbox.get(refOf("r1")))).toMatchObject({ orphanRemainder: "release" });
  });
  it("بازتکرارِ رزرو (replayed) رکورد تازه نمی‌سازد و همان رسید را می‌دهد", async () => {
    const outbox = flakyOutbox(createMemoryOutbox(), {});
    const x = await rig({ outbox });
    ok(await x.durable.reserve(reserveInput("r1")));
    const again = ok(await x.durable.reserve(reserveInput("r1")));
    expect(again.replayed).toBe(true);
    expect(outbox.count["begin"]).toBe(1);
  });
  it("رد دفتر (اعتبار ناکافی/ورودی بد) ⇒ هیچ رکوردی ساخته نمی‌شود", async () => {
    const x = await rig({ funds: 10 });
    const r = await x.durable.reserve(reserveInput("r1"));
    expect(!r.ok && r.error.code).toBe("INSUFFICIENT_CREDIT");
    const bad = await x.durable.reserve({ ...reserveInput("r2"), amount: 0 });
    expect(!bad.ok && bad.error.code).toBe("INVALID_INPUT");
    const extra = await x.durable.reserve({ ...reserveInput("r3"), junk: 1 } as never);
    expect(!extra.ok && extra.error.code).toBe("INVALID_INPUT");
    expect(ok(await x.outbox.counts())).toEqual({ open: 0, settling: 0, done: 0, dead: 0 });
  });
  it("عمر رزرو کمتر از دو برابر graceMs ⇒ INVALID_INPUT پیش از هر تماس با دفتر", async () => {
    const f = await fundedLedger(1000);
    const spy = flakyLedger(f.ledger, {});
    const x = await rig({ base: f, ledger: () => spy, grace: 10_000 });
    const r = await x.durable.reserve(reserveInput("r1", WORST, 19_999));
    expect(!r.ok && r.error.code).toBe("INVALID_INPUT");
    expect(spy.count["reserve"]).toBe(0);
    expect((await x.durable.reserve(reserveInput("r1", WORST, 20_000))).ok).toBe(true);
  });
  it.each(["result", "throw", "garbage"] as const)("شکست ثبت در outbox (%s) ⇒ STORE_FAILURE، رزرو برگردانده می‌شود (هیچ پولی نگه‌داشته نمی‌ماند)", async (mode) => {
    const outbox = flakyOutbox(createMemoryOutbox(), { begin: { fail: 1, mode } });
    const x = await rig({ outbox, funds: 1000 });
    const r = await x.durable.reserve(reserveInput("r1"));
    expect(!r.ok && r.error.code).toBe("STORE_FAILURE");
    const b = await balance(x.ledger);
    expect(b).toMatchObject({ available: 1000, held: 0, openReservations: 0 });
    expect(ok(await x.outbox.counts()).open).toBe(0);
  });
  it("اگر آزادسازیِ پس از شکستِ outbox هم نشد، باز خطا برمی‌گردد (رزرو با سررسید آزاد می‌شود؛ تماسی انجام نمی‌شود)", async () => {
    const outbox = flakyOutbox(createMemoryOutbox(), { begin: { fail: 1 } });
    const f = await fundedLedger(1000);
    const x = await rig({ outbox, base: f, ledger: () => flakyLedger(f.ledger, { close: { fail: 1 } }) });
    const r = await x.durable.reserve(reserveInput("r1"));
    expect(!r.ok && r.error.code).toBe("STORE_FAILURE");
    expect((await balance(x.ledger)).held).toBe(WORST);
    x.clock.advance(TTL + 1);
    expect(await balance(x.ledger)).toMatchObject({ available: 1000, held: 0 });
  });
  it("پیام خام پورت (نشانهٔ نشت) هرگز در خطا نمی‌آید", async () => {
    const outbox = flakyOutbox(createMemoryOutbox(), { begin: { fail: 1 } });
    const x = await rig({ outbox });
    const r = await x.durable.reserve(reserveInput("r1"));
    expect(JSON.stringify(r)).not.toMatch(/LEAK-CANARY|boom/);
  });
  it("ساعتِ نامعتبر پس از رزرو ⇒ خطا و رزرو برگردانده می‌شود", async () => {
    const f = await fundedLedger(1000);
    let bad = false;
    const clock = { nowMs: () => (bad ? Number.NaN : f.clock.nowMs()) };
    const made = createDurableLedger({ ledger: flakyLedger(f.ledger, {}), outbox: createMemoryOutbox(), clock, graceMs: GRACE, onUnknownCost: "forfeit" });
    if (!made.ok) throw new Error("x");
    const wrapped = { ...made.value, reserve: async (i: never) => ((bad = true), made.value.reserve(i)) };
    const r = await wrapped.reserve(reserveInput("r1") as never);
    expect(!r.ok && r.error.code).toBe("STORE_FAILURE"); // ساعت خراب هم همان مسیر بسته‌شکستِ «ثبت ماندگار ناموفق» است
    expect(await balance(f.ledger)).toMatchObject({ available: 1000, held: 0 });
  });
});

describe("settlement · دفتر تسویهٔ ماندگار · charge و close", () => {
  it("ترتیبِ ثبت پیش از دفتر: recordCharge ← ledger.charge؛ recordClose ← ledger.close ← finish", async () => {
    const log: string[] = [];
    const f = await fundedLedger(1000);
    const outbox = flakyOutbox(createMemoryOutbox(), {});
    const x = await rig({ outbox, ledger: () => traceLedger(f.ledger, log), base: f });
    ok(await x.durable.reserve(reserveInput("r1")));
    log.length = 0;
    outbox.log.length = 0;
    ok(await x.durable.charge(chargeInput("r1", 100)));
    expect(outbox.log).toEqual(["outbox.recordCharge"]);
    expect(log).toEqual(["ledger.charge"]);
    outbox.log.length = 0;
    log.length = 0;
    ok(await x.durable.close(closeInput("r1", "release")));
    expect(outbox.log).toEqual(["outbox.recordClose", "outbox.finish"]);
    expect(log).toEqual(["ledger.close"]);
    expect(ok(await x.outbox.get(refOf("r1")))).toMatchObject({ state: "done", charge: { attemptId: "a1", amount: 100 }, close: { remainder: "release", origin: "caller" } });
    expect(await balance(x.ledger)).toMatchObject({ available: 1000 - 100, held: 0 });
  });
  it("ترتیبِ واقعی میان دو پورت: قصد همیشه پیش از تغییرِ دفتر ثبت می‌شود", async () => {
    const order: string[] = [];
    const f = await fundedLedger(1000);
    const outbox = flakyOutbox(createMemoryOutbox(), {});
    const inner = outbox.recordCharge;
    (outbox as { recordCharge: typeof inner }).recordCharge = async (...a) => (order.push("intent"), inner(...a));
    const spy = flakyLedger(f.ledger, {});
    const chargeFn = spy.charge;
    const x = await rig({ outbox, base: f, ledger: () => ({ ...spy, charge: async (i) => (order.push("ledger"), chargeFn(i)) }) });
    ok(await x.durable.reserve(reserveInput("r1")));
    ok(await x.durable.charge(chargeInput("r1", 5)));
    expect(order).toEqual(["intent", "ledger"]);
  });
  it.each(["result", "throw", "garbage"] as const)("شکست ثبتِ قصدِ مصرف (%s) ⇒ دفتر دست‌نخورده و STORE_FAILURE (بسته‌شکستی)", async (mode) => {
    const outbox = flakyOutbox(createMemoryOutbox(), { recordCharge: { fail: 1, mode } });
    const f = await fundedLedger(1000);
    const spy = flakyLedger(f.ledger, {});
    const x = await rig({ outbox, base: f, ledger: () => spy });
    ok(await x.durable.reserve(reserveInput("r1")));
    const before = (await journal(x.ledger)).length;
    const r = await x.durable.charge(chargeInput("r1", 100));
    expect(!r.ok && r.error.code).toBe("STORE_FAILURE");
    expect(spy.count["charge"]).toBe(0);
    expect((await journal(x.ledger)).length).toBe(before);
    expect(ok(await x.outbox.get(refOf("r1")))).toMatchObject({ state: "open", charge: null });
  });
  it.each(["result", "throw", "garbage"] as const)("شکست ثبتِ قصدِ بستن (%s) ⇒ دفتر دست‌نخورده", async (mode) => {
    const outbox = flakyOutbox(createMemoryOutbox(), { recordClose: { fail: 1, mode } });
    const f = await fundedLedger(1000);
    const spy = flakyLedger(f.ledger, {});
    const x = await rig({ outbox, base: f, ledger: () => spy });
    ok(await x.durable.reserve(reserveInput("r1")));
    const r = await x.durable.close(closeInput("r1", "release"));
    expect(!r.ok && r.error.code).toBe("STORE_FAILURE");
    expect(spy.count["close"]).toBe(0);
    expect((await balance(x.ledger)).held).toBe(WORST);
  });
  it("شکستِ finish نتیجهٔ موفقِ دفتر را عوض نمی‌کند؛ رکورد settling می‌ماند برای رفتگر", async () => {
    const outbox = flakyOutbox(createMemoryOutbox(), { finish: { fail: 1, mode: "throw" } });
    const x = await rig({ outbox });
    ok(await x.durable.reserve(reserveInput("r1")));
    const r = await x.durable.close(closeInput("r1", "release"));
    expect(r.ok).toBe(true);
    expect(ok(await x.outbox.get(refOf("r1")))).toMatchObject({ state: "settling" });
  });
  it("شکستِ دفتر در close ⇒ finish صدا زده نمی‌شود و خطای دفتر عیناً برمی‌گردد", async () => {
    const outbox = flakyOutbox(createMemoryOutbox(), {});
    const f = await fundedLedger(1000);
    const x = await rig({ outbox, base: f, ledger: () => flakyLedger(f.ledger, { close: { fail: 1, code: "STORE_FAILURE" } }) });
    ok(await x.durable.reserve(reserveInput("r1")));
    outbox.log.length = 0;
    const r = await x.durable.close(closeInput("r1", "release"));
    expect(!r.ok && r.error.code).toBe("STORE_FAILURE");
    expect(outbox.log).toEqual(["outbox.recordClose"]);
    expect(ok(await x.outbox.get(refOf("r1")))).toMatchObject({ state: "settling", close: { remainder: "release" } });
  });
  it("رزرویِ بی‌رکورد ⇒ RESERVATION_NOT_FOUND و دفتر دست‌نخورده (مصرف بی‌ردّ ماندگار ممنوع)", async () => {
    const f = await fundedLedger(1000);
    const spy = flakyLedger(f.ledger, {});
    const x = await rig({ base: f, ledger: () => spy });
    ok(await f.ledger.reserve(reserveInput("raw")));
    const r = await x.durable.charge(chargeInput("raw", 5));
    expect(!r.ok && r.error.code).toBe("RESERVATION_NOT_FOUND");
    expect(spy.count["charge"]).toBe(0);
    const c = await x.durable.close(closeInput("raw", "release"));
    expect(!c.ok && c.error.code).toBe("RESERVATION_NOT_FOUND");
  });
  it("قصدِ مصرفِ دوم (تلاش/مبلغ دیگر) ⇒ IDEMPOTENCY_CONFLICT؛ بازتکرارِ یکسان ⇒ replayed", async () => {
    const x = await rig();
    ok(await x.durable.reserve(reserveInput("r1")));
    ok(await x.durable.charge(chargeInput("r1", 100)));
    const again = ok(await x.durable.charge(chargeInput("r1", 100)));
    expect(again.replayed).toBe(true);
    const other = await x.durable.charge(chargeInput("r1", 101));
    expect(!other.ok && other.error.code).toBe("IDEMPOTENCY_CONFLICT");
    const second = await x.durable.charge(chargeInput("r1", 5, "a2"));
    expect(!second.ok && second.error.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await balance(x.ledger)).totals.charged).toBe(100);
  });
  it("پس از نهایی‌شدنِ رکورد (done/dead) ⇒ RESERVATION_CLOSED", async () => {
    const x = await rig();
    ok(await x.durable.reserve(reserveInput("r1")));
    ok(await x.durable.reserve(reserveInput("r2")));
    ok(await x.durable.close(closeInput("r1", "release")));
    ok(await x.outbox.bury(refOf("r2"), { reason: "LEDGER_REJECTED", errorCode: null, atMs: 1 }));
    for (const id of ["r1", "r2"]) {
      const r = await x.durable.charge(chargeInput(id, 1, "a9"));
      expect(!r.ok && r.error.code).toBe("RESERVATION_CLOSED");
    }
  });
  it("ورودیِ نامعتبر ⇒ INVALID_INPUT بی‌هیچ تماس با outbox یا دفتر", async () => {
    const outbox = flakyOutbox(createMemoryOutbox(), {});
    const x = await rig({ outbox });
    outbox.log.length = 0;
    expect(((await x.durable.charge({ ...chargeInput("r1", 1), amount: -1 })) as { error: { code: string } }).error.code).toBe("INVALID_INPUT");
    expect(((await x.durable.close({ ...closeInput("r1", "release"), remainder: "keep" } as never)) as { error: { code: string } }).error.code).toBe("INVALID_INPUT");
    expect(((await x.durable.charge(null as never)) as { error: { code: string } }).error.code).toBe("INVALID_INPUT");
    expect(outbox.log).toEqual([]);
  });
  it("متدهای دیگر (openAccount، grant، refund، balance، journal) عیناً به دفتر می‌رسند", async () => {
    const x = await rig({ funds: 0 });
    ok(await x.durable.grant({ ...KEY, grantId: "g9", unit: UNIT, amount: 700, source: "promo" }));
    expect((await balance(x.durable)).available).toBe(700);
    expect(ok(await x.durable.journal(KEY)).length).toBeGreaterThan(0);
    expect(ok(await x.durable.openAccount({ tenantId: TENANT, accountId: ACCOUNT, unit: UNIT })).replayed).toBe(true);
    ok(await x.durable.reserve(reserveInput("r1", 100)));
    ok(await x.durable.charge(chargeInput("r1", 60)));
    ok(await x.durable.refund({ ...KEY, refundId: "f1", reservationId: "r1", attemptId: "a1", unit: UNIT, amount: 10 }));
    expect((await balance(x.ledger)).totals.refunded).toBe(10);
  });
});
