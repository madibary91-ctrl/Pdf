import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpToolProvider } from "@/modules/ai-provider-http";
import {
  TRUNCATED_TOOL_CALL_ISSUE,
  createToolGateway,
  encodeToolResults,
  sumStepSpend,
  type ToolGateway,
  type ToolStepRequest,
  type ToolWireFormat,
  type UsageEvent,
} from "@/modules/ai-gateway";
import { CALC_TOOLS, executeCalcToolJson } from "@/modules/calc-tools";

/**
 * ai-gateway ⇄ ai-provider-http ⇄ **سرورِ HTTPِ واقعیِ loopback** (ADR-0057). `fetch` واقعیِ Node و `createToolGateway` واقعی؛ فقط مدلِ
 * پشتِ سرور شبیه‌سازی است (پاسخ‌های از پیش‌نوشته). هیچ تماسِ اینترنتی نیست؛ قراردادِ زندهٔ OpenAI/Anthropic (CT‑3c‑2) جداست و کلیدِ واقعی می‌خواهد.
 */
const KEY = "sk-INTEGRATION-KEY-must-not-leak-987";
const PRICE = { currency: "IRR", inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000, version: "test-prices-v1" };
const GOOD_ARGS = { date: { year: 1404, month: 6, day: 15 }, stage: "first-instance", claim: { kind: "known", amountRials: 100_000_000 } };
const FORMATS: readonly ToolWireFormat[] = ["openai-chat", "anthropic-messages"];

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string; closedEarly: boolean };
type Handler = (req: IncomingMessage, res: ServerResponse, seen: Seen) => void;

let server: Server;
let other: Server;
let base = "";
let otherBase = "";
let seen: Seen[] = [];
let otherHits = 0;
let queue: Handler[] = [];

const listen = (s: Server): Promise<string> => new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    const rec: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: "", closedEarly: false };
    seen.push(rec);
    res.on("close", () => {
      if (!res.writableEnded) rec.closedEarly = true;
    });
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      rec.body = Buffer.concat(chunks).toString("utf8");
      const h = queue.shift();
      if (h === undefined) {
        res.statusCode = 599;
        res.end();
        return;
      }
      h(req, res, rec);
    });
  });
  other = createServer((_req, res) => {
    otherHits++;
    res.end("{}");
  });
  base = await listen(server);
  otherBase = await listen(other);
});
afterAll(async () => {
  server.closeAllConnections();
  other.closeAllConnections();
  await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => other.close(r))]);
});
beforeEach(() => {
  seen = [];
  otherHits = 0;
  queue = [];
});

const reply = (status: number, body: unknown, headers: Record<string, string> = {}): Handler => (_q, res) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

const toolReply = (format: ToolWireFormat, id: string, args: unknown, rawArgs?: string, truncated = false): unknown =>
  format === "openai-chat"
    ? { model: "served", choices: [{ index: 0, finish_reason: truncated ? "length" : "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "court_fee", arguments: rawArgs ?? JSON.stringify(args) } }] } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }
    : { type: "message", role: "assistant", model: "served", stop_reason: truncated ? "max_tokens" : "tool_use", content: [{ type: "tool_use", id, name: "court_fee", input: truncated ? {} : args }], usage: { input_tokens: 1000, output_tokens: 200 } };
const textReply = (format: ToolWireFormat, text: string): unknown =>
  format === "openai-chat"
    ? { model: "served", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }], usage: { prompt_tokens: 500, completion_tokens: 60 } }
    : { type: "message", role: "assistant", model: "served", stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 500, output_tokens: 60 } };

function build(format: ToolWireFormat, extra: Record<string, unknown> = {}, path?: string) {
  const events: UsageEvent[] = [];
  const p = createHttpToolProvider({
    format,
    endpoint: `${base}${path ?? (format === "openai-chat" ? "/v1/chat/completions" : "/v1/messages")}`,
    getApiKey: () => KEY,
    fetch: globalThis.fetch,
    allowInsecureLoopback: true,
    ...extra,
  });
  if (!p.ok) throw new Error(JSON.stringify(p.error));
  const g = createToolGateway(
    {
      providers: { p: { complete: () => Promise.reject(new Error("unused")) } },
      models: { legal: { provider: "p", providerModel: "served-model-x", maxInputChars: 20_000, maxOutputTokens: 2048, price: PRICE } },
      clock: { nowMs: () => Date.now() },
      usageSink: { record: (e: UsageEvent) => void events.push(e) },
    },
    { models: { legal: { format, provider: p.value } } },
  );
  if (!g.ok) throw new Error(JSON.stringify(g.error));
  return { gw: g.value as ToolGateway, events };
}
const REQ: ToolStepRequest = { model: "legal", messages: [{ role: "system", content: "دستیار حقوقی" }, { role: "user", content: "هزینهٔ دادرسی دعوای ۱۰۰ میلیون ریالی؟" }], maxOutputTokens: 500, tools: CALC_TOOLS };

describe("حلقهٔ دو‌گامیِ کامل روی HTTP واقعی", () => {
  it.each(FORMATS)("%s: درخواستِ سیم درست، ابزارِ واقعی اجرا، نتیجه برگشت، پاسخِ نهایی؛ هزینهٔ دو گام جمع می‌شود", async (format) => {
    queue.push(reply(200, toolReply(format, "call_1", GOOD_ARGS)), reply(200, textReply(format, "هزینهٔ دادرسی محاسبه شد.")));
    const { gw, events } = build(format);

    const s1 = await gw.completeStep(REQ);
    expect(s1.ok).toBe(true);
    if (!s1.ok) return;
    expect(s1.value.finish).toBe("tool_calls");
    expect(s1.value.provider).toBe("p");

    const first = seen[0]!;
    expect(first.method).toBe("POST");
    expect(first.url).toBe(format === "openai-chat" ? "/v1/chat/completions" : "/v1/messages");
    expect(first.headers["content-type"]).toBe("application/json");
    if (format === "openai-chat") {
      expect(first.headers["authorization"]).toBe(`Bearer ${KEY}`);
      expect(first.headers["x-api-key"]).toBeUndefined();
    } else {
      expect(first.headers["x-api-key"]).toBe(KEY);
      expect(first.headers["anthropic-version"]).toBe("2023-06-01");
      expect(first.headers["authorization"]).toBeUndefined();
    }
    const b1 = JSON.parse(first.body) as Record<string, unknown>;
    expect(b1["model"]).toBe("served-model-x");
    expect(b1["stream"]).toBe(false);
    expect((b1["tools"] as unknown[]).length).toBe(CALC_TOOLS.length);
    if (format === "anthropic-messages") {
      expect(b1["system"]).toBe("دستیار حقوقی");
      expect((b1["messages"] as Array<{ role: string }>).map((m) => m.role)).toEqual(["user"]);
    } else {
      expect((b1["messages"] as Array<{ role: string }>).map((m) => m.role)).toEqual(["system", "user"]);
    }

    const results = s1.value.toolCalls.map((c) => {
      const r = executeCalcToolJson(c.name, c.argumentsJson);
      expect(r.ok).toBe(true);
      return { id: c.id, content: JSON.stringify(r.ok ? { result: r.value.result, reviewPending: r.value.reviewPending } : r), isError: !r.ok };
    });
    const enc = encodeToolResults(gw.toolFormat("legal"), s1.value.toolCalls, results);
    expect(enc.ok).toBe(true);
    if (!enc.ok) return;
    const s2 = await gw.completeStep({ ...REQ, continuation: [s1.value.assistantMessage, ...enc.value] });
    expect(s2.ok).toBe(true);
    if (!s2.ok) return;
    expect(s2.value.text).toBe("هزینهٔ دادرسی محاسبه شد.");
    expect(s2.value.finish).toBe("stop");

    const b2 = JSON.parse(seen[1]!.body) as { messages: Array<{ role: string }> };
    expect(b2.messages.map((m) => m.role)).toEqual(format === "openai-chat" ? ["system", "user", "assistant", "tool"] : ["user", "assistant", "user"]);

    expect(events).toHaveLength(2);
    const spend = sumStepSpend([s1.value, s2.value]);
    expect(spend.steps).toBe(2);
    expect(spend.complete).toBe(true);
    expect(spend.usage).toEqual({ inputTokens: 1500, outputTokens: 260, totalTokens: 1760 });
    expect(JSON.stringify([s1, s2, events])).not.toContain(KEY);
  });
});

describe("شکست‌های HTTP واقعی ⇒ کدهای دروازه", () => {
  const run = async (handler: Handler, format: ToolWireFormat = "openai-chat", extra: Record<string, unknown> = {}, req: ToolStepRequest = REQ) => {
    queue.push(handler);
    const { gw, events } = build(format, extra);
    const r = await gw.completeStep(req);
    if (r.ok) throw new Error("انتظار شکست");
    expect(JSON.stringify([r, events])).not.toContain(KEY);
    return { error: r.error, events };
  };

  it.each(FORMATS)("%s: ۴۲۹ با Retry-After ⇒ PROVIDER_RATE_LIMITED با retryAfterMs", async (format) => {
    const { error } = await run(reply(429, { error: { message: `quota ${KEY}` } }, { "retry-after": "3" }), format);
    expect(error.code).toBe("PROVIDER_RATE_LIMITED");
    expect(error.retryAfterMs).toBe(3000);
    expect(error.retryable).toBe(true);
    expect(JSON.stringify(error)).not.toContain("quota");
  });
  it("۴۰۱ ⇒ PROVIDER_AUTH؛ ۴۰۰ ⇒ PROVIDER_REJECTED؛ ۵۰۳ ⇒ PROVIDER_UNAVAILABLE", async () => {
    expect((await run(reply(401, {}))).error.code).toBe("PROVIDER_AUTH");
    expect((await run(reply(400, {}))).error.code).toBe("PROVIDER_REJECTED");
    expect((await run(reply(503, {}, { "retry-after-ms": "250" }))).error.retryAfterMs).toBe(250);
  });
  it("پاسخِ شکست‌خورده (حتی ۴xx) یک رویدادِ مصرفِ بی‌هزینه (usage=null) ثبت می‌کند", async () => {
    const { events } = await run(reply(500, {}));
    expect(events).toHaveLength(1);
    expect(events[0]!.usage).toBeNull();
  });
  it("بدنهٔ ۲۰۰ ولی نامعتبر (HTML/خراب/تهی) ⇒ PROVIDER_BAD_RESPONSE", async () => {
    for (const body of ["<html>login</html>", "{", ""]) {
      expect((await run((_q, res) => { res.writeHead(200); res.end(body); })).error.code).toBe("PROVIDER_BAD_RESPONSE");
    }
  });
  it("بدنهٔ بزرگ‌تر از سقف ⇒ PROVIDER_BAD_RESPONSE و اتصال زودتر بسته می‌شود", async () => {
    const { error } = await run(
      (_q, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"pad":"');
        const t = setInterval(() => {
          if (res.writableEnded || res.destroyed) return clearInterval(t);
          res.write("x".repeat(8192));
        }, 1);
        res.on("close", () => clearInterval(t));
      },
      "openai-chat",
      { maxResponseBytes: 4096 },
    );
    expect(error.code).toBe("PROVIDER_BAD_RESPONSE");
  });
  it.each(FORMATS)("%s: فراخوانیِ بریده ⇒ PROVIDER_BAD_RESPONSE با TRUNCATED_TOOL_CALL و هزینهٔ همان گام", async (format) => {
    const { error } = await run(reply(200, toolReply(format, "call_1", undefined, '{"date":', true)), format);
    expect(error.code).toBe("PROVIDER_BAD_RESPONSE");
    expect(error.issues?.[0]).toBe(TRUNCATED_TOOL_CALL_ISSUE);
    expect(error.usage).toEqual({ inputTokens: 1000, outputTokens: 200, totalTokens: 1200 });
  });
  it("۳۰۲ به میزبانِ دیگر دنبال نمی‌شود: کلید به آن‌جا نمی‌رسد", async () => {
    const { error } = await run((_q, res) => {
      res.writeHead(302, { location: `${otherBase}/steal` });
      res.end();
    });
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(otherHits).toBe(0);
    expect(seen).toHaveLength(1);
  });
  it.each(FORMATS)("%s: ۳۰۷ (بدنه و سرایندِ کلید را حفظ می‌کند) هم دنبال نمی‌شود", async (format) => {
    const { error } = await run((_q, res) => {
      res.writeHead(307, { location: `${otherBase}/steal` });
      res.end();
    }, format);
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(otherHits).toBe(0);
  });
  it("سرورِ خاموش (اتصال ردشده) ⇒ PROVIDER_UNAVAILABLE", async () => {
    const dead = createServer();
    const url = await listen(dead);
    await new Promise((r) => dead.close(r));
    const { gw } = build("openai-chat", { endpoint: `${url}/v1/chat/completions` });
    const r = await gw.completeStep(REQ);
    expect(!r.ok && r.error.code).toBe("PROVIDER_UNAVAILABLE");
  });
  it("قطعِ اتصال وسطِ بدنه ⇒ PROVIDER_UNAVAILABLE", async () => {
    const { error } = await run((_q, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write('{"a":');
      setTimeout(() => res.destroy(), 5);
    });
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
  });
});

describe("مهلت و لغو روی اتصالِ واقعی", () => {
  it("مهلتِ دروازه ⇒ TIMEOUT و درخواستِ HTTP واقعاً لغو می‌شود (سرور اتصالِ بسته می‌بیند)", async () => {
    queue.push(() => undefined);
    const { gw } = build("openai-chat");
    const r = await gw.completeStep({ ...REQ, timeoutMs: 100 });
    expect(!r.ok && r.error.code).toBe("TIMEOUT");
    await new Promise((res) => setTimeout(res, 100));
    expect(seen[0]!.closedEarly).toBe(true);
  });
  it("لغوِ فراخواننده ⇒ ABORTED و اتصال بسته می‌شود", async () => {
    queue.push(() => undefined);
    const { gw } = build("anthropic-messages");
    const ac = new AbortController();
    const p = gw.completeStep(REQ, { signal: ac.signal });
    await new Promise((res) => setTimeout(res, 50));
    ac.abort();
    const r = await p;
    expect(!r.ok && r.error.code).toBe("ABORTED");
    await new Promise((res) => setTimeout(res, 100));
    expect(seen[0]!.closedEarly).toBe(true);
  });
});
