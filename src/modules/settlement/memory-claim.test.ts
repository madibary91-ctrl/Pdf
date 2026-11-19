/**
 * اجارهٔ رکوردهای سررسیده (ADR-0029) روی outbox حافظه‌ای: قرارداد مشترک + آزمونِ خاصیتی در برابر مدلِ مرجعِ مستقل (بی‌پایگاه).
 * نسخهٔ PostgreSQL همین قرارداد را در `pg/claim.pg.test.ts` می‌گذراند و با این پیاده‌سازی «تفاضلی» سنجیده می‌شود.
 */
import { describe, expect, it } from "vitest";
import { describeClaimContract } from "./contract/claim-contract";
import { createMemoryOutbox } from "./memory-outbox";
import type { OutboxResult, ReservationRef } from "./types";

describeClaimContract("memory", async () => ({ outbox: createMemoryOutbox() }));

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

type Model = { due: number; state: "active" | "final"; attempts: number };
const REFS: readonly ReservationRef[] = ["t1", "T1"].flatMap((tenantId) => ["a1", "a.1"].flatMap((accountId) => ["r1", "R1", "r.1", "r2"].map((reservationId) => ({ tenantId, accountId, reservationId }))));
const key = (r: ReservationRef): string => `${r.tenantId}|${r.accountId}|${r.reservationId}`;
const BEGIN = { unit: "IRR_MICROS", reserved: 500, createdAtMs: 1_000, expiresAtMs: 61_000, orphanRemainder: "forfeit" as const };
const byKey = (a: ReservationRef, b: ReservationRef): number => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);

describe("settlement · اجاره (claimDue) · خاصیتی (حافظه‌ای در برابر مدلِ مرجع)", () => {
  it("۳۰ بذر × ۲۵۰ گام: claimDue/listDue/recordFailure/finish/bury با مدلِ ساده می‌خوانند و سررسید هرگز کم نمی‌شود مگر با recordFailure", async () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rand = rng(seed * 7919);
      const o = createMemoryOutbox();
      const model = new Map<string, Model>();
      let now = 1_000;
      const pick = (): ReservationRef => REFS[Math.floor(rand() * REFS.length)] as ReservationRef;
      for (let step = 0; step < 250; step++) {
        now += Math.floor(rand() * 4_000);
        const roll = rand();
        const ref = pick();
        const m = model.get(key(ref));
        if (roll < 0.25) {
          const due = now - 2_000 + Math.floor(rand() * 6_000);
          const r = await o.begin({ ...ref, ...BEGIN, dueAtMs: Math.max(0, due) });
          if (m === undefined) {
            expect(r.ok).toBe(true);
            model.set(key(ref), { due: Math.max(0, due), state: "active", attempts: 0 });
          } else expect(must(r)).toEqual({ replayed: true });
        } else if (roll < 0.6) {
          const limit = 1 + Math.floor(rand() * 5);
          const lease = 1 + Math.floor(rand() * 9_000);
          const expected = [...model.entries()]
            .filter(([, v]) => v.state === "active" && v.due <= now)
            .map(([k, v]) => ({ k, due: v.due }))
            .sort((x, y) => x.due - y.due || (x.k < y.k ? -1 : x.k > y.k ? 1 : 0))
            .slice(0, limit);
          const got = must(await o.claimDue({ nowMs: now, limit, leaseMs: lease }));
          expect(got.map((e) => key(e))).toEqual(expected.map((e) => e.k));
          for (const e of expected) (model.get(e.k) as Model).due = now + lease;
          for (const e of got) expect(e.dueAtMs).toBe(now + lease);
        } else if (roll < 0.75) {
          const limit = 1 + Math.floor(rand() * 8);
          const want = [...model.entries()]
            .filter(([, v]) => v.state === "active" && v.due <= now)
            .sort(([ka, a], [kb, b]) => a.due - b.due || (ka < kb ? -1 : ka > kb ? 1 : 0))
            .slice(0, limit)
            .map(([k]) => k);
          expect(must(await o.listDue({ nowMs: now, limit })).map((e) => key(e))).toEqual(want);
        } else if (roll < 0.87) {
          const due = now + Math.floor(rand() * 5_000);
          const r = await o.recordFailure(ref, { errorCode: "STORE_FAILURE", dueAtMs: due });
          if (m === undefined) expect(r).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
          else if (m.state === "final") expect(r).toMatchObject({ ok: false, error: { code: "NOT_ACTIVE" } });
          else {
            m.attempts += 1;
            m.due = due;
            expect(must(r)).toEqual({ attempts: m.attempts });
          }
        } else if (roll < 0.94) {
          const c = await o.recordClose(ref, { remainder: "release", origin: "caller" });
          if (m !== undefined && m.state === "active") expect(c.ok).toBe(true);
          const f = await o.finish(ref, now);
          if (m !== undefined && m.state === "active") {
            expect(f.ok).toBe(true);
            m.state = "final";
          }
        } else {
          const b = await o.bury(ref, { reason: "LEDGER_REJECTED", errorCode: "INVALID_INPUT", atMs: now });
          if (m !== undefined && m.state === "active") {
            expect(b.ok).toBe(true);
            m.state = "final";
          }
        }
        // ناوردا: dueAtMs هر رکوردِ فعال با مدل می‌خواند.
        if (step % 25 === 0) {
          for (const r of [...REFS].sort(byKey)) {
            const mm = model.get(key(r));
            const e = must(await o.get(r));
            if (mm === undefined) expect(e).toBeNull();
            else {
              expect(e?.dueAtMs).toBe(mm.due);
              expect(e?.attempts).toBe(mm.attempts);
            }
          }
        }
      }
    }
  }, 60_000);
});
