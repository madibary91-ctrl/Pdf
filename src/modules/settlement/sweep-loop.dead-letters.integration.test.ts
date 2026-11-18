/**
 * زنگِ ماندگار روی دفتر و outbox واقعی (حافظه‌ای) با رفتگرِ واقعی و زمانِ مجازی (ADR-0026): رکوردِ مردهٔ واقعی (رزروِ منقضی‌شده)
 * در همان گذرِ دفن می‌رسد و تأیید می‌شود؛ و **خرابیِ زنگ هرگز تسویهٔ پول را کند یا خراب نمی‌کند** (ناوردای ۱۰).
 */
import { describe, expect, it } from "vitest";
import { createSweepLoop } from "./index";
import type { DeadLetter, LoopFault } from "./index";
import { GRACE, KEY, WORST, auditLedger, balance, fundedLedger, manualTimer, ok, refOf, reserveInput, rig } from "./test-kit";
import type { MutableClock } from "./test-kit";

const HALF = GRACE / 2;

async function world(deliver: (l: DeadLetter) => unknown) {
  const timer = manualTimer();
  const base = await fundedLedger(200_000, undefined, timer.clock as unknown as MutableClock);
  const x = await rig({ base, policy: "forfeit" });
  const faults: LoopFault[] = [];
  const made = createSweepLoop({
    sweeper: x.sweeper,
    timer,
    clock: timer.clock,
    graceMs: GRACE,
    intervalMs: 1000,
    observer: { onFault: (f: LoopFault) => void faults.push(f) },
    deadLetters: { outbox: x.outbox, deliver },
  });
  if (!made.ok) throw new Error(made.error.issues.join("; "));
  return { ...x, timer, loop: made.value, faults };
}

describe("settlement · زنگِ ماندگار روی دفتر و outbox واقعی", () => {
  it("رزروِ منقضی‌شده پیش از دیدنِ رفتگر ⇒ dead ⇒ در همان گذر تحویل و تأیید؛ مبلغ و دلیلِ درست؛ ریستارت دوباره نمی‌رساند", async () => {
    const got: DeadLetter[] = [];
    const x = await world((l) => void got.push(l));
    ok(await x.durable.reserve(reserveInput("r1", WORST, 2 * GRACE)));
    await x.timer.advance(3 * GRACE);
    x.loop.start();
    await x.timer.advance(0);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ tenantId: KEY.tenantId, accountId: KEY.accountId, reservationId: "r1", reason: "EXPIRED_UNBILLED", reserved: WORST });
    expect(ok(await x.outbox.listUnacknowledgedDead({ limit: 10 }))).toEqual([]);
    expect(ok(await x.outbox.listDead({ limit: 10 }))).toHaveLength(1); // تاریخچه می‌ماند
    await x.loop.stop();

    const again: DeadLetter[] = [];
    const y = createSweepLoop({ sweeper: x.sweeper, timer: x.timer, clock: x.timer.clock, graceMs: GRACE, intervalMs: 1000, deadLetters: { outbox: x.outbox, deliver: (l: DeadLetter) => void again.push(l) } });
    if (!y.ok) throw new Error("cfg");
    y.value.start();
    await x.timer.advance(10 * GRACE);
    expect(again).toEqual([]);
    await y.value.stop();
  });

  it("deliverِ همیشه خراب: تسویهٔ پول دقیق و به‌موقع می‌ماند و فاصلهٔ گذرها هرگز از ⌊graceMs/2⌋ بیشتر نمی‌شود", async () => {
    const x = await world(() => {
      throw new Error("LEAK-CANARY-dead-integration");
    });
    // یک مردهٔ ماندگار (زنگ همیشه می‌شکند) + چند رزروِ عادیِ یتیم که باید بسته شوند.
    ok(await x.durable.reserve(reserveInput("dead1", WORST, 2 * GRACE)));
    await x.timer.advance(3 * GRACE);
    for (let i = 0; i < 6; i++) ok(await x.durable.reserve(reserveInput(`ok${i}`)));
    x.loop.start();
    await x.timer.advance(3 * GRACE);
    for (let i = 0; i < 6; i++) expect(ok(await x.outbox.get(refOf(`ok${i}`)))).toMatchObject({ state: "done" });
    expect(Math.max(...x.timer.delays.filter((d) => d !== 30_000))).toBeLessThanOrEqual(HALF);
    expect((await balance(x.ledger)).held).toBe(0);
    const a = await auditLedger(x.store);
    expect(a.available + a.held + a.charged + a.forfeited).toBe(a.granted);
    expect(x.loop.status().deadLetters.deliverFailures).toBeGreaterThan(0);
    expect(JSON.stringify([x.faults, x.loop.status()])).not.toContain("LEAK-CANARY");
    await x.loop.stop();
  });
});
