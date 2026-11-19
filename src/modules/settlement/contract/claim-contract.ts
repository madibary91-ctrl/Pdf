/**
 * آزمون قرارداد «اجارهٔ رکوردهای سررسیده» (ADR-0029) — قابلیتِ `DueClaimer` (`claimDue`) روی outbox.
 * هر پیاده‌سازی (حافظه‌ای، PostgreSQL) باید آن را **بی‌تغییر** بگذراند. از index صادر نمی‌شود و آزمونِ محصول نیست
 * (پوشهٔ `contract/` عمداً بیرون از فهرستِ فایل‌های منبعِ `purity.test.ts` است). قراردادِ پایهٔ پورت (`../outbox-contract.ts`) دست نخورده است.
 *
 * ناوردای محوری: **گرفتن = تأخیرِ محضِ اتمی.** `claimDue` فقط `dueAtMs` را به `nowMs + leaseMs` می‌برد (هرگز به عقب)، هیچ‌چیزِ مالی (وضعیت، قصدها،
 * شمارندهٔ تلاش) را عوض نمی‌کند، و اجاره قفلِ درستی نیست: همهٔ نوشتن‌های دیگر روی رکوردِ اجاره‌شده کار می‌کنند.
 */
import { describe, expect, it } from "vitest";
import { beginOf, refOf } from "../outbox-contract";
import type { DueClaimer, OutboxEntry, OutboxResult, ReservationRef, SettlementOutbox } from "../types";

export type ClaimHarness = Readonly<{ outbox: SettlementOutbox & DueClaimer; dispose?: () => Promise<void> }>;

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const LEASE = 30_000;

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
const ids = (es: readonly OutboxEntry[]): string[] => es.map((e) => e.reservationId);

export function describeClaimContract(label: string, make: () => Promise<ClaimHarness>): void {
  const fresh = async (fn: (o: SettlementOutbox & DueClaimer) => Promise<void>): Promise<void> => {
    const h = await make();
    try {
      await fn(h.outbox);
    } finally {
      await h.dispose?.();
    }
  };
  /** رکوردهای open با سررسیدهای داده‌شده. */
  const seed = async (o: SettlementOutbox, specs: readonly (readonly [string, number])[]): Promise<void> => {
    for (const [id, dueAtMs] of specs) must(await o.begin(beginOf({ reservationId: id, dueAtMs })));
  };

  describe(`${label} · قرارداد اجاره (claimDue) · گرفتن`, () => {
    it("رکوردهای سررسیده را به ترتیبِ (سررسید، شناسه) می‌گیرد؛ عکسِ پس از به‌روزرسانی و منجمد؛ سررسید = now + lease", () =>
      fresh(async (o) => {
        await seed(o, [["r3", 5_000], ["r1", 3_000], ["r2", 3_000]]);
        const got = must(await o.claimDue({ nowMs: 10_000, limit: 10, leaseMs: LEASE }));
        expect(ids(got)).toEqual(["r1", "r2", "r3"]);
        for (const e of got) expect(e.dueAtMs).toBe(10_000 + LEASE);
        expect(Object.isFrozen(got)).toBe(true);
        expect(got.every((e) => Object.isFrozen(e))).toBe(true);
        for (const e of got) expect(await entry(o, e)).toEqual(e);
      }));

    it("مرز سررسید: dueAtMs == now گرفته می‌شود، now+1 نه (و دست‌نخورده می‌ماند)", () =>
      fresh(async (o) => {
        await seed(o, [["at", 10_000], ["after", 10_001]]);
        expect(ids(must(await o.claimDue({ nowMs: 10_000, limit: 10, leaseMs: LEASE })))).toEqual(["at"]);
        expect((await entry(o, refOf("after"))).dueAtMs).toBe(10_001);
      }));

    it("تأخیرِ محض: وضعیت، قصدها، شمارندهٔ تلاش و کدِ خطا دست‌نخورده (فقط dueAtMs)", () =>
      fresh(async (o) => {
        await seed(o, [["s1", 1_000], ["s2", 1_000]]);
        must(await o.recordCharge(refOf("s1"), { attemptId: "a1", amount: 120 }));
        must(await o.recordFailure(refOf("s1"), { errorCode: "STORE_FAILURE", dueAtMs: 2_000 }));
        must(await o.recordFailure(refOf("s1"), { errorCode: "INTERNAL_ERROR", dueAtMs: 2_500 }));
        must(await o.recordClose(refOf("s2"), { remainder: "release", origin: "caller" }));
        const before = [await entry(o, refOf("s1")), await entry(o, refOf("s2"))];
        const got = must(await o.claimDue({ nowMs: 10_000, limit: 10, leaseMs: LEASE }));
        expect(ids(got)).toEqual(["s2", "s1"]); // سررسیدِ s2 = ۱٬۰۰۰ و s1 = ۲٬۵۰۰
        for (const b of before) expect(await entry(o, b)).toEqual({ ...b, dueAtMs: 10_000 + LEASE });
        expect(must(await o.counts())).toEqual({ open: 0, settling: 2, done: 0, dead: 0 });
      }));

    it("open و settling گرفته می‌شوند؛ done و dead هرگز", () =>
      fresh(async (o) => {
        await seed(o, [["open1", 1_000], ["settling1", 1_000], ["done1", 1_000], ["dead1", 1_000]]);
        must(await o.recordCharge(refOf("settling1"), { attemptId: "a1", amount: 5 }));
        must(await o.recordClose(refOf("done1"), { remainder: "release", origin: "caller" }));
        must(await o.finish(refOf("done1"), 2_000));
        must(await o.bury(refOf("dead1"), { reason: "LEDGER_REJECTED", errorCode: "INVALID_INPUT", atMs: 2_000 }));
        const got = must(await o.claimDue({ nowMs: 50_000, limit: 10, leaseMs: LEASE }));
        expect(ids(got).sort()).toEqual(["open1", "settling1"]);
        expect((await entry(o, refOf("done1"))).dueAtMs).toBe(1_000);
        expect((await entry(o, refOf("dead1"))).dueAtMs).toBe(1_000);
        // پس از پایانِ اجاره هم done/dead برنمی‌گردند.
        expect(ids(must(await o.claimDue({ nowMs: 50_000 + LEASE, limit: 10, leaseMs: LEASE }))).sort()).toEqual(["open1", "settling1"]);
      }));

    it("limit: فقط همان‌قدر می‌گیرد و گرفتنِ بعدی از ادامهٔ فهرست می‌آید (هیچ رکوردی دوبار، هیچ‌کدام جا نمی‌ماند)", () =>
      fresh(async (o) => {
        await seed(o, [["e", 5], ["d", 4], ["c", 3], ["b", 2], ["a", 1]]);
        const pick = async () => ids(must(await o.claimDue({ nowMs: 10, limit: 2, leaseMs: LEASE })));
        expect(await pick()).toEqual(["a", "b"]);
        expect(await pick()).toEqual(["c", "d"]);
        expect(await pick()).toEqual(["e"]);
        expect(await pick()).toEqual([]);
      }));

    it("ترتیبِ هم‌سررسید با ترتیبِ نقطه‌کد (COLLATE C) است، نه ترتیبِ زبانی: «A1، B1، a1»", () =>
      fresh(async (o) => {
        await seed(o, [["a1", 100], ["B1", 100], ["A1", 100]]);
        expect(ids(must(await o.claimDue({ nowMs: 100, limit: 10, leaseMs: LEASE })))).toEqual(["A1", "B1", "a1"]);
      }));

    it("بی‌رکوردِ سررسیده ⇒ آرایهٔ خالیِ منجمد (نه خطا)", () =>
      fresh(async (o) => {
        const none = must(await o.claimDue({ nowMs: 1, limit: 5, leaseMs: LEASE }));
        expect(none).toEqual([]);
        expect(Object.isFrozen(none)).toBe(true);
        await seed(o, [["future", 99_000]]);
        expect(must(await o.claimDue({ nowMs: 1, limit: 5, leaseMs: LEASE }))).toEqual([]);
      }));
  });

  describe(`${label} · قرارداد اجاره (claimDue) · معناشناسیِ اجاره`, () => {
    it("در طولِ اجاره رکورد نه در listDue است و نه در claimDue؛ دقیقاً در now+lease دوباره سررسیده است", () =>
      fresh(async (o) => {
        await seed(o, [["r1", 1_000]]);
        must(await o.claimDue({ nowMs: 10_000, limit: 10, leaseMs: LEASE }));
        for (const t of [10_000, 10_001, 10_000 + LEASE - 1]) {
          expect(must(await o.listDue({ nowMs: t, limit: 10 }))).toEqual([]);
          expect(must(await o.claimDue({ nowMs: t, limit: 10, leaseMs: LEASE }))).toEqual([]);
        }
        expect(ids(must(await o.listDue({ nowMs: 10_000 + LEASE, limit: 10 })))).toEqual(["r1"]);
        expect(ids(must(await o.claimDue({ nowMs: 10_000 + LEASE, limit: 10, leaseMs: 5 })))).toEqual(["r1"]);
      }));

    it("اجارهٔ تمام‌شده دوباره گرفته می‌شود و سررسید به now'+lease می‌رود (بازیابیِ مرگِ دارندهٔ اجاره، بی‌پاکسازی)", () =>
      fresh(async (o) => {
        await seed(o, [["r1", 1_000]]);
        must(await o.claimDue({ nowMs: 10_000, limit: 10, leaseMs: 100 }));
        const again = must(await o.claimDue({ nowMs: 20_000, limit: 10, leaseMs: 700 }));
        expect(again).toHaveLength(1);
        expect(again[0]?.dueAtMs).toBe(20_700);
      }));

    it("سررسید هرگز به عقب نمی‌رود: گرفتن با now کوچک‌تر رکوردِ اجاره‌شده/آینده را نمی‌گیرد و دست نمی‌زند", () =>
      fresh(async (o) => {
        await seed(o, [["r1", 1_000]]);
        must(await o.claimDue({ nowMs: 10_000, limit: 10, leaseMs: LEASE }));
        let last = (await entry(o, refOf("r1"))).dueAtMs;
        for (const t of [0, 5, 9_999, 10_000, 39_999]) {
          must(await o.claimDue({ nowMs: t, limit: 10, leaseMs: 1 }));
          const now = (await entry(o, refOf("r1"))).dueAtMs;
          expect(now).toBeGreaterThanOrEqual(last);
          last = now;
        }
        expect(last).toBe(10_000 + LEASE);
      }));

    it("اجاره قفل نیست: recordFailure روی رکوردِ اجاره‌شده سررسیدِ خودش را می‌گذارد (اجاره را کوتاه می‌کند) و تلاش را +۱ می‌کند", () =>
      fresh(async (o) => {
        await seed(o, [["r1", 1_000]]);
        const [snap] = must(await o.claimDue({ nowMs: 10_000, limit: 10, leaseMs: 600_000 }));
        expect(snap?.dueAtMs).toBe(610_000);
        expect(must(await o.recordFailure(refOf("r1"), { errorCode: "STORE_FAILURE", dueAtMs: 40_000 }))).toEqual({ attempts: 1 });
        expect(await entry(o, refOf("r1"))).toMatchObject({ attempts: 1, dueAtMs: 40_000, lastErrorCode: "STORE_FAILURE" });
        expect(ids(must(await o.claimDue({ nowMs: 40_000, limit: 10, leaseMs: LEASE })))).toEqual(["r1"]);
      }));

    it("عکسِ claimDue با CAS ِ recordFailure (ADR-0028) سازگار است: attempts در گرفتن عوض نمی‌شود، پس expectedAttempts عکس معتبر می‌ماند", () =>
      fresh(async (o) => {
        await seed(o, [["r1", 1_000]]);
        must(await o.recordFailure(refOf("r1"), { errorCode: "STORE_FAILURE", dueAtMs: 2_000 }));
        const [snap] = must(await o.claimDue({ nowMs: 10_000, limit: 10, leaseMs: LEASE }));
        expect(snap?.attempts).toBe(1);
        const f = { errorCode: "STORE_FAILURE", dueAtMs: 90_000, expectedAttempts: snap?.attempts as number };
        expect(must(await o.recordFailure(refOf("r1"), f))).toEqual({ attempts: 2, replayed: false });
        expect(must(await o.recordFailure(refOf("r1"), f))).toEqual({ attempts: 2, replayed: true });
      }));

    it("اجاره قفل نیست: recordCharge، recordClose، resolveClose، finish و bury روی رکوردِ اجاره‌شده کار می‌کنند؛ done دیگر هرگز گرفته نمی‌شود", () =>
      fresh(async (o) => {
        await seed(o, [["a", 1_000], ["b", 1_000], ["c", 1_000]]);
        must(await o.claimDue({ nowMs: 10_000, limit: 10, leaseMs: LEASE }));
        expect(must(await o.recordCharge(refOf("a"), { attemptId: "x1", amount: 7 }))).toEqual({ replayed: false });
        expect(must(await o.resolveClose(refOf("a")))).toMatchObject({ state: "settling", close: { remainder: "release", origin: "sweeper" } });
        expect(must(await o.finish(refOf("a"), 11_000))).toEqual({ replayed: false });
        expect(must(await o.recordClose(refOf("b"), { remainder: "forfeit", origin: "caller" }))).toEqual({ replayed: false });
        expect(must(await o.bury(refOf("c"), { reason: "EXPIRED_UNBILLED", errorCode: "RESERVATION_EXPIRED", atMs: 11_000 }))).toEqual({ replayed: false });
        expect(ids(must(await o.claimDue({ nowMs: 10_000 + 3 * LEASE, limit: 10, leaseMs: LEASE })))).toEqual(["b"]);
      }));

    it("begin تکراریِ هم‌محتوا (تلاشِ دوبارهٔ درون‌خطی) سررسیدِ اجاره‌شده را بازنمی‌گرداند", () =>
      fresh(async (o) => {
        await seed(o, [["r1", 1_000]]);
        must(await o.claimDue({ nowMs: 10_000, limit: 10, leaseMs: LEASE }));
        expect(must(await o.begin(beginOf({ reservationId: "r1", dueAtMs: 1 })))).toEqual({ replayed: true });
        expect((await entry(o, refOf("r1"))).dueAtMs).toBe(10_000 + LEASE);
      }));

    it("رکوردهای ناسررسیده و شمارش‌ها دست‌نخورده؛ گرفتن بر شمارشِ وضعیت‌ها اثری ندارد", () =>
      fresh(async (o) => {
        await seed(o, [["due", 1_000], ["later", 80_000]]);
        const before = await entry(o, refOf("later"));
        must(await o.claimDue({ nowMs: 10_000, limit: 10, leaseMs: LEASE }));
        expect(await entry(o, refOf("later"))).toEqual(before);
        expect(must(await o.counts())).toEqual({ open: 2, settling: 0, done: 0, dead: 0 });
      }));

    it("رکوردِ مستأجرهای دیگر هم در همان گذر گرفته می‌شود (رفتگر سراسری است) و ترتیب بر پایهٔ (سررسید، مستأجر، حساب، رزرو) است", () =>
      fresh(async (o) => {
        must(await o.begin(beginOf({ tenantId: "t2", accountId: "a1", reservationId: "r1", dueAtMs: 500 })));
        must(await o.begin(beginOf({ tenantId: "t1", accountId: "a2", reservationId: "r1", dueAtMs: 500 })));
        must(await o.begin(beginOf({ tenantId: "t1", accountId: "a1", reservationId: "r1", dueAtMs: 500 })));
        const got = must(await o.claimDue({ nowMs: 10_000, limit: 10, leaseMs: LEASE }));
        expect(got.map((e) => `${e.tenantId}/${e.accountId}/${e.reservationId}`)).toEqual(["t1/a1/r1", "t1/a2/r1", "t2/a1/r1"]);
      }));
  });

  describe(`${label} · قرارداد اجاره (claimDue) · دقتِ شناسهٔ رکورد`, () => {
    it("رزروِ هم‌شناسه در حساب/مستأجرِ دیگر یک رکوردِ جداست: گرفتنِ یکی (limit=۱) دیگری را اجاره نمی‌کند", () =>
      fresh(async (o) => {
        must(await o.begin(beginOf({ tenantId: "t1", accountId: "a1", reservationId: "r1", dueAtMs: 500 })));
        must(await o.begin(beginOf({ tenantId: "t1", accountId: "a2", reservationId: "r1", dueAtMs: 600 })));
        must(await o.begin(beginOf({ tenantId: "t2", accountId: "a1", reservationId: "r1", dueAtMs: 700 })));
        must(await o.begin(beginOf({ tenantId: "t1", accountId: "a1", reservationId: "r2", dueAtMs: 800 })));
        const got = must(await o.claimDue({ nowMs: 10_000, limit: 1, leaseMs: LEASE }));
        expect(got.map((e) => `${e.tenantId}/${e.accountId}/${e.reservationId}`)).toEqual(["t1/a1/r1"]);
        const due = async (t: string, a: string, r: string) => (await entry(o, { tenantId: t, accountId: a, reservationId: r })).dueAtMs;
        expect(await due("t1", "a1", "r1")).toBe(10_000 + LEASE);
        expect(await due("t1", "a2", "r1")).toBe(600);
        expect(await due("t2", "a1", "r1")).toBe(700);
        expect(await due("t1", "a1", "r2")).toBe(800);
      }));
  });

  describe(`${label} · قرارداد اجاره (claimDue) · مرزها و ورودیِ نامعتبر`, () => {
    it("مرزهای معتبر: leaseMs=۱ و ۸۶٬۴۰۰٬۰۰۰، limit=۱ و ۱۰۰۰", () =>
      fresh(async (o) => {
        await seed(o, [["r1", 1], ["r2", 1], ["r3", 1], ["r4", 1]]);
        expect(must(await o.claimDue({ nowMs: 10, limit: 1, leaseMs: 1 }))[0]?.dueAtMs).toBe(11);
        expect(must(await o.claimDue({ nowMs: 10, limit: 1000, leaseMs: 86_400_000 })).map((e) => e.dueAtMs)).toEqual([86_400_010, 86_400_010, 86_400_010]);
      }));

    it("بالاترین زمانِ ممکن: now + lease == Number.MAX_SAFE_INTEGER پذیرفته می‌شود (دامنهٔ ستون)", () =>
      fresh(async (o) => {
        await seed(o, [["r1", 1_000]]);
        const got = must(await o.claimDue({ nowMs: MAX_SAFE - 1, limit: 1, leaseMs: 1 }));
        expect(got[0]?.dueAtMs).toBe(MAX_SAFE);
        expect((await entry(o, refOf("r1"))).dueAtMs).toBe(MAX_SAFE);
      }));

    const bad: readonly (readonly [string, unknown])[] = [
      ["null", null],
      ["undefined", undefined],
      ["آرایه", []],
      ["رشته", "x"],
      ["بی‌nowMs", { limit: 1, leaseMs: 1 }],
      ["nowMs منفی", { nowMs: -1, limit: 1, leaseMs: 1 }],
      ["nowMs اعشاری", { nowMs: 1.5, limit: 1, leaseMs: 1 }],
      ["nowMs رشته", { nowMs: "10", limit: 1, leaseMs: 1 }],
      ["nowMs NaN", { nowMs: Number.NaN, limit: 1, leaseMs: 1 }],
      ["nowMs ناایمن", { nowMs: MAX_SAFE + 1, limit: 1, leaseMs: 1 }],
      ["limit صفر", { nowMs: 1, limit: 0, leaseMs: 1 }],
      ["limit ۱۰۰۱", { nowMs: 1, limit: 1001, leaseMs: 1 }],
      ["limit اعشاری", { nowMs: 1, limit: 1.5, leaseMs: 1 }],
      ["limit رشته", { nowMs: 1, limit: "1", leaseMs: 1 }],
      ["بی‌limit", { nowMs: 1, leaseMs: 1 }],
      ["leaseMs صفر", { nowMs: 1, limit: 1, leaseMs: 0 }],
      ["leaseMs منفی", { nowMs: 1, limit: 1, leaseMs: -1 }],
      ["leaseMs اعشاری", { nowMs: 1, limit: 1, leaseMs: 1.5 }],
      ["leaseMs رشته", { nowMs: 1, limit: 1, leaseMs: "5" }],
      ["leaseMs NaN", { nowMs: 1, limit: 1, leaseMs: Number.NaN }],
      ["leaseMs بی‌نهایت", { nowMs: 1, limit: 1, leaseMs: Number.POSITIVE_INFINITY }],
      ["leaseMs بالای سقف", { nowMs: 1, limit: 1, leaseMs: 86_400_001 }],
      ["بی‌leaseMs", { nowMs: 1, limit: 1 }],
      ["leaseMs undefined", { nowMs: 1, limit: 1, leaseMs: undefined }],
      ["now + lease ناایمن", { nowMs: MAX_SAFE, limit: 1, leaseMs: 1 }],
      ["now + lease ناایمنِ مرزی", { nowMs: MAX_SAFE - 5, limit: 1, leaseMs: 6 }],
    ];
    it.each(bad)("ورودیِ نامعتبر (%s) ⇒ INVALID_INPUT و هیچ رکوردی گرفته نمی‌شود", (_name, query) =>
      fresh(async (o) => {
        await seed(o, [["r1", 1]]);
        const r = await o.claimDue(query as never);
        expect(code(r)).toBe("INVALID_INPUT");
        expect(must(await o.listDue({ nowMs: 10, limit: 10 }))).toHaveLength(1);
        expect((await entry(o, refOf("r1"))).dueAtMs).toBe(1);
      }),
    );

    it("پیامِ خطا ثابت و بی‌پژواکِ مقدارِ ورودی است", () =>
      fresh(async (o) => {
        const r = await o.claimDue({ nowMs: 777_123_456, limit: 424_242, leaseMs: -9_999 } as never);
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.message).not.toMatch(/777|424|9999/);
          expect(Object.isFrozen(r.error)).toBe(true);
        }
      }));

    it("ورودیِ بدجنس (getter پرتاب‌کننده) ⇒ INVALID_INPUT، نه پرتاب", () =>
      fresh(async (o) => {
        const evil = { nowMs: 10, limit: 1, get leaseMs(): number { throw new Error("boom"); } };
        expect(code(await o.claimDue(evil as never))).toBe("INVALID_INPUT");
      }));
  });
}
