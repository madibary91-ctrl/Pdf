/**
 * آزمون قرارداد «ثبتِ شکستِ تکرارپذیر» (ADR-0028) — بخشی از پورت `SettlementOutbox`: `recordFailure` با `expectedAttempts`.
 * هر پیاده‌سازی (حافظه‌ای، PostgreSQL) باید آن را **بی‌تغییر** بگذراند. از index صادر نمی‌شود و آزمونِ محصول نیست (پوشهٔ `contract/` عمداً
 * بیرون از فهرستِ فایل‌های منبعِ `purity.test.ts` است). قرارداد پایهٔ پورت (`../outbox-contract.ts`) دست نخورده است.
 *
 * ناوردای محوری: **یک شکستِ منطقی، یک واحد شمارش.** `attempts` سقفِ مرگِ مالیِ رکورد را می‌سازد؛ دو رفتگرِ هم‌زمان یا تلاشِ دوبارهٔ پس از
 * قطعِ مبهم نباید رکورد را زودتر از سقف بمیرانند. مسیرِ بی‌`expectedAttempts` دقیقاً مثلِ پیش می‌ماند (آزمونِ پایه آن را می‌سنجد؛ این‌جا فقط
 * «شکلِ نتیجه» و «بی‌اثر بودنِ فیلدِ undefined» سنجیده می‌شود).
 */
import { describe, expect, it } from "vitest";
import { beginOf, refOf, type OutboxHarness } from "../outbox-contract";
import type { OutboxEntry, OutboxResult, ReservationRef, SettlementOutbox } from "../types";

function must<T>(r: OutboxResult<T>): T {
  if (!r.ok) throw new Error(`انتظار موفقیت بود: ${r.error.code}`);
  return r.value;
}
const code = (r: OutboxResult<unknown>): string => (r.ok ? "ok" : r.error.code);
const entry = async (o: SettlementOutbox, ref: ReservationRef): Promise<OutboxEntry> => {
  const e = must(await o.get(ref));
  if (e === null) throw new Error("رکورد باید وجود می‌داشت");
  return e;
};
const fail = (dueAtMs: number, errorCode = "STORE_FAILURE") => ({ errorCode, dueAtMs });

export function describeFailureCasContract(label: string, make: () => Promise<OutboxHarness>): void {
  const fresh = async (fn: (o: SettlementOutbox, ref: ReservationRef) => Promise<void>): Promise<void> => {
    const h = await make();
    try {
      const ref = refOf("c1");
      must(await h.outbox.begin(beginOf({ reservationId: "c1" })));
      await fn(h.outbox, ref);
    } finally {
      await h.dispose?.();
    }
  };

  describe(`${label} · قرارداد ثبتِ شکستِ تکرارپذیر · مقایسه و ثبت`, () => {
    it("expectedAttempts برابرِ شمارنده ⇒ ثبت و replayed:false؛ شمارنده، کد و سررسید تازه می‌شوند", () =>
      fresh(async (o, ref) => {
        expect(await o.recordFailure(ref, { ...fail(20_000, "STORE_FAILURE"), expectedAttempts: 0 })).toEqual({ ok: true, value: { attempts: 1, replayed: false } });
        expect(await entry(o, ref)).toMatchObject({ attempts: 1, lastErrorCode: "STORE_FAILURE", dueAtMs: 20_000 });
        expect(must(await o.recordFailure(ref, { ...fail(30_000, "INTERNAL_ERROR"), expectedAttempts: 1 }))).toEqual({ attempts: 2, replayed: false });
        expect(await entry(o, ref)).toMatchObject({ attempts: 2, lastErrorCode: "INTERNAL_ERROR", dueAtMs: 30_000 });
      }));

    it("تکرارِ همان ثبت (همان expectedAttempts) ⇒ replayed:true و هیچ‌چیز نوشته نمی‌شود (نه شمارنده، نه سررسید، نه کد)", () =>
      fresh(async (o, ref) => {
        must(await o.recordFailure(ref, { ...fail(20_000, "STORE_FAILURE"), expectedAttempts: 0 }));
        const before = await entry(o, ref);
        expect(await o.recordFailure(ref, { ...fail(99_999, "INTERNAL_ERROR"), expectedAttempts: 0 })).toEqual({ ok: true, value: { attempts: 1, replayed: true } });
        expect(await entry(o, ref)).toEqual(before);
      }));

    it("expectedAttempts کهنه‌تر از شمارنده (چند واحد عقب) ⇒ replayed:true با شمارندهٔ فعلی؛ رکورد دست‌نخورده", () =>
      fresh(async (o, ref) => {
        for (let i = 0; i < 3; i++) must(await o.recordFailure(ref, { ...fail(1_000 + i), expectedAttempts: i }));
        const before = await entry(o, ref);
        expect(must(await o.recordFailure(ref, { ...fail(77_777), expectedAttempts: 0 }))).toEqual({ attempts: 3, replayed: true });
        expect(must(await o.recordFailure(ref, { ...fail(77_777), expectedAttempts: 2 }))).toEqual({ attempts: 3, replayed: true });
        expect(await entry(o, ref)).toEqual(before);
      }));

    it("expectedAttempts بزرگ‌تر از شمارنده (عکسِ «از آینده») ⇒ CONFLICT و رکورد دست‌نخورده", () =>
      fresh(async (o, ref) => {
        const before = await entry(o, ref);
        expect(code(await o.recordFailure(ref, { ...fail(20_000), expectedAttempts: 1 }))).toBe("CONFLICT");
        expect(code(await o.recordFailure(ref, { ...fail(20_000), expectedAttempts: Number.MAX_SAFE_INTEGER }))).toBe("CONFLICT");
        expect(await entry(o, ref)).toEqual(before);
      }));

    it("پیام CONFLICT فارسی، ثابت و بی‌پژواکِ مقدارِ ورودی است", () =>
      fresh(async (o, ref) => {
        const r = await o.recordFailure(ref, { ...fail(20_000, "SECRET_CODE_X"), expectedAttempts: 424_242 });
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.message).not.toMatch(/424242|424_242|SECRET_CODE_X/);
          expect(r.error.message).toMatch(/[\u0600-\u06FF]/);
          expect(Object.isFrozen(r.error)).toBe(true);
        }
      }));
  });

  describe(`${label} · قرارداد ثبتِ شکستِ تکرارپذیر · ترتیبِ خطاها و ورودی`, () => {
    it("نامعتبر ⇒ INVALID_INPUT: منفی، اعشار، NaN، Infinity، ناایمن، null، رشته، شیء، بولی", () =>
      fresh(async (o, ref) => {
        const before = await entry(o, ref);
        for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, null, "0", {}, [], true]) {
          expect(code(await o.recordFailure(ref, { ...fail(1), expectedAttempts: bad } as never)), String(bad)).toBe("INVALID_INPUT");
        }
        expect(await entry(o, ref)).toEqual(before);
      }));

    it("expectedAttempts: undefined مثلِ نبودن است (نتیجه بی‌replayed، رفتارِ پیشین)", () =>
      fresh(async (o, ref) => {
        const r = must(await o.recordFailure(ref, { ...fail(5_000), expectedAttempts: undefined }));
        expect(r).toEqual({ attempts: 1 });
        expect(Object.keys(r)).toEqual(["attempts"]);
        expect(must(await o.recordFailure(ref, fail(6_000)))).toEqual({ attempts: 2 });
      }));

    it("بی‌expectedAttempts: همچنان هر فراخوانی می‌شمارد (سازگاریِ رو به عقب) و `replayed` هرگز نمی‌آید", () =>
      fresh(async (o, ref) => {
        for (let i = 1; i <= 4; i++) expect(must(await o.recordFailure(ref, fail(i)))).toEqual({ attempts: i });
      }));

    it("بی‌رکورد ⇒ NOT_FOUND (حتی با expectedAttempts)", () =>
      fresh(async (o) => {
        expect(code(await o.recordFailure(refOf("none"), { ...fail(1), expectedAttempts: 0 }))).toBe("NOT_FOUND");
      }));

    it("رکوردِ نهایی (done/dead) ⇒ NOT_ACTIVE پیش از مقایسهٔ شمارنده، حتی اگر expectedAttempts «آینده» یا «کهنه» باشد", () =>
      fresh(async (o, ref) => {
        must(await o.recordFailure(ref, { ...fail(10), expectedAttempts: 0 }));
        must(await o.bury(ref, { reason: "ATTEMPTS_EXHAUSTED", errorCode: "STORE_FAILURE", atMs: 50 }));
        const before = await entry(o, ref);
        for (const n of [0, 1, 2, 99]) expect(code(await o.recordFailure(ref, { ...fail(1), expectedAttempts: n })), String(n)).toBe("NOT_ACTIVE");
        expect(await entry(o, ref)).toEqual(before);

        const done = refOf("c2");
        must(await o.begin(beginOf({ reservationId: "c2" })));
        must(await o.recordClose(done, { remainder: "release", origin: "caller" }));
        must(await o.finish(done, 9));
        expect(code(await o.recordFailure(done, { ...fail(1), expectedAttempts: 0 }))).toBe("NOT_ACTIVE");
        expect(code(await o.recordFailure(done, { ...fail(1), expectedAttempts: 5 }))).toBe("NOT_ACTIVE");
      }));

    it("ترتیبِ اعتبارسنجی: ref نامعتبر یا errorCode نامعتبر پیش از هر چیز INVALID_INPUT است", () =>
      fresh(async (o, ref) => {
        expect(code(await o.recordFailure(refOf("c1", { tenantId: "" }), { ...fail(1), expectedAttempts: 0 }))).toBe("INVALID_INPUT");
        expect(code(await o.recordFailure(ref, { errorCode: "bad code", dueAtMs: 1, expectedAttempts: 0 }))).toBe("INVALID_INPUT");
        expect(code(await o.recordFailure(ref, { errorCode: "X", dueAtMs: -1, expectedAttempts: 0 }))).toBe("INVALID_INPUT");
        expect((await entry(o, ref)).attempts).toBe(0);
      }));

    it("رکورد در حالت settling هم قابلِ ثبت است و وضعیت و قصدها را عوض نمی‌کند", () =>
      fresh(async (o, ref) => {
        must(await o.recordCharge(ref, { attemptId: "a1", amount: 7 }));
        expect(must(await o.recordFailure(ref, { ...fail(20_000), expectedAttempts: 0 }))).toEqual({ attempts: 1, replayed: false });
        expect(await entry(o, ref)).toMatchObject({ state: "settling", charge: { attemptId: "a1", amount: 7 }, attempts: 1 });
      }));
  });

  describe(`${label} · قرارداد ثبتِ شکستِ تکرارپذیر · هم‌زمانی منطقی`, () => {
    it("دو «رفتگر» با همان عکس (expectedAttempts=0) ⇒ یکی ثبت، دیگری replayed؛ attempts دقیقاً ۱ (نه ۲)", () =>
      fresh(async (o, ref) => {
        const [a, b] = await Promise.all([o.recordFailure(ref, { ...fail(20_000, "STORE_FAILURE"), expectedAttempts: 0 }), o.recordFailure(ref, { ...fail(30_000, "INTERNAL_ERROR"), expectedAttempts: 0 })]);
        const results = [must(a), must(b)];
        expect(results.filter((r) => r.replayed === false)).toHaveLength(1);
        expect(results.filter((r) => r.replayed === true)).toHaveLength(1);
        expect(results.every((r) => r.attempts === 1)).toBe(true);
        const e = await entry(o, ref);
        expect(e.attempts).toBe(1);
        // سررسید و کد هر دو از «برنده» می‌آیند و مخلوطِ دو فراخوان نیستند.
        expect([
          [20_000, "STORE_FAILURE"],
          [30_000, "INTERNAL_ERROR"],
        ]).toContainEqual([e.dueAtMs, e.lastErrorCode]);
      }));

    it("۱۶ فراخوانِ هم‌زمان با همان expectedAttempts ⇒ دقیقاً یک برنده؛ attempts نهایی n+1", () =>
      fresh(async (o, ref) => {
        for (let i = 0; i < 2; i++) must(await o.recordFailure(ref, { ...fail(100 + i), expectedAttempts: i }));
        const rs = (await Promise.all(Array.from({ length: 16 }, (_, i) => o.recordFailure(ref, { ...fail(1_000 + i), expectedAttempts: 2 })))).map(must);
        expect(rs.filter((r) => r.replayed === false)).toHaveLength(1);
        expect(rs.filter((r) => r.replayed === true)).toHaveLength(15);
        expect(rs.every((r) => r.attempts === 3)).toBe(true);
        expect((await entry(o, ref)).attempts).toBe(3);
      }));

    it("زنجیرهٔ CAS: هر فراخوان عکسِ تازه را می‌گیرد ⇒ شمارش‌ها پیوسته و بی‌حفره‌اند", () =>
      fresh(async (o, ref) => {
        let seen = 0;
        for (let i = 0; i < 8; i++) {
          const r = must(await o.recordFailure(ref, { ...fail(500 + i), expectedAttempts: seen }));
          expect(r).toEqual({ attempts: seen + 1, replayed: false });
          seen = r.attempts;
        }
        expect((await entry(o, ref)).attempts).toBe(8);
      }));

    it("ترکیبِ CAS و فراخوانِ بی‌expected: فراخوانِ بی‌expected همیشه می‌شمارد و CASِ کهنه را replayed می‌کند", () =>
      fresh(async (o, ref) => {
        must(await o.recordFailure(ref, fail(1)));
        expect(must(await o.recordFailure(ref, { ...fail(2), expectedAttempts: 0 }))).toEqual({ attempts: 1, replayed: true });
        expect(must(await o.recordFailure(ref, fail(3)))).toEqual({ attempts: 2 });
        expect(must(await o.recordFailure(ref, { ...fail(4), expectedAttempts: 2 }))).toEqual({ attempts: 3, replayed: false });
      }));
  });

  describe(`${label} · قرارداد ثبتِ شکستِ تکرارپذیر · ناوردا با بقیهٔ پورت`, () => {
    it("replayed بودن listDue را عوض نمی‌کند (رکورد ته صف نمی‌رود)، ولی ثبتِ واقعی می‌برد", () =>
      fresh(async (o, ref) => {
        must(await o.begin(beginOf({ reservationId: "c0", dueAtMs: 12_000 })));
        must(await o.recordFailure(ref, { ...fail(900), expectedAttempts: 0 }));
        const order = async () => must(await o.listDue({ nowMs: 1_000_000, limit: 10 })).map((e) => e.reservationId);
        expect(await order()).toEqual(["c1", "c0"]);
        must(await o.recordFailure(ref, { ...fail(900_000), expectedAttempts: 0 })); // replayed ⇒ ترتیب ثابت
        expect(await order()).toEqual(["c1", "c0"]);
        must(await o.recordFailure(ref, { ...fail(900_000), expectedAttempts: 1 })); // ثبتِ واقعی ⇒ ته صف
        expect(await order()).toEqual(["c0", "c1"]);
      }));

    it("counts و فهرستِ مرده‌ها را تغییر نمی‌دهد", () =>
      fresh(async (o, ref) => {
        const before = must(await o.counts());
        must(await o.recordFailure(ref, { ...fail(1), expectedAttempts: 0 }));
        must(await o.recordFailure(ref, { ...fail(2), expectedAttempts: 0 }));
        expect(must(await o.counts())).toEqual(before);
        expect(must(await o.listDead({ limit: 10 }))).toEqual([]);
      }));
  });
}
