/**
 * آزمونِ تصادفیِ قطعی (۳۰۰ بذر) با داورِ مستقل: برای هر توالیِ گام‌ها، موجودیِ دفتر را جدا و با حسابِ دستی پیش‌بینی می‌کنیم
 * (رزرو = بایت‌ها + سربار + ۳×خروجی؛ هزینهٔ معلوم ⇒ min(cost, رزرو)؛ نامعلوم ⇒ سوخت/آزاد؛ بی‌تماس ⇒ آزاد).
 * پایا: رزروِ باز نمی‌ماند، و `funded = available + charged + forfeited`.
 */
import { describe, expect, it } from "vitest";
import { TOOLS_BYTES, balance, fundedLedger, make, stepErr, stepOk, stubGateway, STEP } from "./test-kit";

function rng(seed: number): () => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}
const KINDS = ["known", "known-over", "null-cost", "timeout", "bad-with-cost", "invalid", "throw", "malformed"] as const;
type Kind = (typeof KINDS)[number];

describe("metered-tool-gateway · تصادفیِ قطعی با داورِ مستقل", () => {
  const hit = new Set<Kind | "refused" | "forfeit" | "release">();
  for (let seed = 1; seed <= 300; seed++) {
    it(`بذر ${seed}`, async () => {
      const r = rng(seed);
      const pick = (n: number): number => Math.floor(r() * n);
      const funded = [200, 600, 1500, 4000, 20_000][pick(5)]!;
      const policy = r() < 0.5 ? "forfeit" : "release";
      const steps = 1 + pick(6);
      const plan = Array.from({ length: steps }, () => ({ kind: KINDS[pick(KINDS.length)]!, micros: pick(400), len: 1 + pick(40), maxOut: 1 + pick(120) }));

      const { ledger } = await fundedLedger(funded);
      let cursor = 0;
      let current = plan[0]!;
      const { gateway } = stubGateway(() => {
        cursor++;
        const p = current;
        switch (p.kind) {
          case "known": return stepOk(p.micros);
          case "known-over": return stepOk(p.micros + 100_000);
          case "null-cost": return stepOk(null);
          case "timeout": return stepErr("TIMEOUT");
          case "bad-with-cost": return stepErr("PROVIDER_BAD_RESPONSE", { cost: { micros: p.micros, currency: "IRR", priceVersion: "v" } });
          case "invalid": return stepErr("INVALID_REQUEST");
          case "throw": throw new Error("x");
          case "malformed": return 42;
        }
      });
      const g = make(ledger, gateway, { onUnknownCost: policy });

      let available = funded;
      let charged = 0;
      let forfeited = 0;
      let refusals = 0;
      let attention = false;
      for (const p of plan) {
        const worst = p.len + TOOLS_BYTES + 20 + 3 * p.maxOut;
        const before = cursor;
        current = p;
        const res = await g.completeStep({ ...STEP, messages: [{ role: "user", content: "a".repeat(p.len) }], maxOutputTokens: p.maxOut });
        if (available < worst) {
          expect(cursor, "بی‌اعتبار ⇒ بی‌تماس").toBe(before);
          expect(!res.ok && res.error.metering.refusal?.code).toBe("INSUFFICIENT_CREDIT");
          refusals++;
          hit.add("refused");
          continue;
        }
        expect(cursor).toBe(before + 1);
        hit.add(p.kind);
        if (p.kind === "known" || p.kind === "known-over" || p.kind === "bad-with-cost") {
          const c = p.kind === "known-over" ? p.micros + 100_000 : p.micros;
          const take = Math.min(c, worst);
          available -= take;
          charged += take;
          if (c > worst) attention = true;
        } else if (p.kind === "invalid") {
          // آزاد، بی‌اثر
        } else {
          attention = true;
          if (policy === "forfeit") {
            available -= worst;
            forfeited += worst;
            hit.add("forfeit");
          } else hit.add("release");
        }
      }
      const b = await balance(ledger);
      expect(b.available).toBe(available);
      expect(b.held).toBe(0);
      expect(b.openReservations).toBe(0);
      expect(b.totals.charged).toBe(charged);
      expect(b.totals.forfeited).toBe(forfeited);
      expect(funded).toBe(b.available + b.totals.charged + b.totals.forfeited);
      const s = g.summary();
      expect(s.calls).toBe(steps);
      expect(s.outcomes.refused).toBe(refusals);
      expect(s.charged).toBe(charged);
      expect(s.needsAttention).toBe(attention);
    });
  }
  it("پوششِ فضای حالت: همهٔ انواعِ گام، ردّ، سوخت و آزادسازی دست‌کم یک‌بار دیده شده", () => {
    for (const k of [...KINDS, "refused", "forfeit", "release"]) expect(hit.has(k as never), k).toBe(true);
  });
});
