/** اعتبارسنجیِ گزینه‌ها روی مرز؛ خطاها فقط نامِ کلید، هرگز مقدار. */
import type { Timers } from "@/modules/ai-gateway";
import type { CallDeadlineError } from "./types";

/** سقفِ بالای مهلت هم‌راستا با سقفِ مهلتِ ai-gateway (۱۰ دقیقه)؛ مهلتِ بزرگ‌تر معنایی برای گامِ تعاملی ندارد. */
export const CALL_DEADLINE_LIMITS = Object.freeze({ minMs: 1, maxMs: 600_000 });

export const DEFAULT_TIMERS: Timers = Object.freeze({
  setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h: unknown) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
});

const KEYS: ReadonlySet<string> = new Set(["gateway", "maxCallMs", "timers", "onEvent"]);
const GATEWAY_FNS = ["completeStep", "toolFormat", "limits"] as const;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keyName = (k: string): string => (k.length > 40 ? `${k.slice(0, 40)}…` : k);

export type ResolvedDeadline = Readonly<{
  gateway: Record<string, unknown>;
  maxCallMs: number;
  timers: Timers;
  onEvent: ((event: never) => void) | null;
}>;
type Resolved = Readonly<{ ok: true; value: ResolvedDeadline }> | Readonly<{ ok: false; error: CallDeadlineError }>;

const fail = (issues: readonly string[]): Resolved => ({
  ok: false,
  error: Object.freeze({ code: "INVALID_CONFIG" as const, message: "پیکربندی سقفِ مهلتِ تماسِ مدل نامعتبر است.", issues: Object.freeze(issues.slice(0, 20)) }),
});

/** هر کلید فقط یک‌بار خوانده می‌شود؛ تابع‌های دروازه و تایمر یک‌بار گرفته و `bind` می‌شوند. */
export function resolveDeadlineOptions(raw: unknown): Resolved {
  const issues: string[] = [];
  let o: Record<string, unknown>;
  try {
    if (!isRecord(raw)) return fail(["پیکربندی باید یک شیء ساده باشد."]);
    o = {};
    for (const k of Object.keys(raw)) {
      if (!KEYS.has(k)) issues.push(`کلید ناشناخته: ${JSON.stringify(keyName(k))}.`);
      else o[k] = raw[k];
    }
  } catch {
    return fail(["خواندن پیکربندی ناموفق بود."]);
  }
  const gw = o["gateway"];
  const hasGateway = isRecord(gw) && GATEWAY_FNS.every((n) => typeof gw[n] === "function");
  if (!hasGateway) issues.push("gateway باید completeStep، toolFormat و limits داشته باشد.");
  const ms = o["maxCallMs"];
  if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms < CALL_DEADLINE_LIMITS.minMs || ms > CALL_DEADLINE_LIMITS.maxMs) {
    issues.push(`maxCallMs باید عدد صحیح ${CALL_DEADLINE_LIMITS.minMs} تا ${CALL_DEADLINE_LIMITS.maxMs} باشد.`);
  }
  let timers: Timers = DEFAULT_TIMERS;
  const t = o["timers"];
  if (t !== undefined) {
    if (!isRecord(t) || typeof t["setTimeout"] !== "function" || typeof t["clearTimeout"] !== "function") issues.push("timers باید setTimeout و clearTimeout داشته باشد.");
    else timers = Object.freeze({ setTimeout: (t["setTimeout"] as Timers["setTimeout"]).bind(t), clearTimeout: (t["clearTimeout"] as Timers["clearTimeout"]).bind(t) });
  }
  const ev = o["onEvent"];
  if (ev !== undefined && typeof ev !== "function") issues.push("onEvent باید تابع باشد.");
  if (issues.length > 0 || !hasGateway) return fail(issues);
  const g = gw as Record<string, unknown>;
  const bound: Record<string, unknown> = {};
  for (const n of GATEWAY_FNS) bound[n] = (g[n] as (...a: unknown[]) => unknown).bind(g);
  return { ok: true, value: Object.freeze({ gateway: Object.freeze(bound), maxCallMs: ms as number, timers, onEvent: typeof ev === "function" ? (ev as (event: never) => void) : null }) };
}
