/**
 * ثبتِ شکستِ تکرارپذیر (ADR-0028) روی outbox حافظه‌ای: قرارداد مشترک + آزمونِ خاصیتی در برابر مدلِ مرجعِ مستقل (بی‌پایگاه).
 * نسخهٔ PostgreSQL همین قرارداد را در `pg/failure-cas.pg.test.ts` می‌گذراند و با این پیاده‌سازی «تفاضلی» سنجیده می‌شود.
 */
import { describe, expect, it } from "vitest";
import { describeFailureCasContract } from "./contract/failure-cas-contract";
import { createMemoryOutbox } from "./memory-outbox";
import type { OutboxResult, ReservationRef } from "./types";

describeFailureCasContract("memory", async () => ({ outbox: createMemoryOutbox() }));

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

describe("settlement · ثبتِ شکستِ تکرارپذیر · خاصیتی (حافظه‌ای در برابر مدلِ مرجع)", () => {
  const REFS: readonly ReservationRef[] = ["t1", "T1"].flatMap((tenantId) => ["a1", "a.1"].flatMap((accountId) => ["r1", "R1", "r.1"].map((reservationId) => ({ tenantId, accountId, reservationId }))));
  const BEGIN = { unit: "IRR_MICROS", reserved: 500, createdAtMs: 1_000, expiresAtMs: 61_000, dueAtMs: 11_000, orphanRemainder: "forfeit" as const };
  const key = (r: ReservationRef): string => `${r.tenantId}|${r.accountId}|${r.reservationId}`;

  it.each(Array.from({ length: 30 }, (_, i) => [i + 1]))("بذر %i: نتیجه و حالتِ هر فراخوان با مدلِ مرجع یکی است؛ attempts هرگز کم نمی‌شود و replayed هیچ‌چیز را عوض نمی‌کند", async (seed) => {
    const r = rng(seed * 104729);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
    const o = createMemoryOutbox();
    // مدلِ مرجع: فقط {attempts، code، due، active}
    const model = new Map<string, { attempts: number; code: string | null; due: number; active: boolean }>();
    for (const ref of REFS) {
      must(await o.begin({ ...ref, ...BEGIN }));
      model.set(key(ref), { attempts: 0, code: null, due: BEGIN.dueAtMs, active: true });
    }
    for (let step = 0; step < 250; step += 1) {
      const ref = pick(REFS);
      const m = model.get(key(ref)) as { attempts: number; code: string | null; due: number; active: boolean };
      const roll = r();
      if (roll < 0.04 && m.active) {
        must(await o.bury(ref, { reason: "LEDGER_REJECTED", errorCode: null, atMs: step }));
        m.active = false;
        m.code = null; // bury(errorCode:null) کدِ آخر را پاک می‌کند (رفتارِ پیشینِ پورت)
        continue;
      }
      const errorCode = pick(["STORE_FAILURE", "INTERNAL_ERROR"]);
      const dueAtMs = 100 + step;
      const mode = r();
      const before = must(await o.get(ref));
      if (mode < 0.15) {
        // بی‌expected: رفتارِ پیشین
        const res = await o.recordFailure(ref, { errorCode, dueAtMs });
        if (!m.active) expect(res).toMatchObject({ ok: false, error: { code: "NOT_ACTIVE" } });
        else {
          m.attempts += 1;
          m.code = errorCode;
          m.due = dueAtMs;
          expect(res).toEqual({ ok: true, value: { attempts: m.attempts } });
        }
      } else {
        // expected: درست، کهنه یا آینده
        const expected = mode < 0.55 ? m.attempts : mode < 0.8 ? Math.max(0, m.attempts - 1 - Math.floor(r() * 3)) : m.attempts + 1 + Math.floor(r() * 3);
        const res = await o.recordFailure(ref, { errorCode, dueAtMs, expectedAttempts: expected });
        if (!m.active) expect(res).toMatchObject({ ok: false, error: { code: "NOT_ACTIVE" } });
        else if (expected === m.attempts) {
          m.attempts += 1;
          m.code = errorCode;
          m.due = dueAtMs;
          expect(res).toEqual({ ok: true, value: { attempts: m.attempts, replayed: false } });
        } else if (expected < m.attempts) {
          expect(res).toEqual({ ok: true, value: { attempts: m.attempts, replayed: true } });
          expect(must(await o.get(ref))).toEqual(before); // replayed ⇒ هیچ‌چیز نوشته نشد
        } else {
          expect(res).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
          expect(must(await o.get(ref))).toEqual(before);
        }
      }
      const e = must(await o.get(ref));
      expect(e).toMatchObject({ attempts: m.attempts, lastErrorCode: m.code, dueAtMs: m.due });
      if (before !== null) expect(e?.attempts).toBeGreaterThanOrEqual(before.attempts);
    }
  });
});
