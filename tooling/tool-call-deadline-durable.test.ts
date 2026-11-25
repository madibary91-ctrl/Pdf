/**
 * ترکیبِ `tool-call-deadline` + `durable-tool-gateway` + رفتگرِ واقعیِ `settlement` روی ذخیرهٔ حافظه‌ای (ADR-0066): «گامِ زامبی» (ADR-0065-الف) با سقفِ
 * سختِ مهلت **ناممکن** می‌شود. زمانِ مجازی: ساعتِ دفتر و تایمرِ سقف با هم جلو می‌روند. شاهدِ کنترل (بی‌پوشش) نشان می‌دهد که همین سناریو
 * بدونِ پوشش هنوز زامبی می‌شود، پس رفع از خودِ پوشش است نه از تنظیمِ آزمون. قیمت‌ها ساختگیِ test-kit ماژول‌اند.
 */
import { describe, expect, it } from "vitest";
import { createDurableToolGateway } from "@/modules/durable-tool-gateway";
import { GRACE, STEP, TTL, WORST, audit, configFor, fundedLedger, ok, prng, refOf, stepErr, stepOk, stubGateway } from "@/modules/durable-tool-gateway/test-kit";
import type { StepReply } from "@/modules/durable-tool-gateway/test-kit";
import { checkTimingRelations, createDeadlineToolGateway } from "@/modules/tool-call-deadline";
import type { DeadlineEvent } from "@/modules/tool-call-deadline";
import { fakeTimers } from "@/modules/tool-call-deadline/test-kit";
import { createMemoryOutbox, createSettlementSweeper } from "@/modules/settlement";

const MAX_CALL = 4000;
const FUNDS = 1_000_000;
const settleIo = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await new Promise<void>((res) => setImmediate(res));
};
const meta = (r: { ok: boolean; value?: { metering: unknown }; error?: { metering: unknown } }): Record<string, unknown> => (r.ok ? r.value!.metering : r.error!.metering) as Record<string, unknown>;

async function world(reply: StepReply | ((input: unknown, index: number) => unknown), policy: "forfeit" | "release", wrap: boolean, maxCallMs = MAX_CALL) {
  const f = await fundedLedger(FUNDS);
  const outbox = createMemoryOutbox();
  const timers = fakeTimers();
  const events: DeadlineEvent[] = [];
  const stub = stubGateway(reply);
  let gateway = stub.gateway;
  if (wrap) {
    const d = createDeadlineToolGateway({ gateway, maxCallMs, timers, onEvent: (e: DeadlineEvent) => void events.push(e) });
    if (!d.ok) throw new Error(d.error.issues.join(";"));
    gateway = d.value;
  }
  const made = createDurableToolGateway(configFor(f.ledger, gateway, outbox, f.clock, { onUnknownCost: policy }));
  if (!made.ok) throw new Error(made.error.issues.join(";"));
  const sweeper = createSettlementSweeper({ ledger: f.ledger, outbox, clock: f.clock });
  if (!sweeper.ok) throw new Error(sweeper.error.issues.join(";"));
  /** زمانِ مجازی: ساعتِ دفتر و تایمرِ سقف با هم؛ پس از هر گام I/Oِ حافظه‌ای تمام می‌شود. */
  const tick = async (ms: number): Promise<void> => {
    f.clock.advance(ms);
    timers.advance(ms);
    await settleIo();
  };
  return { gw: made.value, stub, ledger: f.ledger, outbox, sweeper: sweeper.value, timers, events, tick };
}

describe("tool-call-deadline + durable-tool-gateway · رابطه‌های ساختاری", () => {
  it("مقدارهای این آزمون با رابطه‌های ساختاری سازگارند (maxCallMs < graceMs ≤ ttl/۲)", () => {
    expect(checkTimingRelations({ maxCallMs: MAX_CALL, graceMs: GRACE, reservationTtlMs: TTL })).toEqual([]);
    expect(MAX_CALL).toBeLessThan(GRACE);
  });
});

describe("tool-call-deadline + durable-tool-gateway · گامِ زامبی ناممکن است", () => {
  it.each(["forfeit", "release"] as const)("تماسِ آویزان (سیاست %s): پیش از graceMs خودِ دروازه می‌بندد؛ settlement-failed و SETTLEMENT_PENDING نیست؛ رفتگر هرگز کاری ندارد", async (policy) => {
    const t = await world(() => new Promise(() => undefined), policy, true);
    const call = t.gw.completeStep(STEP);
    await settleIo();
    // تا یک میلی‌ثانیه پیش از سقف: رزرو زنده است و رفتگر دست نمی‌زند (حتی با sweep در هر گام).
    for (let at = 0; at < MAX_CALL - 1; at += 500) {
      await t.tick(Math.min(500, MAX_CALL - 1 - at));
      expect(await t.sweeper.sweep()).toMatchObject({ examined: 0 });
    }
    expect(ok(await t.outbox.counts())).toEqual({ open: 1, settling: 0, done: 0, dead: 0 });
    await t.tick(1);
    const r = await call;
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: "TIMEOUT" });
    expect(meta(r)).toMatchObject({ outcome: policy === "forfeit" ? "forfeited" : "released", charged: 0, alarms: ["COST_UNKNOWN"] });
    expect(ok(await t.outbox.counts())).toEqual({ open: 0, settling: 0, done: 1, dead: 0 });
    expect(ok(await t.outbox.get(refOf("scope-1.r1")))).toMatchObject({ state: "done" });
    // از اینجا تا بسیار پس از graceMs: رفتگر هرگز چیزی برای بستن نمی‌یابد.
    for (let i = 0; i < 6; i++) {
      await t.tick(GRACE);
      expect(await t.sweeper.sweep()).toMatchObject({ examined: 0 });
    }
    const a = await audit(t.ledger);
    expect(a).toMatchObject({ held: 0, openReservations: 0, charged: 0, forfeited: policy === "forfeit" ? WORST : 0 });
    expect(a.available + a.forfeited).toBe(FUNDS);
    expect(t.events).toEqual([{ kind: "deadline", maxCallMs: MAX_CALL }]);
  });

  it.each(["forfeit", "release"] as const)("جوابِ دیرهنگام (سیاست %s): پول و رکورد را عوض نمی‌کند؛ هزینهٔ معلومش فقط به‌صورتِ رویدادِ بی‌متن برای مغایرت‌گیری می‌آید", async (policy) => {
    let release: (v: unknown) => void = () => undefined;
    const t = await world(() => new Promise((res) => void (release = res)), policy, true);
    const call = t.gw.completeStep(STEP);
    await settleIo();
    await t.tick(MAX_CALL);
    expect((await call).ok).toBe(false);
    const before = await audit(t.ledger);
    await t.tick(GRACE * 2);
    release(stepOk(100)); // تماسِ لغوشده پس از سقف جواب می‌دهد
    await settleIo();
    await t.tick(GRACE);
    expect(await audit(t.ledger)).toEqual(before);
    expect(ok(await t.outbox.counts())).toEqual({ open: 0, settling: 0, done: 1, dead: 0 });
    expect(await t.sweeper.sweep()).toMatchObject({ examined: 0 });
    expect(t.events).toEqual([{ kind: "deadline", maxCallMs: MAX_CALL }, { kind: "late-result", ok: true, cost: { currency: "IRR", micros: 100 } }]);
  });

  it("شاهدِ کنترل (بی‌پوشش): همین سناریو زامبی می‌شود ⇒ settlement-failed با SETTLEMENT_PENDING؛ پس رفع از پوشش است", async () => {
    let release: (v: unknown) => void = () => undefined;
    const t = await world(() => new Promise((res) => void (release = res)), "forfeit", false);
    const call = t.gw.completeStep(STEP);
    await settleIo();
    await t.tick(GRACE + 1);
    expect(await t.sweeper.sweep()).toMatchObject({ examined: 1 }); // رفتگر رزروِ تماسِ زنده را می‌بندد
    release(stepOk(100));
    const r = await call;
    expect(meta(r)).toMatchObject({ outcome: "settlement-failed", alarms: ["SETTLEMENT_PENDING"] });
  });

  it.each(["forfeit", "release"] as const)("جدولِ تأخیر (سیاست %s): هر تأخیر یا جوابِ خودِ دروازه است یا TIMEOUT؛ هرگز settlement-failed؛ مرزِ سقف دقیق", async (policy) => {
    for (const latency of [0, MAX_CALL - 1, MAX_CALL, MAX_CALL + 1, GRACE - 1, GRACE, GRACE + 5000]) {
      let release: (v: unknown) => void = () => undefined;
      const t = await world(() => new Promise((res) => void (release = res)), policy, true);
      const call = t.gw.completeStep(STEP);
      await settleIo();
      if (latency < MAX_CALL) {
        await t.tick(latency);
        release(stepOk(100));
      } else {
        await t.tick(latency); // زمان از سقف می‌گذرد؛ تماس هنوز آویزان است
      }
      const r = await call;
      const label = `latency=${latency}`;
      if (latency < MAX_CALL) expect(meta(r), label).toMatchObject({ outcome: "billed", charged: 100, alarms: [] });
      else expect(meta(r), label).toMatchObject({ outcome: policy === "forfeit" ? "forfeited" : "released", charged: 0, alarms: ["COST_UNKNOWN"] });
      await t.tick(GRACE);
      expect(await t.sweeper.sweep(), label).toMatchObject({ examined: 0 });
      const a = await audit(t.ledger);
      expect(a.openReservations, label).toBe(0);
    }
  });

  it("خطای دروازه با هزینهٔ معلوم (در مهلت) همان هزینه را می‌پردازد؛ پوشش آن را دست نمی‌زند", async () => {
    const t = await world(stepErr("PROVIDER_ERROR", { cost: { micros: 40, currency: "IRR", priceVersion: "test-v1" } }), "forfeit", true);
    const r = await t.gw.completeStep(STEP);
    expect(meta(r)).toMatchObject({ outcome: "billed", charged: 40 });
    expect(t.timers.pending()).toBe(0);
  });

  it("ویژگی (۶۰ بذر × دو سیاست): گام‌های آمیخته با تأخیرهای درمهلت/برمرز/بیش از سقف/هرگز؛ بقا، بی‌settlement-failed، بی‌رزروِ باز، رفتگرِ بی‌کار و داورِ مستقل از روی طرح", async () => {
    let timedOut = 0;
    let billed = 0;
    for (const policy of ["forfeit", "release"] as const) {
      for (let seed = 1; seed <= 60; seed++) {
        const rnd = prng(seed * 31 + (policy === "forfeit" ? 1 : 2));
        const n = 2 + Math.floor(rnd() * 5);
        const lat = Array.from({ length: n }, () => {
          const r = rnd();
          return r < 0.25 ? Number.POSITIVE_INFINITY : r < 0.4 ? MAX_CALL : r < 0.5 ? MAX_CALL - 1 : r < 0.65 ? MAX_CALL + 1 + Math.floor(rnd() * 5000) : Math.floor(rnd() * (MAX_CALL - 1));
        });
        const gates: Array<(v: unknown) => void> = [];
        const t = await world(() => new Promise((res) => void gates.push(res)), policy, true);
        const calls: ReturnType<typeof t.gw.completeStep>[] = [];
        for (let i = 0; i < n; i++) {
          calls.push(t.gw.completeStep(STEP)); // پیاپی ولی همه در t=0؛ ترتیبِ ورود = ترتیبِ شماره
          await settleIo();
        }
        expect(gates).toHaveLength(n); // هر گام جدا رزرو و شروع شد
        // رویدادها به ترتیبِ زمانِ سررسیدِ خودشان؛ همهٔ گام‌ها هم‌زمان آغاز شده‌اند (t=0).
        const marks = [...new Set([...lat.filter((x) => x < MAX_CALL), MAX_CALL])].sort((a, b) => a - b);
        let now = 0;
        for (const m of marks) {
          await t.tick(m - now);
          now = m;
          lat.forEach((l, i) => {
            if (l === m && m < MAX_CALL) gates[i]!(stepOk(10 + i));
          });
          await settleIo();
        }
        const results = await Promise.all(calls);
        results.forEach((r, i) => {
          const l = lat[i]!;
          const label = `${policy}/seed=${seed}/i=${i}`;
          if (l < MAX_CALL) {
            expect(meta(r), label).toMatchObject({ outcome: "billed", charged: 10 + i });
            billed += 1;
          } else {
            expect(meta(r), label).toMatchObject({ outcome: policy === "forfeit" ? "forfeited" : "released", charged: 0 });
            timedOut += 1;
          }
        });
        await t.tick(GRACE * 3);
        expect(await t.sweeper.sweep(), `${policy}/seed=${seed}`).toMatchObject({ examined: 0 });
        const a = await audit(t.ledger);
        expect(a.openReservations).toBe(0);
        const expectedCharged = lat.reduce((s, l, i) => (l < MAX_CALL ? s + 10 + i : s), 0);
        const expectedForfeit = policy === "forfeit" ? lat.filter((l) => !(l < MAX_CALL)).length * WORST : 0;
        expect(a).toMatchObject({ charged: expectedCharged, forfeited: expectedForfeit });
        expect(ok(await t.outbox.counts())).toEqual({ open: 0, settling: 0, done: n, dead: 0 });
      }
    }
    expect(billed).toBeGreaterThan(100); // ادعای پوشش
    expect(timedOut).toBeGreaterThan(100);
  });
});
