/**
 * ابزار آزمون ai-gateway (از index صادر نمی‌شود): تایمر و ساعتِ دستی، ارائه‌دهندهٔ سناریویی، و ساختِ دروازه.
 * همهٔ قیمت‌ها **ساختگیِ آزمون**‌اند و هیچ ارتباطی با قیمت واقعیِ هیچ ارائه‌دهنده‌ای ندارند.
 */
import { createGateway } from "./gateway";
import type { Clock, Gateway, ModelProvider, PriceSpec, ProviderCall, Timers, UsageEvent } from "./types";

export class ManualTimers implements Timers {
  private now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; fn: () => void }>();
  readonly setCalls: number[] = [];
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.setCalls.push(ms);
    this.tasks.set(id, { at: this.now + ms, fn });
    return id;
  };
  clearTimeout = (h: unknown): void => {
    this.tasks.delete(h as number);
  };
  get pending(): number {
    return this.tasks.size;
  }
  /** زمان مجازی را جلو می‌برد و تایمرهای سررسیده را به ترتیب اجرا می‌کند. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (due === undefined) break;
      this.tasks.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
    }
    this.now = target;
  }
}

export type ManualClock = Clock & { t: number };
export const manualClock = (start = 1_700_000_000_000): ManualClock => {
  const c = { t: start, nowMs: () => c.t };
  return c;
};

export type Step =
  | Readonly<{ reply: unknown }>
  | Readonly<{ fail: unknown }>
  | Readonly<{ hang: true }>
  | Readonly<{ run: (call: ProviderCall) => unknown }>;

export type ScriptedProvider = ModelProvider & { calls: ProviderCall[] };

/** ارائه‌دهندهٔ سناریویی: هر فراخوانی یک گام را مصرف می‌کند؛ تمام‌شدن سناریو بلند شکست می‌خورد. `hang` با لغو رد می‌شود. */
export function scriptedProvider(steps: readonly Step[]): ScriptedProvider {
  const calls: ProviderCall[] = [];
  let i = 0;
  return {
    calls,
    complete(call: ProviderCall) {
      calls.push(call);
      const step = steps[i++];
      if (step === undefined) return Promise.reject(new Error("scripted provider: script exhausted"));
      if ("fail" in step) return Promise.reject(step.fail);
      if ("hang" in step) {
        return new Promise((_, reject) => call.signal.addEventListener("abort", () => reject(new Error("aborted by gateway")), { once: true }));
      }
      if ("run" in step) return Promise.resolve().then(() => step.run(call)) as Promise<never>;
      return Promise.resolve(step.reply) as Promise<never>;
    },
  };
}

export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const PRICE: PriceSpec = { currency: "IRR", inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000, version: "test-prices-v1" };
export const OK_REPLY = { text: "پاسخ آزمایشی", finishReason: "stop", usage: { inputTokens: 1000, outputTokens: 500 }, model: "served-model-1" } as const;
export const REQUEST = { model: "m1", messages: [{ role: "user", content: "سلام" }], maxOutputTokens: 100 } as const;

export type Rig = Readonly<{ gw: Gateway; provider: ScriptedProvider; timers: ManualTimers; clock: ManualClock; events: UsageEvent[] }>;

export function rig(steps: readonly Step[] = [{ reply: OK_REPLY }], over: Record<string, unknown> = {}, modelOver: Record<string, unknown> = {}): Rig {
  const provider = scriptedProvider(steps);
  const timers = new ManualTimers();
  const clock = manualClock();
  const events: UsageEvent[] = [];
  const config = {
    providers: { p1: provider },
    models: { m1: { provider: "p1", providerModel: "provider-model-1", maxInputChars: 10_000, maxOutputTokens: 4096, price: PRICE, ...modelOver } },
    clock,
    timers,
    usageSink: { record: (e: UsageEvent) => void events.push(e) },
    ...over,
  };
  const g = createGateway(config);
  if (!g.ok) throw new Error(`rig config rejected: ${JSON.stringify(g.error.issues)}`);
  return { gw: g.value, provider, timers, clock, events };
}
