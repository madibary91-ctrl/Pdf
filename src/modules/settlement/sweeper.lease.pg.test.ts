/**
 * رفتگرِ دارای اجاره روی PostgreSQL واقعی (ADR-0029): چند «فرایند» (استخرِ جدا) هم‌زمان روی یک outbox می‌روبند؛ دفتر مشترک و شمارنده‌دار است
 * تا «کارِ تکراری» را مستقیم بسنجیم (هر close اضافه یک تماسِ اضافه است). زمان مجازی، I/O واقعی.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createSettlementSweeper } from "./index";
import type { DueClaimer, OutboxEntry, SettlementOutbox, Sweeper, SweepReport } from "./index";
import { GRACE, auditLedger, flakyLedger, ok, refOf, reserveInput, rig, type Rig } from "./test-kit";
import { dbDescribe, openPgOutbox } from "./pg/test-db";
import type { TestOutbox } from "./pg/test-db";

const LEASE = 20_000; // < TTLِ رزرو (۶۰٬۰۰۰)

const sum = (rs: readonly SweepReport[], k: "examined" | "settled" | "retryLater" | "raced" | "outboxFailures"): number => rs.reduce((n, r) => n + r[k], 0);
const entry = async (o: SettlementOutbox, id: string): Promise<OutboxEntry> => {
  const e = ok(await o.get(refOf(id)));
  if (e === null) throw new Error("رکورد باید وجود می‌داشت");
  return e;
};

dbDescribe("settlement · رفتگرِ دارای اجاره روی PostgreSQL", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  async function fleet(n: number, over: Record<string, unknown>, ledgerPlan: Parameters<typeof flakyLedger>[1] = {}) {
    const t: TestOutbox = await openPgOutbox(4);
    cleanups.push(t.dispose);
    let fl: ReturnType<typeof flakyLedger> | undefined;
    const x: Rig = await rig({ funds: 200_000, outbox: t.outbox, ledger: (l) => (fl = flakyLedger(l, ledgerPlan)), ...(over["maxAttempts"] !== undefined ? { maxAttempts: over["maxAttempts"] as number } : {}) });
    const outboxes: (SettlementOutbox & DueClaimer)[] = [t.outbox];
    for (let i = 1; i < n; i++) {
      const r = await t.reopen();
      cleanups.push(r.close);
      outboxes.push(r.outbox);
    }
    const sweepers: Sweeper[] = outboxes.map((outbox) => {
      const s = createSettlementSweeper({ ledger: x.ledger, outbox, clock: x.clock, leaseMs: LEASE, ...over });
      if (!s.ok) throw new Error(s.error.issues.join(";"));
      return s.value;
    });
    return { t, x, sweepers, fl: () => fl as ReturnType<typeof flakyLedger>, outboxes };
  }
  async function reserveMany(x: Rig, n: number): Promise<void> {
    for (let i = 0; i < n; i++) ok(await x.durable.reserve(reserveInput(`r${i}`)));
  }

  it("۴ رفتگرِ هم‌زمان (۴ استخر) روی ۲۴ رزرو: هر رکورد یک‌بار بررسی و دقیقاً یک close روی دفتر؛ بی‌raced و دفتر سالم", async () => {
    const f = await fleet(4, {});
    await reserveMany(f.x, 24);
    f.x.clock.advance(GRACE);
    const reps = await Promise.all(f.sweepers.map((s) => s.sweep()));
    expect(sum(reps, "examined")).toBe(24);
    expect(sum(reps, "settled")).toBe(24);
    expect(sum(reps, "raced")).toBe(0);
    expect(sum(reps, "outboxFailures")).toBe(0);
    expect(f.fl().count["close"]).toBe(24);
    for (let i = 0; i < 24; i++) expect((await entry(f.x.outbox, `r${i}`)).state).toBe("done");
    await auditLedger(f.x.store);
  });

  it("limit کوچک (۵) و ۴ رفتگر در چند دور: همه بسته می‌شوند، بی‌تکرار", async () => {
    const f = await fleet(4, { limit: 5 });
    await reserveMany(f.x, 20);
    f.x.clock.advance(GRACE);
    const all: SweepReport[] = [];
    for (let round = 0; round < 6; round++) all.push(...(await Promise.all(f.sweepers.map((s) => s.sweep()))));
    expect(sum(all, "settled")).toBe(20);
    expect(sum(all, "examined")).toBe(20);
    expect(f.fl().count["close"]).toBe(20);
    await auditLedger(f.x.store);
  });

  it("دارندهٔ اجاره می‌میرد (استخرش بسته می‌شود): دیگران تا پایانِ اجاره چیزی نمی‌بینند، سپس همه را می‌بندند", async () => {
    const f = await fleet(2, {});
    await reserveMany(f.x, 6);
    f.x.clock.advance(GRACE);
    const dying = f.outboxes[1] as SettlementOutbox & DueClaimer;
    ok(await dying.claimDue({ nowMs: f.x.clock.nowMs(), limit: 100, leaseMs: LEASE }));
    // «مرگ»: دارنده هیچ‌چیز را نمی‌بندد.
    expect(await (f.sweepers[0] as Sweeper).sweep()).toMatchObject({ examined: 0 });
    f.x.clock.advance(LEASE - 1);
    expect(await (f.sweepers[0] as Sweeper).sweep()).toMatchObject({ examined: 0 });
    f.x.clock.advance(1);
    expect(await (f.sweepers[0] as Sweeper).sweep()).toMatchObject({ examined: 6, settled: 6 });
    await auditLedger(f.x.store);
  });

  it("۳ رفتگر + ۳ خرابیِ گذرای دفتر روی ۹ رزرو: هر شکست یک‌بار تلاش دوباره می‌شود؛ مجموعِ close = ۹ + ۳، سقفِ تلاش هیچ‌جا زودتر نمی‌رسد", async () => {
    const f = await fleet(3, { maxAttempts: 10, retryDelayMs: 1_000 }, { close: { fail: 3 } });
    await reserveMany(f.x, 9);
    f.x.clock.advance(GRACE);
    const all: SweepReport[] = [];
    for (let round = 0; round < 4; round++) {
      all.push(...(await Promise.all(f.sweepers.map((s) => s.sweep()))));
      f.x.clock.advance(5_000);
    }
    expect(sum(all, "settled")).toBe(9);
    expect(sum(all, "retryLater")).toBe(3);
    expect(sum(all, "raced")).toBe(0);
    expect(f.fl().count["close"]).toBe(12);
    for (let i = 0; i < 9; i++) expect((await entry(f.x.outbox, `r${i}`)).attempts).toBeLessThanOrEqual(1);
    await auditLedger(f.x.store);
  });
});
