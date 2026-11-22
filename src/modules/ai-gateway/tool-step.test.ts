import { describe, expect, it } from "vitest";
import { createToolGateway, ProviderFailure, TOOL_STEP_LIMITS, TRUNCATED_TOOL_CALL_ISSUE, encodeTools, encodeToolResults } from "./index";
import type { ToolModelProvider, ToolProviderCall, ToolStepResult, UsageEvent } from "./index";
import { ManualTimers, PRICE, manualClock } from "./test-kit";

/** آزمون‌های گامِ ابزار (ADR-0055). پاسخ‌های مدل شبیه‌سازی‌اند و قیمت‌ها ساختگیِ آزمون. */

const SPEC = { name: "court_fee", description: "هزینهٔ دادرسی را محاسبه می‌کند.", parameters: { type: "object", properties: { amountRials: { type: "integer" } }, required: ["amountRials"] } };
const SECRET = "SECRET-CONTENT-۱۲۳";

type Step = Readonly<{ reply: unknown }> | Readonly<{ fail: unknown }> | Readonly<{ hang: true }> | Readonly<{ run: (c: ToolProviderCall) => unknown }>;
type Scripted = ToolModelProvider & { calls: ToolProviderCall[] };

function scripted(steps: readonly Step[]): Scripted {
  const calls: ToolProviderCall[] = [];
  let i = 0;
  return {
    calls,
    completeWithTools(call: ToolProviderCall) {
      calls.push(call);
      const s = steps[i++];
      if (s === undefined) return Promise.reject(new Error("script exhausted"));
      if ("fail" in s) return Promise.reject(s.fail);
      if ("hang" in s) return new Promise((_, rej) => call.signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true }));
      if ("run" in s) return Promise.resolve().then(() => s.run(call));
      return Promise.resolve(s.reply);
    },
  };
}

const oai = (message: Record<string, unknown>, finish: string, extra: Record<string, unknown> = {}) => ({
  model: "served-1",
  choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", ...message } }],
  usage: { prompt_tokens: 1000, completion_tokens: 500 },
  ...extra,
});
const oaiCall = (id = "call_1", name = "court_fee", args = '{"amountRials":100}') => ({ id, type: "function", function: { name, arguments: args } });
const OAI_TOOL = oai({ content: null, tool_calls: [oaiCall()] }, "tool_calls");
const OAI_TEXT = oai({ content: "پاسخ نهایی" }, "stop");
const ANT_TOOL = {
  type: "message",
  role: "assistant",
  model: "served-a",
  stop_reason: "tool_use",
  content: [{ type: "tool_use", id: "toolu_1", name: "court_fee", input: { amountRials: 100 } }],
  usage: { input_tokens: 1000, output_tokens: 500 },
};
const ANT_TEXT = { type: "message", role: "assistant", model: "served-a", stop_reason: "end_turn", content: [{ type: "text", text: "پاسخ نهایی" }], usage: { input_tokens: 1000, output_tokens: 500 } };

const BASE = { model: "m1", messages: [{ role: "user", content: "سلام" }], maxOutputTokens: 100, tools: [SPEC] };

type Rig = Readonly<{ gw: ReturnType<typeof must>; provider: Scripted; timers: ManualTimers; events: UsageEvent[] }>;
function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`rig rejected: ${JSON.stringify(r.error)}`);
  return r.value;
}
function rig(steps: readonly Step[] = [{ reply: OAI_TOOL }], format: "openai-chat" | "anthropic-messages" = "openai-chat", over: Record<string, unknown> = {}, modelOver: Record<string, unknown> = {}) {
  const provider = scripted(steps);
  const timers = new ManualTimers();
  const events: UsageEvent[] = [];
  const spec = { provider: "p1", providerModel: "provider-model-1", maxInputChars: 10_000, maxOutputTokens: 4096, price: PRICE };
  const config = {
    providers: { p1: { complete: () => Promise.reject(new Error("unused")) } },
    models: { m1: { ...spec, ...modelOver }, m2: spec },
    clock: manualClock(),
    timers,
    usageSink: { record: (e: UsageEvent) => void events.push(e) },
    ...over,
  };
  const gw = must(createToolGateway(config, { models: { m1: { format, provider } } }));
  return { gw, provider, timers, events };
}
const fails = (r: ToolStepResult) => {
  if (r.ok) throw new Error("انتظار شکست");
  return r.error;
};
const wins = (r: ToolStepResult) => {
  if (!r.ok) throw new Error(`انتظار موفقیت: ${JSON.stringify(r.error)}`);
  return r.value;
};
const deepFrozen = (v: unknown): boolean => typeof v !== "object" || v === null || (Object.isFrozen(v) && Object.values(v).every(deepFrozen));

describe("createToolGateway · پیکربندی", () => {
  const baseCfg = () => ({
    providers: { p1: { complete: () => Promise.reject(new Error("x")) } },
    models: { m1: { provider: "p1", providerModel: "pm", maxInputChars: 100, maxOutputTokens: 100, price: PRICE }, m2: { provider: "p1", providerModel: "pm", maxInputChars: 100, maxOutputTokens: 100, price: null } },
    clock: manualClock(),
  });
  const okProvider = { completeWithTools: () => Promise.resolve({}) };
  it("معتبر: قالب برای مدلِ ابزاری و null برای مدلِ بی‌ابزار/ناشناخته/غیرمتن", () => {
    const g = must(createToolGateway(baseCfg(), { models: { m1: { format: "anthropic-messages", provider: okProvider } } }));
    expect(g.toolFormat("m1")).toBe("anthropic-messages");
    expect(g.toolFormat("m2")).toBeNull();
    expect(g.toolFormat("nope")).toBeNull();
    expect(g.toolFormat(5 as unknown as string)).toBeNull();
    expect(g.toolFormat("__proto__")).toBeNull();
    expect(Object.isFrozen(g)).toBe(true);
  });
  it("limits همان حدهای پیکربندیِ پایه است", () => {
    const g = must(createToolGateway(baseCfg(), { models: { m1: { format: "openai-chat", provider: okProvider } } }));
    expect(g.limits("m1")).toEqual({ maxInputChars: 100, maxOutputTokens: 100, priced: true });
    expect(g.limits("m2")).toEqual({ maxInputChars: 100, maxOutputTokens: 100, priced: false });
    expect(g.limits("zzz")).toBeNull();
  });
  it("پیکربندیِ پایهٔ نامعتبر ⇒ INVALID_CONFIG", () => {
    const r = createToolGateway({ nope: 1 }, { models: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_CONFIG");
  });
  it.each([
    ["غیرشیء", 5],
    ["null", null],
    ["آرایه", []],
    ["بدونِ models", {}],
    ["models تهی", { models: {} }],
    ["کلیدِ ناشناخته", { models: { m1: { format: "openai-chat", provider: okProvider } }, extra: 1 }],
    ["مدلِ ناموجود در پایه", { models: { ghost: { format: "openai-chat", provider: okProvider } } }],
    ["قالبِ ناشناخته", { models: { m1: { format: "gemini", provider: okProvider } } }],
    ["بدونِ قالب", { models: { m1: { provider: okProvider } } }],
    ["ارائه‌دهندهٔ بی‌متد", { models: { m1: { format: "openai-chat", provider: {} } } }],
    ["ارائه‌دهندهٔ رشته", { models: { m1: { format: "openai-chat", provider: "p1" } } }],
    ["کلیدِ ناشناختهٔ مدل", { models: { m1: { format: "openai-chat", provider: okProvider, price: 1 } } }],
    ["مدل غیرشیء", { models: { m1: 5 } }],
  ])("setup نامعتبر (%s) ⇒ INVALID_CONFIG بی‌پرتاب", (_n, setup) => {
    const r = createToolGateway(baseCfg(), setup);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_CONFIG");
      expect((r.error.issues ?? []).length).toBeGreaterThan(0);
    }
  });
  it("getterِ پرتابگر در setup ⇒ INVALID_CONFIG، نه پرتاب", () => {
    const bad = { get models(): never { throw new Error("boom"); } };
    const r = createToolGateway(baseCfg(), bad);
    expect(r.ok).toBe(false);
  });
  it("متدِ ارائه‌دهنده هنگام ساخت گرفته می‌شود و this حفظ می‌شود", async () => {
    const p = { tag: "T", completeWithTools(this: { tag?: string }) { return this.tag === "T" ? Promise.resolve(OAI_TEXT) : Promise.reject(new Error("this lost")); } };
    const g = must(createToolGateway(baseCfg(), { models: { m1: { format: "openai-chat", provider: p } } }));
    (p as { completeWithTools: unknown }).completeWithTools = () => Promise.resolve("garbage");
    expect(wins(await g.completeStep(BASE)).text).toBe("پاسخ نهایی");
  });
});

describe("completeStep · اعتبارسنجیِ درخواست", () => {
  it.each(["openai-chat", "anthropic-messages"] as const)("%s: مسیرِ خوشحال؛ ارائه‌دهنده فقط دادهٔ سنجیده و یخ‌زده می‌بیند", async (format) => {
    const { gw, provider } = rig([{ reply: format === "openai-chat" ? OAI_TOOL : ANT_TOOL }], format);
    const r = await gw.completeStep({ ...BASE, requestId: "r-1" });
    expect(r.ok).toBe(true);
    expect(provider.calls).toHaveLength(1);
    const c = provider.calls[0]!;
    expect(c.format).toBe(format);
    expect(c.model).toBe("provider-model-1");
    expect(c.messages).toEqual(BASE.messages);
    expect(c.temperature).toBe(0);
    expect(c.stopSequences).toEqual([]);
    expect(c.maxOutputTokens).toBe(100);
    expect(c.continuation).toEqual([]);
    const enc = encodeTools(format, [SPEC]);
    expect(enc.ok && c.tools).toEqual(enc.ok ? enc.value : null);
    expect(c.signal.aborted).toBe(false);
    expect(Object.isFrozen(c)).toBe(true);
    for (const part of [c.messages, c.tools, c.continuation, c.stopSequences]) expect(deepFrozen(part)).toBe(true);
  });
  it("toolChoice و allowParallel به سیم می‌رسند", async () => {
    const { gw, provider } = rig([{ reply: OAI_TOOL }]);
    await gw.completeStep({ ...BASE, toolChoice: "required", allowParallel: true });
    expect(provider.calls[0]!.tools).toMatchObject({ tool_choice: "required", parallel_tool_calls: true });
    const a = rig([{ reply: ANT_TOOL }], "anthropic-messages");
    await a.gw.completeStep({ ...BASE, toolChoice: { name: "court_fee" } });
    expect(a.provider.calls[0]!.tools).toMatchObject({ tool_choice: { type: "tool", name: "court_fee", disable_parallel_tool_use: true } });
  });
  it.each([
    ["ابزار نیامده", { tools: undefined }],
    ["ابزارِ تهی", { tools: [] }],
    ["ابزارِ غیرآرایه", { tools: "x" }],
    ["نامِ ابزارِ نامعتبر", { tools: [{ ...SPEC, name: "bad name!" }] }],
    ["نامِ تکراری", { tools: [SPEC, SPEC] }],
    ["toolChoice نامعتبر", { toolChoice: "sometimes" }],
    ["toolChoice با نامِ ناموجود", { toolChoice: { name: "ghost" } }],
    ["allowParallel غیربولی", { allowParallel: "yes" }],
    ["کلیدِ ناشناخته (غلط املایی)", { temprature: 0.2 }],
    ["مدلِ ناشناخته", { model: "ghost" }],
    ["پیامِ آخر غیرکاربر", { messages: [{ role: "assistant", content: "x" }] }],
    ["maxOutputTokens بیرون از بازه", { maxOutputTokens: 999_999 }],
  ])("%s ⇒ شکستِ بسته، ارائه‌دهنده صدا نمی‌خورد و رویدادی ثبت نمی‌شود", async (_n, over) => {
    const { gw, provider, events } = rig();
    const e = fails(await gw.completeStep({ ...BASE, ...over }));
    expect(["INVALID_REQUEST", "UNKNOWN_MODEL"]).toContain(e.code);
    expect(e.usage).toBeNull();
    expect(e.cost).toBeNull();
    expect(provider.calls).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
  it("مدلِ بدونِ تنظیمِ ابزار ⇒ INVALID_REQUEST با دلیل", async () => {
    const { gw, provider } = rig();
    const e = fails(await gw.completeStep({ ...BASE, model: "m2" }));
    expect(e.code).toBe("INVALID_REQUEST");
    expect(e.issues?.join(" ")).toContain("model");
    expect(provider.calls).toHaveLength(0);
  });
  it.each([5, null, "x", [], undefined])("ورودیِ غیرشیء (%j) ⇒ INVALID_REQUEST", async (input) => {
    const e = fails(await rig().gw.completeStep(input));
    expect(e.code).toBe("INVALID_REQUEST");
  });
  it("ورودیِ getterِ پرتابگر ⇒ INVALID_REQUEST، نه پرتاب", async () => {
    const bad = { ...BASE, get requestId(): never { throw new Error("boom"); } };
    const r = await rig().gw.completeStep(bad);
    expect(fails(r).code).toBe("INVALID_REQUEST");
  });
  it("options نامعتبر یا signalِ غیرAbortSignal ⇒ INVALID_REQUEST", async () => {
    const { gw, provider } = rig();
    expect(fails(await gw.completeStep(BASE, 5 as never)).code).toBe("INVALID_REQUEST");
    expect(fails(await gw.completeStep(BASE, { signal: {} as never })).code).toBe("INVALID_REQUEST");
    expect(provider.calls).toHaveLength(0);
  });
  it("مشکل‌ها محتوا نمی‌آورند (فقط نامِ فیلد)", async () => {
    const { gw } = rig();
    const e = fails(await gw.completeStep({ ...BASE, tools: [{ ...SPEC, name: SECRET }], continuation: [{ role: "system", content: SECRET }] }));
    expect(JSON.stringify(e)).not.toContain(SECRET);
  });
});

describe("completeStep · continuation", () => {
  const OAI_CONT = [{ role: "assistant", content: null, tool_calls: [oaiCall()] }, { role: "tool", tool_call_id: "call_1", content: "{}" }];
  const ANT_CONT = [
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "court_fee", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{}" }] },
  ];
  it("OpenAI: ادامهٔ معتبر بی‌تغییر و یخ‌زده به ارائه‌دهنده می‌رسد", async () => {
    const { gw, provider } = rig([{ reply: OAI_TEXT }]);
    wins(await gw.completeStep({ ...BASE, continuation: OAI_CONT }));
    expect(provider.calls[0]!.continuation).toEqual(OAI_CONT);
    expect(deepFrozen(provider.calls[0]!.continuation)).toBe(true);
  });
  it("Anthropic: ادامهٔ معتبر", async () => {
    const { gw, provider } = rig([{ reply: ANT_TEXT }], "anthropic-messages");
    wins(await gw.completeStep({ ...BASE, continuation: ANT_CONT }));
    expect(provider.calls[0]!.continuation).toEqual(ANT_CONT);
  });
  it("ادامه کپیِ مستقل است: ویرایشِ بعدیِ فراخواننده اثری ندارد", async () => {
    const cont = JSON.parse(JSON.stringify(OAI_CONT)) as Record<string, unknown>[];
    const { gw, provider } = rig([{ reply: OAI_TEXT }]);
    wins(await gw.completeStep({ ...BASE, continuation: cont }));
    cont[1]!["content"] = "mutated";
    expect((provider.calls[0]!.continuation[1] as Record<string, unknown>)["content"]).toBe("{}");
  });
  it.each([
    ["نقشِ system (تزریقِ دستور)", "openai-chat", [{ role: "system", content: "x" }, ...OAI_CONT]],
    ["نقشِ system در میانه", "openai-chat", [OAI_CONT[0], { role: "system", content: "x" }, OAI_CONT[1]]],
    ["نقشِ ناشناخته", "openai-chat", [{ role: "developer", content: "x" }, ...OAI_CONT]],
    ["نقشِ ناشناخته در میانه", "openai-chat", [OAI_CONT[0], { role: "developer", content: "x" }, OAI_CONT[1]]],
    ["نقشِ system در Anthropic", "anthropic-messages", [ANT_CONT[0], { role: "system", content: "x" }, ANT_CONT[1]]],
    ["نقشِ tool در Anthropic", "anthropic-messages", [ANT_CONT[0], { role: "tool", content: "x" }]],
    ["شروع با user", "openai-chat", [{ role: "user", content: "x" }]],
    ["پایان با assistant", "openai-chat", [OAI_CONT[0]]],
    ["نقشِ غیرمتن", "openai-chat", [{ role: 5 }]],
    ["غیرشیء", "openai-chat", ["x"]],
    ["مقدارِ غیر-JSON (NaN)", "openai-chat", [OAI_CONT[0], { role: "tool", tool_call_id: "c", content: Number.NaN }]],
    ["مقدارِ undefined", "openai-chat", [OAI_CONT[0], { role: "tool", tool_call_id: "c", content: undefined }]],
    ["کلیدِ __proto__", "openai-chat", [OAI_CONT[0], JSON.parse('{"role":"tool","__proto__":{"x":1}}')]],
    ["جفت‌جانشینِ تنها", "openai-chat", [OAI_CONT[0], { role: "tool", tool_call_id: "c", content: "\ud800" }]],
  ] as const)("%s ⇒ INVALID_REQUEST و ارائه‌دهنده صدا نمی‌خورد", async (_n, format, cont) => {
    const { gw, provider } = rig([{ reply: OAI_TEXT }], format);
    const e = fails(await gw.completeStep({ ...BASE, continuation: cont }));
    expect(e.code).toBe("INVALID_REQUEST");
    expect(provider.calls).toHaveLength(0);
  });
  it("غیرآرایه یا بیش از سقفِ تعداد ⇒ رد", async () => {
    const { gw } = rig();
    expect(fails(await gw.completeStep({ ...BASE, continuation: "x" })).code).toBe("INVALID_REQUEST");
    const many = [OAI_CONT[0], ...Array.from({ length: TOOL_STEP_LIMITS.maxContinuationMessages }, () => OAI_CONT[1])];
    expect(fails(await gw.completeStep({ ...BASE, continuation: many })).code).toBe("INVALID_REQUEST");
  });
  it("بیش از سقفِ اندازه ⇒ رد", async () => {
    const { gw, provider } = rig();
    const big = { role: "tool", tool_call_id: "c", content: "x".repeat(TOOL_STEP_LIMITS.maxContinuationChars) };
    expect(fails(await gw.completeStep({ ...BASE, continuation: [OAI_CONT[0], big] })).code).toBe("INVALID_REQUEST");
    expect(provider.calls).toHaveLength(0);
  });
  it("ادامهٔ تهی همان بی‌ادامه است", async () => {
    const { gw, provider } = rig([{ reply: OAI_TEXT }]);
    wins(await gw.completeStep({ ...BASE, continuation: [] }));
    expect(provider.calls[0]!.continuation).toEqual([]);
  });
});

describe("completeStep · پاسخِ موفق", () => {
  it("OpenAI tool_calls: فراخوانی، پیامِ دستیار، مصرف و هزینهٔ صحیح، رویدادِ مصرف", async () => {
    const { gw, events } = rig([{ reply: OAI_TOOL }]);
    const v = wins(await gw.completeStep({ ...BASE, requestId: "req-7" }));
    expect(v.finish).toBe("tool_calls");
    expect(v.toolCalls).toEqual([{ id: "call_1", name: "court_fee", argumentsJson: '{"amountRials":100}' }]);
    expect(v.assistantMessage).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_1" }] });
    expect(v.usage).toEqual({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 });
    expect(v.cost).toEqual({ micros: 10_500, currency: "IRR", priceVersion: "test-prices-v1" }); // ⌈(1000×3e6+500×15e6)/1e6⌉
    expect(v.servedModel).toBe("served-1");
    expect(v.model).toBe("m1");
    expect(v.provider).toBe("p1");
    expect(v.format).toBe("openai-chat");
    expect(v.requestId).toBe("req-7");
    expect(v.warnings).toEqual([]);
    expect(deepFrozen(v)).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ requestId: "req-7", model: "m1", provider: "p1", providerModel: "provider-model-1", servedModel: "served-1", outcome: "ok", finishReason: "stop", usage: v.usage, cost: v.cost });
  });
  it("Anthropic tool_use", async () => {
    const { gw } = rig([{ reply: ANT_TOOL }], "anthropic-messages");
    const v = wins(await gw.completeStep(BASE));
    expect(v.finish).toBe("tool_calls");
    expect(v.toolCalls[0]).toMatchObject({ id: "toolu_1", name: "court_fee" });
    expect(v.usage?.totalTokens).toBe(1500);
    expect(v.format).toBe("anthropic-messages");
  });
  it.each([
    ["openai-chat", OAI_TEXT],
    ["anthropic-messages", ANT_TEXT],
  ] as const)("%s: پاسخِ متنیِ بی‌ابزار ⇒ finish=stop و toolCalls تهی", async (format, reply) => {
    const { gw, events } = rig([{ reply }], format);
    const v = wins(await gw.completeStep(BASE));
    expect(v.finish).toBe("stop");
    expect(v.toolCalls).toEqual([]);
    expect(v.text).toBe("پاسخ نهایی");
    expect(events[0]?.finishReason).toBe("stop");
  });
  it("latencyMs از ساعتِ تزریقی می‌آید", async () => {
    const clock = manualClock();
    const { gw } = rig([{ run: () => { clock.t += 321; return OAI_TOOL; } }], "openai-chat", { clock });
    expect(wins(await gw.completeStep(BASE)).latencyMs).toBe(321);
  });
  it("پاسخِ بریدهٔ متنی (length) ⇒ موفق ولی OUTPUT_TRUNCATED", async () => {
    const { gw, events } = rig([{ reply: oai({ content: "نیمه" }, "length") }]);
    const v = wins(await gw.completeStep(BASE));
    expect(v.finish).toBe("length");
    expect(v.warnings).toContain("OUTPUT_TRUNCATED");
    expect(events[0]?.finishReason).toBe("length");
  });
  it("پاسخِ تهیِ بی‌ابزار ⇒ EMPTY_OUTPUT؛ اما فراخوانیِ بی‌متن هشدار نمی‌گیرد", async () => {
    const empty = rig([{ reply: oai({ content: "" }, "stop") }]);
    expect(wins(await empty.gw.completeStep(BASE)).warnings).toContain("EMPTY_OUTPUT");
    const tool = rig([{ reply: OAI_TOOL }]);
    expect(wins(await tool.gw.completeStep(BASE)).warnings).not.toContain("EMPTY_OUTPUT");
  });
  it("بدونِ مصرف ⇒ USAGE_MISSING، usage و cost برابرِ null (نه صفر)", async () => {
    const { gw, events } = rig([{ reply: { ...OAI_TOOL, usage: undefined } }]);
    const v = wins(await gw.completeStep(BASE));
    expect(v.usage).toBeNull();
    expect(v.cost).toBeNull();
    expect(v.warnings).toContain("USAGE_MISSING");
    expect(events[0]?.usage).toBeNull();
  });
  it("مدلِ بی‌قیمت ⇒ UNPRICED با usage و cost=null", async () => {
    const { gw } = rig([{ reply: OAI_TOOL }], "openai-chat", {}, { price: null });
    const v = wins(await gw.completeStep(BASE));
    expect(v.warnings).toContain("UNPRICED");
    expect(v.usage).not.toBeNull();
    expect(v.cost).toBeNull();
  });
  it("Anthropic با کشِ ناصفر ⇒ مصرف ناشناخته (هزینه هرگز کمتر از واقع نیست)", async () => {
    const reply = { ...ANT_TOOL, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900 } };
    const v = wins(await rig([{ reply }], "anthropic-messages").gw.completeStep(BASE));
    expect(v.usage).toBeNull();
    expect(v.cost).toBeNull();
    expect(v.warnings).toContain("USAGE_MISSING");
  });
  it("آرگومانِ خرابِ مدل خطای دروازه نیست؛ عیناً می‌گذرد تا مرزِ اجرا ردش کند", async () => {
    const reply = oai({ content: null, tool_calls: [oaiCall("c1", "court_fee", "{broken")] }, "tool_calls");
    const v = wins(await rig([{ reply }]).gw.completeStep(BASE));
    expect(v.toolCalls[0]?.argumentsJson).toBe("{broken");
  });
  it("رویداد و نتیجه متنِ پیام/پاسخ ندارند", async () => {
    const reply = oai({ content: null, tool_calls: [oaiCall("c1", "court_fee", "{}")] }, "tool_calls", { model: "served-1" });
    const { gw, events } = rig([{ reply }]);
    wins(await gw.completeStep({ ...BASE, messages: [{ role: "user", content: SECRET }] }));
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });
});

describe("completeStep · شکست‌ها و مصرفِ نجات‌یافته", () => {
  it("فراخوانیِ بریده (length + tool_calls) ⇒ PROVIDER_BAD_RESPONSE با نشانهٔ ثابت؛ هرگز اجرا نمی‌شود؛ مصرف ثبت می‌شود", async () => {
    const reply = oai({ content: null, tool_calls: [oaiCall("c1", "court_fee", '{"amountRials":1')] }, "length");
    const { gw, events } = rig([{ reply }]);
    const e = fails(await gw.completeStep(BASE));
    expect(e.code).toBe("PROVIDER_BAD_RESPONSE");
    expect(e.issues?.[0]).toBe(TRUNCATED_TOOL_CALL_ISSUE);
    expect(e.retryable).toBe(false);
    expect(e.usage).toEqual({ inputTokens: 1000, outputTokens: 500, totalTokens: 1500 });
    expect(e.cost?.micros).toBe(10_500);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "PROVIDER_BAD_RESPONSE", finishReason: null, usage: e.usage, cost: e.cost });
    expect(JSON.stringify(e)).not.toContain("amountRials");
  });
  it("Anthropic max_tokens همراهِ tool_use ⇒ بریده", async () => {
    const reply = { ...ANT_TOOL, stop_reason: "max_tokens" };
    const e = fails(await rig([{ reply }], "anthropic-messages").gw.completeStep(BASE));
    expect(e.issues?.[0]).toBe(TRUNCATED_TOOL_CALL_ISSUE);
    expect(e.usage?.totalTokens).toBe(1500);
  });
  it.each([
    ["غیرشیء", "نه شیء"],
    ["null", null],
    ["بدونِ choices", { model: "x" }],
    ["tool_calls بدونِ فراخوانی", oai({ content: "x" }, "tool_calls")],
    ["شناسهٔ تکراری", oai({ content: null, tool_calls: [oaiCall("d"), oaiCall("d")] }, "tool_calls")],
  ])("پاسخِ خراب (%s) ⇒ PROVIDER_BAD_RESPONSE", async (_n, reply) => {
    const { gw, events } = rig([{ reply }]);
    const e = fails(await gw.completeStep(BASE));
    expect(e.code).toBe("PROVIDER_BAD_RESPONSE");
    expect(events[0]?.outcome).toBe("PROVIDER_BAD_RESPONSE");
  });
  it("پاسخِ خرابِ دارای مصرفِ معتبر ⇒ مصرف نجات می‌یابد (هزینه شده است)", async () => {
    const { gw, events } = rig([{ reply: oai({ content: "x" }, "tool_calls") }]);
    const e = fails(await gw.completeStep(BASE));
    expect(e.usage?.inputTokens).toBe(1000);
    expect(e.cost?.micros).toBe(10_500);
    expect(events[0]?.usage).toEqual(e.usage);
  });
  it("پاسخِ خرابِ بدونِ مصرفِ معتبر ⇒ usage=null", async () => {
    const e = fails(await rig([{ reply: { choices: "x", usage: { prompt_tokens: -1, completion_tokens: 2 } } }]).gw.completeStep(BASE));
    expect(e.usage).toBeNull();
    expect(e.cost).toBeNull();
  });
  it("متنِ پاسخِ مدل در خطا بازتاب نمی‌شود", async () => {
    const reply = oai({ content: SECRET }, "tool_calls");
    const e = fails(await rig([{ reply }]).gw.completeStep(BASE));
    expect(JSON.stringify(e)).not.toContain(SECRET);
  });
  it("ProviderFailure rate_limited ⇒ PROVIDER_RATE_LIMITED، قابل‌تلاش، retryAfterMs؛ پیامِ خام نمی‌آید", async () => {
    const f = new ProviderFailure("rate_limited", { retryAfterMs: 1500, cause: new Error(SECRET) });
    const { gw, events } = rig([{ fail: f }]);
    const e = fails(await gw.completeStep(BASE));
    expect(e.code).toBe("PROVIDER_RATE_LIMITED");
    expect(e.retryable).toBe(true);
    expect(e.retryAfterMs).toBe(1500);
    expect(e.usage).toBeNull();
    expect(JSON.stringify(e)).not.toContain(SECRET);
    expect(events[0]).toMatchObject({ outcome: "PROVIDER_RATE_LIMITED", usage: null, cost: null });
  });
  it.each([
    ["unavailable", "PROVIDER_UNAVAILABLE"],
    ["auth", "PROVIDER_AUTH"],
    ["rejected", "PROVIDER_REJECTED"],
  ] as const)("ProviderFailure %s ⇒ %s", async (kind, code) => {
    expect(fails(await rig([{ fail: new ProviderFailure(kind) }]).gw.completeStep(BASE)).code).toBe(code);
  });
  it("هر استثنای دیگر ⇒ PROVIDER_ERROR (نه قابل‌تلاش) بی‌نشتِ پیام", async () => {
    const e = fails(await rig([{ fail: new Error(SECRET) }]).gw.completeStep(BASE));
    expect(e.code).toBe("PROVIDER_ERROR");
    expect(e.retryable).toBe(false);
    expect(JSON.stringify(e)).not.toContain(SECRET);
  });
  it("استثنای غیرِ Error (رشته/شیء) هم بسته شکست می‌خورد", async () => {
    expect(fails(await rig([{ fail: "boom" }]).gw.completeStep(BASE)).code).toBe("PROVIDER_ERROR");
    expect(fails(await rig([{ fail: { x: 1 } }]).gw.completeStep(BASE)).code).toBe("PROVIDER_ERROR");
  });
  it("مهلت ⇒ TIMEOUT، سیگنالِ ارائه‌دهنده لغو می‌شود، رویداد ثبت می‌شود", async () => {
    const { gw, provider, timers, events } = rig([{ hang: true }]);
    const p = gw.completeStep({ ...BASE, timeoutMs: 500 });
    await Promise.resolve();
    await Promise.resolve();
    timers.advance(500);
    const e = fails(await p);
    expect(e.code).toBe("TIMEOUT");
    expect(e.retryable).toBe(true);
    expect(provider.calls[0]!.signal.aborted).toBe(true);
    expect(events[0]?.outcome).toBe("TIMEOUT");
  });
  it("لغوِ پیش از فراخوانی ⇒ ABORTED بدونِ تماس", async () => {
    const { gw, provider, events } = rig();
    const ac = new AbortController();
    ac.abort();
    expect(fails(await gw.completeStep(BASE, { signal: ac.signal })).code).toBe("ABORTED");
    expect(provider.calls).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
  it("لغو در میانهٔ کار ⇒ ABORTED و سیگنالِ ارائه‌دهنده لغو می‌شود", async () => {
    const { gw, provider, events } = rig([{ hang: true }]);
    const ac = new AbortController();
    const p = gw.completeStep(BASE, { signal: ac.signal });
    await Promise.resolve();
    await Promise.resolve();
    ac.abort();
    const e = fails(await p);
    expect(e.code).toBe("ABORTED");
    expect(e.retryable).toBe(false);
    expect(provider.calls[0]!.signal.aborted).toBe(true);
    expect(events[0]?.outcome).toBe("ABORTED");
  });
  it("ساعتِ خراب ⇒ INTERNAL_ERROR، هرگز پرتاب", async () => {
    const clock = { nowMs: () => Number.NaN };
    const { gw } = rig([{ reply: OAI_TOOL }], "openai-chat", { clock });
    expect(fails(await gw.completeStep(BASE)).code).toBe("INTERNAL_ERROR");
  });
  it("پاسخِ دارای getterِ پرتابگر ⇒ بسته شکست می‌خورد، نه پرتاب", async () => {
    const reply = { get choices(): never { throw new Error("boom"); } };
    const e = fails(await rig([{ reply }]).gw.completeStep(BASE));
    expect(["PROVIDER_BAD_RESPONSE", "INTERNAL_ERROR"]).toContain(e.code);
  });
  it("خطاها همه زیرنوعِ GatewayError‌اند (message ثابت فارسی، warnings آرایه)", async () => {
    const e = fails(await rig([{ fail: new Error("x") }]).gw.completeStep(BASE));
    expect(typeof e.message).toBe("string");
    expect(Array.isArray(e.warnings)).toBe(true);
    expect(Object.isFrozen(e)).toBe(true);
  });
});

describe("completeStep · مقصدِ مصرف", () => {
  it("شکستِ مقصد ⇒ هشدارِ USAGE_SINK_FAILED و پاسخ از دست نمی‌رود", async () => {
    const { gw } = rig([{ reply: OAI_TOOL }], "openai-chat", { usageSink: { record: () => { throw new Error("db down"); } } });
    const v = wins(await gw.completeStep(BASE));
    expect(v.warnings).toContain("USAGE_SINK_FAILED");
    expect(v.toolCalls).toHaveLength(1);
  });
  it("کندیِ مقصد ⇒ USAGE_SINK_TIMEOUT", async () => {
    const { gw, timers } = rig([{ reply: OAI_TOOL }], "openai-chat", { usageSink: { record: () => new Promise<void>(() => undefined) }, sinkTimeoutMs: 100 });
    const p = gw.completeStep(BASE);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    timers.advance(100);
    expect(wins(await p).warnings).toContain("USAGE_SINK_TIMEOUT");
  });
  it("شکستِ مقصد روی گامِ ناموفق هم هشدار را در error.warnings می‌گذارد", async () => {
    const { gw } = rig([{ fail: new Error("x") }], "openai-chat", { usageSink: { record: () => Promise.reject(new Error("db down")) } });
    expect(fails(await gw.completeStep(BASE)).warnings).toContain("USAGE_SINK_FAILED");
  });
  it("بدونِ مقصد هم کار می‌کند", async () => {
    const { gw } = rig([{ reply: OAI_TOOL }], "openai-chat", { usageSink: undefined });
    expect(wins(await gw.completeStep(BASE)).warnings).toEqual([]);
  });
});

describe("completeStep · هم‌زمانی و حلقهٔ دستی", () => {
  it("دو گامِ هم‌زمان مستقل‌اند", async () => {
    const { gw, provider, events } = rig([{ reply: OAI_TOOL }, { reply: OAI_TEXT }]);
    const [a, b] = await Promise.all([gw.completeStep({ ...BASE, requestId: "a" }), gw.completeStep({ ...BASE, requestId: "b" })]);
    expect(wins(a).requestId).toBe("a");
    expect(wins(b).requestId).toBe("b");
    expect(provider.calls).toHaveLength(2);
    expect(events.map((e) => e.requestId).sort()).toEqual(["a", "b"]);
  });
  it("دو گامِ پیاپی: assistantMessage + encodeToolResults ادامهٔ معتبرِ گام بعد است (هر دو قالب)", async () => {
    for (const format of ["openai-chat", "anthropic-messages"] as const) {
      const { gw, provider } = rig([{ reply: format === "openai-chat" ? OAI_TOOL : ANT_TOOL }, { reply: format === "openai-chat" ? OAI_TEXT : ANT_TEXT }], format);
      const s1 = wins(await gw.completeStep(BASE));
      const res = encodeToolResults(format, s1.toolCalls, s1.toolCalls.map((c) => ({ id: c.id, content: '{"ok":true}' })));
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const s2 = wins(await gw.completeStep({ ...BASE, continuation: [s1.assistantMessage, ...res.value] }));
      expect(s2.finish).toBe("stop");
      expect(provider.calls[1]!.continuation).toHaveLength(1 + res.value.length);
      expect(gw.toolFormat("m1")).toBe(format);
    }
  });
});
