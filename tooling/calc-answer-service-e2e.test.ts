import { describe, expect, it } from "vitest";
import { createHttpToolProvider } from "@/modules/ai-provider-http";
import { createToolGateway, type ToolWireFormat, type UsageEvent } from "@/modules/ai-gateway";
import { createCalcAnswerService, type CalcAnswerService } from "@/modules/calc-answer-service";
import { NOTICES } from "@/modules/calc-answer-cards";
import { CALC_TOOLS } from "@/modules/calc-tools";
import { COURT_FEE_TARIFFS } from "@/modules/legal-calc";
import { createToolLoop } from "@/modules/tool-loop";

/**
 * «fetchِ درون‌حافظه ← ai-provider-http ← ai-gateway ← tool-loop ← tool-runner ← calc-tool-executor ← calc-answer-cards ← **calc-answer-service**»، همه واقعی (ADR-0061).
 * فقط مدلِ پشتِ fetch شبیه‌سازی است؛ هیچ سوکت/تماسِ اینترنتی/کلیدِ واقعی نیست.
 */
const FORMATS: readonly ToolWireFormat[] = ["openai-chat", "anthropic-messages"];
const PRICE = { currency: "IRR", inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000, version: "test-prices-v1" };
const claim = (amountRials: number, year = 1404) => ({ date: { year, month: 6, day: 15 }, stage: "first-instance", claim: { kind: "known", amountRials } });
const USER = (content = "هزینهٔ دادرسی؟") => ({ messages: [{ role: "user", content }] });

const toolReply = (format: ToolWireFormat, id: string, args: unknown): unknown =>
  format === "openai-chat"
    ? { model: "served", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "court_fee", arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }
    : { type: "message", role: "assistant", model: "served", stop_reason: "tool_use", content: [{ type: "tool_use", id, name: "court_fee", input: args }], usage: { input_tokens: 1000, output_tokens: 200 } };
const textReply = (format: ToolWireFormat, text: string): unknown =>
  format === "openai-chat"
    ? { model: "served", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }], usage: { prompt_tokens: 500, completion_tokens: 60 } }
    : { type: "message", role: "assistant", model: "served", stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 500, output_tokens: 60 } };

type Responder = (body: string, index: number) => Response | Promise<Response>;
const json = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

function build(format: ToolWireFormat, responder: Responder, over: Record<string, unknown> = {}) {
  const bodies: string[] = [];
  const headers: Record<string, string>[] = [];
  const events: UsageEvent[] = [];
  const fetchFn = (_url: string, init: { body: string; headers?: Record<string, string> }) => {
    bodies.push(init.body);
    headers.push(init.headers ?? {});
    return Promise.resolve(responder(init.body, bodies.length - 1));
  };
  const p = createHttpToolProvider({ format, endpoint: `https://models.example.invalid/${format}`, getApiKey: () => "sk-svc-KEY-555", fetch: fetchFn as never });
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
  const l = createToolLoop({ maxSteps: 5, maxToolCalls: 6, maxIdenticalCalls: 2, truncationRetries: 1, budget: { kind: "none" } });
  if (!l.ok) throw new Error(JSON.stringify(l.error));
  const s = createCalcAnswerService({ gateway: g.value, loop: l.value, model: "legal", maxOutputTokens: 500, maxCards: 6, totalTimeoutMs: 10_000, toolTimeoutMs: 2_000, maxResultChars: 20_000, ...over });
  if (!s.ok) throw new Error(JSON.stringify(s.error));
  const service: CalcAnswerService = s.value;
  return { service, bodies, headers, events };
}
const seq = (format: ToolWireFormat, replies: readonly unknown[]): Responder => (_b, i) => (replies[i] === undefined ? new Response("", { status: 599 }) : json(replies[i]));

describe("calc-answer-service ⇄ زنجیرهٔ کامل (سرتاسری)", () => {
  it.each(FORMATS)("%s: مدل عددِ غلط نقل می‌کند؛ پاسخ شاملِ متنِ دست‌نخورده، کارتِ درست، هر دو اعلان و هزینه است", async (format) => {
    const { service } = build(format, seq(format, [toolReply(format, "call_1", claim(100_000_000)), textReply(format, "هزینهٔ دادرسی دقیقاً ۱ ریال است.")]));
    const r = await service.answer(USER());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = r.value.answer;
    expect(a.text).toBe("هزینهٔ دادرسی دقیقاً ۱ ریال است.");
    expect(a.cards).toHaveLength(1);
    expect(JSON.stringify(a.cards[0]!.result)).not.toContain("دقیقاً ۱ ریال");
    expect(a.cards[0]!.notes.length).toBeGreaterThan(0);
    expect(a.reviewPending).toBe(true);
    expect(a.notices).toEqual([NOTICES.reviewPending, NOTICES.cardPrecedence]);
    expect(r.value.spend).toMatchObject({ steps: 2, complete: true });
  });

  it.each(FORMATS)("%s: هزینهٔ سرویس دقیقاً برابرِ جمعِ رویدادهای مصرفِ دروازه است (پایهٔ اتصال به metering)", async (format) => {
    const { service, events } = build(format, seq(format, [toolReply(format, "call_1", claim(100_000_000)), textReply(format, "تمام")]));
    const r = await service.answer(USER());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(events.length).toBe(2);
    const sumMicros = events.reduce((n, e) => n + ((e as unknown as { cost: { micros: number } | null }).cost?.micros ?? 0), 0);
    expect(r.value.spend.cost).toHaveLength(1);
    expect(r.value.spend.cost[0]!.micros).toBe(sumMicros);
    expect(r.value.spend.cost[0]).toMatchObject({ currency: "IRR", priceVersion: "test-prices-v1" });
    expect(r.value.spend.usage.inputTokens).toBe(1500);
    expect(r.value.spend.usage.outputTokens).toBe(260);
  });

  it.each(FORMATS)("%s: جدولِ تزریقیِ legally-verified ⇒ بی‌اعلانِ تأییدنشدگی", async (format) => {
    const base = COURT_FEE_TARIFFS.find((t) => t.year === 1405);
    if (!base) throw new Error("جدول ۱۴۰۵ نیست");
    const verified = { ...base, review: { status: "legally-verified" as const, reviewedBy: "آزمون", reviewedOn: "1405-01-01" } };
    const { service } = build(format, seq(format, [toolReply(format, "call_1", claim(100_000_000, 1405)), textReply(format, "تمام.")]), { deps: { courtFeeTariffs: [verified] } });
    const r = await service.answer(USER());
    expect(r.ok && r.value.answer.reviewPending).toBe(false);
    expect(r.ok && r.value.answer.notices).toEqual([NOTICES.cardPrecedence]);
  });

  it.each(FORMATS)("%s: فهرستِ مجازِ ابزار و مدل را فقط سرویس می‌گذارد؛ کلیدِ API فقط در سرآیند است و در هیچ خروجی/بدنه‌ای نیست", async (format) => {
    const { service, bodies, headers } = build(format, seq(format, [textReply(format, "سلام")]));
    const r = await service.answer({ messages: [{ role: "user", content: "سلام" }] });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain("sk-svc-KEY-555");
    expect(bodies[0]).not.toContain("sk-svc-KEY-555");
    expect(JSON.stringify(headers[0])).toContain("sk-svc-KEY-555");
    for (const t of CALC_TOOLS) expect(bodies[0]).toContain(t.name);
    expect(bodies[0]).toContain("served-model-x");
  });

  it.each(FORMATS)("%s: فراخواننده نمی‌تواند ابزار/مدل را عوض کند ⇒ INVALID_INPUT و بدونِ هیچ تماسِ شبکه", async (format) => {
    const { service, bodies } = build(format, seq(format, [textReply(format, "x")]));
    const r = await service.answer({ ...USER(), tools: [{ name: "evil", description: "d", parameters: { type: "object" } }], model: "expensive" });
    expect(!r.ok && r.error.code).toBe("INVALID_INPUT");
    expect(bodies).toHaveLength(0);
  });

  it.each(FORMATS)("%s: اجراهای هم‌زمانِ یک سرویس (با تأخیرهای وارونه) کارت و هزینه را قاطی نمی‌کنند", async (format) => {
    const amounts: Record<string, number> = { a: 100_000_000, b: 200_000_000, c: 150_000_000 };
    const who = (body: string): string => (["a", "b", "c"].find((w) => body.includes(`«${w}»`)) ?? "?");
    const responder: Responder = async (body) => {
      const w = who(body);
      await new Promise((res) => setTimeout(res, w === "a" ? 20 : w === "b" ? 8 : 1));
      const isSecond = body.includes("call_" + w) || body.includes("tool_result") || body.includes('"role":"tool"');
      return json(isSecond ? textReply(format, `پاسخِ ${w}`) : toolReply(format, `call_${w}`, claim(amounts[w]!)));
    };
    const { service } = build(format, responder);
    const ws = ["a", "b", "c"];
    const rs = await Promise.all(ws.map((w) => service.answer(USER(`پرسشِ «${w}»`))));
    rs.forEach((r, i) => {
      const w = ws[i]!;
      expect(r.ok, w).toBe(true);
      if (!r.ok) return;
      expect(r.value.answer.text).toBe(`پاسخِ ${w}`);
      expect(r.value.answer.cards.map((c) => c.callId)).toEqual([`call_${w}`]);
      expect(JSON.stringify(r.value.answer.cards[0]!.result)).toContain(String(amounts[w]));
    });
  });

  it.each(FORMATS)("%s: خطای HTTP از ارائه‌دهنده ⇒ پاسخِ stopped بی‌متن؛ هیچ متنِ پاسخِ خطا نشت نمی‌کند", async (format) => {
    const { service } = build(format, () => new Response("sk-LEAK-upstream-body", { status: 500 }));
    const r = await service.answer(USER());
    expect(r.ok && r.value.answer).toMatchObject({ status: "stopped", text: null });
    expect(JSON.stringify(r)).not.toContain("sk-LEAK-upstream-body");
  });

  it.each(FORMATS)("%s: نتیجهٔ بزرگ‌تر از سقف ⇒ کارت نمایش داده نمی‌شود و در droppedCards می‌آید", async (format) => {
    const { service } = build(format, seq(format, [toolReply(format, "call_1", claim(100_000_000)), textReply(format, "نتیجه‌ای نشد.")]), { maxResultChars: 64 });
    const r = await service.answer(USER());
    expect(r.ok && r.value.answer).toMatchObject({ cards: [], droppedCards: 1, text: "نتیجه‌ای نشد." });
  });

  it.each(FORMATS)("%s: لغوِ فراخواننده در میانهٔ تماس ⇒ stopped/abortedBy=caller و هزینه و کارت‌های پیشین حفظ می‌شود", async (format) => {
    const ac = new AbortController();
    const responder: Responder = (_b, i) => (i === 0 ? json(toolReply(format, "call_1", claim(100_000_000))) : new Promise<Response>(() => { ac.abort(); }));
    const { service } = build(format, responder);
    const r = await service.answer(USER(), { signal: ac.signal });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.answer).toMatchObject({ status: "stopped", text: null, abortedBy: "caller" });
    expect(r.value.answer.cards.map((c) => c.callId)).toEqual(["call_1"]);
    expect(r.value.spend.steps).toBeGreaterThanOrEqual(1);
  });
});
