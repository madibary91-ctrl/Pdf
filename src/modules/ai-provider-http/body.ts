/**
 * ساختِ بدنهٔ درخواست و سرایندها به قالبِ سیمِ هر ارائه‌دهنده. **خالص و قطعی** (بی‌I/O). ورودی همان `ToolProviderCall`ِ سنجیده‌شدهٔ
 * دروازه است؛ این‌جا چیزی «اصلاح» نمی‌شود (مثلاً دمای بیش از حدِ ارائه‌دهنده کم نمی‌شود): ارائه‌دهنده رد می‌کند و `PROVIDER_REJECTED` می‌شود.
 */
import type { ToolProviderCall, ToolWireFormat } from "@/modules/ai-gateway";
import type { OpenAiMaxTokensField } from "./types";

/** کلیدهایی که از `call.tools` (خروجیِ `encodeTools`) به بدنه می‌روند؛ هر چیزِ دیگر دور ریخته می‌شود تا ابزار نتواند `model`/`stream` را بازنویسی کند. */
const TOOL_KEYS: Readonly<Record<ToolWireFormat, readonly string[]>> = {
  "openai-chat": ["tools", "tool_choice", "parallel_tool_calls"],
  "anthropic-messages": ["tools", "tool_choice"],
};

function pickTools(format: ToolWireFormat, tools: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of TOOL_KEYS[format]) {
    if (Object.prototype.hasOwnProperty.call(tools, k)) out[k] = tools[k];
  }
  return out;
}

export function buildRequestBody(format: ToolWireFormat, call: ToolProviderCall, openaiMaxTokensField: OpenAiMaxTokensField = "max_tokens"): Record<string, unknown> {
  const tools = pickTools(format, call.tools);
  if (format === "openai-chat") {
    return {
      ...tools,
      model: call.model,
      messages: [...call.messages.map((m) => ({ role: m.role, content: m.content })), ...call.continuation],
      [openaiMaxTokensField]: call.maxOutputTokens,
      temperature: call.temperature,
      ...(call.stopSequences.length > 0 ? { stop: [...call.stopSequences] } : {}),
      stream: false,
    };
  }
  // Anthropic: پیام‌های system فقط در کلیدِ سطح‌بالای `system` می‌آیند (به‌ترتیب، با یک خط خالی).
  const system = call.messages.filter((m) => m.role === "system").map((m) => m.content);
  const rest = call.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
  return {
    ...tools,
    model: call.model,
    ...(system.length > 0 ? { system: system.join("\n\n") } : {}),
    messages: [...rest, ...call.continuation],
    max_tokens: call.maxOutputTokens,
    temperature: call.temperature,
    ...(call.stopSequences.length > 0 ? { stop_sequences: [...call.stopSequences] } : {}),
    stream: false,
  };
}

export function buildHeaders(format: ToolWireFormat, apiKey: string, anthropicVersion: string): Record<string, string> {
  const base = { "content-type": "application/json", accept: "application/json" };
  return format === "openai-chat" ? { ...base, authorization: `Bearer ${apiKey}` } : { ...base, "x-api-key": apiKey, "anthropic-version": anthropicVersion };
}
