import { describe, expect, it } from "vitest";
import type { ToolCall } from "@/modules/ai-gateway";
import { sumStepSpend } from "@/modules/ai-gateway";
import type { LoopAction, LoopOutcome } from "./index";
import { START, call, cost, mkLoop, must, okResults, stepErr, stepOk, stepTruncated, usage } from "./test-kit";

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T };
}

describe("tool-loop · پایداریِ تصادفی (۳۰۰ بذر): پایان‌پذیری، سقف‌ها و حسابداری", () => {
  it("برای هر پیکربندی و رفتارِ مدل/ابزار ناوردا‌ها برقرارند", () => {
    const reasons = new Set<string>();
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const maxSteps = r.int(1, 8);
      const maxToolCalls = r.int(1, 12);
      const maxIdenticalCalls = r.int(1, 3);
      const truncationRetries = r.int(0, 2);
      const capped = r.next() < 0.6;
      const currency = "IRR";
      const maxMicros = r.int(200, 5000);
      const est = r.int(0, 600);
      const estCalls: { known: number; est: number }[] = [];
      const loop = mkLoop({
        maxSteps,
        maxToolCalls,
        maxIdenticalCalls,
        truncationRetries,
        budget: capped ? { kind: "cap", currency, maxMicros, estimateStepMicros: () => est } : { kind: "none" },
      });

      let t = must(loop.start({ ...START, format: r.pick(["openai-chat", "anthropic-messages"] as const) }));
      const actions: LoopAction[] = [t.action];
      const stepCosts: (number | null)[] = [];
      let idCounter = 0;
      let modelCalls = 0;
      let toolRuns = 0;
      for (let guard = 0; guard < 200 && t.action.kind !== "done"; guard++) {
        const a = t.action;
        if (a.kind === "call-model") {
          modelCalls++;
          // ناوردا: هر گامی که شروع می‌شود در سقفِ گام و (اگر سقف دارد) در سقفِ هزینه می‌ماند.
          expect(a.step).toBe(modelCalls);
          expect(a.step).toBeLessThanOrEqual(maxSteps);
          if (capped) {
            const known = stepCosts.reduce<number>((s, c) => s + (c ?? 0), 0);
            expect(stepCosts.every((c) => c !== null)).toBe(true);
            expect(known + est).toBeLessThanOrEqual(maxMicros);
          }
          const c = r.next() < 0.08 ? null : r.int(0, 700);
          stepCosts.push(c);
          const kind = r.pick(["tool", "tool", "tool", "text", "text", "trunc", "fail", "length", "filter", "empty"] as const);
          const costV = c === null ? null : cost(c);
          const base = { cost: costV, usage: usage(r.int(0, 900), r.int(0, 900)) };
          const calls: ToolCall[] = Array.from({ length: r.int(1, 3) }, () => call(`id${idCounter++}`, { v: r.int(0, 3) }));
          const ev =
            kind === "tool" ? stepOk({ ...base, calls })
            : kind === "text" ? stepOk({ ...base, text: "پاسخ" })
            : kind === "trunc" ? stepTruncated({ ...base })
            : kind === "fail" ? stepErr("PROVIDER_ERROR", { ...base })
            : kind === "length" ? stepOk({ ...base, finish: "length", text: "ناقص" })
            : kind === "filter" ? stepOk({ ...base, finish: "content_filter", text: "" })
            : stepOk({ ...base, text: "  " });
          t = must(loop.onStep(t.state, ev));
        } else if (a.kind === "run-tools") {
          toolRuns += a.calls.length;
          const bad = r.next() < 0.2;
          t = must(loop.onToolResults(t.state, okResults(a.calls, { reviewPending: r.next() < 0.5, ...(bad ? { isError: true } : {}) })));
        }
        actions.push(t.action);
      }
      expect(t.action.kind, `seed ${seed}: پایان‌پذیری`).toBe("done");
      const o: LoopOutcome = (t.action as Extract<LoopAction, { kind: "done" }>).outcome;
      reasons.add(o.status === "answered" ? "answered" : o.reason);

      expect(o.steps, `seed ${seed}`).toBe(modelCalls);
      expect(o.steps).toBeLessThanOrEqual(maxSteps);
      expect(o.toolCalls).toBeLessThanOrEqual(maxToolCalls);
      expect(o.toolCalls).toBe(toolRuns);
      // حسابداری: جمعِ گزارش‌شده = جمعِ هزینهٔ گام‌های داده‌شده؛ نامعلوم‌ها جدا شمرده می‌شوند.
      const expected = sumStepSpend(stepCosts.slice(0, o.steps).map((c) => ({ usage: null, cost: c === null ? null : cost(c) })));
      expect(o.spend.cost).toEqual(expected.cost);
      expect(o.spend.unknownCostSteps).toBe(stepCosts.slice(0, o.steps).filter((c) => c === null).length);
      // پاسخ فقط از گامِ متنیِ نهایی؛ «answered» هیچ‌گاه متنِ تهی ندارد.
      if (o.status === "answered") expect(o.text.trim().length).toBeGreaterThan(0);
      else expect("text" in o).toBe(false);
      // پس از done هیچ رویدادی پذیرفته نمی‌شود.
      expect(loop.onStep(t.state, stepOk()).ok).toBe(false);
      expect(loop.cancel(t.state).ok).toBe(false);
      // ترتیبِ کنش‌ها: بعد از run-tools همیشه call-model یا done؛ بعد از call-model هرگز call-model.
      for (let i = 1; i < actions.length; i++) {
        const prev = actions[i - 1]!.kind;
        const cur = actions[i]!.kind;
        if (prev === "done") throw new Error("کنش پس از done");
        if (prev === "run-tools") expect(cur === "call-model" || cur === "done").toBe(true);
      }
    }
    // پوششِ سناریو: تصادفی‌ها واقعاً چند نوع پایان را دیده‌اند.
    expect(reasons.size).toBeGreaterThanOrEqual(6);
    expect(reasons.has("answered")).toBe(true);
  });
});
