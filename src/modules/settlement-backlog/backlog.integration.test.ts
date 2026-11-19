/**
 * settlement-backlog · یکپارچگی با حلقهٔ واقعیِ settlement (ADR-0039): همان outboxی که `createSweepLoop` زنگ را از آن می‌رساند.
 * ثابت می‌کند پایش چیزی را می‌بیند که `createSweepHealthCheck` نمی‌بیند: وقتی `deliver` شکست می‌خورد حلقه «زنده» (running) می‌ماند و سلامتِ رفتگر
 * هرگز `down` نمی‌شود، ولی پسماندِ تأییدنشده پیر می‌شود و پایش `down` می‌دهد؛ با بهبودِ `deliver` پسماند صفر و پایش `ok` می‌شود.
 * زمان مجازی است (ساعت و زمان‌سنجِ دستی)؛ بی‌پایگاه.
 */
import { describe, expect, it } from "vitest";
import { createMemoryOutbox, createSweepHealthCheck, createSweepLoop } from "@/modules/settlement";
import type { DeadLetter, LoopTimer, SettlementOutbox, SweepLoop } from "@/modules/settlement";
import type { BacklogHealth } from "./index";
import { T0, buryMany, manualClock, monitorOf, must } from "./test-kit";
import type { ManualClock } from "./test-kit";

const GRACE = 20_000;
const INTERVAL = 1_000;
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

type Rec = { at: number; fn: () => void; cancelled: boolean };
function virtual(): { clock: ManualClock; timer: LoopTimer; advance(ms: number): Promise<void> } {
  const clock = manualClock(T0);
  const q: Rec[] = [];
  const timer: LoopTimer = {
    after(fn, ms) {
      const rec: Rec = { at: clock.now + ms, fn, cancelled: false };
      q.push(rec);
      return rec;
    },
    cancel(h) {
      (h as Rec).cancelled = true;
    },
  };
  return {
    clock,
    timer,
    async advance(ms) {
      const target = clock.now + ms;
      for (;;) {
        const live = q.filter((r) => !r.cancelled).sort((a, b) => a.at - b.at);
        const next = live[0];
        if (next === undefined || next.at > target) break;
        q.splice(q.indexOf(next), 1);
        clock.now = Math.max(clock.now, next.at);
        next.fn();
        await flush();
      }
      clock.now = target;
      await flush();
    },
  };
}

const emptyReport = { examined: 0, settled: 0, retryLater: 0, raced: 0, outboxFailures: 0, buried: [], listFailed: false };

function world(deliver: (l: DeadLetter) => unknown) {
  const v = virtual();
  const outbox: SettlementOutbox = createMemoryOutbox();
  const loop: SweepLoop = must(
    createSweepLoop({ sweeper: { sweep: async () => emptyReport }, timer: v.timer, clock: v.clock, graceMs: GRACE, intervalMs: INTERVAL, deadLetters: { outbox, deliver } }),
  );
  const backlog = monitorOf({ degradedCount: 3, downCount: 6, degradedAfterMs: 3_000, downAfterMs: 8_000, sampleMaxAgeMs: 30_000, sampleLimit: 20 }, outbox, v.clock);
  const sweepHealth = must(createSweepHealthCheck({ graceMs: GRACE }));
  const loopHealth = () => sweepHealth.evaluate({ status: loop.status(), nowMs: v.clock.now, sinceMs: T0 });
  return { v, outbox, loop, backlog, loopHealth };
}

const codes = (h: BacklogHealth) => h.reasons.map((r) => r.code);

describe("settlement-backlog · روی حلقهٔ واقعیِ زنگِ ماندگار", () => {
  it("deliver شکست‌خورده: حلقه down نمی‌شود ولی پسماند پیر می‌شود و پایش down می‌دهد؛ با بهبودِ deliver همه ok می‌شود", async () => {
    let healthy = false;
    const delivered: string[] = [];
    const w = world((l) => {
      if (!healthy) throw new Error("webhook-down-SECRET");
      delivered.push(l.reservationId);
    });
    await buryMany(w.outbox, 4, () => w.v.clock.now);
    expect(w.loop.start()).toEqual({ started: true });
    await w.v.advance(1);

    // آغاز: چهار مردهٔ تأییدنشده، تازه ⇒ COUNT_HIGH؛ سلامتِ رفتگر هم هشدار (خطای deliver) ولی down نیست.
    let b = await w.backlog.check();
    expect(b).toMatchObject({ status: "degraded", count: 4 });
    expect(codes(b)).toEqual(["COUNT_HIGH"]);

    // زمان می‌گذرد و deliver هنوز خراب است: حلقه running می‌ماند (هرگز down نمی‌شود)، ولی پسماند OLDEST_AGED ⇒ OLDEST_STUCK.
    await w.v.advance(4_000);
    expect(w.loop.status().state).toBe("running");
    expect(w.loopHealth().status).not.toBe("down");
    b = await w.backlog.check();
    expect(codes(b)).toEqual(["COUNT_HIGH", "OLDEST_AGED"]);

    await w.v.advance(6_000);
    expect(w.loop.status().state).toBe("running");
    expect(w.loopHealth().status).not.toBe("down");
    b = await w.backlog.check();
    expect(b.status).toBe("down");
    expect(codes(b)).toContain("OLDEST_STUCK");
    expect(b).toMatchObject({ count: 4, byReason: { EXPIRED_UNBILLED: 0, ATTEMPTS_EXHAUSTED: 4, LEDGER_REJECTED: 0 } });
    expect(delivered).toEqual([]);
    expect(JSON.stringify(b)).not.toContain("SECRET");

    // deliver بهبود می‌یابد ⇒ حلقه می‌رساند و تأیید می‌کند ⇒ پسماند صفر ⇒ ok.
    healthy = true;
    await w.v.advance(25_000);
    expect(delivered.sort()).toEqual(["r1", "r2", "r3", "r4"]);
    b = await w.backlog.check();
    expect(b).toMatchObject({ status: "ok", count: 0, reasons: [], oldestAgeMs: null });
    await w.loop.stop();
  });

  it("زنگِ سالم: مرده‌های تازه پس از رسیدن و تأیید از پسماند بیرون می‌روند (پایش با تأیید هم‌خوان است)", async () => {
    const w = world(() => undefined);
    await buryMany(w.outbox, 2, () => w.v.clock.now);
    expect((await w.backlog.check()).count).toBe(2);
    w.loop.start();
    await w.v.advance(1);
    expect(await w.backlog.check()).toMatchObject({ status: "ok", count: 0 });
    // تاریخچه می‌ماند (تأیید فهرستِ listDead را عوض نمی‌کند)؛ فقط پسماند صفر است.
    const dead = await w.outbox.listDead({ limit: 10 });
    expect(dead.ok && dead.value.length).toBe(2);
    await w.loop.stop();
  });

  it("حلقهٔ بدونِ deadLetters اصلاً تأیید نمی‌کند: پسماند تا ابد می‌ماند و پایش آن را (برخلافِ سلامتِ رفتگر) می‌بیند", async () => {
    const v = virtual();
    const outbox = createMemoryOutbox();
    const loop = must(createSweepLoop({ sweeper: { sweep: async () => emptyReport }, timer: v.timer, clock: v.clock, graceMs: GRACE, intervalMs: INTERVAL }));
    const sweepHealth = must(createSweepHealthCheck({ graceMs: GRACE }));
    const backlog = monitorOf({ degradedCount: 1, downCount: 2, degradedAfterMs: 3_000, downAfterMs: 8_000, sampleMaxAgeMs: 30_000 }, outbox, v.clock);
    await buryMany(outbox, 1, () => v.clock.now);
    loop.start();
    await v.advance(10_000);
    expect(sweepHealth.evaluate({ status: loop.status(), nowMs: v.clock.now, sinceMs: T0 }).status).toBe("ok");
    const b = await backlog.check();
    expect(b.status).toBe("down");
    expect(codes(b)).toEqual(["OLDEST_STUCK", "COUNT_HIGH"]);
    await loop.stop();
  });
});
