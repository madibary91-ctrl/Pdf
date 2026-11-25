import { describe, expect, it } from "vitest";
import { createToolGateway, type ToolWireFormat, type UsageEvent } from "@/modules/ai-gateway";
import { createHttpToolProvider } from "@/modules/ai-provider-http";
import { createCalcAnswerService } from "@/modules/calc-answer-service";
import { createLedger, createMemoryStore } from "@/modules/ledger";
import type { Ledger } from "@/modules/ledger";
import { createDurableToolGateway } from "@/modules/durable-tool-gateway";
import { createMemoryOutbox, createSettlementSweeper } from "@/modules/settlement";
import type { SettlementOutbox } from "@/modules/settlement";
import { createToolLoop } from "@/modules/tool-loop";

/**
 * «fetchِ درون‌حافظه ← ai-provider-http ← ai-gateway ← **durable-tool-gateway (دفتر اعتبارِ واقعی + outbox + رفتگر)** ← tool-loop ← tool-runner ←
 * calc-tool-executor ← calc-answer-cards ← calc-answer-service»، همه واقعی (ADR-0063). فقط مدلِ پشتِ fetch شبیه‌سازی است.
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


const GRACE = 10_000;
const TTL = 600_000;

type Hook = {
  /** تعدادِ شکستِ `charge` (پس از `skip`) روی دفتر. */
  chargeFail?: number;
  /** تماسِ شمارهٔ n (از ۰) که هرگز برنمی‌گردد (مرگِ فرایند). */
  hangAt?: number;
  /** شکستِ `begin` در outbox برای رکوردِ n‑ام (از ۰). */
  beginFailAt?: number;
  onUnknownCost?: "forfeit" | "release";
  /** پاسخ‌دهندهٔ محتوامحور (برای پرسش‌های هم‌زمان؛ ترتیبِ تماس‌ها قطعی نیست). */
  responder?: (body: string) => unknown;
};

async function world(format: ToolWireFormat, funded: number, replies: readonly unknown[], hook: Hook = {}) {
  const bodies: string[] = [];
  const events: UsageEvent[] = [];
  const fetchFn = (_u: string, init: { body: string }) => {
    bodies.push(init.body);
    const i = bodies.length - 1;
    if (hook.hangAt === i) return new Promise<Response>(() => undefined);
    const r = hook.responder !== undefined ? hook.responder(init.body) : replies[i];
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
  let now = 5_000_000;
  const clock = { nowMs: () => now };
  const store = createMemoryStore();
  const made = createLedger({ store, clock });
  if (!made.ok) throw new Error("ledger");
  const ledger = made.value;
  await ledger.openAccount({ tenantId: TENANT, accountId: ACCOUNT, unit: "IRR_MICROS" });
  if (funded > 0) await ledger.grant({ tenantId: TENANT, accountId: ACCOUNT, grantId: "g0", unit: "IRR_MICROS", amount: funded, source: "purchase" });

  // خطای تزریقی روی دفتر/outbox (فقط برای همین آزمون‌ها؛ متنِ خطا باید هرگز نشت نکند).
  let charges = 0;
  const rawLedger: Ledger = {
    ...ledger,
    charge: async (input) => (hook.chargeFail !== undefined && ++charges <= hook.chargeFail ? { ok: false, error: { code: "STORE_FAILURE", message: "LEAK-CANARY-E2E" } } : ledger.charge(input)),
  };
  const mem = createMemoryOutbox();
  let begins = 0;
  const outbox: SettlementOutbox = { ...mem, begin: async (input) => (hook.beginFailAt !== undefined && begins++ === hook.beginFailAt ? { ok: false, error: { code: "STORE_FAILURE", message: "LEAK-CANARY-E2E" } } : mem.begin(input)) };
  const sweeper = createSettlementSweeper({ ledger, outbox: mem, clock });
  if (!sweeper.ok) throw new Error(JSON.stringify(sweeper.error));

  /** برای هر پرسش: دروازهٔ ماندگارِ تازه با scopeId یکتا + سرویسِ تازه. */
  function question(scopeId: string) {
    const m = createDurableToolGateway({ gateway: innerGateway, ledger: rawLedger, account: { tenantId: TENANT, accountId: ACCOUNT }, currency: "IRR", models: MODELS, scopeId, reservationTtlMs: TTL, perMessageOverheadTokens: 50, onUnknownCost: hook.onUnknownCost ?? "forfeit", outbox, clock, graceMs: GRACE });
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
  const counts = async () => {
    const c = await mem.counts();
    if (!c.ok) throw new Error("counts");
    return c.value;
  };
  const advance = (ms: number) => void (now += ms);
  const sweepAll = async () => {
    for (let i = 0; i < 6; i++) if ((await sweeper.value.sweep()).examined === 0) return;
  };
  const waitBodies = async (n: number) => {
    for (let i = 0; i < 3000 && bodies.length < n; i++) await new Promise((r) => setTimeout(r, 1));
    expect(bodies.length).toBeGreaterThanOrEqual(n);
  };
  return { question, balance, counts, advance, sweepAll, waitBodies, bodies, events };
}

const TWO = (format: ToolWireFormat) => [toolReply(format, "call_1", claim(100_000_000)), textReply(format, "هزینهٔ دادرسی دقیقاً ۱ ریال است.")];

describe("durable-tool-gateway ⇄ زنجیرهٔ کامل با دفتر اعتبار، outbox و رفتگر (سرتاسری)", () => {
  it.each(FORMATS)("%s: پاسخِ دو‌گامی: مصرفِ دفتر = هزینهٔ سرویس؛ دو رکوردِ done؛ رفتگر کاری ندارد", async (format) => {
    const w = await world(format, 1_000_000, TWO(format));
    const q = w.question("q1");
    const r = await q.service.answer(USER());
    expect(r.ok && r.value.answer.cards).toHaveLength(1);
    expect(r.ok && r.value.spend.cost[0]?.micros).toBe(TWO_STEPS);
    expect(await w.counts()).toEqual({ open: 0, settling: 0, done: 2, dead: 0 });
    w.advance(GRACE);
    await w.sweepAll();
    const b = await w.balance();
    expect(b).toMatchObject({ held: 0, openReservations: 0, available: 1_000_000 - TWO_STEPS });
    expect(b.totals.charged).toBe(TWO_STEPS);
    expect(b.totals.forfeited).toBe(0);
    expect(q.metered.summary()).toMatchObject({ calls: 2, charged: TWO_STEPS, needsAttention: false });
  });

  it.each(FORMATS)("%s: فرایند وسط گامِ دوم می‌میرد (forfeit): گامِ اول ثبت می‌ماند و رفتگر رزروِ گامِ دوم را می‌سوزاند", async (format) => {
    const w = await world(format, 1_000_000, TWO(format), { hangAt: 1 });
    const q = w.question("q1");
    void q.service.answer(USER()); // رها شد: فرایند مرد
    await w.waitBodies(2);
    expect(await w.counts()).toEqual({ open: 1, settling: 0, done: 1, dead: 0 });
    const mid = await w.balance();
    expect(mid.held).toBeGreaterThan(0);
    await w.sweepAll();
    expect((await w.balance()).held).toBe(mid.held); // هنوز در مهلتِ تماس
    w.advance(GRACE);
    await w.sweepAll();
    const b = await w.balance();
    const reserved2 = mid.held; // رزروِ گامِ دوم (گامِ اول بسته بود)؛ رسیدِ گامِ مرده هرگز ساخته نمی‌شود.
    expect(q.metered.receipts()).toHaveLength(1);
    expect(b).toMatchObject({ held: 0, openReservations: 0 });
    expect(b.totals.charged).toBe(6000);
    expect(b.totals.forfeited).toBe(reserved2);
    expect(b.available + b.totals.charged + b.totals.forfeited).toBe(1_000_000);
    expect(await w.counts()).toEqual({ open: 0, settling: 0, done: 2, dead: 0 });
  });

  it.each(FORMATS)("%s: همان مرگ با release ⇒ رزرو آزاد (تصمیمِ صریحِ محصول)؛ فقط هزینهٔ گامِ اول گرفته می‌شود", async (format) => {
    const w = await world(format, 1_000_000, TWO(format), { hangAt: 1, onUnknownCost: "release" });
    const q = w.question("q1");
    void q.service.answer(USER());
    await w.waitBodies(2);
    w.advance(GRACE);
    await w.sweepAll();
    expect(await w.balance()).toMatchObject({ held: 0, available: 1_000_000 - 6000, totals: { charged: 6000, forfeited: 0 } });
  });

  it.each(FORMATS)("%s: شکستِ ثبتِ مصرفِ گامِ اول در دفتر: پاسخ کامل می‌شود با زنگ؛ رفتگر هزینه را دقیقاً یک بار می‌گیرد", async (format) => {
    const w = await world(format, 1_000_000, TWO(format), { chargeFail: 3 });
    const q = w.question("q1");
    const r = await q.service.answer(USER());
    expect(r.ok && r.value.answer.status).not.toBe("stopped");
    const s = q.metered.summary();
    expect(s.needsAttention).toBe(true);
    expect(s.alarms).toContain("SETTLEMENT_PENDING");
    expect(JSON.stringify([r, s, q.metered.receipts()])).not.toContain("LEAK-CANARY-E2E");
    expect((await w.balance()).totals.charged).toBe(TWO_STEPS - 6000); // فقط گامِ دوم؛ گامِ اول معلق
    w.advance(GRACE);
    await w.sweepAll();
    const b = await w.balance();
    expect(b).toMatchObject({ held: 0, openReservations: 0, available: 1_000_000 - TWO_STEPS });
    expect(b.totals.charged).toBe(TWO_STEPS);
    expect(b.totals.forfeited).toBe(0);
    expect(await w.counts()).toEqual({ open: 0, settling: 0, done: 2, dead: 0 });
    w.advance(GRACE);
    await w.sweepAll();
    expect((await w.balance()).totals.charged).toBe(TWO_STEPS); // رفتگرِ دوباره دوباره‌کاری نمی‌کند
  });

  it.each(FORMATS)("%s: outbox هنگام رزروِ گامِ دوم خراب است ⇒ تماسِ دوم نمی‌رود، پاسخ ایست می‌خورد، هزینهٔ گامِ اول می‌ماند و چیزی معلق نیست", async (format) => {
    const w = await world(format, 1_000_000, TWO(format), { beginFailAt: 1 });
    const q = w.question("q1");
    const r = await q.service.answer(USER());
    expect(r.ok && r.value.answer.status).toBe("stopped");
    expect(w.bodies).toHaveLength(1);
    expect(r.ok && r.value.spend.cost[0]?.micros).toBe(6000);
    expect(JSON.stringify(r)).not.toContain("LEAK-CANARY-E2E");
    expect(q.metered.receipts()[1]!.refusal?.code).toBe("RESERVE_FAILED");
    w.advance(GRACE);
    await w.sweepAll();
    expect(await w.balance()).toMatchObject({ held: 0, openReservations: 0, available: 1_000_000 - 6000, totals: { charged: 6000, forfeited: 0 } });
    expect(await w.counts()).toEqual({ open: 0, settling: 0, done: 1, dead: 0 });
  });

  it.each(FORMATS)("%s: دو پرسشِ هم‌زمانِ یک حساب با scopeIdهای جدا: چهار رکوردِ done و بی‌تداخل", async (format) => {
    const responder = (body: string): unknown => {
      const second = body.includes("call_") || body.includes("tool_result") || body.includes('"role":"tool"');
      return second ? textReply(format, "پاسخ") : toolReply(format, "call_1", claim(100_000_000));
    };
    const w2 = await world(format, 1_000_000, [], { responder });
    const a = w2.question("qa");
    const b = w2.question("qb");
    const [ra, rb] = await Promise.all([a.service.answer(USER("الف")), b.service.answer(USER("ب"))]);
    expect(ra.ok && rb.ok).toBe(true);
    expect(await w2.counts()).toEqual({ open: 0, settling: 0, done: 4, dead: 0 });
    const bal = await w2.balance();
    expect(bal.held).toBe(0);
    expect(bal.totals.charged + bal.totals.forfeited + bal.available).toBe(1_000_000);
    expect(w2.bodies).toHaveLength(4);
  });
});
