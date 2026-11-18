/**
 * تأیید رسیدگی به مرده‌ها (ADR-0025) روی outbox حافظه‌ای: قرارداد مشترک + آزمونِ خاصیتی در برابر مدلِ مرجعِ مستقل (بی‌پایگاه).
 * نسخهٔ PostgreSQL همین قرارداد را در `pg/dead-ack.pg.test.ts` می‌گذراند و در برابر این پیاده‌سازی «تفاضلی» سنجیده می‌شود.
 */
import { describe, expect, it } from "vitest";
import { describeDeadAckContract } from "./contract/dead-ack-contract";
import { createMemoryOutbox } from "./memory-outbox";
import type { OutboxResult, ReservationRef } from "./types";

describeDeadAckContract("memory", async () => ({ outbox: createMemoryOutbox() }));

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const must = <T>(r: OutboxResult<T>): T => {
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};

describe("settlement · تأیید رسیدگی · خاصیتی (حافظه‌ای در برابر مدلِ مرجع)", () => {
  const REFS: readonly ReservationRef[] = ["t1", "T1"].flatMap((tenantId) => ["a1", "a.1"].flatMap((accountId) => ["r1", "R1", "r.1", "r-1", "r_1"].map((reservationId) => ({ tenantId, accountId, reservationId }))));
  const key = (r: ReservationRef): string => `${r.tenantId}|${r.accountId}|${r.reservationId}`;

  it.each(Array.from({ length: 30 }, (_, i) => [i + 1]))("بذر %i: ناوردهای «تأییدشده‌ها ⊆ مرده‌ها»، «تأییدشده برنمی‌گردد»، «تأییدنشده‌ها = مرده‌ها − تأییدشده‌ها» و بی‌اثریِ تأیید بر listDead", async (seed) => {
    const r = rng(seed * 7919);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
    const o = createMemoryOutbox();
    // مدلِ مرجع (ساده و مستقل از پیاده‌سازی)
    const state = new Map<string, "open" | "settling" | "done" | "dead">();
    const deadAt = new Map<string, number>();
    const acked = new Set<string>();

    for (let step = 0; step < 220; step += 1) {
      const ref = pick(REFS);
      const k = key(ref);
      const w = r();
      if (w < 0.2) {
        expect((await o.begin({ ...ref, unit: "IRR_MICROS", reserved: 5, createdAtMs: 0, expiresAtMs: 50, dueAtMs: 5, orphanRemainder: "forfeit" })).ok).toBe(true);
        if (!state.has(k)) state.set(k, "open");
      } else if (w < 0.4) {
        // حالتِ فعال/done را از خودِ پورت می‌خوانیم (قراردادِ پایه)؛ آنچه مدلِ مستقل پیش‌بینی می‌کند فقط مرگ و تأیید است.
        if (w < 0.3) await o.recordCharge(ref, { attemptId: "a1", amount: 3 });
        else if ((await o.recordClose(ref, { remainder: "release", origin: "caller" })).ok) await o.finish(ref, 9);
        const e = must(await o.get(ref));
        if (e !== null && state.get(k) !== "dead") state.set(k, e.state);
      } else if (w < 0.6) {
        const at = pick([1, 5, 5, 9]);
        const res = await o.bury(ref, { reason: "LEDGER_REJECTED", errorCode: null, atMs: at });
        const was = state.get(k);
        if (was === "open" || was === "settling") {
          expect(res).toEqual({ ok: true, value: { replayed: false } });
          state.set(k, "dead");
          deadAt.set(k, at);
        } else if (was === "dead") expect(res).toEqual({ ok: true, value: { replayed: true } });
        else expect(res).toMatchObject({ ok: false, error: { code: was === undefined ? "NOT_FOUND" : "NOT_ACTIVE" } });
      } else if (w < 0.85) {
        const res = await o.acknowledgeDead(ref, { atMs: pick([1, 50, 70]) });
        const was = state.get(k);
        if (was === "dead") {
          expect(res).toEqual({ ok: true, value: { replayed: acked.has(k) } });
          acked.add(k);
        } else expect(res).toMatchObject({ ok: false, error: { code: was === undefined ? "NOT_FOUND" : "CONFLICT" } });
      }

      // ناوردها پس از هر گام
      const dead = [...state].filter(([, s]) => s === "dead").map(([x]) => x);
      const un = must(await o.listUnacknowledgedDead({ limit: 1000 })).map(key);
      expect([...un].sort()).toEqual(dead.filter((x) => !acked.has(x)).sort());
      expect(un.every((x) => !acked.has(x))).toBe(true);
      const all = must(await o.listDead({ limit: 1000 })).map(key);
      expect([...all].sort()).toEqual([...dead].sort());
      const order = un.map((x) => [deadAt.get(x) ?? 0, x] as const);
      expect(order).toEqual([...order].sort((p, q) => p[0] - q[0] || (p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0)));
    }
  });
});
