import { describe, expect, it } from "vitest";
import { ERROR_CODES, ProviderFailure } from "./index";
import { makeError } from "./errors";
import type { Step } from "./test-kit";
import type { UsageEvent } from "./types";
import { OK_REPLY, PRICE, REQUEST, rig } from "./test-kit";

const CANARY = "CANARY-نشت-نباید-شود";
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T };
}

const WARNINGS = new Set(["USAGE_MISSING", "UNPRICED", "OUTPUT_TRUNCATED", "EMPTY_OUTPUT", "USAGE_SINK_FAILED", "USAGE_SINK_TIMEOUT"]);

describe("ai-gateway · پایداری تصادفی (۲۰۰ بذر): بی‌پرتاب، بی‌نشت، و حسابداریِ سازگار", () => {
  it("برای هر ترکیب رفتار ارائه‌دهنده/ثبت مصرف/درخواست: ناوردا‌ها برقرارند", async () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const priced = r.next() < 0.7;
      const inT = r.int(0, 5_000_000), outT = r.int(0, 5_000_000);
      const scenario = r.pick(["ok", "ok", "ok", "usage-missing", "truncated", "rate", "unavailable", "auth", "rejected", "throw", "bad", "hang-timeout", "hang-abort", "invalid-request", "unknown-model"] as const);
      const reply = { text: r.pick(["پاسخ", "", "  ", "x".repeat(50)]), finishReason: scenario === "truncated" ? "length" : "stop", ...(scenario === "usage-missing" ? {} : { usage: { inputTokens: inT, outputTokens: outT } }) };
      const steps: Step[] = [
        scenario === "rate" ? { fail: new ProviderFailure("rate_limited", { retryAfterMs: r.int(0, 5000), cause: new Error(CANARY) }) }
        : scenario === "unavailable" ? { fail: new ProviderFailure("unavailable", { cause: CANARY }) }
        : scenario === "auth" ? { fail: new ProviderFailure("auth") }
        : scenario === "rejected" ? { fail: new ProviderFailure("rejected") }
        : scenario === "throw" ? { fail: new Error(CANARY) }
        : scenario === "bad" ? { reply: { text: CANARY, finishReason: "weird" } }
        : scenario.startsWith("hang") ? { hang: true }
        : { reply },
      ];
      const sinkMode = r.pick(["good", "good", "throw", "reject", "hang"] as const);
      const events: UsageEvent[] = [];
      const sinkBody = (e: UsageEvent): void | Promise<void> => {
        events.push(e);
        if (sinkMode === "throw") throw new Error(CANARY);
        if (sinkMode === "reject") return Promise.reject(new Error(CANARY));
        if (sinkMode === "hang") return new Promise<void>(() => undefined);
      };
      const t = rig(steps, { usageSink: { record: sinkBody }, sinkTimeoutMs: 50 }, { price: priced ? PRICE : null });

      const input = scenario === "invalid-request" ? { ...REQUEST, maxOutputTokens: -1, messages: [{ role: "user", content: CANARY }, { role: "user", content: CANARY + "\u0000" }] }
        : scenario === "unknown-model" ? { ...REQUEST, model: CANARY } : { ...REQUEST, requestId: `s${seed}` };
      const ctl = new AbortController();
      const p = t.gw.complete(input, { signal: ctl.signal });
      await tick();
      if (scenario === "hang-timeout") t.timers.advance(60_000);
      if (scenario === "hang-abort") ctl.abort();
      await tick();
      t.timers.advance(50);
      const res = await p;
      seen.add(scenario);

      const reachedProvider = t.provider.calls.length;
      expect(events.length, `seed=${seed} ${scenario}`).toBe(reachedProvider);
      expect(reachedProvider).toBe(scenario === "invalid-request" || scenario === "unknown-model" ? 0 : 1);
      expect(t.timers.pending, `seed=${seed} تایمر نشتی`).toBe(0);
      const ev = events[0];

      if (res.ok) {
        const v = res.value;
        expect(ev?.outcome).toBe("ok");
        expect(v.warnings.every((w) => WARNINGS.has(w))).toBe(true);
        expect(v.warnings.includes("OUTPUT_TRUNCATED")).toBe(v.finishReason === "length");
        expect(v.warnings.includes("UNPRICED")).toBe(!priced);
        expect(v.warnings.includes("USAGE_MISSING")).toBe(scenario === "usage-missing");
        expect(v.warnings.includes("EMPTY_OUTPUT")).toBe(v.text.trim() === "");
        if (sinkMode === "throw" || sinkMode === "reject") expect(v.warnings).toContain("USAGE_SINK_FAILED");
        if (sinkMode === "hang") expect(v.warnings).toContain("USAGE_SINK_TIMEOUT");
        if (sinkMode === "good") expect(v.warnings.some((w) => w.startsWith("USAGE_SINK"))).toBe(false);
        // هزینه ≡ ⌈N/۱۰⁶⌉ مستقل
        if (v.usage !== null && priced) {
          const N = BigInt(v.usage.inputTokens) * BigInt(PRICE.inputMicrosPerMTok) + BigInt(v.usage.outputTokens) * BigInt(PRICE.outputMicrosPerMTok);
          expect(BigInt(v.cost?.micros ?? -1)).toBe((N + BigInt(999_999)) / BigInt(1_000_000));
        } else expect(v.cost).toBeNull();
        expect(v.usage?.totalTokens).toBe(v.usage === null ? undefined : inT + outT);
        expect(ev?.cost).toEqual(v.cost);
        expect(ev?.usage).toEqual(v.usage);
      } else {
        const e = res.error;
        expect(ERROR_CODES).toContain(e.code);
        expect(e.message).toBe(makeError(e.code).message);
        expect(e.retryable).toBe(makeError(e.code).retryable);
        expect(e.warnings.every((w) => w.startsWith("USAGE_SINK"))).toBe(true);
        if (ev !== undefined) expect(ev.outcome).toBe(e.code);
        expect(JSON.stringify(e), `seed=${seed} ${scenario} نشت`).not.toContain("CANARY");
        expect(e.issues === undefined || e.code === "INVALID_REQUEST" || e.code === "PROVIDER_BAD_RESPONSE" || e.code === "UNKNOWN_MODEL").toBe(true);
      }
      for (const evt of events) expect(JSON.stringify(evt)).not.toContain("CANARY");
    }
    expect([...seen].sort()).toEqual(["auth", "bad", "hang-abort", "hang-timeout", "invalid-request", "ok", "rate", "rejected", "throw", "truncated", "unavailable", "unknown-model", "usage-missing"].sort());
  });

  it("پاسخ سالم با هر ترکیب ورودی/خروجی دقیقاً همان مصرف را به ثبت می‌رساند (بی‌گرد کردنِ پنهان)", async () => {
    const cases: Array<[number, number]> = [[0, 0], [1, 0], [0, 1], [1_000_000_000, 1_000_000_000], [123_456_789, 987_654_321]];
    for (const [i, o] of cases) {
      const t = rig([{ reply: { ...OK_REPLY, usage: { inputTokens: i, outputTokens: o } } }]);
      const res = await t.gw.complete(REQUEST);
      expect(res.ok && res.value.usage).toEqual({ inputTokens: i, outputTokens: o, totalTokens: i + o });
      expect(t.events[0]?.usage).toEqual({ inputTokens: i, outputTokens: o, totalTokens: i + o });
    }
  });
});
