/** ابزار مشترکِ آزمون‌های tool-policy-preflight (از index صادر نمی‌شود). همهٔ مقدارها ساختگیِ آزمون‌اند. */
import { timingFromGrace, type PolicyProjection } from "@/modules/tool-policy";
import { createMemoryPolicyStore, createToolPolicyAdmin, type AdminResult, type PolicyVersionStore, type ToolPolicyAdmin } from "@/modules/tool-policy-admin";

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

export const ACTOR = "admin:alice";
export const REASON = "پیش‌بازرسی پیش از انتشار";

/** مجموعهٔ سازگارِ زمانی (بی‌اصلاحِ خودکار، پس صریح). */
export function compat(graceMs: number, modelTimeoutMs: number): { timing: Record<string, number>; model: { timeoutMs: number } } {
  const t = timingFromGrace(graceMs);
  if (!t.ok) throw new Error("compat");
  return { timing: { ...t.value }, model: { timeoutMs: modelTimeoutMs } };
}

/** سازندهٔ ساختگی: `{ ok:true, value:{ id } }` و ثبتِ ورودی‌ها؛ `reject(p)` درست ⇒ `{ ok:false }`. */
export function fakeBuild(reject: (p: PolicyProjection) => boolean = () => false) {
  const state = { calls: [] as PolicyProjection[], reject };
  return {
    state,
    build: (p: PolicyProjection): unknown => {
      state.calls.push(p);
      return state.reject(p) ? { ok: false } : { ok: true, value: { id: state.calls.length } };
    },
  };
}

export function fakeClock(start = 1_700_000_000_000) {
  return { nowMs: (): number => start };
}

export function realAdmin(store: PolicyVersionStore = createMemoryPolicyStore()): { admin: ToolPolicyAdmin; store: PolicyVersionStore } {
  const a = createToolPolicyAdmin({ store, clock: fakeClock() });
  if (!a.ok) throw new Error("admin");
  return { admin: a.value, store };
}

/** مدیرِ ساختگی: هر متد فراخوانی‌ها را می‌شمارد و `impl` پاسخ می‌دهد (می‌تواند بپرتابد). */
export function spyAdmin(impl: Partial<Record<"set" | "rollbackTo" | "current" | "history", (input?: unknown) => unknown>> = {}) {
  const calls = { set: [] as unknown[], rollbackTo: [] as unknown[], current: 0, history: [] as unknown[] };
  const okEmpty: AdminResult<never> = { ok: false, error: { code: "VERSION_NOT_FOUND", message: "x", issues: [], currentVersion: 0 } };
  const admin = {
    set: async (i: unknown) => {
      calls.set.push(i);
      return (impl.set ? impl.set(i) : okEmpty) as never;
    },
    rollbackTo: async (i: unknown) => {
      calls.rollbackTo.push(i);
      return (impl.rollbackTo ? impl.rollbackTo(i) : okEmpty) as never;
    },
    current: async () => {
      calls.current += 1;
      return (impl.current ? impl.current() : okEmpty) as never;
    },
    history: async (i?: unknown) => {
      calls.history.push(i);
      return (impl.history ? impl.history(i) : { ok: true, value: { entries: [], nextBefore: null } }) as never;
    },
  };
  return { admin, calls };
}

export const deepFrozen = (v: unknown): boolean => {
  if (typeof v !== "object" || v === null) return true;
  return Object.isFrozen(v) && Object.values(v).every(deepFrozen);
};
