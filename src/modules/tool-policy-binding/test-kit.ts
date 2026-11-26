/** ابزار مشترکِ آزمون‌های tool-policy-binding (از index صادر نمی‌شود). همهٔ مقدارها ساختگیِ آزمون‌اند. */
import { projectToolPolicy, timingFromGrace, type PolicyProjection } from "@/modules/tool-policy";
import { createPolicyBinding } from "./binding";
import type { BindingEvent, PolicyBinding } from "./types";

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

/** هر سطح یک سیاستِ معتبر و متفاوت می‌دهد (گریس و مهلتِ مدل). */
export const LEVELS: readonly (readonly [number, number])[] = [
  [60_000, 20_000],
  [90_000, 30_000],
  [120_000, 40_000],
  [150_000, 50_000],
];

export function projectionFor(level: number): PolicyProjection {
  const [grace, model] = LEVELS[level % LEVELS.length]!;
  const t = timingFromGrace(grace);
  if (!t.ok) throw new Error("timing");
  const r = projectToolPolicy({ timing: { ...t.value }, model: { timeoutMs: model } });
  if (!r.ok) throw new Error("projection");
  return r.value;
}

export const defaultsProjection = (): PolicyProjection => {
  const r = projectToolPolicy(undefined);
  if (!r.ok) throw new Error("defaults");
  return r.value;
};

/** نسخهٔ ۰ ⇒ پیش‌فرض‌های کد؛ وگرنه ذخیره‌شده با سطحِ مشخص. */
export function snapOk(version: number, level = version, over: Record<string, unknown> = {}): unknown {
  const stored = version > 0;
  return {
    ok: true,
    value: { version, source: stored ? "stored" : "defaults", projection: stored ? projectionFor(level) : defaultsProjection(), drift: false, loadedAtMs: 1, confirmedAtMs: 2, ageMs: 5, ...over },
  };
}
export const snapErr = (code: string): unknown => ({ ok: false, error: { code, message: "x" } });

/** منبعِ ساختگی: `next` را می‌توان عوض کرد؛ تابع ⇒ فراخوانی (ممکن است بپرتابد). */
export function fakeSource(initial: unknown) {
  const state: { next: unknown; calls: number } = { next: initial, calls: 0 };
  return {
    state,
    source: {
      snapshot: (): unknown => {
        state.calls += 1;
        return typeof state.next === "function" ? (state.next as () => unknown)() : state.next;
      },
    },
  };
}

/** سازندهٔ ساختگی: نمونهٔ `{ id }` می‌دهد و ورودی‌ها را ثبت می‌کند. */
export const RAW_UNDEFINED = Symbol("raw-undefined");

export function fakeBuild(over: { fail?: (n: number) => unknown } = {}) {
  const calls: PolicyProjection[] = [];
  return {
    calls,
    build: (p: PolicyProjection): unknown => {
      calls.push(p);
      if (over.fail !== undefined) {
        const f = over.fail(calls.length);
        if (f === RAW_UNDEFINED) return undefined;
        if (f !== undefined) return f;
      }
      return { ok: true, value: { id: calls.length } };
    },
  };
}

export function newBinding(initial: unknown, over: { observer?: (e: BindingEvent) => unknown; fail?: (n: number) => unknown } = {}) {
  const fs = fakeSource(initial);
  const fb = fakeBuild(over.fail ? { fail: over.fail } : {});
  const events: BindingEvent[] = [];
  const r = createPolicyBinding<{ id: number }>({ source: fs.source, build: fb.build, observer: over.observer ?? ((e) => void events.push(e)) });
  if (!r.ok) throw new Error(`createPolicyBinding: ${r.error.issues.join(",")}`);
  const binding: PolicyBinding<{ id: number }> = r.value;
  return { binding, events, ...fs, ...fb };
}

export function deepFrozen(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return true;
  if (!Object.isFrozen(v)) return false;
  return Object.values(v).every(deepFrozen);
}
