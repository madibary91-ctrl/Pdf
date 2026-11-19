/**
 * رفتگر و ثبتِ شکستِ تکرارپذیر (ADR-0028): دو رفتگرِ هم‌زمان یک شکستِ منطقی را فقط یک بار می‌شمارند و رکورد را زودتر از `maxAttempts` نمی‌میرانند.
 * پورتِ بیرونی ممکن است قدیمی/خراب باشد؛ رفتگر هرگز نمی‌پرتابد.
 */
import { describe, expect, it } from "vitest";
import { createMemoryOutbox, createSettlementSweeper } from "./index";
import type { OutboxEntry, OutboxResult, ReservationRef, SettlementOutbox, Sweeper } from "./index";
import { GRACE, flakyLedger, ok, refOf, reserveInput, rig } from "./test-kit";

const ENTRY = async (outbox: SettlementOutbox, id: string): Promise<OutboxEntry> => {
  const e = ok(await outbox.get(refOf(id)));
  if (e === null) throw new Error("رکورد باید وجود می‌داشت");
  return e;
};

type Call = Readonly<{ ref: ReservationRef; failure: Record<string, unknown> }>;
/** outbox با رهگیریِ `recordFailure` و امکانِ تزریقِ رفتار (رقیب/پورتِ خراب). */
function spyOutbox(inner: SettlementOutbox, hooks: { recordFailure?: (real: () => Promise<unknown>) => Promise<unknown> } = {}) {
  const calls: Call[] = [];
  const wrapped: SettlementOutbox = {
    ...inner,
    recordFailure: (ref, failure) => {
      calls.push({ ref, failure: { ...failure } });
      const real = () => inner.recordFailure(ref, failure);
      return (hooks.recordFailure ? hooks.recordFailure(real) : real()) as Promise<OutboxResult<{ attempts: number }>>;
    },
  };
  return { outbox: wrapped, calls };
}

const second = (x: { ledger: never; outbox: SettlementOutbox; clock: never }, over: Record<string, unknown> = {}): Sweeper => {
  const s = createSettlementSweeper({ ledger: x.ledger, outbox: x.outbox, clock: x.clock, ...over });
  if (!s.ok) throw new Error(s.error.issues.join(";"));
  return s.value;
};
const sum = (rs: readonly { retryLater: number; raced: number; outboxFailures: number; buried: readonly unknown[] }[], k: "retryLater" | "raced" | "outboxFailures"): number => rs.reduce((n, r) => n + r[k], 0);

describe("settlement · رفتگر · ثبتِ شکستِ تکرارپذیر · دو رفتگرِ هم‌زمان", () => {
  it("دو رفتگر با عکسِ یکسان: attempts فقط +۱ (نه +۲)؛ یکی retryLater و دیگری raced", async () => {
    const x = await rig({ maxAttempts: 10, retryDelayMs: 1_000, ledger: (l) => flakyLedger(l, { close: { fail: 99 } }) });
    ok(await x.durable.reserve(reserveInput("r1")));
    x.clock.advance(GRACE);
    const other = second(x as never, { maxAttempts: 10, retryDelayMs: 1_000 });
    const reps = await Promise.all([x.sweeper.sweep(), other.sweep()]);
    expect(reps.map((r) => r.examined)).toEqual([1, 1]);
    expect(sum(reps, "retryLater")).toBe(1);
    expect(sum(reps, "raced")).toBe(1);
    expect(sum(reps, "outboxFailures")).toBe(0);
    expect((await ENTRY(x.outbox, "r1")).attempts).toBe(1);
  });

  it("رکورد زودتر از maxAttempts نمی‌میرد: با دو رفتگرِ هم‌زمان در هر دور attempts دقیقاً +۱ و مرگ فقط در دورِ سقف", async () => {
    const x = await rig({ maxAttempts: 3, retryDelayMs: 1_000, ledger: (l) => flakyLedger(l, { close: { fail: 999 } }) });
    ok(await x.durable.reserve(reserveInput("r1")));
    const other = second(x as never, { maxAttempts: 3, retryDelayMs: 1_000 });
    x.clock.advance(GRACE);
    for (const expected of [1, 2]) {
      const reps = await Promise.all([x.sweeper.sweep(), other.sweep()]);
      expect(sum(reps, "retryLater")).toBe(1);
      const e = await ENTRY(x.outbox, "r1");
      expect(e).toMatchObject({ attempts: expected });
      expect(e.state).not.toBe("dead");
      x.clock.advance(100_000);
    }
    const last = await Promise.all([x.sweeper.sweep(), other.sweep()]);
    const e = await ENTRY(x.outbox, "r1");
    expect(e).toMatchObject({ state: "dead", deadReason: "ATTEMPTS_EXHAUSTED", attempts: 2 });
    expect(last.flatMap((r) => r.buried).length).toBeGreaterThanOrEqual(1);
  });

  it("تعدادِ زیاد: ۶ رفتگرِ هم‌زمان روی ۵ رکورد ⇒ هر رکورد دقیقاً +۱", async () => {
    const x = await rig({ maxAttempts: 10, retryDelayMs: 1_000, ledger: (l) => flakyLedger(l, { close: { fail: 9_999 } }) });
    for (let i = 0; i < 5; i++) ok(await x.durable.reserve(reserveInput(`r${i}`)));
    x.clock.advance(GRACE);
    const sweepers = [x.sweeper, ...Array.from({ length: 5 }, () => second(x as never, { maxAttempts: 10, retryDelayMs: 1_000 }))];
    const reps = await Promise.all(sweepers.map((s) => s.sweep()));
    expect(sum(reps, "retryLater")).toBe(5);
    expect(sum(reps, "raced")).toBe(25);
    for (let i = 0; i < 5; i++) expect((await ENTRY(x.outbox, `r${i}`)).attempts).toBe(1);
  });
});

describe("settlement · رفتگر · ثبتِ شکستِ تکرارپذیر · عکسِ کهنه و پورت", () => {
  it("رفتگر همیشه expectedAttempts = attemptsِ عکسِ خودش را می‌فرستد (دورِ اول ۰، دورِ دوم ۱)", async () => {
    const spy = spyOutbox(createMemoryOutbox());
    const x = await rig({ outbox: spy.outbox, retryDelayMs: 1_000, ledger: (l) => flakyLedger(l, { close: { fail: 99 } }) });
    ok(await x.durable.reserve(reserveInput("r1")));
    x.clock.advance(GRACE);
    await x.sweeper.sweep();
    x.clock.advance(100_000);
    await x.sweeper.sweep();
    expect(spy.calls.map((c) => c.failure["expectedAttempts"])).toEqual([0, 1]);
    expect(spy.calls.every((c) => c.failure["errorCode"] === "STORE_FAILURE")).toBe(true);
    expect((await ENTRY(x.outbox, "r1")).attempts).toBe(2);
  });

  it("رقیب میانِ «خواندنِ عکس» و «ثبتِ شکست» (هنگامِ تماس با دفتر) پیش می‌افتد ⇒ raced (نه retryLater)؛ شمارنده و سررسیدِ رقیب دست‌نخورده", async () => {
    const inner = createMemoryOutbox();
    let intruded = false;
    const x = await rig({
      outbox: inner,
      retryDelayMs: 1_000,
      ledger: (l) => {
        const flaky = flakyLedger(l, { close: { fail: 99 } });
        return {
          ...flaky,
          close: async (input) => {
            if (!intruded) {
              intruded = true;
              // رفتگرِ دیگر همین شکست را (با همان عکسِ attempts=۰) پیش‌تر ثبت کرد.
              ok(await inner.recordFailure(refOf("r1"), { errorCode: "STORE_FAILURE", dueAtMs: 555_555, expectedAttempts: 0 }));
            }
            return flaky.close(input);
          },
        };
      },
    });
    ok(await x.durable.reserve(reserveInput("r1")));
    x.clock.advance(GRACE);
    const rep = await x.sweeper.sweep();
    expect(intruded).toBe(true);
    expect(rep).toMatchObject({ examined: 1, raced: 1, retryLater: 0, outboxFailures: 0, buried: [] });
    expect(await ENTRY(x.outbox, "r1")).toMatchObject({ attempts: 1, dueAtMs: 555_555 });
  });

  it("پورتِ قدیمی که expectedAttempts را نمی‌شناسد و `{attempts}` برمی‌گرداند ⇒ retryLater (سازگاریِ رو به عقب)", async () => {
    const spy = spyOutbox(createMemoryOutbox(), { recordFailure: async (real) => { const r = (await real()) as { ok: true; value: { attempts: number } }; return { ok: true, value: { attempts: r.value.attempts } }; } });
    const x = await rig({ outbox: spy.outbox, ledger: (l) => flakyLedger(l, { close: { fail: 99 } }) });
    ok(await x.durable.reserve(reserveInput("r1")));
    x.clock.advance(GRACE);
    expect(await x.sweeper.sweep()).toMatchObject({ retryLater: 1, raced: 0, outboxFailures: 0 });
  });

  it.each([[undefined], [null], [7], ["x"], [{ attempts: 1, replayed: "true" }], [{ attempts: 1, replayed: 1 }]])("پورتِ خراب با ارزشِ %j ⇒ بی‌پرتاب؛ فقط replayed===true به «raced» می‌رود", async (garbage) => {
    const spy = spyOutbox(createMemoryOutbox(), { recordFailure: async (real) => { await real(); return { ok: true, value: garbage }; } });
    const x = await rig({ outbox: spy.outbox, ledger: (l) => flakyLedger(l, { close: { fail: 99 } }) });
    ok(await x.durable.reserve(reserveInput("r1")));
    x.clock.advance(GRACE);
    const rep = await x.sweeper.sweep();
    expect(rep).toMatchObject({ examined: 1, retryLater: 1, raced: 0, outboxFailures: 0 });
  });

  it("پورت `replayed:true` برگرداند ⇒ raced؛ `CONFLICT` (شمارندهٔ آینده) ⇒ outboxFailures و نه raced", async () => {
    const replayed = spyOutbox(createMemoryOutbox(), { recordFailure: async () => ({ ok: true, value: { attempts: 3, replayed: true } }) });
    const a = await rig({ outbox: replayed.outbox, ledger: (l) => flakyLedger(l, { close: { fail: 99 } }) });
    ok(await a.durable.reserve(reserveInput("r1")));
    a.clock.advance(GRACE);
    expect(await a.sweeper.sweep()).toMatchObject({ raced: 1, retryLater: 0, outboxFailures: 0 });

    const conflict = spyOutbox(createMemoryOutbox(), { recordFailure: async () => ({ ok: false, error: { code: "CONFLICT", message: "x" } }) });
    const b = await rig({ outbox: conflict.outbox, ledger: (l) => flakyLedger(l, { close: { fail: 99 } }) });
    ok(await b.durable.reserve(reserveInput("r1")));
    b.clock.advance(GRACE);
    expect(await b.sweeper.sweep()).toMatchObject({ raced: 0, retryLater: 0, outboxFailures: 1 });
    expect(await ENTRY(b.outbox, "r1")).toMatchObject({ attempts: 0 });
  });

  it("پورتی که recordFailure را می‌پرتابد ⇒ outboxFailures؛ رفتگر نمی‌پرتابد", async () => {
    const spy = spyOutbox(createMemoryOutbox(), { recordFailure: async () => { throw new Error("boom: LEAK-CANARY"); } });
    const x = await rig({ outbox: spy.outbox, ledger: (l) => flakyLedger(l, { close: { fail: 99 } }) });
    ok(await x.durable.reserve(reserveInput("r1")));
    x.clock.advance(GRACE);
    const rep = await x.sweeper.sweep();
    expect(rep).toMatchObject({ outboxFailures: 1, retryLater: 0, raced: 0 });
    expect(JSON.stringify(rep)).not.toMatch(/LEAK-CANARY/);
  });
});
