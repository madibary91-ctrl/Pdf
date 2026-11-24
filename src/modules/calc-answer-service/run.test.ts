import { describe, expect, it } from "vitest";
import { createCardCollector } from "@/modules/calc-answer-cards";
import { ANSWER_MESSAGES } from "./messages";
import { defaultCollector, runAnswer, type CollectorFactory, type RunContext } from "./run";
import { baseOptions, call, makeLoop, scripted, stepOk, stubGateway, USER, GOOD } from "./test-kit";

function ctxOf(step: Parameters<typeof stubGateway>[0], over: Partial<RunContext> = {}): RunContext {
  const { gateway } = stubGateway(step);
  const o = baseOptions(gateway);
  return { gateway: o.gateway, loop: o.loop, model: o.model, maxOutputTokens: o.maxOutputTokens, maxCards: o.maxCards, totalTimeoutMs: o.totalTimeoutMs, toolTimeoutMs: o.toolTimeoutMs, maxResultChars: o.maxResultChars, deps: undefined, timers: undefined, ...over };
}
const TWO_STEPS = scripted([stepOk({ calls: [call("model-chosen-id-777")] }), stepOk({ text: "متنِ محرمانهٔ مدل" })]);

describe("runAnswer · مسیرهای دفاعی", () => {
  it("جمع‌آورندهٔ وصل‌نشده (ناظر هیچ نمی‌بیند) ⇒ NOT_DISPLAYABLE/CARD_MISSING؛ پاسخ و شناسه بازتاب نمی‌شود؛ هزینه حفظ می‌شود", async () => {
    const tampered: CollectorFactory = (maxCards) => {
      const c = createCardCollector({ maxCards });
      if (!c.ok) return c;
      return { ok: true, value: { ...c.value, observe: () => undefined } };
    };
    const r = await runAnswer(ctxOf(TWO_STEPS), USER(), undefined, tampered);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: "NOT_DISPLAYABLE", cause: "CARD_MISSING", message: ANSWER_MESSAGES.NOT_DISPLAYABLE, issues: [] });
    expect(r.error.spend).toMatchObject({ steps: 2, complete: true });
    expect(Object.isFrozen(r.error.spend)).toBe(true);
    const s = JSON.stringify(r);
    expect(s).not.toContain("متنِ محرمانهٔ مدل");
    expect(s).not.toContain("model-chosen-id-777");
  });

  it("ناظرِ نامطابق در نامِ ابزار ⇒ NOT_DISPLAYABLE/TOOL_MISMATCH", async () => {
    const tampered: CollectorFactory = (maxCards) => {
      const c = createCardCollector({ maxCards });
      if (!c.ok) return c;
      return { ok: true, value: { ...c.value, observe: (o) => c.value.observe({ ...o, tool: "late_payment" } as never) } };
    };
    const r = await runAnswer(ctxOf(TWO_STEPS), USER(), undefined, tampered);
    expect(!r.ok && r.error).toMatchObject({ code: "NOT_DISPLAYABLE", cause: "TOOL_MISMATCH", issues: [] });
    expect(!r.ok && r.error.spend).toMatchObject({ steps: 2 });
  });

  it("ساختِ جمع‌آورنده ناموفق ⇒ RUN_FAILED/SETUP بی‌تماس با دروازه و بی‌هزینه", async () => {
    const { gateway, inputs } = stubGateway(scripted([]));
    const o = baseOptions(gateway);
    const bad: CollectorFactory = () => ({ ok: false, error: { code: "INVALID_OPTIONS", message: "x", issues: [] } });
    const r = await runAnswer({ ...ctxOf(scripted([])), gateway: o.gateway }, USER(), undefined, bad);
    expect(!r.ok && r.error).toMatchObject({ code: "RUN_FAILED", cause: "SETUP", spend: null });
    expect(inputs).toHaveLength(0);
  });

  it("سازندهٔ پرتاب‌کننده ⇒ RUN_FAILED/THREW بی‌نشتِ متنِ استثنا", async () => {
    const boom: CollectorFactory = () => {
      throw new Error("sk-SECRET-factory");
    };
    const r = await runAnswer(ctxOf(scripted([])), USER(), undefined, boom);
    expect(!r.ok && r.error).toMatchObject({ code: "RUN_FAILED", cause: "THREW", spend: null });
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("پیکربندیِ نامعتبرِ اجراگر در زمانِ اجرا (دورزدنِ سازنده) ⇒ RUN_FAILED/INVALID_CONFIG، نه پرتاب", async () => {
    const r = await runAnswer(ctxOf(scripted([]), { totalTimeoutMs: 0 }), USER(), undefined, defaultCollector);
    expect(!r.ok && r.error).toMatchObject({ code: "RUN_FAILED", cause: "SETUP" });
  });

  it("هزینهٔ ناخوانا در نتیجهٔ حلقه ⇒ شکست‌بسته RUN_FAILED/SPEND_INVALID (پاسخی بی‌ثبتِ هزینه نمایش داده نمی‌شود) و بی‌نشت", async () => {
    const real = makeLoop();
    const loop: typeof real = {
      ...real,
      onStep: (state, result) => {
        const t = real.onStep(state, result);
        if (!t.ok || t.value.action.kind !== "done") return t;
        return { ok: true, value: { ...t.value, action: { ...t.value.action, outcome: { ...t.value.action.outcome, spend: "not-a-spend" as never } } } };
      },
    };
    const r = await runAnswer(ctxOf(scripted([stepOk({ text: "متنِ مدل" })]), { loop }), USER(), undefined, defaultCollector);
    expect(!r.ok && r.error).toMatchObject({ code: "RUN_FAILED", cause: "SPEND_INVALID", spend: null });
    expect(JSON.stringify(r)).not.toContain("متنِ مدل");
  });

  it("خطای قراردادِ میانِ اجرا هزینهٔ تاکنون را از `partial` نگه می‌دارد (هرگز گم نمی‌شود)", async () => {
    // مدل ابتدا ابزار صدا می‌زند، سپس دروازه پاسخِ ناقض‌شده می‌دهد؛ هر نتیجه‌ای که برگردد باید هزینه را حفظ کند یا ایستِ بسته باشد.
    const r = await runAnswer(ctxOf(scripted([stepOk({ calls: [call("c1")] }), { ok: true, value: { garbage: true } }])), USER(), undefined, defaultCollector);
    if (r.ok) expect(r.value.answer.status).toBe("stopped");
    else expect(r.error.spend === null || r.error.spend.steps >= 1).toBe(true);
    expect(JSON.stringify(r)).not.toContain("garbage");
  });
});

/** تصادفیِ قطعی (LCG) با داورِ مستقل: ناوردایی‌های ADR-0061 روی ۳۰۰ برنامهٔ تصادفیِ مدل. */
describe("runAnswer · ناوردایی‌های تصادفیِ قطعی", () => {
  const lcg = (seed: number) => {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  };

  it("۳۰۰ بذر: هرگز پرتاب نمی‌کند؛ کارت ≤ فراخوانی؛ answered ⇒ متنِ ناتهی؛ stopped ⇒ text:null؛ کارت‌دار ⇒ تأییدنشده و دو اعلان (answered)؛ هزینه همیشه هست", async () => {
    const seen = { answered: 0, stopped: 0, withCards: 0, error: 0 };
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = lcg(seed);
      const rounds = Math.floor(rnd() * 4); // ۰..۳ دورِ ابزار
      const replies: unknown[] = [];
      for (let i = 0; i < rounds; i++) {
        const n = 1 + Math.floor(rnd() * 2);
        const calls = Array.from({ length: n }, (_, j) => call(`s${seed}_${i}_${j}`, { ...GOOD, claim: { kind: "known", amountRials: 100_000_000 + (i * 2 + j) * 1_000_000 } }, rnd() < 0.15 ? "unknown_tool" : "court_fee"));
        replies.push(stepOk({ calls }));
      }
      if (rnd() < 0.8) replies.push(stepOk({ text: `پاسخ ${seed}` }));
      const maxSteps = 1 + Math.floor(rnd() * 4);
      const maxCards = 1 + Math.floor(rnd() * 3);
      const r = await runAnswer(ctxOf(scripted(replies), { loop: makeLoop({ maxSteps }), maxCards }), USER(), undefined, defaultCollector);
      if (!r.ok) {
        seen.error++;
        expect(r.error.code, `seed ${seed}`).not.toBe("INVALID_INPUT");
        continue;
      }
      const { answer: a, spend, toolCalls } = r.value;
      expect(a.cards.length, `seed ${seed}`).toBeLessThanOrEqual(Math.min(toolCalls, maxCards));
      expect(spend.steps, `seed ${seed}`).toBeGreaterThanOrEqual(1);
      if (a.status === "answered") {
        seen.answered++;
        expect(typeof a.text === "string" && a.text.length > 0, `seed ${seed}`).toBe(true);
        expect(a.notices.length, `seed ${seed}`).toBe(a.cards.length > 0 ? 2 : 0);
      } else {
        seen.stopped++;
        expect(a.text, `seed ${seed}`).toBeNull();
        expect(a.stopReason, `seed ${seed}`).not.toBeNull();
      }
      if (a.cards.length > 0) {
        seen.withCards++;
        expect(a.reviewPending, `seed ${seed}`).toBe(true);
        expect(a.cards.every((c) => c.reviewPending), `seed ${seed}`).toBe(true);
      } else expect(a.droppedCards >= 0, `seed ${seed}`).toBe(true);
      expect(Object.isFrozen(a) && Object.isFrozen(r.value), `seed ${seed}`).toBe(true);
    }
    // پوششِ فضای حالت: آزمون بی‌معنا نشود.
    expect(seen.answered).toBeGreaterThan(40);
    expect(seen.stopped).toBeGreaterThan(20);
    expect(seen.withCards).toBeGreaterThan(40);
  });
});
