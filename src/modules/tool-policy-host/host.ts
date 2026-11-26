/**
 * `createToolPolicyHost` — چرخهٔ عمرِ فرایندیِ یک `ToolPolicyRuntime` (ADR-0075). ماژول سیاستی نمی‌سازد؛ فقط تضمین می‌کند:
 *  ۱. **بوتِ شکست‌بسته و تک‌شروع:** سیگنال‌ها پیش از `runtime.start()` نصب می‌شوند (نصبِ ناموفق ⇒ ریشه شروع نمی‌شود)؛
 *     هم‌زمان ⇒ یک وعده؛ فقط `UNAVAILABLE` بازتلاش می‌شود (`NOT_MIGRATED`/`SCHEMA_MISMATCH`/… نیازِ مداخلهٔ انسان دارند).
 *  ۲. **«بوت شد» ≠ «آماده است»:** `start()` ریشه نخستین تازه‌سازی را منتظر نمی‌ماند؛ آمادگی فقط از `health()` ریشه و فقط در پروب‌ها خوانده می‌شود
 *     (ترافیک بدونِ سیاستِ تازه نمی‌گیریم)؛ پروبِ startup از نخستین «آماده»ِ دیده‌شده چسبنده است.
 *  ۳. **خاموشیِ مرتب، مهلت‌دار و یک‌بار:** `stopping` (ready ⇒ ۵۰۳) ← `runtime.stop()` ← انتظارِ بوتِ در جریان ←
 *     (فقط پس از توقفِ تمیز) `closeResources()` ← `stopped`؛ همه زیرِ یک مهلتِ کلی؛ زمان‌سنجِ خراب مانعِ stop نیست.
 *  ۴. **هیچ متدی نمی‌پرتابد** و خروجیِ هر پورت ناقابل‌اعتماد فرض می‌شود.
 */
import { parseHostConfig } from "./config";
import type { HostSettings } from "./config";
import { evaluateProbe, readReadiness } from "./probes";
import type {
  BootFailureReason,
  ClosedState,
  HostBootResult,
  HostEvent,
  HostResult,
  HostSignal,
  HostState,
  HostStatus,
  ProbeKind,
  ProbeResult,
  RuntimeFailureReason,
  ShutdownReason,
  ShutdownResult,
  ToolPolicyHost,
} from "./types";

const SIGNALS: readonly HostSignal[] = ["SIGTERM", "SIGINT"];
const RUNTIME_REASONS: readonly string[] = ["ALREADY_STARTED", "STOPPING", "STOPPED_DURING_START", "NOT_MIGRATED", "SCHEMA_MISMATCH", "UNAVAILABLE", "SCHEDULE_FAILED"];

type StartOutcome = Readonly<{ started: true }> | Readonly<{ started: false; reason: BootFailureReason }>;

const invalidStart: StartOutcome = Object.freeze({ started: false as const, reason: "RUNTIME_INVALID" as const });
const okStart: StartOutcome = Object.freeze({ started: true as const });

/** پاسخِ `start()` ورودیِ ناشناخته است: فقط `started===true` یا `started===false` با دلیلی از مجموعهٔ بسته. */
export function normalizeStart(r: unknown): StartOutcome {
  try {
    if (typeof r !== "object" || r === null) return invalidStart;
    const v = r as { started?: unknown; reason?: unknown };
    const started = v.started;
    if (started === true) return okStart;
    if (started !== false) return invalidStart;
    const reason = v.reason;
    if (typeof reason !== "string" || !RUNTIME_REASONS.includes(reason)) return invalidStart;
    return Object.freeze({ started: false as const, reason: reason as RuntimeFailureReason });
  } catch {
    return invalidStart;
  }
}

/** توقفِ «تمیز» یعنی `stopped===true` و تلاشِ در جریانی رها نشد؛ هر چیزِ دیگر (شکل ناشناخته هم) ناتمیز است. */
export function isCleanStop(r: unknown): boolean {
  try {
    if (typeof r !== "object" || r === null) return false;
    const v = r as { stopped?: unknown; abandonedInFlight?: unknown };
    return v.stopped === true && v.abandonedInFlight === false;
  } catch {
    return false;
  }
}

export function createToolPolicyHost(raw: unknown): HostResult<ToolPolicyHost> {
  try {
    const parsed = parseHostConfig(raw);
    if (!parsed.ok) return parsed;
    const cfg: HostSettings = parsed.value;
    const { runtime, timer, signals, exit, closeResources, observer } = cfg;

    let state: HostState = "idle";
    let hasBooted = false;
    let hasBeenReady = false;
    let attempts = 0;
    let lastFailure: { reason: BootFailureReason } | null = null;
    let shutdownReason: ShutdownReason | null = null;
    let bootPromise: Promise<HostBootResult> | null = null;
    let bootSuccess: HostBootResult | null = null;
    let shutdownPromise: Promise<ShutdownResult> | null = null;
    let exitRequested = false;
    let abortWait: (() => void) | null = null;
    const listeners = new Map<HostSignal, () => void>();

    function emit(event: HostEvent): void {
      if (observer === null) return;
      try {
        const out: unknown = (observer as (e: HostEvent) => unknown)(Object.freeze(event));
        if (typeof out === "object" && out !== null && typeof (out as { then?: unknown }).then === "function") {
          Promise.resolve(out).then(undefined, () => undefined);
        }
      } catch {
        // مشاهده‌گر هرگز رفتارِ میزبان را عوض نمی‌کند.
      }
    }

    function removeSignals(): void {
      if (signals === false) return;
      for (const [sig, l] of listeners) {
        try {
          signals.off(sig, l);
        } catch {
          // برداشتنِ ناموفق بی‌خطر است.
        }
      }
      listeners.clear();
    }

    function installSignals(): boolean {
      if (signals === false || listeners.size > 0) return true;
      try {
        for (const sig of SIGNALS) {
          const l = (): void => onSignal(sig);
          signals.on(sig, l);
          listeners.set(sig, l);
        }
        return true;
      } catch {
        removeSignals();
        return false;
      }
    }

    function callExit(ok: boolean): void {
      if (exit === null) return;
      try {
        exit(ok ? 0 : 1);
      } catch {
        // exit پرتاب کند فرایند با استثنا نمی‌میرد؛ تصمیمِ بعدی با مالک.
      }
    }

    function onSignal(sig: HostSignal): void {
      exitRequested = true; // خاموشیِ جاری (تکراری یا دستی) پس از پایان exit را هم صدا می‌زند؛ shutdownInternal تکراری را یک وعده می‌کند.
      void shutdownInternal(sig);
    }

    const failBoot = (reason: BootFailureReason): HostBootResult => {
      state = "failed";
      lastFailure = { reason };
      emit({ type: "boot.failed", attempts, reason });
      return Object.freeze({ booted: false as const, reason, attempts });
    };
    const shuttingDown = (): HostBootResult => Object.freeze({ booted: false as const, reason: "SHUTTING_DOWN" as const, attempts });

    async function startOnce(): Promise<StartOutcome> {
      try {
        return normalizeStart(await runtime.start());
      } catch {
        return invalidStart;
      }
    }

    /** `elapsed` | `aborted` (خاموشی) | `broken` (زمان‌سنجِ خراب). */
    function sleep(ms: number): Promise<"elapsed" | "aborted" | "broken"> {
      return new Promise((resolve) => {
        let handle: unknown;
        let armed = false;
        let settled = false;
        const finish = (r: "elapsed" | "aborted" | "broken"): void => {
          if (settled) return;
          settled = true;
          abortWait = null;
          if (armed && r !== "elapsed") {
            try {
              timer.cancel(handle);
            } catch {
              // لغوِ ناموفق بی‌خطر است.
            }
          }
          resolve(r);
        };
        try {
          handle = timer.after(() => finish("elapsed"), ms);
          armed = true;
        } catch {
          finish("broken");
          return;
        }
        if (!settled) abortWait = () => finish("aborted");
      });
    }

    async function bootSequence(): Promise<HostBootResult> {
      attempts = 0;
      lastFailure = null;
      if (!installSignals()) return failBoot("SIGNALS_UNAVAILABLE");
      for (;;) {
        if (state !== "booting") return shuttingDown();
        attempts += 1;
        const r = await startOnce();
        if (state !== "booting") return shuttingDown(); // shutdown() خودش runtime.stop() را صدا زده است.
        if (r.started) {
          state = "running";
          hasBooted = true;
          const done: HostBootResult = Object.freeze({ booted: true as const, attempts });
          bootSuccess = done;
          emit({ type: "booted", attempts });
          return done;
        }
        const willRetry = r.reason === "UNAVAILABLE" && attempts < cfg.maxAttempts;
        emit({ type: "boot.attempt_failed", attempt: attempts, reason: r.reason, willRetry });
        if (!willRetry) return failBoot(r.reason);
        const waited = await sleep(cfg.delayMs);
        if (waited === "broken") return failBoot(r.reason);
      }
    }

    function boot(): Promise<HostBootResult> {
      if (state === "running") return Promise.resolve(bootSuccess as HostBootResult); // ناوردا: running ⇔ bootSuccess ثبت شده
      if (state === "booting" && bootPromise !== null) return bootPromise;
      if (state === "stopping" || state === "stopped") return Promise.resolve(shuttingDown());
      state = "booting";
      bootSuccess = null;
      // bootSequence هرگز ردّ نمی‌شود: همهٔ پورت‌ها (start، timer، signals، observer) درونش محافظت شده‌اند.
      const p = bootSequence();
      bootPromise = p; // پس از پایان نگه داشته می‌ماند (وعدهٔ حل‌شده بی‌خطر است)؛ بوتِ بعدی آن را بازنویسی می‌کند.
      return p;
    }

    async function safeStop(): Promise<boolean> {
      try {
        return isCleanStop(await runtime.stop());
      } catch {
        return false;
      }
    }

    async function run(reason: ShutdownReason, pendingBoot: Promise<HostBootResult> | null): Promise<ShutdownResult> {
      const st = { stopClean: false, closeStarted: false, closeOk: false, closeDone: false };
      const work = async (): Promise<void> => {
        st.stopClean = await safeStop();
        if (pendingBoot !== null) await pendingBoot; // بوتِ نیمه‌کاره از منابع استفاده می‌کند؛ پیش از بستنشان تمام شود (هرگز ردّ نمی‌شود).
        if (!st.stopClean || closeResources === null) return;
        st.closeStarted = true;
        try {
          await closeResources();
          st.closeOk = true;
        } catch {
          st.closeOk = false;
        }
        st.closeDone = true;
      };
      const outcome = await new Promise<"done" | "timeout">((resolve) => {
        let handle: unknown;
        let armed = false;
        try {
          handle = timer.after(() => resolve("timeout"), cfg.shutdownTimeoutMs);
          armed = true;
        } catch {
          // زمان‌سنجِ خراب مانعِ توقف نمی‌شود؛ فقط مهلت نداریم.
        }
        void work().then(() => {
          if (armed) {
            try {
              timer.cancel(handle);
            } catch {
              // لغوِ ناموفق بی‌خطر است.
            }
          }
          resolve("done");
        });
      });
      const timedOut = outcome === "timeout";
      const clean = st.stopClean;
      const closed: ClosedState = closeResources === null ? "none" : !clean ? "skipped" : st.closeStarted && st.closeDone && st.closeOk ? "ok" : "failed";
      const ok = clean && !timedOut && (closed === "none" || closed === "ok");
      return Object.freeze({ ok, clean, timedOut, closed, reason });
    }

    function shutdownInternal(reason: ShutdownReason): Promise<ShutdownResult> {
      if (shutdownPromise !== null) return shutdownPromise;
      shutdownReason = reason;
      state = "stopping";
      const pendingBoot = bootPromise;
      emit({ type: "shutdown.started", reason });
      const wake = abortWait;
      if (wake !== null) wake();
      // run هرگز ردّ نمی‌شود: stop/close/timer/pendingBoot همه محافظت شده‌اند.
      shutdownPromise = run(reason, pendingBoot).then((r) => {
        state = "stopped";
        removeSignals();
        emit({ type: "shutdown.finished", reason, ok: r.ok, clean: r.clean, timedOut: r.timedOut, closed: r.closed });
        if (exitRequested) callExit(r.ok);
        return r;
      });
      return shutdownPromise;
    }

    const shutdown = (): Promise<ShutdownResult> => shutdownInternal("MANUAL");

    function status(): HostStatus {
      return Object.freeze({ state, bootAttempts: attempts, hasBooted, hasBeenReady, lastBootFailure: lastFailure === null ? null : Object.freeze({ ...lastFailure }), shutdownReason });
    }

    function latch(): void {
      if (hasBeenReady) return;
      hasBeenReady = true;
      emit({ type: "ready.first" });
    }

    /** نخستین «آماده»ی دیده‌شده (فقط در `running`) چسبنده ثبت می‌شود؛ فقط پروب‌ها آن را می‌خوانند (هر پروب حداکثر یک بار `health()` می‌خواند). */
    const probe = (kind: ProbeKind): ProbeResult => {
      const read = (): unknown => runtime.health();
      if (kind === "startup" && !hasBeenReady && state === "running" && readReadiness(read).ready) latch();
      const res = evaluateProbe(kind, { state, hasBeenReady, readHealth: read });
      if (kind === "ready" && res.body.ok && state === "running") latch();
      return res;
    };
    const probes = Object.freeze({ live: () => probe("live"), startup: () => probe("startup"), ready: () => probe("ready") });

    return { ok: true, value: Object.freeze({ boot, shutdown, status, probes }) };
  } catch {
    return { ok: false, error: Object.freeze({ code: "INVALID_CONFIG" as const, message: "خواندن پیکربندی ناموفق بود.", issues: Object.freeze(["خواندن پیکربندی ناموفق بود."]) }) };
  }
}
