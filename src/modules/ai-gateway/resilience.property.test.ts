import { describe, expect, it } from "vitest";
import { ERROR_CODES, FALLBACK_ELIGIBLE_CODES, ProviderFailure, RETRYABLE_CODES } from "./index";
import { makeError } from "./errors";
import { drive, rrig, seqRandom } from "./resilience-kit";
import type { Step } from "./test-kit";
import { PRICE, REQUEST } from "./test-kit";
import type { ResilientResult } from "./index";

const CANARY = "CANARY-نشت-نباید-شود";
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const WARNINGS = new Set(["USAGE_MISSING", "UNPRICED", "OUTPUT_TRUNCATED", "EMPTY_OUTPUT", "USAGE_SINK_FAILED", "USAGE_SINK_TIMEOUT", "RETRIED", "FELL_BACK"]);

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T, chance: (p: number) => next() < p };
}

const USD = { currency: "USD", inputMicrosPerMTok: 1_000_000, outputMicrosPerMTok: 2_000_000, version: "test-usd" };
type Scenario = "ok" | "usage-missing" | "truncated" | "rate" | "unavailable" | "auth" | "rejected" | "throw" | "bad" | "bad-usage" | "hang";
const SCENARIOS: readonly Scenario[] = ["ok", "ok", "usage-missing", "truncated", "rate", "rate", "unavailable", "unavailable", "auth", "rejected", "throw", "bad", "bad-usage", "hang"];

describe("ai-gateway · تاب‌آوری · پایداری تصادفی (۲۰۰ بذر): ناورداهای تلاش/جایگزین/هزینه", () => {
  it("بی‌پرتاب، بی‌نشت، بودجه‌ها رعایت، هر فراخوانی یک رویداد، هزینه در برابر اوراکلِ رویدادها، انتظارها در حدود", async () => {
    const seenStops = new Set<string>();
    const seen = { retried: 0, fellBack: 0, skipped: 0, waited: 0, retryAfterChecked: 0, spendNull: 0 };

    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const nModels = r.int(1, 4);
      const names = ["m1", "m2", "m3", "m4"].slice(0, nModels);
      const maxAttemptsPerModel = r.int(1, 4);
      const maxTotalAttempts = r.int(1, 8);
      const totalTimeoutMs = r.pick([500, 3000, 20_000]);
      const baseDelayMs = r.int(0, 300);
      const maxDelayMs = baseDelayMs + r.int(0, 1700);
      const jitter = r.pick(["none", "full", "equal"] as const);
      const retryOn = maxAttemptsPerModel > 1 ? RETRYABLE_CODES.filter(() => r.chance(0.7)) : [...RETRYABLE_CODES].filter(() => r.chance(0.5));
      if (maxAttemptsPerModel > 1 && retryOn.length === 0) retryOn.push("PROVIDER_UNAVAILABLE");
      let fallbackOn = FALLBACK_ELIGIBLE_CODES.filter(() => r.chance(0.6));
      if (nModels > 1 && fallbackOn.length === 0) fallbackOn = ["PROVIDER_AUTH"];
      const randomValues = [r.next(), r.next(), r.pick([Number.NaN, 2, -1, 0, 1, 0.5] as const)];

      const scripts: Record<string, Step[]> = {};
      const retryAfters: Record<string, Array<number | null>> = {};
      const models: Record<string, { steps: Step[]; model: Record<string, unknown> }> = {};
      for (const name of names) {
        const steps: Step[] = [];
        const ras: Array<number | null> = [];
        for (let i = r.int(0, 5); i > 0; i--) {
          const sc = r.pick(SCENARIOS);
          let ra: number | null = null;
          const usage = { inputTokens: r.int(0, 3_000_000), outputTokens: r.int(0, 3_000_000) };
          steps.push(
            sc === "ok" ? { reply: { text: "پاسخ", finishReason: "stop", usage } }
            : sc === "usage-missing" ? { reply: { text: "پاسخ", finishReason: "stop" } }
            : sc === "truncated" ? { reply: { text: "پا", finishReason: "length", usage } }
            : sc === "rate" ? ((ra = r.chance(0.5) ? r.int(0, 3000) : null), { fail: new ProviderFailure("rate_limited", { ...(ra === null ? {} : { retryAfterMs: ra }), cause: new Error(CANARY) }) })
            : sc === "unavailable" ? { fail: new ProviderFailure("unavailable", { cause: CANARY }) }
            : sc === "auth" ? { fail: new ProviderFailure("auth") }
            : sc === "rejected" ? { fail: new ProviderFailure("rejected") }
            : sc === "throw" ? { fail: new Error(CANARY) }
            : sc === "bad" ? { reply: { text: CANARY, finishReason: "weird" } }
            : sc === "bad-usage" ? { reply: { text: 9, finishReason: "stop", usage } }
            : { hang: true },
          );
          ras.push(ra);
        }
        scripts[name] = steps;
        retryAfters[name] = ras;
        const priced = r.pick(["irr", "irr", "usd", "none"] as const);
        models[name] = {
          steps,
          model: { timeoutMs: 1000, price: priced === "irr" ? PRICE : priced === "usd" ? USD : null, ...(name !== "m1" && r.chance(0.25) ? { maxOutputTokens: 50 } : {}) },
        };
      }

      const t = rrig(models, {
        maxAttemptsPerModel,
        maxTotalAttempts,
        totalTimeoutMs,
        backoff: { baseDelayMs, maxDelayMs, jitter },
        retryOn,
        fallbackOn,
        fallbacks: nModels > 1 ? { m1: names.slice(1) } : {},
        random: seqRandom(randomValues),
      });
      const ctl = new AbortController();
      const abortAt = r.chance(0.25) ? r.int(0, 8) : -1;
      const res: ResilientResult = await drive(t.gw.complete({ ...REQUEST, requestId: `s${seed}` }, { signal: ctl.signal }), t, 250, (i) => {
        if (i === abortAt) ctl.abort();
      });

      const ctx = `seed=${seed}`;
      const report = res.ok ? res.value.report : res.error.report;
      const attempts = report.attempts;
      seenStops.add(report.stoppedBecause);

      // ۱) هر فراخوانیِ رسیده به ارائه‌دهنده دقیقاً یک رویداد (و هر رویداد یک فراخوانی)
      const calls = t.totalCalls();
      expect(t.events.length, `${ctx} رویداد=فراخوانی`).toBe(calls);
      expect(attempts.filter((a) => a.reachedProvider).length, `${ctx} report=فراخوانی`).toBe(calls);

      // ۲) بودجه‌ها
      expect(calls, `${ctx} سقف کل`).toBeLessThanOrEqual(maxTotalAttempts);
      for (const name of names) expect(t.providers[`p-${name}`]?.calls.length ?? 0, `${ctx} سقف ${name}`).toBeLessThanOrEqual(maxAttemptsPerModel);
      expect(t.timers.pending, `${ctx} تایمر نشتی`).toBe(0);

      // ۳) انسجام ردپا
      attempts.forEach((a, i) => expect(a.index, ctx).toBe(i + 1));
      for (const name of names) {
        const mine = attempts.filter((a) => a.model === name);
        mine.forEach((a, i) => expect(a.modelAttempt, `${ctx} ${name}`).toBe(i + 1));
        if (name !== "m1" && mine.length > 0) expect(attempts.findIndex((a) => a.model === name), ctx).toBeGreaterThan(attempts.findIndex((a) => a.model === "m1"));
      }
      if (res.ok) {
        expect(report.stoppedBecause, ctx).toBe("success");
        expect(attempts[attempts.length - 1]?.outcome, ctx).toBe("ok");
        expect(attempts.slice(0, -1).every((a) => a.outcome !== "ok"), ctx).toBe(true);
      } else {
        expect(report.stoppedBecause, ctx).not.toBe("success");
        expect(ERROR_CODES, ctx).toContain(res.error.code);
        expect(res.error.message, ctx).toBe(makeError(res.error.code).message);
        const lastReached = [...attempts].reverse().find((a) => a.reachedProvider);
        if (report.stoppedBecause === "aborted") expect(res.error.code, ctx).toBe("ABORTED");
        else if (lastReached !== undefined) expect(res.error.code, `${ctx} خطای آخرین تلاشِ رسیده`).toBe(lastReached.outcome);
      }

      // ۴) انتظارها: نخستین تلاشِ هر مدل ۰؛ همه ≤ maxDelayMs؛ بعد از rate_limited با retryAfter: ≥ آن (هرگز زودتر)
      attempts.forEach((a, i) => {
        if (a.modelAttempt === 1) expect(a.waitedMs, `${ctx} نخستین تلاش بی‌انتظار`).toBe(0);
        expect(a.waitedMs, `${ctx} سقف انتظار`).toBeLessThanOrEqual(maxDelayMs);
        if (a.waitedMs > 0) seen.waited++;
        const prev = attempts[i - 1];
        if (a.modelAttempt > 1 && prev !== undefined && prev.model === a.model) {
          const ra = retryAfters[a.model]?.[a.modelAttempt - 2];
          if (prev.outcome === "PROVIDER_RATE_LIMITED" && typeof ra === "number") {
            expect(a.waitedMs, `${ctx} retryAfter=${ra}`).toBeGreaterThanOrEqual(ra);
            seen.retryAfterChecked++;
          }
        }
      });

      // ۵) هزینه در برابر اوراکلِ مستقل (از خودِ رویدادها، نه از report)
      const sums = new Map<string, bigint>();
      for (const e of t.events) if (e.cost !== null) sums.set(e.cost.currency, (sums.get(e.cost.currency) ?? BigInt(0)) + BigInt(e.cost.micros));
      const expectedSpend = [...sums].map(([currency, total]) => ({ currency, micros: total <= MAX_SAFE ? Number(total) : null })).sort((x, y) => x.currency.localeCompare(y.currency));
      expect([...report.spend].sort((x, y) => x.currency.localeCompare(y.currency)), `${ctx} spend`).toEqual(expectedSpend);
      expect(report.costUnknownAttempts, `${ctx} نامعلوم`).toBe(t.events.filter((e) => e.cost === null).length);
      if (report.spend.some((s) => s.micros === null)) seen.spendNull++;

      // ۶) هشدارها
      const ws = res.ok ? res.value.warnings : res.error.warnings;
      expect(new Set(ws).size, `${ctx} هشدار تکراری`).toBe(ws.length);
      for (const w of ws) expect(WARNINGS.has(w), `${ctx} ${w}`).toBe(true);
      const reachedAttempts = attempts.filter((a) => a.reachedProvider);
      const retried = reachedAttempts.some((a) => a.modelAttempt > 1);
      const fellBack = reachedAttempts.some((a) => a.model !== "m1");
      expect(ws.includes("RETRIED"), `${ctx} RETRIED`).toBe(retried);
      expect(ws.includes("FELL_BACK"), `${ctx} FELL_BACK`).toBe(fellBack);
      if (retried) seen.retried++;
      if (fellBack) seen.fellBack++;
      if (attempts.some((a) => !a.reachedProvider && a.outcome === "INVALID_REQUEST")) seen.skipped++;

      // ۷) بی‌نشت
      expect(JSON.stringify(res.ok ? res.value.report : res.error), `${ctx} نشت در خطا/گزارش`).not.toContain("CANARY");
      expect(JSON.stringify(t.events)).not.toContain("CANARY");
    }

    // پوششِ سناریوها: پایداری بی‌معنا می‌شود اگر فقط یک مسیر دیده شود
    for (const reason of ["success", "attempts_exhausted", "chain_exhausted", "non_retryable", "aborted", "budget_exhausted"]) expect(seenStops.has(reason), `علت توقف دیده نشد: ${reason}`).toBe(true);
    expect(seen.retried).toBeGreaterThan(10);
    expect(seen.fellBack).toBeGreaterThan(10);
    expect(seen.skipped).toBeGreaterThan(0);
    expect(seen.waited).toBeGreaterThan(10);
    expect(seen.retryAfterChecked).toBeGreaterThan(0);
  });
});
