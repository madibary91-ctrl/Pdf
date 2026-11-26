/**
 * مدل‌محور: ۳۰۰ بذر × ۶۰ گام (start/stop/advance/نتیجهٔ منبع از انواعِ مختلف، از جمله نتیجهٔ دیرهنگامِ تلاشِ رهاشده) در برابرِ یک داورِ مستقل
 * که فقط «ماشینِ حالتِ زمان‌دار» را می‌داند. پس از هر گام: وضعیت، شمارنده‌ها، تعدادِ فراخوانیِ منبع و تعدادِ تایمرهای زنده یکی است.
 */
import { describe, expect, it } from "vitest";
import { createPolicyRefresher } from "./refresher";
import { controlledSource, DEADLINE, failResult, fakeTimer, flush, goodOptions, INTERVAL, okResult, prng, RETRY } from "./test-kit";
import type { AttemptOutcome, RefresherStopResult } from "./types";

type Kind = "ok" | "fail" | "superseded" | "garbage" | "reject";

class Model {
  t = 0;
  phase: "idle" | "running" | "stopping" = "idle";
  inflight = false;
  live = 0;
  calls = 0;
  attempts = 0;
  failures = 0;
  lastOutcome: AttemptOutcome | null = null;
  nextAt: number | null = null;
  deadlineAt: number | null = null;
  launch(): void {
    this.inflight = true;
    this.deadlineAt = this.t + DEADLINE;
    this.nextAt = null;
    this.attempts += 1;
    this.calls += 1;
    this.live = this.calls;
  }
  settle(o: AttemptOutcome): void {
    this.inflight = false;
    this.deadlineAt = null;
    this.lastOutcome = o;
    if (o === "ok") this.failures = 0;
    else if (o !== "superseded") this.failures += 1;
    if (this.phase === "stopping") {
      this.phase = "idle";
      return;
    }
    this.nextAt = this.t + (o === "ok" ? INTERVAL : RETRY);
  }
  start(): void {
    if (this.phase !== "idle") return;
    this.phase = "running";
    this.launch();
  }
  stop(): void {
    if (this.phase === "idle" || this.phase === "stopping") return;
    this.nextAt = null;
    this.phase = this.inflight ? "stopping" : "idle";
  }
  advance(d: number): void {
    const end = this.t + d;
    for (;;) {
      const e = this.inflight ? this.deadlineAt : this.phase === "running" ? this.nextAt : null;
      if (e === null || e > end) break;
      this.t = e;
      if (this.inflight) this.settle("timed_out");
      else this.launch();
    }
    this.t = end;
  }
  resolve(id: number, k: Kind): void {
    if (!this.inflight || id !== this.live) return;
    this.settle(k === "ok" ? "ok" : k === "superseded" ? "superseded" : "failed");
  }
  timers(): number {
    return this.phase === "idle" ? 0 : 1;
  }
}

const SEEDS = 300;
const STEPS = 60;

describe("tool-policy-refresher · مدل‌محور", () => {
  it(`${SEEDS} بذر × ${STEPS} گام: حلقه با ماشینِ حالتِ مرجع هم‌سان است`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rnd = prng(seed);
      const t = fakeTimer();
      const s = controlledSource();
      const created = createPolicyRefresher(goodOptions(s.source, t.timer));
      if (!created.ok) throw new Error("x");
      const r = created.value;
      const m = new Model();
      const stops: Promise<RefresherStopResult>[] = [];
      for (let step = 0; step < STEPS; step++) {
        const x = rnd();
        let what: string;
        if (x < 0.15) {
          what = "start";
          r.start();
          m.start();
        } else if (x < 0.27) {
          what = "stop";
          stops.push(r.stop());
          m.stop();
        } else if (x < 0.6) {
          const d = Math.floor(rnd() * 2 * INTERVAL);
          what = `advance ${d}`;
          t.advance(d);
          m.advance(d);
        } else if (s.pending.length > 0) {
          const i = Math.floor(rnd() * s.pending.length);
          const call = s.pending.splice(i, 1)[0]!;
          const kind: Kind = (["ok", "fail", "superseded", "garbage", "reject"] as const)[Math.floor(rnd() * 5)]!;
          what = `resolve#${call.id} ${kind}`;
          if (kind === "ok") call.resolve(okResult);
          else if (kind === "fail") call.resolve(failResult("READ_FAILED"));
          else if (kind === "superseded") call.resolve(failResult("SUPERSEDED"));
          else if (kind === "garbage") call.resolve({ ok: 1 });
          else call.reject(new Error("secret-x"));
          m.resolve(call.id, kind);
        } else {
          what = "noop";
        }
        await flush();
        const st = r.status();
        const ctx = `seed ${seed} step ${step} ${what}`;
        expect(st.state, ctx).toBe(m.phase);
        expect(st.inFlight, ctx).toBe(m.inflight);
        expect(st.attempts, ctx).toBe(m.attempts);
        expect(st.consecutiveFailures, ctx).toBe(m.failures);
        expect(st.lastOutcome, ctx).toBe(m.lastOutcome);
        expect(s.calls(), ctx).toBe(m.calls);
        expect(t.pending(), ctx).toBe(m.timers());
        expect(JSON.stringify(st), ctx).not.toContain("secret");
      }
      // پایان: هر stopِ معلق باید با رسیدنِ مهلت یا نتیجه تمام شود (قفلِ همیشگی ممنوع)
      t.advance(10 * (DEADLINE + INTERVAL));
      await flush();
      void r.stop();
      t.advance(DEADLINE);
      await flush();
      for (const p of stops) await p;
      expect(r.status().state, `seed ${seed} final`).toBe("idle");
      expect(t.pending(), `seed ${seed} final`).toBe(0);
    }
  });
});
