/** ۴۰۰ ورودیِ قطعی (بذرِ ثابت): هر خروجی برای داوریِ tool-runner معتبر است و هر دو شاخه (موفق/خطا) و هر دو ابزار واقعاً دیده می‌شوند. */
import { describe, expect, it } from "vitest";
import { judgeExecution } from "@/modules/tool-runner";
import { COURT_ARGS, LATE_ARGS, callOf, makeExecutor, parse, runSync } from "./test-kit";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const JUNK: readonly unknown[] = [null, true, false, 0, -1, 1.5, 2 ** 60, Number.MAX_SAFE_INTEGER, "", "x", "۱۰۰", "\u0000", "\ud800", [], {}, [1, 2], { a: { b: [] } }];

function mutate(value: unknown, r: () => number, depth = 0): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return JUNK[Math.floor(r() * JUNK.length)];
  const o: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  const keys = Object.keys(o);
  const pick = r();
  if (pick < 0.15) o[`extra${Math.floor(r() * 5)}`] = JUNK[Math.floor(r() * JUNK.length)];
  else if (pick < 0.3 && keys.length > 0) delete o[keys[Math.floor(r() * keys.length)]!];
  else if (keys.length > 0) {
    const k = keys[Math.floor(r() * keys.length)]!;
    o[k] = depth < 3 && r() < 0.6 ? mutate(o[k], r, depth + 1) : JUNK[Math.floor(r() * JUNK.length)];
  }
  return o;
}

describe("calc-tool-executor: تصادفیِ قطعی (۴۰۰ بذر)", () => {
  const exec = makeExecutor();

  it("هر ورودی: همگام، بی‌پرتاب، شکلِ نتیجه برای مجری معتبر، reviewPending بولین و true، بی‌بازتابِ استثنا", () => {
    let okCount = 0;
    let errCount = 0;
    const tools = new Set<string>();
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const name = r() < 0.5 ? "court_fee" : "late_payment";
      const base = name === "court_fee" ? COURT_ARGS : LATE_ARGS;
      const roll = r();
      const valid = name === "court_fee" ? { ...COURT_ARGS, claim: { kind: "known", amountRials: 1 + Math.floor(r() * 1e10) } } : { ...LATE_ARGS, principalRials: 1 + Math.floor(r() * 1e10) };
      const argumentsJson = roll < 0.08 ? "x".repeat(Math.floor(r() * 200)) : roll < 0.12 ? "" : roll < 0.4 ? JSON.stringify(valid) : JSON.stringify(mutate(roll < 0.7 ? base : mutate(base, r), r));
      const out = runSync(exec, callOf(name, argumentsJson ?? "null"));
      const verdict = judgeExecution(out, 20_000);
      expect(verdict.code === null || verdict.code === "TOOL_REPORTED_ERROR", `seed ${seed}: ${String(verdict.code)}`).toBe(true);
      const c = parse(out);
      if (out.ok) {
        okCount++;
        tools.add(name);
        expect(out.reviewPending, `seed ${seed}`).toBe(true);
        expect(c["reviewPending"]).toBe(true);
        expect(c["tool"]).toBe(name);
      } else {
        errCount++;
        expect(Object.keys(c)).toEqual(["error"]);
        expect(JSON.stringify(c)).not.toMatch(/\bat\s.+\.ts|Error:/);
      }
    }
    // پوششِ فضای حالت: اگر جهش‌ها همه خطا یا همه موفق بودند، آزمون بی‌ارزش می‌شد.
    expect(okCount).toBeGreaterThan(40);
    expect(errCount).toBeGreaterThan(100);
    expect([...tools].sort()).toEqual(["court_fee", "late_payment"]);
  });
});
