/**
 * آزمون خاصیتی (ADR-0020): ترتیب‌های تصادفی و خصمانهٔ تماس/اعطا/گذر زمان، با نتیجه‌های تصادفیِ دروازه (موفق، بی‌هزینه، گران‌تر از رزرو،
 * خطا، پرتاب، گزارش‌های جزئی) و خطای تزریقیِ دفتر و استفادهٔ دوبارهٔ دامنه. پس از **هر** عملیات ناوردای پول سنجیده می‌شود:
 *  ۱. checkInvariants و بازپخش ژورنال = حالت؛ بقا: اعطا = موجود + نگه‌داشته + مصرف + سوخته.
 *  ۲. هر تماس به دروازهٔ درونی دقیقاً یک رزروِ تازه و موفق پشت سرش دارد (رسید `reservationId ≠ null`)؛ رد پیش از رزرو = بی‌تماس.
 *  ۳. جمع `charged` رسیدها = `totals.charged` دفتر (هیچ مصرفِ بی‌رسید و هیچ رسیدِ بی‌مصرف).
 *  ۴. هر رسید یکی از خروجی‌های اعلام‌شده است و زنگ‌هایش با خروجی سازگار.
 * مولد باید همهٔ خروجی‌ها و زنگ‌ها را بسازد (ادعای پوشش در پایان) تا «سبزِ بی‌اثر» نشود.
 */
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@/modules/ledger";
import type { AccountStore } from "@/modules/ledger";
import { createMeteredGateway } from "./index";
import type { MeteringAlarm, MeteringOutcome, MeteringReceipt } from "./index";
import { KEY, auditLedger } from "./integration-kit";
import { REQUEST, config, errResult, fakeGateway, flakyLedger, fundedLedger, okResult, report } from "./test-kit";
import { dbDescribe, openPgStore } from "./test-db";

const SEEDS = 40;
const OPS = 40;
const PG_SEEDS = 4;
const PG_OPS = 25;

function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

const seen = { outcomes: new Map<string, number>(), alarms: new Map<string, number>() };
const bump = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);

const COMPATIBLE: Readonly<Record<MeteringOutcome, readonly MeteringAlarm[]>> = {
  billed: ["SHORTFALL", "CLOSE_PENDING"],
  released: ["COST_UNKNOWN", "SHORTFALL"],
  forfeited: ["COST_UNKNOWN", "SHORTFALL"],
  refused: [],
  unbilled: ["COST_UNKNOWN", "UNBILLED", "SHORTFALL"],
  "settlement-failed": ["COST_UNKNOWN", "SETTLEMENT_PENDING", "SHORTFALL"],
};

async function runSeed(seed: number, ops: number, store: AccountStore): Promise<void> {
  const r = prng(seed * 104729);
  const f = await fundedLedger(2000 + Math.floor(r() * 3000), store);
  let grants = 0;
  let sumCharged = 0;
  let innerCalls = 0;
  let reservedReceipts = 0;
  let scopeCounter = 0;
  let lastScope = "s0";

  for (let i = 0; i < ops; i++) {
    const roll = r();
    if (roll < 0.1) {
      const g = await f.ledger.grant({ ...KEY, grantId: `g${++grants}`, unit: "IRR_MICROS", amount: 1 + Math.floor(r() * 2000), source: "promo" });
      expect(g.ok, `بذر ${seed} عملیات ${i}: اعطا`).toBe(true);
    } else if (roll < 0.15) {
      f.clock.advance(Math.floor(r() * 90_000));
    } else {
      const worstClock = r() < 0.12; // انقضا در حین تماس
      const reuse = r() < 0.08; // دامنهٔ تکراری
      const scopeId = reuse ? lastScope : `s${++scopeCounter}`;
      lastScope = scopeId;
      const pick = r();
      const cost = Math.floor(r() * 400);
      const step =
        pick < 0.3 ? okResult(cost)
        : pick < 0.38 ? okResult(300 + Math.floor(r() * 400)) // شاید از رزرو بیشتر
        : pick < 0.45 ? okResult(null)
        : pick < 0.55 ? okResult(cost, { report: report({ spend: [{ currency: "IRR", micros: cost }] }) })
        : pick < 0.65 ? okResult(1, { report: report({ costUnknownAttempts: 1, spend: [{ currency: "IRR", micros: cost }] }) })
        : pick < 0.72 ? errResult("TIMEOUT")
        : pick < 0.8 ? errResult("INVALID_REQUEST")
        : pick < 0.86 ? errResult("PROVIDER_UNAVAILABLE", { report: report({ spend: [], costUnknownAttempts: 2 }) })
        : pick < 0.9 ? new Error("boom")
        : pick < 0.94 ? okResult(5, { report: report({ spend: [{ currency: "USD", micros: 5 }] }) })
        : null;
      const inner = fakeGateway(() => {
        innerCalls++;
        if (worstClock) f.clock.advance(60_001);
        return step;
      });
      const faultRoll = r();
      const plan: Parameters<typeof flakyLedger>[1] =
        faultRoll < 0.05 ? { reserve: { fail: 99 } }
        : faultRoll < 0.12 ? { charge: { fail: 99 } }
        : faultRoll < 0.18 ? { charge: { fail: 1 + Math.floor(r() * 2) } }
        : faultRoll < 0.24 ? { close: { fail: 99 } }
        : faultRoll < 0.28 ? { close: { fail: 99, mode: "throw" } }
        : {};
      const made = createMeteredGateway(config(flakyLedger(f.ledger, plan), inner, { scopeId, onUnknownCost: r() < 0.5 ? "forfeit" : "release" }));
      if (!made.ok) throw new Error(made.error.issues.join(";"));
      const small = r() < 0.7;
      const input = { ...REQUEST, maxOutputTokens: small ? 20 + Math.floor(r() * 80) : 300 + Math.floor(r() * 600), messages: [{ role: "user", content: "x".repeat(Math.floor(r() * 60)) }] };

      const before = innerCalls;
      const res = await made.value.complete(input);
      const m: MeteringReceipt = res.ok ? res.value.metering : res.error.metering;
      const where = `بذر ${seed} عملیات ${i}`;

      bump(seen.outcomes, m.outcome);
      for (const a of m.alarms) bump(seen.alarms, a);
      expect(Object.keys(COMPATIBLE), where).toContain(m.outcome);
      for (const a of m.alarms) expect([...COMPATIBLE[m.outcome], "COST_UNKNOWN"], `${where}: زنگ ${a} با ${m.outcome}`).toContain(a);
      // ۲. بی‌رزرو ⇒ بی‌تماس؛ تماس ⇒ رزرو
      if (m.reservationId === null) expect(innerCalls, `${where}: تماسِ بی‌رزرو`).toBe(before);
      else {
        expect(innerCalls, `${where}: رزرو بی‌تماس`).toBe(before + 1);
        reservedReceipts++;
      }
      if (m.outcome === "refused") expect([m.reserved, m.charged], where).toEqual([0, 0]);
      expect(m.charged, where).toBeLessThanOrEqual(m.reserved);
      sumCharged += m.charged;

      // ۱ و ۳
      const a = await auditLedger(f.store);
      expect(a.charged, `${where}: جمع رسیدها ≠ دفتر`).toBe(sumCharged);
    }
  }
  expect(reservedReceipts).toBeGreaterThan(0);
}

describe("metering · آزمون خاصیتی (حافظه‌ای): ناوردای پول تحت ترتیب‌های تصادفی و خطای تزریقی", () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`بذر ${seed}: ${OPS} عملیات تصادفی/خصمانه`, async () => {
      await runSeed(seed, OPS, createMemoryStore());
    });
  }
});

dbDescribe("metering · آزمون خاصیتی (PostgreSQL): همان ناوردا روی ذخیرهٔ واقعی", () => {
  for (let seed = 1; seed <= PG_SEEDS; seed++) {
    it(`بذر ${seed}: ${PG_OPS} عملیات (شِمای یک‌بارمصرفِ تازه)`, async () => {
      const pg = await openPgStore(4);
      try {
        await runSeed(seed + 1000, PG_OPS, pg.store);
      } finally {
        await pg.dispose();
      }
    });
  }
});

describe("metering · ادعای پوشش مولد (مولدِ ضعیف تست را بی‌اثر می‌کند)", () => {
  it("همهٔ خروجی‌ها و همهٔ زنگ‌ها واقعاً ساخته شدند", () => {
    for (const o of ["billed", "released", "forfeited", "refused", "unbilled", "settlement-failed"]) expect(seen.outcomes.get(o) ?? 0, `خروجی ${o}`).toBeGreaterThan(0);
    for (const a of ["SHORTFALL", "COST_UNKNOWN", "UNBILLED", "SETTLEMENT_PENDING", "CLOSE_PENDING"]) expect(seen.alarms.get(a) ?? 0, `زنگ ${a}`).toBeGreaterThan(0);
    expect(seen.outcomes.get("billed") ?? 0).toBeGreaterThan(100);
  });
});
