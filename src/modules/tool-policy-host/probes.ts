/**
 * tool-policy-host — سه پروبِ جدا (ADR-0075 تصمیم ۴). تابعِ خالص؛ همگام، بی‌I/O، هرگز نمی‌پرتابد، بدنهٔ بسته.
 *  - live: همیشه ۲۰۰ (به پایگاه/حلقه وابسته نیست).
 *  - startup: ۲۰۰ از نخستین باری که آمادگی دیده شد (چسبنده؛ `start()` ریشه نخستین تازه‌سازی را منتظر نمی‌ماند، پس «بوت شد» ≠ «آماده شد»).
 *  - ready: ۲۰۰ فقط در `running` با سلامتِ ریشه‌ای که **هم‌سازگار** «آماده» می‌گوید (`state==="RUNNING" ∧ ready===true ∧ reason===null`)؛
 *    هر چیزِ دیگر (بدشکل، ناسازگار، پرتاب) ۵۰۳ (شکستِ بسته).
 */
import type { HostState, NotReadyReason, ProbeKind, ProbeResult } from "./types";

export type ProbeInput = Readonly<{
  state: HostState | "absent";
  hasBeenReady: boolean;
  /** فقط در حالتِ `running` صدا زده می‌شود. خروجی ناقابل‌اعتماد است. */
  readHealth: () => unknown;
}>;

export type Readiness = Readonly<{ ready: boolean; reason: NotReadyReason | null }>;

export const NOT_READY_REASONS: readonly NotReadyReason[] = ["NOT_STARTED", "STARTING", "STOPPING", "NOT_LOADED", "STALE", "CLOCK_INVALID", "REFRESHER_HALTED", "HEALTH_UNAVAILABLE"];

const READY: Readiness = Object.freeze({ ready: true, reason: null });
const UNAVAILABLE: Readiness = Object.freeze({ ready: false, reason: "HEALTH_UNAVAILABLE" as const });

/** سلامتِ ریشه را (ناقابل‌اعتماد) به `{ready, reason}`ِ بسته تبدیل می‌کند؛ هرگز نمی‌پرتابد. */
export function readReadiness(readHealth: () => unknown): Readiness {
  try {
    const h = readHealth() as { state?: unknown; ready?: unknown; reason?: unknown } | null;
    if (typeof h !== "object" || h === null) return UNAVAILABLE;
    const { state, ready, reason } = h;
    if (ready === true) return state === "RUNNING" && reason === null ? READY : UNAVAILABLE;
    if (ready !== false) return UNAVAILABLE;
    return typeof reason === "string" && (NOT_READY_REASONS as readonly string[]).includes(reason) ? Object.freeze({ ready: false, reason: reason as NotReadyReason }) : UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

function result(probe: ProbeKind, ok: boolean, state: ProbeInput["state"], reason: NotReadyReason | null): ProbeResult {
  return Object.freeze({ httpStatus: ok ? (200 as const) : (503 as const), body: Object.freeze({ probe, ok, state, reason }) });
}

export function evaluateProbe(kind: ProbeKind, input: ProbeInput): ProbeResult {
  try {
    const { state, hasBeenReady } = input;
    if (kind === "live") return result("live", true, state, null);
    if (kind === "startup") return result("startup", hasBeenReady === true, state, null);
    if (kind === "ready") {
      if (state !== "running") return result("ready", false, state, null);
      const r = readReadiness(input.readHealth);
      return result("ready", r.ready, state, r.reason);
    }
    return result("ready", false, "absent", null);
  } catch {
    return result(kind === "live" ? "live" : kind === "startup" ? "startup" : "ready", kind === "live", "absent", null);
  }
}
