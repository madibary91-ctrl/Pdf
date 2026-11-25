/** ویژگی‌آزمایی با بذرِ قطعی و داورِ مستقل از روی «طرح» (نه از روی خروجیِ ماژول). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolStepResult } from "@/modules/ai-gateway";
import { INPUT, MAX_CALL, build, deferred, flush, prng, stepErr, stepOk } from "./test-kit";
import type { Deferred } from "./test-kit";

const unhandled: unknown[] = [];
const onUnhandled = (e: unknown): void => void unhandled.push(e);
beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => void process.off("unhandledRejection", onUnhandled));

type Plan = Readonly<{ startAt: number; latency: number | null; kind: "ok" | "err" | "throw" | "reject" }>;

describe("tool-call-deadline · ویژگی (۳۰۰ بذر)", () => {
  it("هر گام دقیقاً یک بار تمام می‌شود؛ زودتر از سقف ⇒ جوابِ خودِ دروازه، وگرنه TIMEOUT؛ تایمر هرگز نمی‌ماند؛ بی‌rejectionِ کنترل‌نشده", async () => {
    let timedOut = 0;
    let passed = 0;
    let threw = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = prng(seed);
      const n = 1 + Math.floor(rnd() * 6);
      const plans: Plan[] = Array.from({ length: n }, () => {
        const r = rnd();
        return {
          startAt: Math.floor(rnd() * 4000),
          // تأخیر: بیشترش درمهلت، بخشی دقیقاً روی مرز، بخشی بیش از سقف، بخشی هرگز.
          latency: r < 0.15 ? null : r < 0.3 ? MAX_CALL : r < 0.4 ? MAX_CALL - 1 : r < 0.6 ? MAX_CALL + 1 + Math.floor(rnd() * 5000) : Math.floor(rnd() * (MAX_CALL - 1)),
          kind: (["ok", "ok", "err", "throw", "reject"] as const)[Math.floor(rnd() * 5)]!,
        };
      });
      const order = plans.map((_, i) => i).sort((a, b) => plans[a]!.startAt - plans[b]!.startAt || a - b);
      const gates: Deferred<unknown>[] = plans.map(() => deferred<unknown>());
      let started = 0;
      const stamps: number[] = []; // زمانِ مجازیِ هر رویدادِ deadline (همگام در تایمر ثبت می‌شود)
      const t: ReturnType<typeof build> = build(() => gates[started++]!.promise, { onEvent: (e: { kind: string }) => void (e.kind === "deadline" && stamps.push(t.timers.now())) });

      // رویدادهای زمانی (آغاز و پایانِ تماس‌ها) روی یک محورِ مجازی؛ پایان‌ها به ترتیب (زمان، شمارهٔ ورودی).
      type Ev = { at: number; seq: number; run: () => void };
      const evs: Ev[] = [];
      const results: Array<ToolStepResult | undefined> = plans.map(() => undefined);
      order.forEach((idx, pos) => {
        const p = plans[idx]!;
        evs.push({
          at: p.startAt,
          seq: pos,
          run: () => {
            void t.gw.completeStep(INPUT).then((r) => {
              results[pos] = r;
            });
          },
        });
        if (p.latency !== null) {
          evs.push({
            at: p.startAt + p.latency,
            seq: 1000 + pos,
            run: () => {
              const g = gates[pos]!;
              if (p.kind === "ok") g.resolve(stepOk(10 + pos));
              else if (p.kind === "err") g.resolve(stepErr("PROVIDER_ERROR"));
              else if (p.kind === "throw") g.reject(new Error("LEAK-CANARY"));
              else g.reject(new Error("LEAK-CANARY"));
            },
          });
        }
      });
      evs.sort((a, b) => a.at - b.at || a.seq - b.seq);
      for (const e of evs) {
        if (e.at > t.timers.now()) {
          // سقف‌های سررسیده پیش از این رویداد اجرا شوند.
          t.timers.advance(e.at - t.timers.now());
          await flush(10);
        }
        e.run();
        await flush(10);
      }
      t.timers.advance(MAX_CALL * 3);
      await flush(20);

      plans.forEach((_, pos) => {
        const p = plans[order[pos]!]!;
        const r = results[pos];
        const label = `seed=${seed} pos=${pos}`;
        expect(r, label).toBeDefined();
        const inTime = p.latency !== null && p.latency < MAX_CALL;
        if (inTime && (p.kind === "ok" || p.kind === "err")) {
          expect(r!.ok, label).toBe(p.kind === "ok");
          if (!r!.ok) expect(r!.error.code, label).toBe("PROVIDER_ERROR");
          passed += 1;
        } else if (inTime) {
          expect(!r!.ok && r!.error.code, label).toBe("INTERNAL_ERROR");
          threw += 1;
        } else {
          expect(!r!.ok && r!.error.code, label).toBe("TIMEOUT");
          timedOut += 1;
        }
      });
      expect(t.timers.pending(), `seed=${seed}`).toBe(0);
      // سقف‌ها درست در «آغاز + MAX_CALL» می‌رسند (نه زودتر و نه دیرتر): چندمجموعهٔ زمان‌ها با طرح برابر است.
      const expectedStamps = plans.filter((p) => !(p.latency !== null && p.latency < MAX_CALL)).map((p) => p.startAt + MAX_CALL).sort((a, b) => a - b);
      expect([...stamps].sort((a, b) => a - b), `seed=${seed}`).toEqual(expectedStamps);
      expect(JSON.stringify([results, stamps]), `seed=${seed}`).not.toContain("LEAK-CANARY");
    }
    await new Promise((res) => setImmediate(res));
    expect(unhandled).toEqual([]);
    // ادعای پوشش: هر سه شاخه واقعاً دیده شده‌اند.
    expect(passed).toBeGreaterThan(100);
    expect(timedOut).toBeGreaterThan(100);
    expect(threw).toBeGreaterThan(20);
  });
});
