/**
 * آزمونِ همسانی (ADR-0062 تصمیم ۴): منطقِ تسویه در این ماژول بازنویسیِ `metering` است. همان سناریوهای هزینه/دفتر از هر دو دروازه
 * (`createMeteredGateway` روی `Gateway`، و این ماژول روی `ToolGateway`) می‌گذرد و رسیدها و موجودیِ دفتر باید یکی باشد
 * (جز `reserved` که برآوردِ ابزار بزرگ‌تر است). اگر یکی از دو طرف جدا بچرخد این آزمون قرمز می‌شود.
 */
import { describe, expect, it } from "vitest";
import type { Ledger } from "@/modules/ledger";
import { createMeteredGateway } from "@/modules/metering";
import { MODELS, STEP, balance, fundedLedger, make, stepErr, stepOk, stubGateway, ACCOUNT, TENANT, type MutableClock } from "./test-kit";

type Wrap = (l: Ledger, clock: MutableClock) => { ledger: Ledger; hook?: () => void };
const transient = { ok: false as const, error: { code: "STORE_FAILURE" as const, message: "m" } };

const scenarios: { name: string; result: unknown | (() => never); wrap?: Wrap }[] = [
  { name: "هزینهٔ معلومِ کمتر از رزرو", result: stepOk(120) },
  { name: "هزینهٔ صفر", result: stepOk(0) },
  { name: "هزینهٔ بیش از رزرو (SHORTFALL)", result: stepOk(10_000) },
  { name: "هزینهٔ نامعلوم (cost=null)", result: stepOk(null) },
  { name: "شکستِ بی‌تماس (INVALID_REQUEST)", result: stepErr("INVALID_REQUEST") },
  { name: "شکستِ مبهم (TIMEOUT)", result: stepErr("TIMEOUT") },
  { name: "نتیجهٔ بی‌شکل", result: 5 },
  { name: "پرتابِ دروازهٔ درونی", result: () => { throw new Error("x"); } },
  { name: "انقضای رزرو پیش از تسویه", result: stepOk(100), wrap: (l, c) => ({ ledger: l, hook: () => c.advance(61_000) }) },
  { name: "charge همیشه گذرا-ناموفق", result: stepOk(100), wrap: (l) => ({ ledger: { ...l, reserve: l.reserve.bind(l), close: l.close.bind(l), charge: async () => transient } as never }) },
  { name: "close ناموفق", result: stepOk(100), wrap: (l) => ({ ledger: { ...l, reserve: l.reserve.bind(l), charge: l.charge.bind(l), close: async () => ({ ok: false, error: { code: "VALIDATION_FAILED", message: "m" } }) } as never }) },
  { name: "close(forfeit) روی رزروِ منقضی", result: stepOk(null), wrap: (l, c) => ({ ledger: l, hook: () => c.advance(61_000) }) },
];

describe("metered-tool-gateway ⇄ metering · همسانیِ تسویه", () => {
  for (const policy of ["forfeit", "release"] as const) {
    it.each(scenarios.map((s) => [s.name, s] as const))(`${policy}: %s`, async (_n, s) => {
      const run = async (kind: "tool" | "plain") => {
        const f = await fundedLedger(10_000);
        const w = s.wrap?.(f.ledger, f.clock) ?? { ledger: f.ledger };
        const reply = () => {
          w.hook?.();
          if (typeof s.result === "function") return (s.result as () => never)();
          return s.result;
        };
        let receipt: { outcome: string; charged: number; shortfall: number; alarms: readonly string[] } | undefined;
        if (kind === "tool") {
          const { gateway } = stubGateway(reply);
          const r = await make(w.ledger, gateway, { onUnknownCost: policy }).completeStep(STEP);
          receipt = r.ok ? r.value.metering : r.error.metering;
        } else {
          const gateway = { complete: async () => reply() as never, limits: () => ({ maxInputChars: 20_000, maxOutputTokens: 1000, priced: true }) };
          const m = createMeteredGateway({ gateway, ledger: w.ledger, account: { tenantId: TENANT, accountId: ACCOUNT }, currency: "IRR", models: MODELS, scopeId: "scope-1", reservationTtlMs: 60_000, maxProviderCalls: 1, perMessageOverheadTokens: 10, onUnknownCost: policy });
          if (!m.ok) throw new Error("config");
          const r = await m.value.complete({ model: "legal", messages: [{ role: "user", content: "abcd" }], maxOutputTokens: 100 });
          receipt = r.ok ? r.value.metering : r.error.metering;
        }
        const b = await balance(f.ledger);
        return { receipt: { outcome: receipt.outcome, charged: receipt.charged, shortfall: receipt.shortfall, alarms: receipt.alarms }, charged: b.totals.charged, forfeited: b.totals.forfeited, shortfallTotal: b.totals.shortfall, opened: b.openReservations };
      };
      const tool = await run("tool");
      const plain = await run("plain");
      // خروجی‌های وابسته به اندازهٔ رزرو (forfeited و موجودی) فقط در «آیا سوخت/آزاد شد» می‌خواند: مقایسهٔ بولی.
      // با SHORTFALL مبلغِ مصرف‌شده = کلِ رزرو است که به برآورد وابسته است: فقط «بودنِ» آن مقایسه می‌شود.
      const norm = (x: Awaited<ReturnType<typeof run>>) => {
        const over = x.receipt.shortfall > 0;
        return { ...x, receipt: { ...x.receipt, charged: over ? -1 : x.receipt.charged, shortfall: over ? -1 : x.receipt.shortfall }, charged: over ? -1 : x.charged, shortfallTotal: over ? -1 : x.shortfallTotal, forfeited: x.forfeited > 0 };
      };
      expect(norm(tool)).toEqual(norm(plain));
    });
  }
});
