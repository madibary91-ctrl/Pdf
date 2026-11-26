/**
 * حلقهٔ تازه‌سازیِ دوره‌ایِ سیاستِ ابزار (ADR-0072، CT‑5c‑2c‑2a): `source.refresh()` را با زمان‌سنجِ تزریقی دوره‌ای صدا می‌زند.
 * - **هرگز منتظرِ بی‌پایان نمی‌ماند:** هر تلاش یک نگهبانِ مهلت (`attemptDeadlineMs`) دارد؛ تلاشِ بی‌پاسخ «timed_out» حساب می‌شود، حلقه با `retryMs`
 *   ادامه می‌دهد و تلاشِ بعد (منبع تلاشِ قدیمی را پس از `refreshTimeoutMs` رها می‌کند) قفلِ همیشگی نمی‌سازد.
 * - هم‌زمانی ندارد: تلاشِ بعدی فقط پس از پایانِ (یا مهلتِ) تلاشِ قبل زمان‌بندی می‌شود؛ نتیجهٔ دیرهنگامِ تلاشِ رهاشده نادیده است.
 * - شکستِ زمان‌بندی (`timer.after` پرتاب کرد) بی‌صدا نیست: حالتِ `halted` (و منبع به‌زودی `STALE` ⇒ بسته).
 * - هرگز نمی‌پرتابد، متنِ خطا را نمی‌گیرد و هیچ تایمر/ساعت/محیطی را مستقیم نمی‌شناسد.
 */
import { parseOptions } from "./config";
import type {
  AttemptOutcome,
  PolicyRefresher,
  RefresherFailureCode,
  RefresherOptions,
  RefresherResult,
  RefresherStartResult,
  RefresherState,
  RefresherStatus,
  RefresherStopResult,
} from "./types";

type Attempt = { done: boolean; watchdog: unknown };
type Classified = Readonly<{ outcome: AttemptOutcome; code: RefresherFailureCode | null }>;

/** کدهای شکستِ منبع که حلقه می‌شناسد (کدِ ناشناخته ⇒ `INVALID_RESULT`)؛ SUPERSEDED جدا رسیدگی می‌شود. */
const SOURCE_CODES: Readonly<Record<Exclude<RefresherFailureCode, "TIMED_OUT" | "REFRESH_THREW" | "INVALID_RESULT">, true>> = Object.freeze({
  INVALID_CLOCK: true,
  READ_FAILED: true,
  STORED_POLICY_INVALID: true,
  INVALID_RESPONSE: true,
  PROJECTION_INVALID: true,
  VERSION_REGRESSED: true,
  VERSION_CONTENT_MISMATCH: true,
});

const OK: Classified = Object.freeze({ outcome: "ok", code: null });
const SUPERSEDED: Classified = Object.freeze({ outcome: "superseded", code: null });
const TIMED_OUT: Classified = Object.freeze({ outcome: "timed_out", code: "TIMED_OUT" });
const failed = (code: RefresherFailureCode): Classified => Object.freeze({ outcome: "failed", code });

/** نتیجهٔ منبع ورودیِ ناشناخته است: فقط `ok === true` موفقیت است (دسترسیِ پرتاب‌کننده یا مقدارِ غیرِشیء ⇒ INVALID_RESULT). */
function classify(result: unknown): Classified {
  let ok: unknown;
  let error: unknown;
  try {
    ok = (result as { ok?: unknown }).ok;
    error = (result as { error?: unknown }).error;
  } catch {
    return failed("INVALID_RESULT");
  }
  if (ok === true) return OK;
  if (ok !== false) return failed("INVALID_RESULT");
  let code: unknown;
  try {
    code = (error as { code?: unknown }).code;
  } catch {
    return failed("INVALID_RESULT");
  }
  if (code === "SUPERSEDED") return SUPERSEDED;
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(SOURCE_CODES, code) ? failed(code as RefresherFailureCode) : failed("INVALID_RESULT");
}

export function createPolicyRefresher(options: RefresherOptions): RefresherResult<PolicyRefresher> {
  const parsed = parseOptions(options);
  if (!parsed.ok) return parsed;
  const { refresh, after, cancel, intervalMs, retryMs, attemptDeadlineMs } = parsed.value;

  let phase: RefresherState = "idle";
  let haltReason: "SCHEDULE_FAILED" | null = null;
  let generation = 0;
  let inflight: Attempt | null = null;
  let nextHandle: unknown;
  let hasNext = false;
  let stopPromise: Promise<RefresherStopResult> | undefined;
  let stopResolve: ((r: RefresherStopResult) => void) | undefined;
  let attempts = 0;
  let failures = 0;
  let lastOutcome: AttemptOutcome | null = null;
  let lastFailure: RefresherFailureCode | null = null;

  const safeCancel = (handle: unknown): void => {
    try {
      cancel(handle);
    } catch {
      // قرارداد: cancel نمی‌پرتابد؛ پرتاب نباید حلقه را بشکند.
    }
  };

  const halt = (): void => {
    phase = "halted";
    haltReason = "SCHEDULE_FAILED";
  };

  function settle(attempt: Attempt, c: Classified, fromWatchdog: boolean): void {
    if (attempt.done) return;
    attempt.done = true;
    if (!fromWatchdog) safeCancel(attempt.watchdog);
    inflight = null;
    lastOutcome = c.outcome;
    if (c.outcome === "ok") {
      failures = 0;
      lastFailure = null;
    } else if (c.outcome !== "superseded") {
      failures += 1;
      lastFailure = c.code;
    }
    if (phase === "stopping") {
      phase = "idle";
      const resolve = stopResolve;
      stopResolve = undefined;
      stopPromise = undefined;
      resolve!(Object.freeze({ stopped: true, abandonedInFlight: c.outcome === "timed_out" }));
      return;
    }
    schedule(c.outcome === "ok" ? intervalMs : retryMs);
  }

  function schedule(delayMs: number): void {
    const mine = generation;
    try {
      nextHandle = after(() => onTick(mine), delayMs);
      hasNext = true;
    } catch {
      hasNext = false;
      halt();
    }
  }

  function onTick(mine: number): void {
    if (phase !== "running" || mine !== generation) return;
    hasNext = false;
    if (!launch()) halt();
  }

  /** نگهبانِ مهلت پیش از تلاش بسته می‌شود تا هرگز تلاشِ بی‌نگهبان نداشته باشیم. */
  function launch(): boolean {
    const attempt: Attempt = { done: false, watchdog: undefined };
    try {
      attempt.watchdog = after(() => settle(attempt, TIMED_OUT, true), attemptDeadlineMs);
    } catch {
      return false;
    }
    inflight = attempt;
    attempts += 1;
    new Promise<unknown>((resolve) => resolve(refresh())).then(
      (r) => settle(attempt, classify(r), false),
      () => settle(attempt, failed("REFRESH_THREW"), false),
    );
    return true;
  }

  const start = (): RefresherStartResult => {
    if (phase === "running") return Object.freeze({ started: false, reason: "ALREADY_RUNNING" });
    if (phase === "stopping") return Object.freeze({ started: false, reason: "STOPPING" });
    generation += 1;
    haltReason = null;
    phase = "running";
    if (!launch()) {
      halt();
      return Object.freeze({ started: false, reason: "SCHEDULE_FAILED" });
    }
    return Object.freeze({ started: true });
  };

  const stop = (): Promise<RefresherStopResult> => {
    if (stopPromise !== undefined) return stopPromise;
    if (hasNext) {
      safeCancel(nextHandle);
      hasNext = false;
    }
    if (inflight === null) {
      phase = "idle";
      haltReason = null;
      return Promise.resolve(Object.freeze({ stopped: true, abandonedInFlight: false }));
    }
    phase = "stopping";
    stopPromise = new Promise<RefresherStopResult>((resolve) => {
      stopResolve = resolve;
    });
    return stopPromise;
  };

  const status = (): RefresherStatus =>
    Object.freeze({
      state: phase,
      haltReason,
      inFlight: inflight !== null,
      attempts,
      consecutiveFailures: failures,
      lastOutcome,
      lastFailure,
    });

  return { ok: true, value: Object.freeze({ start, stop, status }) };
}
