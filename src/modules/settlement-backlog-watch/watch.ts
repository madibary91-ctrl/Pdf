/**
 * `createBacklogWatch` — حلقهٔ پس‌زمینهٔ نمونه‌گیریِ پسماند + کش + `view()` همگام (ADR-0042). ماژول سیاستِ آستانه نمی‌سازد (در `settlement-backlog` است)؛
 * فقط زمان‌بندی و کش را تضمین می‌کند:
 *  ۱. **بی‌هم‌پوشانی:** نمونهٔ بعد فقط پس از پایانِ نمونهٔ جاری و `intervalMs` زمان‌بندی می‌شود (زنجیرهٔ `after`، نه `setInterval`)؛ پایگاهِ کُند انباشتِ خواندن نمی‌سازد.
 *  ۲. **پروب بی‌I/O:** `view()` فقط کش و ساعت را می‌خواند؛ پایگاهِ آویزان هرگز پروب را کُند نمی‌کند.
 *  ۳. **نسل:** هر `stop` نسل را عوض می‌کند؛ خواندنِ رهاشده و تیکِ زمان‌سنجِ لغوناپذیرِ نسلِ قبل (پس از `stop`) هرگز کش را دست نمی‌زند، خواندنِ تازه یا تایمر نمی‌سازد.
 *  ۴. **`stop` هرگز آویزان نمی‌شود:** منتظرِ پایگاه نمی‌ماند (خواندنِ در جریان رها می‌شود و با مهلتِ مانیتور خودش تمام می‌شود).
 *  ۵. **هیچ متدی نمی‌پرتابد.** زمان‌سنجِ خراب ⇒ فاز `stalled` و کهنه‌شدنِ نمونه (دیده می‌شود)، نه سکوت.
 */
import { resolveWatchSettings } from "./config";
import type { BacklogWatch, BacklogView, BacklogWatchPhase, WatchResult, WatchStartResult, WatchStopResult } from "./types";
import { safeView } from "./view";
import type { GoodSample } from "./view";
import type { BacklogSampleFailure } from "@/modules/settlement-backlog";

const FAILURES: readonly string[] = ["CLOCK_INVALID", "LIST_FAILED", "BAD_LIST", "TIMEOUT"];

function readClock(clock: { nowMs(): number }): number | null {
  try {
    const t: unknown = clock.nowMs();
    return typeof t === "number" && Number.isSafeInteger(t) && t >= 0 ? t : null;
  } catch {
    return null;
  }
}

export function createBacklogWatch(raw: unknown): WatchResult<BacklogWatch> {
  const r = resolveWatchSettings(raw);
  if (!r.ok) return r;
  const s = r.value;

  let phase: BacklogWatchPhase = "idle";
  let gen = 0;
  let lastGood: GoodSample | null = null;
  let failure: BacklogSampleFailure | null = null;
  let handle: unknown;
  let hasHandle = false;
  let reading = false;

  function record(sample: unknown): void {
    try {
      const v = sample as { ok?: unknown; code?: unknown } | null;
      if (typeof v === "object" && v !== null && v.ok === true) {
        lastGood = sample as GoodSample;
        failure = null;
        return;
      }
      const code = typeof v === "object" && v !== null ? v.code : undefined;
      failure = typeof code === "string" && FAILURES.includes(code) ? (code as BacklogSampleFailure) : "BAD_LIST";
    } catch {
      failure = "BAD_LIST";
    }
  }

  function schedule(g: number): void {
    let fired = false;
    try {
      const h = s.timer.after(() => {
        fired = true;
        hasHandle = false;
        tick(g);
      }, s.intervalMs);
      if (!fired) {
        handle = h;
        hasHandle = true;
      }
    } catch {
      phase = "stalled";
    }
  }

  function tick(g: number): void {
    if (g !== gen) return;
    reading = true;
    let p: Promise<unknown>;
    try {
      p = Promise.resolve(s.monitor.sample());
    } catch {
      p = Promise.resolve(null);
    }
    p.then(
      (sample) => finish(g, sample),
      () => finish(g, null),
    );
  }

  function finish(g: number, sample: unknown): void {
    if (g !== gen) return; // رهاشده: هیچ‌چیز را دست نمی‌زند.
    reading = false;
    record(sample);
    schedule(g);
  }

  function cancelTimer(): void {
    if (!hasHandle) return;
    hasHandle = false;
    try {
      s.timer.cancel(handle);
    } catch {
      // لغوِ ناموفق چیزی را عوض نمی‌کند؛ نسلِ جدید تیکِ قدیمی را خنثی می‌کند.
    }
  }

  const watch: BacklogWatch = Object.freeze({
    start(): WatchStartResult {
      if (phase === "running") return Object.freeze({ started: false as const, reason: "ALREADY_RUNNING" as const });
      phase = "running";
      tick(gen);
      return Object.freeze({ started: true as const });
    },
    stop(): WatchStopResult {
      const abandonedRead = reading;
      cancelTimer();
      gen += 1;
      reading = false;
      if (phase !== "idle") phase = "stopped";
      return Object.freeze({ stopped: true as const, abandonedRead });
    },
    view(): BacklogView {
      return safeView({ phase, readyPolicy: s.readyPolicy, lastGood, failure, nowMs: readClock(s.clock), evaluate: s.monitor.evaluate });
    },
  });
  return { ok: true, value: watch };
}
