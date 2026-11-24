import { describe, expect, it } from "vitest";
import { createToolLoop, type LoopAction } from "./index";
import { START, call, cost, drive, mkLoop, must, mustFail, okResults, outcomeOf, stepErr, stepOk, stepTruncated, usage } from "./test-kit";
import type { ToolWireFormat } from "@/modules/ai-gateway";

const FORMATS: readonly ToolWireFormat[] = ["openai-chat", "anthropic-messages"];
const CANARY = "CANARY-نشت-نباید-شود";
const kinds = (xs: readonly LoopAction[]) => xs.map((a) => a.kind);

describe("tool-loop · ساخت و شروع", () => {
  it("پیکربندیِ نامعتبر ⇒ INVALID_CONFIG و پرتاب نمی‌شود", () => {
    const r = createToolLoop({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_CONFIG");
  });

  it("start ⇒ call-model گامِ ۱ با continuationِ تهی و سقفِ پایه", () => {
    const t = must(mkLoop().start(START));
    expect(t.action).toEqual({ kind: "call-model", step: 1, continuation: [], maxOutputTokens: 500 });
    expect(t.state.phase).toBe("awaiting-step");
    expect(Object.isFrozen(t.state)).toBe(true);
    expect(Object.isFrozen(t.action)).toBe(true);
  });

  it.each([
    ["غیرشیء", null],
    ["قالبِ ناشناخته", { ...START, format: "gemini" }],
    ["بی‌قالب", { maxOutputTokens: 5, modelMaxOutputTokens: 5 }],
    ["سقفِ صفر", { ...START, maxOutputTokens: 0 }],
    ["سقفِ اعشاری", { ...START, maxOutputTokens: 1.5 }],
    ["پایه بیش از سقفِ مدل", { ...START, maxOutputTokens: 3000 }],
    ["سقفِ مدلِ منفی", { ...START, modelMaxOutputTokens: -1 }],
    ["کلیدِ اضافه", { ...START, extra: 1 }],
  ])("start: ورودیِ نامعتبر (%s) ⇒ INVALID_INPUT", (_n, input) => {
    expect(mustFail(mkLoop().start(input)).code).toBe("INVALID_INPUT");
  });
});

describe.each(FORMATS)("tool-loop · مسیرِ شادِ دوگامی (%s)", (format) => {
  const start = { ...START, format };
  it("ابزار ← نتیجه ← پاسخ؛ continuation و هزینه درست", () => {
    const loop = mkLoop();
    const c1 = call("c1");
    const t0 = must(loop.start(start));
    const t1 = must(loop.onStep(t0.state, stepOk({ format, calls: [c1], usage: usage(100, 20), cost: cost(50) })));
    expect(t1.action).toEqual({ kind: "run-tools", calls: [c1] });
    expect(t1.state.phase).toBe("awaiting-tools");

    const t2 = must(loop.onToolResults(t1.state, okResults([c1], { content: '{"fee":1}', reviewPending: true })));
    expect(t2.action.kind).toBe("call-model");
    if (t2.action.kind !== "call-model") return;
    expect(t2.action.step).toBe(2);
    expect(t2.action.continuation).toHaveLength(2);
    expect(t2.action.continuation[0]).toMatchObject({ role: "assistant" });
    expect(t2.action.continuation[1]).toMatchObject(format === "openai-chat" ? { role: "tool", tool_call_id: "c1", content: '{"fee":1}' } : { role: "user" });
    expect(Object.isFrozen(t2.action.continuation)).toBe(true);

    const t3 = must(loop.onStep(t2.state, stepOk({ format, text: "هزینه ۱ است.", usage: usage(200, 30), cost: cost(70) })));
    const o = outcomeOf(t3);
    expect(o).toMatchObject({ status: "answered", text: "هزینه ۱ است.", steps: 2, toolCalls: 1, reviewPending: true });
    expect(o.spend.cost).toEqual([{ currency: "IRR", priceVersion: "v1", micros: 120 }]);
    expect(o.spend.usage.totalTokens).toBe(350);
    expect(o.spend.complete).toBe(true);
    expect(kinds([t0.action, t1.action, t2.action, t3.action])).toEqual(["call-model", "run-tools", "call-model", "done"]);
  });
});

describe("tool-loop · پاسخِ مستقیم و reviewPending", () => {
  it("پاسخِ متنیِ گامِ اول ⇒ answered با reviewPending=false", () => {
    const r = drive(mkLoop(), START, () => stepOk({ text: "سلام" }));
    expect(r.outcome).toMatchObject({ status: "answered", text: "سلام", steps: 1, toolCalls: 0, reviewPending: false });
  });
  it("نتیجهٔ موفقِ تأییدنشده ⇒ reviewPending=true؛ تأییدشده ⇒ false؛ نتیجهٔ خطا بی‌اثر", () => {
    const run = (over: Parameters<typeof okResults>[1]) =>
      drive(mkLoop(), START, (_a, n) => (n === 0 ? stepOk({ calls: [call("c1")] }) : stepOk({ text: "تمام" })), (cs) => okResults(cs, over)).outcome;
    expect(run({ reviewPending: true }).reviewPending).toBe(true);
    expect(run({ reviewPending: false }).reviewPending).toBe(false);
    expect(run({ isError: true, reviewPending: true }).reviewPending).toBe(false);
  });
  it("یک نتیجهٔ تأییدنشده در میانِ چند نتیجه کافی است و تا پایان می‌ماند", () => {
    const calls = [call("a", { x: 1 }), call("b", { x: 2 })];
    const r = drive(
      mkLoop(),
      START,
      (_a, n) => (n === 0 ? stepOk({ calls }) : n === 1 ? stepOk({ calls: [call("c", { x: 3 })] }) : stepOk({ text: "تمام" })),
      (cs) => cs.map((c) => ({ id: c.id, content: "{}", reviewPending: c.id === "a" })),
    );
    expect(r.outcome).toMatchObject({ status: "answered", toolCalls: 3, steps: 3, reviewPending: true });
  });
  it("reviewPending در ایست هم گزارش می‌شود", () => {
    const r = drive(mkLoop({ maxSteps: 2 }), START, (_a, n) => stepOk({ calls: [call(`c${n}`, { n })] }), (cs) => okResults(cs, { reviewPending: true }));
    expect(r.outcome).toMatchObject({ status: "stopped", reason: "MAX_STEPS", reviewPending: true });
  });
});

describe("tool-loop · نتیجهٔ ابزارها (مرزِ ورودی)", () => {
  const waiting = () => {
    const loop = mkLoop();
    const cs = [call("a", { x: 1 }), call("b", { x: 2 })];
    const t = must(loop.onStep(must(loop.start(START)).state, stepOk({ calls: cs })));
    return { loop, t, cs };
  };
  it("reviewPending برای نتیجهٔ موفق الزامی است (نگفتن = رد) و حالت دست‌نخورده می‌ماند", () => {
    const { loop, t } = waiting();
    const e = mustFail(loop.onToolResults(t.state, [{ id: "a", content: "x" }, { id: "b", content: "y", reviewPending: false }]));
    expect(e.code).toBe("INVALID_RESULTS");
    expect(e.issues.join()).toContain("reviewPending");
    expect(t.state.phase).toBe("awaiting-tools");
    expect(loop.onToolResults(t.state, okResults([call("a"), call("b")])).ok).toBe(true);
  });
  it("نتیجهٔ خطا بی‌reviewPending مجاز است", () => {
    const { loop, t } = waiting();
    expect(loop.onToolResults(t.state, [{ id: "a", content: "x", isError: true }, { id: "b", content: "y", isError: true }]).ok).toBe(true);
  });
  it.each([
    ["غیرآرایه", () => ({})],
    ["نتیجهٔ کم", (cs: ReturnType<typeof call>[]) => okResults(cs.slice(0, 1))],
    ["نتیجهٔ اضافی", (cs: ReturnType<typeof call>[]) => okResults([...cs, call("zzz")])],
    ["نتیجهٔ تکراری", (cs: ReturnType<typeof call>[]) => okResults([...cs, cs[0]!])],
    ["محتوای تهی", (cs: ReturnType<typeof call>[]) => okResults(cs, { content: "" })],
    ["محتوای بیش از سقف", (cs: ReturnType<typeof call>[]) => okResults(cs, { content: "x".repeat(100_001) })],
    ["عضوِ غیرشیء", () => [1, 2]],
    ["کلیدِ ناشناخته", (cs: ReturnType<typeof call>[]) => okResults(cs).map((r) => ({ ...r, extra: 1 }))],
    ["isError غیربولی", (cs: ReturnType<typeof call>[]) => okResults(cs).map((r) => ({ ...r, isError: "yes" }))],
    ["reviewPending غیربولی", (cs: ReturnType<typeof call>[]) => okResults(cs).map((r) => ({ ...r, reviewPending: "no" }))],
    ["id غیررشته", (cs: ReturnType<typeof call>[]) => okResults(cs).map((r) => ({ ...r, id: 5 }))],
  ])("%s ⇒ INVALID_RESULTS (بی‌پرتاب، بی‌نشت)", (_n, make) => {
    const { loop, t, cs } = waiting();
    const e = mustFail(loop.onToolResults(t.state, make(cs)));
    expect(e.code).toBe("INVALID_RESULTS");
    expect(e.issues.length).toBeLessThanOrEqual(10);
  });
  it("محتوای نتیجه در پیامِ خطا بازتاب نمی‌شود", () => {
    const { loop, t, cs } = waiting();
    const e = mustFail(loop.onToolResults(t.state, [...okResults(cs, { content: CANARY }), { id: CANARY, content: CANARY, reviewPending: false }]));
    expect(JSON.stringify(e)).not.toContain(CANARY);
  });
});

describe("tool-loop · سقف‌ها", () => {
  it("MAX_STEPS با maxSteps=1: ابزار هرگز به مجری سپرده نمی‌شود", () => {
    const r = drive(mkLoop({ maxSteps: 1 }), START, () => stepOk({ calls: [call("c1")] }));
    expect(kinds(r.actions)).toEqual(["call-model", "done"]);
    expect(r.outcome).toMatchObject({ status: "stopped", reason: "MAX_STEPS", steps: 1, toolCalls: 0 });
    expect(r.outcome.spend.cost).toEqual([{ currency: "IRR", priceVersion: "v1", micros: 50 }]);
  });
  it("MAX_STEPS در گامِ آخر پس از یک دورِ ابزار", () => {
    const r = drive(mkLoop({ maxSteps: 2 }), START, (_a, n) => stepOk({ calls: [call(`c${n}`, { n })] }));
    expect(kinds(r.actions)).toEqual(["call-model", "run-tools", "call-model", "done"]);
    expect(r.outcome).toMatchObject({ reason: "MAX_STEPS", steps: 2, toolCalls: 1 });
  });
  it("حلقهٔ بی‌پایانِ مدل با آرگومان‌های متفاوت دقیقاً در maxSteps می‌ایستد", () => {
    for (const maxSteps of [1, 3, 7, 16]) {
      const r = drive(mkLoop({ maxSteps, maxToolCalls: 64 }), START, (_a, n) => stepOk({ calls: [call(`c${n}`, { n })] }));
      expect(r.outcome).toMatchObject({ status: "stopped", reason: "MAX_STEPS", steps: maxSteps });
    }
  });
  it("MAX_TOOL_CALLS: فراخوانیِ موازی از سقف بگذرد ⇒ هیچ‌کدام اجرا نمی‌شود", () => {
    const r = drive(mkLoop({ maxToolCalls: 2 }), START, () => stepOk({ calls: [call("a", { x: 1 }), call("b", { x: 2 }), call("c", { x: 3 })] }));
    expect(kinds(r.actions)).toEqual(["call-model", "done"]);
    expect(r.outcome).toMatchObject({ reason: "MAX_TOOL_CALLS", toolCalls: 0 });
  });
  it("MAX_TOOL_CALLS: سقفِ دقیق مجاز؛ یکی بیشتر ممنوع (تجمعی بر گام‌ها)", () => {
    const at = drive(mkLoop({ maxToolCalls: 2 }), START, (_a, n) => (n === 0 ? stepOk({ calls: [call("a", { x: 1 }), call("b", { x: 2 })] }) : stepOk({ text: "تمام" })));
    expect(at.outcome).toMatchObject({ status: "answered", toolCalls: 2 });
    const over = drive(mkLoop({ maxToolCalls: 2 }), START, (_a, n) => (n === 0 ? stepOk({ calls: [call("a", { x: 1 }), call("b", { x: 2 })] }) : stepOk({ calls: [call("c", { x: 3 })] })));
    expect(over.outcome).toMatchObject({ reason: "MAX_TOOL_CALLS", toolCalls: 2, steps: 2 });
  });
  it("REPEATED_CALL: آرگومانِ هم‌ارز (ترتیبِ کلید) شمرده می‌شود؛ سقفِ دقیق مجاز", () => {
    const argsFor = (n: number) => (n % 2 === 0 ? '{"a":1,"b":2}' : '{ "b": 2, "a": 1 }');
    const r = drive(mkLoop({ maxIdenticalCalls: 2 }), START, (_a, n) => stepOk({ calls: [call(`c${n}`, argsFor(n))] }));
    expect(r.outcome).toMatchObject({ status: "stopped", reason: "REPEATED_CALL", steps: 3, toolCalls: 2 });
  });
  it("REPEATED_CALL: آرگومانِ متفاوت یا ابزارِ متفاوت تکرار نیست", () => {
    const r = drive(mkLoop({ maxIdenticalCalls: 1 }), START, (_a, n) => (n < 3 ? stepOk({ calls: [call(`c${n}`, { a: 1 }, n % 2 === 0 ? "court_fee" : "late_payment")] }) : stepOk({ text: "تمام" })));
    expect(r.outcome.status === "answered" || (r.outcome.status === "stopped" && r.outcome.reason === "REPEATED_CALL")).toBe(true);
    // n=0 court_fee، n=1 late_payment، n=2 دوباره court_fee با همان آرگومان ⇒ تکرار
    expect(r.outcome).toMatchObject({ reason: "REPEATED_CALL" });
    const ok = drive(mkLoop({ maxIdenticalCalls: 1 }), START, (_a, n) => (n < 3 ? stepOk({ calls: [call(`c${n}`, { a: n })] }) : stepOk({ text: "تمام" })));
    expect(ok.outcome).toMatchObject({ status: "answered", toolCalls: 3 });
  });
  it("REPEATED_CALL در یک گامِ موازی (دو فراخوانیِ یکسان با شناسهٔ متفاوت) هم می‌گیرد", () => {
    const r = drive(mkLoop({ maxIdenticalCalls: 1 }), START, () => stepOk({ calls: [call("a", { x: 1 }), call("b", { x: 1 })] }));
    expect(r.outcome).toMatchObject({ reason: "REPEATED_CALL", toolCalls: 0 });
  });
  it("DUPLICATE_CALL_ID در یک گام و میانِ گام‌ها", () => {
    const within = drive(mkLoop(), START, () => stepOk({ calls: [call("a", { x: 1 }), call("a", { x: 2 })] }));
    expect(within.outcome).toMatchObject({ reason: "DUPLICATE_CALL_ID" });
    const across = drive(mkLoop(), START, (_a, n) => stepOk({ calls: [call("same", { n })] }));
    expect(across.outcome).toMatchObject({ reason: "DUPLICATE_CALL_ID", steps: 2, toolCalls: 1 });
  });
});

describe("tool-loop · فراخوانیِ بریده (TRUNCATED_TOOL_CALL)", () => {
  it("یک تلاش: سقفِ خروجی دوبرابر، continuation همان، پاسخِ بعدی پذیرفته؛ هزینهٔ بریده شمرده می‌شود", () => {
    const loop = mkLoop({ truncationRetries: 1 });
    const t0 = must(loop.start(START));
    const t1 = must(loop.onStep(t0.state, stepTruncated({ usage: usage(100, 500), cost: cost(300) })));
    expect(t1.action).toEqual({ kind: "call-model", step: 2, continuation: [], maxOutputTokens: 1000 });
    const t2 = must(loop.onStep(t1.state, stepOk({ text: "ok", cost: cost(40) })));
    const o = outcomeOf(t2);
    expect(o).toMatchObject({ status: "answered", steps: 2 });
    expect(o.spend.cost).toEqual([{ currency: "IRR", priceVersion: "v1", micros: 340 }]);
  });
  it("دو تلاش: ۵۰۰ ← ۱۰۰۰ ← ۲۰۰۰ (سقفِ مدل)؛ سومین بریدگی ⇒ ایست", () => {
    const seen: number[] = [];
    const r = drive(mkLoop({ truncationRetries: 2 }), START, (a) => {
      seen.push(a.maxOutputTokens);
      return stepTruncated();
    });
    expect(seen).toEqual([500, 1000, 2000]);
    expect(r.outcome).toMatchObject({ status: "stopped", reason: "TRUNCATED_TOOL_CALL", steps: 3 });
    expect(r.outcome.spend.cost).toEqual([{ currency: "IRR", priceVersion: "v1", micros: 150 }]);
  });
  it("truncationRetries=0 ⇒ بی‌تلاش ایست", () => {
    const r = drive(mkLoop({ truncationRetries: 0 }), START, () => stepTruncated());
    expect(r.outcome).toMatchObject({ reason: "TRUNCATED_TOOL_CALL", steps: 1 });
  });
  it("وقتی سقف بزرگ‌تر نمی‌شود (پایه = سقفِ مدل) تلاشِ بی‌فایده نمی‌شود", () => {
    const r = drive(mkLoop({ truncationRetries: 2 }), { ...START, maxOutputTokens: 2000 }, () => stepTruncated());
    expect(r.outcome).toMatchObject({ reason: "TRUNCATED_TOOL_CALL", steps: 1 });
  });
  it("رشدِ دوبرابر به سقفِ مدل چفت می‌شود (۷۰۰)", () => {
    const seen: number[] = [];
    drive(mkLoop({ truncationRetries: 2 }), { ...START, modelMaxOutputTokens: 700 }, (a) => {
      seen.push(a.maxOutputTokens);
      return stepTruncated();
    });
    expect(seen).toEqual([500, 700]);
  });
  it("تلاشِ دوباره هم سقفِ گام را رعایت می‌کند", () => {
    const r = drive(mkLoop({ maxSteps: 1, truncationRetries: 2 }), START, () => stepTruncated());
    expect(r.outcome).toMatchObject({ reason: "MAX_STEPS", steps: 1 });
  });
  it("پس از بازیابی، حلقهٔ ابزار ادامه دارد و سقفِ خروجی بالا می‌ماند", () => {
    const seen: number[] = [];
    const r = drive(mkLoop({ truncationRetries: 1 }), START, (a, n) => {
      seen.push(a.maxOutputTokens);
      return n === 0 ? stepTruncated() : n === 1 ? stepOk({ calls: [call("c1")] }) : stepOk({ text: "تمام" });
    });
    expect(seen).toEqual([500, 1000, 1000]);
    expect(r.outcome).toMatchObject({ status: "answered", steps: 3, toolCalls: 1 });
  });
  it("شناسهٔ فراخوانیِ پاسخِ بریده «دیده» حساب نمی‌شود (پاسخِ بریده هرگز به مدل برنمی‌گردد)", () => {
    const r = drive(mkLoop({ truncationRetries: 1 }), START, (_a, n) => (n === 0 ? stepTruncated() : n === 1 ? stepOk({ calls: [call("c1")] }) : stepOk({ text: "تمام" })));
    expect(r.outcome.status).toBe("answered");
  });
  it("PROVIDER_BAD_RESPONSE بی‌نشانهٔ بریدگی یا کدِ دیگر با همان نشانه، بریدگی نیست", () => {
    expect(drive(mkLoop(), START, () => stepErr("PROVIDER_BAD_RESPONSE", { issues: ["x"] })).outcome).toMatchObject({ reason: "STEP_FAILED", errorCode: "PROVIDER_BAD_RESPONSE" });
    expect(drive(mkLoop(), START, () => stepErr("PROVIDER_ERROR", { issues: ["TRUNCATED_TOOL_CALL"] })).outcome).toMatchObject({ reason: "STEP_FAILED", errorCode: "PROVIDER_ERROR" });
    expect(drive(mkLoop(), START, () => stepErr("PROVIDER_BAD_RESPONSE", { issues: ["x", "TRUNCATED_TOOL_CALL"] })).outcome).toMatchObject({ reason: "STEP_FAILED" });
  });
});

describe("tool-loop · شکستِ گام و پایانِ غیرعادی", () => {
  it.each(["PROVIDER_ERROR", "PROVIDER_TIMEOUT", "RATE_LIMITED", "ABORTED"])("%s ⇒ STEP_FAILED با کدِ همان و هزینهٔ گام", (code) => {
    const r = drive(mkLoop(), START, () => stepErr(code, { cost: cost(77) }));
    expect(r.outcome).toMatchObject({ status: "stopped", reason: "STEP_FAILED", errorCode: code, steps: 1 });
    expect(r.outcome.spend.cost).toEqual([{ currency: "IRR", priceVersion: "v1", micros: 77 }]);
  });
  it("خطای پیش از ارائه‌دهنده (بی‌مصرف) نامعلوم شمرده می‌شود، نه صفر", () => {
    const r = drive(mkLoop(), START, () => stepErr("INVALID_REQUEST", { usage: null, cost: null }));
    expect(r.outcome.spend).toMatchObject({ steps: 1, unknownUsageSteps: 1, unknownCostSteps: 1, complete: false });
  });
  it("کدِ خطای نامنتظر/آلوده به فهرستِ بسته تبدیل می‌شود (بی‌نشت)", () => {
    const r = drive(mkLoop(), START, () => stepErr(`bad code ${CANARY}`));
    expect(r.outcome).toMatchObject({ reason: "STEP_FAILED", errorCode: "UNKNOWN" });
    expect(JSON.stringify(r.outcome)).not.toContain(CANARY);
  });
  it.each([
    ["length", "OUTPUT_TRUNCATED"],
    ["content_filter", "MODEL_FILTERED"],
    ["other", "UNEXPECTED_FINISH"],
  ])("پایانِ %s بی‌ابزار ⇒ %s و هیچ متنی عبور نمی‌کند", (finish, reason) => {
    const r = drive(mkLoop(), START, () => stepOk({ finish, text: CANARY }));
    expect(r.outcome).toMatchObject({ status: "stopped", reason });
    expect(JSON.stringify(r.outcome)).not.toContain(CANARY);
    expect("text" in r.outcome).toBe(false);
  });
  it.each(["", "   ", "\n\t "])("پاسخِ تهی/فاصله (%j) ⇒ EMPTY_ANSWER", (text) => {
    expect(drive(mkLoop(), START, () => stepOk({ text })).outcome).toMatchObject({ reason: "EMPTY_ANSWER" });
  });
  it("متنِ همراهِ فراخوانیِ ابزار هرگز پاسخ نمی‌شود", () => {
    const r = drive(mkLoop({ maxSteps: 1 }), START, () => stepOk({ calls: [call("c1")], text: CANARY }));
    expect(JSON.stringify(r.outcome)).not.toContain(CANARY);
  });
});

describe("tool-loop · سقفِ هزینه", () => {
  const est = (i: { maxOutputTokens: number; continuationChars: number }) => i.maxOutputTokens + i.continuationChars;
  const budget = (maxMicros: number, estimateStepMicros: (i: never) => number = est as never) => ({ kind: "cap", currency: "IRR", maxMicros, estimateStepMicros });

  it("برآوردِ گامِ اول از سقف بگذرد ⇒ بی‌هیچ فراخوانیِ مدل می‌ایستد", () => {
    const r = drive(mkLoop({ budget: budget(501) }), START, () => stepOk());
    expect(kinds(r.actions)).toEqual(["done"]);
    expect(r.outcome).toMatchObject({ status: "stopped", reason: "BUDGET_EXCEEDED", steps: 0, toolCalls: 0 });
  });
  it("برآورد دقیقاً برابرِ سقف ⇒ مجاز", () => {
    // برآوردِ گامِ اول = ۵۰۰ توکن + ۲ نویسهٔ «[]» = ۵۰۲
    expect(drive(mkLoop({ budget: budget(502) }), START, () => stepOk({ cost: cost(1) })).outcome.status).toBe("answered");
  });
  it("پس از گامِ اول، هزینهٔ معلوم + برآورد از سقف بگذرد ⇒ ابزار اجرا نمی‌شود", () => {
    // گام ۱: هزینه ۴۰۰؛ برآوردِ گامِ بعد ۵۰۰ ⇒ ۹۰۰ ≤ ۱۰۰۰ مجاز؛ با سقفِ ۸۹۹ ممنوع.
    const run = (cap: number) => drive(mkLoop({ budget: budget(cap, (() => 500) as never) }), START, (_a, n) => (n === 0 ? stepOk({ calls: [call("c1")], cost: cost(400) }) : stepOk({ text: "تمام", cost: cost(1) })));
    expect(run(1000).outcome.status).toBe("answered");
    const r = run(899);
    expect(kinds(r.actions)).toEqual(["call-model", "done"]);
    expect(r.outcome).toMatchObject({ reason: "BUDGET_EXCEEDED", steps: 1, toolCalls: 0 });
    expect(r.outcome.spend.cost).toEqual([{ currency: "IRR", priceVersion: "v1", micros: 400 }]);
  });
  it("رشدِ continuation پس از نتیجهٔ ابزار دوباره سنجیده می‌شود (نتیجهٔ بزرگ ⇒ ایست)", () => {
    const seen: { step: number; maxOutputTokens: number; continuationChars: number }[] = [];
    const spy = (i: { step: number; maxOutputTokens: number; continuationChars: number }) => {
      seen.push(i);
      return i.maxOutputTokens + i.continuationChars;
    };
    const r = drive(mkLoop({ budget: budget(3000, spy as never) }), START, () => stepOk({ calls: [call("c1")], cost: cost(100) }), (cs) => okResults(cs, { content: "x".repeat(2500) }));
    expect(r.outcome).toMatchObject({ reason: "BUDGET_EXCEEDED", steps: 1, toolCalls: 1 });
    expect(kinds(r.actions)).toEqual(["call-model", "run-tools", "done"]);
    expect(seen.map((s) => s.step)).toEqual([1, 2, 2]);
    expect(seen[0]!.continuationChars).toBe(2); // JSON.stringify([]) = "[]"
    expect(seen[1]!.continuationChars).toBe(2);
    expect(seen[2]!.continuationChars).toBeGreaterThanOrEqual(2500);
    expect(seen.every((s) => s.maxOutputTokens === 500)).toBe(true);
  });
  it("تلاشِ دوبارهٔ بریدگی با سقفِ خروجیِ بزرگ‌تر از سقفِ هزینه بگذرد ⇒ ایست (برآورد با ۱۰۰۰ توکن)", () => {
    // گام ۱: ۴۰۰ هزینه؛ برآوردِ تلاش = ۱۰۰۰ ⇒ ۱۴۰۰ > ۱۲۰۰.
    const r = drive(mkLoop({ budget: budget(1200) }), START, () => stepTruncated({ cost: cost(400) }));
    expect(r.outcome).toMatchObject({ reason: "BUDGET_EXCEEDED", steps: 1 });
  });
  it("هزینهٔ نامعلومِ یک گام ⇒ SPEND_UNKNOWN (شکست‌بسته)", () => {
    const r = drive(mkLoop({ budget: budget(10_000) }), START, (_a, n) => (n === 0 ? stepOk({ calls: [call("c1")], cost: null }) : stepOk()));
    expect(r.outcome).toMatchObject({ reason: "SPEND_UNKNOWN", steps: 1, toolCalls: 0 });
  });
  it("ارزِ دیگر در هزینهٔ گام ⇒ SPEND_UNKNOWN", () => {
    const r = drive(mkLoop({ budget: budget(10_000) }), START, (_a, n) => (n === 0 ? stepOk({ calls: [call("c1")], cost: cost(5, "USD") }) : stepOk()));
    expect(r.outcome).toMatchObject({ reason: "SPEND_UNKNOWN" });
  });
  it("برآوردگرِ پرتابگر ⇒ SPEND_UNKNOWN از همان آغاز", () => {
    const r = drive(mkLoop({ budget: budget(10_000, () => { throw new Error("x"); }) }), START, () => stepOk());
    expect(r.outcome).toMatchObject({ reason: "SPEND_UNKNOWN", steps: 0 });
  });
  it("بدونِ سقف (none) هزینهٔ نامعلوم مانع نیست ولی در spend گزارش می‌شود", () => {
    const r = drive(mkLoop(), START, () => stepOk({ cost: null, usage: null }));
    expect(r.outcome).toMatchObject({ status: "answered" });
    expect(r.outcome.spend).toMatchObject({ unknownCostSteps: 1, complete: false });
  });
});

describe("tool-loop · سقفِ continuation", () => {
  it("نتیجه‌های بزرگ ⇒ CONTINUATION_LIMIT پیش از آن‌که دروازه INVALID_REQUEST بدهد", () => {
    const r = drive(mkLoop({ maxSteps: 10, maxToolCalls: 20 }), START, (_a, n) => stepOk({ calls: [call(`c${n}`, { n })] }), (cs) => okResults(cs, { content: "x".repeat(100_000) }));
    expect(r.outcome).toMatchObject({ status: "stopped", reason: "CONTINUATION_LIMIT" });
    expect(r.outcome.toolCalls).toBeGreaterThanOrEqual(4);
  });
});

describe("tool-loop · لغو", () => {
  it("لغو در انتظارِ گام و در انتظارِ ابزار ⇒ CANCELLED با هزینهٔ تاکنون", () => {
    const loop = mkLoop();
    const t0 = must(loop.start(START));
    expect(outcomeOf(must(loop.cancel(t0.state)))).toMatchObject({ reason: "CANCELLED", steps: 0 });
    const t1 = must(loop.onStep(t0.state, stepOk({ calls: [call("c1")], cost: cost(90) })));
    const o = outcomeOf(must(loop.cancel(t1.state)));
    expect(o).toMatchObject({ reason: "CANCELLED", steps: 1, toolCalls: 1 });
    expect(o.spend.cost).toEqual([{ currency: "IRR", priceVersion: "v1", micros: 90 }]);
  });
  it("لغوِ حلقهٔ بسته‌شده ⇒ INVALID_STATE", () => {
    const loop = mkLoop();
    const done = must(loop.onStep(must(loop.start(START)).state, stepOk()));
    expect(mustFail(loop.cancel(done.state)).code).toBe("INVALID_STATE");
  });
});

describe("tool-loop · انضباطِ حالت و رویداد", () => {
  it("رویدادِ ناهمگام با مرحله ⇒ INVALID_STATE", () => {
    const loop = mkLoop();
    const t0 = must(loop.start(START));
    expect(mustFail(loop.onToolResults(t0.state, [])).code).toBe("INVALID_STATE");
    const t1 = must(loop.onStep(t0.state, stepOk({ calls: [call("c1")] })));
    expect(mustFail(loop.onStep(t1.state, stepOk())).code).toBe("INVALID_STATE");
    const done = must(loop.onStep(t0.state, stepOk()));
    expect(mustFail(loop.onStep(done.state, stepOk())).code).toBe("INVALID_STATE");
    expect(mustFail(loop.onToolResults(done.state, [])).code).toBe("INVALID_STATE");
  });
  it.each([null, undefined, 5, "x", [], {}, { phase: "bogus" }, { phase: "awaiting-step" }, { phase: "awaiting-tools", pending: null }])("حالتِ جعلی (%j) بی‌پرتاب رد می‌شود", (state) => {
    const loop = mkLoop();
    for (const r of [loop.onStep(state as never, stepOk()), loop.onToolResults(state as never, []), loop.cancel(state as never)]) expect(r.ok).toBe(false);
  });
  it.each([
    ["null", null],
    ["بی‌ok", {}],
    ["ok غیربولی", { ok: "yes" }],
    ["value غیرشیء", { ok: true, value: 5 }],
    ["error غیرشیء", { ok: false, error: 5 }],
    ["finish ناشناخته", { ok: true, value: { ...(stepOk() as { value: object }).value, finish: "weird" } }],
    ["tool_calls بی‌فراخوانی", { ok: true, value: { ...(stepOk() as { value: object }).value, finish: "tool_calls" } }],
    ["فراخوانی با finish=stop", { ok: true, value: { ...(stepOk({ calls: [call("a")] }) as { value: object }).value, finish: "stop" } }],
    ["فراخوانیِ بدشکل", { ok: true, value: { ...(stepOk({ calls: [call("a")] }) as { value: object }).value, toolCalls: [{ id: 1 }] } }],
    ["text غیررشته", { ok: true, value: { ...(stepOk() as { value: object }).value, text: 5 } }],
    ["بی‌assistantMessage", { ok: true, value: { ...(stepOk() as { value: object }).value, assistantMessage: null } }],
  ])("نتیجهٔ بدشکل (%s) ⇒ INVALID_EVENT و حالت دست‌نخورده", (_n, ev) => {
    const loop = mkLoop();
    const t0 = must(loop.start(START));
    expect(mustFail(loop.onStep(t0.state, ev)).code).toBe("INVALID_EVENT");
    expect(t0.state.steps).toBe(0);
  });
  it("حالتِ جعلیِ کاملاً خوش‌شکل (کپی/سریال‌شده) پذیرفته نمی‌شود؛ فقط حالتِ ساخته‌شدهٔ همین ماژول", () => {
    const loop = mkLoop();
    const t0 = must(loop.start(START));
    const copy = { ...t0.state };
    const viaJson = JSON.parse(JSON.stringify(t0.state));
    for (const forged of [copy, viaJson]) {
      expect(mustFail(loop.onStep(forged, stepOk())).code).toBe("INVALID_STATE");
      expect(mustFail(loop.cancel(forged)).code).toBe("INVALID_STATE");
    }
    const t1 = must(loop.onStep(t0.state, stepOk({ calls: [call("c1")] })));
    expect(mustFail(loop.onToolResults({ ...t1.state }, okResults([call("c1")]))).code).toBe("INVALID_STATE");
    expect(loop.onStep(t0.state, stepOk()).ok).toBe(true);
  });
  it("getterِ پرتابگر در رویداد پرتاب نمی‌شود", () => {
    const loop = mkLoop();
    const t0 = must(loop.start(START));
    const evil = new Proxy({}, { get: () => { throw new Error("boom"); } });
    expect(mustFail(loop.onStep(t0.state, evil)).code).toBe("INVALID_EVENT");
    const evil2 = { ok: true, value: new Proxy({}, { get: () => { throw new Error("boom"); } }) };
    expect(mustFail(loop.onStep(t0.state, evil2)).code).toBe("INVALID_EVENT");
  });
  it("حالتِ ورودی هرگز تغییر نمی‌کند و بازپخشِ همان رویداد همان خروجی را می‌دهد (خالص)", () => {
    const loop = mkLoop();
    const t0 = must(loop.start(START));
    const before = JSON.stringify(t0.state);
    const ev = stepOk({ calls: [call("c1")] });
    const a = must(loop.onStep(t0.state, ev));
    const b = must(loop.onStep(t0.state, ev));
    expect(JSON.stringify(t0.state)).toBe(before);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.isFrozen(a.state)).toBe(true);
    expect(Object.isFrozen(a.state.entries)).toBe(true);
  });
  it("تغییرِ بعدیِ رویداد/نتیجه بر حالتِ ساخته‌شده اثری ندارد", () => {
    const loop = mkLoop();
    const t0 = must(loop.start(START));
    const u = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    const ev = stepOk({ calls: [call("c1")], usage: u }) as { value: { usage: { inputTokens: number } } };
    const t1 = must(loop.onStep(t0.state, ev));
    ev.value.usage.inputTokens = 999_999;
    const t2 = must(loop.onToolResults(t1.state, okResults([call("c1")])));
    const t3 = must(loop.onStep(t2.state, stepOk({ text: "تمام", usage: usage(1, 1) })));
    expect(outcomeOf(t3).spend.usage.inputTokens).toBe(1 + 1);
  });
  it("یک حلقه با چند نمونهٔ هم‌زمان (حالت‌های جدا) به هم نشت نمی‌کند", () => {
    const loop = mkLoop();
    const a = must(loop.start(START));
    const b = must(loop.start({ ...START, format: "anthropic-messages" }));
    const a1 = must(loop.onStep(a.state, stepOk({ calls: [call("x")] })));
    const b1 = must(loop.onStep(b.state, stepOk({ text: "ب" })));
    expect(a1.state.toolCalls).toBe(1);
    expect(a1.action.kind).toBe("run-tools");
    expect(outcomeOf(b1)).toMatchObject({ status: "answered", toolCalls: 0 });
  });
});
