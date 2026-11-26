/**
 * tool-policy-host · یکپارچه با `createToolPolicyRuntime` **واقعی** (پورت‌های ساختگی): قراردادِ `start/stop/health` ریشه همان است که میزبان انتظار دارد
 * (اگر ریشه نام یا معنای دلیل/وضعیت را عوض کند، این‌جا قرمز می‌شود). پایگاه و ساعتِ واقعی در `tooling/tool-policy-host.pg.test.ts` است.
 */
import { describe, expect, it } from "vitest";
import { createToolPolicyRuntime } from "@/modules/tool-policy-runtime";
import type { ToolPolicyRuntime } from "@/modules/tool-policy-runtime";
import { createToolPolicyHost } from "./index";
import type { ToolPolicyHost } from "./index";
import { flush, manualTimer, fakeSignals } from "./test-kit";

type PortState = {
  preflight: unknown[];
  source: unknown;
  refresher: unknown;
  stop: unknown;
  calls: { preflight: number; start: number; stop: number };
};

const sourceHealth = (state: string): unknown => ({ state, version: 3, ageMs: 10, drift: false, consecutiveFailures: 0, lastFailure: null, lastAttemptAtMs: 1, lastSuccessAtMs: 1 });
const refresherStatus = (state: string): unknown => ({ state, haltReason: state === "halted" ? "SCHEDULE_FAILED" : null, inFlight: false, attempts: 1, consecutiveFailures: 0, lastOutcome: "ok", lastFailure: null });

function world(over: { shutdownTimeoutMs?: number; bootRetry?: { maxAttempts: number; delayMs: number } } = {}) {
  const st: PortState = { preflight: [], source: sourceHealth("NOT_LOADED"), refresher: refresherStatus("running"), stop: { stopped: true, abandonedInFlight: false }, calls: { preflight: 0, start: 0, stop: 0 } };
  const coreTimer = { after: (): unknown => ({}), cancel: (): void => undefined };
  const rt = createToolPolicyRuntime({
    preflight: () => {
      st.calls.preflight += 1;
      return Promise.resolve(st.preflight.length > 0 ? st.preflight.shift() : { ok: true });
    },
    source: { snapshot: () => ({ ok: false, error: { code: "NOT_LOADED", message: "x" } }) as never, health: () => st.source as never },
    refresher: {
      start: () => (st.calls.start += 1, { started: true }),
      stop: () => (st.calls.stop += 1, Promise.resolve(st.stop)),
      status: () => st.refresher as never,
    },
    timer: coreTimer,
    preflightDeadlineMs: 6_000,
  });
  if (!rt.ok) throw new Error(`runtime: ${rt.error.issues.join(",")}`);
  const runtime: ToolPolicyRuntime = rt.value;
  const timer = manualTimer();
  const signals = fakeSignals();
  const exits: number[] = [];
  const closes = { n: 0 };
  const made = createToolPolicyHost({ runtime, timer, signals, exit: (c: number) => void exits.push(c), closeResources: () => void (closes.n += 1), ...over });
  if (!made.ok) throw new Error(`host: ${made.error.issues.join(",")}`);
  const host: ToolPolicyHost = made.value;
  return { st, host, runtime, timer, signals, exits, closes };
}

describe("tool-policy-host · با ریشهٔ واقعی", () => {
  it("مهاجرت‌نشده ⇒ NOT_MIGRATED، حلقه هرگز شروع نمی‌شود، بازتلاش نیست، ready ۵۰۳", async () => {
    const w = world({ bootRetry: { maxAttempts: 5, delayMs: 10 } });
    w.st.preflight.push({ ok: false, code: "NOT_MIGRATED" });
    expect(await w.host.boot()).toEqual({ booted: false, reason: "NOT_MIGRATED", attempts: 1 });
    expect(w.st.calls.start).toBe(0);
    expect(w.st.calls.preflight).toBe(1);
    expect(w.host.probes.ready().httpStatus).toBe(503);
  });
  it("SCHEMA_MISMATCH هم دائمی است", async () => {
    const w = world({ bootRetry: { maxAttempts: 5, delayMs: 10 } });
    w.st.preflight.push({ ok: false, code: "SCHEMA_MISMATCH" });
    expect(await w.host.boot()).toEqual({ booted: false, reason: "SCHEMA_MISMATCH", attempts: 1 });
    expect(w.st.calls.preflight).toBe(1);
  });
  it("پایگاهِ موقتاً ناپاسخ‌گو: دو بار UNAVAILABLE سپس بالا می‌آید و حلقه دقیقاً یک بار شروع می‌شود", async () => {
    const w = world({ bootRetry: { maxAttempts: 4, delayMs: 100 } });
    w.st.preflight.push({ ok: false, code: "UNAVAILABLE" }, { ok: false, code: "UNAVAILABLE" });
    const p = w.host.boot();
    await flush();
    await w.timer.advance(100);
    await w.timer.advance(100);
    expect(await p).toEqual({ booted: true, attempts: 3 });
    expect(w.st.calls.preflight).toBe(3);
    expect(w.st.calls.start).toBe(1);
  });
  it("چرخهٔ کامل: running ولی ناآماده (NOT_LOADED) ← آماده ← STALE ← بهبود ← REFRESHER_HALTED ← خاموشی", async () => {
    const w = world();
    expect((await w.host.boot()).booted).toBe(true);
    expect(w.host.status().state).toBe("running");
    expect(w.host.probes.ready()).toMatchObject({ httpStatus: 503, body: { reason: "NOT_LOADED" } });
    expect(w.host.probes.startup().httpStatus).toBe(503);

    w.st.source = sourceHealth("FRESH");
    expect(w.host.probes.startup().httpStatus).toBe(200);
    expect(w.host.probes.ready()).toMatchObject({ httpStatus: 200, body: { ok: true, reason: null } });

    w.st.source = sourceHealth("STALE");
    expect(w.host.probes.ready()).toMatchObject({ httpStatus: 503, body: { reason: "STALE" } });
    expect(w.host.probes.startup().httpStatus).toBe(200);

    w.st.source = sourceHealth("FRESH");
    expect(w.host.probes.ready().httpStatus).toBe(200);

    w.st.refresher = refresherStatus("halted");
    expect(w.host.probes.ready()).toMatchObject({ httpStatus: 503, body: { reason: "REFRESHER_HALTED" } });

    w.st.refresher = refresherStatus("running");
    const res = await w.host.shutdown();
    expect(res).toEqual({ ok: true, clean: true, timedOut: false, closed: "ok", reason: "MANUAL" });
    expect(w.st.calls.stop).toBe(1);
    expect(w.closes.n).toBe(1);
    expect(w.host.probes.ready()).toMatchObject({ httpStatus: 503, body: { state: "stopped" } });
    expect(w.runtime.health().state).toBe("STOPPED");
  });
  it("SIGTERM ⇒ ریشه stop می‌شود و فرایند با ۰ بسته می‌شود", async () => {
    const w = world();
    await w.host.boot();
    w.signals.emit("SIGTERM");
    await flush();
    expect(w.st.calls.stop).toBe(1);
    expect(w.exits).toEqual([0]);
    expect(w.host.status().state).toBe("stopped");
  });
  it("حلقه‌ای که در stop رهایش کرده‌ایم (abandonedInFlight) ⇒ خاموشی ناتمیز؛ منابع بسته نمی‌شوند؛ exit(1)", async () => {
    const w = world();
    await w.host.boot();
    w.st.stop = { stopped: true, abandonedInFlight: true };
    w.signals.emit("SIGINT");
    await flush();
    expect(w.closes.n).toBe(0);
    expect(w.exits).toEqual([1]);
  });
  it("خاموشیِ میزبانِ بوت‌نشده، ریشه را idempotent می‌بندد و پس از آن boot بسته است", async () => {
    const w = world();
    expect((await w.host.shutdown()).ok).toBe(true);
    expect(await w.host.boot()).toMatchObject({ booted: false, reason: "SHUTTING_DOWN" });
    expect(w.st.calls.preflight).toBe(0);
  });
});
