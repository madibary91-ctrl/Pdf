import { describe, expect, it } from "vitest";
import { encodeToolResults } from "@/modules/ai-gateway";
import { buildHeaders, buildRequestBody } from "./body";
import { KEY, SPEC, makeCall, must } from "./test-kit";

describe("buildRequestBody · OpenAI", () => {
  it("شکلِ دقیقِ بدنه", () => {
    const b = buildRequestBody("openai-chat", makeCall("openai-chat"));
    expect(b).toEqual({
      tools: [{ type: "function", function: { name: SPEC.name, description: SPEC.description, parameters: SPEC.parameters } }],
      tool_choice: "auto",
      parallel_tool_calls: false,
      model: "provider-model-1",
      messages: [{ role: "user", content: "سلام" }],
      max_tokens: 100,
      temperature: 0,
      stream: false,
    });
  });
  it("max_completion_tokens وقتی خواسته شود؛ و max_tokens حذف می‌شود", () => {
    const b = buildRequestBody("openai-chat", makeCall("openai-chat"), "max_completion_tokens");
    expect(b["max_completion_tokens"]).toBe(100);
    expect("max_tokens" in b).toBe(false);
  });
  it("stop فقط با توقف‌دنباله‌ها می‌آید و کپی است", () => {
    const seqs = ["END", "STOP"];
    const b = buildRequestBody("openai-chat", makeCall("openai-chat", { stopSequences: seqs }));
    expect(b["stop"]).toEqual(["END", "STOP"]);
    expect(b["stop"]).not.toBe(seqs);
    expect("stop" in buildRequestBody("openai-chat", makeCall("openai-chat"))).toBe(false);
  });
  it("پیام‌های system در همان جایگاه می‌مانند و continuation پس از messages می‌آید", () => {
    const cont = must(encodeToolResults("openai-chat", [{ id: "c1" }], [{ id: "c1", content: "{}" }]));
    const assistant = { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "court_fee", arguments: "{}" } }] };
    const b = buildRequestBody(
      "openai-chat",
      makeCall("openai-chat", { messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }], continuation: [assistant, ...cont] }),
    );
    const msgs = b["messages"] as Array<Record<string, unknown>>;
    expect(msgs.map((m) => m["role"])).toEqual(["system", "user", "assistant", "tool"]);
    expect(msgs[2]).toBe(assistant);
  });
  it("دما و سقفِ توکن عیناً (بی‌اصلاح) می‌روند", () => {
    const b = buildRequestBody("openai-chat", makeCall("openai-chat", { temperature: 1.7, maxOutputTokens: 7 }));
    expect(b["temperature"]).toBe(1.7);
    expect(b["max_tokens"]).toBe(7);
  });
});

describe("buildRequestBody · Anthropic", () => {
  it("شکلِ دقیقِ بدنه؛ بی‌system کلیدِ system نمی‌آید", () => {
    const b = buildRequestBody("anthropic-messages", makeCall("anthropic-messages"));
    expect(b).toEqual({
      tools: [{ name: SPEC.name, description: SPEC.description, input_schema: SPEC.parameters }],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      model: "provider-model-1",
      messages: [{ role: "user", content: "سلام" }],
      max_tokens: 100,
      temperature: 0,
      stream: false,
    });
    expect("system" in b).toBe(false);
  });
  it("پیام‌های system از messages بیرون و به‌ترتیب با خطِ خالی در system جمع می‌شوند", () => {
    const b = buildRequestBody(
      "anthropic-messages",
      makeCall("anthropic-messages", { messages: [{ role: "system", content: "A" }, { role: "user", content: "U" }, { role: "assistant", content: "X" }, { role: "system", content: "B" }, { role: "user", content: "V" }] }),
    );
    expect(b["system"]).toBe("A\n\nB");
    expect((b["messages"] as Array<{ role: string }>).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
  it("stop_sequences و continuation", () => {
    const cont = must(encodeToolResults("anthropic-messages", [{ id: "t1" }], [{ id: "t1", content: "{}" }]));
    const a = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "court_fee", input: {} }] };
    const b = buildRequestBody("anthropic-messages", makeCall("anthropic-messages", { stopSequences: ["E"], continuation: [a, ...cont] }));
    expect(b["stop_sequences"]).toEqual(["E"]);
    expect("stop" in b).toBe(false);
    expect((b["messages"] as Array<{ role: string }>).map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
  it("openaiMaxTokensField روی Anthropic اثر ندارد", () => {
    const b = buildRequestBody("anthropic-messages", makeCall("anthropic-messages"), "max_completion_tokens");
    expect(b["max_tokens"]).toBe(100);
    expect("max_completion_tokens" in b).toBe(false);
  });
});

describe("buildRequestBody · فهرستِ مجازِ کلیدهای ابزار", () => {
  it.each(["openai-chat", "anthropic-messages"] as const)("کلیدِ بیگانه در call.tools نمی‌تواند model/stream/messages را بازنویسی کند (%s)", (format) => {
    const evil = { ...makeCall(format).tools, model: "evil", stream: true, messages: [], max_tokens: 9999, system: "evil", __proto__: { polluted: 1 } };
    const b = buildRequestBody(format, makeCall(format, { tools: evil }));
    expect(b["model"]).toBe("provider-model-1");
    expect(b["stream"]).toBe(false);
    expect(b["max_tokens"]).toBe(100);
    expect((b["messages"] as unknown[]).length).toBe(1);
    expect("system" in b).toBe(false);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
  it("parallel_tool_calls فقط برای OpenAI پاس داده می‌شود", () => {
    const o = buildRequestBody("openai-chat", makeCall("openai-chat", { tools: { ...makeCall("openai-chat").tools, parallel_tool_calls: true } }));
    expect(o["parallel_tool_calls"]).toBe(true);
    const a = buildRequestBody("anthropic-messages", makeCall("anthropic-messages", { tools: { ...makeCall("anthropic-messages").tools, parallel_tool_calls: true } }));
    expect("parallel_tool_calls" in a).toBe(false);
  });
  it("ورودی را تغییر نمی‌دهد و خروجی بدنهٔ JSON-پذیر و قطعی است", () => {
    const call = makeCall("openai-chat", { stopSequences: ["E"] });
    const before = JSON.stringify(call);
    const s1 = JSON.stringify(buildRequestBody("openai-chat", call));
    expect(JSON.stringify(call)).toBe(before);
    expect(JSON.stringify(buildRequestBody("openai-chat", call))).toBe(s1);
  });
});

describe("buildHeaders", () => {
  it("OpenAI: Bearer", () => {
    expect(buildHeaders("openai-chat", KEY, "2023-06-01")).toEqual({ "content-type": "application/json", accept: "application/json", authorization: `Bearer ${KEY}` });
  });
  it("Anthropic: x-api-key و anthropic-version (و بی‌authorization)", () => {
    const h = buildHeaders("anthropic-messages", KEY, "2024-10-22");
    expect(h).toEqual({ "content-type": "application/json", accept: "application/json", "x-api-key": KEY, "anthropic-version": "2024-10-22" });
    expect("authorization" in h).toBe(false);
  });
});
