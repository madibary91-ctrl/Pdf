/**
 * آزمون خاصیتی (ADR-0021): ترتیب‌های تصادفی و خصمانهٔ تماس، اعطا، گذر زمان و رفتگر، با نتیجه‌های تصادفیِ دروازه (موفق، نامعلوم، خطا، پرتاب، **مرگِ فرایند وسط تماس**)
 * و خطای تزریقیِ هم‌زمانِ دفتر و outbox. پس از **هر** عملیات ناوردای پول سنجیده می‌شود (checkInvariants، بازپخش ژورنال، بقا).
 * پس از پایان، خطاها خاموش و رفتگر تا آرامش اجرا می‌شود؛ سپس برای **هر** رزرو:
 *  ۱. هیچ رکوردِ فعال نمی‌ماند؛ رکورد done ⇒ رزرو بسته (نه نگه‌داشته)؛ مرگ ⇒ حتماً در گزارشِ یک گذر (زنگ) آمده است: هیچ مرگی بی‌صدا نیست.
 *  ۲. مصرفِ دفتر = قصدِ ثبت‌شده (بی‌قصد: ۰)؛ رفتگر با قصدِ مصرف هرگز سوخت نمی‌کند (بی‌بیش‌اخذ).
 *  ۳. هیچ هزینهٔ معلومی گم نمی‌شود: با قصدِ ثبت‌شده مصرف دقیقاً همان است؛ و با سیاست forfeit مصرف+سوخت ≥ هزینهٔ معلوم (کفِ امن) حتی در مرگِ فرایند.
 * مولد باید همهٔ مسیرها را بسازد (ادعای پوشش در پایان) تا «سبزِ بی‌اثر» نشود.
 */
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "@/modules/ledger";
import type { AccountStore } from "@/modules/ledger";
import { createDurableMeteredGateway, createMemoryOutbox, createSettlementSweeper } from "./index";
import { GRACE, KEY, REQUEST, auditLedger, durableConfig, errResult, fakeGateway, flakyLedger, flakyOutbox, fundedLedger, okResult, refOf } from "./test-kit";
import type { OutboxMethod } from "./test-kit";
import { dbDescribe, openPgStore } from "./test-db";

const SEEDS = 40;
const OPS = 40;
const PG_SEEDS = 4;
const PG_OPS = 25;

function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

const seen = new Map<string, number>();
const bump = (k: string, by = 1): void => void seen.set(k, (seen.get(k) ?? 0) + by);

type LedgerPlan = Parameters<typeof flakyLedger>[1];
type OutboxPlan = Partial<Record<OutboxMethod, { fail: number; mode?: "result" | "throw" | "garbage" }>>;

async function runSeed(seed: number, ops: number, store: AccountStore): Promise<void> {
  const r = prng(seed * 104729);
  const f = await fundedLedger(3000 + Math.floor(r() * 3000), store);
  const outbox = createMemoryOutbox();
  const policy = seed % 2 === 0 ? "forfeit" : "release";
  const knownCost = new Map<string, number>(); // reservationId ← هزینهٔ معلومی که دروازه برگرداند (فقط اگر تماس واقعاً رسید)
  const buriedSeen = new Set<string>();
  let n = 0;
  let grants = 0;

  const sweep = async (faulty: boolean): Promise<void> => {
    const lp: LedgerPlan = faulty && r() < 0.5 ? (r() < 0.5 ? { charge: { fail: 99 } } : { close: { fail: 1 + Math.floor(r() * 2), mode: r() < 0.3 ? "throw" : "result" } }) : {};
    const op: OutboxPlan = faulty && r() < 0.5 ? (r() < 0.5 ? { finish: { fail: 99 } } : r() < 0.5 ? { resolveClose: { fail: 1 } } : { recordFailure: { fail: 99 } }) : {};
    const s = createSettlementSweeper({ ledger: flakyLedger(f.ledger, lp), outbox: flakyOutbox(outbox, op), clock: f.clock, maxAttempts: 4, retryDelayMs: 2_000 });
    if (!s.ok) throw new Error(s.error.issues.join(";"));
    const rep = await s.value.sweep();
    for (const b of rep.buried) buriedSeen.add(b.reservationId);
    bump("sweep.retryLater", rep.retryLater);
    bump("sweep.outboxFailures", rep.outboxFailures);
    bump("sweep.settled", rep.settled);
  };

  for (let i = 0; i < ops; i++) {
    const roll = r();
    const where = `بذر ${seed} عملیات ${i}`;
    if (roll < 0.55) {
      const scopeId = `s${++n}`;
      const rid = `${scopeId}.r1`;
      const pick = r();
      const cost = Math.floor(r() * 300);
      const crash = pick >= 0.93;
      let startedResolve: () => void = () => undefined;
      const started = new Promise<void>((res) => (startedResolve = res));
      const gw = fakeGateway(() => {
        startedResolve();
        if (crash) return new Promise(() => undefined); // مرگِ فرایند: هرگز برنمی‌گردد
        if (pick < 0.5) {
          knownCost.set(rid, cost);
          return okResult(cost);
        }
        if (pick < 0.6) return okResult(null);
        if (pick < 0.7) return errResult("TIMEOUT");
        if (pick < 0.78) return errResult("INVALID_REQUEST");
        return new Error("boom");
      });
      const fr = r();
      const lp: LedgerPlan = fr < 0.1 ? { charge: { fail: 99 } } : fr < 0.18 ? { charge: { fail: 1 + Math.floor(r() * 2) } } : fr < 0.26 ? { close: { fail: 99 } } : fr < 0.3 ? { reserve: { fail: 99 } } : fr < 0.34 ? { close: { fail: 99, mode: "throw" } } : {};
      const fo = r();
      const op: OutboxPlan = fo < 0.06 ? { begin: { fail: 1 } } : fo < 0.12 ? { recordCharge: { fail: 99 } } : fo < 0.18 ? { recordClose: { fail: 99 } } : fo < 0.24 ? { finish: { fail: 99 } } : fo < 0.28 ? { recordClose: { fail: 99, mode: "throw" } } : {};
      const made = createDurableMeteredGateway(durableConfig(flakyLedger(f.ledger, lp), gw, flakyOutbox(outbox, op), f.clock, { scopeId, onUnknownCost: policy }));
      if (!made.ok) throw new Error(made.error.issues.join(";"));
      const p = made.value.complete(REQUEST);
      if (crash) {
        void p;
        await Promise.race([p, started]);
        bump("op.crash");
      } else {
        const res = await p;
        bump(`op.outcome.${(res.ok ? res.value.metering : res.error.metering).outcome}`);
      }
    } else if (roll < 0.62) {
      const g = await f.ledger.grant({ ...KEY, grantId: `g${++grants}`, unit: "IRR_MICROS", amount: 1 + Math.floor(r() * 2000), source: "promo" });
      expect(g.ok, `${where}: اعطا`).toBe(true);
    } else if (roll < 0.8) {
      f.clock.advance(r() < 0.1 ? 40_000 + Math.floor(r() * 40_000) : Math.floor(r() * 9_000));
    } else {
      await sweep(r() < 0.4);
    }
    await auditLedger(f.store); // ناوردا پس از هر عملیات
  }

  // ── آرامش: خطاها خاموش؛ رفتگر تا پایان ──
  f.clock.advance(GRACE + 1);
  for (let k = 0; k < 12; k++) {
    await sweep(false);
    const c = await outbox.counts();
    if (c.ok && c.value.open === 0 && c.value.settling === 0) break;
    f.clock.advance(6_000);
  }
  const counts = await outbox.counts();
  expect(counts.ok && counts.value.open + counts.value.settling, `بذر ${seed}: رکورد فعالِ باقی‌مانده`).toBe(0);

  const state = await f.store.read(KEY);
  if (state === null) throw new Error("حساب نیست");
  for (const [id, res] of Object.entries(state.reservations)) {
    const where = `بذر ${seed} رزرو ${id}`;
    const got = await outbox.get(refOf(id));
    const e = got.ok ? got.value : null;
    if (e === null) {
      // begin نشد (رزرو برگردانده شد یا با سررسید آزاد می‌شود): هیچ مصرف/سوختی نباید رخ داده باشد.
      expect(res.charged, `${where}: بی‌رکورد ولی مصرف`).toBe(0);
      expect(res.closedBy === "forfeit", `${where}: بی‌رکورد ولی سوخت`).toBe(false);
      if (res.status === "open") expect(res.expiresAtMs, `${where}: رزروِ بی‌رکورد و باز باید در انتظار سررسید باشد`).toBeGreaterThan(f.clock.nowMs());
      bump("res.noEntry");
      continue;
    }
    expect(["done", "dead"], `${where}: وضعیت ${e.state}`).toContain(e.state);
    const billed = res.charged + (res.closedBy === "forfeit" ? res.closedAmount : 0);
    const c = knownCost.get(id);
    if (e.state === "dead") {
      expect(buriedSeen.has(id), `${where}: مرگِ بی‌زنگ`).toBe(true);
      expect(["EXPIRED_UNBILLED", "ATTEMPTS_EXHAUSTED", "LEDGER_REJECTED"], where).toContain(e.deadReason);
      bump(`dead.${e.deadReason}`);
      continue;
    }
    // done
    expect(res.status, `${where}: done ولی رزرو باز`).toBe("closed");
    expect(e.close, `${where}: done بی‌قصدِ بستن`).not.toBeNull();
    const remainder = e.close?.remainder;
    if (remainder === "forfeit") expect(res.closedBy, where).toBe("forfeit");
    else expect(["release", "expiry"], where).toContain(res.closedBy);
    if (e.charge !== null) {
      expect(res.charged, `${where}: مصرف ≠ قصدِ ثبت‌شده`).toBe(Math.min(e.charge.amount, res.amount));
      if (e.close?.origin === "sweeper") expect(res.closedBy === "forfeit", `${where}: رفتگر با قصدِ مصرف سوخت کرد (بیش‌اخذ)`).toBe(false);
      if (c !== undefined) expect(res.charged, `${where}: هزینهٔ معلوم گم/اضافه شد`).toBe(Math.min(c, res.amount));
    } else {
      expect(res.charged, `${where}: بی‌قصد ولی مصرف`).toBe(0);
    }
    if (policy === "forfeit" && c !== undefined) expect(billed, `${where}: هزینهٔ معلوم پوشش داده نشد`).toBeGreaterThanOrEqual(Math.min(c, res.amount));
    bump(e.close?.origin === "sweeper" ? (e.charge === null ? "done.sweeper.orphan" : "done.sweeper.withCharge") : "done.caller");
  }
  // رزروِ باز فقط می‌تواند بی‌رکورد باشد
  for (const res of Object.values(state.reservations)) {
    if (res.status !== "open") continue;
    const got = await outbox.get(refOf(res.id));
    expect(got.ok && got.value === null, `رزرو باز با رکورد: ${res.id}`).toBe(true);
  }
}

describe("settlement · آزمون خاصیتی (حافظه‌ای): ناوردای پول، بی‌هزینهٔ گمشده، بی‌بیش‌اخذ، بی‌مرگِ بی‌صدا", () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`بذر ${seed}: ${OPS} عملیات تصادفی/خصمانه`, async () => {
      await runSeed(seed, OPS, createMemoryStore());
    });
  }
});

dbDescribe("settlement · آزمون خاصیتی (PostgreSQL): همان ناوردا روی دفتر ماندگار واقعی", () => {
  for (let seed = 1; seed <= PG_SEEDS; seed++) {
    it(`بذر ${seed}: ${PG_OPS} عملیات (شِمای یک‌بارمصرفِ تازه)`, async () => {
      const pg = await openPgStore(4);
      try {
        await runSeed(seed + 2000, PG_OPS, pg.store);
      } finally {
        await pg.dispose();
      }
    });
  }
});

describe("settlement · ادعای پوشش مولد (مولدِ ضعیف تست را بی‌اثر می‌کند)", () => {
  it("همهٔ مسیرهای مهم واقعاً ساخته شدند", () => {
    const need: Array<[string, number]> = [
      ["op.crash", 5],
      ["op.outcome.billed", 100],
      ["op.outcome.forfeited", 5],
      ["op.outcome.released", 5],
      ["op.outcome.settlement-failed", 5],
      ["op.outcome.refused", 5],
      ["done.caller", 50],
      ["done.sweeper.orphan", 5],
      ["done.sweeper.withCharge", 5],
      ["dead.EXPIRED_UNBILLED", 1],
      ["sweep.settled", 20],
      ["sweep.retryLater", 1],
      ["sweep.outboxFailures", 1],
      ["res.noEntry", 1],
    ];
    for (const [k, min] of need) expect(seen.get(k) ?? 0, `مسیر ${k}`).toBeGreaterThanOrEqual(min);
  });
});
