import { describe, expect, it } from "vitest";
import { decodeToolReply, encodeToolResults, encodeTools, TOOL_LIMITS } from "./index";

/** آزمون‌های رمزگذارِ ابزار روی سیم (ADR-0054). شکل‌های سیم از مستندِ رسمیِ OpenAI و Anthropic نوشته شده‌اند، نه از خروجیِ خودِ کد. */

const PARAMS = {
  type: "object",
  description: "ورودی",
  properties: { amountRials: { type: "integer", minimum: 0, maximum: 1000 }, kind: { type: "string", enum: ["a", "b"] } },
  required: ["amountRials"],
  additionalProperties: false,
} as const;
const SPEC = { name: "court_fee", description: "هزینهٔ دادرسی را محاسبه می‌کند.", parameters: PARAMS };
const SPEC2 = { name: "late_payment", description: "خسارت تأخیر.", parameters: PARAMS };

const deepFrozen = (v: unknown): boolean => typeof v !== "object" || v === null || (Object.isFrozen(v) && Object.values(v).every(deepFrozen));
const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`انتظار موفقیت: ${JSON.stringify(r.error)}`);
  return r.value;
};
const errOf = (r: { ok: boolean; error?: { code: string; message: string; issues: readonly string[]; usage: unknown } }) => {
  if (r.ok || r.error === undefined) throw new Error("انتظار خطا");
  return r.error;
};

describe("encodeTools · قالبِ OpenAI", () => {
  it("شکلِ مرجع: tools/function، tool_choice=auto، parallel_tool_calls=false", () => {
    expect(must(encodeTools("openai-chat", [SPEC]))).toEqual({
      tools: [{ type: "function", function: { name: "court_fee", description: SPEC.description, parameters: PARAMS } }],
      tool_choice: "auto",
      parallel_tool_calls: false,
    });
  });
  it.each([
    ["auto", "auto"],
    ["none", "none"],
    ["required", "required"],
    [{ name: "late_payment" }, { type: "function", function: { name: "late_payment" } }],
  ] as const)("choice=%j", (choice, wire) => {
    const v = must(encodeTools("openai-chat", [SPEC, SPEC2], { choice })) as Record<string, unknown>;
    expect(v["tool_choice"]).toEqual(wire);
  });
  it("allowParallel=true ⇒ parallel_tool_calls=true؛ ترتیبِ ابزارها حفظ می‌شود", () => {
    const v = must(encodeTools("openai-chat", [SPEC2, SPEC], { allowParallel: true })) as { tools: { function: { name: string } }[]; parallel_tool_calls: boolean };
    expect(v.parallel_tool_calls).toBe(true);
    expect(v.tools.map((t) => t.function.name)).toEqual(["late_payment", "court_fee"]);
  });
  it("strict عمداً فرستاده نمی‌شود (شماها فیلدِ اختیاری دارند)", () => {
    expect(JSON.stringify(must(encodeTools("openai-chat", [SPEC])))).not.toContain("strict");
  });
});

describe("encodeTools · قالبِ Anthropic", () => {
  it("شکلِ مرجع: input_schema و tool_choice با disable_parallel_tool_use=true", () => {
    expect(must(encodeTools("anthropic-messages", [SPEC]))).toEqual({
      tools: [{ name: "court_fee", description: SPEC.description, input_schema: PARAMS }],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
    });
  });
  it.each([
    ["auto", { type: "auto", disable_parallel_tool_use: true }],
    ["required", { type: "any", disable_parallel_tool_use: true }],
    [{ name: "court_fee" }, { type: "tool", name: "court_fee", disable_parallel_tool_use: true }],
    ["none", { type: "none" }],
  ] as const)("choice=%j", (choice, wire) => {
    const v = must(encodeTools("anthropic-messages", [SPEC, SPEC2], { choice })) as Record<string, unknown>;
    expect(v["tool_choice"]).toEqual(wire);
  });
  it("allowParallel=true ⇒ disable_parallel_tool_use=false", () => {
    const v = must(encodeTools("anthropic-messages", [SPEC], { allowParallel: true })) as { tool_choice: Record<string, unknown> };
    expect(v.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: false });
  });
});

describe("encodeTools · خروجی مستقل و یخ‌زده", () => {
  it.each(["openai-chat", "anthropic-messages"] as const)("%s: ژرف یخ‌زده و کپیِ مستقل از ورودی", (format) => {
    const spec = { name: "t", description: "d", parameters: { type: "object", properties: { x: { type: "string" } } } };
    const out = must(encodeTools(format, [spec]));
    expect(deepFrozen(out)).toBe(true);
    const before = JSON.stringify(out);
    (spec.parameters.properties.x as { type: string }).type = "integer";
    spec.description = "changed";
    expect(JSON.stringify(out)).toBe(before);
  });
  it("ورودیِ فراخواننده یخ‌زده/تغییر داده نمی‌شود", () => {
    const specs = Object.freeze([Object.freeze({ ...SPEC })]);
    expect(encodeTools("openai-chat", specs).ok).toBe(true);
  });
});

describe("encodeTools · ورودیِ نامعتبر رد می‌شود (بی‌حدس، بی‌پرتاب)", () => {
  const cyc: Record<string, unknown> = { type: "object" };
  cyc["self"] = cyc;
  let deep: Record<string, unknown> = { type: "object" };
  for (let i = 0; i < 40; i++) deep = { type: "object", n: deep };
  const proto = JSON.parse('{"type":"object","__proto__":{"x":1}}') as Record<string, unknown>;
  const withParams = (parameters: unknown) => [{ ...SPEC, parameters }];
  const bad: [string, unknown, unknown?][] = [
    ["ابزار آرایه نیست", "x"],
    ["آرایهٔ تهی", []],
    ["بیش از سقف", Array.from({ length: TOOL_LIMITS.maxTools + 1 }, (_, i) => ({ ...SPEC, name: `t${i}` }))],
    ["نامِ تکراری", [SPEC, SPEC]],
    ["نام با فاصله", [{ ...SPEC, name: "a b" }]],
    ["نامِ تهی", [{ ...SPEC, name: "" }]],
    ["نامِ ۶۵ نویسه", [{ ...SPEC, name: "a".repeat(65) }]],
    ["نامِ فارسی", [{ ...SPEC, name: "هزینه" }]],
    ["نام عدد", [{ ...SPEC, name: 1 }]],
    ["توضیحِ تهی", [{ ...SPEC, description: "" }]],
    ["توضیحِ فقط‌فاصله", [{ ...SPEC, description: "  \n " }]],
    ["توضیحِ بلند", [{ ...SPEC, description: "x".repeat(TOOL_LIMITS.maxDescriptionChars + 1) }]],
    ["توضیحِ NUL", [{ ...SPEC, description: "a\u0000b" }]],
    ["توضیحِ جانشینِ تنها", [{ ...SPEC, description: "a\ud800" }]],
    ["کلیدِ ناشناختهٔ ابزار", [{ ...SPEC, strict: true }]],
    ["عضو شیء نیست", [null]],
    ["parameters آرایه", withParams([])],
    ["parameters از نوع array", withParams({ type: "array" })],
    ["parameters بدونِ type", withParams({ properties: {} })],
    ["NaN در شما", withParams({ type: "object", minimum: Number.NaN })],
    ["∞ در شما", withParams({ type: "object", minimum: Number.POSITIVE_INFINITY })],
    ["تابع در شما", withParams({ type: "object", f: () => 1 })],
    ["undefined در شما", withParams({ type: "object", u: undefined })],
    ["bigint در شما", withParams({ type: "object", b: BigInt(1) })],
    ["شیءِ غیرساده در شما", withParams({ type: "object", d: new Date(0) })],
    ["چرخه در شما", withParams(cyc)],
    ["ژرفای بیش‌ازحد", withParams(deep)],
    ["کلیدِ __proto__", withParams(proto)],
    ["شمای بزرگ", withParams({ type: "object", big: "x".repeat(TOOL_LIMITS.maxSchemaChars + 1) })],
    ["گزینهٔ ناشناخته", [SPEC], { chioce: "none" }],
    ["options آرایه", [SPEC], []],
    ["choice نامعتبر", [SPEC], { choice: "sometimes" }],
    ["choice با نامِ ناموجود", [SPEC], { choice: { name: "nope" } }],
    ["choice با کلیدِ اضافه", [SPEC], { choice: { name: "court_fee", extra: 1 } }],
    ["allowParallel رشته", [SPEC], { allowParallel: "yes" }],
  ];
  it.each(bad)("%s", (_n, specs, options) => {
    for (const format of ["openai-chat", "anthropic-messages"] as const) {
      const e = errOf(encodeTools(format, specs, options));
      expect(e.code).toBe("INVALID_TOOLS");
      expect(e.issues.length).toBeGreaterThan(0);
      expect(e.issues.length).toBeLessThanOrEqual(10);
      expect(e.usage).toBeNull();
    }
  });
  it("قالبِ ناشناخته", () => {
    for (const f of ["gemini", "", null, undefined, 1, {}]) expect(errOf(encodeTools(f, [SPEC])).code).toBe("INVALID_TOOLS");
  });
  it("پیامِ خطا کران‌دار است حتی با ۱۰۰ ابزارِ خراب", () => {
    const e = errOf(encodeTools("openai-chat", Array.from({ length: 100 }, () => null)));
    expect(e.message.length).toBeLessThan(200);
    expect(JSON.stringify(e).length).toBeLessThan(2000);
  });
  it("Proxyِ بدجنس: پرتاب نمی‌کند", () => {
    const trap = new Proxy({}, { get() { throw new Error("boom"); }, ownKeys() { throw new Error("boom"); }, getPrototypeOf() { throw new Error("boom"); } });
    expect(errOf(encodeTools("openai-chat", [trap])).code).toBe("INVALID_TOOLS");
    expect(errOf(encodeTools("openai-chat", [SPEC], trap)).code).toBe("INVALID_TOOLS");
    expect(errOf(encodeTools("openai-chat", trap)).code).toBe("INVALID_TOOLS");
  });
});

describe("encodeToolResults", () => {
  const calls = [
    { id: "call_1", name: "court_fee", argumentsJson: "{}" },
    { id: "call_2", name: "late_payment", argumentsJson: "{}" },
  ];
  it("OpenAI: یک پیام role=tool برای هر نتیجه، به ترتیبِ calls (نه results)", () => {
    const v = must(encodeToolResults("openai-chat", calls, [{ id: "call_2", content: "B" }, { id: "call_1", content: "A", isError: true }]));
    expect(v).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "A" },
      { role: "tool", tool_call_id: "call_2", content: "B" },
    ]);
  });
  it("Anthropic: یک پیامِ user با بلوک‌های tool_result؛ is_error فقط برای خطا", () => {
    const v = must(encodeToolResults("anthropic-messages", calls, [{ id: "call_2", content: "B" }, { id: "call_1", content: "A", isError: true }]));
    expect(v).toEqual([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "A", is_error: true },
          { type: "tool_result", tool_use_id: "call_2", content: "B" },
        ],
      },
    ]);
  });
  it("isError=false صریح هم is_error نمی‌فرستد", () => {
    const v = must(encodeToolResults("anthropic-messages", [calls[0]], [{ id: "call_1", content: "A", isError: false }]));
    expect(JSON.stringify(v)).not.toContain("is_error");
  });
  it("خروجی یخ‌زده است", () => {
    for (const f of ["openai-chat", "anthropic-messages"] as const) expect(deepFrozen(must(encodeToolResults(f, calls, [{ id: "call_1", content: "A" }, { id: "call_2", content: "B" }])))).toBe(true);
  });
  const ok2 = [{ id: "call_1", content: "A" }, { id: "call_2", content: "B" }];
  const bad: [string, unknown, unknown][] = [
    ["نتیجهٔ گم‌شده", calls, [ok2[0]]],
    ["هیچ نتیجه", calls, []],
    ["نتیجهٔ اضافه", calls, [...ok2, { id: "call_3", content: "C" }]],
    ["نتیجهٔ تکراری", calls, [ok2[0], ok2[0], ok2[1]]],
    ["id بی‌ربط به‌جای یکی", calls, [ok2[0], { id: "zzz", content: "B" }]],
    ["id نامعتبر", calls, [{ id: "a b", content: "A" }, ok2[1]]],
    ["محتوای تهی", calls, [{ id: "call_1", content: "" }, ok2[1]]],
    ["محتوای عدد", calls, [{ id: "call_1", content: 5 }, ok2[1]]],
    ["محتوای NUL", calls, [{ id: "call_1", content: "a\u0000" }, ok2[1]]],
    ["محتوای جانشینِ تنها", calls, [{ id: "call_1", content: "\udc00" }, ok2[1]]],
    ["محتوای بزرگ", calls, [{ id: "call_1", content: "x".repeat(TOOL_LIMITS.maxResultChars + 1) }, ok2[1]]],
    ["کلیدِ ناشناخته", calls, [{ id: "call_1", content: "A", is_error: true }, ok2[1]]],
    ["isError رشته", calls, [{ id: "call_1", content: "A", isError: "true" }, ok2[1]]],
    ["عضو شیء نیست", calls, [null, ok2[1]]],
    ["calls تهی", [], []],
    ["calls آرایه نیست", "x", ok2],
    ["results آرایه نیست", calls, "x"],
    ["idِ تکراری در calls", [calls[0], calls[0]], [ok2[0]]],
    ["call بدونِ id", [{ name: "x" }], [ok2[0]]],
    ["results بیش از سقف", calls, Array.from({ length: 17 }, (_, i) => ({ id: `c${i}`, content: "x" }))],
  ];
  it.each(bad)("%s", (_n, c, r) => {
    for (const f of ["openai-chat", "anthropic-messages"] as const) {
      const e = errOf(encodeToolResults(f, c, r));
      expect(e.code).toBe("INVALID_TOOL_RESULTS");
      expect(e.issues.length).toBeGreaterThan(0);
      expect(e.issues.length).toBeLessThanOrEqual(10);
    }
  });
  it("قالبِ ناشناخته و Proxyِ بدجنس بی‌پرتاب‌اند", () => {
    expect(errOf(encodeToolResults("x", calls, ok2)).code).toBe("INVALID_TOOL_RESULTS");
    const trap = new Proxy([], { get() { throw new Error("boom"); } });
    expect(errOf(encodeToolResults("openai-chat", trap, trap)).code).toBe("INVALID_TOOL_RESULTS");
  });
});

/* ───────────── رمزگشایی ───────────── */

const oaiReply = (message: Record<string, unknown>, finish: unknown = "stop", extra: Record<string, unknown> = {}) => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "gpt-x-2026",
  choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
  usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
  ...extra,
});
const oaiCall = (id: string, name: string, args: unknown) => ({ id, type: "function", function: { name, arguments: args } });

describe("decodeToolReply · OpenAI", () => {
  it("متنِ ساده: بدونِ ابزار", () => {
    const v = must(decodeToolReply("openai-chat", oaiReply({ content: "سلام" })));
    expect(v).toEqual({
      text: "سلام",
      toolCalls: [],
      finish: "stop",
      usage: { inputTokens: 120, outputTokens: 30 },
      servedModel: "gpt-x-2026",
      assistantMessage: { role: "assistant", content: "سلام" },
    });
  });
  it("فراخوانیِ ابزار: content=null، پیامِ دستیار با tool_calls بازسازی می‌شود", () => {
    const raw = oaiReply({ content: null, tool_calls: [oaiCall("call_abc", "court_fee", '{"amountRials":5}')] }, "tool_calls");
    const v = must(decodeToolReply("openai-chat", raw));
    expect(v.finish).toBe("tool_calls");
    expect(v.toolCalls).toEqual([{ id: "call_abc", name: "court_fee", argumentsJson: '{"amountRials":5}' }]);
    expect(v.text).toBe("");
    expect(v.assistantMessage).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_abc", type: "function", function: { name: "court_fee", arguments: '{"amountRials":5}' } }],
    });
  });
  it("متن + ابزار: متن در پیامِ دستیار می‌ماند", () => {
    const v = must(decodeToolReply("openai-chat", oaiReply({ content: "محاسبه می‌کنم", tool_calls: [oaiCall("c1", "t", "{}")] }, "tool_calls")));
    expect(v.text).toBe("محاسبه می‌کنم");
    expect((v.assistantMessage as { content: unknown }).content).toBe("محاسبه می‌کنم");
  });
  it("ابزارِ اجباری با finish_reason=stop ⇒ finish به tool_calls اصلاح می‌شود", () => {
    expect(must(decodeToolReply("openai-chat", oaiReply({ content: null, tool_calls: [oaiCall("c1", "t", "{}")] }, "stop"))).finish).toBe("tool_calls");
  });
  it("چند فراخوانی (موازی) به ترتیب", () => {
    const v = must(decodeToolReply("openai-chat", oaiReply({ tool_calls: [oaiCall("a", "x", "{}"), oaiCall("b", "y", "{}")] }, "tool_calls")));
    expect(v.toolCalls.map((c) => c.id)).toEqual(["a", "b"]);
  });
  it("آرگومانِ نامعتبرِ JSON عیناً می‌گذرد (مرزِ اجرا خطای قابل‌اصلاح می‌دهد)", () => {
    const v = must(decodeToolReply("openai-chat", oaiReply({ tool_calls: [oaiCall("a", "x", '{"amountRials": 5,')] }, "tool_calls")));
    expect(v.toolCalls[0]?.argumentsJson).toBe('{"amountRials": 5,');
  });
  it.each([
    ["stop", "stop"],
    ["length", "length"],
    ["content_filter", "content_filter"],
    ["function_call", "other"],
    [null, "other"],
    ["something_new", "other"],
  ])("finish_reason=%j ⇒ %s", (fr, want) => {
    expect(must(decodeToolReply("openai-chat", oaiReply({ content: "x" }, fr))).finish).toBe(want);
  });
  it("بریده‌شدن همراهِ ابزار ⇒ TRUNCATED_TOOL_CALL با مصرفِ نجات‌یافته", () => {
    const e = errOf(decodeToolReply("openai-chat", oaiReply({ tool_calls: [oaiCall("a", "x", '{"amou')] }, "length")));
    expect(e.code).toBe("TRUNCATED_TOOL_CALL");
    expect(e.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
  });
  it("content_filter همراهِ ابزار ⇒ TRUNCATED_TOOL_CALL", () => {
    expect(errOf(decodeToolReply("openai-chat", oaiReply({ tool_calls: [oaiCall("a", "x", "{}")] }, "content_filter"))).code).toBe("TRUNCATED_TOOL_CALL");
  });
  it("finish_reason=tool_calls بدونِ فراخوانی ⇒ BAD_RESPONSE", () => {
    expect(errOf(decodeToolReply("openai-chat", oaiReply({ content: "x" }, "tool_calls"))).code).toBe("BAD_RESPONSE");
    expect(errOf(decodeToolReply("openai-chat", oaiReply({ content: "x", tool_calls: [] }, "tool_calls"))).code).toBe("BAD_RESPONSE");
  });
  it("refusal ⇒ content_filter (مگر بریده)", () => {
    expect(must(decodeToolReply("openai-chat", oaiReply({ content: null, refusal: "نه" }))).finish).toBe("content_filter");
    expect(must(decodeToolReply("openai-chat", oaiReply({ content: null, refusal: "نه" }, "length"))).finish).toBe("length");
    expect(must(decodeToolReply("openai-chat", oaiReply({ content: "x", refusal: null }))).finish).toBe("stop");
  });
  const badReplies: [string, unknown][] = [
    ["شیء نیست", "x"],
    ["null", null],
    ["آرایه", []],
    ["choices تهی", oaiReply({}, "stop", { choices: [] })],
    ["دو choice", oaiReply({}, "stop", { choices: [oaiReply({}).choices[0], oaiReply({}).choices[0]] })],
    ["بدونِ message", oaiReply({}, "stop", { choices: [{ finish_reason: "stop" }] })],
    ["role نادرست", oaiReply({ role: "user", content: "x" })],
    ["content عدد", oaiReply({ content: 5 })],
    ["content با NUL", oaiReply({ content: "a\u0000" })],
    ["refusal عدد", oaiReply({ content: "x", refusal: 3 })],
    ["tool_calls آرایه نیست", oaiReply({ tool_calls: "x" }, "tool_calls")],
    ["بیش از ۱۶ فراخوانی", oaiReply({ tool_calls: Array.from({ length: 17 }, (_, i) => oaiCall(`c${i}`, "t", "{}")) }, "tool_calls")],
    ["نوعِ غیرِ function", oaiReply({ tool_calls: [{ ...oaiCall("a", "t", "{}"), type: "custom" }] }, "tool_calls")],
    ["بدونِ function", oaiReply({ tool_calls: [{ id: "a", type: "function" }] }, "tool_calls")],
    ["id تکراری", oaiReply({ tool_calls: [oaiCall("a", "t", "{}"), oaiCall("a", "t", "{}")] }, "tool_calls")],
    ["id نامعتبر", oaiReply({ tool_calls: [oaiCall("a b", "t", "{}")] }, "tool_calls")],
    ["بدونِ id", oaiReply({ tool_calls: [{ type: "function", function: { name: "t", arguments: "{}" } }] }, "tool_calls")],
    ["نامِ نامعتبر", oaiReply({ tool_calls: [oaiCall("a", "t t", "{}")] }, "tool_calls")],
    ["arguments شیء", oaiReply({ tool_calls: [oaiCall("a", "t", {})] }, "tool_calls")],
    ["arguments بلند", oaiReply({ tool_calls: [oaiCall("a", "t", "x".repeat(TOOL_LIMITS.maxArgumentChars + 1))] }, "tool_calls")],
    ["arguments با NUL", oaiReply({ tool_calls: [oaiCall("a", "t", "{\u0000}")] }, "tool_calls")],
    ["model عدد", oaiReply({ content: "x" }, "stop", { model: 3 })],
    ["model بلند", oaiReply({ content: "x" }, "stop", { model: "m".repeat(201) })],
  ];
  it.each(badReplies)("پاسخِ خراب: %s ⇒ BAD_RESPONSE", (_n, raw) => {
    const e = errOf(decodeToolReply("openai-chat", raw));
    expect(e.code).toBe("BAD_RESPONSE");
    expect(e.message.length).toBeLessThan(200);
    expect(e.issues.length).toBeLessThanOrEqual(10);
  });
  it("مصرفِ معتبر از پاسخِ خراب نجات داده می‌شود", () => {
    expect(errOf(decodeToolReply("openai-chat", oaiReply({ tool_calls: "x" }, "tool_calls"))).usage).toEqual({ inputTokens: 120, outputTokens: 30 });
  });
  it.each([
    ["نبودن", undefined],
    ["رشته‌ای", { prompt_tokens: "5", completion_tokens: 3 }],
    ["اعشاری", { prompt_tokens: 5.5, completion_tokens: 3 }],
    ["منفی", { prompt_tokens: -1, completion_tokens: 3 }],
    ["نیمه", { prompt_tokens: 5 }],
    ["بیش از ۱۰⁹", { prompt_tokens: 1_000_000_001, completion_tokens: 0 }],
    ["NaN", { prompt_tokens: Number.NaN, completion_tokens: 0 }],
  ])("مصرفِ %s ⇒ null (نه صفر)", (_n, usage) => {
    const raw = oaiReply({ content: "x" }, "stop", { usage });
    expect(must(decodeToolReply("openai-chat", raw)).usage).toBeNull();
  });
  it("مصرفِ صفر معتبر است و null نیست", () => {
    expect(must(decodeToolReply("openai-chat", oaiReply({ content: "x" }, "stop", { usage: { prompt_tokens: 0, completion_tokens: 0 } }))).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
  it("خروجی ژرف یخ‌زده است و به پاسخِ خام وصل نیست", () => {
    const raw = oaiReply({ tool_calls: [oaiCall("a", "t", "{}")] }, "tool_calls");
    const v = must(decodeToolReply("openai-chat", raw));
    expect(deepFrozen(v)).toBe(true);
    (raw.choices[0] as { message: { tool_calls: { id: string }[] } }).message.tool_calls[0]!.id = "mutated";
    expect(v.toolCalls[0]?.id).toBe("a");
  });
});

const antReply = (content: unknown, stop: unknown = "end_turn", extra: Record<string, unknown> = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-x-2026",
  content,
  stop_reason: stop,
  usage: { input_tokens: 200, output_tokens: 40 },
  ...extra,
});
const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });

describe("decodeToolReply · Anthropic", () => {
  it("متنِ ساده", () => {
    expect(must(decodeToolReply("anthropic-messages", antReply([{ type: "text", text: "سلام" }])))).toEqual({
      text: "سلام",
      toolCalls: [],
      finish: "stop",
      usage: { inputTokens: 200, outputTokens: 40 },
      servedModel: "claude-x-2026",
      assistantMessage: { role: "assistant", content: [{ type: "text", text: "سلام" }] },
    });
  });
  it("متن + tool_use: آرگومان رشتهٔ JSON می‌شود و بلوک‌ها به ترتیب برمی‌گردند", () => {
    const v = must(decodeToolReply("anthropic-messages", antReply([{ type: "text", text: "می‌سنجم" }, use("toolu_01", "court_fee", { amountRials: 5, kind: "a" })], "tool_use")));
    expect(v.finish).toBe("tool_calls");
    expect(v.toolCalls).toEqual([{ id: "toolu_01", name: "court_fee", argumentsJson: '{"amountRials":5,"kind":"a"}' }]);
    expect(v.assistantMessage).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "می‌سنجم" }, { type: "tool_use", id: "toolu_01", name: "court_fee", input: { amountRials: 5, kind: "a" } }],
    });
  });
  it("چند tool_use و بلوکِ متنیِ تهی (در بازگشت نمی‌آید)", () => {
    const v = must(decodeToolReply("anthropic-messages", antReply([{ type: "text", text: "" }, use("a", "x", {}), use("b", "y", { k: 1 })], "tool_use")));
    expect(v.toolCalls.map((c) => c.id)).toEqual(["a", "b"]);
    expect((v.assistantMessage as { content: unknown[] }).content).toHaveLength(2);
  });
  it("چند بلوکِ متن به هم می‌چسبند", () => {
    expect(must(decodeToolReply("anthropic-messages", antReply([{ type: "text", text: "الف" }, { type: "text", text: "ب" }]))).text).toBe("الفب");
  });
  it.each([
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["max_tokens", "length"],
    ["refusal", "content_filter"],
    ["pause_turn", "other"],
    ["new_reason", "other"],
    [null, "other"],
  ])("stop_reason=%j ⇒ %s", (sr, want) => {
    expect(must(decodeToolReply("anthropic-messages", antReply([{ type: "text", text: "x" }], sr))).finish).toBe(want);
  });
  it("max_tokens همراهِ tool_use ⇒ TRUNCATED_TOOL_CALL با مصرف", () => {
    const e = errOf(decodeToolReply("anthropic-messages", antReply([use("a", "x", { amount: 1 })], "max_tokens")));
    expect(e.code).toBe("TRUNCATED_TOOL_CALL");
    expect(e.usage).toEqual({ inputTokens: 200, outputTokens: 40 });
  });
  it("stop_reason=tool_use بدونِ بلوکِ tool_use ⇒ BAD_RESPONSE", () => {
    expect(errOf(decodeToolReply("anthropic-messages", antReply([{ type: "text", text: "x" }], "tool_use"))).code).toBe("BAD_RESPONSE");
  });
  const bad: [string, unknown][] = [
    ["شیء نیست", 5],
    ["content آرایه نیست", antReply("x")],
    ["بیش از ۶۴ بلوک", antReply(Array.from({ length: 65 }, () => ({ type: "text", text: "x" })))],
    ["بلوکِ thinking", antReply([{ type: "thinking", thinking: "…", signature: "s" }, { type: "text", text: "x" }])],
    ["بلوکِ ناشناخته", antReply([{ type: "server_tool_use", id: "a", name: "x", input: {} }])],
    ["بلوک شیء نیست", antReply([null])],
    ["text عدد", antReply([{ type: "text", text: 5 }])],
    ["text با NUL", antReply([{ type: "text", text: "a\u0000" }])],
    ["input آرایه", antReply([use("a", "x", [])], "tool_use")],
    ["input رشته", antReply([use("a", "x", "{}")], "tool_use")],
    ["input با NaN", antReply([use("a", "x", { n: Number.NaN })], "tool_use")],
    ["input با undefined", antReply([use("a", "x", { n: undefined })], "tool_use")],
    ["input با __proto__", antReply([use("a", "x", JSON.parse('{"__proto__":{"a":1}}'))], "tool_use")],
    ["input بزرگ", antReply([use("a", "x", { s: "x".repeat(TOOL_LIMITS.maxArgumentChars + 1) })], "tool_use")],
    ["id تکراری", antReply([use("a", "x", {}), use("a", "x", {})], "tool_use")],
    ["id نامعتبر", antReply([use("a b", "x", {})], "tool_use")],
    ["نامِ نامعتبر", antReply([use("a", "x y", {})], "tool_use")],
    ["type نادرست", antReply([{ type: "text", text: "x" }], "end_turn", { type: "error" })],
    ["role نادرست", antReply([{ type: "text", text: "x" }], "end_turn", { role: "user" })],
    ["model عدد", antReply([{ type: "text", text: "x" }], "end_turn", { model: 1 })],
  ];
  it.each(bad)("پاسخِ خراب: %s ⇒ BAD_RESPONSE", (_n, raw) => {
    const e = errOf(decodeToolReply("anthropic-messages", raw));
    expect(e.code).toBe("BAD_RESPONSE");
    expect(e.message.length).toBeLessThan(200);
  });
  it("مسیرِ گزارش نامِ کلیدهای مدل را بازتاب نمی‌دهد", () => {
    const e = errOf(decodeToolReply("anthropic-messages", antReply([use("a", "x", { CANARY_KEY: { v: Number.NaN } })], "tool_use")));
    expect(JSON.stringify(e)).not.toContain("CANARY");
  });
  it("مصرف: کشِ ناصفر ⇒ null (نه کمتر از واقع)؛ کشِ صفر یا نبودنش مشکلی ندارد", () => {
    const withUsage = (usage: unknown) => antReply([{ type: "text", text: "x" }], "end_turn", { usage });
    const u = (extra: Record<string, unknown>) => must(decodeToolReply("anthropic-messages", withUsage({ input_tokens: 10, output_tokens: 5, ...extra }))).usage;
    expect(u({})).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(u({ cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } })).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(u({ cache_read_input_tokens: 7 })).toBeNull();
    expect(u({ cache_creation_input_tokens: 7 })).toBeNull();
    expect(u({ cache_creation: { ephemeral_5m_input_tokens: 3 } })).toBeNull();
    expect(u({ cache_creation: "x" })).toBeNull();
  });
  it("مصرفِ ناقص/نامعتبر ⇒ null", () => {
    for (const usage of [undefined, { input_tokens: 1 }, { input_tokens: "1", output_tokens: 1 }, { input_tokens: 1.5, output_tokens: 1 }, { prompt_tokens: 1, completion_tokens: 1 }]) {
      expect(must(decodeToolReply("anthropic-messages", antReply([{ type: "text", text: "x" }], "end_turn", { usage }))).usage).toBeNull();
    }
  });
  it("خروجی ژرف یخ‌زده و مستقل از پاسخِ خام", () => {
    const input = { amountRials: 5 };
    const v = must(decodeToolReply("anthropic-messages", antReply([use("a", "x", input)], "tool_use")));
    expect(deepFrozen(v)).toBe(true);
    input.amountRials = 999;
    expect(v.toolCalls[0]?.argumentsJson).toBe('{"amountRials":5}');
    expect(JSON.stringify(v.assistantMessage)).not.toContain("999");
  });
});

describe("decodeToolReply · عمومی", () => {
  it("قالبِ ناشناخته و Proxyِ بدجنس بی‌پرتاب‌اند", () => {
    expect(errOf(decodeToolReply("gemini", {})).code).toBe("BAD_RESPONSE");
    const trap = new Proxy({}, { get() { throw new Error("boom"); }, ownKeys() { throw new Error("boom"); }, getPrototypeOf() { throw new Error("boom"); } });
    for (const f of ["openai-chat", "anthropic-messages"] as const) expect(errOf(decodeToolReply(f, trap)).code).toBe("BAD_RESPONSE");
  });
  it("رفت‌وبرگشت: فراخوانی‌های رمزگشایی‌شده مستقیم به encodeToolResults می‌روند", () => {
    const o = must(decodeToolReply("openai-chat", oaiReply({ tool_calls: [oaiCall("a", "x", "{}"), oaiCall("b", "y", "{}")] }, "tool_calls")));
    expect(encodeToolResults("openai-chat", o.toolCalls, [{ id: "a", content: "1" }, { id: "b", content: "2" }]).ok).toBe(true);
    const a = must(decodeToolReply("anthropic-messages", antReply([use("a", "x", {}), use("b", "y", {})], "tool_use")));
    expect(encodeToolResults("anthropic-messages", a.toolCalls, [{ id: "a", content: "1" }, { id: "b", content: "2" }]).ok).toBe(true);
  });
});

describe("پیامِ دقیقِ ردها (جهش‌های هم‌ارز را می‌کُشد)", () => {
  it("نتیجهٔ گم‌شده با پیامِ خودش گزارش می‌شود، نه با خطای داخلی", () => {
    const e = errOf(encodeToolResults("openai-chat", [{ id: "a", name: "t", argumentsJson: "{}" }], []));
    expect(e.issues).toEqual(["برای دست‌کم یک فراخوانی نتیجه‌ای داده نشده است."]);
  });
  it("چرخه در شما «ارجاعِ چرخه‌ای» گزارش می‌شود، نه بیش‌ازحد تو‌در‌تو", () => {
    const cyc: Record<string, unknown> = { type: "object" };
    cyc["self"] = cyc;
    const e = errOf(encodeTools("openai-chat", [{ ...SPEC, parameters: cyc }]));
    expect(e.issues.some((i) => i.includes("چرخه"))).toBe(true);
    expect(e.issues.some((i) => i.includes("سطح"))).toBe(false);
  });
  it("شمای مشترک (DAG نه چرخه) رد نمی‌شود", () => {
    const shared = { type: "string" };
    expect(encodeTools("openai-chat", [{ ...SPEC, parameters: { type: "object", properties: { a: shared, b: shared } } }]).ok).toBe(true);
  });
});
