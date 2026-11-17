/**
 * ابزار آزمونِ برش ۲ (از index صادر نمی‌شود). `test-kit.ts` برش ۱ دست نمی‌خورد؛ این فایل فقط از آن می‌سازد.
 * همهٔ قیمت‌ها و نام‌ها **ساختگیِ آزمون**‌اند. زمان مجازی است: ساعت و تایمر با `drive` هم‌گام جلو می‌روند.
 */
import { createResilientGateway } from "./resilience";
import { FALLBACK_ELIGIBLE_CODES, RETRYABLE_CODES } from "./resilience-policy";
import type { RandomSource, ResilientGateway } from "./resilience-types";
import { ManualTimers, PRICE, manualClock, scriptedProvider } from "./test-kit";
import type { ManualClock, ScriptedProvider, Step } from "./test-kit";
import type { UsageEvent } from "./types";

/** مهلتِ مقصد مصرف در rig؛ عددی غیرمعمول تا از تایمرهای تلاش/انتظار جدا شناخته شود. */
export const SINK_MS = 4242;

export const tick = (): Promise<void> => new Promise<void>((r) => setTimeout(r, 0));

/** سیاست پایه: همه‌چیز صریح؛ ۳ تلاش، ۶ فراخوانی کل، backoff ۱۰۰ تا ۱۰۰۰ بدون jitter، بدون جایگزین. */
export const BASE_POLICY = {
  maxAttemptsPerModel: 3,
  maxTotalAttempts: 6,
  totalTimeoutMs: 100_000,
  backoff: { baseDelayMs: 100, maxDelayMs: 1000, jitter: "none" },
  retryOn: [...RETRYABLE_CODES],
  fallbackOn: [...FALLBACK_ELIGIBLE_CODES],
  fallbacks: {},
} as const;

export type KitModel = Readonly<{ steps: readonly Step[]; model?: Record<string, unknown> }>;
export type RRig = Readonly<{
  gw: ResilientGateway;
  providers: Record<string, ScriptedProvider>;
  timers: ManualTimers;
  clock: ManualClock;
  events: UsageEvent[];
  /** مجموع فراخوانی‌های رسیده به همهٔ ارائه‌دهنده‌ها. */
  totalCalls: () => number;
  /** مدت‌های همهٔ `setTimeout`های تزریقی به‌جز تایمر مقصد مصرف (مهلت تلاش‌ها و انتظارهای backoff). */
  timerCalls: () => number[];
}>;

/**
 * هر کلیدِ `models` یک مدل منطقی با ارائه‌دهندهٔ سناریویی و جدای خودش می‌سازد (مدل `mN` ← ارائه‌دهندهٔ `pN`).
 * `policy` روی `BASE_POLICY` ادغام می‌شود؛ `config` روی پیکربندی هسته.
 */
export function rrig(models: Readonly<Record<string, KitModel>>, policy: Record<string, unknown> = {}, config: Record<string, unknown> = {}): RRig {
  const providers: Record<string, ScriptedProvider> = {};
  const specs: Record<string, unknown> = {};
  for (const [name, m] of Object.entries(models)) {
    const pname = `p-${name}`;
    providers[pname] = scriptedProvider(m.steps);
    specs[name] = { provider: pname, providerModel: `provider-${name}`, maxInputChars: 10_000, maxOutputTokens: 4096, price: PRICE, ...(m.model ?? {}) };
  }
  const timers = new ManualTimers();
  const clock = manualClock();
  const events: UsageEvent[] = [];
  const g = createResilientGateway({ providers, models: specs, clock, timers, usageSink: { record: (e: UsageEvent) => void events.push(e) }, sinkTimeoutMs: SINK_MS, ...config }, { ...BASE_POLICY, ...policy });
  if (!g.ok) throw new Error(`rrig config rejected: ${JSON.stringify(g.error.issues)}`);
  return { gw: g.value, providers, timers, clock, events, totalCalls: () => Object.values(providers).reduce((n, p) => n + p.calls.length, 0), timerCalls: () => timers.setCalls.filter((ms) => ms !== SINK_MS) };
}

/** زمان مجازی را (ساعت + تایمر) پله‌پله جلو می‌برد تا وعده تمام شود. `onStep` برای تزریقِ رویداد (مثلاً لغو) در پله‌ای مشخص. */
export async function drive<T>(p: Promise<T>, t: Readonly<{ timers: ManualTimers; clock: ManualClock }>, stepMs = 100, onStep?: (i: number) => void, maxSteps = 5000): Promise<T> {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < maxSteps && !done; i++) {
    await tick();
    if (done) break;
    onStep?.(i);
    t.clock.t += stepMs;
    t.timers.advance(stepMs);
  }
  return p;
}

/** منبع تصادف قطعی از دنباله‌ای ثابت (پس از پایان، آخرین مقدار تکرار می‌شود). */
export function seqRandom(values: readonly unknown[]): RandomSource & { calls: number } {
  const r = {
    calls: 0,
    next: (): number => {
      const v = values[Math.min(r.calls, values.length - 1)];
      r.calls++;
      return v as number;
    },
  };
  return r;
}
