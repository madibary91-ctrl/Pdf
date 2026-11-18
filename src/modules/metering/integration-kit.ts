/** ابزار آزمون‌های یکپارچگی/خاصیتی (از index صادر نمی‌شود): ممیزی دفتر و دروازهٔ تاب‌آورِ واقعی با ارائه‌دهندهٔ سناریویی. */
import { ProviderFailure, createResilientGateway } from "@/modules/ai-gateway";
import type { Gateway, ModelProvider, ProviderCall } from "@/modules/ai-gateway";
import { checkInvariants, foldJournal } from "@/modules/ledger";
import type { AccountStore } from "@/modules/ledger";
import { ACCOUNT, PRICE, PRICE_ALT, TENANT } from "./test-kit";

export const KEY = { tenantId: TENANT, accountId: ACCOUNT };

/** ناوردای پول روی حالت ماندگار: checkInvariants، بازپخش ژورنال = حالت، و بقا (اعطا = موجود + نگه‌داشته + مصرف + سوخته؛ بی‌بازگشت). */
export async function auditLedger(store: AccountStore): Promise<{ available: number; held: number; charged: number; forfeited: number; granted: number }> {
  const state = await store.read(KEY);
  if (state === null) throw new Error("حساب نیست");
  const violations = checkInvariants(state);
  if (violations.length > 0) throw new Error(`ناوردا شکست: ${violations.join("; ")}`);
  const folded = foldJournal(await store.journal(KEY));
  if (!folded.ok) throw new Error(`بازپخش ژورنال: ${folded.reason}`);
  const f = folded.value;
  if (f.available !== state.available || f.held !== state.held || f.seq !== state.seq || JSON.stringify(f.totals) !== JSON.stringify(state.totals)) throw new Error("بازپخش ژورنال با حالت نمی‌خواند");
  const t = state.totals;
  if (state.available + state.held + t.charged + t.forfeited !== t.granted) throw new Error(`بقا شکست: ${JSON.stringify({ a: state.available, h: state.held, ...t })}`);
  return { available: state.available, held: state.held, charged: t.charged, forfeited: t.forfeited, granted: t.granted };
}

export type Step = Readonly<{ reply: { inputTokens: number; outputTokens: number } } | { fail: "unavailable" | "auth" | "rate_limited" }>;

export function stepProvider(steps: readonly Step[]): ModelProvider & { calls: ProviderCall[] } {
  const calls: ProviderCall[] = [];
  return {
    calls,
    async complete(call: ProviderCall) {
      calls.push(call);
      const s = steps[calls.length - 1];
      if (s === undefined) throw new Error("سناریوی ارائه‌دهنده تمام شد");
      if ("fail" in s) throw new ProviderFailure(s.fail);
      return { text: "پاسخ آزمایشی", finishReason: "stop", usage: s.reply, model: "served" };
    },
  };
}

/** دروازهٔ تاب‌آور **واقعی** (شامل گزارش `report`): main→p1، alt→p2؛ ۲ تلاش به‌ازای مدل، ۴ تلاش کل، بی‌انتظار. */
export function realResilientGateway(p1: ModelProvider, p2: ModelProvider): Gateway {
  const m = { maxInputChars: 10_000, maxOutputTokens: 1000 };
  const g = createResilientGateway(
    {
      providers: { p1, p2 },
      models: { main: { provider: "p1", providerModel: "pm1", price: PRICE, ...m }, alt: { provider: "p2", providerModel: "pm2", price: PRICE_ALT, ...m } },
      clock: { nowMs: () => Date.now() },
    },
    {
      maxAttemptsPerModel: 2,
      maxTotalAttempts: 4,
      totalTimeoutMs: 10_000,
      backoff: { baseDelayMs: 0, maxDelayMs: 0, jitter: "none" },
      retryOn: ["PROVIDER_UNAVAILABLE"],
      fallbackOn: ["PROVIDER_UNAVAILABLE", "PROVIDER_AUTH"],
      fallbacks: { main: ["alt"] },
    },
  );
  if (!g.ok) throw new Error(`createResilientGateway failed: ${(g.error.issues ?? []).join("; ")}`);
  return g.value;
}
