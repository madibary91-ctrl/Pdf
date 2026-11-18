/**
 * حلقهٔ رفتگر روی دفتر و outbox واقعی (حافظه‌ای) با دکوراتور واقعی و زمانِ مجازی (ADR-0023): بی‌هیچ `sweep()` دستی،
 * رزروهای یتیم و نیمه‌تمام به‌تنهایی بسته می‌شوند؛ ناوردای پول پس از هر سناریو سنجیده می‌شود.
 */
import { describe, expect, it } from "vitest";
import { createSweepLoop } from "./index";
import type { BuriedItem, LoopFault, SettlementOutbox } from "./index";
import { GRACE, KEY, WORST, auditLedger, balance, chargeInput, flakyOutbox, flush, fundedLedger, manualTimer, ok, refOf, reserveInput, rig } from "./test-kit";
import type { MutableClock } from "./test-kit";
import { createMemoryOutbox } from "./index";

const HALF = GRACE / 2;

function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** ساعتِ دفتر = ساعتِ زمان‌سنجِ مجازی ⇒ `timer.advance` همزمان زمانِ دفتر و حلقه است. */
async function world(o: { policy?: "forfeit" | "release"; limit?: number; outbox?: SettlementOutbox; funds?: number; intervalMs?: number; loop?: Record<string, unknown> } = {}) {
  const timer = manualTimer();
  const base = await fundedLedger(o.funds ?? 200_000, undefined, timer.clock as unknown as MutableClock);
  const x = await rig({ base, policy: o.policy ?? "forfeit", ...(o.limit !== undefined ? { limit: o.limit } : {}), ...(o.outbox !== undefined ? { outbox: o.outbox } : {}) });
  const buried: BuriedItem[] = [];
  const faults: LoopFault[] = [];
  const made = createSweepLoop({
    sweeper: x.sweeper,
    timer,
    clock: timer.clock,
    graceMs: GRACE,
    intervalMs: o.intervalMs ?? 1000,
    observer: { onBuried: (items: readonly BuriedItem[]) => void buried.push(...items), onFault: (f: LoopFault) => void faults.push(f) },
    ...(o.loop ?? {}),
  });
  if (!made.ok) throw new Error(made.error.issues.join("; "));
  return { ...x, timer, loop: made.value, buried, faults };
}

describe("settlement · حلقه روی دفتر و outbox واقعی", () => {
  it("رزروِ یتیم بی‌هیچ sweep دستی پس از graceMs بسته می‌شود (forfeit)", async () => {
    const x = await world({ policy: "forfeit" });
    ok(await x.durable.reserve(reserveInput("r1")));
    x.loop.start();
    await x.timer.advance(GRACE - 1);
    expect((await balance(x.ledger)).held).toBe(WORST); // پیش از مهلت دست‌نخورده
    await x.timer.advance(1 + 1000);
    expect(await balance(x.ledger)).toMatchObject({ held: 0, available: 200_000 - WORST, totals: { forfeited: WORST, charged: 0 } });
    expect(ok(await x.outbox.get(refOf("r1")))).toMatchObject({ state: "done", close: { origin: "sweeper" } });
    expect(x.buried).toEqual([]);
    await auditLedger(x.store);
    await x.loop.stop();
  });
  it("رزروِ یتیم با سیاست release آزاد می‌شود و رزروِ نیمه‌تمامِ مصرف‌شده فقط هزینهٔ ثبت‌شده را می‌گیرد", async () => {
    const x = await world({ policy: "release" });
    ok(await x.durable.reserve(reserveInput("r1")));
    ok(await x.durable.reserve(reserveInput("r2")));
    ok(await x.durable.charge(chargeInput("r2", 100)));
    x.loop.start();
    await x.timer.advance(GRACE + 2000);
    expect(await balance(x.ledger)).toMatchObject({ held: 0, available: 200_000 - 100, totals: { charged: 100, forfeited: 0 } });
    expect(x.buried).toEqual([]);
    await auditLedger(x.store);
  });
  it("۴۰ رزرو با limit=۵: تخلیهٔ پیاپی همه را در همان لحظه می‌بندد (بی‌انتظارِ interval)", async () => {
    const x = await world({ limit: 5, funds: 1_000_000 });
    for (let i = 0; i < 40; i++) ok(await x.durable.reserve(reserveInput(`r${i}`)));
    x.loop.start();
    await x.timer.advance(GRACE - 1); // پیش از سررسید: حلقه می‌چرخد ولی چیزی برای بستن نیست
    expect(x.loop.status().totals.settled).toBe(0);
    await x.timer.advance(1 + 1000);
    const st = x.loop.status();
    expect(st.totals.settled).toBe(40);
    expect(ok(await x.outbox.counts())).toMatchObject({ open: 0, settling: 0, done: 40, dead: 0 });
    expect((await balance(x.ledger)).held).toBe(0);
    // ۴۰ رکورد با limit=۵ ⇒ ۸ گذرِ پربار پیاپی در یک لحظه (تخلیه)، نه ۸ interval
    expect(x.timer.delays.filter((d) => d === 0).length).toBeGreaterThanOrEqual(8);
    await auditLedger(x.store);
  });
  it("خطای گذرای outbox: حلقه عقب می‌نشیند، خطا اعلام می‌کند، بهبود می‌یابد و هیچ رزروی گم نمی‌شود", async () => {
    const outbox = flakyOutbox(createMemoryOutbox(), { listDue: { fail: 4, skip: 1 } });
    const x = await world({ outbox });
    ok(await x.durable.reserve(reserveInput("r1", WORST, 600_000)));
    x.loop.start();
    await x.timer.advance(GRACE + 60_000);
    expect(x.faults.length).toBe(4);
    expect(x.faults.every((f) => f.kind === "LIST_FAILED")).toBe(true);
    expect(x.faults.map((f) => f.nextDelayMs)).toEqual([1000, 2000, 4000, 8000].map((d) => Math.min(d, HALF)));
    expect(ok(await x.outbox.get(refOf("r1")))).toMatchObject({ state: "done" });
    expect(x.loop.status()).toMatchObject({ consecutiveFailures: 0, state: "running" });
    await auditLedger(x.store);
  });
  it("outbox در حالتِ throw/garbage هم حلقه نمی‌میرد", async () => {
    for (const mode of ["throw", "garbage"] as const) {
      const outbox = flakyOutbox(createMemoryOutbox(), { listDue: { fail: 3, mode } });
      const x = await world({ outbox });
      ok(await x.durable.reserve(reserveInput("r1", WORST, 600_000)));
      x.loop.start();
      await x.timer.advance(GRACE + 30_000);
      expect(x.loop.status().state).toBe("running");
      expect(ok(await x.outbox.get(refOf("r1")))).toMatchObject({ state: "done" });
      expect(JSON.stringify(x.faults)).not.toContain("LEAK-CANARY");
    }
  });
  it("رزروِ منقضی‌شده پیش از دیدنِ رفتگر ⇒ مرگِ مستند و زنگِ onBuried (کاربر مجانی گرفت)", async () => {
    const x = await world();
    ok(await x.durable.reserve(reserveInput("r1", WORST, 2 * GRACE)));
    // رفتگر دیر شروع می‌شود (فرایند پس از انقضا بالا آمد)
    await x.timer.advance(3 * GRACE);
    x.loop.start();
    await x.timer.advance(0);
    expect(x.buried).toEqual([{ tenantId: KEY.tenantId, accountId: KEY.accountId, reservationId: "r1", reason: "EXPIRED_UNBILLED", errorCode: "RESERVATION_EXPIRED" }]);
    expect(ok(await x.outbox.get(refOf("r1")))).toMatchObject({ state: "dead", deadReason: "EXPIRED_UNBILLED" });
    expect(x.loop.status().totals.buried).toBe(1);
    // دوباره هرگز زنگ نمی‌زند
    await x.timer.advance(10 * GRACE);
    expect(x.buried).toHaveLength(1);
  });
  it("سقفِ ایمنی: با interval=⌊grace/2⌋ و ttl=2·grace هیچ رزروِ یتیمی منقضی نمی‌شود (۳۰ بذر با فازِ تصادفی)", async () => {
    for (let seed = 1; seed <= 30; seed++) {
      const r = prng(seed * 31337);
      const x = await world({ intervalMs: HALF, funds: 10_000_000 });
      await x.timer.advance(Math.floor(r() * 3 * HALF)); // فازِ تصادفیِ آغازِ حلقه نسبت به زمانِ رزروها
      x.loop.start();
      let n = 0;
      for (let step = 0; step < 25; step++) {
        const at = Math.floor(r() * 2500);
        await x.timer.advance(at);
        if (r() < 0.7) {
          ok(await x.durable.reserve(reserveInput(`s${seed}-${n++}`, WORST, 2 * GRACE)));
          if (r() < 0.4) ok(await x.durable.charge(chargeInput(`s${seed}-${n - 1}`, 1 + Math.floor(r() * 100))));
        }
      }
      await x.timer.advance(4 * GRACE);
      expect(x.buried, `بذر ${seed}`).toEqual([]);
      expect(ok(await x.outbox.counts()), `بذر ${seed}`).toMatchObject({ open: 0, settling: 0, dead: 0, done: n });
      expect((await balance(x.ledger)).held).toBe(0);
      await auditLedger(x.store);
      await x.loop.stop();
    }
  });
  it("آمیخته با تسویهٔ درون‌خطی (close فراخواننده) و حلقه: هرگز مصرف+سوختِ هم‌زمان و دفتر سالم (۲۰ بذر)", async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const r = prng(seed * 7727);
      const x = await world({ funds: 10_000_000, policy: seed % 2 === 0 ? "forfeit" : "release", intervalMs: 700 });
      x.loop.start();
      const closed = new Set<string>();
      const charged = new Map<string, number>();
      for (let i = 0; i < 30; i++) {
        await x.timer.advance(Math.floor(r() * 4000));
        const id = `m${seed}-${i}`;
        ok(await x.durable.reserve(reserveInput(id, WORST, 6 * GRACE)));
        if (r() < 0.6) {
          const amount = 1 + Math.floor(r() * 200);
          ok(await x.durable.charge(chargeInput(id, amount)));
          charged.set(id, amount);
          if (r() < 0.5) {
            ok(await x.durable.close({ ...KEY, reservationId: id, remainder: "release" }));
            closed.add(id);
          }
        }
      }
      await x.timer.advance(6 * GRACE);
      const c = ok(await x.outbox.counts());
      expect(c, `بذر ${seed}`).toMatchObject({ open: 0, settling: 0, dead: 0, done: 30 });
      const b = await balance(x.ledger);
      const total = [...charged.values()].reduce((a, v) => a + v, 0);
      expect(b.held).toBe(0);
      expect(b.totals.charged, `بذر ${seed}: دقیقاً مجموعِ هزینه‌های ثبت‌شده`).toBe(total);
      await auditLedger(x.store);
      await x.loop.stop();
    }
  });
  it("stop هنگامِ گذرِ واقعی: گذر کامل می‌شود، دفتر سازگار می‌ماند و پس از stop هیچ کاری نمی‌شود", async () => {
    const x = await world();
    for (let i = 0; i < 10; i++) ok(await x.durable.reserve(reserveInput(`r${i}`)));
    await x.timer.advance(GRACE);
    x.loop.start();
    await x.timer.advance(0);
    const stopped = await x.loop.stop();
    expect(stopped.clean).toBe(true);
    const done = ok(await x.outbox.counts()).done;
    await x.timer.advance(10 * GRACE);
    await flush();
    expect(ok(await x.outbox.counts()).done).toBe(done);
    await auditLedger(x.store);
  });
});
