/** ابزار مشترکِ آزمون‌های tool-policy-source (از index صادر نمی‌شود). */
import { resolveToolPolicy, timingFromGrace, type ToolPolicy } from "@/modules/tool-policy";
import type { AdminResult, CurrentPolicy } from "@/modules/tool-policy-admin";
import { createPolicySource } from "./source";
import type { PolicyReader, PolicySource } from "./types";

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

export function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    nowMs: (): number => t,
    advance(ms: number): void {
      t += ms;
    },
    set(v: number): void {
      t = v;
    },
  };
}

export const MAX_STALE = 60_000;
export const REFRESH_TIMEOUT = 5_000;

/** سطح‌های سازگارِ سیاست (گریس، مهلتِ مدل): هر سطح یک سیاستِ مؤثرِ متفاوت و معتبر. */
export const LEVELS: readonly (readonly [number, number])[] = [
  [60_000, 20_000],
  [90_000, 30_000],
  [120_000, 40_000],
  [150_000, 50_000],
];

export function overridesFor(level: number): { timing: Record<string, number>; model: { timeoutMs: number } } {
  const [grace, model] = LEVELS[level % LEVELS.length]!;
  const t = timingFromGrace(grace);
  if (!t.ok) throw new Error("level");
  return { timing: { ...t.value }, model: { timeoutMs: model } };
}

export function policyFor(level: number): ToolPolicy {
  const r = resolveToolPolicy(overridesFor(level));
  if (!r.ok) throw new Error("policyFor");
  return r.value;
}

export function defaultsPolicy(): ToolPolicy {
  const r = resolveToolPolicy(undefined);
  if (!r.ok) throw new Error("defaults");
  return r.value;
}

/** پاسخِ معتبرِ `current()` مدیر برای یک نسخه و سطح (نسخهٔ ۰ ⇒ پیش‌فرض‌های کد). */
export function okCurrent(version: number, level = version, extra: Partial<CurrentPolicy> = {}): AdminResult<CurrentPolicy> {
  const stored = version > 0;
  return {
    ok: true,
    value: {
      version,
      source: stored ? "stored" : "defaults",
      policy: stored ? policyFor(level) : defaultsPolicy(),
      overrides: stored ? (overridesFor(level) as never) : {},
      drift: false,
      updatedAtMs: stored ? 1000 + version : null,
      ...extra,
    },
  };
}

export const adminFail = (code: string): AdminResult<CurrentPolicy> =>
  ({ ok: false, error: { code, message: "x", issues: [], currentVersion: null } }) as unknown as AdminResult<CurrentPolicy>;

/** خواننده‌ای که هر فراخوانی را یک وعدهٔ دستی می‌دهد. */
export function controlledReader() {
  const pending: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  const reader: PolicyReader = {
    current: () => new Promise((resolve, reject) => void pending.push({ resolve: resolve as (v: unknown) => void, reject })) as Promise<AdminResult<CurrentPolicy>>,
  };
  return { reader, pending, calls: (): number => pending.length };
}

/** خواننده‌ای که گام‌های از‌پیش‌نوشته را به ترتیب می‌دهد (تابع ⇒ فراخوانی؛ ممکن است همگام بپرتابد). */
export function scriptedReader(steps: readonly unknown[]) {
  let i = 0;
  const state = { calls: 0 };
  const reader: PolicyReader = {
    current: () => {
      state.calls += 1;
      const s = steps[Math.min(i, steps.length - 1)];
      i += 1;
      const v = typeof s === "function" ? (s as () => unknown)() : s;
      return Promise.resolve(v) as Promise<AdminResult<CurrentPolicy>>;
    },
  };
  return { reader, state };
}

export function newSource(reader: PolicyReader, clock = fakeClock(), extra: Record<string, unknown> = {}): { source: PolicySource; clock: ReturnType<typeof fakeClock> } {
  const r = createPolicySource({ reader, clock, maxStaleMs: MAX_STALE, refreshTimeoutMs: REFRESH_TIMEOUT, ...extra });
  if (!r.ok) throw new Error(`createPolicySource: ${r.error.issues.join(",")}`);
  return { source: r.value, clock };
}

export function deepFrozen(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return true;
  if (!Object.isFrozen(v)) return false;
  return Object.values(v).every(deepFrozen);
}

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
