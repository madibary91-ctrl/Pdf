import { describe, expect, it } from "vitest";
import { createToolGateway, type ToolWireFormat } from "@/modules/ai-gateway";
import { createHttpToolProvider } from "@/modules/ai-provider-http";
import { createCalcAnswerService } from "@/modules/calc-answer-service";
import { createCardCollector } from "@/modules/calc-answer-cards";
import { createDurableToolGateway } from "@/modules/durable-tool-gateway";
import { createLedger, createMemoryStore } from "@/modules/ledger";
import { createDurableLedger, createMemoryOutbox } from "@/modules/settlement";
import { checkTimingRelations, createDeadlineToolGateway } from "@/modules/tool-call-deadline";
import { createToolLoop, resolveToolLoopConfig } from "@/modules/tool-loop";
import { resolveRunnerOptions } from "@/modules/tool-runner";
import { DEFAULT_TOOL_POLICY, projectToolPolicy, resolveToolPolicy, timingFromGrace, toolScopeId } from "@/modules/tool-policy";

/**
 * قرارداد با پایین‌دست‌ها (ADR-0067): آنچه `projectToolPolicy` می‌دهد را **اعتبارسنج‌های واقعیِ** هر ماژول می‌پذیرند و کلِ زنجیرهٔ
 * `service(durable(deadline(gateway)))` با آن ساخته و اجرا می‌شود. اگر کرانِ ماژولی عوض شود، اینجا قرمز می‌شود. قیمت‌ها ساختگیِ آزمون‌اند.
 */
const FORMAT: ToolWireFormat = "openai-chat";
const PRICE = { currency: "IRR", inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000, version: "test-prices-v1" };
const TENANT = "tenant-pol";
const ACCOUNT = "acct-pol";
const json = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const REPLIES: unknown[] = [
  { model: "served", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "court_fee", arguments: JSON.stringify({ date: { year: 1404, month: 6, day: 15 }, stage: "first-instance", claim: { kind: "known", amountRials: 100_000_000 } }) } }] } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } },
  { model: "served", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "خلاصهٔ محاسبه" } }], usage: { prompt_tokens: 500, completion_tokens: 60 } },
];

function proj(overrides?: unknown) {
  const r = projectToolPolicy(overrides);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

describe("tool-policy ⇄ اعتبارسنج‌های واقعیِ پایین‌دست", () => {
  it("loop: resolveToolLoopConfig همان مقدارها را می‌پذیرد (با budget از ریشه)", () => {
    const p = proj();
    const r = resolveToolLoopConfig({ ...p.loop, budget: { kind: "none" } });
    expect(r.ok).toBe(true);
    expect(r.ok && r.value).toMatchObject(p.loop);
  });

  it("cards: createCardCollector با maxCards سیاست", () => {
    expect(createCardCollector({ maxCards: proj().service.maxCards }).ok).toBe(true);
  });

  it("runner: resolveRunnerOptions با مهلت‌ها و سقفِ نتیجهٔ سیاست", () => {
    const p = proj();
    const l = createToolLoop({ ...p.loop, budget: { kind: "none" } });
    expect(l.ok).toBe(true);
    if (!l.ok) return;
    const gw = { completeStep: () => Promise.reject(new Error("unused")), toolFormat: () => FORMAT, limits: () => null };
    const r = resolveRunnerOptions({ gateway: gw, loop: l.value, executeTool: () => Promise.resolve({ ok: true, content: "x" }), totalTimeoutMs: p.service.totalTimeoutMs, toolTimeoutMs: p.service.toolTimeoutMs, maxResultChars: p.service.maxResultChars });
    expect(r.ok).toBe(true);
  });

  it("deadline + زمان‌بندی: checkTimingRelations (منبعِ رابطه‌ها) روی سیاستِ پیش‌فرض و مشتق از graceMs خالی است", () => {
    const t = DEFAULT_TOOL_POLICY.timing;
    expect(checkTimingRelations(t)).toEqual([]);
    const d = timingFromGrace(45_000);
    expect(d.ok && checkTimingRelations(d.value)).toEqual([]);
  });

  it("settlement: دفترِ ماندگار با graceMs و onUnknownCost سیاست ساخته می‌شود", () => {
    const p = proj();
    const clock = { nowMs: () => 1_000 };
    const made = createLedger({ store: createMemoryStore(), clock });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const sw = createDurableLedger({ ledger: made.value, outbox: createMemoryOutbox(), clock, graceMs: p.durable.graceMs, onUnknownCost: p.durable.onUnknownCost });
    expect(sw.ok).toBe(true);
  });

  it("ttl کمتر از ۲×graceMs را دروازهٔ ماندگار واقعی هم رد می‌کند؛ سیاست پیش‌تر رد کرده است (دو لایه، یک قاعده)", () => {
    expect(resolveToolPolicy({ timing: { reservationTtlMs: DEFAULT_TOOL_POLICY.timing.graceMs } }).ok).toBe(false);
  });

  it.each(["forfeit", "release"] as const)("زنجیرهٔ کامل service(durable(deadline(gateway))) با سیاست (%s) ساخته و یک پرسش با دو گام پاسخ می‌دهد", async (policy) => {
    const p = proj({ metering: { onUnknownCost: policy } });
    let i = 0;
    const fetchFn = () => Promise.resolve(json(REPLIES[i++]));
    const prov = createHttpToolProvider({ format: FORMAT, endpoint: "https://models.example.invalid/x", getApiKey: () => "sk-test-key", fetch: fetchFn as never });
    if (!prov.ok) throw new Error(JSON.stringify(prov.error));
    const inner = createToolGateway(
      { providers: { p: { complete: () => Promise.reject(new Error("unused")) } }, models: { [p.service.model]: { provider: "p", providerModel: "served-model-x", maxInputChars: 200_000, maxOutputTokens: 2048, price: PRICE, timeoutMs: p.gatewayModel.timeoutMs } }, clock: { nowMs: () => Date.now() }, usageSink: { record: () => undefined } },
      { models: { [p.service.model]: { format: FORMAT, provider: prov.value } } },
    );
    if (!inner.ok) throw new Error(JSON.stringify(inner.error));
    const dl = createDeadlineToolGateway({ gateway: inner.value, maxCallMs: p.deadline.maxCallMs });
    if (!dl.ok) throw new Error(JSON.stringify(dl.error));
    const clock = { nowMs: () => 5_000_000 };
    const led = createLedger({ store: createMemoryStore(), clock });
    if (!led.ok) throw new Error("ledger");
    await led.value.openAccount({ tenantId: TENANT, accountId: ACCOUNT, unit: "IRR_MICROS" });
    await led.value.grant({ tenantId: TENANT, accountId: ACCOUNT, grantId: "g0", unit: "IRR_MICROS", amount: 1_000_000, source: "purchase" });
    const scope = toolScopeId("question-1");
    if (!scope.ok) throw new Error("scope");
    const durable = createDurableToolGateway({ gateway: dl.value, ledger: led.value, account: { tenantId: TENANT, accountId: ACCOUNT }, currency: "IRR", models: { [p.service.model]: { price: PRICE, maxOutputTokens: 2048 } }, scopeId: scope.value, outbox: createMemoryOutbox(), clock, ...p.durable });
    if (!durable.ok) throw new Error(JSON.stringify(durable.error));
    const loop = createToolLoop({ ...p.loop, budget: { kind: "none" } });
    if (!loop.ok) throw new Error(JSON.stringify(loop.error));
    const svc = createCalcAnswerService({ gateway: durable.value, loop: loop.value, ...p.service });
    if (!svc.ok) throw new Error(JSON.stringify(svc.error));
    const r = await svc.value.answer({ messages: [{ role: "user", content: "هزینهٔ دادرسی؟" }] });
    expect(r.ok && r.value.answer.cards).toHaveLength(1);
    expect(r.ok && r.value.steps).toBe(2);
    expect(r.ok && r.value.spend.cost[0]?.micros).toBe(8400);
  });
});
