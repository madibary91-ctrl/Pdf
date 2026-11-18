/**
 * حلقهٔ رفتگر تسویه (ADR-0023، م۳‑ج): `sweep()` را با زمان‌سنجِ تزریقی و بی‌هم‌پوشانی زمان‌بندی می‌کند؛ بی‌تایمرِ سراسری و بی‌ساعتِ سیستم.
 * ناورداها:
 *  ۱. **تک‌پرواز:** هرگز دو `sweep()` هم‌زمان؛ گذر بعد فقط پس از پایانِ گذرِ پیشین زمان‌بندی می‌شود (زنجیرِ تایمرِ یک‌باره، نه interval).
 *  ۲. **سقفِ فاصله:** تأخیرِ هر گذر ≤ ⌊graceMs/2⌋ (پیکربندی تضمین می‌کند)، حتی زیر شکستِ پیاپی.
 *  ۳. **بی‌پرتاب و بی‌نشت:** رفتگرِ تزریقی، زمان‌سنج، ساعت و مشاهده‌گر ممکن است بپرتابند؛ هیچ‌کدام حلقه را نمی‌شکنند و هیچ پیامِ خامی بیرون نمی‌آید.
 *  ۴. **زنگِ مرگ هرگز گم نمی‌شود:** حتی گذری که پس از `stop` ناپاک تمام می‌شود، `onBuried` را صدا می‌زند.
 *  ۵. **خاموشیِ ساکت نیست:** اگر زمان‌سنج نتواند گذر بعد را بسازد، وضعیت `stalled` و خطای `SCHEDULE_FAILED` اعلام می‌شود.
 *  ۶. **هر تایمر یک بار:** هر زمان‌بندی یک نشانهٔ یکتا دارد؛ تایمرِ دوباره‌صداشده یا کهنه هرگز زنجیرِ دوم نمی‌سازد.
 * مشاهده‌گرها await نمی‌شوند.
 *
 * م۳‑د‑۲ (ADR-0026) — زنگِ ماندگار، اختیاری (`deadLetters`):
 *  ۷. **دست‌کم‌یک‌بار:** در هر گذر (از جمله نخستین گذرِ پس از `start`، یعنی پس از هر ریستارت) مرده‌های **تأییدنشده** از outbox خوانده و به `deliver`
 *     داده می‌شوند؛ تأیید **فقط پس از موفقیتِ `deliver`**. نرسیدن یا تأییدنشدن = دوباره در گذر بعد؛ هیچ زنگی گم نمی‌شود.
 *  ۸. **هرگز آویزان نمی‌شود:** `deliver` await می‌شود ولی با مهلتِ زمان‌سنجِ تزریقی؛ مهلت/پرتاب/ردّ ⇒ شکستِ همان رکورد، رکوردهای دیگر ادامه می‌دهند.
 *  ۹. **رکوردِ مسموم گرسنگی نمی‌دهد:** رکوردی که در همین گذر شکست خورد از دسته‌های بعدیِ همین گذر کنار می‌رود (یک تلاش در هر گذر).
 *  ۱۰. **سقفِ فاصله دست‌نخورده:** شکستِ زنگ عقب‌نشینیِ همان سیاستِ ADR-0023 را می‌گیرد؛ فاصله هرگز از ⌊graceMs/2⌋ بیشتر نمی‌شود، پس تسویه کند نمی‌شود.
 */
import type { Clock } from "@/modules/ledger";
import { SETTLEMENT_LIMITS, resolveSweepLoopConfig } from "./config";
import { faultOf, hasProgress, nextDelay, parseDeadList, parseReport } from "./loop-policy";
import type { RunOutcome } from "./loop-policy";
import type { LoopFault, LoopFaultKind, LoopRunInfo, LoopStartResult, LoopState, LoopStopResult, SettlementResult, SweepLoop, SweepLoopStatus, SweepReport } from "./types";

type Totals = { examined: number; settled: number; retryLater: number; raced: number; outboxFailures: number; buried: number; faults: number; observerFailures: number };

const cap = (n: number): number => (n > Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : n);

function readClock(clock: Clock): number | null {
  try {
    const t = clock.nowMs();
    return Number.isSafeInteger(t) && t >= 0 ? t : null;
  } catch {
    return null;
  }
}

export function createSweepLoop(raw: unknown): SettlementResult<SweepLoop> {
  const resolved = resolveSweepLoopConfig(raw);
  if (!resolved.ok) return resolved;
  const cfg = resolved.value;
  const policy = Object.freeze({ intervalMs: cfg.intervalMs, maxBackoffMs: cfg.maxBackoffMs, maxDrainRuns: cfg.maxDrainRuns });

  let running = false;
  let stalled = false;
  /** گذری در حال اجراست (درست پیش از زمان‌بندیِ گذر بعد پاک می‌شود). */
  let busy = false;
  let inFlight: Promise<void> | null = null;
  let stopping: Promise<LoopStopResult> | null = null;
  /** نسلِ حلقه؛ با هر `start`/`stop` بالا می‌رود تا گذرِ کهنه زمان‌بندی نکند. */
  let generation = 0;
  let armed = false;
  let armSeq = 0;
  let handle: unknown;
  let drainRuns = 0;

  const dead = { delivered: 0, acknowledged: 0, deliverFailures: 0, ackFailures: 0, listFailures: 0, lastAckAtMs: null as number | null };

  let runs = 0;
  let consecutiveFailures = 0;
  let lastRunAtMs: number | null = null;
  let lastSuccessAtMs: number | null = null;
  let lastFault: LoopFaultKind | null = null;
  const totals: Totals = { examined: 0, settled: 0, retryLater: 0, raced: 0, outboxFailures: 0, buried: 0, faults: 0, observerFailures: 0 };

  function notify(call: () => unknown): void {
    try {
      const r: unknown = call();
      if ((typeof r === "object" || typeof r === "function") && r !== null) {
        const then = (r as { then?: unknown }).then;
        if (typeof then === "function") (then as (a: undefined, b: () => void) => unknown).call(r, undefined, () => void (totals.observerFailures = cap(totals.observerFailures + 1)));
      }
    } catch {
      totals.observerFailures = cap(totals.observerFailures + 1);
    }
  }

  function emitFault(kind: LoopFaultKind, nextDelayMs: number | null): void {
    totals.faults = cap(totals.faults + 1);
    lastFault = kind;
    const fault: LoopFault = Object.freeze({ kind, consecutiveFailures, nextDelayMs });
    notify(() => cfg.observer?.onFault?.(fault));
  }

  function disarm(): void {
    if (!armed) return;
    armed = false; // تایمرِ آویزان (حتی اگر لغوش ناموفق باشد) با `!armed` یا نشانهٔ تازه بی‌اثر می‌شود.
    const h = handle;
    handle = undefined;
    try {
      cfg.timer.cancel(h);
    } catch {
      // لغوِ ناموفق بی‌خطر است: نشانهٔ تایمر دیگر معتبر نیست.
    }
  }

  /** زمان‌سنج بیرونی است: پرتاب ⇒ `false` (فراخوانده تصمیم می‌گیرد). */
  function arm(delayMs: number, gen: number): boolean {
    disarm();
    armSeq += 1;
    const token = armSeq;
    armed = true;
    try {
      const h = cfg.timer.after(() => tick(gen, token), delayMs);
      if (armed && token === armSeq) handle = h;
      return true;
    } catch {
      if (token === armSeq) {
        armed = false;
        handle = undefined;
      }
      return false;
    }
  }

  function tick(gen: number, token: number): void {
    try {
      if (token !== armSeq || !armed) return; // تایمرِ کهنه یا دوباره‌صداشده
      armed = false;
      handle = undefined;
      if (!running || gen !== generation || busy) return;
      busy = true;
      inFlight = runOnce(gen);
    } catch {
      busy = false;
    }
  }

  /**
   * `call` را با مهلتِ زمان‌سنجِ تزریقی await می‌کند؛ هرگز نمی‌پرتابد و آویزان نمی‌ماند. `true` فقط اگر `call` پیش از مهلت موفق شد.
   * زمان‌سنجِ خراب (نتوانست مهلت بسازد) ⇒ `call` اصلاً صدا زده نمی‌شود (بی‌مهلت نمی‌شود منتظر ماند).
   */
  function callBounded(call: () => unknown, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let armedTimeout = false;
      let timeoutHandle: unknown;
      const finish = (okay: boolean): void => {
        if (settled) return;
        settled = true;
        if (armedTimeout) {
          try {
            cfg.timer.cancel(timeoutHandle);
          } catch {
            // بی‌خطر
          }
        }
        resolve(okay);
      };
      try {
        armedTimeout = true;
        const h = cfg.timer.after(() => finish(false), timeoutMs);
        if (!settled) timeoutHandle = h;
      } catch {
        armedTimeout = false;
        finish(false);
        return;
      }
      if (settled) return; // زمان‌سنجِ همگام: مهلت پیش از شروع گذشت
      try {
        Promise.resolve(call()).then(
          () => finish(true),
          () => finish(false),
        );
      } catch {
        finish(false);
      }
    });
  }

  const isOk = (r: unknown): r is { ok: true; value: unknown } => {
    try {
      return typeof r === "object" && r !== null && (r as { ok?: unknown }).ok === true;
    } catch {
      return false;
    }
  };

  /**
   * زنگِ ماندگار (ADR-0026). پیش از هر کار: ایستادنِ حلقه (`stop`/نسلِ تازه) میانِ رکوردها محترم است؛ هرچه مانده تأییدنشده می‌ماند (و بعداً می‌رسد).
   * نخستین خطا در ترتیبِ «فهرست، تحویل، تأیید» خطای گذر است؛ شمارنده‌ها همهٔ خطاها را می‌شمارند.
   */
  async function deliverDead(gen: number): Promise<{ fault: LoopFaultKind | null; more: boolean }> {
    const dl = cfg.deadLetters;
    if (dl === null) return { fault: null, more: false };
    let fault: LoopFaultKind | null = null;
    const note = (kind: LoopFaultKind): void => {
      if (fault === null) fault = kind;
    };
    const failed = new Set<string>();
    const alive = (): boolean => running && gen === generation;
    let more = false;
    for (let batch = 0; batch < dl.maxBatchesPerRun; batch++) {
      if (!alive()) return { fault, more: false };
      const want = Math.min(SETTLEMENT_LIMITS.maxDeadBatchLimit, dl.batchLimit + failed.size);
      let listed: ReturnType<typeof parseDeadList> = null;
      try {
        const r: unknown = await dl.outbox.listUnacknowledgedDead({ limit: want });
        if (isOk(r)) listed = parseDeadList(r.value, want);
      } catch {
        listed = null;
      }
      if (listed === null) {
        dead.listFailures = cap(dead.listFailures + 1);
        note("DEAD_LIST_FAILED");
        return { fault, more: false };
      }
      const fresh = listed.filter((p) => !failed.has(p.key)).slice(0, dl.batchLimit);
      if (fresh.length === 0) return { fault, more: false };
      for (const item of fresh) {
        if (!alive()) return { fault, more: false };
        const delivered = await callBounded(() => dl.deliver(item.letter), dl.deliverTimeoutMs);
        if (!delivered) {
          failed.add(item.key);
          dead.deliverFailures = cap(dead.deliverFailures + 1);
          note("DEAD_DELIVER_FAILED");
          continue;
        }
        dead.delivered = cap(dead.delivered + 1);
        const atMs = readClock(cfg.clock);
        let acked = false;
        if (atMs !== null) {
          try {
            acked = isOk(await dl.outbox.acknowledgeDead(item.ref, { atMs }));
          } catch {
            acked = false;
          }
        }
        if (!acked) {
          failed.add(item.key);
          dead.ackFailures = cap(dead.ackFailures + 1);
          note("DEAD_ACK_FAILED");
          continue;
        }
        dead.acknowledged = cap(dead.acknowledged + 1);
        dead.lastAckAtMs = atMs;
      }
      if (listed.length < want) return { fault, more: false }; // همهٔ تأییدنشده‌ها دیده شد
      if (batch === dl.maxBatchesPerRun - 1) more = true; // سقفِ دسته‌ها؛ گذر بعد بی‌انتظار ادامه می‌دهد
    }
    return { fault, more };
  }

  async function runOnce(gen: number): Promise<void> {
    // یک ریزتیک: `inFlight` پیش از هر کارِ دیگر مقدار می‌گیرد (stop همین را await می‌کند).
    await null;
    let report: SweepReport | null = null;
    let fault: LoopFaultKind | null = null;
    try {
      const got: unknown = await cfg.sweeper.sweep();
      report = parseReport(got);
      fault = report === null ? "BAD_REPORT" : faultOf(report);
    } catch {
      fault = "SWEEP_THREW";
    }
    // م۳‑د‑۲: زنگِ ماندگار پس از رفتگر (مرده‌های تازهٔ همین گذر هم در همین گذر می‌رسند). مستقل از شکستِ رفتگر؛ هرگز نمی‌پرتابد.
    let deadFault: LoopFaultKind | null = null;
    let deadMore = false;
    if (cfg.deadLetters !== null) {
      try {
        const d = await deliverDead(gen);
        deadFault = d.fault;
        deadMore = d.more;
      } catch {
        deadFault = "DEAD_LIST_FAILED";
      }
    }
    const anyFault = fault ?? deadFault;
    const atMs = readClock(cfg.clock);

    runs = cap(runs + 1);
    lastRunAtMs = atMs;
    if (report !== null) {
      totals.examined = cap(totals.examined + report.examined);
      totals.settled = cap(totals.settled + report.settled);
      totals.retryLater = cap(totals.retryLater + report.retryLater);
      totals.raced = cap(totals.raced + report.raced);
      totals.outboxFailures = cap(totals.outboxFailures + report.outboxFailures);
      totals.buried = cap(totals.buried + report.buried.length);
    }
    if (anyFault === null) {
      consecutiveFailures = 0;
      lastSuccessAtMs = atMs;
    } else {
      consecutiveFailures = cap(consecutiveFailures + 1);
    }

    const outcome: RunOutcome = anyFault !== null ? "unhealthy" : deadMore || (report !== null && hasProgress(report)) ? "progress" : "idle";
    const next = nextDelay(policy, outcome, consecutiveFailures, drainRuns);
    drainRuns = next.drainRuns;
    busy = false;

    let nextDelayMs: number | null = null;
    let scheduleFailed = false;
    if (running && gen === generation) {
      if (arm(next.delayMs, gen)) nextDelayMs = next.delayMs;
      else {
        scheduleFailed = true;
        running = false;
        stalled = true;
      }
    }

    // ناوردای ۴: گزارشِ مرگ حتی پس از stop می‌رسد. ترتیب: زنگ، خطا، سنجه.
    const info: LoopRunInfo = Object.freeze({ run: runs, atMs, nextDelayMs });
    if (report !== null && report.buried.length > 0) {
      const items = report.buried;
      notify(() => cfg.observer?.onBuried?.(items, info));
    }
    if (fault !== null) emitFault(fault, nextDelayMs);
    if (deadFault !== null) emitFault(deadFault, nextDelayMs);
    if (scheduleFailed) emitFault("SCHEDULE_FAILED", null);
    if (report !== null) {
      const r = report;
      notify(() => cfg.observer?.onReport?.(r, info));
    }
  }

  function stateOf(): LoopState {
    if (running) return "running";
    if (busy) return "stopping";
    return stalled ? "stalled" : "stopped";
  }

  const loop: SweepLoop = Object.freeze({
    start(): LoopStartResult {
      try {
        if (running) return { started: false, reason: "ALREADY_RUNNING" };
        if (busy) return { started: false, reason: "PREVIOUS_RUN_ACTIVE" };
        generation += 1;
        stalled = false;
        drainRuns = 0;
        stopping = null;
        running = true;
        if (!arm(0, generation)) {
          running = false;
          emitFault("SCHEDULE_FAILED", null);
          return { started: false, reason: "SCHEDULE_FAILED" };
        }
        return { started: true };
      } catch {
        running = false;
        return { started: false, reason: "SCHEDULE_FAILED" };
      }
    },

    stop(): Promise<LoopStopResult> {
      try {
        if (running) {
          running = false;
          generation += 1;
        }
        stalled = false;
        disarm();
        const pending = inFlight;
        if (!busy || pending === null) return Promise.resolve({ clean: true });
        if (stopping !== null) return stopping;
        const p = new Promise<LoopStopResult>((resolve) => {
          let done = false;
          let timeoutHandle: unknown;
          let timeoutArmed = false;
          const finish = (clean: boolean): void => {
            if (done) return;
            done = true;
            if (timeoutArmed) {
              try {
                cfg.timer.cancel(timeoutHandle);
              } catch {
                // بی‌خطر
              }
            }
            resolve({ clean });
          };
          void pending.then(() => finish(true));
          try {
            timeoutArmed = true;
            timeoutHandle = cfg.timer.after(() => finish(false), cfg.stopTimeoutMs);
          } catch {
            timeoutArmed = false;
            finish(false); // بی‌مهلت نمی‌شود منتظر ماند؛ هرگز آویزان نمی‌مانیم.
          }
        });
        stopping = p;
        return p;
      } catch {
        return Promise.resolve({ clean: false });
      }
    },

    status(): SweepLoopStatus {
      return Object.freeze({
        state: stateOf(),
        busy,
        runs,
        consecutiveFailures,
        lastRunAtMs,
        lastSuccessAtMs,
        lastFault,
        totals: Object.freeze({ ...totals }),
        deadLetters: Object.freeze({ enabled: cfg.deadLetters !== null, ...dead }),
      });
    },
  });
  return { ok: true, value: loop };
}
