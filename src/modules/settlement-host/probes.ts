/**
 * settlement-host — سه پروبِ جدا (ADR-0032 تصمیم ۴). تابعِ خالص؛ همگام، بی‌I/O، هرگز نمی‌پرتابد، بدنهٔ بسته.
 *  - live: همیشه ۲۰۰ (به پایگاه/رفتگر وابسته نیست).
 *  - startup: ۲۰۰ از اولین بوتِ موفق (چسبنده).
 *  - ready: ۲۰۰ فقط در `running` با سلامتِ `ok|degraded` که `httpStatus=200` هم‌سازگار دارد؛ هر چیزِ دیگر ۵۰۳ (شکستِ بسته).
 */
import type { HostState, ProbeKind, ProbeResult, ProbeSweep } from "./types";

export type ProbeInput = Readonly<{
  state: HostState | "absent";
  hasBooted: boolean;
  /** فقط در حالتِ `running` صدا زده می‌شود. خروجی ناقابل‌اعتماد است. */
  readHealth: () => unknown;
}>;

const SWEEP: readonly string[] = ["ok", "degraded", "down"];

function result(probe: ProbeKind, ok: boolean, state: ProbeInput["state"], sweep: ProbeSweep | null): ProbeResult {
  return Object.freeze({ httpStatus: ok ? (200 as const) : (503 as const), body: Object.freeze({ probe, ok, state, sweep }) });
}

function readSweep(readHealth: () => unknown): { sweep: ProbeSweep | null; consistent: boolean } {
  try {
    const h = readHealth() as { health?: { status?: unknown }; httpStatus?: unknown } | null;
    if (typeof h !== "object" || h === null) return { sweep: null, consistent: false };
    const inner = h.health;
    const status = typeof inner === "object" && inner !== null ? inner.status : undefined;
    const http = h.httpStatus;
    if (typeof status !== "string" || !SWEEP.includes(status)) return { sweep: null, consistent: false };
    const sweep = status as ProbeSweep;
    const expected = sweep === "down" ? 503 : 200;
    return { sweep, consistent: http === expected };
  } catch {
    return { sweep: null, consistent: false };
  }
}

export function evaluateProbe(kind: ProbeKind, input: ProbeInput): ProbeResult {
  try {
    const { state, hasBooted } = input;
    if (kind === "live") return result("live", true, state, null);
    if (kind === "startup") return result("startup", hasBooted === true, state, null);
    if (kind === "ready") {
      if (state !== "running") return result("ready", false, state, null);
      const { sweep, consistent } = readSweep(input.readHealth);
      return result("ready", consistent && sweep !== "down", state, sweep);
    }
    return result("ready", false, "absent", null);
  } catch {
    return result(kind === "live" ? "live" : kind === "startup" ? "startup" : "ready", kind === "live", "absent", null);
  }
}
