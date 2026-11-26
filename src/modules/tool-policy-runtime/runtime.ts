/**
 * `createToolPolicyRuntime` — چرخهٔ عمرِ مرتبِ منبع + حلقهٔ تازه‌سازیِ سیاست (ADR-0073).
 *  - `start`: پیش‌بازرسیِ فقط‌خواندنی با نگهبانِ مهلت، سپس آغازِ حلقه؛ شکستِ پیش‌بازرسی هیچ حلقه‌ای راه نمی‌اندازد.
 *  - `stop`: مرتب، idempotent، هم‌زمان‌ها یک وعده؛ `stop` در میانهٔ `start` آن را بی‌اثر می‌کند (حلقه هرگز بعد از stop آغاز نمی‌شود).
 *  - `health`: همگام؛ «آماده» فقط وقتی RUNNING و حلقه running و منبع FRESH باشد؛ دلیلِ ناآمادگی کدِ ثابت است.
 *  - هیچ‌چیز نمی‌پرتابد و متنِ استثنای پورت‌ها هرگز گرفته نمی‌شود.
 * همهٔ پورت‌ها ورودیِ ناشناخته‌اند؛ هر کلید یک بار خوانده می‌شود.
 */
import { REFRESHER_LIMITS } from "@/modules/tool-policy-refresher";
import type { RefresherStatus } from "@/modules/tool-policy-refresher";
import type { SnapshotResult, SourceHealth } from "@/modules/tool-policy-source";
import type { NotReadyReason, PreflightCode, PreflightResult, RuntimeHealth, RuntimeResult, RuntimeStartResult, RuntimeState, RuntimeStopResult, ToolPolicyRuntime } from "./types";

const KEYS = ["preflight", "source", "refresher", "timer", "preflightDeadlineMs"] as const;
const PREFLIGHT_CODES: readonly string[] = ["NOT_MIGRATED", "SCHEMA_MISMATCH", "UNAVAILABLE"];
const SOURCE_STATES: readonly string[] = ["NOT_LOADED", "FRESH", "STALE", "CLOCK_INVALID"];
const REFRESHER_STATES: readonly string[] = ["idle", "running", "stopping", "halted"];

const UNAVAILABLE: PreflightResult = Object.freeze({ ok: false as const, code: "UNAVAILABLE" as const });
const NOT_LOADED: SnapshotResult = Object.freeze({ ok: false as const, error: Object.freeze({ code: "NOT_LOADED" as const, message: "سیاستِ ابزار در دسترس نیست." }) });

type Fn = (...args: never[]) => unknown;

function member(owner: unknown, key: string): unknown {
  try {
    return typeof owner === "object" && owner !== null ? (owner as Record<string, unknown>)[key] : undefined;
  } catch {
    return undefined; // دسترسی به کلید پرتاب کرد ⇒ نامعتبر
  }
}

function fail(issues: string[]): RuntimeResult<never> {
  return { ok: false, error: Object.freeze({ code: "INVALID_CONFIG" as const, message: "پیکربندیِ ریشهٔ سیاستِ ابزار نامعتبر است.", issues: Object.freeze(issues.slice(0, 20)) }) };
}

function classify(v: unknown): PreflightResult {
  try {
    if (typeof v !== "object" || v === null) return UNAVAILABLE;
    const ok = (v as { ok?: unknown }).ok;
    if (ok === true) return Object.freeze({ ok: true as const });
    if (ok !== false) return UNAVAILABLE;
    const code = (v as { code?: unknown }).code;
    if (typeof code === "string" && PREFLIGHT_CODES.includes(code)) return Object.freeze({ ok: false as const, code: code as PreflightCode });
    return UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

export function createToolPolicyRuntime(raw: unknown): RuntimeResult<ToolPolicyRuntime> {
  const issues: string[] = [];
  const got: Record<string, unknown> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail(["options"]);
  try {
    for (const k of Object.keys(raw)) if (!(KEYS as readonly string[]).includes(k)) issues.push(`unknown:${k.length <= 40 ? k : "?"}`);
    for (const k of KEYS) got[k] = (raw as Record<string, unknown>)[k];
  } catch {
    return fail(["options"]);
  }
  const preflight = got["preflight"];
  const source = got["source"];
  const refresher = got["refresher"];
  const timer = got["timer"];
  const deadline = got["preflightDeadlineMs"];
  const snapshotFn = member(source, "snapshot");
  const healthFn = member(source, "health");
  const startFn = member(refresher, "start");
  const stopFn = member(refresher, "stop");
  const statusFn = member(refresher, "status");
  const afterFn = member(timer, "after");
  const cancelFn = member(timer, "cancel");
  if (typeof preflight !== "function") issues.push("preflight");
  if (typeof snapshotFn !== "function") issues.push("source.snapshot");
  if (typeof healthFn !== "function") issues.push("source.health");
  if (typeof startFn !== "function") issues.push("refresher.start");
  if (typeof stopFn !== "function") issues.push("refresher.stop");
  if (typeof statusFn !== "function") issues.push("refresher.status");
  if (typeof afterFn !== "function") issues.push("timer.after");
  if (typeof cancelFn !== "function") issues.push("timer.cancel");
  const L = REFRESHER_LIMITS.attemptDeadlineMs;
  if (typeof deadline !== "number" || !Number.isSafeInteger(deadline) || deadline < L.min || deadline > L.max) issues.push("preflightDeadlineMs");
  if (issues.length > 0) return fail(issues);

  const runPreflight = preflight as () => Promise<unknown>;
  const after = (afterFn as Fn).bind(timer) as (fn: () => void, ms: number) => unknown;
  const cancel = (cancelFn as Fn).bind(timer) as (h: unknown) => void;
  const deadlineMs = deadline as number;

  let state: RuntimeState = "IDLE";
  let generation = 0;
  let startPromise: Promise<RuntimeStartResult> | null = null;
  let stopPromise: Promise<RuntimeStopResult> | null = null;

  /** پیش‌بازرسی با نگهبانِ مهلت؛ نگهبان پیش از فراخوانیِ پیش‌بازرسی ساخته می‌شود (ساخته نشد ⇒ فراخوانی نمی‌شود). هرگز نمی‌پرتابد. */
  async function guardedPreflight(): Promise<PreflightResult> {
    let settle: (r: PreflightResult) => void = () => undefined;
    const done = new Promise<PreflightResult>((resolve) => {
      settle = resolve;
    });
    let handle: unknown;
    try {
      handle = after(() => settle(UNAVAILABLE), deadlineMs);
    } catch {
      return UNAVAILABLE;
    }
    try {
      Promise.resolve(runPreflight()).then(
        (v) => settle(classify(v)),
        () => settle(UNAVAILABLE),
      );
    } catch {
      settle(UNAVAILABLE);
    }
    const result = await done;
    try {
      cancel(handle);
    } catch {
      // پرتابِ cancel بی‌اثر (کمربندِ دوم)
    }
    return result;
  }

  async function stopRefresher(): Promise<boolean> {
    try {
      const r = await Promise.resolve((stopFn as Fn).call(refresher));
      return member(r, "abandonedInFlight") !== false; // محافظه‌کارانه: ناشناخته = رهاشده
    } catch {
      return true;
    }
  }

  async function doStart(mine: number): Promise<RuntimeStartResult> {
    const pre = await guardedPreflight();
    if (mine !== generation) return Object.freeze({ started: false as const, reason: "STOPPED_DURING_START" as const });
    if (!pre.ok) {
      state = "IDLE";
      return Object.freeze({ started: false as const, reason: pre.code });
    }
    let started: unknown;
    try {
      started = member((startFn as Fn).call(refresher), "started");
    } catch {
      started = undefined;
    }
    if (started !== true) {
      await stopRefresher(); // هیچ حلقهٔ نیمه‌زنده‌ای نماند
      state = "IDLE";
      return Object.freeze({ started: false as const, reason: "SCHEDULE_FAILED" as const });
    }
    state = "RUNNING";
    return Object.freeze({ started: true as const });
  }

  const runtime: ToolPolicyRuntime = {
    start(): Promise<RuntimeStartResult> {
      if (state === "STARTING" || state === "RUNNING") return Promise.resolve(Object.freeze({ started: false as const, reason: "ALREADY_STARTED" as const }));
      if (state === "STOPPING") return Promise.resolve(Object.freeze({ started: false as const, reason: "STOPPING" as const }));
      state = "STARTING";
      const p = doStart(generation);
      startPromise = p;
      return p;
    },

    stop(): Promise<RuntimeStopResult> {
      if (stopPromise !== null) return stopPromise;
      if (state === "IDLE" || state === "STOPPED") return Promise.resolve(Object.freeze({ stopped: true as const, abandonedInFlight: false }));
      const pendingStart = state === "STARTING" ? startPromise : null;
      state = "STOPPING";
      generation += 1;
      const p = (async (): Promise<RuntimeStopResult> => {
        if (pendingStart !== null) await pendingStart;
        const abandoned = await stopRefresher();
        state = "STOPPED";
        stopPromise = null;
        return Object.freeze({ stopped: true as const, abandonedInFlight: abandoned });
      })();
      stopPromise = p;
      return p;
    },

    snapshot(): SnapshotResult {
      try {
        const r = (snapshotFn as Fn).call(source) as SnapshotResult;
        const ok = member(r, "ok");
        if (ok === true && typeof member(r, "value") === "object" && member(r, "value") !== null) return r;
        if (ok === false && typeof member(member(r, "error"), "code") === "string") return r;
        return NOT_LOADED;
      } catch {
        return NOT_LOADED;
      }
    },

    health(): RuntimeHealth {
      let src: SourceHealth | null = null;
      let ref: RefresherStatus | null = null;
      try {
        const h = (healthFn as Fn).call(source) as SourceHealth;
        const st = member(h, "state");
        if (typeof st === "string" && SOURCE_STATES.includes(st)) src = h;
      } catch {
        src = null;
      }
      try {
        const s = (statusFn as Fn).call(refresher) as RefresherStatus;
        const st = member(s, "state");
        if (typeof st === "string" && REFRESHER_STATES.includes(st)) ref = s;
      } catch {
        ref = null;
      }
      const reason = notReady(state, src, ref);
      return Object.freeze({ state, ready: reason === null, reason, source: src, refresher: ref });
    },
  };
  return { ok: true, value: Object.freeze(runtime) };
}

function notReady(state: RuntimeState, src: SourceHealth | null, ref: RefresherStatus | null): NotReadyReason | null {
  if (state === "IDLE" || state === "STOPPED") return "NOT_STARTED";
  if (state === "STARTING") return "STARTING";
  if (state === "STOPPING") return "STOPPING";
  if (src === null || ref === null) return "HEALTH_UNAVAILABLE";
  if (ref.state === "halted") return "REFRESHER_HALTED";
  if (ref.state !== "running") return "HEALTH_UNAVAILABLE";
  if (src.state === "FRESH") return null;
  return src.state;
}
