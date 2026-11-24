import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { TRUNCATED_TOOL_CALL_ISSUE } from "@/modules/ai-gateway";
import type { ToolLoop } from "@/modules/tool-loop";
import { ABORT_GRACE_MS, createToolRunner } from "./runner";
import { FAILURE_CONTENT } from "./errors";
import { RUN_INPUT, call, cost, fakeTimers, makeLoop, makeRunner, okExec, scripted, stepErr, stepOk, stubGateway, tick, usage } from "./test-kit";
import type { RunReport, ToolExecutor, ToolRunner } from "./types";

async function report(r: ToolRunner, input: unknown = RUN_INPUT, options?: Parameters<ToolRunner["run"]>[1]): Promise<RunReport> {
  const res = await r.run(input, options);
  if (!res.ok) throw new Error(`انتظارِ موفقیت: ${JSON.stringify(res.error)}`);
  return res.value;
}
async function failure(r: ToolRunner, input: unknown = RUN_INPUT, options?: Parameters<ToolRunner["run"]>[1]) {
  const res = await r.run(input, options);
  if (res.ok) throw new Error("انتظارِ شکست");
  return res.error;
}
const C1 = call("call_1");

describe("createToolRunner", () => {
  it("پیکربندیِ نامعتبر ⇒ INVALID_CONFIG (بی‌پرتاب)", () => {
    const { gateway } = stubGateway(scripted([]));
    const r = createToolRunner({ gateway, loop: makeLoop(), executeTool: okExec(), totalTimeoutMs: 5, toolTimeoutMs: 1000, maxResultChars: 1000 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe("INVALID_CONFIG");
    expect(Object.isFrozen(makeRunner({ gateway }))).toBe(true);
  });
});

describe("run · مسیرِ عادی", () => {
  it("پاسخِ بی‌ابزار: پورتِ ابزار صدا زده نمی‌شود", async () => {
    let hit = 0;
    const { gateway, inputs } = stubGateway(scripted([stepOk({ text: "سلام" })]));
    const out = await report(makeRunner({ gateway, executeTool: () => (hit++, { ok: true, content: "x", reviewPending: false }) }));
    expect(out.outcome).toMatchObject({ status: "answered", text: "سلام", steps: 1, toolCalls: 0, reviewPending: false });
    expect(out.abortedBy).toBeNull();
    expect(out.toolRuns).toEqual([]);
    expect(hit).toBe(0);
    expect(inputs).toHaveLength(1);
  });

  it("دو گام: ابزار اجرا، نتیجه در continuation گامِ بعد، reviewPending و هزینه جمع می‌شود", async () => {
    const { gateway, inputs } = stubGateway(scripted([stepOk({ calls: [C1] }), stepOk({ text: "تمام", usage: usage(10, 5), cost: cost(7) })]));
    const seen: string[] = [];
    const exec: ToolExecutor = (c) => (seen.push(c.name, c.argumentsJson), { ok: true, content: '{"fee":1}', reviewPending: true });
    const out = await report(makeRunner({ gateway, executeTool: exec }));
    expect(out.outcome).toMatchObject({ status: "answered", text: "تمام", steps: 2, toolCalls: 1, reviewPending: true });
    expect(out.outcome.spend.cost).toEqual([{ currency: "IRR", priceVersion: "v1", micros: 57 }]);
    expect(out.outcome.spend.complete).toBe(true);
    expect(seen).toEqual(["court_fee", '{"a":1}']);
    expect(out.toolRuns).toEqual([{ id: "call_1", name: "court_fee", status: "ok", code: null, reviewPending: true }]);
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!["continuation"]).toEqual([]);
    const cont = inputs[1]!["continuation"] as Array<Record<string, unknown>>;
    expect(cont.map((m) => m["role"])).toEqual(["assistant", "tool"]);
    expect(cont[1]).toMatchObject({ tool_call_id: "call_1", content: '{"fee":1}' });
  });

  it("کلیدهای درخواستِ پایه (دما، requestId، toolChoice، …) بی‌تغییر به دروازه می‌رسند؛ سقفِ خروجی از حلقه", async () => {
    const { gateway, inputs } = stubGateway(scripted([stepOk({ text: "x" })]));
    const input = { ...RUN_INPUT, temperature: 0.2, requestId: "req-1", toolChoice: "auto", allowParallel: true, stopSequences: ["END"], timeoutMs: 5000 };
    await report(makeRunner({ gateway }), input);
    expect(inputs[0]).toMatchObject({ ...input, maxOutputTokens: 500, continuation: [] });
  });

  it("به هر گام signalِ مجری داده می‌شود (نه signalِ فراخواننده)", async () => {
    const { gateway, signals } = stubGateway(scripted([stepOk({ calls: [C1] }), stepOk()]));
    const caller = new AbortController();
    await report(makeRunner({ gateway }), RUN_INPUT, { signal: caller.signal });
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]).not.toBe(caller.signal);
    expect(signals[0]).toBe(signals[1]);
  });

  it("چند فراخوانیِ یک گام: به ترتیب و ترتیبی؛ نتیجه‌ها به ترتیبِ مدل برمی‌گردند", async () => {
    const calls = [call("c1", { a: 1 }), call("c2", { a: 2 }, "late_payment"), call("c3", { a: 3 })];
    const { gateway, inputs } = stubGateway(scripted([stepOk({ calls }), stepOk()]));
    let running = 0;
    let max = 0;
    const order: string[] = [];
    const exec: ToolExecutor = async (c) => {
      running++;
      max = Math.max(max, running);
      await tick(2);
      order.push(c.id);
      running--;
      return { ok: true, content: c.id, reviewPending: false };
    };
    const out = await report(makeRunner({ gateway, executeTool: exec }));
    expect(max).toBe(1);
    expect(order).toEqual(["c1", "c2", "c3"]);
    expect(out.outcome).toMatchObject({ toolCalls: 3 });
    const cont = inputs[1]!["continuation"] as Array<Record<string, unknown>>;
    expect(cont.slice(1).map((m) => m["tool_call_id"])).toEqual(["c1", "c2", "c3"]);
  });

  it("پورتِ همگام و ناهمگام هر دو پذیرفته‌اند", async () => {
    for (const exec of [okExec(), (async () => ({ ok: true, content: "x", reviewPending: false })) as ToolExecutor]) {
      const { gateway } = stubGateway(scripted([stepOk({ calls: [C1] }), stepOk()]));
      expect((await report(makeRunner({ gateway, executeTool: exec }))).outcome.status).toBe("answered");
    }
  });
});

describe("run · ابزارِ ناهنجار به مدل برمی‌گردد و حلقه نمی‌شکند", () => {
  const cases: ReadonlyArray<readonly [string, ToolExecutor, string]> = [
    ["پرتاب", () => { throw new Error("راز-پرونده"); }, "TOOL_FAILED"],
    ["رد ناهمگام", () => Promise.reject(new Error("راز-پرونده")), "TOOL_FAILED"],
    ["شکلِ نادرست", (() => 42) as never, "TOOL_RESULT_INVALID"],
    ["بی‌reviewPending", (() => ({ ok: true, content: "x" })) as never, "TOOL_RESULT_INVALID"],
    ["تهی", () => ({ ok: true, content: "", reviewPending: false }), "TOOL_RESULT_INVALID"],
    ["بزرگ", () => ({ ok: true, content: "x".repeat(4001), reviewPending: true }), "TOOL_RESULT_TOO_LARGE"],
  ];
  it.each(cases)("%s ⇒ %s و گامِ بعد اجرا می‌شود", async (_n, exec, code) => {
    const { gateway, inputs } = stubGateway(scripted([stepOk({ calls: [C1] }), stepOk({ text: "جمع‌بندی" })]));
    const out = await report(makeRunner({ gateway, executeTool: exec }));
    expect(out.outcome).toMatchObject({ status: "answered", text: "جمع‌بندی", reviewPending: false });
    expect(out.toolRuns[0]).toMatchObject({ status: "error", code, reviewPending: false });
    const wire = JSON.stringify(inputs[1]!["continuation"]);
    expect(wire).toContain(JSON.stringify(FAILURE_CONTENT[code as keyof typeof FAILURE_CONTENT]).slice(1, -1));
    expect(wire).not.toContain("راز-پرونده");
    expect(JSON.stringify(out)).not.toContain("راز-پرونده");
  });

  it("خطای گزارش‌شدهٔ ابزار (ok:false): متنِ خودِ ابزار به مدل می‌رسد", async () => {
    const { gateway, inputs } = stubGateway(scripted([stepOk({ calls: [C1] }), stepOk()]));
    const out = await report(makeRunner({ gateway, executeTool: () => ({ ok: false, content: '{"error":"ورودیِ نادرست"}' }) }));
    expect(out.toolRuns[0]).toMatchObject({ code: "TOOL_REPORTED_ERROR", status: "error" });
    expect(JSON.stringify(inputs[1]!["continuation"])).toContain("ورودیِ نادرست");
  });

  it("ابزارِ بیرون از فهرست (در پاسخ مدل): هرگز اجرا نمی‌شود", async () => {
    let hit = 0;
    const { gateway } = stubGateway(scripted([stepOk({ calls: [call("c1", {}, "delete_case")] }), stepOk()]));
    const out = await report(makeRunner({ gateway, executeTool: () => (hit++, { ok: true, content: "x", reviewPending: false }) }));
    expect(hit).toBe(0);
    expect(out.toolRuns[0]).toMatchObject({ name: "delete_case", code: "UNKNOWN_TOOL" });
    expect(out.outcome.status).toBe("answered");
  });

  it("مهلتِ ابزار (تایمرِ تزریقی): TOOL_TIMEOUT؛ حلقه ادامه می‌دهد؛ signalِ ابزار لغو شده", async () => {
    const f = fakeTimers();
    const { gateway } = stubGateway(scripted([stepOk({ calls: [C1] }), stepOk({ text: "ادامه" })]));
    let sig: AbortSignal | undefined;
    const r = makeRunner({ gateway, timers: f.timers, toolTimeoutMs: 321, executeTool: (_c, x) => ((sig = x.signal), new Promise(() => {})) });
    const p = report(r);
    await tick(20);
    expect(f.fire(321)).toBe(1);
    const out = await p;
    expect(out.outcome).toMatchObject({ status: "answered", text: "ادامه" });
    expect(out.toolRuns[0]).toMatchObject({ code: "TOOL_TIMEOUT" });
    expect(sig!.aborted).toBe(true);
    expect(f.pending()).toBe(0);
  });
});

describe("run · ایست‌های کنترل‌گر عبور می‌کنند", () => {
  it("MAX_STEPS: مدلِ همیشه-ابزار؛ ابزارِ گامِ آخر اجرا نمی‌شود؛ هزینهٔ خرج‌شده گزارش می‌شود", async () => {
    let n = 0;
    const { gateway } = stubGateway(() => stepOk({ calls: [call(`c${++n}`, { n })] }));
    let ran = 0;
    const out = await report(makeRunner({ gateway, loop: makeLoop({ maxSteps: 3 }), executeTool: () => (ran++, { ok: true, content: "x", reviewPending: false }) }));
    expect(out.outcome).toMatchObject({ status: "stopped", reason: "MAX_STEPS", steps: 3 });
    expect(ran).toBe(2);
    expect(out.outcome.spend.cost).toEqual([{ currency: "IRR", priceVersion: "v1", micros: 150 }]);
  });

  it("REPEATED_CALL، STEP_FAILED(با کد)، بودجهٔ همان آغاز", async () => {
    const same = stubGateway(() => stepOk({ calls: [call(`c${Math.random()}`, { x: 1 })] }));
    expect((await report(makeRunner({ gateway: same.gateway, loop: makeLoop({ maxIdenticalCalls: 1 }) }))).outcome).toMatchObject({ reason: "REPEATED_CALL" });
    const failing = stubGateway(scripted([stepErr("PROVIDER_UNAVAILABLE")]));
    expect((await report(makeRunner({ gateway: failing.gateway }))).outcome).toMatchObject({ reason: "STEP_FAILED", errorCode: "PROVIDER_UNAVAILABLE" });
    const cap = stubGateway(scripted([]));
    const loop = makeLoop({ budget: { kind: "cap", currency: "IRR", maxMicros: 10, estimateStepMicros: () => 11 } });
    const out = await report(makeRunner({ gateway: cap.gateway, loop }));
    expect(out.outcome).toMatchObject({ status: "stopped", reason: "BUDGET_EXCEEDED", steps: 0 });
    expect(cap.inputs).toHaveLength(0);
  });

  it("فراخوانیِ بریده: تلاشِ دوباره با سقفِ خروجیِ دوبرابر از راهِ مجری؛ هزینهٔ پاسخِ بریده شمرده می‌شود", async () => {
    const trunc = stepErr("PROVIDER_BAD_RESPONSE", { usage: usage(10, 10), cost: cost(5) });
    (trunc as { error: { issues: string[] } }).error.issues = [TRUNCATED_TOOL_CALL_ISSUE, "x"];
    const { gateway, inputs } = stubGateway(scripted([trunc, stepOk({ text: "ok", cost: cost(1) })]));
    const out = await report(makeRunner({ gateway }));
    expect(out.outcome).toMatchObject({ status: "answered", steps: 2 });
    expect(inputs.map((i) => i["maxOutputTokens"])).toEqual([500, 1000]);
    expect(out.outcome.spend.cost).toEqual([{ currency: "IRR", priceVersion: "v1", micros: 6 }]);
  });
});

describe("run · ورودی و مدل", () => {
  const bad: ReadonlyArray<readonly [string, unknown]> = [
    ["null", null],
    ["آرایه", []],
    ["continuation", { ...RUN_INPUT, continuation: [] }],
    ["بی‌model", { ...RUN_INPUT, model: undefined }],
    ["model تهی", { ...RUN_INPUT, model: "" }],
    ["maxOutputTokens صفر", { ...RUN_INPUT, maxOutputTokens: 0 }],
    ["maxOutputTokens اعشاری", { ...RUN_INPUT, maxOutputTokens: 1.5 }],
    ["maxOutputTokens رشته", { ...RUN_INPUT, maxOutputTokens: "5" }],
    ["tools تهی", { ...RUN_INPUT, tools: [] }],
    ["tools غیرآرایه", { ...RUN_INPUT, tools: {} }],
    ["ابزارِ بی‌نام", { ...RUN_INPUT, tools: [{ description: "d" }] }],
  ];
  it.each(bad)("ورودیِ نامعتبر (%s) ⇒ INVALID_INPUT بی‌هیچ تماس", async (_n, input) => {
    const { gateway, inputs } = stubGateway(scripted([]));
    const e = await failure(makeRunner({ gateway }), input);
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.partial).toBeNull();
    expect(inputs).toHaveLength(0);
  });

  it("options نامعتبر و signal نامعتبر", async () => {
    const { gateway } = stubGateway(scripted([]));
    const r = makeRunner({ gateway });
    expect((await failure(r, RUN_INPUT, 5 as never)).code).toBe("INVALID_INPUT");
    expect((await failure(r, RUN_INPUT, { signal: {} as never })).code).toBe("INVALID_INPUT");
  });

  it("مدلِ بی‌ابزار یا ناشناخته ⇒ MODEL_UNSUPPORTED", async () => {
    expect((await failure(makeRunner({ gateway: stubGateway(scripted([]), { format: null }).gateway }))).code).toBe("MODEL_UNSUPPORTED");
    expect((await failure(makeRunner({ gateway: stubGateway(scripted([]), { limits: null }).gateway }))).code).toBe("MODEL_UNSUPPORTED");
  });

  it("maxOutputTokens بیش از سقفِ مدل ⇒ INVALID_INPUT (از کنترل‌گر)", async () => {
    const { gateway, inputs } = stubGateway(scripted([]));
    const e = await failure(makeRunner({ gateway }), { ...RUN_INPUT, maxOutputTokens: 2001 });
    expect(e.code).toBe("INVALID_INPUT");
    expect(inputs).toHaveLength(0);
  });

  it("خطا پیامِ ثابت دارد و ورودی را بازتاب نمی‌دهد", async () => {
    const { gateway } = stubGateway(scripted([]));
    const e = await failure(makeRunner({ gateway }), { ...RUN_INPUT, model: "", messages: [{ role: "user", content: "راز-کاربر" }], extra: "راز-کاربر" });
    expect(JSON.stringify(e)).not.toContain("راز-کاربر");
    expect(e.message).toMatch(/[\u0600-\u06FF]/);
  });
});

describe("run · لغو و مهلتِ کل", () => {
  it("فرجهٔ لغو مثبت و کوتاه است (نه صفر که نتیجهٔ معلوم را دور بریزد، نه بلند که اجرا را نگه دارد)", () => {
    expect(ABORT_GRACE_MS).toBeGreaterThanOrEqual(500);
    expect(ABORT_GRACE_MS).toBeLessThanOrEqual(10_000);
  });

  it("signalِ از پیش لغوشده: هیچ تماسی؛ CANCELLED با هزینهٔ صفرِ کامل؛ abortedBy=caller", async () => {
    const { gateway, inputs } = stubGateway(scripted([]));
    const ac = new AbortController();
    ac.abort();
    const out = await report(makeRunner({ gateway }), RUN_INPUT, { signal: ac.signal });
    expect(out.outcome).toMatchObject({ status: "stopped", reason: "CANCELLED", steps: 0 });
    expect(out.outcome.spend.complete).toBe(true);
    expect(out.abortedBy).toBe("caller");
    expect(inputs).toHaveLength(0);
  });

  it("لغو حینِ اجرای ابزار: ابزار رها می‌شود (حتی بدون رعایتِ signal)، CANCELLED، هزینهٔ گامِ ۱ می‌ماند", async () => {
    const f = fakeTimers();
    const { gateway, inputs } = stubGateway(scripted([stepOk({ calls: [C1] }), stepOk()]));
    const ac = new AbortController();
    let sig: AbortSignal | undefined;
    const r = makeRunner({ gateway, timers: f.timers, executeTool: (_c, x) => ((sig = x.signal), new Promise(() => {})) });
    const p = report(r, RUN_INPUT, { signal: ac.signal });
    await tick(20);
    ac.abort();
    const out = await p;
    expect(out.outcome).toMatchObject({ status: "stopped", reason: "CANCELLED", steps: 1, toolCalls: 1 });
    expect(out.outcome.spend.cost).toEqual([{ currency: "IRR", priceVersion: "v1", micros: 50 }]);
    expect(out.abortedBy).toBe("caller");
    expect(out.toolRuns).toEqual([{ id: "call_1", name: "court_fee", status: "error", code: "TOOL_ABORTED", reviewPending: false }]);
    expect(sig!.aborted).toBe(true);
    expect(inputs).toHaveLength(1);
    expect(f.pending()).toBe(0);
  });

  it("مهلتِ کل حینِ ابزارِ بی‌پایان ⇒ بسته می‌شود (abortedBy=deadline)", async () => {
    const f = fakeTimers();
    const { gateway } = stubGateway(scripted([stepOk({ calls: [C1] })]));
    const r = makeRunner({ gateway, timers: f.timers, totalTimeoutMs: 7777, toolTimeoutMs: 60_000, executeTool: () => new Promise(() => {}) });
    const p = report(r);
    await tick(20);
    expect(f.fire(7777)).toBe(1);
    const out = await p;
    expect(out).toMatchObject({ abortedBy: "deadline" });
    expect(out.outcome).toMatchObject({ status: "stopped", reason: "CANCELLED" });
    expect(f.pending()).toBe(0);
  });

  it("لغو حینِ گامِ در-پرواز که دروازه به آن احترام می‌گذارد: STEP_FAILED(ABORTED)؛ هزینهٔ گام «نامعلوم» است نه صفر", async () => {
    const f = fakeTimers();
    const { gateway } = stubGateway((_i, signal) => new Promise((res) => signal!.addEventListener("abort", () => res(stepErr("ABORTED")), { once: true })));
    const ac = new AbortController();
    const p = report(makeRunner({ gateway, timers: f.timers }), RUN_INPUT, { signal: ac.signal });
    await tick();
    ac.abort();
    const out = await p;
    expect(out.outcome).toMatchObject({ status: "stopped", reason: "STEP_FAILED", errorCode: "ABORTED", steps: 1 });
    expect(out.outcome.spend.complete).toBe(false);
    expect(out.outcome.spend.unknownCostSteps).toBe(1);
    expect(out.abortedBy).toBe("caller");
    expect(f.pending()).toBe(0);
  });

  it("دروازه‌ای که لغو را نادیده می‌گیرد: پس از مهلتِ فرجه رها می‌شود (هزینهٔ نامعلوم)؛ نتیجهٔ دیرهنگام بی‌اثر", async () => {
    const f = fakeTimers();
    let late: (v: unknown) => void = () => {};
    const { gateway } = stubGateway(() => new Promise((res) => (late = res)));
    const ac = new AbortController();
    const p = report(makeRunner({ gateway, timers: f.timers, totalTimeoutMs: 9999 }), RUN_INPUT, { signal: ac.signal });
    await tick();
    ac.abort();
    await tick();
    expect(f.pendingMs()).toContain(ABORT_GRACE_MS);
    f.fire(ABORT_GRACE_MS);
    const out = await p;
    expect(out.outcome).toMatchObject({ status: "stopped", reason: "STEP_FAILED", errorCode: "ABORTED" });
    expect(out.outcome.spend.complete).toBe(false);
    late(stepOk({ text: "دیر" }));
    await tick();
    expect(f.pending()).toBe(0);
  });

  it("نتیجه‌ای که در فرجه می‌رسد (با مصرفِ معلوم) شمرده می‌شود", async () => {
    const f = fakeTimers();
    let late: (v: unknown) => void = () => {};
    const { gateway } = stubGateway(() => new Promise((res) => (late = res)));
    const ac = new AbortController();
    const p = report(makeRunner({ gateway, timers: f.timers }), RUN_INPUT, { signal: ac.signal });
    await tick();
    ac.abort();
    await tick();
    late(stepOk({ calls: [C1], cost: cost(321), usage: usage(3, 4) }));
    const out = await p;
    expect(out.outcome).toMatchObject({ status: "stopped", reason: "CANCELLED", steps: 1 });
    expect(out.outcome.spend.cost).toEqual([{ currency: "IRR", priceVersion: "v1", micros: 321 }]);
    expect(out.outcome.spend.complete).toBe(true);
    expect(out.toolRuns).toEqual([]);
  });

  it("گامِ موفق که هم‌زمان با لغو برگشت: ابزارها اجرا نمی‌شوند، هزینه حفظ می‌شود", async () => {
    const f = fakeTimers();
    const ac = new AbortController();
    let hit = 0;
    const { gateway } = stubGateway(() => {
      ac.abort();
      return stepOk({ calls: [C1], cost: cost(9) });
    });
    const out = await report(makeRunner({ gateway, timers: f.timers, executeTool: () => (hit++, { ok: true, content: "x", reviewPending: false }) }), RUN_INPUT, { signal: ac.signal });
    expect(hit).toBe(0);
    expect(out.outcome).toMatchObject({ status: "stopped", reason: "CANCELLED", steps: 1 });
    expect(out.outcome.spend.cost).toEqual([{ currency: "IRR", priceVersion: "v1", micros: 9 }]);
  });

  it("تایمرِ مهلتِ کل با اتمامِ عادی پاک می‌شود و شنوندهٔ signalِ فراخواننده برداشته می‌شود", async () => {
    const f = fakeTimers();
    const ac = new AbortController();
    const { gateway } = stubGateway(scripted([stepOk({ calls: [C1] }), stepOk()]));
    await report(makeRunner({ gateway, timers: f.timers }), RUN_INPUT, { signal: ac.signal });
    expect(f.pending()).toBe(0);
    expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
  });

  it("مهلتِ کل با تایمرِ واقعی و دروازهٔ معلق: در ۱ ثانیه بسته می‌شود", async () => {
    const { gateway } = stubGateway((_i, signal) => new Promise((res) => signal!.addEventListener("abort", () => res(stepErr("ABORTED")), { once: true })));
    const t0 = Date.now();
    const out = await report(makeRunner({ gateway, totalTimeoutMs: 1000 }));
    expect(out.abortedBy).toBe("deadline");
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe("run · خطاهای قرارداد و استحکام", () => {
  it("دروازه‌ای که پرتاب می‌کند: INTERNAL_ERROR به‌صورتِ شکستِ گام (هزینهٔ نامعلوم)", async () => {
    const { gateway } = stubGateway(() => { throw new Error("راز"); });
    const out = await report(makeRunner({ gateway }));
    expect(out.outcome).toMatchObject({ status: "stopped", reason: "STEP_FAILED", errorCode: "INTERNAL_ERROR" });
    expect(out.outcome.spend.complete).toBe(false);
    expect(JSON.stringify(out)).not.toContain("راز");
  });

  it("onToolResults ردشود ⇒ CONTRACT_VIOLATION و هزینهٔ تاکنون در partial", async () => {
    const real = makeLoop();
    const loop: ToolLoop = { ...real, onToolResults: () => ({ ok: false, error: { code: "INVALID_RESULTS", message: "m", issues: ["x"] } }) };
    const { gateway } = stubGateway(scripted([stepOk({ calls: [C1], cost: cost(77) })]));
    const e = await failure(makeRunner({ gateway, loop }));
    expect(e.code).toBe("CONTRACT_VIOLATION");
    expect(e.partial).toMatchObject({ status: "stopped", reason: "CANCELLED", steps: 1 });
    expect(e.partial!.spend.cost).toEqual([{ currency: "IRR", priceVersion: "v1", micros: 77 }]);
  });

  it("onStep ردشود ⇒ CONTRACT_VIOLATION؛ ساختارِ ناقصِ دروازه ⇒ INVALID_EVENT از کنترل‌گر", async () => {
    const { gateway } = stubGateway(() => ({ ok: "maybe" }));
    const e = await failure(makeRunner({ gateway }));
    expect(e.code).toBe("CONTRACT_VIOLATION");
    expect(e.issues.length).toBeGreaterThan(0);
    expect(e.partial).toMatchObject({ reason: "CANCELLED", steps: 0 });
  });

  it("start با خطای غیر INVALID_INPUT ⇒ CONTRACT_VIOLATION", async () => {
    const real = makeLoop();
    const loop: ToolLoop = { ...real, start: () => ({ ok: false, error: { code: "INVALID_CONFIG", message: "m", issues: [] } }) };
    const { gateway } = stubGateway(scripted([]));
    expect((await failure(makeRunner({ gateway, loop }))).code).toBe("CONTRACT_VIOLATION");
  });

  it("کنترل‌گری که هرگز نمی‌ایستد: نگهبانِ کنش‌ها ⇒ INTERNAL_ERROR (نه حلقهٔ بی‌پایان)", async () => {
    const real = makeLoop();
    const first = real.start({ format: "openai-chat", maxOutputTokens: 5, modelMaxOutputTokens: 10 });
    if (!first.ok) throw new Error("x");
    let steps = 0;
    const loop: ToolLoop = { ...real, start: () => first, onStep: () => (steps++, first) };
    const { gateway } = stubGateway(scripted([]));
    const e = await failure(makeRunner({ gateway, loop }));
    expect(e.code).toBe("INTERNAL_ERROR");
    expect(steps).toBeLessThanOrEqual(201);
  });

  it("هر استثنای ناگهانی (toolFormat پرتاب کند) ⇒ INTERNAL_ERROR، نه پرتاب", async () => {
    const { gateway } = stubGateway(scripted([]));
    const bomb = { ...gateway, toolFormat: () => { throw new Error("بوم"); } };
    const e = await failure(makeRunner({ gateway: bomb }));
    expect(e.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(e)).not.toContain("بوم");
  });

  it("اجرای هم‌زمانِ چند run روی یک مجری مستقل‌اند", async () => {
    let n = 0;
    const { gateway } = stubGateway(async (input) => {
      await tick(((n++ % 3) + 1) * 2);
      const cont = input["continuation"] as unknown[];
      return cont.length === 0 ? stepOk({ calls: [call(`id_${n}`, { n })] }) : stepOk({ text: `پاسخ ${cont.length}` });
    });
    const r = makeRunner({ gateway });
    const all = await Promise.all(Array.from({ length: 12 }, () => report(r)));
    for (const o of all) expect(o.outcome).toMatchObject({ status: "answered", steps: 2, toolCalls: 1 });
  });
});
