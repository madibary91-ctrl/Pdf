/** ابزارِ مشترکِ آزمون‌های ai-provider-http (فقط آزمون‌ها import می‌کنند). هیچ تماسِ شبکه‌ای نیست؛ `fetch` شبیه‌سازی است. */
import { encodeTools } from "@/modules/ai-gateway";
import type { ToolProviderCall, ToolSpec, ToolWireFormat } from "@/modules/ai-gateway";
import type { FetchFn } from "./types";

export const SPEC: ToolSpec = {
  name: "court_fee",
  description: "هزینهٔ دادرسی را محاسبه می‌کند.",
  parameters: { type: "object", properties: { amountRials: { type: "integer" } }, required: ["amountRials"] },
};

/** کلیدِ ساختگیِ آزمون؛ آزمون‌های نشت دنبالِ همین رشته در همهٔ خروجی‌ها می‌گردند. */
export const KEY = "sk-TEST-KEY-do-not-leak-123456";

export function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`انتظار موفقیت: ${JSON.stringify(r.error)}`);
  return r.value;
}

export function makeCall(format: ToolWireFormat, over: Partial<Record<keyof ToolProviderCall, unknown>> = {}, signal: AbortSignal = new AbortController().signal): ToolProviderCall {
  const tools = must(encodeTools(format, [SPEC]));
  return Object.freeze({
    model: "provider-model-1",
    format,
    messages: [{ role: "user", content: "سلام" }],
    tools,
    continuation: [],
    maxOutputTokens: 100,
    temperature: 0,
    stopSequences: [],
    signal,
    ...over,
  }) as ToolProviderCall;
}

export type Recorded = Readonly<{ url: string; init: RequestInit }>;
export type FakeFetch = FetchFn & { calls: Recorded[] };

/** `fetch`ی که پاسخ‌های از پیش‌تعیین‌شده را به‌ترتیب می‌دهد؛ تابع ⇒ محاسبهٔ پویا؛ `Error` ⇒ رد. */
export function fakeFetch(...steps: ReadonlyArray<Response | Error | ((r: Recorded) => Response | Promise<Response>)>): FakeFetch {
  const calls: Recorded[] = [];
  let i = 0;
  const f = ((url: string, init: RequestInit) => {
    const rec = { url, init };
    calls.push(rec);
    const s = steps[Math.min(i++, steps.length - 1)];
    if (s === undefined) return Promise.reject(new Error("no step"));
    if (s instanceof Error) return Promise.reject(s);
    if (typeof s === "function") return Promise.resolve().then(() => s(rec));
    return Promise.resolve(s);
  }) as FakeFetch;
  f.calls = calls;
  return f;
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export const baseOptions = (format: ToolWireFormat, f: FetchFn, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  format,
  endpoint: format === "openai-chat" ? OPENAI_URL : ANTHROPIC_URL,
  getApiKey: () => KEY,
  fetch: f,
  ...over,
});
