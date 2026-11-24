import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpToolProvider } from "@/modules/ai-provider-http";
import { createToolGateway, sumStepSpend, type ToolWireFormat, type UsageEvent } from "@/modules/ai-gateway";
import { CALC_TOOLS, executeCalcToolJson } from "@/modules/calc-tools";
import { createToolLoop, type ToolLoopConfig } from "@/modules/tool-loop";
import { createToolRunner, type RunReport, type ToolExecutor } from "@/modules/tool-runner";

/**
 * «سرورِ HTTPِ واقعی ← fetch ← ai-provider-http ← ai-gateway ← tool-loop ← **tool-runner** ← calc-tools»، همه واقعی (ADR-0058).
 * فقط مدلِ پشتِ سرور شبیه‌سازی است (پاسخ‌های از پیش‌نوشته)؛ هیچ تماسِ اینترنتی/کلیدِ واقعی نیست.
 * ⚠ این اثباتِ «سیم‌کشیِ مجری» است، نه اثباتِ سازگاریِ ارائه‌دهنده (CT‑3c‑2).
 */
const FORMATS: readonly ToolWireFormat[] = ["openai-chat", "anthropic-messages"];
const PRICE = { currency: "IRR", inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000, version: "test-prices-v1" };
const GOOD = { date: { year: 1404, month: 6, day: 15 }, stage: "first-instance", claim: { kind: "known", amountRials: 100_000_000 } };

type Seen = { body: string; closedEarly: boolean };
type Handler = (req: IncomingMessage, res: ServerResponse, seen: Seen) => void;
let server: Server;
let base = "";
let seen: Seen[] = [];
let queue: Handler[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    const rec: Seen = { body: "", closedEarly: false };
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
      } else h(req, res, rec);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  seen = [];
  queue = [];
});

const reply = (body: unknown): Handler => (_q, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const hang: Handler = () => {};

const toolReply = (format: ToolWireFormat, id: string, name: string, args: unknown): unknown =>
  format === "openai-chat"
    ? { model: "served", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }
    : { type: "message", role: "assistant", model: "served", stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input: args }], usage: { input_tokens: 1000, output_tokens: 200 } };
const textReply = (format: ToolWireFormat, text: string): unknown =>
  format === "openai-chat"
    ? { model: "served", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }], usage: { prompt_tokens: 500, completion_tokens: 60 } }
    : { type: "message", role: "assistant", model: "served", stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 500, output_tokens: 60 } };

/** پورتِ ابزارِ آزمون: calc-tools واقعی (همان نگاشتی که ریشهٔ ترکیبِ آینده می‌نویسد). */
const calcExecutor: ToolExecutor = (c) => {
  const r = executeCalcToolJson(c.name, c.argumentsJson);
  return r.ok
    ? { ok: true, content: JSON.stringify({ result: r.value.result, review: r.value.review, notes: r.value.notes }), reviewPending: r.value.reviewPending }
    : { ok: false, content: JSON.stringify({ error: r.error }) };
};

function rig(format: ToolWireFormat, over: Partial<{ executeTool: ToolExecutor; totalTimeoutMs: number; toolTimeoutMs: number; loop: Partial<ToolLoopConfig> }> = {}) {
  const events: UsageEvent[] = [];
  const p = createHttpToolProvider({ format, endpoint: `${base}${format === "openai-chat" ? "/v1/chat/completions" : "/v1/messages"}`, getApiKey: () => "sk-e2e-KEY-987", fetch: globalThis.fetch, allowInsecureLoopback: true });
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
  const l = createToolLoop({ maxSteps: 5, maxToolCalls: 6, maxIdenticalCalls: 2, truncationRetries: 1, budget: { kind: "none" }, ...over.loop });
  if (!l.ok) throw new Error(JSON.stringify(l.error));
  const r = createToolRunner({ gateway: g.value, loop: l.value, executeTool: over.executeTool ?? calcExecutor, totalTimeoutMs: over.totalTimeoutMs ?? 10_000, toolTimeoutMs: over.toolTimeoutMs ?? 2_000, maxResultChars: 20_000 });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return { runner: r.value, events };
}
const INPUT = { model: "legal", messages: [{ role: "user", content: "هزینهٔ دادرسی دعوای ۱۰۰ میلیون ریالی؟" }], maxOutputTokens: 500, tools: CALC_TOOLS };
const ok = async (p: Promise<{ ok: true; value: RunReport } | { ok: false; error: unknown }>): Promise<RunReport> => {
  const r = await p;
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("tool-runner ⇄ HTTP واقعی ⇄ calc-tools واقعی", () => {
  it.each(FORMATS)("%s: حلقهٔ دو‌گامی؛ ابزارِ واقعی اجرا؛ هزینهٔ حلقه = جمعِ رویدادهای مصرف؛ reviewPending از calc-tools", async (format) => {
    queue.push(reply(toolReply(format, "call_1", "court_fee", GOOD)), reply(textReply(format, "هزینهٔ دادرسی محاسبه شد.")));
    const { runner, events } = rig(format);
    const out = await ok(runner.run(INPUT));
    expect(out.outcome).toMatchObject({ status: "answered", text: "هزینهٔ دادرسی محاسبه شد.", steps: 2, toolCalls: 1, reviewPending: true });
    expect(out.abortedBy).toBeNull();
    expect(out.toolRuns).toEqual([{ id: "call_1", name: "court_fee", status: "ok", code: null, reviewPending: true }]);
    expect(out.outcome.spend).toEqual(sumStepSpend(events));
    // ⌈(1000×3e6+200×15e6)/1e6⌉ = 6000 ؛ ⌈(500×3e6+60×15e6)/1e6⌉ = 2400
    expect(out.outcome.spend.cost).toEqual([{ currency: "IRR", priceVersion: "test-prices-v1", micros: 8400 }]);
    // پیامِ دومِ سرور شاملِ نتیجهٔ ابزارِ واقعی است
    expect(seen).toHaveLength(2);
    expect(seen[1]!.body).toContain("call_1");
    expect(seen[1]!.body).toContain("result");
    expect(JSON.stringify(out)).not.toContain("sk-e2e-KEY-987");
  });

  it.each(FORMATS)("%s: آرگومانِ نادرستِ مدل ⇒ خطای ابزار به مدل؛ مدل اصلاح می‌کند و پاسخ می‌دهد", async (format) => {
    queue.push(reply(toolReply(format, "call_1", "court_fee", { ...GOOD, claim: { kind: "known", amountRials: "صد" } })), reply(textReply(format, "اصلاح شد.")));
    const { runner } = rig(format);
    const out = await ok(runner.run(INPUT));
    expect(out.outcome).toMatchObject({ status: "answered", toolCalls: 1, reviewPending: false });
    expect(out.toolRuns[0]).toMatchObject({ status: "error", code: "TOOL_REPORTED_ERROR" });
  });

  it.each(FORMATS)("%s: مدل ابزارِ بیرون از فهرست می‌خواهد ⇒ هرگز اجرا نمی‌شود", async (format) => {
    queue.push(reply(toolReply(format, "call_1", "delete_everything", {})), reply(textReply(format, "باشد.")));
    let ran = 0;
    const { runner } = rig(format, { executeTool: () => (ran++, { ok: true, content: "x", reviewPending: false }) });
    const out = await ok(runner.run(INPUT));
    expect(ran).toBe(0);
    expect(out.toolRuns[0]).toMatchObject({ name: "delete_everything", code: "UNKNOWN_TOOL" });
    expect(out.outcome.status).toBe("answered");
  });

  it.each(FORMATS)("%s: ابزارِ کند (فراتر از مهلتِ ابزار) ⇒ TOOL_TIMEOUT؛ حلقه ادامه می‌دهد", async (format) => {
    queue.push(reply(toolReply(format, "call_1", "court_fee", GOOD)), reply(textReply(format, "پس از خطا.")));
    const slow: ToolExecutor = () => new Promise(() => {});
    const { runner } = rig(format, { executeTool: slow, toolTimeoutMs: 60 });
    const out = await ok(runner.run(INPUT));
    expect(out.toolRuns[0]).toMatchObject({ code: "TOOL_TIMEOUT" });
    expect(out.outcome).toMatchObject({ status: "answered", text: "پس از خطا." });
  });

  it.each(FORMATS)("%s: لغوِ فراخواننده حینِ پاسخِ معلقِ سرور ⇒ اتصالِ واقعی بسته می‌شود؛ هزینهٔ گام «نامعلوم»", async (format) => {
    queue.push(hang);
    const { runner } = rig(format);
    const ac = new AbortController();
    const p = ok(runner.run(INPUT, { signal: ac.signal }));
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    const out = await p;
    expect(out.abortedBy).toBe("caller");
    expect(out.outcome).toMatchObject({ status: "stopped", reason: "STEP_FAILED", errorCode: "ABORTED" });
    expect(out.outcome.spend.complete).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen[0]!.closedEarly).toBe(true);
  });

  it("مهلتِ کلِ اجرا با تایمرِ واقعی ⇒ بسته می‌شود و اتصال قطع می‌شود", async () => {
    queue.push(hang);
    const { runner } = rig("openai-chat", { totalTimeoutMs: 1000 });
    const t0 = Date.now();
    const out = await ok(runner.run(INPUT));
    expect(out.abortedBy).toBe("deadline");
    expect(Date.now() - t0).toBeLessThan(4000);
    await new Promise((r) => setTimeout(r, 50));
    expect(seen[0]!.closedEarly).toBe(true);
  });

  it("مدلی که همان فراخوانی را تکرار می‌کند ⇒ REPEATED_CALL (سیاستِ tool-loop از راهِ مجری)", async () => {
    for (let i = 0; i < 5; i++) queue.push(reply(toolReply("openai-chat", `call_${i}`, "court_fee", GOOD)));
    const { runner } = rig("openai-chat", { loop: { maxIdenticalCalls: 2 } });
    const out = await ok(runner.run(INPUT));
    expect(out.outcome).toMatchObject({ status: "stopped", reason: "REPEATED_CALL" });
    expect(out.toolRuns).toHaveLength(2);
    expect(seen).toHaveLength(3);
  });
});
