/**
 * آزمون قرارداد «تأیید رسیدگی به مرده‌ها» (ADR-0025) — بخشی از پورت `SettlementOutbox`: `listUnacknowledgedDead` و `acknowledgeDead`.
 * هر پیاده‌سازی (حافظه‌ای، PostgreSQL) باید آن را **بی‌تغییر** بگذراند. از index صادر نمی‌شود و آزمونِ محصول نیست (پوشهٔ `contract/`
 * عمداً بیرون از فهرستِ فایل‌های منبعِ `purity.test.ts` است). قرارداد پایهٔ پورت (`../outbox-contract.ts`) دست نخورده است.
 *
 * ناوردای محوری: **زنگِ عملیاتی دست‌کم یک‌بار می‌رسد.** تا تأیید ثبت نشده رکورد در `listUnacknowledgedDead` می‌ماند (مرگِ فرایندِ میانِ «فهرست» و «تأیید»
 * چیزی را گم نمی‌کند)، و تأیید فقط یک‌بار و فقط برای رکوردِ مرده ممکن است.
 */
import { describe, expect, it } from "vitest";
import { beginOf, refOf, type OutboxHarness } from "../outbox-contract";
import type { OutboxEntry, OutboxResult, ReservationRef, SettlementOutbox } from "../types";

function must<T>(r: OutboxResult<T>): T {
  if (!r.ok) throw new Error(`انتظار موفقیت بود: ${r.error.code}`);
  return r.value;
}
const code = (r: OutboxResult<unknown>): string => (r.ok ? "ok" : r.error.code);
const idOf = (e: { reservationId: string }): string => e.reservationId;

/** رکوردِ تازه را آغاز و (در صورت `atMs`) دفن می‌کند؛ شناسهٔ رکورد برمی‌گردد. */
async function dead(o: SettlementOutbox, id: string, atMs = 1_000, over: Record<string, unknown> = {}): Promise<ReservationRef> {
  const ref = refOf(id, over);
  must(await o.begin(beginOf({ ...over, reservationId: id })));
  must(await o.bury(ref, { reason: "LEDGER_REJECTED", errorCode: null, atMs }));
  return ref;
}
const unacked = async (o: SettlementOutbox, limit = 1000): Promise<readonly OutboxEntry[]> => must(await o.listUnacknowledgedDead({ limit }));
const keyOf = (e: ReservationRef): string => `${e.tenantId}\u0000${e.accountId}\u0000${e.reservationId}`;

export function describeDeadAckContract(label: string, make: () => Promise<OutboxHarness>): void {
  const fresh = async (fn: (o: SettlementOutbox) => Promise<void>): Promise<void> => {
    const h = await make();
    try {
      await fn(h.outbox);
    } finally {
      await h.dispose?.();
    }
  };

  describe(`${label} · قرارداد تأیید رسیدگی · فهرست و تأیید`, () => {
    it("outbox تازه: فهرستِ تأییدنشده خالی و منجمد است", () =>
      fresh(async (o) => {
        const r = must(await o.listUnacknowledgedDead({ limit: 10 }));
        expect(r).toEqual([]);
        expect(Object.isFrozen(r)).toBe(true);
      }));

    it("رکوردِ مرده تأییدنشده است؛ تأیید آن را از این فهرست بیرون می‌برد ولی listDead، get و counts دست‌نخورده می‌مانند", () =>
      fresh(async (o) => {
        const ref = await dead(o, "r1", 5);
        const before = must(await o.get(ref));
        const list = await unacked(o);
        expect(list).toHaveLength(1);
        expect(list[0]).toEqual(before);
        expect(list[0]?.state).toBe("dead");

        expect(await o.acknowledgeDead(ref, { atMs: 50 })).toEqual({ ok: true, value: { replayed: false } });

        expect(await unacked(o)).toEqual([]);
        expect(must(await o.listDead({ limit: 10 }))).toEqual([before]);
        expect(must(await o.get(ref))).toEqual(before);
        expect(must(await o.counts())).toEqual({ open: 0, settling: 0, done: 0, dead: 1 });
      }));

    it("تحویلِ دست‌کم‌یک‌بار: فهرست‌کردن بی‌تأیید (مرگِ فرایند پیش از رسیدنِ زنگ) هیچ رکوردی را از فهرست بیرون نمی‌برد", () =>
      fresh(async (o) => {
        await dead(o, "r1", 5);
        await dead(o, "r2", 6);
        const first = await unacked(o);
        for (let i = 0; i < 3; i += 1) expect(await unacked(o)).toEqual(first);
        expect(first.map(idOf)).toEqual(["r1", "r2"]);
      }));

    it("تکرار تأیید ⇒ replayed (حتی با زمانِ دیگر)؛ هرگز CONFLICT نمی‌شود چون تکرارِ پس از قطعِ مبهم باید بی‌ضرر باشد", () =>
      fresh(async (o) => {
        const ref = await dead(o, "r1");
        expect(await o.acknowledgeDead(ref, { atMs: 10 })).toEqual({ ok: true, value: { replayed: false } });
        expect(await o.acknowledgeDead(ref, { atMs: 10 })).toEqual({ ok: true, value: { replayed: true } });
        expect(await o.acknowledgeDead(ref, { atMs: 99_999 })).toEqual({ ok: true, value: { replayed: true } });
        expect(await unacked(o)).toEqual([]);
      }));

    it("بی‌رکورد ⇒ NOT_FOUND و چیزی ساخته نمی‌شود", () =>
      fresh(async (o) => {
        expect(await o.acknowledgeDead(refOf("ghost"), { atMs: 1 })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
        expect(must(await o.counts())).toEqual({ open: 0, settling: 0, done: 0, dead: 0 });
        expect(await unacked(o)).toEqual([]);
      }));

    it("رکوردِ غیرمرده (open، settling با قصدِ مصرف، settling با قصدِ بستن، done) ⇒ CONFLICT و رکورد دست‌نخورده؛ پس از مرگ همان رکورد تأیید می‌شود", () =>
      fresh(async (o) => {
        const refs = { open: refOf("r-open"), charged: refOf("r-charged"), closing: refOf("r-closing"), done: refOf("r-done") };
        for (const [id, ref] of Object.entries(refs)) must(await o.begin(beginOf({ reservationId: ref.reservationId, createdAtMs: id.length })));
        must(await o.recordCharge(refs.charged, { attemptId: "a1", amount: 7 }));
        must(await o.recordClose(refs.closing, { remainder: "release", origin: "caller" }));
        must(await o.recordClose(refs.done, { remainder: "release", origin: "caller" }));
        must(await o.finish(refs.done, 40));

        for (const ref of Object.values(refs)) {
          const before = must(await o.get(ref));
          expect(await o.acknowledgeDead(ref, { atMs: 5 }), ref.reservationId).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
          expect(must(await o.get(ref)), ref.reservationId).toEqual(before);
        }
        expect(await unacked(o)).toEqual([]);

        // تعارض «مسموم» نمی‌کند: رکورد فعال بعداً می‌میرد و آن‌گاه فهرست و تأیید کار می‌کنند.
        must(await o.bury(refs.charged, { reason: "ATTEMPTS_EXHAUSTED", errorCode: "STORE_FAILURE", atMs: 77 }));
        expect((await unacked(o)).map(idOf)).toEqual(["r-charged"]);
        expect(await o.acknowledgeDead(refs.charged, { atMs: 80 })).toEqual({ ok: true, value: { replayed: false } });
        expect(await unacked(o)).toEqual([]);
      }));

    it("هویتِ رکورد سه‌بخشی است: تأییدِ یک مستأجر/حساب، رکوردِ هم‌نامِ دیگری را تأیید نمی‌کند", () =>
      fresh(async (o) => {
        const a = await dead(o, "r1", 5, { tenantId: "t1", accountId: "a1" });
        await dead(o, "r1", 5, { tenantId: "t1", accountId: "a2" });
        await dead(o, "r1", 5, { tenantId: "t2", accountId: "a1" });
        expect(await unacked(o)).toHaveLength(3);
        must(await o.acknowledgeDead(a, { atMs: 9 }));
        const left = await unacked(o);
        expect(left.map((e) => `${e.tenantId}/${e.accountId}`).sort()).toEqual(["t1/a2", "t2/a1"]);
      }));

    it("پس از تأیید: دفنِ دوباره با همان دلیل ⇒ replayed و رکورد بازنمی‌گردد؛ با دلیل دیگر ⇒ CONFLICT و باز هم تأییدشده می‌ماند", () =>
      fresh(async (o) => {
        const ref = await dead(o, "r1", 5);
        must(await o.acknowledgeDead(ref, { atMs: 9 }));
        expect(await o.bury(ref, { reason: "LEDGER_REJECTED", errorCode: null, atMs: 500 })).toEqual({ ok: true, value: { replayed: true } });
        expect(await o.bury(ref, { reason: "EXPIRED_UNBILLED", errorCode: null, atMs: 500 })).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
        expect(await unacked(o)).toEqual([]);
        expect(must(await o.get(ref))).toMatchObject({ state: "dead", settledAtMs: 5 });
      }));

    it("خروجیِ فهرست و رکوردها منجمدند و دستکاری‌شان حالتِ درونی را عوض نمی‌کند", () =>
      fresh(async (o) => {
        await dead(o, "r1", 5);
        const list = await unacked(o);
        expect(Object.isFrozen(list)).toBe(true);
        expect(Object.isFrozen(list[0])).toBe(true);
        expect(() => {
          (list as OutboxEntry[]).push(list[0] as OutboxEntry);
        }).toThrow();
        expect(await unacked(o)).toHaveLength(1);
      }));
  });

  describe(`${label} · قرارداد تأیید رسیدگی · ترتیب و صفحه‌بندی`, () => {
    // ترتیب: (زمان مرگ، شناسه) با مقایسهٔ نقطه‌کد (COLLATE "C")؛ شناسه‌ها عمداً حرف بزرگ/کوچک و علامت دارند.
    const PLAN: readonly (readonly [string, number])[] = [
      ["r.b", 30],
      ["R.a", 10],
      ["r-c", 20],
      ["r1", 10],
      ["r_2", 10],
      ["r:3", 20],
      ["r.a", 30],
      ["Z9", 0],
    ];
    const expected = [...PLAN].sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map((x) => x[0]);

    it("ترتیبِ (زمان مرگ، شناسه) و سقفِ limit؛ و هم‌ترتیب با listDead", () =>
      fresh(async (o) => {
        for (const [id, at] of PLAN) await dead(o, id, at);
        expect((await unacked(o)).map(idOf)).toEqual(expected);
        expect((await unacked(o, 3)).map(idOf)).toEqual(expected.slice(0, 3));
        expect((await unacked(o, 1)).map(idOf)).toEqual(expected.slice(0, 1));
        expect(must(await o.listDead({ limit: 1000 })).map(idOf)).toEqual(expected);
      }));

    it("تخلیهٔ صفحه‌ای: «فهرست ← تأیید» تا خالی‌شدن، هر رکورد دقیقاً یک‌بار و به ترتیب؛ listDead کامل می‌ماند", () =>
      fresh(async (o) => {
        for (const [id, at] of PLAN) await dead(o, id, at);
        const seen: string[] = [];
        for (let guard = 0; guard < 20; guard += 1) {
          const page = await unacked(o, 3);
          if (page.length === 0) break;
          for (const e of page) {
            seen.push(e.reservationId);
            expect(await o.acknowledgeDead(e, { atMs: 1_000 })).toEqual({ ok: true, value: { replayed: false } });
          }
        }
        expect(seen).toEqual(expected);
        expect(await unacked(o)).toEqual([]);
        expect(must(await o.listDead({ limit: 1000 })).map(idOf)).toEqual(expected);
      }));

    it("رکوردِ مرده پس از آغازِ تخلیه هم دیده می‌شود (مرگِ تازه میانِ صفحه‌ها گم نمی‌شود)", () =>
      fresh(async (o) => {
        await dead(o, "r1", 10);
        const [first] = await unacked(o, 1);
        must(await o.acknowledgeDead(first as OutboxEntry, { atMs: 11 }));
        await dead(o, "r2", 12);
        expect((await unacked(o)).map(idOf)).toEqual(["r2"]);
      }));
  });

  describe(`${label} · قرارداد تأیید رسیدگی · ورودی نامعتبر`, () => {
    const HOSTILE = { get atMs(): number { throw new Error("LEAK-CANARY"); } };
    const BAD_ACKS: readonly unknown[] = [null, undefined, 5, "x", [], {}, { atMs: -1 }, { atMs: 1.5 }, { atMs: Number.NaN }, { atMs: Number.POSITIVE_INFINITY }, { atMs: Number.MAX_SAFE_INTEGER + 1 }, { atMs: "5" }, { atMs: null }, HOSTILE];
    const BAD_REFS: readonly unknown[] = [null, undefined, 1, "x", [], {}, { tenantId: "bad id", accountId: "a1", reservationId: "r1" }, { tenantId: "t1", accountId: "a1" }, { tenantId: "t1", accountId: "a1", reservationId: "" }];
    const BAD_QUERIES: readonly unknown[] = [null, undefined, 5, "x", [], {}, { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: 1001 }, { limit: Number.NaN }, { limit: "5" }, { limit: null }];

    it("acknowledgeDead با تأییدِ نامعتبر ⇒ INVALID_INPUT (بی‌پرتاب، بی‌پژواکِ مقدار) و رکورد تأییدنشده می‌ماند", () =>
      fresh(async (o) => {
        const ref = await dead(o, "r1");
        for (const bad of BAD_ACKS) {
          const r = await o.acknowledgeDead(ref, bad as never);
          expect(code(r)).toBe("INVALID_INPUT");
          expect(JSON.stringify(r)).not.toContain("LEAK-CANARY");
        }
        expect((await unacked(o)).map(idOf)).toEqual(["r1"]);
      }));

    it("acknowledgeDead با ارجاعِ نامعتبر ⇒ INVALID_INPUT", () =>
      fresh(async (o) => {
        await dead(o, "r1");
        for (const bad of BAD_REFS) expect(code(await o.acknowledgeDead(bad as never, { atMs: 1 }))).toBe("INVALID_INPUT");
        expect(await unacked(o)).toHaveLength(1);
      }));

    it("listUnacknowledgedDead با پرسشِ نامعتبر ⇒ INVALID_INPUT؛ سقفِ ۱۰۰۰ مجاز است", () =>
      fresh(async (o) => {
        for (const bad of BAD_QUERIES) expect(code(await o.listUnacknowledgedDead(bad as never)), JSON.stringify(bad)).toBe("INVALID_INPUT");
        expect(code(await o.listUnacknowledgedDead({ limit: 1000 }))).toBe("ok");
        expect(code(await o.listUnacknowledgedDead({ limit: 1 }))).toBe("ok");
      }));
  });

  describe(`${label} · قرارداد تأیید رسیدگی · هم‌زمانی`, () => {
    it("۲۰ تأییدِ هم‌زمان روی یک رکورد: دقیقاً یکی تازه (replayed:false) و بقیه replayed:true؛ هیچ خطایی نیست", () =>
      fresh(async (o) => {
        const ref = await dead(o, "r1", 5);
        const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => o.acknowledgeDead(ref, { atMs: 100 + i })));
        expect(rs.every((r) => r.ok)).toBe(true);
        expect(rs.filter((r) => r.ok && !r.value.replayed)).toHaveLength(1);
        expect(rs.filter((r) => r.ok && r.value.replayed)).toHaveLength(19);
        expect(await unacked(o)).toEqual([]);
      }));

    it("تأیید و مرگِ هم‌زمانِ رکوردهای مختلف: هر مرده دقیقاً یک‌بار دیده و تأیید می‌شود", () =>
      fresh(async (o) => {
        const ids = Array.from({ length: 12 }, (_, i) => `r${i}`);
        const refs = await Promise.all(ids.map((id, i) => dead(o, id, i)));
        const rs = await Promise.all(refs.flatMap((ref) => [o.acknowledgeDead(ref, { atMs: 1 }), o.acknowledgeDead(ref, { atMs: 2 })]));
        expect(rs.every((r) => r.ok)).toBe(true);
        expect(rs.filter((r) => r.ok && !r.value.replayed)).toHaveLength(12);
        expect(await unacked(o)).toEqual([]);
        expect(new Set(refs.map(keyOf)).size).toBe(12);
      }));
  });
}
