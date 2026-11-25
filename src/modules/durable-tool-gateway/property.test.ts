/**
 * ویژگی‌آزمایی با ۳۰۰ بذرِ قطعی: دنباله‌ای تصادفی از گام‌ها (موفق، هزینهٔ نامعلوم، شکستِ هزینه‌دار، بی‌تماس، مرگِ فرایند) با خطای تزریقیِ دفتر/outbox.
 * داورِ مستقل: پس از گذشتنِ مهلت و چند دورِ رفتگر، (۱) هیچ رزرو/رکوردِ بازی نمی‌ماند، (۲) پول حفظ می‌شود، (۳) مصرف دقیقاً همان است که از
 * طرحِ بذر برمی‌آید (کاربر هرگز مجانی نمی‌گیرد، مگر سیاستِ صریحِ release برای هزینهٔ نامعلوم/فرایندِ مرده).
 */
import { describe, expect, it } from "vitest";
import { GRACE, STEP, WORST, audit, flakyLedger, flakyOutbox, ok, prng, stepErr, stepOk, world } from "./test-kit";
import type { WorldOptions } from "./test-kit";

type Kind = "ok" | "unknown" | "errcost" | "invalid" | "hang";
type Fault = "none" | "charge" | "close" | "outbox-charge" | "outbox-begin";
type Plan = Readonly<{ policy: "forfeit" | "release"; fault: Fault; skip: number; steps: readonly { kind: Kind; micros: number }[] }>;

const KINDS: readonly Kind[] = ["ok", "unknown", "errcost", "invalid", "hang"];
const FAULTS: readonly Fault[] = ["none", "charge", "close", "outbox-charge", "outbox-begin"];
const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

function planOf(seed: number): Plan {
  const r = prng(seed * 7919);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const fault = pick(FAULTS);
  // outbox-charge فقط با forfeit معنا دارد (با release رزروِ بی‌قصدِ ثبت‌شده طبق سیاستِ صریح آزاد می‌شود).
  const policy = fault === "outbox-charge" ? "forfeit" : pick(["forfeit", "release"] as const);
  const n = 3 + Math.floor(r() * 4);
  const steps = Array.from({ length: n }, () => ({ kind: pick(KINDS), micros: 1 + Math.floor(r() * 400) }));
  return { policy, fault, skip: Math.floor(r() * 3), steps };
}

describe("durable-tool-gateway · ویژگی‌آزمایی (۳۰۰ بذر، داورِ مستقل)", () => {
  it.each(SEEDS)("بذر %i: پول حفظ و هیچ چیز باز نمی‌ماند؛ مصرف دقیقاً طبق طرح", async (seed) => {
    const plan = planOf(seed);
    const reply = (_input: unknown, n: number): unknown => {
      const s = plan.steps[n % plan.steps.length]!;
      switch (s.kind) {
        case "ok":
          return stepOk(s.micros);
        case "unknown":
          return stepOk(null);
        case "errcost":
          return stepErr("PROVIDER_ERROR", { cost: { micros: s.micros, currency: "IRR", priceVersion: "test-v1" } });
        case "invalid":
          return stepErr("INVALID_REQUEST");
        case "hang":
          return new Promise(() => undefined);
      }
    };
    const o: WorldOptions = { funds: 1_000_000, policy: plan.policy };
    if (plan.fault === "charge") o.ledger = (l) => flakyLedger(l, { charge: { fail: 3, skip: plan.skip } });
    if (plan.fault === "close") o.ledger = (l) => flakyLedger(l, { close: { fail: 3, skip: plan.skip } });
    if (plan.fault === "outbox-charge") o.outbox = (m) => flakyOutbox(m, { recordCharge: { fail: 999 } });
    if (plan.fault === "outbox-begin") o.outbox = (m) => flakyOutbox(m, { begin: { fail: 1, skip: plan.skip } });
    const t = await world(reply, o);

    // گام‌ها پیاپی؛ گامِ «مرده» رها می‌شود و تا رسیدنِ تماس به دروازهٔ درونی صبر می‌کنیم.
    for (let i = 0; i < plan.steps.length; i++) {
      const before = t.stub.inputs.length;
      const p = t.gw.completeStep(STEP);
      const kindAtCall = plan.steps[before % plan.steps.length]!.kind;
      const willReach = (): boolean => t.stub.inputs.length > before;
      if (kindAtCall === "hang") {
        // گامِ مرده هرگز تمام نمی‌شود، مگر آن‌که begin ردش کند؛ پس تا «رسیدنِ تماس» یا «پایانِ گام» صبر می‌کنیم.
        let finished = false;
        void p.then(() => void (finished = true));
        for (let k = 0; k < 2000 && !willReach() && !finished; k++) await new Promise((res) => setTimeout(res, 1));
      } else {
        await p;
      }
    }

    t.clock.advance(GRACE);
    for (let k = 0; k < 6; k++) if ((await t.sweeper.sweep()).examined === 0) break;
    t.clock.advance(GRACE);
    for (let k = 0; k < 6; k++) if ((await t.sweeper.sweep()).examined === 0) break;

    const a = await audit(t.ledger);
    expect(a.held).toBe(0);
    expect(a.openReservations).toBe(0);
    expect(a.available + a.charged + a.forfeited).toBe(a.granted);
    const c = ok(await t.outbox.counts());
    expect(c.open + c.settling + c.dead).toBe(0);

    // مصرفِ مورد انتظار از طرح: فقط گام‌هایی که واقعاً به مدل رسیدند (بی‌ردِ begin).
    const reached = t.stub.inputs.length;
    let known = 0;
    let unknownOrDead = 0;
    for (let n = 0; n < reached; n++) {
      const s = plan.steps[n % plan.steps.length]!;
      if (s.kind === "ok" || s.kind === "errcost") known += s.micros;
      else if (s.kind === "unknown" || s.kind === "hang") unknownOrDead += 1;
    }
    if (plan.fault === "outbox-charge") {
      // قصدِ مصرف هرگز ثبت نشد ⇒ رفتگر کفِ امن را می‌گیرد: همهٔ گام‌های رسیده به مدل (جز بی‌تماسِ اثبات‌شده) سوخته‌اند.
      const modelCalls = Array.from({ length: reached }, (_, n) => plan.steps[n % plan.steps.length]!.kind).filter((k) => k !== "invalid").length;
      expect(a.charged).toBe(0);
      expect(a.forfeited).toBe(modelCalls * WORST);
    } else {
      expect(a.charged).toBe(known);
      expect(a.forfeited).toBe(plan.policy === "forfeit" ? unknownOrDead * WORST : 0);
    }
  });

  it("ادعای پوشش: هر نوعِ گام و هر نوعِ خطا و هر دو سیاست در ۳۰۰ بذر دست‌کم چند بار رخ می‌دهد", () => {
    const plans = SEEDS.map(planOf);
    for (const k of KINDS) expect(plans.filter((p) => p.steps.some((s) => s.kind === k)).length, k).toBeGreaterThan(30);
    for (const f of FAULTS) expect(plans.filter((p) => p.fault === f).length, f).toBeGreaterThan(30);
    for (const pol of ["forfeit", "release"] as const) expect(plans.filter((p) => p.policy === pol).length, pol).toBeGreaterThan(30);
  });
});
