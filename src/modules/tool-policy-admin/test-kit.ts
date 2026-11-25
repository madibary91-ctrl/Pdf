/** ابزار مشترکِ آزمون‌های tool-policy-admin (از index صادر نمی‌شود). */
import { resolveToolPolicy, timingFromGrace } from "@/modules/tool-policy";
import { createToolPolicyAdmin } from "./admin";
import { createMemoryPolicyStore } from "./memory-store";
import type { PolicyVersionRecord, PolicyVersionStore, ToolPolicyAdmin } from "./types";

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

export function fakeClock(start = 1_700_000_000_000) {
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

export const ACTOR = "admin:alice";
export const REASON = "کاهش مهلت پس از اندازه‌گیری تأخیر ارائه‌دهنده";

/** مجموعهٔ سازگار: زمان‌بندیِ مشتق از graceMs و مهلتِ مدلِ کمتر از maxCallMs (بی‌اصلاحِ خودکار، پس صریح). */
export function compat(graceMs: number, modelTimeoutMs: number): { timing: Record<string, number>; model: { timeoutMs: number } } {
  const t = timingFromGrace(graceMs);
  if (!t.ok) throw new Error("compat: graceMs نامعتبر");
  return { timing: { ...t.value }, model: { timeoutMs: modelTimeoutMs } };
}

export function defaultsPolicy() {
  const r = resolveToolPolicy(undefined);
  if (!r.ok) throw new Error("defaults نامعتبر");
  return r.value;
}

export function newAdmin(store: PolicyVersionStore = createMemoryPolicyStore(), clock = fakeClock()): { admin: ToolPolicyAdmin; store: PolicyVersionStore; clock: ReturnType<typeof fakeClock> } {
  const a = createToolPolicyAdmin({ store, clock });
  if (!a.ok) throw new Error(`createToolPolicyAdmin: ${a.error.code}`);
  return { admin: a.value, store, clock };
}

export const setPolicy = (admin: ToolPolicyAdmin, expectedVersion: number, overrides: unknown, extra: Record<string, unknown> = {}) =>
  admin.set({ expectedVersion, overrides, actor: ACTOR, reason: REASON, ...extra });

export const rollback = (admin: ToolPolicyAdmin, expectedVersion: number, toVersion: number, extra: Record<string, unknown> = {}) =>
  admin.rollbackTo({ expectedVersion, toVersion, actor: ACTOR, reason: REASON, ...extra });

/** رکوردِ معتبرِ نمونه برای آزمونِ ذخیره‌ساز. */
export function sampleRecord(version: number, extra: Partial<PolicyVersionRecord> = {}): PolicyVersionRecord {
  return { version, overrides: {}, policy: defaultsPolicy(), changes: [], source: { kind: "set" }, actor: ACTOR, reason: REASON, createdAtMs: 1000 + version, ...extra };
}

export function unwrap<T>(r: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: unknown }>): T {
  if (!r.ok) throw new Error(`unwrap: ${JSON.stringify(r.error)}`);
  return r.value;
}

export function deepFrozen(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return true;
  if (!Object.isFrozen(v)) return false;
  return Object.values(v).every(deepFrozen);
}

/** ذخیره‌سازِ پوششی: روشی را جایگزین یا شمارش می‌کند. */
export function wrapStore(inner: PolicyVersionStore, replace: Partial<Record<keyof PolicyVersionStore, (...a: never[]) => unknown>> = {}): PolicyVersionStore & { calls: Record<string, number> } {
  const calls: Record<string, number> = { latest: 0, get: 0, append: 0, list: 0 };
  const w = (name: keyof PolicyVersionStore) => (...a: unknown[]) => {
    calls[name] = (calls[name] ?? 0) + 1;
    const r = replace[name];
    return r !== undefined ? (r as (...x: unknown[]) => unknown)(...a) : (inner[name] as (...x: unknown[]) => unknown)(...a);
  };
  return { latest: w("latest"), get: w("get"), append: w("append"), list: w("list"), calls } as unknown as PolicyVersionStore & { calls: Record<string, number> };
}
