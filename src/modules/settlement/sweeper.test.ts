/**
 * رفتگر تسویه: هر گذار، هر خطا، idempotency، مسابقه و پیکربندی. همهٔ سناریوها با دفتر واقعی (حافظه‌ای) و دکوراتور واقعی ساخته می‌شوند؛
 * «مرگِ فرایند» با اجرای ناقصِ گام‌های دکوراتور شبیه‌سازی می‌شود.
 */
import { describe, expect, it } from "vitest";
import { createMemoryOutbox, createSettlementSweeper } from "./index";
import type { SettlementOutbox } from "./index";
import { GRACE, TTL, WORST, auditLedger, balance, chargeInput, closeInput, flakyLedger, flakyOutbox, journal, ok, refOf, reserveInput, rig } from "./test-kit";

const ENTRY = async (x: { outbox: SettlementOutbox }, id: string) => {
  const e = ok(await x.outbox.get(refOf(id)));
  if (e === null) throw new Error("رکورد باید وجود می‌داشت");
  return e;
};

describe("settlement · createSettlementSweeper · پیکربندی", () => {
  it("پیش‌فرض‌ها اعمال می‌شوند و نمونه ساخته می‌شود", async () => {
    const x = await rig();
    expect(createSettlementSweeper({ ledger: x.ledger, outbox: x.outbox, clock: x.clock }).ok).toBe(true);
  });
  it.each([
    ["غیرشیء", null],
    ["بی‌ledger", { ledger: undefined }],
    ["ledger بی‌close", { ledger: { charge: () => 1 } }],
    ["outbox ناقص", { outbox: { listDue: () => 1 } }],
    ["بی‌clock", { clock: undefined }],
    ["limit صفر", { limit: 0 }],
    ["limit بزرگ", { limit: 1001 }],
    ["maxAttempts صفر", { maxAttempts: 0 }],
    ["maxAttempts اعشاری", { maxAttempts: 1.5 }],
    ["retryDelayMs منفی", { retryDelayMs: -1 }],
    ["کلید ناشناخته", { policy: "forfeit" }],
  ])("%s ⇒ INVALID_CONFIG", async (_n, over) => {
    const x = await rig();
    const base = { ledger: x.ledger, outbox: x.outbox, clock: x.clock };
    const r = createSettlementSweeper(over === null ? null : { ...base, ...over });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_CONFIG");
  });
  it("دفتر دکوراته‌شده را رد می‌کند (رفتگر باید دفتر خام بگیرد)", async () => {
    const x = await rig();
    const r = createSettlementSweeper({ ledger: x.durable, outbox: x.outbox, clock: x.clock });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.join(" ")).toMatch(/دفتر خام/);
  });
});

describe("settlement · رفتگر · رزروِ یتیم (مرگ پیش از ثبتِ هر قصد)", () => {
  it("پیش از مهلت (graceMs) به هیچ رکوردی دست نمی‌زند", async () => {
    const x = await rig();
    ok(await x.durable.reserve(reserveInput("r1")));
    x.clock.advance(GRACE - 1);
    expect(await x.sweeper.sweep()).toMatchObject({ examined: 0, settled: 0 });
    expect((await balance(x.ledger)).held).toBe(WORST);
  });
  it("سیاست forfeit: کل رزرو سوخته می‌شود (کفِ امن)، رکورد done، origin=sweeper", async () => {
    const x = await rig({ policy: "forfeit" });
    ok(await x.durable.reserve(reserveInput("r1")));
    x.clock.advance(GRACE);
    const rep = await x.sweeper.sweep();
    expect(rep).toMatchObject({ examined: 1, settled: 1, retryLater: 0, raced: 0, outboxFailures: 0, listFailed: false, buried: [] });
    expect(await balance(x.ledger)).toMatchObject({ available: 5000 - WORST, held: 0, totals: { forfeited: WORST, charged: 0 } });
    expect(await ENTRY(x, "r1")).toMatchObject({ state: "done", close: { remainder: "forfeit", origin: "sweeper" } });
    await auditLedger(x.store);
  });
  it("سیاست release: رزرو آزاد می‌شود (کاربر مجانی؛ تصمیمِ محصولیِ صریح)", async () => {
    const x = await rig({ policy: "release" });
    ok(await x.durable.reserve(reserveInput("r1")));
    x.clock.advance(GRACE);
    expect((await x.sweeper.sweep()).settled).toBe(1);
    expect(await balance(x.ledger)).toMatchObject({ available: 5000, held: 0, totals: { forfeited: 0, charged: 0 } });
  });
});

describe("settlement · رفتگر · قصدِ ثبت‌شده (شکست یا مرگ در میانهٔ تسویه)", () => {
  it("فقط قصدِ مصرف ثبت شده (مرگ پیش از ledger.charge): هزینه را می‌گیرد و باقیمانده را release می‌کند — نه forfeit", async () => {
    const x = await rig({ policy: "forfeit" });
    ok(await x.durable.reserve(reserveInput("r1")));
    ok(await x.outbox.recordCharge(refOf("r1"), { attemptId: "a1", amount: 100 })); // مرگ دقیقاً اینجا
    x.clock.advance(GRACE);
    expect((await x.sweeper.sweep()).settled).toBe(1);
    expect(await balance(x.ledger)).toMatchObject({ available: 5000 - 100, held: 0, totals: { charged: 100, forfeited: 0 } });
    expect(await ENTRY(x, "r1")).toMatchObject({ state: "done", close: { remainder: "release", origin: "sweeper" } });
  });
  it("مصرف روی دفتر اعمال شده ولی بستن نه: بازپخشِ مصرف دوباره‌کاری نمی‌کند (هزینه یک بار)", async () => {
    const x = await rig();
    ok(await x.durable.reserve(reserveInput("r1")));
    ok(await x.durable.charge(chargeInput("r1", 100)));
    const before = (await journal(x.ledger)).filter((e) => e.type === "charge").length;
    x.clock.advance(GRACE);
    expect((await x.sweeper.sweep()).settled).toBe(1);
    expect((await journal(x.ledger)).filter((e) => e.type === "charge")).toHaveLength(before);
    expect((await balance(x.ledger)).totals.charged).toBe(100);
    expect(await balance(x.ledger)).toMatchObject({ available: 4900, held: 0 });
  });
  it("هر دو قصد ثبت و دفتر کاملاً بسته ولی finish گم شد: فقط رکورد بسته می‌شود، دفتر بی‌تغییر", async () => {
    const outbox = flakyOutbox(createMemoryOutbox(), { finish: { fail: 1 } });
    const x = await rig({ outbox });
    ok(await x.durable.reserve(reserveInput("r1")));
    ok(await x.durable.charge(chargeInput("r1", 100)));
    ok(await x.durable.close(closeInput("r1", "release")));
    expect((await ENTRY(x, "r1")).state).toBe("settling");
    const n = (await journal(x.ledger)).length;
    x.clock.advance(GRACE);
    expect(await x.sweeper.sweep()).toMatchObject({ settled: 1, buried: [] });
    expect((await journal(x.ledger)).length).toBe(n);
    expect((await ENTRY(x, "r1")).state).toBe("done");
  });
  it("قصدِ سوخت با کفِ معلوم (هزینهٔ نامعلوم): مصرفِ کف سپس forfeit", async () => {
    const x = await rig({ policy: "forfeit" });
    ok(await x.durable.reserve(reserveInput("r1")));
    ok(await x.outbox.recordCharge(refOf("r1"), { attemptId: "a1", amount: 40 }));
    ok(await x.outbox.recordClose(refOf("r1"), { remainder: "forfeit", origin: "caller" }));
    x.clock.advance(GRACE);
    expect((await x.sweeper.sweep()).settled).toBe(1);
    expect(await balance(x.ledger)).toMatchObject({ held: 0, available: 5000 - WORST, totals: { charged: 40, forfeited: WORST - 40 } });
  });
  it("دو گذرِ پیاپی: دومی چیزی نمی‌بیند و دفتر را تکان نمی‌دهد (idempotent)", async () => {
    const x = await rig();
    ok(await x.durable.reserve(reserveInput("r1")));
    x.clock.advance(GRACE);
    await x.sweeper.sweep();
    const n = (await journal(x.ledger)).length;
    expect(await x.sweeper.sweep()).toMatchObject({ examined: 0, settled: 0 });
    expect((await journal(x.ledger)).length).toBe(n);
  });
});

describe("settlement · رفتگر · شکست‌های گذرا، سقف تلاش و مرگِ مستند", () => {
  it("شکست گذرای دفتر: retryLater؛ سررسیدِ بعد = delay × (تلاش+۱)؛ گذرِ بعد پس از سررسید موفق", async () => {
    let flaky!: ReturnType<typeof flakyLedger>;
    const x = await rig({ retryDelayMs: 5_000, ledger: (l) => (flaky = flakyLedger(l, { close: { fail: 1 } })) });
    ok(await x.durable.reserve(reserveInput("r1")));
    x.clock.advance(GRACE);
    expect(await x.sweeper.sweep()).toMatchObject({ examined: 1, retryLater: 1, settled: 0 });
    const e1 = await ENTRY(x, "r1");
    expect(e1).toMatchObject({ attempts: 1, lastErrorCode: "STORE_FAILURE", dueAtMs: x.clock.nowMs() + 5_000, state: "settling" });
    expect(await x.sweeper.sweep()).toMatchObject({ examined: 0 }); // هنوز سررسید نشده
    x.clock.advance(5_000);
    expect(await x.sweeper.sweep()).toMatchObject({ examined: 1, settled: 1 });
    expect(flaky.count["close"]).toBe(2);
  });
  it("تأخیر خطی است: شکستِ دوم سررسید را به ۲×delay می‌برد (نه همان delay)", async () => {
    const x = await rig({ retryDelayMs: 5_000, maxAttempts: 10, ledger: (l) => flakyLedger(l, { close: { fail: 2 } }) });
    ok(await x.durable.reserve(reserveInput("r1")));
    x.clock.advance(GRACE);
    await x.sweeper.sweep();
    x.clock.advance(5_000);
    expect(await x.sweeper.sweep()).toMatchObject({ retryLater: 1 });
    expect(await ENTRY(x, "r1")).toMatchObject({ attempts: 2, dueAtMs: x.clock.nowMs() + 10_000 });
    x.clock.advance(9_999);
    expect(await x.sweeper.sweep()).toMatchObject({ examined: 0 });
    x.clock.advance(1);
    expect(await x.sweeper.sweep()).toMatchObject({ settled: 1 });
  });
  it("پرتاب و خروجیِ نامعتبرِ دفتر هم گذرا شمرده می‌شوند", async () => {
    for (const mode of ["throw", "garbage"] as const) {
      const x = await rig({ ledger: (l) => flakyLedger(l, { close: { fail: 1, mode } }) });
      ok(await x.durable.reserve(reserveInput("r1")));
      x.clock.advance(GRACE);
      expect(await x.sweeper.sweep()).toMatchObject({ retryLater: 1 });
    }
  });
  it("سقف تلاش: پس از maxAttempts شکستِ گذرا ⇒ ATTEMPTS_EXHAUSTED (زنگ) و در listDead", async () => {
    const x = await rig({ maxAttempts: 3, retryDelayMs: 1_000, ledger: (l) => flakyLedger(l, { close: { fail: 99 } }) });
    ok(await x.durable.reserve(reserveInput("r1")));
    x.clock.advance(GRACE);
    const reps = [];
    for (let i = 0; i < 3; i++) {
      reps.push(await x.sweeper.sweep());
      x.clock.advance(10_000);
    }
    expect(reps.map((r) => r.retryLater)).toEqual([1, 1, 0]);
    expect(reps[2]?.buried).toEqual([{ tenantId: "tenant-s", accountId: "acct-s", reservationId: "r1", reason: "ATTEMPTS_EXHAUSTED", errorCode: "STORE_FAILURE" }]);
    expect(ok(await x.outbox.listDead({ limit: 5 })).map((e) => e.deadReason)).toEqual(["ATTEMPTS_EXHAUSTED"]);
    expect(await x.sweeper.sweep()).toMatchObject({ examined: 0 });
  });
  it("قصدِ مصرفِ اعمال‌نشده + انقضا ⇒ EXPIRED_UNBILLED (دفتر دیگر نمی‌پذیرد؛ کاربر مجانی گرفت و زنگ می‌خورد)", async () => {
    const x = await rig();
    ok(await x.durable.reserve(reserveInput("r1")));
    ok(await x.outbox.recordCharge(refOf("r1"), { attemptId: "a1", amount: 100 }));
    x.clock.advance(TTL + 1);
    const rep = await x.sweeper.sweep();
    expect(rep.buried).toMatchObject([{ reason: "EXPIRED_UNBILLED", errorCode: "RESERVATION_EXPIRED" }]);
    expect(await balance(x.ledger)).toMatchObject({ available: 5000, held: 0, totals: { charged: 0 } });
    expect((await ENTRY(x, "r1")).state).toBe("dead");
  });
  it("یتیمِ forfeit پس از انقضا ⇒ EXPIRED_UNBILLED؛ یتیمِ release پس از انقضا ⇒ بسته می‌شود (دفتر close(release) را می‌پذیرد)", async () => {
    const a = await rig({ policy: "forfeit" });
    ok(await a.durable.reserve(reserveInput("r1")));
    a.clock.advance(TTL + 1);
    expect((await a.sweeper.sweep()).buried).toMatchObject([{ reason: "EXPIRED_UNBILLED" }]);
    const b = await rig({ policy: "release" });
    ok(await b.durable.reserve(reserveInput("r1")));
    b.clock.advance(TTL + 1);
    expect(await b.sweeper.sweep()).toMatchObject({ settled: 1, buried: [] });
  });
  it("بازپخشِ تسویهٔ کامل پس از انقضا موفق است (بازتکرار از کلید یکتایی؛ نه مرگِ کاذب)", async () => {
    const outbox = flakyOutbox(createMemoryOutbox(), { finish: { fail: 1 } });
    const x = await rig({ outbox });
    ok(await x.durable.reserve(reserveInput("r1")));
    ok(await x.durable.charge(chargeInput("r1", 100)));
    ok(await x.durable.close(closeInput("r1", "release")));
    x.clock.advance(TTL + 1);
    expect(await x.sweeper.sweep()).toMatchObject({ settled: 1, buried: [] });
  });
  it("رزرو را دیگری با باقیمانده‌ٔ متفاوت بسته: LEDGER_REJECTED (برای رسیدگی انسانی)، نه موفقیتِ کاذب", async () => {
    const x = await rig({ policy: "forfeit" });
    ok(await x.durable.reserve(reserveInput("r1")));
    ok(await x.ledger.close(closeInput("r1", "release"))); // مستقیم روی دفتر خام
    x.clock.advance(GRACE);
    expect((await x.sweeper.sweep()).buried).toMatchObject([{ reason: "LEDGER_REJECTED", errorCode: "IDEMPOTENCY_CONFLICT" }]);
  });
});

describe("settlement · رفتگر · خطای خودِ outbox و مسابقه", () => {
  it("شکست listDue ⇒ listFailed و گذرِ بی‌اثر؛ ساعت خراب هم همین", async () => {
    const outbox = flakyOutbox(createMemoryOutbox(), { listDue: { fail: 1 } });
    const x = await rig({ outbox });
    ok(await x.durable.reserve(reserveInput("r1")));
    x.clock.advance(GRACE);
    expect(await x.sweeper.sweep()).toMatchObject({ listFailed: true, examined: 0 });
    expect(await x.sweeper.sweep()).toMatchObject({ listFailed: false, settled: 1 });
    const bad = createSettlementSweeper({ ledger: x.ledger, outbox: x.outbox, clock: { nowMs: () => Number.NaN } });
    if (!bad.ok) throw new Error("x");
    expect(await bad.value.sweep()).toMatchObject({ listFailed: true });
  });
  it("شکست resolveClose ⇒ outboxFailures؛ رکورد و دفتر دست‌نخورده؛ گذر بعد موفق", async () => {
    const outbox = flakyOutbox(createMemoryOutbox(), { resolveClose: { fail: 1, mode: "throw" } });
    const x = await rig({ outbox });
    ok(await x.durable.reserve(reserveInput("r1")));
    x.clock.advance(GRACE);
    expect(await x.sweeper.sweep()).toMatchObject({ outboxFailures: 1, settled: 0 });
    expect((await ENTRY(x, "r1")).state).toBe("open");
    expect((await balance(x.ledger)).held).toBe(WORST);
    expect(await x.sweeper.sweep()).toMatchObject({ settled: 1 });
  });
  it("شکست finish پس از موفقیتِ دفتر ⇒ outboxFailures؛ گذر بعد بی‌اثر روی دفتر و رکورد done", async () => {
    const outbox = flakyOutbox(createMemoryOutbox(), { finish: { fail: 1 } });
    const x = await rig({ outbox });
    ok(await x.durable.reserve(reserveInput("r1")));
    x.clock.advance(GRACE);
    expect(await x.sweeper.sweep()).toMatchObject({ outboxFailures: 1, settled: 0 });
    const n = (await journal(x.ledger)).length;
    expect(await x.sweeper.sweep()).toMatchObject({ settled: 1 });
    expect((await journal(x.ledger)).length).toBe(n);
  });
  it("شکست recordFailure (خودِ outbox) ⇒ outboxFailures؛ شمار تلاشِ رکورد ثبت نمی‌شود و گذر بعد دوباره تلاش می‌کند", async () => {
    const outbox = flakyOutbox(createMemoryOutbox(), { recordFailure: { fail: 1 } });
    const x = await rig({ outbox, ledger: (l) => flakyLedger(l, { close: { fail: 99 } }) });
    ok(await x.durable.reserve(reserveInput("r1")));
    x.clock.advance(GRACE);
    expect(await x.sweeper.sweep()).toMatchObject({ outboxFailures: 1, retryLater: 0, buried: [] });
    expect(await ENTRY(x, "r1")).toMatchObject({ attempts: 0, state: "settling" });
    expect(await x.sweeper.sweep()).toMatchObject({ outboxFailures: 0, retryLater: 1 });
    expect(await ENTRY(x, "r1")).toMatchObject({ attempts: 1 });
  });
  it("شکست bury (خودِ outbox) ⇒ outboxFailures و بی‌زنگِ کاذب؛ گذر بعد رکورد را ATTEMPTS_EXHAUSTED می‌کند", async () => {
    const outbox = flakyOutbox(createMemoryOutbox(), { bury: { fail: 1 } });
    const x = await rig({ outbox, maxAttempts: 1, ledger: (l) => flakyLedger(l, { close: { fail: 99 } }) });
    ok(await x.durable.reserve(reserveInput("r1")));
    x.clock.advance(GRACE);
    expect(await x.sweeper.sweep()).toMatchObject({ outboxFailures: 1, buried: [] });
    expect((await ENTRY(x, "r1")).state).toBe("settling");
    expect((await x.sweeper.sweep()).buried).toMatchObject([{ reason: "ATTEMPTS_EXHAUSTED" }]);
  });
  it("مسابقه هنگام دفن: رکورد میان تصمیم و bury توسط تماسِ درون‌خطی نهایی شد ⇒ raced، نه مرگِ کاذب", async () => {
    const inner = createMemoryOutbox();
    const outbox: SettlementOutbox = {
      ...inner,
      async bury(ref, burial) {
        await inner.finish(ref, burial.atMs); // درون‌خطی همین لحظه تمام کرد
        return inner.bury(ref, burial);
      },
    };
    const x = await rig({ outbox, maxAttempts: 1, ledger: (l) => flakyLedger(l, { close: { fail: 99 } }) });
    ok(await x.durable.reserve(reserveInput("r1")));
    x.clock.advance(GRACE);
    expect(await x.sweeper.sweep()).toMatchObject({ examined: 1, raced: 1, buried: [], outboxFailures: 0 });
    expect((await ENTRY(x, "r1")).state).toBe("done");
  });
  it("مسابقه: تماسِ درون‌خطی میان فهرست‌کردن و تصمیم تسویه را تمام کرد ⇒ raced و دفتر دست‌نخورده", async () => {
    const inner = createMemoryOutbox();
    const outbox: SettlementOutbox = {
      ...inner,
      async listDue(q) {
        const r = await inner.listDue(q);
        if (r.ok) for (const e of r.value) (await inner.recordClose(e, { remainder: "release", origin: "caller" }), await inner.finish(e, q.nowMs));
        return r;
      },
    };
    let spy!: ReturnType<typeof flakyLedger>;
    const x = await rig({ outbox, ledger: (l) => (spy = flakyLedger(l, {})) });
    ok(await x.durable.reserve(reserveInput("r1")));
    x.clock.advance(GRACE);
    expect(await x.sweeper.sweep()).toMatchObject({ examined: 1, raced: 1, settled: 0 });
    expect(spy.count["close"]).toBe(0);
    expect(spy.count["charge"]).toBe(0);
  });
  it("مسابقه: قصدِ مصرفِ درون‌خطی میان فهرست و تصمیمِ رفتگر ثبت شد ⇒ release (نه forfeit) و مصرف اعمال می‌شود", async () => {
    const inner = createMemoryOutbox();
    const outbox: SettlementOutbox = {
      ...inner,
      async listDue(q) {
        const r = await inner.listDue(q); // عکسِ کهنه: charge=null
        if (r.ok) for (const e of r.value) await inner.recordCharge(e, { attemptId: "a1", amount: 70 });
        return r;
      },
    };
    const x = await rig({ outbox, policy: "forfeit" });
    ok(await x.durable.reserve(reserveInput("r1")));
    x.clock.advance(GRACE);
    expect(await x.sweeper.sweep()).toMatchObject({ settled: 1 });
    expect(await balance(x.ledger)).toMatchObject({ held: 0, available: 5000 - 70, totals: { charged: 70, forfeited: 0 } });
  });
  it("مسابقه: دو رفتگرِ هم‌زمان روی ۱۰ رکورد ⇒ هر هزینه دقیقاً یک بار، همه done، ناوردا سالم", async () => {
    const x = await rig({ funds: 100_000, policy: "forfeit" });
    for (let i = 0; i < 10; i++) {
      ok(await x.durable.reserve(reserveInput(`r${i}`, 500)));
      if (i % 2 === 0) ok(await x.outbox.recordCharge(refOf(`r${i}`), { attemptId: "a1", amount: 30 + i }));
    }
    x.clock.advance(GRACE);
    const second = createSettlementSweeper({ ledger: x.ledger, outbox: x.outbox, clock: x.clock });
    if (!second.ok) throw new Error("x");
    await Promise.all([x.sweeper.sweep(), second.value.sweep(), x.sweeper.sweep()]);
    expect(ok(await x.outbox.counts())).toEqual({ open: 0, settling: 0, done: 10, dead: 0 });
    const expectedCharged = [0, 2, 4, 6, 8].reduce((s, i) => s + 30 + i, 0);
    const expectedForfeit = 5 * 500;
    expect(await balance(x.ledger)).toMatchObject({ held: 0, totals: { charged: expectedCharged, forfeited: expectedForfeit } });
    await auditLedger(x.store);
  });
});

describe("settlement · رفتگر · سقف، ترتیب و گزارش", () => {
  it("limit: هر گذر حداکثر limit رکورد، به ترتیب سررسید؛ گذرهای بعد بقیه", async () => {
    const x = await rig({ limit: 2 });
    for (let i = 0; i < 5; i++) {
      ok(await x.durable.reserve(reserveInput(`r${i}`, 100)));
      x.clock.advance(1);
    }
    x.clock.advance(GRACE);
    const reps = [await x.sweeper.sweep(), await x.sweeper.sweep(), await x.sweeper.sweep(), await x.sweeper.sweep()];
    expect(reps.map((r) => r.examined)).toEqual([2, 2, 1, 0]);
    expect(ok(await x.outbox.counts()).done).toBe(5);
  });
  it("گزارش فقط شناسه و شمار دارد: هیچ پیام خام پورت (نشانهٔ نشت) نمی‌آید", async () => {
    const outbox = flakyOutbox(createMemoryOutbox(), { finish: { fail: 1, mode: "throw" }, listDue: { fail: 1, skip: 1 } });
    const x = await rig({ outbox, ledger: (l) => flakyLedger(l, { close: { fail: 1, mode: "throw" } }) });
    ok(await x.durable.reserve(reserveInput("r1")));
    x.clock.advance(GRACE);
    const reps = [await x.sweeper.sweep(), await x.sweeper.sweep(), await x.sweeper.sweep()];
    expect(JSON.stringify(reps)).not.toMatch(/LEAK-CANARY|boom|پیام|message/i);
  });
  it("ریخت گزارش منجمد و کامل است", async () => {
    const x = await rig();
    const r = await x.sweeper.sweep();
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.buried)).toBe(true);
    expect(Object.keys(r).sort()).toEqual(["buried", "examined", "listFailed", "outboxFailures", "raced", "retryLater", "settled"]);
  });
});
