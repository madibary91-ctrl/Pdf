/**
 * `createSettlementRuntime` — ریشهٔ ترکیبِ رفتگرِ تسویه روی پورت‌های تزریقی (ADR-0031، م۳‑ه‑۲).
 * ماژول سیاستی نمی‌سازد؛ فقط چرخهٔ عمر را تضمین می‌کند:
 *  ۱. **شروعِ شکست‌بسته:** حلقه فقط پس از پیش‌بازرسیِ موفق (مهاجرت‌ها، پایگاه) و ساعتِ معتبر شروع می‌شود؛ پیش‌بازرسی با مهلتِ زمان‌سنجِ تزریقی کران‌دار است.
 *  ۲. **تک‌شروع:** `start` هم‌زمان/تکراری هرگز دو حلقه نمی‌سازد؛ `stop` هنگامِ `starting` شروع را لغو می‌کند (بی‌حلقهٔ یتیم).
 *  ۳. **توقفِ مرتب و تکرارپذیر:** `stop` هم‌زمان یک وعده را به اشتراک می‌گذارد؛ پس از `stop` می‌شود دوباره `start` کرد.
 *  ۴. **سلامتِ همگام و بی‌نشت:** `health()` فقط از وضعیتِ حلقه و ساعت می‌سازد (بی‌I/O)، با `sinceMs` = آغازِ آخرین `start`؛ هر خطا ⇒ `down`.
 *  ۵. **هیچ متدی نمی‌پرتابد.**
 */
import { sweepHealthHttpStatus } from "@/modules/settlement";
import type { LoopStopResult, LoopTimer, SweepLoopStatus } from "@/modules/settlement";
import { assemble, configError, isFn, snapshot, TUNING_KEYS, unknownKeyIssues } from "./assemble";
import type { PreflightCode, PreflightResult, RuntimeHealth, RuntimeResult, RuntimeStartResult, RuntimeState, RuntimeStatus, SettlementRuntime, StartFailureReason } from "./types";

export const RUNTIME_KEYS = [...TUNING_KEYS, "ledger", "outbox", "clock", "timer", "preflight"] as const;

type Bounded<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>;

/** `work` را با مهلتِ زمان‌سنجِ تزریقی await می‌کند؛ هرگز نمی‌پرتابد و آویزان نمی‌ماند (زمان‌سنجِ خراب ⇒ `work` اصلاً صدا زده نمی‌شود). */
function bounded<T>(timer: LoopTimer, ms: number, work: () => T | Promise<T>): Promise<Bounded<T>> {
  return new Promise<Bounded<T>>((resolve) => {
    let done = false;
    let armed = false;
    let handle: unknown;
    const finish = (r: Bounded<T>): void => {
      if (done) return;
      done = true;
      if (armed) {
        try {
          timer.cancel(handle);
        } catch {
          // لغوِ ناموفق بی‌خطر است.
        }
      }
      resolve(r);
    };
    try {
      armed = true;
      const h = timer.after(() => finish({ ok: false }), ms);
      if (!done) handle = h;
    } catch {
      armed = false;
      finish({ ok: false });
    }
    if (done) return; // مهلت پیش از شروعِ کار گذشت یا زمان‌سنج خراب بود: `work` هرگز صدا زده نمی‌شود.
    try {
      Promise.resolve(work()).then(
        (value) => finish({ ok: true, value }),
        () => finish({ ok: false }),
      );
    } catch {
      finish({ ok: false });
    }
  });
}

function parsePreflight(r: Bounded<unknown>): PreflightCode | null {
  if (!r.ok) return "UNAVAILABLE";
  try {
    const v = r.value as { ok?: unknown; code?: unknown } | null;
    if (typeof v !== "object" || v === null) return "UNAVAILABLE";
    if (v.ok === true) return null;
    return v.code === "NOT_MIGRATED" || v.code === "SCHEMA_MISMATCH" ? v.code : "UNAVAILABLE";
  } catch {
    return "UNAVAILABLE";
  }
}

function readClock(clock: { nowMs(): number }): number | null {
  try {
    const t = clock.nowMs();
    return Number.isSafeInteger(t) && t >= 0 ? t : null;
  } catch {
    return null;
  }
}

export function createSettlementRuntime(raw: unknown): RuntimeResult<SettlementRuntime> {
  try {
    const snap = snapshot(raw);
    if (snap === null) return configError(["پیکربندی باید یک شیء ساده باشد."]);
    const issues = unknownKeyIssues(snap, RUNTIME_KEYS);
    const { ledger, outbox, clock, timer, preflight } = snap;
    if (preflight !== undefined && !isFn(preflight)) issues.push("preflight باید تابع باشد.");
    const built = assemble(snap, { ledger, outbox, clock, timer });
    if (!built.ok) return configError([...issues, ...built.error.issues]);
    if (issues.length > 0) return configError(issues);
    const { loop, check, startTimeoutMs } = built.value;
    const clk = clock as { nowMs(): number };
    const tmr = timer as LoopTimer;
    const pre = preflight as (() => unknown) | undefined;

    let state: RuntimeState = "idle";
    let startedAtMs: number | null = null;
    let stopRequested = false;
    let stopping: Promise<LoopStopResult> | null = null;

    const fail = (reason: StartFailureReason, code: PreflightCode | null = null): RuntimeStartResult => Object.freeze({ started: false as const, reason, code });

    async function start(): Promise<RuntimeStartResult> {
      try {
        if (state === "running") return fail("ALREADY_RUNNING");
        if (state === "starting") return fail("STARTING");
        if (state === "stopping") return fail("STOPPING");
        state = "starting";
        stopRequested = false;
        try {
          if (pre !== undefined) {
            const code = parsePreflight(await bounded<unknown>(tmr, startTimeoutMs, pre));
            if (stopRequested) return fail("STOPPED_DURING_START");
            if (code !== null) return fail("PREFLIGHT_FAILED", code);
          }
          const atMs = readClock(clk); // بی‌await تا `loop.start()`: `stop` در این فاصله نمی‌تواند وسط بیاید.
          if (atMs === null) return fail("CLOCK_INVALID");
          const r = loop.start();
          if (!r.started) return fail(r.reason);
          startedAtMs = atMs;
          state = "running";
          return Object.freeze({ started: true as const, atMs });
        } finally {
          if (state === "starting") state = "idle";
        }
      } catch {
        state = state === "running" ? "running" : "idle";
        return fail("PREFLIGHT_FAILED", "UNAVAILABLE");
      }
    }

    function stop(): Promise<LoopStopResult> {
      try {
        if (state === "starting") {
          stopRequested = true; // حلقه هنوز نساخته؛ `start` در گامِ بعدی خودش را لغو می‌کند.
          return Promise.resolve(Object.freeze({ clean: true }));
        }
        if (state === "stopping" && stopping !== null) return stopping;
        if (state === "idle") return loop.stop();
        state = "stopping";
        const p = loop.stop().then(
          (r) => r,
          () => Object.freeze({ clean: false }) as LoopStopResult,
        );
        stopping = p.then((r) => {
          state = "idle";
          stopping = null;
          return r;
        });
        return stopping;
      } catch {
        return Promise.resolve(Object.freeze({ clean: false }));
      }
    }

    function health(): RuntimeHealth {
      let nowMs = Number.NaN;
      let status: unknown;
      try {
        nowMs = clk.nowMs();
      } catch {
        // ساعتِ خراب ⇒ evaluate آن را CLOCK_INVALID/down می‌کند.
      }
      try {
        status = loop.status();
      } catch {
        // وضعیتِ ناخوانا ⇒ STATUS_INVALID/down.
      }
      const h = check.evaluate({ status: status as SweepLoopStatus, nowMs, sinceMs: startedAtMs });
      return Object.freeze({ health: h, httpStatus: sweepHealthHttpStatus(h) });
    }

    function status(): RuntimeStatus {
      return Object.freeze({ state, startedAtMs, loop: loop.status() });
    }

    const ports = Object.freeze({ ledger: ledger as SettlementRuntime["ports"]["ledger"], outbox: outbox as SettlementRuntime["ports"]["outbox"] });
    return { ok: true, value: Object.freeze({ start, stop, health, status, ports }) };
  } catch {
    return configError(["خواندن پیکربندی ناموفق بود."]);
  }
}
