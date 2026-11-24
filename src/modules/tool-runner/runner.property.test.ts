import { describe, expect, it } from "vitest";
import { TRUNCATED_TOOL_CALL_ISSUE } from "@/modules/ai-gateway";
import { RUN_INPUT, call, cost, fakeTimers, makeLoop, makeRunner, stepErr, stepOk, stubGateway, tick, usage } from "./test-kit";
import type { RunReport, ToolExecutor } from "./types";

/** تولیدکنندهٔ قطعیِ شبه‌تصادفی (بذردار)؛ آزمون هیچ‌گاه flaky نیست. */
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

const TOOL_MS = 777;
const TOTAL_MS = 99_999;

type Seen = Readonly<{ label: string; aborted: boolean; codes: readonly (string | null)[] }>;

async function scenario(seed: number): Promise<Seen> {
  const rand = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const f = fakeTimers();
  const abortAt = rand() < 0.3 ? Math.floor(rand() * 8) : -1;
  const ac = new AbortController();
  let events = 0;
  const tickAbort = (): void => {
    if (events++ === abortAt) ac.abort();
  };

  let idn = 0;
  let stepNo = 0;
  const steps: unknown[] = [];
  const makeStep = (): unknown => {
    const r = rand();
    if (r < 0.5) {
      const n = 1 + Math.floor(rand() * 3);
      const calls = Array.from({ length: n }, () => call(`c${seed}_${++idn}`, { v: idn }, pick(["court_fee", "late_payment", "court_fee", "ghost"])));
      return stepOk({ calls, cost: cost(10 + Math.floor(rand() * 5)) });
    }
    if (r < 0.7) return stepOk({ text: `پاسخ ${stepNo}`, cost: cost(3) });
    if (r < 0.78) return stepOk({ text: "", cost: cost(3) });
    if (r < 0.85) {
      const e = stepErr("PROVIDER_BAD_RESPONSE", { usage: usage(1, 1), cost: cost(2) });
      (e as { error: { issues: string[] } }).error.issues = [TRUNCATED_TOOL_CALL_ISSUE, "x"];
      return e;
    }
    if (r < 0.92) return stepErr(pick(["PROVIDER_UNAVAILABLE", "TIMEOUT", "PROVIDER_AUTH"]), { usage: null, cost: null });
    return "THROW";
  };

  let gatewayCalls = 0;
  const { gateway } = stubGateway(async () => {
    tickAbort();
    gatewayCalls++;
    const s = steps[stepNo] ?? (steps[stepNo] = makeStep());
    stepNo++;
    await tick(1 + Math.floor(rand() * 3));
    if (s === "THROW") throw new Error("boom");
    return s;
  });

  const executed: string[] = [];
  const exec: ToolExecutor = async (c) => {
    tickAbort();
    executed.push(c.name);
    const r = rand();
    if (r < 0.45) return { ok: true, content: `{"id":"${c.id}"}`, reviewPending: rand() < 0.5 };
    if (r < 0.55) return { ok: false, content: '{"error":"x"}' };
    if (r < 0.65) throw new Error("tool-boom");
    if (r < 0.72) return { ok: true, content: "x".repeat(5000), reviewPending: true };
    if (r < 0.78) return 5 as never;
    if (r < 0.9) return new Promise(() => {}); // معلق ⇒ مهلتِ ابزار
    await tick(2);
    return { ok: true, content: "late", reviewPending: false };
  };

  const loop = makeLoop({ maxSteps: 2 + Math.floor(rand() * 5), maxToolCalls: 4 + Math.floor(rand() * 10), maxIdenticalCalls: 1 + Math.floor(rand() * 3), truncationRetries: Math.floor(rand() * 3) });
  const runner = makeRunner({ gateway, loop, executeTool: exec, timers: f.timers, toolTimeoutMs: TOOL_MS, totalTimeoutMs: TOTAL_MS, maxResultChars: 4000 });

  let settled: Awaited<ReturnType<typeof runner.run>> | null = null;
  const p = runner.run(RUN_INPUT, { signal: ac.signal }).then((r) => (settled = r));
  for (let guard = 0; guard < 4000 && settled === null; guard++) {
    await tick(3);
    if (settled !== null) break;
    // معلق‌ها را با ساعتِ دستی جلو می‌بریم: مهلتِ ابزار، سپس فرجهٔ لغو.
    if (f.pendingMs().includes(TOOL_MS)) f.fire(TOOL_MS);
    else if (f.pendingMs().includes(2_000)) f.fire(2_000);
  }
  await p;
  const res = settled as Awaited<ReturnType<typeof runner.run>> | null;
  const tag = `seed=${seed}`;
  expect(res, tag).not.toBeNull();
  if (res === null) throw new Error(tag);
  expect(res.ok, `${tag} ${JSON.stringify(res)}`).toBe(true);
  if (!res.ok) throw new Error(tag);
  const out: RunReport = res.value;

  expect(f.pending(), `${tag}: تایمرِ باقی‌مانده`).toBe(0);
  expect(out.outcome.steps, `${tag}: گام‌ها = تماس‌های دروازه`).toBe(gatewayCalls);
  expect(out.outcome.spend.steps, tag).toBe(out.outcome.steps);
  expect(new Set(out.toolRuns.map((r) => r.id)).size, `${tag}: شناسهٔ تکراری`).toBe(out.toolRuns.length);
  expect(out.toolRuns.length, tag).toBeLessThanOrEqual(out.outcome.toolCalls);
  // ابزارِ بیرون از فهرست هرگز به پورت نمی‌رسد.
  expect(executed.includes("ghost"), tag).toBe(false);
  expect(out.toolRuns.filter((r) => r.code !== "UNKNOWN_TOOL").length, tag).toBeGreaterThanOrEqual(executed.length);
  if (abortAt < 0) {
    expect(out.abortedBy, tag).toBeNull();
    expect(out.toolRuns.length, tag).toBe(out.outcome.toolCalls);
    expect(out.outcome.reviewPending, `${tag}: reviewPending`).toBe(out.toolRuns.some((r) => r.reviewPending));
    if (out.outcome.status === "stopped") expect(out.outcome.reason, tag).not.toBe("CANCELLED");
  }
  if (out.outcome.status === "stopped") expect(Object.keys(out.outcome).includes("text"), tag).toBe(false);
  return { label: out.outcome.status === "answered" ? "answered" : out.outcome.reason, aborted: out.abortedBy !== null, codes: out.toolRuns.map((r) => r.code) };
}

describe("tool-runner · آزمونِ تصادفیِ قطعی (۳۰۰ بذر)", () => {
  it("هر سناریو: بسته می‌شود، نمی‌پرد، تایمر نمی‌ماند، شمارش‌ها و reviewPending سازگارند، ابزارِ ناشناخته اجرا نمی‌شود", async () => {
    const seen: Seen[] = [];
    for (let seed = 1; seed <= 300; seed++) seen.push(await scenario(seed));
    // پوششِ واقعیِ فضای حالت (اگر مولد تنوع نداشته باشد، این آزمون بی‌ارزش است).
    const labels = new Set(seen.map((s) => s.label));
    for (const l of ["answered", "MAX_STEPS", "STEP_FAILED", "CANCELLED", "EMPTY_ANSWER"]) expect(labels.has(l), `پوشش: ${l} (${[...labels].join()})`).toBe(true);
    expect(seen.filter((s) => s.aborted).length).toBeGreaterThan(20);
    const codes = new Set(seen.flatMap((s) => s.codes));
    for (const c of ["TOOL_TIMEOUT", "TOOL_FAILED", "TOOL_RESULT_TOO_LARGE", "TOOL_RESULT_INVALID", "TOOL_REPORTED_ERROR", "UNKNOWN_TOOL", "TOOL_ABORTED", null]) expect(codes.has(c as never), `پوششِ کد: ${String(c)}`).toBe(true);
  }, 60_000);
});
