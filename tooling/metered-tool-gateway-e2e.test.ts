import { describe, expect, it } from "vitest";
import { createToolGateway, type ToolWireFormat, type UsageEvent } from "@/modules/ai-gateway";
import { createHttpToolProvider } from "@/modules/ai-provider-http";
import { createCalcAnswerService } from "@/modules/calc-answer-service";
import { createLedger, createMemoryStore } from "@/modules/ledger";
import { createMeteredToolGateway } from "@/modules/metered-tool-gateway";
import { createToolLoop } from "@/modules/tool-loop";

/**
 * «fetchِ درون‌حافظه ← ai-provider-http ← ai-gateway ← **metered-tool-gateway (دفتر اعتبارِ واقعی)** ← tool-loop ← tool-runner ←
 * calc-tool-executor ← calc-answer-cards ← calc-answer-service»، همه واقعی (ADR-0062). فقط مدلِ پشتِ fetch شبیه‌سازی است.
 * قیمت‌ها ساختگیِ آزمون‌اند (۳ خرد/توکنِ ورودی، ۱۵ خرد/توکنِ خروجی).
 */
const FORMATS: readonly ToolWireFormat[] = ["openai-chat", "anthropic-messages"];
const PRICE = { currency: "IRR", inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000, version: "test-prices-v1" };
const MODELS = { legal: { price: PRICE, maxOutputTokens: 2048 } };
const TENANT = "tenant-e2e";
const ACCOUNT = "acct-e2e";
const KEY = "sk-svc-KEY-777";
const claim = (amountRials: number) => ({ date: { year: 1404, month: 6, day: 15 }, stage: "first-instance", claim: { kind: "known", amountRials } });
const USER = (content = "هزینهٔ دادرسی؟") => ({ messages: [{ role: "user", content }] });

const toolReply = (format: ToolWireFormat, id: string, args: unknown): unknown =>
  format === "openai-chat"
    ? { model: "served", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "court_fee", arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } }
    : { type: "message", role: "assistant", model: "served", stop_reason: "tool_use", content: [{ type: "tool_use", id, name: "court_fee", input: args }], usage: { input_tokens: 1000, output_tokens: 200 } };
const textReply = (format: ToolWireFormat, text: string): unknown =>
  format === "openai-chat"
    ? { model: "served", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }], usage: { prompt_tokens: 500, completion_tokens: 60 } }
    : { type: "message", role: "assistant", model: "served", stop_reason: "end_turn", content: [{ type: "text", text }], usage: { input_tokens: 500, output_tokens: 60 } };
const json = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
/** هزینهٔ دو گامِ نمونه: (۱۰۰۰×۳ + ۲۰۰×۱۵) + (۵۰۰×۳ + ۶۰×۱۵) = ۶۰۰۰ + ۲۴۰۰. */
const TWO_STEPS = 8400;

async function world(format: ToolWireFormat, funded: number, replies: readonly unknown[], over: { onUnknownCost?: "forfeit" | "release"; ttl?: number } = {}) {
  const bodies: string[] = [];
  const events: UsageEvent[] = [];
  const fetchFn = (_u: string, init: { body: string }) => {
    bodies.push(init.body);
    const r = replies[bodies.length - 1];
    return Promise.resolve(r === undefined ? new Response("", { status: 599 }) : json(r));
  };
  const p = createHttpToolProvider({ format, endpoint: `https://models.example.invalid/${format}`, getApiKey: () => KEY, fetch: fetchFn as never });
  if (!p.ok) throw new Error(JSON.stringify(p.error));
  const inner = createToolGateway(
    { providers: { p: { complete: () => Promise.reject(new Error("unused")) } }, models: { legal: { provider: "p", providerModel: "served-model-x", maxInputChars: 200_000, maxOutputTokens: 2048, price: PRICE } }, clock: { nowMs: () => Date.now() }, usageSink: { record: (e: UsageEvent) => void events.push(e) } },
    { models: { legal: { format, provider: p.value } } },
  );
  if (!inner.ok) throw new Error(JSON.stringify(inner.error));
  const innerGateway = inner.value;
  const store = createMemoryStore();
  const made = createLedger({ store, clock: { nowMs: () => Date.now() } });
  if (!made.ok) throw new Error("ledger");
  const ledger = made.value;
  await ledger.openAccount({ tenantId: TENANT, accountId: ACCOUNT, unit: "IRR_MICROS" });
  if (funded > 0) await ledger.grant({ tenantId: TENANT, accountId: ACCOUNT, grantId: "g0", unit: "IRR_MICROS", amount: funded, source: "purchase" });

  /** برای هر پرسش: دروازهٔ اندازه‌گیرشدهٔ تازه با scopeId یکتا + سرویسِ تازه. */
  function question(scopeId: string) {
    const m = createMeteredToolGateway({ gateway: innerGateway, ledger, account: { tenantId: TENANT, accountId: ACCOUNT }, currency: "IRR", models: MODELS, scopeId, reservationTtlMs: 600_000, perMessageOverheadTokens: 50, onUnknownCost: over.onUnknownCost ?? "forfeit" });
    if (!m.ok) throw new Error(JSON.stringify(m.error));
    const l = createToolLoop({ maxSteps: 5, maxToolCalls: 6, maxIdenticalCalls: 2, truncationRetries: 1, budget: { kind: "none" } });
    if (!l.ok) throw new Error(JSON.stringify(l.error));
    const s = createCalcAnswerService({ gateway: m.value, loop: l.value, model: "legal", maxOutputTokens: 500, maxCards: 6, totalTimeoutMs: 10_000, toolTimeoutMs: 2_000, maxResultChars: 20_000 });
    if (!s.ok) throw new Error(JSON.stringify(s.error));
    return { metered: m.value, service: s.value };
  }
  const balance = async () => {
    const b = await ledger.balance({ tenantId: TENANT, accountId: ACCOUNT });
    if (!b.ok) throw new Error("balance");
    return b.value;
  };
  return { question, balance, bodies, events };
}

describe("metered-tool-gateway ⇄ زنجیرهٔ کامل با دفتر اعتبار (سرتاسری)", () => {
  it.each(FORMATS)("%s: مصرفِ دفتر = هزینهٔ گزارش‌شدهٔ سرویس = جمعِ رویدادهای مصرفِ دروازه؛ هیچ رزروی باز نمی‌ماند", async (format) => {
    const w = await world(format, 1_000_000, [toolReply(format, "call_1", claim(100_000_000)), textReply(format, "هزینهٔ دادرسی دقیقاً ۱ ریال است.")]);
    const q = w.question("q1");
    const r = await q.service.answer(USER());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.answer.cards).toHaveLength(1);
    const events = w.events.reduce((n, e) => n + ((e as unknown as { cost: { micros: number } | null }).cost?.micros ?? 0), 0);
    expect(events).toBe(TWO_STEPS);
    expect(r.value.spend.cost[0]!.micros).toBe(TWO_STEPS);
    const b = await w.balance();
    expect(b.totals.charged).toBe(TWO_STEPS);
    expect(b.available).toBe(1_000_000 - TWO_STEPS);
    expect(b.held).toBe(0);
    expect(b.openReservations).toBe(0);
    const s = q.metered.summary();
    expect(s).toMatchObject({ calls: 2, charged: TWO_STEPS, shortfall: 0, needsAttention: false, alarms: [] });
    expect(s.outcomes.billed).toBe(2);
    expect(q.metered.receipts().map((x) => x.reservationId)).toEqual(["q1.r1", "q1.r2"]);
  });

  it.each(FORMATS)("%s: رزروِ هر گام از هزینهٔ واقعی بیشتر و شاملِ بدنهٔ ابزارها و ادامه است (بی‌SHORTFALL)", async (format) => {
    const w = await world(format, 1_000_000, [toolReply(format, "call_1", claim(100_000_000)), textReply(format, "تمام")]);
    const q = w.question("q1");
    await q.service.answer(USER());
    const [r1, r2] = q.metered.receipts();
    expect(r1!.reserved).toBeGreaterThan(6000);
    expect(r2!.reserved).toBeGreaterThan(r1!.reserved); // گام دوم ادامهٔ گفت‌وگو (پیامِ دستیار + نتیجهٔ ابزار) را هم دارد
    expect(r2!.reserved).toBeGreaterThan(2400);
    expect(q.metered.summary().shortfall).toBe(0);
  });

  it.each(FORMATS)("%s: اعتبار کافی نیست ⇒ پاسخ ساخته نمی‌شود، هیچ تماسِ شبکه‌ای نمی‌رود و دفتر دست‌نخورده است", async (format) => {
    const w = await world(format, 100, [textReply(format, "x")]);
    const q = w.question("q1");
    const r = await q.service.answer(USER());
    // شکستِ گام در حلقه «ایست» است نه خطای سرویس: پاسخِ ناتمام هرگز نمایش داده نمی‌شود و هزینه حفظ می‌شود (ADR-0061).
    expect(r.ok && r.value.answer.status).toBe("stopped");
    expect(r.ok && r.value.answer.text).toBeFalsy();
    expect(w.bodies).toHaveLength(0);
    expect(await w.balance()).toMatchObject({ available: 100, held: 0, openReservations: 0 });
    expect(q.metered.receipts()[0]!.refusal?.code).toBe("INSUFFICIENT_CREDIT");
    expect(q.metered.summary().needsAttention).toBe(false);
  });

  it.each(FORMATS)("%s: اعتبار فقط برای گامِ اول بس است ⇒ گامِ دوم رد می‌شود، هزینهٔ گامِ اول ثبت می‌ماند و در spend سرویس هست", async (format) => {
    // رزروِ گامِ اول چند هزار است؛ پس از مصرفِ ۶۰۰۰ باقیمانده برای رزروِ گامِ دوم کافی نیست.
    const probe = await world(format, 1_000_000, [toolReply(format, "call_1", claim(100_000_000)), textReply(format, "x")]);
    const pq = probe.question("p");
    await pq.service.answer(USER());
    const worst1 = pq.metered.receipts()[0]!.reserved;
    const worst2 = pq.metered.receipts()[1]!.reserved;
    const funded = worst1 + 100;
    expect(funded - 6000).toBeLessThan(worst2);
    const w = await world(format, funded, [toolReply(format, "call_1", claim(100_000_000)), textReply(format, "x")]);
    const q = w.question("q1");
    const r = await q.service.answer(USER());
    expect(r.ok && r.value.answer.status).toBe("stopped");
    expect(w.bodies).toHaveLength(1);
    expect(r.ok && r.value.spend.cost[0]?.micros).toBe(6000);
    const b = await w.balance();
    expect(b.totals.charged).toBe(6000);
    expect(b.available).toBe(funded - 6000);
    expect(b.held).toBe(0);
  });

  it.each(FORMATS)("%s: خطای ارائه‌دهنده (۵۹۹) ⇒ هزینهٔ نامعلوم با forfeit: رزروِ گام سوخته و زنگ COST_UNKNOWN", async (format) => {
    const w = await world(format, 1_000_000, []);
    const q = w.question("q1");
    const r = await q.service.answer(USER());
    expect(r.ok && r.value.answer.status).toBe("stopped");
    const s = q.metered.summary();
    expect(s.alarms).toContain("COST_UNKNOWN");
    expect(s.needsAttention).toBe(true);
    const b = await w.balance();
    expect(b.held).toBe(0);
    expect(b.totals.forfeited).toBeGreaterThan(0);
  });

  it.each(FORMATS)("%s: همان خطا با release ⇒ دفتر سالم می‌ماند ولی زنگ می‌ماند", async (format) => {
    const w = await world(format, 1_000_000, [], { onUnknownCost: "release" });
    const q = w.question("q1");
    await q.service.answer(USER());
    expect(await w.balance()).toMatchObject({ available: 1_000_000, held: 0 });
    expect(q.metered.summary().alarms).toContain("COST_UNKNOWN");
  });

  it.each(FORMATS)("%s: پرسش‌های هم‌زمانِ یک حساب با scopeIdهای جدا هر کدام درست تسویه می‌شوند", async (format) => {
    const responder = (body: string): unknown => {
      const second = body.includes("call_") || body.includes("tool_result") || body.includes('"role":"tool"');
      return second ? textReply(format, "پاسخ") : toolReply(format, "call_1", claim(100_000_000));
    };
    // fetchِ ثابتِ ساخته‌شده در world پاسخِ ترتیبی می‌دهد؛ برای هم‌زمانی دنیای جدا با پاسخ‌دهندهٔ محتوامحور می‌سازیم.
    const bodies: string[] = [];
    const p = createHttpToolProvider({ format, endpoint: "https://models.example.invalid/x", getApiKey: () => KEY, fetch: ((_u: string, init: { body: string }) => { bodies.push(init.body); return Promise.resolve(json(responder(init.body))); }) as never });
    if (!p.ok) throw new Error("p");
    const inner = createToolGateway(
      { providers: { p: { complete: () => Promise.reject(new Error("unused")) } }, models: { legal: { provider: "p", providerModel: "m", maxInputChars: 200_000, maxOutputTokens: 2048, price: PRICE } }, clock: { nowMs: () => Date.now() } },
      { models: { legal: { format, provider: p.value } } },
    );
    if (!inner.ok) throw new Error("g");
    const made = createLedger({ store: createMemoryStore(), clock: { nowMs: () => Date.now() } });
    if (!made.ok) throw new Error("l");
    await made.value.openAccount({ tenantId: TENANT, accountId: ACCOUNT, unit: "IRR_MICROS" });
    await made.value.grant({ tenantId: TENANT, accountId: ACCOUNT, grantId: "g0", unit: "IRR_MICROS", amount: 10_000_000, source: "purchase" });
    const qs = ["a", "b", "c"].map((id) => {
      const m = createMeteredToolGateway({ gateway: inner.value, ledger: made.value, account: { tenantId: TENANT, accountId: ACCOUNT }, currency: "IRR", models: MODELS, scopeId: `q-${id}`, reservationTtlMs: 600_000, perMessageOverheadTokens: 50, onUnknownCost: "forfeit" });
      if (!m.ok) throw new Error("m");
      const l = createToolLoop({ maxSteps: 5, maxToolCalls: 6, maxIdenticalCalls: 2, truncationRetries: 1, budget: { kind: "none" } });
      if (!l.ok) throw new Error("loop");
      const s = createCalcAnswerService({ gateway: m.value, loop: l.value, model: "legal", maxOutputTokens: 500, maxCards: 6, totalTimeoutMs: 10_000, toolTimeoutMs: 2_000, maxResultChars: 20_000 });
      if (!s.ok) throw new Error("s");
      return { m: m.value, s: s.value };
    });
    const rs = await Promise.all(qs.map((q) => q.s.answer(USER())));
    expect(rs.every((r) => r.ok)).toBe(true);
    for (const q of qs) expect(q.m.summary()).toMatchObject({ calls: 2, needsAttention: false });
    const b = await made.value.balance({ tenantId: TENANT, accountId: ACCOUNT });
    expect(b.ok && b.value.held).toBe(0);
    expect(b.ok && b.value.openReservations).toBe(0);
    expect(b.ok && b.value.totals.charged).toBe(3 * TWO_STEPS);
    expect(qs.reduce((n, q) => n + q.m.summary().charged, 0)).toBe(3 * TWO_STEPS);
    expect(bodies.length).toBeGreaterThanOrEqual(6);
  });

  it.each(FORMATS)("%s: scopeId تکراری برای پرسشِ دوم ⇒ ردّ و بی‌تماس (جلوگیری از اشتراکِ رزرو)", async (format) => {
    const w = await world(format, 1_000_000, [toolReply(format, "call_1", claim(100_000_000)), textReply(format, "x"), textReply(format, "y")]);
    await w.question("same").service.answer(USER());
    const calls = w.bodies.length;
    const r = await w.question("same").service.answer(USER());
    expect(r.ok && r.value.answer.status).toBe("stopped");
    expect(w.bodies).toHaveLength(calls);
  });

  it.each(FORMATS)("%s: کلیدِ API و متنِ پرسش در هیچ رسید/خلاصه‌ای نیست", async (format) => {
    const w = await world(format, 1_000_000, [toolReply(format, "call_1", claim(100_000_000)), textReply(format, "تمام")]);
    const q = w.question("q1");
    await q.service.answer(USER("پرسشِ محرمانهٔ ۴۲۴۲"));
    const dump = JSON.stringify([q.metered.receipts(), q.metered.summary()]);
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain("محرمانه");
    expect(dump).not.toContain("served-model-x");
  });
});
