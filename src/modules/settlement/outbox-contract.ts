/**
 * آزمون قرارداد پورت `SettlementOutbox` (از index صادر نمی‌شود). هر پیاده‌سازی (حافظه‌ای، و در برش بعد PostgreSQL) باید آن را بی‌تغییر بگذراند:
 * معناشناسی هر متد، ناوردای «قصدِ بستن آخرین قصد است»، اتمی‌بودن `resolveClose` زیر مسابقه، کپیِ منجمد، جداسازی حساب‌ها.
 */
import { describe, expect, it } from "vitest";
import type { BeginInput, OutboxEntry, OutboxResult, SettlementOutbox } from "./types";

export type OutboxHarness = Readonly<{ outbox: SettlementOutbox; dispose?: () => Promise<void> }>;

export const REF = Object.freeze({ tenantId: "t1", accountId: "a1", reservationId: "s1.r1" });
export const BEGIN: BeginInput = Object.freeze({ ...REF, unit: "IRR_MICROS", reserved: 500, createdAtMs: 1_000, expiresAtMs: 61_000, dueAtMs: 11_000, orphanRemainder: "forfeit" as const });
export const beginOf = (over: Record<string, unknown> = {}): BeginInput => ({ ...BEGIN, ...over }) as BeginInput;
export const refOf = (reservationId: string, over: Record<string, unknown> = {}) => ({ ...REF, reservationId, ...over });

function must<T>(r: OutboxResult<T>): T {
  if (!r.ok) throw new Error(`انتظار موفقیت بود: ${r.error.code}`);
  return r.value;
}
/** رکوردِ موجود (نبودنش خودش شکستِ آزمون است). */
async function entryOf(o: SettlementOutbox, ref: { tenantId: string; accountId: string; reservationId: string }): Promise<OutboxEntry> {
  const e = must(await o.get(ref));
  if (e === null) throw new Error("رکورد باید وجود می‌داشت");
  return e;
}
function code(r: OutboxResult<unknown>): string {
  return r.ok ? "ok" : r.error.code;
}

export function describeOutboxContract(label: string, make: () => Promise<OutboxHarness>): void {
  const fresh = async (fn: (o: SettlementOutbox) => Promise<void>): Promise<void> => {
    const h = await make();
    try {
      await fn(h.outbox);
    } finally {
      await h.dispose?.();
    }
  };
  const open = async (o: SettlementOutbox, id = "s1.r1", over: Record<string, unknown> = {}) => must(await o.begin(beginOf({ reservationId: id, ...over })));

  describe(`${label} · قرارداد outbox · begin`, () => {
    it("رکورد تازهٔ open می‌سازد و get کپیِ منجمد با همهٔ میدان‌ها می‌دهد", () =>
      fresh(async (o) => {
        expect(await open(o)).toEqual({ replayed: false });
        const e = must(await o.get(REF));
        expect(e).toMatchObject({ ...BEGIN, state: "open", charge: null, close: null, attempts: 0, lastErrorCode: null, deadReason: null, settledAtMs: null });
        expect(Object.isFrozen(e)).toBe(true);
        expect(must(await o.get(REF))).not.toBe(e);
      }));
    it("بازتکرارِ هم‌محتوا (حتی با زمان‌های دیگر) replayed است و چیزی را عوض نمی‌کند", () =>
      fresh(async (o) => {
        await open(o);
        expect(must(await o.begin(beginOf({ createdAtMs: 9_999, dueAtMs: 19_999 })))).toEqual({ replayed: true });
        expect(must(await o.get(REF))).toMatchObject({ createdAtMs: 1_000, dueAtMs: 11_000 });
      }));
    it.each([{ reserved: 501 }, { orphanRemainder: "release" }, { expiresAtMs: 62_000 }, { unit: "USD_MICROS" }])("محتوای دیگر %j ⇒ CONFLICT و رکورد دست‌نخورده", (over) =>
      fresh(async (o) => {
        await open(o);
        expect(code(await o.begin(beginOf(over)))).toBe("CONFLICT");
        expect(must(await o.get(REF))).toMatchObject(BEGIN);
      }));
    it.each([
      [null],
      [{}],
      [{ ...BEGIN, tenantId: "bad id" }],
      [{ ...BEGIN, reservationId: "" }],
      [{ ...BEGIN, reserved: 0 }],
      [{ ...BEGIN, reserved: 1.5 }],
      [{ ...BEGIN, createdAtMs: -1 }],
      [{ ...BEGIN, dueAtMs: Number.MAX_SAFE_INTEGER + 1 }],
      [{ ...BEGIN, unit: "irr" }],
      [{ ...BEGIN, orphanRemainder: "keep" }],
    ])("ورودی نامعتبر %# ⇒ INVALID_INPUT و چیزی ساخته نمی‌شود", (bad) =>
      fresh(async (o) => {
        expect(code(await o.begin(bad as BeginInput))).toBe("INVALID_INPUT");
        expect(must(await o.counts())).toEqual({ open: 0, settling: 0, done: 0, dead: 0 });
      }));
    it("حساب‌ها و مستأجرها جدا هستند (همان reservationId در دو حساب)", () =>
      fresh(async (o) => {
        await open(o, "r", { accountId: "a1" });
        await open(o, "r", { accountId: "a2", reserved: 7 });
        await open(o, "r", { tenantId: "t2", reserved: 9 });
        expect(must(await o.get(refOf("r")))).toMatchObject({ reserved: 500 });
        expect(must(await o.get(refOf("r", { accountId: "a2" })))).toMatchObject({ reserved: 7 });
        expect(must(await o.get(refOf("r", { tenantId: "t2" })))).toMatchObject({ reserved: 9 });
        expect(must(await o.get(refOf("r", { tenantId: "t3" })))).toBeNull();
      }));
  });

  describe(`${label} · قرارداد outbox · recordCharge / recordClose`, () => {
    it("recordCharge: open→settling؛ بازتکرارِ یکسان replayed؛ مبلغ/تلاشِ دیگر CONFLICT", () =>
      fresh(async (o) => {
        await open(o);
        expect(must(await o.recordCharge(REF, { attemptId: "a1", amount: 120 }))).toEqual({ replayed: false });
        expect(must(await o.get(REF))).toMatchObject({ state: "settling", charge: { attemptId: "a1", amount: 120 } });
        expect(must(await o.recordCharge(REF, { attemptId: "a1", amount: 120 }))).toEqual({ replayed: true });
        expect(code(await o.recordCharge(REF, { attemptId: "a1", amount: 121 }))).toBe("CONFLICT");
        expect(code(await o.recordCharge(REF, { attemptId: "a2", amount: 120 }))).toBe("CONFLICT");
        expect(must(await o.get(REF))).toMatchObject({ charge: { attemptId: "a1", amount: 120 } });
      }));
    it("مبلغ صفر هم قصدِ معتبر است (تصمیمِ پذیرش با دفتر است)", () =>
      fresh(async (o) => {
        await open(o);
        expect(must(await o.recordCharge(REF, { attemptId: "a1", amount: 0 }))).toEqual({ replayed: false });
      }));
    it("recordClose: ثبت؛ همان باقیمانده با origin دیگر replayed (اولین ثبت می‌ماند)؛ باقیمانده دیگر CONFLICT", () =>
      fresh(async (o) => {
        await open(o);
        expect(must(await o.recordClose(REF, { remainder: "release", origin: "caller" }))).toEqual({ replayed: false });
        expect(must(await o.recordClose(REF, { remainder: "release", origin: "sweeper" }))).toEqual({ replayed: true });
        expect(code(await o.recordClose(REF, { remainder: "forfeit", origin: "caller" }))).toBe("CONFLICT");
        expect(must(await o.get(REF))).toMatchObject({ state: "settling", close: { remainder: "release", origin: "caller" } });
      }));
    it("قصدِ بستن آخرین قصد است: پس از آن recordCharge ⇒ CONFLICT", () =>
      fresh(async (o) => {
        await open(o);
        await o.recordClose(REF, { remainder: "release", origin: "caller" });
        expect(code(await o.recordCharge(REF, { attemptId: "a1", amount: 1 }))).toBe("CONFLICT");
        expect(must(await o.get(REF))).toMatchObject({ charge: null });
      }));
    it("بی‌رکورد ⇒ NOT_FOUND؛ نهایی (done/dead) ⇒ NOT_ACTIVE؛ ورودی بد ⇒ INVALID_INPUT", () =>
      fresh(async (o) => {
        expect(code(await o.recordCharge(REF, { attemptId: "a1", amount: 1 }))).toBe("NOT_FOUND");
        expect(code(await o.recordClose(REF, { remainder: "release", origin: "caller" }))).toBe("NOT_FOUND");
        await open(o, "done1");
        await open(o, "dead1");
        await o.recordClose(refOf("done1"), { remainder: "release", origin: "caller" });
        must(await o.finish(refOf("done1"), 5));
        must(await o.bury(refOf("dead1"), { reason: "LEDGER_REJECTED", errorCode: null, atMs: 5 }));
        for (const id of ["done1", "dead1"]) {
          expect(code(await o.recordCharge(refOf(id), { attemptId: "a1", amount: 1 }))).toBe("NOT_ACTIVE");
          expect(code(await o.recordClose(refOf(id), { remainder: "release", origin: "caller" }))).toBe("NOT_ACTIVE");
        }
        await open(o, "x");
        expect(code(await o.recordCharge(refOf("x"), { attemptId: "bad id", amount: 1 }))).toBe("INVALID_INPUT");
        expect(code(await o.recordCharge(refOf("x"), { attemptId: "a1", amount: -1 }))).toBe("INVALID_INPUT");
        expect(code(await o.recordClose(refOf("x"), { remainder: "keep" as never, origin: "caller" }))).toBe("INVALID_INPUT");
        expect(code(await o.recordClose(refOf("x"), { remainder: "release", origin: "me" as never }))).toBe("INVALID_INPUT");
        expect(code(await o.recordCharge({ tenantId: "t1" } as never, { attemptId: "a1", amount: 1 }))).toBe("INVALID_INPUT");
      }));
  });

  describe(`${label} · قرارداد outbox · resolveClose (تصمیمِ اتمیِ رفتگر)`, () => {
    it.each(["forfeit", "release"] as const)("بی‌قصدِ مصرف: باقیمانده = orphanRemainder (%s) با origin=sweeper", (policy) =>
      fresh(async (o) => {
        await open(o, "s1.r1", { orphanRemainder: policy });
        const e = must(await o.resolveClose(REF));
        expect(e).toMatchObject({ state: "settling", charge: null, close: { remainder: policy, origin: "sweeper" } });
      }));
    it("با قصدِ مصرف: همیشه release (هرگز بیش از هزینهٔ ثبت‌شده نمی‌گیرد) حتی اگر سیاست یتیم forfeit باشد", () =>
      fresh(async (o) => {
        await open(o, "s1.r1", { orphanRemainder: "forfeit" });
        await o.recordCharge(REF, { attemptId: "a1", amount: 40 });
        const e = must(await o.resolveClose(REF));
        expect(e).toMatchObject({ charge: { attemptId: "a1", amount: 40 }, close: { remainder: "release", origin: "sweeper" } });
      }));
    it("اگر قصدِ بستن هست همان را بی‌تغییر برمی‌گرداند (origin اصلی می‌ماند)؛ تکرار بی‌اثر", () =>
      fresh(async (o) => {
        await open(o);
        await o.recordClose(REF, { remainder: "forfeit", origin: "caller" });
        const a = must(await o.resolveClose(REF));
        const b = must(await o.resolveClose(REF));
        expect(a.close).toEqual({ remainder: "forfeit", origin: "caller" });
        expect(b).toEqual(a);
      }));
    it("پس از resolveClose، ثبتِ درون‌خطیِ مصرف یا بستنِ متفاوت CONFLICT است (رفتگر برنده است)", () =>
      fresh(async (o) => {
        await open(o);
        must(await o.resolveClose(REF));
        expect(code(await o.recordCharge(REF, { attemptId: "a1", amount: 1 }))).toBe("CONFLICT");
        expect(code(await o.recordClose(REF, { remainder: "release", origin: "caller" }))).toBe("CONFLICT"); // forfeit ثبت شده
        expect(must(await o.recordClose(REF, { remainder: "forfeit", origin: "caller" }))).toEqual({ replayed: true });
      }));
    it("بی‌رکورد ⇒ NOT_FOUND؛ نهایی ⇒ NOT_ACTIVE", () =>
      fresh(async (o) => {
        expect(code(await o.resolveClose(REF))).toBe("NOT_FOUND");
        await open(o);
        must(await o.bury(REF, { reason: "LEDGER_REJECTED", errorCode: "X", atMs: 1 }));
        expect(code(await o.resolveClose(REF))).toBe("NOT_ACTIVE");
      }));
    it("مسابقه: recordCharge و resolveClose هم‌زمان ⇒ هرگز «مصرف ثبت‌شده + سوخت» نمی‌شود (۴۰ دور)", () =>
      fresh(async (o) => {
        for (let i = 0; i < 40; i++) {
          const ref = refOf(`race${i}`);
          await open(o, `race${i}`, { orphanRemainder: "forfeit" });
          const order = i % 2 === 0 ? [o.recordCharge(ref, { attemptId: "a1", amount: 5 }), o.resolveClose(ref)] : [o.resolveClose(ref), o.recordCharge(ref, { attemptId: "a1", amount: 5 })];
          await Promise.all(order);
          const e = await entryOf(o, ref);
          expect(e.close, `دور ${i}`).not.toBeNull();
          if (e.charge !== null) expect(e.close?.remainder, `دور ${i}`).toBe("release");
          else expect(e.close?.remainder, `دور ${i}`).toBe("forfeit");
        }
      }));
  });

  describe(`${label} · قرارداد outbox · finish / recordFailure / bury`, () => {
    it("finish: بی‌قصدِ بستن CONFLICT؛ با آن done و settledAtMs؛ بازتکرار replayed", () =>
      fresh(async (o) => {
        await open(o);
        expect(code(await o.finish(REF, 7))).toBe("CONFLICT");
        await o.recordCharge(REF, { attemptId: "a1", amount: 3 });
        expect(code(await o.finish(REF, 7))).toBe("CONFLICT");
        await o.recordClose(REF, { remainder: "release", origin: "caller" });
        expect(must(await o.finish(REF, 7))).toEqual({ replayed: false });
        expect(must(await o.get(REF))).toMatchObject({ state: "done", settledAtMs: 7 });
        expect(must(await o.finish(REF, 99))).toEqual({ replayed: true });
        expect(must(await o.get(REF))).toMatchObject({ settledAtMs: 7 });
      }));
    it("finish: بی‌رکورد NOT_FOUND؛ dead ⇒ NOT_ACTIVE؛ زمان بد INVALID_INPUT", () =>
      fresh(async (o) => {
        expect(code(await o.finish(REF, 1))).toBe("NOT_FOUND");
        await open(o);
        expect(code(await o.finish(REF, -1))).toBe("INVALID_INPUT");
        must(await o.bury(REF, { reason: "EXPIRED_UNBILLED", errorCode: null, atMs: 2 }));
        expect(code(await o.finish(REF, 3))).toBe("NOT_ACTIVE");
      }));
    it("recordFailure: شمار تلاش، کد و سررسید تازه؛ نهایی ⇒ NOT_ACTIVE؛ کد بد ⇒ INVALID_INPUT", () =>
      fresh(async (o) => {
        await open(o);
        expect(must(await o.recordFailure(REF, { errorCode: "STORE_FAILURE", dueAtMs: 20_000 }))).toEqual({ attempts: 1 });
        expect(must(await o.recordFailure(REF, { errorCode: "INTERNAL_ERROR", dueAtMs: 30_000 }))).toEqual({ attempts: 2 });
        expect(must(await o.get(REF))).toMatchObject({ attempts: 2, lastErrorCode: "INTERNAL_ERROR", dueAtMs: 30_000, state: "open" });
        expect(code(await o.recordFailure(REF, { errorCode: "lower case", dueAtMs: 1 }))).toBe("INVALID_INPUT");
        expect(code(await o.recordFailure(REF, { errorCode: "X", dueAtMs: -5 }))).toBe("INVALID_INPUT");
        expect(code(await o.recordFailure(refOf("none"), { errorCode: "X", dueAtMs: 1 }))).toBe("NOT_FOUND");
        must(await o.bury(REF, { reason: "ATTEMPTS_EXHAUSTED", errorCode: "STORE_FAILURE", atMs: 40_000 }));
        expect(code(await o.recordFailure(REF, { errorCode: "X", dueAtMs: 1 }))).toBe("NOT_ACTIVE");
      }));
    it("bury: فعال→dead با دلیل؛ همان دلیل replayed؛ دلیل دیگر CONFLICT؛ done ⇒ NOT_ACTIVE؛ دلیل بد INVALID_INPUT", () =>
      fresh(async (o) => {
        await open(o);
        expect(must(await o.bury(REF, { reason: "EXPIRED_UNBILLED", errorCode: "RESERVATION_EXPIRED", atMs: 9 }))).toEqual({ replayed: false });
        expect(must(await o.get(REF))).toMatchObject({ state: "dead", deadReason: "EXPIRED_UNBILLED", lastErrorCode: "RESERVATION_EXPIRED", settledAtMs: 9 });
        expect(must(await o.bury(REF, { reason: "EXPIRED_UNBILLED", errorCode: null, atMs: 99 }))).toEqual({ replayed: true });
        expect(code(await o.bury(REF, { reason: "LEDGER_REJECTED", errorCode: null, atMs: 99 }))).toBe("CONFLICT");
        expect(code(await o.bury(REF, { reason: "NOPE" as never, errorCode: null, atMs: 1 }))).toBe("INVALID_INPUT");
        expect(code(await o.bury(refOf("none"), { reason: "LEDGER_REJECTED", errorCode: null, atMs: 1 }))).toBe("NOT_FOUND");
        await open(o, "d");
        await o.recordClose(refOf("d"), { remainder: "release", origin: "caller" });
        await o.finish(refOf("d"), 1);
        expect(code(await o.bury(refOf("d"), { reason: "LEDGER_REJECTED", errorCode: null, atMs: 2 }))).toBe("NOT_ACTIVE");
      }));
  });

  describe(`${label} · قرارداد outbox · listDue / listDead / counts`, () => {
    it("listDue: فقط فعال‌های سررسیدشده؛ ترتیب (سررسید، شناسه)؛ limit؛ done/dead بیرون", () =>
      fresh(async (o) => {
        await open(o, "b", { dueAtMs: 500 });
        await open(o, "a", { dueAtMs: 500 });
        await open(o, "c", { dueAtMs: 100 });
        await open(o, "late", { dueAtMs: 10_000 });
        await open(o, "gone", { dueAtMs: 1 });
        await o.recordClose(refOf("gone"), { remainder: "release", origin: "caller" });
        await o.finish(refOf("gone"), 2);
        await open(o, "dead", { dueAtMs: 1 });
        await o.bury(refOf("dead"), { reason: "LEDGER_REJECTED", errorCode: null, atMs: 2 });
        const ids = (xs: readonly { reservationId: string }[]) => xs.map((x) => x.reservationId);
        expect(ids(must(await o.listDue({ nowMs: 500, limit: 10 })))).toEqual(["c", "a", "b"]);
        expect(ids(must(await o.listDue({ nowMs: 500, limit: 2 })))).toEqual(["c", "a"]);
        expect(ids(must(await o.listDue({ nowMs: 99, limit: 10 })))).toEqual([]);
        expect(ids(must(await o.listDue({ nowMs: 10_000, limit: 10 })))).toEqual(["c", "a", "b", "late"]);
      }));
    it("listDue: سررسید با recordFailure جلو می‌رود (رکوردِ ناکام ته صف می‌رود)", () =>
      fresh(async (o) => {
        await open(o, "a", { dueAtMs: 100 });
        await open(o, "b", { dueAtMs: 200 });
        await o.recordFailure(refOf("a"), { errorCode: "STORE_FAILURE", dueAtMs: 900 });
        expect(must(await o.listDue({ nowMs: 300, limit: 10 })).map((e) => e.reservationId)).toEqual(["b"]);
        expect(must(await o.listDue({ nowMs: 900, limit: 10 })).map((e) => e.reservationId)).toEqual(["b", "a"]);
      }));
    it.each([{ nowMs: 1, limit: 0 }, { nowMs: 1, limit: 1001 }, { nowMs: -1, limit: 1 }, { nowMs: 1.5, limit: 1 }, null])("listDue ورودی نامعتبر %j ⇒ INVALID_INPUT", (q) =>
      fresh(async (o) => {
        expect(code(await o.listDue(q as never))).toBe("INVALID_INPUT");
      }));
    it("listDead: به ترتیب زمان مرگ؛ counts همهٔ وضعیت‌ها را می‌شمارد؛ listDead ورودی بد INVALID_INPUT", () =>
      fresh(async (o) => {
        await open(o, "x");
        await open(o, "y");
        await open(o, "z");
        await open(o, "w");
        await o.bury(refOf("y"), { reason: "LEDGER_REJECTED", errorCode: "A", atMs: 30 });
        await o.bury(refOf("x"), { reason: "EXPIRED_UNBILLED", errorCode: "B", atMs: 20 });
        await o.recordCharge(refOf("w"), { attemptId: "a1", amount: 1 });
        await o.recordClose(refOf("z"), { remainder: "release", origin: "caller" });
        await o.finish(refOf("z"), 5);
        expect(must(await o.listDead({ limit: 10 })).map((e) => e.reservationId)).toEqual(["x", "y"]);
        expect(must(await o.listDead({ limit: 1 })).map((e) => e.reservationId)).toEqual(["x"]);
        expect(must(await o.counts())).toEqual({ open: 0, settling: 1, done: 1, dead: 2 });
        expect(code(await o.listDead({ limit: 0 }))).toBe("INVALID_INPUT");
        expect(code(await o.listDead(null as never))).toBe("INVALID_INPUT");
      }));
    it("خروجی‌ها کپیِ منجمدند: دست‌کاری آن‌ها حالت درونی را عوض نمی‌کند", () =>
      fresh(async (o) => {
        await open(o);
        await o.recordCharge(REF, { attemptId: "a1", amount: 5 });
        const e = await entryOf(o, REF);
        expect(() => {
          (e as { state: string }).state = "done";
        }).toThrow();
        expect(Object.isFrozen(e.charge)).toBe(true);
        expect((await entryOf(o, REF)).state).toBe("settling");
        for (const x of must(await o.listDue({ nowMs: 1e9, limit: 5 }))) expect(Object.isFrozen(x)).toBe(true);
      }));
    it("همزمانی: ۲۰ recordCharge یکسان ⇒ دقیقاً یکی replayed=false", () =>
      fresh(async (o) => {
        await open(o);
        const rs = await Promise.all(Array.from({ length: 20 }, () => o.recordCharge(REF, { attemptId: "a1", amount: 9 })));
        expect(rs.filter((r) => r.ok && !r.value.replayed)).toHaveLength(1);
        expect(rs.every((r) => r.ok)).toBe(true);
      }));
  });
}
