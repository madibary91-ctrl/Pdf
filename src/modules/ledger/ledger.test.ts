import { describe, expect, it } from "vitest";
import { checkInvariants, createLedger, createMemoryStore, foldJournal } from "./index";
import type { AccountKey, AccountStore, Ledger } from "./index";
import { A, T, UNIT, code, mutableClock, openFunded, setup, val } from "./test-kit";

const base = { tenantId: T, accountId: A };
const reserve = (l: Ledger, id: string, amount: number, ttlMs = 60_000, b = base) => l.reserve({ ...b, reservationId: id, unit: UNIT, amount, ttlMs });
const charge = (l: Ledger, id: string, attempt: string, amount: number, b = base) => l.charge({ ...b, reservationId: id, attemptId: attempt, unit: UNIT, amount });

async function audit(store: AccountStore, k: AccountKey = base): Promise<void> {
  const s = await store.read(k);
  expect(s).not.toBeNull();
  expect(checkInvariants(s!)).toEqual([]);
  const f = foldJournal(await store.journal(k));
  expect(f.ok).toBe(true);
  if (f.ok) expect(f.value).toEqual({ available: s!.available, held: s!.held, totals: s!.totals, seq: s!.seq });
}

describe("ledger · createLedger", () => {
  it("پیکربندی نامعتبر ⇒ INVALID_INPUT (clock الزامی است؛ ساعت سیستم پیش‌فرض ندارد)", () => {
    const store = createMemoryStore();
    for (const cfg of [null, undefined, 5, {}, { store }, { clock: mutableClock() }, { store, clock: {} }, { store: {}, clock: mutableClock() }, { store: { transact() {}, read() {} }, clock: mutableClock() }, { store: { read() {}, journal() {} }, clock: mutableClock() }, { store: { transact() {}, journal() {} }, clock: mutableClock() }, { store: { transact: 1, read: 2, journal: 3 }, clock: mutableClock() }, { store, clock: { nowMs: 5 } }]) {
      const r = createLedger(cfg);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
    }
    expect(createLedger({ store, clock: mutableClock() }).ok).toBe(true);
  });
  it("نمونهٔ ساخته‌شده منجمد است", () => {
    expect(Object.isFrozen(setup().ledger)).toBe(true);
  });
});

describe("ledger · چرخهٔ عمر یک ask با دو تلاش (ADR-0017)", () => {
  it("باز ← اعطا ← رزرو ← مصرف تلاش ۱ و ۲ ← بستن (آزاد) ⇒ فقط مصرف واقعی کسر می‌شود", async () => {
    const { ledger, store } = setup();
    await openFunded(ledger, 1000);
    const r = val(await reserve(ledger, "ask-1", 600));
    expect(r).toMatchObject({ kind: "reserve", amount: 600, availableAfter: 400, heldAfter: 600, replayed: false });
    expect(val(await charge(ledger, "ask-1", "ask-1:1", 250))).toMatchObject({ charged: 250, shortfall: 0, remainingHold: 350 });
    expect(val(await charge(ledger, "ask-1", "ask-1:2", 200))).toMatchObject({ charged: 200, remainingHold: 150 });
    expect(val(await ledger.close({ ...base, reservationId: "ask-1", remainder: "release" }))).toMatchObject({ released: 150, forfeited: 0 });
    expect(val(await ledger.balance(base))).toMatchObject({ available: 550, held: 0, openReservations: 0, totals: { granted: 1000, charged: 450, forfeited: 0, refunded: 0, shortfall: 0 } });
    expect(val(await ledger.journal(base)).map((e) => e.type)).toEqual(["grant", "reserve", "charge", "charge", "release"]);
    await audit(store);
  });
  it("بازتکرار تلاش ۱ (مثلاً timeout شبکه) دوباره کسر نمی‌کند", async () => {
    const { ledger, store } = setup();
    await openFunded(ledger, 1000);
    await reserve(ledger, "a", 500);
    const first = val(await charge(ledger, "a", "a:1", 100));
    const second = val(await charge(ledger, "a", "a:1", 100));
    expect(second).toEqual({ ...first, replayed: true });
    expect(val(await ledger.balance(base)).held).toBe(400);
    expect(val(await ledger.journal(base))).toHaveLength(3);
    await audit(store);
  });
  it("هزینهٔ نامعلوم: forfeit همهٔ باقیمانده را صریحاً مصرف‌شده می‌گیرد", async () => {
    const { ledger, store } = setup();
    await openFunded(ledger, 1000);
    await reserve(ledger, "a", 300);
    expect(val(await ledger.close({ ...base, reservationId: "a", remainder: "forfeit" }))).toMatchObject({ released: 0, forfeited: 300 });
    expect(val(await ledger.balance(base))).toMatchObject({ available: 700, held: 0, totals: { forfeited: 300 } });
    await audit(store);
  });
  it("تماس گران‌تر از رزرو: کسری ثبت می‌شود، موجودی منفی نمی‌شود", async () => {
    const { ledger, store } = setup();
    await openFunded(ledger, 100);
    await reserve(ledger, "a", 40);
    expect(val(await charge(ledger, "a", "a:1", 90))).toMatchObject({ charged: 40, shortfall: 50 });
    expect(val(await ledger.balance(base))).toMatchObject({ available: 60, held: 0, totals: { shortfall: 50 } });
    await audit(store);
  });
  it("بازگشت یک تلاش پس از بستن", async () => {
    const { ledger, store } = setup();
    await openFunded(ledger, 100);
    await reserve(ledger, "a", 50);
    await charge(ledger, "a", "a:1", 30);
    await ledger.close({ ...base, reservationId: "a", remainder: "release" });
    expect(val(await ledger.refund({ ...base, refundId: "f1", reservationId: "a", attemptId: "a:1", unit: UNIT, amount: 30 }))).toMatchObject({ availableAfter: 100, replayed: false });
    expect(code(await ledger.refund({ ...base, refundId: "f2", reservationId: "a", attemptId: "a:1", unit: UNIT, amount: 1 }))).toBe("REFUND_EXCEEDS_CHARGE");
    await audit(store);
  });
});

describe("ledger · جداسازی مستأجر", () => {
  const other = { tenantId: "tenant-b", accountId: A };
  it("مستأجر دیگر حساب را نمی‌بیند: همهٔ متدها ACCOUNT_NOT_FOUND (نه «ممنوع») و هیچ اثری ندارند", async () => {
    const { ledger, store } = setup();
    await openFunded(ledger, 100);
    await reserve(ledger, "r1", 10);
    await charge(ledger, "r1", "x1", 5);
    const before = await store.journal(base);
    expect(code(await ledger.balance(other))).toBe("ACCOUNT_NOT_FOUND");
    expect(code(await ledger.journal(other))).toBe("ACCOUNT_NOT_FOUND");
    expect(code(await ledger.grant({ ...other, grantId: "g", unit: UNIT, amount: 1, source: "promo" }))).toBe("ACCOUNT_NOT_FOUND");
    expect(code(await reserve(ledger, "r9", 1, 60_000, other))).toBe("ACCOUNT_NOT_FOUND");
    expect(code(await charge(ledger, "r1", "x2", 1, other))).toBe("ACCOUNT_NOT_FOUND");
    expect(code(await ledger.close({ ...other, reservationId: "r1", remainder: "forfeit" }))).toBe("ACCOUNT_NOT_FOUND");
    expect(code(await ledger.refund({ ...other, refundId: "f", reservationId: "r1", attemptId: "x1", unit: UNIT, amount: 1 }))).toBe("ACCOUNT_NOT_FOUND");
    expect(await store.read(other)).toBeNull();
    expect(await store.journal(base)).toEqual(before);
    expect(val(await ledger.balance(base)).held).toBe(5);
  });
  it("پیام خطای مستأجر دیگر با «حساب وجود ندارد» یکسان است (وجود حساب فاش نمی‌شود)", async () => {
    const { ledger } = setup();
    await openFunded(ledger, 100);
    const a = await ledger.balance(other);
    const c = await ledger.balance({ tenantId: "tenant-z", accountId: "no-such" });
    expect(a).toEqual(c);
  });
  it("شناسهٔ یکسان در دو مستأجر مستقل است (reservationId، attemptId، grantId، refundId)", async () => {
    const { ledger, store } = setup();
    await openFunded(ledger, 100);
    await openFunded(ledger, 7, "tenant-b", A);
    await reserve(ledger, "same", 50);
    await reserve(ledger, "same", 5, 60_000, other);
    await charge(ledger, "same", "x", 20);
    await charge(ledger, "same", "x", 5, other);
    expect(val(await ledger.balance(base))).toMatchObject({ available: 50, held: 30 });
    expect(val(await ledger.balance(other))).toMatchObject({ available: 2, held: 0, totals: { granted: 7, charged: 5 } });
    expect(code(await reserve(ledger, "same", 6, 60_000, other))).toBe("IDEMPOTENCY_CONFLICT"); // تعارض فقط درون خودش
    await audit(store);
    await audit(store, other);
  });
  it("حساب‌های مختلفِ یک مستأجر هم مستقل‌اند", async () => {
    const { ledger } = setup();
    await openFunded(ledger, 100);
    await openFunded(ledger, 100, T, "acct-2");
    await reserve(ledger, "r", 60);
    expect(code(await reserve(ledger, "r", 60, 60_000, { tenantId: T, accountId: "acct-2" }))).toBe("ok");
    expect(code(await charge(ledger, "r", "x", 1, { tenantId: T, accountId: "acct-3" }))).toBe("ACCOUNT_NOT_FOUND");
  });
  it("باز کردن حسابِ هم‌نام برای مستأجر دیگر یک حساب جدا می‌سازد و به حساب اول دست نمی‌زند", async () => {
    const { ledger } = setup();
    await openFunded(ledger, 100);
    expect(val(await ledger.openAccount({ ...other, unit: "MSG" }))).toMatchObject({ unit: "MSG", replayed: false });
    expect(val(await ledger.balance(base)).unit).toBe(UNIT);
    expect(val(await ledger.balance(other)).unit).toBe("MSG");
  });
});

describe("ledger · openAccount", () => {
  it("بازتکرار با همان واحد بی‌اثر و replayed؛ واحد دیگر ⇒ IDEMPOTENCY_CONFLICT؛ موجودی دست‌نخورده", async () => {
    const { ledger } = setup();
    await openFunded(ledger, 100);
    expect(val(await ledger.openAccount({ ...base, unit: UNIT })).replayed).toBe(true);
    expect(code(await ledger.openAccount({ ...base, unit: "MSG" }))).toBe("IDEMPOTENCY_CONFLICT");
    expect(val(await ledger.balance(base)).available).toBe(100);
  });
  it("ناهمخوانی واحد در همهٔ عملیات پولی", async () => {
    const { ledger } = setup();
    await openFunded(ledger, 100);
    expect(code(await ledger.grant({ ...base, grantId: "g", unit: "MSG", amount: 1, source: "promo" }))).toBe("UNIT_MISMATCH");
    expect(code(await ledger.reserve({ ...base, reservationId: "r", unit: "MSG", amount: 1, ttlMs: 5000 }))).toBe("UNIT_MISMATCH");
  });
});

describe("ledger · یکتایی عملیات (بازتکرار و تعارض)", () => {
  it("بازتکرار هر شش عملیات: replayed با همان رسید؛ ژورنال و حالت بی‌تغییر", async () => {
    const { ledger, store } = setup();
    const ops: (() => Promise<{ ok: boolean }>)[] = [
      () => ledger.openAccount({ ...base, unit: UNIT }),
      () => ledger.grant({ ...base, grantId: "g1", unit: UNIT, amount: 500, source: "purchase" }),
      () => reserve(ledger, "r1", 300),
      () => charge(ledger, "r1", "x1", 100),
      () => ledger.refund({ ...base, refundId: "f1", reservationId: "r1", attemptId: "x1", unit: UNIT, amount: 40 }),
      () => ledger.close({ ...base, reservationId: "r1", remainder: "forfeit" }),
    ];
    for (const op of ops) {
      const first = (await op()) as { ok: true; value: object };
      expect(first.ok).toBe(true);
      const stateBefore = await store.read(base);
      const journalBefore = await store.journal(base);
      const again = (await op()) as { ok: true; value: object };
      expect(again).toEqual({ ok: true, value: { ...first.value, replayed: true } });
      expect(await store.read(base)).toEqual(stateBefore);
      expect(await store.journal(base)).toEqual(journalBefore);
    }
    await audit(store);
  });
  it("تعارض: همان شناسه با محتوای دیگر ⇒ IDEMPOTENCY_CONFLICT و بی‌اثر", async () => {
    const { ledger, store } = setup();
    await openFunded(ledger, 1000);
    await reserve(ledger, "r1", 300);
    await charge(ledger, "r1", "x1", 100);
    const snap = await store.read(base);
    expect(code(await ledger.grant({ ...base, grantId: "g-init", unit: UNIT, amount: 1, source: "purchase" }))).toBe("IDEMPOTENCY_CONFLICT");
    expect(code(await reserve(ledger, "r1", 301))).toBe("IDEMPOTENCY_CONFLICT");
    expect(code(await reserve(ledger, "r1", 300, 61_000))).toBe("IDEMPOTENCY_CONFLICT");
    expect(code(await charge(ledger, "r1", "x1", 101))).toBe("IDEMPOTENCY_CONFLICT");
    expect(await store.read(base)).toEqual(snap);
  });
  it("شکست‌ها ثبت نمی‌شوند: همان شناسه پس از اعطای اعتبار موفق می‌شود", async () => {
    const { ledger, store } = setup();
    await openFunded(ledger, 10);
    expect(code(await reserve(ledger, "r1", 50))).toBe("INSUFFICIENT_CREDIT");
    expect(code(await charge(ledger, "r1", "x1", 5))).toBe("RESERVATION_NOT_FOUND");
    await ledger.grant({ ...base, grantId: "g2", unit: UNIT, amount: 100, source: "promo" });
    expect(val(await reserve(ledger, "r1", 50)).replayed).toBe(false);
    expect(val(await charge(ledger, "r1", "x1", 5)).replayed).toBe(false);
    await audit(store);
  });
  it("کلیدهای عملیات‌های مختلف با هم برخورد نمی‌کنند (grant:r1 ≠ reserve:r1 ≠ close:r1)", async () => {
    const { ledger, store } = setup();
    val(await ledger.openAccount({ ...base, unit: UNIT }));
    val(await ledger.grant({ ...base, grantId: "same", unit: UNIT, amount: 100, source: "promo" }));
    val(await reserve(ledger, "same", 10));
    val(await ledger.close({ ...base, reservationId: "same", remainder: "release" }));
    await audit(store);
  });
});

describe("ledger · انقضا و ساعت", () => {
  it("balance انقضا را می‌بیند ولی ماندگار نمی‌کند؛ فرمان بعدی ماندگارش می‌کند", async () => {
    const { ledger, store, clock } = setup();
    await openFunded(ledger, 100);
    await reserve(ledger, "r1", 60, 5_000);
    clock.advance(4_999);
    expect(val(await ledger.balance(base))).toMatchObject({ available: 40, held: 60 });
    clock.advance(1);
    expect(val(await ledger.balance(base))).toMatchObject({ available: 100, held: 0, openReservations: 0 });
    expect((await store.read(base))?.held).toBe(60); // هنوز ماندگار نشده
    expect(code(await charge(ledger, "r1", "x", 1))).toBe("RESERVATION_EXPIRED");
    expect((await store.read(base))?.held).toBe(0); // انقضا با وجود شکست ماندگار شد
    expect(val(await ledger.journal(base)).map((e) => e.type)).toEqual(["grant", "reserve", "expire"]);
    await audit(store);
  });
  it("رزرو منقضی: close(release) موفق، close(forfeit) رد", async () => {
    const { ledger, clock } = setup();
    await openFunded(ledger, 100);
    await reserve(ledger, "r1", 60, 1_000);
    clock.advance(1_000);
    expect(code(await ledger.close({ ...base, reservationId: "r1", remainder: "forfeit" }))).toBe("RESERVATION_EXPIRED");
    expect(val(await ledger.close({ ...base, reservationId: "r1", remainder: "release" }))).toMatchObject({ released: 60, replayed: true }); // انقضا را شکستِ forfeit پیش‌تر ماندگار کرده بود
  });
  it("close(release) که خودش انقضا را ماندگار می‌کند بازتکرار نیست؛ تکرارش هست و هیچ اثری ندارد", async () => {
    const { ledger, store, clock } = setup();
    await openFunded(ledger, 100);
    await reserve(ledger, "r1", 60, 1_000);
    clock.advance(1_000);
    expect(val(await ledger.close({ ...base, reservationId: "r1", remainder: "release" }))).toMatchObject({ released: 60, replayed: false });
    const snap = await store.read(base);
    expect(val(await ledger.close({ ...base, reservationId: "r1", remainder: "release" }))).toMatchObject({ released: 60, replayed: true });
    expect(await store.read(base)).toEqual(snap);
    await audit(store);
  });
  it("منقضی‌شدن جا را برای رزروهای تازه باز می‌کند (موجودیِ گیرکرده نداریم)", async () => {
    const { ledger, clock } = setup();
    await openFunded(ledger, 100);
    await reserve(ledger, "r1", 100, 1_000);
    expect(code(await reserve(ledger, "r2", 100))).toBe("INSUFFICIENT_CREDIT");
    clock.advance(1_000);
    expect(code(await reserve(ledger, "r2", 100))).toBe("ok");
  });
  it("ساعتِ عقب‌رفته رزرو را زنده نگه نمی‌دارد", async () => {
    const { ledger, clock } = setup();
    await openFunded(ledger, 100);
    await reserve(ledger, "r1", 50, 1_000);
    clock.advance(2_000);
    await ledger.grant({ ...base, grantId: "tick", unit: UNIT, amount: 1, source: "promo" });
    clock.advance(-1_500); // ماشین دیگر با ساعت عقب
    expect(code(await charge(ledger, "r1", "x", 1))).toBe("RESERVATION_EXPIRED");
    expect(val(await ledger.balance(base)).asOfMs).toBe(1_000_000 + 2_000);
  });
  it("ساعت نامعتبر یا پرتاب‌کننده ⇒ INTERNAL_ERROR بی‌اثر؛ پس از درست‌شدن ساعت همه‌چیز کار می‌کند", async () => {
    const { ledger, store, clock } = setup();
    await openFunded(ledger, 100);
    const snap = await store.read(base);
    const real = clock.nowMs;
    for (const bad of [() => Number.NaN, () => -1, () => 1.5, () => Number.POSITIVE_INFINITY, () => { throw new Error("clock down"); }]) {
      (clock as { nowMs: () => number }).nowMs = bad;
      expect(code(await reserve(ledger, "r1", 10))).toBe("INTERNAL_ERROR");
      expect(code(await ledger.balance(base))).toBe("INTERNAL_ERROR");
      expect(code(await ledger.journal(base))).toBe("INTERNAL_ERROR");
    }
    (clock as { nowMs: () => number }).nowMs = real;
    expect(await store.read(base)).toEqual(snap);
    expect(code(await reserve(ledger, "r1", 10))).toBe("ok");
  });
});

describe("ledger · ورودی نامعتبر روی مرز سرویس", () => {
  it("هیچ متدی نمی‌پرتابد و هیچ حسابی ساخته/عوض نمی‌شود", async () => {
    const { ledger, store } = setup();
    const garbage: unknown[] = [null, undefined, 5, "x", [], {}, { tenantId: "t" }, { ...base, unit: UNIT, amount: Number.NaN }, { ...base, extra: 1, unit: UNIT }];
    const methods = ["openAccount", "grant", "reserve", "charge", "close", "refund", "balance", "journal"] as const;
    for (const m of methods) {
      for (const g of garbage) {
        const r = await (ledger[m] as (x: unknown) => Promise<{ ok: boolean; error?: { code: string } }>)(g);
        expect(r.ok, `${m} ${JSON.stringify(g)}`).toBe(false);
        expect(r.error?.code).toBe("INVALID_INPUT");
      }
    }
    expect(await store.read(base)).toBeNull();
  });
  it("getter پرتاب‌کننده ⇒ INVALID_INPUT", async () => {
    const { ledger } = setup();
    const input = { ...base, unit: UNIT, amount: 5, source: "promo" } as Record<string, unknown>;
    Object.defineProperty(input, "grantId", { enumerable: true, get() { throw new Error("boom"); } });
    expect(code(await ledger.grant(input as never))).toBe("INVALID_INPUT");
  });
  it("پیام خطا هرگز مقدار ورودی را پژواک نمی‌کند", async () => {
    const { ledger } = setup();
    const r = await ledger.openAccount({ ...base, unit: "secret-unit!" as never });
    expect(!r.ok && r.error.message).not.toContain("secret");
  });
});

describe("ledger · شکست ذخیره", () => {
  const flaky = (inner: AccountStore, mode: "before" | "after" | "read" | "journal", failTimes = 1): AccountStore => {
    let left = failTimes;
    const boom = (): void => {
      if (left > 0) {
        left -= 1;
        throw new Error("db down: LEAK_MARKER_7f3a");
      }
    };
    return {
      async transact(k, fn) {
        if (mode === "before") boom();
        const v = await inner.transact(k, fn);
        if (mode === "after") boom();
        return v;
      },
      async read(k) {
        if (mode === "read") boom();
        return inner.read(k);
      },
      async journal(k) {
        if (mode === "journal") boom();
        return inner.journal(k);
      },
    };
  };
  it("پرتاب پیش از commit ⇒ STORE_FAILURE بی‌اثر و پیام بی‌نشت؛ تکرار موفق می‌شود", async () => {
    const inner = createMemoryStore();
    const { ledger } = setup(flaky(inner, "before"));
    const r = await ledger.openAccount({ ...base, unit: UNIT });
    expect(!r.ok && r.error.code).toBe("STORE_FAILURE");
    expect(!r.ok && r.error.message).not.toMatch(/LEAK_MARKER|db down/); // پیام ذخیره هرگز به خروجی نشت نمی‌کند
    expect(await inner.read(base)).toBeNull();
    expect(code(await ledger.openAccount({ ...base, unit: UNIT }))).toBe("ok");
  });
  it("پرتاب پس از commit (نتیجه نامعلوم) ⇒ STORE_FAILURE؛ تکرار با همان شناسه replayed است و دوبار نمی‌شمارد", async () => {
    const inner = createMemoryStore();
    const { ledger } = setup(inner);
    await openFunded(ledger, 100);
    const { ledger: flakyLedger } = setup(flaky(inner, "after"), mutableClock());
    expect(code(await flakyLedger.reserve({ ...base, reservationId: "r1", unit: UNIT, amount: 40, ttlMs: 60_000 }))).toBe("STORE_FAILURE");
    expect((await inner.read(base))?.held).toBe(40); // commit شده بود
    const retry = val(await flakyLedger.reserve({ ...base, reservationId: "r1", unit: UNIT, amount: 40, ttlMs: 60_000 }));
    expect(retry.replayed).toBe(true);
    expect((await inner.read(base))?.held).toBe(40);
    await audit(inner);
  });
  it("پرتاب هنگام خواندن (balance/journal) ⇒ STORE_FAILURE", async () => {
    const inner = createMemoryStore();
    await openFunded(setup(inner).ledger, 10);
    expect(code(await setup(flaky(inner, "read")).ledger.balance(base))).toBe("STORE_FAILURE");
    expect(code(await setup(flaky(inner, "read")).ledger.journal(base))).toBe("STORE_FAILURE");
    expect(code(await setup(flaky(inner, "journal")).ledger.journal(base))).toBe("STORE_FAILURE");
  });
});

describe("ledger · بی‌نوشتنِ بی‌اثر (commit: null)", () => {
  it("بازتکرار، شکستِ بی‌انقضا و خطای اعتبارسنجی هیچ commit نمی‌نویسند؛ فقط تغییرِ واقعی (و انقضای ماندگار) می‌نویسد", async () => {
    const inner = createMemoryStore();
    const commits: boolean[] = [];
    const spy: AccountStore = {
      ...inner,
      transact: (k, fn) =>
        inner.transact(k, (cur) => {
          const out = fn(cur);
          commits.push(out.commit !== null);
          return out;
        }),
    };
    const { ledger, clock } = setup(spy);
    const last = (): boolean | undefined => commits[commits.length - 1];
    await ledger.openAccount({ ...base, unit: UNIT });
    expect(last()).toBe(true);
    await ledger.openAccount({ ...base, unit: UNIT }); // بازتکرار
    expect(last()).toBe(false);
    await ledger.grant({ ...base, grantId: "g", unit: UNIT, amount: 10, source: "promo" });
    expect(last()).toBe(true);
    await ledger.grant({ ...base, grantId: "g", unit: UNIT, amount: 10, source: "promo" }); // بازتکرار
    expect(last()).toBe(false);
    await ledger.grant({ ...base, grantId: "g", unit: UNIT, amount: 11, source: "promo" }); // تعارض
    expect(last()).toBe(false);
    await reserve(ledger, "r", 999); // INSUFFICIENT_CREDIT بی‌انقضا
    expect(last()).toBe(false);
    await ledger.openAccount({ tenantId: "other", accountId: "x", unit: UNIT });
    await charge(ledger, "r", "x", 1, { tenantId: "other", accountId: "none" }); // حساب نامعلوم
    expect(last()).toBe(false);
    await reserve(ledger, "r", 5, 1_000);
    expect(last()).toBe(true);
    clock.advance(1_000);
    await reserve(ledger, "r2", 999); // شکستی که انقضا را ماندگار می‌کند ⇒ commit دارد
    expect(last()).toBe(true);
    await ledger.balance(base);
    expect(commits.length).toBe(10); // balance اصلاً transact نمی‌کند
  });
});

describe("ledger · همزمانی", () => {
  it("۵۰ رزرو موازی با مبلغ ۱۰۰ روی موجودی ۱۰۰۰ ⇒ دقیقاً ۱۰ موفق", async () => {
    const { ledger, store } = setup();
    await openFunded(ledger, 1000);
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => reserve(ledger, `r${i}`, 100)));
    expect(rs.filter((r) => r.ok)).toHaveLength(10);
    expect(rs.filter((r) => !r.ok && r.error.code === "INSUFFICIENT_CREDIT")).toHaveLength(40);
    expect(val(await ledger.balance(base))).toMatchObject({ available: 0, held: 1000, openReservations: 10 });
    await audit(store);
  });
  it("۲۰ بار همان reservationId به‌صورت موازی ⇒ یک اثر و ۱۹ بازتکرار", async () => {
    const { ledger, store } = setup();
    await openFunded(ledger, 1000);
    const rs = await Promise.all(Array.from({ length: 20 }, () => reserve(ledger, "same", 100)));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(rs.filter((r) => r.ok && !r.value.replayed)).toHaveLength(1);
    expect(val(await ledger.balance(base)).held).toBe(100);
    await audit(store);
  });
  it("مصرف موازیِ تلاش‌ها: مجموع هرگز از رزرو بیشتر نمی‌شود و کسری دقیق است", async () => {
    const { ledger, store } = setup();
    await openFunded(ledger, 1000);
    await reserve(ledger, "r", 100);
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => charge(ledger, "r", `x${i}`, 15)));
    const charged = rs.reduce((n, r) => n + val(r).charged, 0);
    const shortfall = rs.reduce((n, r) => n + val(r).shortfall, 0);
    expect(charged).toBe(100);
    expect(shortfall).toBe(12 * 15 - 100);
    await audit(store);
  });
  it("عملیات موازی روی حساب‌های جدا مستقل‌اند", async () => {
    const { ledger, store } = setup();
    await Promise.all(Array.from({ length: 6 }, (_, i) => openFunded(ledger, 100, `t${i}`, A)));
    await Promise.all(Array.from({ length: 6 }, (_, i) => reserve(ledger, "r", 10 * (i + 1), 60_000, { tenantId: `t${i}`, accountId: A })));
    for (let i = 0; i < 6; i++) {
      expect(val(await ledger.balance({ tenantId: `t${i}`, accountId: A }))).toMatchObject({ held: 10 * (i + 1) });
      await audit(store, { tenantId: `t${i}`, accountId: A });
    }
  });
});

describe("ledger · رسیدها و خروجی‌ها", () => {
  it("رسیدها، ژورنال و موجودی منجمدند و ماندگار را عوض نمی‌کنند", async () => {
    const { ledger, store } = setup();
    await openFunded(ledger, 100);
    const r = val(await reserve(ledger, "r", 10));
    expect(Object.isFrozen(r)).toBe(true);
    const j = val(await ledger.journal(base));
    expect(Object.isFrozen(j)).toBe(true);
    expect(() => (j as unknown as { seq: number }[]).push({ seq: 99 })).toThrow();
    expect(Object.isFrozen(val(await ledger.balance(base)))).toBe(true);
    await audit(store);
  });
  it("journal حساب بی‌ورودی تهی است", async () => {
    const { ledger } = setup();
    val(await ledger.openAccount({ ...base, unit: UNIT }));
    expect(val(await ledger.journal(base))).toEqual([]);
  });
  it("شناسه‌هایی هم‌نام با ویژگی‌های Object.prototype از طریق سرویس هم عادی‌اند", async () => {
    const { ledger, store } = setup();
    await openFunded(ledger, 100, "constructor", "toString");
    const b = { tenantId: "constructor", accountId: "toString" };
    expect(code(await reserve(ledger, "hasOwnProperty", 5, 60_000, b))).toBe("ok");
    expect(code(await charge(ledger, "hasOwnProperty", "valueOf", 5, b))).toBe("ok");
    expect(code(await charge(ledger, "constructor", "x", 5, b))).toBe("RESERVATION_NOT_FOUND");
    await audit(store, b);
  });
});
