/** اعتبارسنجیِ گزینه‌های ساخت (ورودیِ ناشناخته؛ هر کلید یک بار خوانده می‌شود؛ هیچ مقداری بازتاب نمی‌شود). */
import type { PolicyClock } from "@/modules/tool-policy-admin";
import type { PolicyReader, SourceConfigError } from "./types";

export const SOURCE_LIMITS = Object.freeze({
  maxStaleMs: Object.freeze({ min: 1_000, max: 86_400_000 }),
  refreshTimeoutMs: Object.freeze({ min: 100, max: 300_000 }),
});

const KEYS = ["reader", "clock", "maxStaleMs", "refreshTimeoutMs"] as const;

export type ParsedOptions = Readonly<{ reader: PolicyReader; read: () => Promise<unknown>; clock: PolicyClock; now: () => unknown; maxStaleMs: number; refreshTimeoutMs: number }>;

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;

export function parseOptions(options: unknown): { ok: true; value: ParsedOptions } | { ok: false; error: SourceConfigError } {
  const issues: string[] = [];
  const bad = (): { ok: false; error: SourceConfigError } => ({
    ok: false,
    error: Object.freeze({ code: "INVALID_CONFIG", message: "گزینه‌های منبعِ سیاست نامعتبر است.", issues: Object.freeze(issues.slice(0, 20)) }),
  });
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    issues.push("options");
    return bad();
  }
  let own: string[];
  const got: Record<string, unknown> = {};
  try {
    own = Object.keys(options);
    for (const k of own) if (!(KEYS as readonly string[]).includes(k)) issues.push(`unknown:${k.length <= 40 ? k : "?"}`);
    for (const k of KEYS) got[k] = (options as Record<string, unknown>)[k];
  } catch {
    issues.push("options");
    return bad();
  }
  const reader = got["reader"] as { current?: unknown } | null | undefined;
  const clock = got["clock"] as { nowMs?: unknown } | null | undefined;
  let current: unknown;
  let nowMs: unknown;
  try {
    current = typeof reader === "object" && reader !== null ? reader.current : undefined;
  } catch {
    // دسترسی به کلید پرتاب کرد ⇒ نامعتبر
  }
  try {
    nowMs = typeof clock === "object" && clock !== null ? clock.nowMs : undefined;
  } catch {
    // دسترسی به کلید پرتاب کرد ⇒ نامعتبر
  }
  if (typeof current !== "function") issues.push("reader.current");
  if (typeof nowMs !== "function") issues.push("clock.nowMs");
  const L = SOURCE_LIMITS;
  const maxStaleMs = got["maxStaleMs"];
  const refreshTimeoutMs = got["refreshTimeoutMs"];
  if (!isInt(maxStaleMs, L.maxStaleMs.min, L.maxStaleMs.max)) issues.push("maxStaleMs");
  if (!isInt(refreshTimeoutMs, L.refreshTimeoutMs.min, L.refreshTimeoutMs.max)) issues.push("refreshTimeoutMs");
  if (isInt(maxStaleMs, L.maxStaleMs.min, L.maxStaleMs.max) && isInt(refreshTimeoutMs, L.refreshTimeoutMs.min, L.refreshTimeoutMs.max) && refreshTimeoutMs > maxStaleMs) {
    issues.push("relation:refreshTimeoutMs<=maxStaleMs");
  }
  if (issues.length > 0) return bad();
  const fnCurrent = current as () => Promise<unknown>;
  const fnNow = nowMs as () => unknown;
  return {
    ok: true,
    value: Object.freeze({
      reader: reader as PolicyReader,
      read: () => fnCurrent.call(reader) as Promise<unknown>,
      clock: clock as PolicyClock,
      now: () => fnNow.call(clock),
      maxStaleMs: maxStaleMs as number,
      refreshTimeoutMs: refreshTimeoutMs as number,
    }),
  };
}
