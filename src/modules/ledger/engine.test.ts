import { describe, expect, it } from "vitest";
import { LIMITS, applyCommand, checkInvariants, parseCommand, viewAt } from "./index";
import { UNIT, deepFreeze, errCode, fundedState, must, mustState, run } from "./test-kit";

const T0 = 10_000;
const reserve = (s: ReturnType<typeof fundedState>, id: string, amount: number, at = T0, ttlMs = 5_000) => run(s, "reserve", { reservationId: id, unit: UNIT, amount, ttlMs }, at);
const charge = (s: ReturnType<typeof fundedState>, id: string, attempt: string, amount: number, at = T0) => run(s, "charge", { reservationId: id, attemptId: attempt, unit: UNIT, amount }, at);

describe("ledger/engine · open", () => {
  it("حساب تازه صفر است و بی‌ورودی ژورنال", () => {
    const o = must(run(null, "open", { unit: UNIT }, 5));
    expect(o.replayed).toBe(false);
    expect(o.changed).toBe(true);
    expect(o.entries).toEqual([]);
    expect(o.state).toMatchObject({ tenantId: "tenant-a", accountId: "acct-1", unit: UNIT, available: 0, held: 0, seq: 0, createdAtMs: 5, lastAtMs: 5 });
    expect(o.receipt).toEqual({ kind: "open", accountId: "acct-1", unit: UNIT });
    expect(checkInvariants(o.state)).toEqual([]);
  });
  it("بازتکرار با همان واحد ⇒ replayed و بی‌تغییر؛ واحد دیگر ⇒ IDEMPOTENCY_CONFLICT", () => {
    const s = fundedState(100);
    const again = must(run(s, "open", { unit: UNIT }, 99));
    expect(again.replayed).toBe(true);
    expect(again.changed).toBe(false);
    expect(again.state).toEqual(s);
    expect(errCode(run(s, "open", { unit: "MSG" }, 99))).toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("ledger/engine · حساب نامعلوم و ناهمخوان", () => {
  it("فرمان غیر open روی حالت null ⇒ ACCOUNT_NOT_FOUND و بی‌تغییر", () => {
    const o = run(null, "grant", { grantId: "g", unit: UNIT, amount: 1, source: "promo" }, T0);
    expect(errCode(o)).toBe("ACCOUNT_NOT_FOUND");
    expect(o.changed).toBe(false);
  });
  it("حالتِ متعلق به مستأجر/حساب دیگر هرگز استفاده نمی‌شود (دفاع در برابر باگ ذخیره)", () => {
    const s = fundedState(100);
    const other = parseCommand("grant", { tenantId: "tenant-b", accountId: "acct-1", grantId: "g", unit: UNIT, amount: 1, source: "promo" });
    const other2 = parseCommand("grant", { tenantId: "tenant-a", accountId: "acct-2", grantId: "g", unit: UNIT, amount: 1, source: "promo" });
    for (const c of [other, other2]) {
      if (!c.ok) throw new Error("bad");
      const o = applyCommand(s, c.value, T0);
      expect(o.ok ? "ok" : o.error.code).toBe("ACCOUNT_NOT_FOUND");
      expect(o.state).toBeNull(); // حتی وجود حالت را نشت نمی‌دهد
    }
  });
  it("ناهمخوانی واحد در هر چهار فرمان پولی ⇒ UNIT_MISMATCH بی‌اثر", () => {
    let s = fundedState(100);
    s = mustState(reserve(s, "r1", 10));
    s = mustState(charge(s, "r1", "x1", 5));
    const before = structuredClone(s);
    const cases: [string, Record<string, unknown>][] = [
      ["grant", { grantId: "g9", unit: "MSG", amount: 1, source: "promo" }],
      ["reserve", { reservationId: "r9", unit: "MSG", amount: 1, ttlMs: 5000 }],
      ["charge", { reservationId: "r1", attemptId: "x9", unit: "MSG", amount: 1 }],
      ["refund", { refundId: "f9", reservationId: "r1", attemptId: "x1", unit: "MSG", amount: 1 }],
    ];
    for (const [k, f] of cases) {
      const o = run(s, k as "grant", f, T0);
      expect(errCode(o), k).toBe("UNIT_MISMATCH");
      expect(o.changed).toBe(false);
    }
    expect(s).toEqual(before);
  });
  it("زمان نامعتبر ⇒ INTERNAL_ERROR بی‌اثر", () => {
    const s = fundedState(10);
    for (const at of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      const o = run(s, "grant", { grantId: "g2", unit: UNIT, amount: 1, source: "promo" }, at);
      expect(errCode(o)).toBe("INTERNAL_ERROR");
      expect(o.changed).toBe(false);
    }
  });
});

describe("ledger/engine · grant", () => {
  it("افزایش موجودی، ورودی ژورنال و رسید", () => {
    const s = fundedState(0);
    const o = must(run(s, "grant", { grantId: "g1", unit: UNIT, amount: 70, source: "purchase" }, T0));
    expect(o.state.available).toBe(70);
    expect(o.state.totals.granted).toBe(70);
    expect(o.receipt).toEqual({ kind: "grant", grantId: "g1", amount: 70, availableAfter: 70 });
    expect(o.entries).toEqual([{ seq: 1, atMs: T0, type: "grant", amount: 70, shortfall: 0, reservationId: null, attemptId: null, refId: "g1", availableAfter: 70, heldAfter: 0 }]);
  });
  it("سرریز ⇒ OVERFLOW و بی‌تغییر؛ دقیقاً تا سقف مجاز", () => {
    const s = mustState(run(fundedState(0), "grant", { grantId: "gmax", unit: UNIT, amount: Number.MAX_SAFE_INTEGER, source: "adjustment" }, T0));
    expect(s.available).toBe(Number.MAX_SAFE_INTEGER);
    expect(checkInvariants(s)).toEqual([]);
    const o = run(s, "grant", { grantId: "g1", unit: UNIT, amount: 1, source: "adjustment" }, T0);
    expect(errCode(o)).toBe("OVERFLOW");
    expect(o.changed).toBe(false);
  });
  it("سرریزِ جمعِ کل اعطاها حتی وقتی موجودی کم است (اعتبار مصرف‌شده هم در granted می‌ماند)", () => {
    let s = mustState(run(fundedState(0), "grant", { grantId: "a", unit: UNIT, amount: Number.MAX_SAFE_INTEGER, source: "purchase" }, T0));
    s = mustState(reserve(s, "r", Number.MAX_SAFE_INTEGER));
    s = mustState(charge(s, "r", "x", Number.MAX_SAFE_INTEGER));
    expect(s.available).toBe(0);
    expect(errCode(run(s, "grant", { grantId: "b", unit: UNIT, amount: 1, source: "purchase" }, T0))).toBe("OVERFLOW");
  });
  it("بازتکرار/تعارض بر پایهٔ grantId؛ مبلغ و منبع بخشی از محتوا هستند", () => {
    const s = fundedState(0);
    const a = mustState(run(s, "grant", { grantId: "g1", unit: UNIT, amount: 5, source: "promo" }, T0));
    const rep = must(run(a, "grant", { grantId: "g1", unit: UNIT, amount: 5, source: "promo" }, T0 + 1));
    expect(rep.replayed).toBe(true);
    expect(rep.state).toEqual(a);
    expect(rep.entries).toEqual([]);
    expect(errCode(run(a, "grant", { grantId: "g1", unit: UNIT, amount: 6, source: "promo" }, T0))).toBe("IDEMPOTENCY_CONFLICT");
    expect(errCode(run(a, "grant", { grantId: "g1", unit: UNIT, amount: 5, source: "purchase" }, T0))).toBe("IDEMPOTENCY_CONFLICT");
  });
});

describe("ledger/engine · reserve", () => {
  it("از موجودی به held می‌رود و سررسید = زمان + ttl", () => {
    const o = must(reserve(fundedState(100), "r1", 30, T0, 7_000));
    expect(o.state.available).toBe(70);
    expect(o.state.held).toBe(30);
    expect(o.receipt).toEqual({ kind: "reserve", reservationId: "r1", amount: 30, expiresAtMs: T0 + 7_000, availableAfter: 70, heldAfter: 30 });
    expect(o.state.reservations["r1"]).toMatchObject({ amount: 30, remaining: 30, status: "open", expiresAtMs: T0 + 7_000, closedBy: null });
    expect(checkInvariants(o.state)).toEqual([]);
  });
  it("دقیقاً برابر موجودی مجاز؛ یکی بیشتر ⇒ INSUFFICIENT_CREDIT بی‌اثر", () => {
    expect(must(reserve(fundedState(100), "r1", 100)).state.available).toBe(0);
    const o = reserve(fundedState(100), "r1", 101);
    expect(errCode(o)).toBe("INSUFFICIENT_CREDIT");
    expect(o.changed).toBe(false);
  });
  it("شکست کلید یکتایی نمی‌سازد: پس از grant همان reservationId موفق می‌شود", () => {
    const s = fundedState(10);
    expect(errCode(reserve(s, "r1", 50))).toBe("INSUFFICIENT_CREDIT");
    const s2 = mustState(run(s, "grant", { grantId: "g2", unit: UNIT, amount: 100, source: "purchase" }, T0));
    expect(must(reserve(s2, "r1", 50)).replayed).toBe(false);
  });
  it("بازتکرار همان رزرو (حتی با ساعت دیرتر) رسید اصلی را می‌دهد و دوباره نگه نمی‌دارد", () => {
    const first = must(reserve(fundedState(100), "r1", 30));
    const again = must(reserve(first.state, "r1", 30, T0 + 3_000));
    expect(again.replayed).toBe(true);
    expect(again.receipt).toEqual(first.receipt);
    expect(again.state.held).toBe(30);
    expect(errCode(reserve(first.state, "r1", 31))).toBe("IDEMPOTENCY_CONFLICT");
    expect(errCode(reserve(first.state, "r1", 30, T0, 6_000))).toBe("IDEMPOTENCY_CONFLICT");
  });
  it("سقف رزروهای باز؛ بستن یکی جا باز می‌کند", () => {
    let s = fundedState(LIMITS.MAX_OPEN_RESERVATIONS + 10);
    for (let i = 0; i < LIMITS.MAX_OPEN_RESERVATIONS; i++) s = mustState(reserve(s, `r${i}`, 1));
    expect(errCode(reserve(s, "extra", 1))).toBe("TOO_MANY_OPEN_RESERVATIONS");
    s = mustState(run(s, "close", { reservationId: "r0", remainder: "release" }, T0));
    expect(must(reserve(s, "extra", 1)).state.held).toBe(LIMITS.MAX_OPEN_RESERVATIONS);
  });
  it("سرریز سررسید ⇒ OVERFLOW", () => {
    const s = fundedState(10);
    const o = reserve(s, "r1", 1, Number.MAX_SAFE_INTEGER - 10, 5_000);
    expect(errCode(o)).toBe("OVERFLOW");
  });
  it("شناسه‌هایی که با ویژگی‌های Object.prototype هم‌نام‌اند عادی کار می‌کنند", () => {
    let s = fundedState(100);
    for (const id of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      s = mustState(reserve(s, id, 5));
      s = mustState(charge(s, id, "constructor", 2));
    }
    expect(Object.keys(s.reservations).sort()).toEqual(["constructor", "hasOwnProperty", "toString", "valueOf"]);
    expect(checkInvariants(s)).toEqual([]);
    expect(errCode(charge(s, "nope", "x", 1))).toBe("RESERVATION_NOT_FOUND");
  });
});

describe("ledger/engine · charge (به ازای هر تلاش)", () => {
  const withRes = () => mustState(reserve(fundedState(1000), "r1", 600));
  it("مصرف جزئی: held کم و totals زیاد می‌شود؛ رزرو باز می‌ماند", () => {
    const o = must(charge(withRes(), "r1", "x1", 250));
    expect(o.receipt).toEqual({ kind: "charge", reservationId: "r1", attemptId: "x1", requested: 250, charged: 250, shortfall: 0, remainingHold: 350 });
    expect(o.state).toMatchObject({ available: 400, held: 350 });
    expect(o.state.totals.charged).toBe(250);
    expect(o.state.reservations["r1"]?.status).toBe("open");
    expect(checkInvariants(o.state)).toEqual([]);
  });
  it("دو تلاش با یک reservationId و attemptId متفاوت: هر دو شمرده می‌شوند (ADR-0017)", () => {
    let s = mustState(charge(withRes(), "r1", "attempt-1", 100));
    s = mustState(charge(s, "r1", "attempt-2", 150));
    expect(s.totals.charged).toBe(250);
    expect(s.held).toBe(350);
    expect(Object.keys(s.reservations["r1"]?.attempts ?? {})).toEqual(["attempt-1", "attempt-2"]);
  });
  it("بازتکرار یک تلاش دوباره نمی‌شمارد؛ مبلغ دیگر ⇒ IDEMPOTENCY_CONFLICT", () => {
    const s = mustState(charge(withRes(), "r1", "x1", 100));
    const rep = must(charge(s, "r1", "x1", 100, T0 + 100));
    expect(rep.replayed).toBe(true);
    expect(rep.state).toEqual(s);
    expect(rep.entries).toEqual([]);
    expect(errCode(charge(s, "r1", "x1", 101))).toBe("IDEMPOTENCY_CONFLICT");
    expect(errCode(charge(s, "r1", "x1", 99))).toBe("IDEMPOTENCY_CONFLICT");
  });
  it("مصرف بیش از باقیمانده: کسری ثبت می‌شود و موجودی هرگز منفی نمی‌شود", () => {
    let s = mustState(reserve(fundedState(100), "r1", 40));
    const o = must(charge(s, "r1", "x1", 70));
    s = o.state;
    expect(o.receipt).toMatchObject({ requested: 70, charged: 40, shortfall: 30, remainingHold: 0 });
    expect(s).toMatchObject({ available: 60, held: 0 });
    expect(s.totals).toMatchObject({ charged: 40, shortfall: 30 });
    expect(o.entries[0]).toMatchObject({ type: "charge", amount: 40, shortfall: 30 });
    const second = must(charge(s, "r1", "x2", 5));
    expect(second.receipt).toMatchObject({ charged: 0, shortfall: 5 });
    expect(second.state.available).toBe(60);
    expect(checkInvariants(second.state)).toEqual([]);
  });
  it("مبلغ صفر مجاز و ثبت‌شده است (کلید یکتایی می‌سازد)", () => {
    const o = must(charge(withRes(), "r1", "free", 0));
    expect(o.receipt).toMatchObject({ charged: 0, shortfall: 0, remainingHold: 600 });
    expect(must(charge(o.state, "r1", "free", 0)).replayed).toBe(true);
    expect(errCode(charge(o.state, "r1", "free", 1))).toBe("IDEMPOTENCY_CONFLICT");
  });
  it("رزرو نامعلوم؛ رزرو بسته؛ رزرو منقضی", () => {
    const s = withRes();
    expect(errCode(charge(s, "nope", "x", 1))).toBe("RESERVATION_NOT_FOUND");
    const closed = mustState(run(s, "close", { reservationId: "r1", remainder: "release" }, T0));
    expect(errCode(charge(closed, "r1", "x", 1))).toBe("RESERVATION_CLOSED");
    const o = charge(s, "r1", "x", 1, T0 + 5_000);
    expect(errCode(o)).toBe("RESERVATION_EXPIRED");
    expect(o.changed).toBe(true); // انقضای تنبل ماندگار می‌شود
    expect(o.state?.available).toBe(1000);
  });
  it("سقف تلاش‌های هر رزرو", () => {
    let s = withRes();
    for (let i = 0; i < LIMITS.MAX_ATTEMPTS_PER_RESERVATION; i++) s = mustState(charge(s, "r1", `x${i}`, 1));
    expect(errCode(charge(s, "r1", "x-extra", 1))).toBe("TOO_MANY_ATTEMPTS");
    expect(must(charge(s, "r1", "x0", 1)).replayed).toBe(true); // بازتکرارِ تلاشِ موجود همچنان کار می‌کند
  });
  it("سرریز جمع مصرف ⇒ OVERFLOW", () => {
    // ناوردا اجازهٔ سرریزِ واقعی نمی‌دهد؛ حالتِ دست‌ساز ولی ناسازگار نشان می‌دهد نگهبان وجود دارد.
    const s = withRes();
    s.totals.charged = Number.MAX_SAFE_INTEGER;
    expect(errCode(charge(s, "r1", "x", 1))).toBe("OVERFLOW");
  });
});

describe("ledger/engine · close", () => {
  const withCharge = () => mustState(charge(mustState(reserve(fundedState(1000), "r1", 600)), "r1", "x1", 250));
  it("release: باقیمانده برمی‌گردد", () => {
    const o = must(run(withCharge(), "close", { reservationId: "r1", remainder: "release" }, T0));
    expect(o.receipt).toEqual({ kind: "close", reservationId: "r1", remainder: "release", released: 350, forfeited: 0 });
    expect(o.state).toMatchObject({ available: 750, held: 0 });
    expect(o.state.reservations["r1"]).toMatchObject({ status: "closed", closedBy: "release", closedAmount: 350, remaining: 0, closedAtMs: T0 });
    expect(o.entries[0]).toMatchObject({ type: "release", amount: 350 });
    expect(checkInvariants(o.state)).toEqual([]);
  });
  it("forfeit: باقیمانده صریحاً مصرف‌شده ثبت می‌شود و به موجودی برنمی‌گردد", () => {
    const o = must(run(withCharge(), "close", { reservationId: "r1", remainder: "forfeit" }, T0));
    expect(o.receipt).toEqual({ kind: "close", reservationId: "r1", remainder: "forfeit", released: 0, forfeited: 350 });
    expect(o.state).toMatchObject({ available: 400, held: 0 });
    expect(o.state.totals.forfeited).toBe(350);
    expect(o.entries[0]).toMatchObject({ type: "forfeit", amount: 350 });
    expect(checkInvariants(o.state)).toEqual([]);
  });
  it("بازتکرار همان حالت ⇒ replayed؛ حالت دیگر ⇒ IDEMPOTENCY_CONFLICT", () => {
    for (const [a, b] of [["release", "forfeit"], ["forfeit", "release"]] as const) {
      const s = mustState(run(withCharge(), "close", { reservationId: "r1", remainder: a }, T0));
      const rep = must(run(s, "close", { reservationId: "r1", remainder: a }, T0 + 1));
      expect(rep.replayed).toBe(true);
      expect(rep.state).toEqual(s);
      expect(errCode(run(s, "close", { reservationId: "r1", remainder: b }, T0))).toBe("IDEMPOTENCY_CONFLICT");
    }
  });
  it("رزرو بی‌باقیمانده با ۰ بسته می‌شود؛ رزرو نامعلوم رد می‌شود", () => {
    const s = mustState(charge(mustState(reserve(fundedState(100), "r1", 50)), "r1", "x", 50));
    const o = must(run(s, "close", { reservationId: "r1", remainder: "forfeit" }, T0));
    expect(o.receipt).toMatchObject({ released: 0, forfeited: 0 });
    expect(errCode(run(s, "close", { reservationId: "zz", remainder: "release" }, T0))).toBe("RESERVATION_NOT_FOUND");
  });
  it("پس از انقضا: close(release) ⇒ موفق و replayed با مبلغ آزادشده؛ close(forfeit) ⇒ RESERVATION_EXPIRED", () => {
    const s = withCharge();
    const rel = must(run(s, "close", { reservationId: "r1", remainder: "release" }, T0 + 5_000));
    expect(rel.replayed).toBe(false); // انقضا همین فراخوانی رخ داد ⇒ اثر داشت، پس بازتکرار نیست
    expect(rel.receipt).toMatchObject({ released: 350, forfeited: 0 });
    expect(rel.state.available).toBe(750);
    expect(rel.changed).toBe(true);
    const again = must(run(rel.state, "close", { reservationId: "r1", remainder: "release" }, T0 + 9_000));
    expect(again.replayed).toBe(true); // ناوردا: replayed ⇒ changed=false
    expect(again.changed).toBe(false);
    expect(again.entries).toEqual([]);
    const lateFirst = must(run(must(run(s, "grant", { grantId: "tick", unit: UNIT, amount: 1, source: "promo" }, T0 + 5_000)).state, "close", { reservationId: "r1", remainder: "release" }, T0 + 6_000));
    expect(lateFirst.replayed).toBe(true); // انقضا پیش‌تر ماندگار شده بود
    expect(lateFirst.changed).toBe(false);
    const forf = run(s, "close", { reservationId: "r1", remainder: "forfeit" }, T0 + 5_000);
    expect(errCode(forf)).toBe("RESERVATION_EXPIRED");
    expect(forf.state?.available).toBe(750); // آزادسازی انقضا بی‌صدا مصرف نشد
  });
});

describe("ledger/engine · بازتکرار = no-op محض", () => {
  it("بازتکرارِ close روی رزروِ از‌پیش‌منقضی‌شده حتی اگر رزروِ دیگری همین لحظه منقضی شود بی‌اثر است (انقضای دیگری به فرمان بعدی می‌ماند)", () => {
    let s = mustState(reserve(fundedState(100), "a", 10, T0, 1_000));
    s = mustState(reserve(s, "b", 10, T0, 3_000));
    s = mustState(run(s, "grant", { grantId: "tick", unit: UNIT, amount: 1, source: "promo" }, T0 + 1_000)); // a منقضی و ماندگار شد
    expect(s.reservations["a"]?.closedBy).toBe("expiry");
    expect(s.reservations["b"]?.status).toBe("open");
    const o = must(run(s, "close", { reservationId: "a", remainder: "release" }, T0 + 3_000)); // b همین لحظه منقضی می‌شد
    expect(o.replayed).toBe(true);
    expect(o.changed).toBe(false);
    expect(o.entries).toEqual([]);
    expect(o.state).toEqual(s);
    expect(o.state.reservations["b"]?.status).toBe("open");
  });
});

describe("ledger/engine · refund", () => {
  const charged = () => mustState(charge(mustState(reserve(fundedState(1000), "r1", 600)), "r1", "x1", 200));
  const refund = (s: ReturnType<typeof fundedState>, id: string, amount: number, attempt = "x1") => run(s, "refund", { refundId: id, reservationId: "r1", attemptId: attempt, unit: UNIT, amount }, T0);
  it("بازگشت جزئی و تجمعی تا سقف مصرف همان تلاش", () => {
    let s = mustState(refund(charged(), "f1", 150));
    expect(s.available).toBe(550);
    expect(s.totals.refunded).toBe(150);
    expect(s.reservations["r1"]?.attempts["x1"]?.refunded).toBe(150);
    const bad = refund(s, "f2", 51);
    expect(errCode(bad)).toBe("REFUND_EXCEEDS_CHARGE");
    expect(bad.changed).toBe(false);
    s = mustState(refund(s, "f2", 50));
    expect(errCode(refund(s, "f3", 1))).toBe("REFUND_EXCEEDS_CHARGE");
    expect(checkInvariants(s)).toEqual([]);
  });
  it("روی رزرو بسته هم ممکن است (مصرف پس از بستن بازگردانده می‌شود)", () => {
    const s = mustState(run(charged(), "close", { reservationId: "r1", remainder: "release" }, T0));
    expect(must(refund(s, "f1", 200)).state.available).toBe(1000);
  });
  it("تلاش یا رزرو ناموجود؛ تلاشِ بی‌مصرف؛ مصرفِ کسری‌خورده فقط تا مقدار واقعاً مصرف‌شده", () => {
    const s = charged();
    expect(errCode(refund(s, "f", 1, "nope"))).toBe("CHARGE_NOT_FOUND");
    expect(errCode(run(s, "refund", { refundId: "f", reservationId: "zz", attemptId: "x1", unit: UNIT, amount: 1 }, T0))).toBe("RESERVATION_NOT_FOUND");
    const s2 = mustState(charge(s, "r1", "free", 0));
    expect(errCode(refund(s2, "f", 1, "free"))).toBe("REFUND_EXCEEDS_CHARGE");
    const s3 = mustState(charge(mustState(reserve(fundedState(100), "r9", 10)), "r9", "x", 25)); // مصرف ۱۰، کسری ۱۵
    expect(errCode(run(s3, "refund", { refundId: "f", reservationId: "r9", attemptId: "x", unit: UNIT, amount: 11 }, T0))).toBe("REFUND_EXCEEDS_CHARGE");
    expect(must(run(s3, "refund", { refundId: "f", reservationId: "r9", attemptId: "x", unit: UNIT, amount: 10 }, T0)).state.available).toBe(100);
  });
  it("بازتکرار و تعارض بر پایهٔ refundId (رزرو/تلاش/مبلغ بخشی از محتوا)", () => {
    const s = mustState(refund(charged(), "f1", 100));
    const rep = must(refund(s, "f1", 100));
    expect(rep.replayed).toBe(true);
    expect(rep.state).toEqual(s);
    expect(errCode(refund(s, "f1", 99))).toBe("IDEMPOTENCY_CONFLICT");
    expect(errCode(refund(s, "f1", 100, "other"))).toBe("IDEMPOTENCY_CONFLICT");
  });
  it("سرریز ⇒ OVERFLOW", () => {
    const s = charged();
    s.totals.refunded = Number.MAX_SAFE_INTEGER;
    expect(errCode(refund(s, "f1", 1))).toBe("OVERFLOW");
  });
});

describe("ledger/engine · انقضای تنبل و ساعت یکنوا", () => {
  it("رزروهای سررسیدشده پیش از فرمان بعدی آزاد می‌شوند (به ترتیب سررسید سپس شناسه) و جا برای رزرو تازه باز می‌شود", () => {
    let s = fundedState(100);
    s = mustState(reserve(s, "rb", 40, T0, 2_000));
    s = mustState(reserve(s, "ra", 40, T0, 2_000));
    s = mustState(reserve(s, "rc", 10, T0, 9_000));
    expect(errCode(reserve(s, "big", 60, T0 + 1_999))).toBe("INSUFFICIENT_CREDIT");
    const o = must(reserve(s, "big", 60, T0 + 2_000));
    expect(o.entries.map((e) => [e.type, e.reservationId])).toEqual([["expire", "ra"], ["expire", "rb"], ["reserve", "big"]]);
    expect(o.state.reservations["ra"]).toMatchObject({ status: "closed", closedBy: "expiry", closedAmount: 40, remaining: 0, closedAtMs: T0 + 2_000 });
    expect(o.state).toMatchObject({ available: 30, held: 70 });
    expect(checkInvariants(o.state)).toEqual([]);
  });
  it("سررسید دقیقاً در لحظهٔ expiresAtMs منقضی است، یک میلی‌ثانیه پیش‌تر نه", () => {
    const s = mustState(reserve(fundedState(10), "r", 5, T0, 1_000));
    expect(errCode(charge(s, "r", "x", 1, T0 + 999))).toBe("ok");
    expect(errCode(charge(s, "r", "x", 1, T0 + 1_000))).toBe("RESERVATION_EXPIRED");
  });
  it("منقضی‌شدنِ رزرو هرگز مصرف نمی‌کند: مصرف‌های قبلی می‌مانند و فقط باقیمانده آزاد می‌شود", () => {
    const s = mustState(charge(mustState(reserve(fundedState(100), "r", 60)), "r", "x", 20));
    const o = must(run(s, "grant", { grantId: "g9", unit: UNIT, amount: 1, source: "promo" }, T0 + 5_000));
    expect(o.state).toMatchObject({ available: 81, held: 0 });
    expect(o.state.totals.charged).toBe(20);
    expect(o.entries[0]).toMatchObject({ type: "expire", amount: 40 });
  });
  it("ساعتِ عقب‌رفته سررسید را عقب نمی‌کشد", () => {
    let s = mustState(reserve(fundedState(100), "r1", 10, 50_000, 1_000)); // سررسید ۵۱٬۰۰۰، lastAtMs = ۵۰٬۰۰۰
    s = mustState(run(s, "grant", { grantId: "g9", unit: UNIT, amount: 1, source: "promo" }, 52_000));
    expect(s.reservations["r1"]?.status).toBe("closed");
    expect(s.lastAtMs).toBe(52_000);
    const o = must(reserve(s, "r2", 5, 100, 1_000)); // ساعت ۱۰۰ ولی حساب ۵۲٬۰۰۰ را دیده
    expect(o.receipt).toMatchObject({ expiresAtMs: 53_000 });
    expect(o.state.lastAtMs).toBe(52_000);
    expect(o.entries[0]?.atMs).toBe(52_000);
  });
  it("شکستِ فرمان پس از انقضای تنبل: خطا برمی‌گردد ولی انقضا ماندگار و علامت‌دار است؛ بی‌انقضا changed=false", () => {
    const s = mustState(reserve(fundedState(100), "r", 60, T0, 1_000));
    const fail = reserve(s, "r2", 1_000, T0 + 1_000);
    expect(errCode(fail)).toBe("INSUFFICIENT_CREDIT");
    expect(fail.changed).toBe(true);
    expect(fail.entries.map((e) => e.type)).toEqual(["expire"]);
    expect(fail.state?.available).toBe(100);
    expect(fail.state?.lastAtMs).toBe(T0 + 1_000);
    const plain = reserve(s, "r2", 1_000, T0);
    expect(plain.changed).toBe(false);
  });
});

describe("ledger/engine · viewAt", () => {
  it("null برای حساب ناموجود", () => {
    expect(viewAt(null, 5)).toBeNull();
  });
  it("انقضا را حساب می‌کند ولی ورودی را تغییر نمی‌دهد", () => {
    const s = mustState(reserve(fundedState(100), "r", 60, T0, 1_000));
    const frozen = deepFreeze(structuredClone(s));
    const early = viewAt(frozen, T0 + 999);
    const late = viewAt(frozen, T0 + 1_000);
    expect(early).toMatchObject({ available: 40, held: 60, openReservations: 1, unit: UNIT, asOfMs: T0 + 999 });
    expect(late).toMatchObject({ available: 100, held: 0, openReservations: 0 });
    expect(frozen).toEqual(s);
    expect(Object.isFrozen(late)).toBe(true);
  });
  it("ساعت عقب‌رفته: asOfMs از lastAtMs کمتر نمی‌شود", () => {
    const s = fundedState(10, 5_000);
    expect(viewAt(s, 1)?.asOfMs).toBe(5_000);
  });
});

describe("ledger/engine · ناخالصی و پایداری", () => {
  it("حالت ورودی هرگز تغییر نمی‌کند (حالت منجمد ⇒ هر تغییر INTERNAL_ERROR می‌شد)", () => {
    let s = fundedState(1000);
    const steps: [string, Record<string, unknown>, number][] = [
      ["grant", { grantId: "g1", unit: UNIT, amount: 5, source: "promo" }, T0],
      ["reserve", { reservationId: "r1", unit: UNIT, amount: 100, ttlMs: 1_000 }, T0],
      ["charge", { reservationId: "r1", attemptId: "x1", unit: UNIT, amount: 30 }, T0],
      ["refund", { refundId: "f1", reservationId: "r1", attemptId: "x1", unit: UNIT, amount: 10 }, T0],
      ["close", { reservationId: "r1", remainder: "release" }, T0],
      ["reserve", { reservationId: "r2", unit: UNIT, amount: 100, ttlMs: 1_000 }, T0],
      ["grant", { grantId: "g2", unit: UNIT, amount: 1, source: "promo" }, T0 + 5_000], // انقضای تنبل
      ["charge", { reservationId: "r1", attemptId: "x1", unit: UNIT, amount: 30 }, T0], // بازتکرار
    ];
    for (const [k, f, at] of steps) {
      deepFreeze(s);
      const snap = structuredClone(s);
      const o = run(s, k as "grant", f, at);
      expect(o.ok, `${k} ${o.ok ? "" : o.error.code}`).toBe(true);
      expect(s).toEqual(snap);
      if (o.ok) s = o.state;
    }
  });
  it("خروجی حالت از ورودی جداست (تغییر خروجی ورودی را نمی‌شکند)", () => {
    const s = fundedState(10);
    const o = must(run(s, "grant", { grantId: "g1", unit: UNIT, amount: 1, source: "promo" }, T0));
    o.state.available = 999;
    expect(s.available).toBe(10);
    const rep = must(run(o.state, "grant", { grantId: "g1", unit: UNIT, amount: 1, source: "promo" }, T0));
    expect(rep.state).not.toBe(o.state);
  });
  it("رسیدها منجمدند و رسید بازتکرار با اصلی برابر ولی نه همان شیء", () => {
    const first = must(run(fundedState(10), "grant", { grantId: "g1", unit: UNIT, amount: 1, source: "promo" }, T0));
    expect(Object.isFrozen(first.receipt)).toBe(true);
    const rep = must(run(first.state, "grant", { grantId: "g1", unit: UNIT, amount: 1, source: "promo" }, T0));
    expect(rep.receipt).toEqual(first.receipt);
    expect(rep.receipt).not.toBe(first.state.processed["grant:g1"]?.receipt);
  });
  it("حالت ناسازگار (رزرو بی‌کلید یکتایی) ⇒ INTERNAL_ERROR نه حدس", () => {
    const s = mustState(reserve(fundedState(100), "r1", 10));
    delete s.processed["reserve:r1"];
    expect(errCode(reserve(s, "r1", 10))).toBe("INTERNAL_ERROR");
    const s2 = mustState(charge(mustState(reserve(fundedState(100), "r1", 10)), "r1", "x", 1));
    delete s2.processed["charge:r1/x"];
    expect(errCode(charge(s2, "r1", "x", 1))).toBe("INTERNAL_ERROR");
    const s3 = mustState(run(mustState(reserve(fundedState(100), "r1", 10)), "close", { reservationId: "r1", remainder: "release" }, T0));
    delete s3.processed["close:r1"];
    expect(errCode(run(s3, "close", { reservationId: "r1", remainder: "release" }, T0))).toBe("INTERNAL_ERROR");
  });
  it("حالتِ خراب‌شده (null در جای شیء) پرتاب نمی‌کند", () => {
    const bad = { ...fundedState(1), reservations: null } as unknown as ReturnType<typeof fundedState>;
    const o = run(bad, "reserve", { reservationId: "r", unit: UNIT, amount: 1, ttlMs: 1_000 }, T0);
    expect(errCode(o)).toBe("INTERNAL_ERROR");
  });
});
