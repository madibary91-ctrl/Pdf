/** ابزار مشترکِ آزمون‌های tool-call-deadline (از index صادر نمی‌شود). زمان مجازی است؛ هیچ تماسِ واقعی نیست. */
import type { Timers, ToolGateway, ToolStepResult } from "@/modules/ai-gateway";
import { createDeadlineToolGateway } from "./deadline";
import type { DeadlineEvent } from "./types";

export const MAX_CALL = 3000;
export const INPUT = Object.freeze({ model: "legal", messages: Object.freeze([Object.freeze({ role: "user", content: "abcd" })]) });

export type FakeTimers = Timers & {
  now(): number;
  pending(): number;
  cleared(): number;
  /** زمان را جلو می‌برد و هر تایمرِ سررسیده را به ترتیب اجرا می‌کند. */
  advance(ms: number): void;
  /** پس از این‌ها `setTimeout` می‌پرتابد. */
  failSet(): void;
  failClear(): void;
};

export function fakeTimers(): FakeTimers {
  let t = 0;
  let seq = 0;
  let cleared = 0;
  let failSet = false;
  let failClear = false;
  const queue = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => t,
    pending: () => queue.size,
    cleared: () => cleared,
    failSet: () => void (failSet = true),
    failClear: () => void (failClear = true),
    setTimeout(fn: () => void, ms: number): unknown {
      if (failSet) throw new Error("SECRET-TIMER-CANARY");
      seq += 1;
      queue.set(seq, { at: t + ms, fn });
      return seq;
    },
    clearTimeout(h: unknown): void {
      cleared += 1;
      if (failClear) throw new Error("SECRET-TIMER-CANARY");
      queue.delete(h as number);
    },
    advance(ms: number): void {
      const target = t + ms;
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null;
        for (const e of queue) if (e[1].at <= target && (next === null || e[1].at < next[1].at)) next = e;
        if (next === null) break;
        queue.delete(next[0]);
        t = Math.max(t, next[1].at);
        next[1].fn();
      }
      t = target;
    },
  };
}

export type Deferred<T> = { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void };
export function deferred<T>(): Deferred<T> {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export const cost = (micros: number) => ({ micros, currency: "IRR", priceVersion: "test-v1" });
export const stepOk = (micros: number | null): ToolStepResult =>
  ({
    ok: true,
    value: { text: "t", toolCalls: [], finish: "stop", assistantMessage: { role: "assistant", content: "t" }, format: "openai-chat", model: "legal", provider: "p", servedModel: null, requestId: null, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, cost: micros === null ? null : cost(micros), latencyMs: 1, warnings: [] },
  }) as unknown as ToolStepResult;
export const stepErr = (code: string, extra: Record<string, unknown> = {}): ToolStepResult =>
  ({ ok: false, error: { code, message: "m", retryable: false, warnings: [], usage: null, cost: null, ...extra } }) as unknown as ToolStepResult;

export type Seen = { input: unknown; options: { signal?: AbortSignal } | undefined };
type Reply = ToolStepResult | ((input: unknown, options: { signal?: AbortSignal } | undefined, index: number) => unknown | Promise<unknown>);

export function stub(reply: Reply): { gateway: ToolGateway; seen: Seen[]; formatCalls: string[]; limitCalls: string[] } {
  const seen: Seen[] = [];
  const formatCalls: string[] = [];
  const limitCalls: string[] = [];
  const gateway: ToolGateway = {
    completeStep: async (input, options) => {
      seen.push({ input, options });
      const i = seen.length - 1;
      return (typeof reply === "function" ? await reply(input, options, i) : reply) as ToolStepResult;
    },
    toolFormat: (m) => {
      formatCalls.push(m);
      return "openai-chat";
    },
    limits: (m) => {
      limitCalls.push(m);
      return { maxInputChars: 20_000, maxOutputTokens: 1000, priced: true };
    },
  };
  return { gateway, seen, formatCalls, limitCalls };
}

export function build(reply: Reply, over: Record<string, unknown> = {}) {
  const timers = fakeTimers();
  const events: DeadlineEvent[] = [];
  const inner = stub(reply);
  const made = createDeadlineToolGateway({ gateway: inner.gateway, maxCallMs: MAX_CALL, timers, onEvent: (e: DeadlineEvent) => void events.push(e), ...over });
  if (!made.ok) throw new Error(made.error.issues.join(";"));
  return { gw: made.value, timers, events, inner };
}

export const flush = async (rounds = 6): Promise<void> => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

/** بذرِ قطعی (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
