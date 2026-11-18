/**
 * حلقهٔ رفتگر (ADR-0023): پیکربندی، چرخهٔ عمر، تک‌پروازی، عقب‌نشینی، تخلیه، مشاهده‌گر و خرابیِ هر وابسته (رفتگر، زمان‌سنج، ساعت، مشاهده‌گر).
 * همه روی زمانِ مجازی؛ هیچ تایمر یا ساعتِ واقعی در کار نیست.
 */
import { describe, expect, it } from "vitest";
import { createSweepLoop } from "./index";
import type { LoopFault, LoopRunInfo, SweepLoop, SweepLoopStatus, SweepReport } from "./index";
import { fakeSweeper, flush, manualTimer, sweepReport } from "./test-kit";
import type { FakeSweeper, ManualTimer } from "./test-kit";

const GRACE = 20_000;
const INTERVAL = 1000;
const HALF = GRACE / 2;
const BURIED = { tenantId: "t", accountId: "a", reservationId: "r1", reason: "EXPIRED_UNBILLED", errorCode: "RESERVATION_EXPIRED" } as const;
const CANARY = "LEAK-CANARY-sweeper-5d2f";

type Events = { buried: Array<readonly unknown[]>; faults: LoopFault[]; reports: Array<{ report: SweepReport; info: LoopRunInfo }> };
type Rig = { loop: SweepLoop; timer: ManualTimer; sw: FakeSweeper; ev: Events };

function mk(step: (n: number) => unknown, over: Record<string, unknown> = {}, observer: Record<string, unknown> | null = null): Rig {
  const timer = manualTimer();
  const sw = fakeSweeper(step);
  const ev: Events = { buried: [], faults: [], reports: [] };
  const obs =
    observer ??
    ({
      onBuried: (items: readonly unknown[]) => void ev.buried.push(items),
      onFault: (f: LoopFault) => void ev.faults.push(f),
      onReport: (report: SweepReport, info: LoopRunInfo) => void ev.reports.push({ report, info }),
    } as Record<string, unknown>);
  const r = createSweepLoop({ sweeper: sw, timer, clock: timer.clock, graceMs: GRACE, intervalMs: INTERVAL, observer: obs, ...over });
  if (!r.ok) throw new Error(`createSweepLoop failed: ${r.error.issues.join("; ")}`);
  return { loop: r.value, timer, sw, ev };
}
const idle = (): SweepReport => sweepReport({ examined: 0 });

describe("settlement · createSweepLoop · پیکربندی", () => {
  const base = () => {
    const timer = manualTimer();
    return { sweeper: fakeSweeper(idle), timer, clock: timer.clock, graceMs: GRACE, intervalMs: INTERVAL };
  };
  it("پیکربندی کمینه معتبر است و پیش‌فرض‌ها اعمال می‌شوند (سقف عقب‌نشینی = نیمِ grace)", async () => {
    const r = createSweepLoop(base());
    expect(r.ok).toBe(true);
    // پیش‌فرضِ maxBackoffMs را از رفتار می‌خوانیم: شکستِ طولانی ⇒ تأخیر به نیمِ grace می‌رسد.
    const x = mk(() => sweepReport({ listFailed: true }));
    x.loop.start();
    await x.timer.advance(10 * 60_000);
    expect(Math.max(...x.timer.delays)).toBe(HALF);
  });
  it.each<[string, Record<string, unknown> | null]>([
    ["غیرشیء", null],
    ["بی‌sweeper", { sweeper: undefined }],
    ["sweeper بی‌sweep", { sweeper: {} }],
    ["بی‌timer", { timer: undefined }],
    ["timer بی‌cancel", { timer: { after: () => 1 } }],
    ["timer بی‌after", { timer: { cancel: () => 1 } }],
    ["بی‌clock", { clock: undefined }],
    ["clock بی‌nowMs", { clock: {} }],
    ["بی‌graceMs", { graceMs: undefined }],
    ["graceMs یک", { graceMs: 1 }],
    ["graceMs اعشاری", { graceMs: 2000.5 }],
    ["graceMs بزرگ‌تر از سقف", { graceMs: 10 ** 12 }],
    ["بی‌intervalMs", { intervalMs: undefined }],
    ["intervalMs صفر", { intervalMs: 0 }],
    ["intervalMs رشته", { intervalMs: "1000" }],
    ["intervalMs بیش از نیمِ grace", { intervalMs: HALF + 1 }],
    ["maxBackoffMs کمتر از interval", { maxBackoffMs: INTERVAL - 1 }],
    ["maxBackoffMs بیش از نیمِ grace", { maxBackoffMs: HALF + 1 }],
    ["maxBackoffMs اعشاری", { maxBackoffMs: 2000.5 }],
    ["maxDrainRuns صفر", { maxDrainRuns: 0 }],
    ["maxDrainRuns بزرگ", { maxDrainRuns: 1001 }],
    ["stopTimeoutMs صفر", { stopTimeoutMs: 0 }],
    ["stopTimeoutMs بزرگ", { stopTimeoutMs: 3_600_001 }],
    ["observer غیرشیء", { observer: 5 }],
    ["observer با کلید ناشناخته", { observer: { onWhatever: () => 1 } }],
    ["observer.onBuried غیرتابع", { observer: { onBuried: 1 } }],
    ["observer.onFault غیرتابع", { observer: { onFault: "x" } }],
    ["observer.onReport غیرتابع", { observer: { onReport: {} } }],
    ["کلید ناشناخته", { policy: "x" }],
  ])("%s ⇒ INVALID_CONFIG", (_n, over) => {
    const r = createSweepLoop(over === null ? null : { ...base(), ...over });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_CONFIG");
      expect(r.error.issues.length).toBeGreaterThan(0);
    }
  });
  it("graceMs نامعتبر و intervalMs بیش از نیمِ grace هر دو با نامِ خودشان گزارش می‌شوند", () => {
    const g = createSweepLoop({ ...base(), graceMs: 1 });
    expect(!g.ok && g.error.issues.some((i) => i.startsWith("graceMs"))).toBe(true);
    const i = createSweepLoop({ ...base(), intervalMs: HALF + 1 });
    expect(!i.ok && i.error.issues.some((m) => m.startsWith("intervalMs"))).toBe(true);
  });
  it("مرزها پذیرفته می‌شوند: interval = نیمِ grace، maxBackoff = interval، grace = ۲", () => {
    expect(createSweepLoop({ ...base(), intervalMs: HALF }).ok).toBe(true);
    expect(createSweepLoop({ ...base(), maxBackoffMs: INTERVAL }).ok).toBe(true);
    expect(createSweepLoop({ ...base(), graceMs: 2, intervalMs: 1 }).ok).toBe(true);
    expect(createSweepLoop({ ...base(), maxDrainRuns: 1000, stopTimeoutMs: 3_600_000 }).ok).toBe(true);
  });
  it("graceMs فرد: سقف کفِ نصف است", () => {
    expect(createSweepLoop({ ...base(), graceMs: 2001, intervalMs: 1000 }).ok).toBe(true);
    expect(createSweepLoop({ ...base(), graceMs: 2001, intervalMs: 1001 }).ok).toBe(false);
  });
  it("پیکربندیِ نامعتبر مشکل‌ها را نام می‌برد نه مقدار را", () => {
    const r = createSweepLoop({ ...base(), sweeper: { sweep: 1 }, extra: CANARY });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).not.toContain("sweep: 1");
  });
  it("getter پرتاب‌کننده در پیکربندی ⇒ INVALID_CONFIG بی‌پرتاب", () => {
    const evil = { ...base() };
    Object.defineProperty(evil, "graceMs", { get: () => { throw new Error("boom"); }, enumerable: true });
    expect(createSweepLoop(evil).ok).toBe(false);
  });
  it("ساختن هیچ تایمری نمی‌سازد و هیچ گذری اجرا نمی‌کند", async () => {
    const x = mk(idle);
    await x.timer.advance(60_000);
    expect(x.timer.pending()).toBe(0);
    expect(x.timer.delays).toEqual([]);
    expect(x.sw.calls()).toBe(0);
    expect(x.loop.status()).toMatchObject({ state: "stopped", busy: false, runs: 0, lastRunAtMs: null, lastSuccessAtMs: null, lastFault: null });
  });
});

describe("settlement · حلقه · چرخهٔ عمر و زمان‌بندی", () => {
  it("start: نخستین گذر با تأخیرِ صفر، سپس هر interval پس از پایانِ گذرِ پیشین", async () => {
    const x = mk(idle);
    expect(x.loop.start()).toEqual({ started: true });
    expect(x.timer.delays).toEqual([0]);
    await x.timer.advance(0);
    expect(x.sw.calls()).toBe(1);
    expect(x.timer.delays).toEqual([0, INTERVAL]);
    await x.timer.advance(INTERVAL - 1);
    expect(x.sw.calls()).toBe(1);
    await x.timer.advance(1);
    expect(x.sw.calls()).toBe(2);
    await x.timer.advance(5 * INTERVAL);
    expect(x.sw.calls()).toBe(7);
    expect(x.loop.status().state).toBe("running");
  });
  it("start خودش sweep را همگام صدا نمی‌زند (فقط تایمر می‌سازد)", () => {
    const x = mk(idle);
    x.loop.start();
    expect(x.sw.calls()).toBe(0);
    expect(x.timer.pending()).toBe(1);
  });
  it("start دوباره ⇒ ALREADY_RUNNING و تایمرِ اضافه نمی‌سازد", async () => {
    const x = mk(idle);
    x.loop.start();
    expect(x.loop.start()).toEqual({ started: false, reason: "ALREADY_RUNNING" });
    expect(x.timer.delays).toEqual([0]);
    await x.timer.advance(3 * INTERVAL);
    expect(x.sw.maxActive()).toBe(1);
    expect(x.timer.pending()).toBe(1); // همواره دقیقاً یک تایمرِ آویزان
  });
  it("تک‌پرواز: گذرِ کُند هرگز با گذرِ دیگر هم‌پوشانی ندارد و گذر بعد پس از پایانش زمان‌بندی می‌شود", async () => {
    let release: (() => void) | undefined;
    const x = mk((n) => (n === 1 ? new Promise<SweepReport>((res) => void (release = () => res(idle()))) : idle()));
    x.loop.start();
    await x.timer.advance(50 * INTERVAL);
    expect(x.sw.calls()).toBe(1);
    expect(x.timer.pending()).toBe(0); // تا پایانِ گذر هیچ تایمری نیست
    expect(x.loop.status()).toMatchObject({ busy: true, state: "running" });
    release?.();
    await flush();
    expect(x.timer.pending()).toBe(1);
    await x.timer.advance(INTERVAL);
    expect(x.sw.calls()).toBe(2);
    expect(x.sw.maxActive()).toBe(1);
  });
  it("stop بی‌گذرِ در حال اجرا: تایمر لغو، هیچ گذرِ دیگری، clean=true", async () => {
    const x = mk(idle);
    x.loop.start();
    await x.timer.advance(2 * INTERVAL);
    const calls = x.sw.calls();
    await expect(x.loop.stop()).resolves.toEqual({ clean: true });
    expect(x.timer.pending()).toBe(0);
    await x.timer.advance(100 * INTERVAL);
    expect(x.sw.calls()).toBe(calls);
    expect(x.loop.status().state).toBe("stopped");
  });
  it("stop پیش از نخستین گذر (پس از start) ⇒ هیچ گذری اجرا نمی‌شود", async () => {
    const x = mk(idle);
    x.loop.start();
    await x.loop.stop();
    await x.timer.advance(10 * INTERVAL);
    expect(x.sw.calls()).toBe(0);
  });
  it("stop هرگز-آغازنشده ⇒ clean=true و بی‌اثر؛ stop تکراری هم", async () => {
    const x = mk(idle);
    await expect(x.loop.stop()).resolves.toEqual({ clean: true });
    await expect(x.loop.stop()).resolves.toEqual({ clean: true });
    expect(x.timer.cancelled).toBe(0);
  });
  it("stop هنگام گذرِ در حال اجرا: منتظر پایانش می‌ماند، clean=true و گذر بعد زمان‌بندی نمی‌شود", async () => {
    let release: (() => void) | undefined;
    const x = mk(() => new Promise<SweepReport>((res) => void (release = () => res(sweepReport({ examined: 1, settled: 1 })))));
    x.loop.start();
    await x.timer.advance(0);
    let settled = false;
    const p = x.loop.stop().then((r) => ((settled = true), r));
    await flush();
    expect(settled).toBe(false);
    expect(x.loop.status().state).toBe("stopping");
    release?.();
    await expect(p).resolves.toEqual({ clean: true });
    expect(x.timer.pending()).toBe(0);
    expect(x.loop.status()).toMatchObject({ state: "stopped", busy: false, runs: 1 });
    await x.timer.advance(100 * INTERVAL);
    expect(x.sw.calls()).toBe(1);
  });
  it("stopهای هم‌زمان همان وعده را برمی‌گردانند و یک تایمرِ مهلت می‌سازند", async () => {
    let release: (() => void) | undefined;
    const x = mk(() => new Promise<SweepReport>((res) => void (release = () => res(idle()))));
    x.loop.start();
    await x.timer.advance(0);
    const p1 = x.loop.stop();
    const p2 = x.loop.stop();
    expect(p2).toBe(p1);
    expect(x.timer.delays.filter((d) => d === 30_000)).toHaveLength(1);
    release?.();
    expect(await Promise.all([p1, p2])).toEqual([{ clean: true }, { clean: true }]);
    expect(x.timer.pending()).toBe(0); // تایمرِ مهلت لغو شد
  });
  it("مهلتِ stop: گذرِ آویزان ⇒ clean=false؛ گذرِ کهنه پس از پایان زمان‌بندی نمی‌کند", async () => {
    let release: (() => void) | undefined;
    const x = mk(() => new Promise<SweepReport>((res) => void (release = () => res(idle()))), { stopTimeoutMs: 5000 });
    x.loop.start();
    await x.timer.advance(0);
    const p = x.loop.stop();
    await x.timer.advance(4999);
    expect(x.loop.status().state).toBe("stopping");
    await x.timer.advance(1);
    await expect(p).resolves.toEqual({ clean: false });
    expect(x.loop.status()).toMatchObject({ state: "stopping", busy: true });
    release?.();
    await flush();
    expect(x.timer.pending()).toBe(0);
    expect(x.loop.status()).toMatchObject({ state: "stopped", busy: false, runs: 1 });
    await x.timer.advance(100 * INTERVAL);
    expect(x.sw.calls()).toBe(1);
  });
  it("start هنگام گذرِ کهنه ⇒ PREVIOUS_RUN_ACTIVE (هرگز هم‌پوشانی)؛ پس از پایانش شروع می‌شود", async () => {
    let release: (() => void) | undefined;
    const x = mk((n) => (n === 1 ? new Promise<SweepReport>((res) => void (release = () => res(idle()))) : idle()), { stopTimeoutMs: 100 });
    x.loop.start();
    await x.timer.advance(0);
    const p = x.loop.stop();
    expect(x.loop.start()).toEqual({ started: false, reason: "PREVIOUS_RUN_ACTIVE" });
    await x.timer.advance(100);
    await p;
    expect(x.loop.start()).toEqual({ started: false, reason: "PREVIOUS_RUN_ACTIVE" });
    release?.();
    await flush();
    expect(x.loop.start()).toEqual({ started: true });
    await x.timer.advance(INTERVAL);
    expect(x.sw.maxActive()).toBe(1);
    expect(x.sw.calls()).toBeGreaterThanOrEqual(2);
  });
  it("راه‌اندازیِ دوباره پس از stopِ پاک کار می‌کند و شمارنده‌ها می‌مانند", async () => {
    const x = mk(() => sweepReport({ examined: 1, settled: 1 }));
    x.loop.start();
    await x.timer.advance(INTERVAL);
    await x.loop.stop();
    const before = x.loop.status().runs;
    expect(x.loop.start()).toEqual({ started: true });
    await x.timer.advance(INTERVAL);
    expect(x.loop.status().runs).toBeGreaterThan(before);
    expect(x.loop.status().totals.settled).toBe(x.loop.status().runs);
  });
  it("stop هنگامی که timer.cancel می‌پرتابد: باز هم متوقف می‌شود و تیکِ کهنه اثری ندارد", async () => {
    const x = mk(idle);
    x.loop.start();
    await x.timer.advance(2 * INTERVAL);
    const calls = x.sw.calls();
    x.timer.failCancel(true);
    await expect(x.loop.stop()).resolves.toEqual({ clean: true });
    x.timer.fireAll(); // تایمرِ لغو‌نشده هم اگر بپرد، بی‌اثر است
    await flush();
    expect(x.sw.calls()).toBe(calls);
  });
  it("تایمرِ کهنه پس از stop+start زنجیرِ دوم نمی‌سازد", async () => {
    const x = mk(idle);
    x.loop.start();
    await x.timer.advance(INTERVAL);
    x.timer.failCancel(true);
    await x.loop.stop();
    x.timer.failCancel(false);
    x.loop.start();
    await x.timer.advance(0);
    x.timer.fireAll(); // هم تایمرِ کهنه هم تازه (اگر مانده) فراخوانده شوند
    await flush();
    await x.timer.advance(20 * INTERVAL);
    expect(x.sw.maxActive()).toBe(1);
    expect(x.timer.pending()).toBe(1);
  });
  it("تایمری که یک فراخوانی را دوبار صدا می‌زند، زنجیرِ دوم نمی‌سازد", async () => {
    const timer = manualTimer();
    const sw = fakeSweeper(idle);
    const twice = { after: (fn: () => void, ms: number) => timer.after(() => (fn(), fn()), ms), cancel: (h: unknown) => timer.cancel(h) };
    const r = createSweepLoop({ sweeper: sw, timer: twice, clock: timer.clock, graceMs: GRACE, intervalMs: INTERVAL });
    if (!r.ok) throw new Error("x");
    r.value.start();
    await timer.advance(10 * INTERVAL);
    expect(sw.maxActive()).toBe(1);
    expect(timer.pending()).toBe(1);
    expect(sw.calls()).toBe(11);
  });
  it("تایمری که همگام (داخلِ after) اجرا می‌کند هم زنجیرِ سالم می‌سازد (۶ گذرِ نخست فوری، سپس عادی)", async () => {
    const timer = manualTimer();
    const sw = fakeSweeper(idle);
    let n = 0;
    const eager = { after: (fn: () => void, ms: number) => (++n <= 6 ? fn() : timer.after(fn, ms), n), cancel: () => undefined };
    const r = createSweepLoop({ sweeper: sw, timer: eager, clock: timer.clock, graceMs: GRACE, intervalMs: INTERVAL });
    if (!r.ok) throw new Error("x");
    expect(r.value.start()).toEqual({ started: true });
    await flush(20);
    expect(sw.calls()).toBe(6);
    expect(sw.maxActive()).toBe(1);
    await timer.advance(INTERVAL);
    expect(sw.calls()).toBe(7);
    expect(r.value.status().state).toBe("running");
    await r.value.stop();
  });
});

describe("settlement · حلقه · عقب‌نشینی پس از شکست", () => {
  it("شکستِ پیاپی ⇒ interval، ۲×، ۴×، ۸×، سپس سقفِ ⌊grace/2⌋؛ بهبود ⇒ بازگشت به interval", async () => {
    let healthyFrom = 9;
    const x = mk((n) => (n < healthyFrom ? sweepReport({ listFailed: true }) : idle()));
    x.loop.start();
    await x.timer.advance(200_000);
    expect(x.timer.delays.slice(0, 11)).toEqual([0, 1000, 2000, 4000, 8000, HALF, HALF, HALF, HALF, INTERVAL, INTERVAL]);
    expect(x.loop.status()).toMatchObject({ consecutiveFailures: 0 });
    healthyFrom = 0;
  });
  it("سقفِ سفارشی maxBackoffMs رعایت می‌شود", async () => {
    const x = mk(() => sweepReport({ listFailed: true }), { maxBackoffMs: 3000 });
    x.loop.start();
    await x.timer.advance(60_000);
    expect(Math.max(...x.timer.delays)).toBe(3000);
    expect(x.timer.delays.slice(0, 5)).toEqual([0, 1000, 2000, 3000, 3000]);
  });
  it.each<[string, (n: number) => unknown, string]>([
    ["listFailed", () => sweepReport({ listFailed: true }), "LIST_FAILED"],
    ["outboxFailures", () => sweepReport({ examined: 3, settled: 2, outboxFailures: 1 }), "OUTBOX_FAILURES"],
    ["sweeper می‌پرتابد", () => new Error(CANARY), "SWEEP_THREW"],
    ["sweeper ردّ می‌شود (promise رد)", () => Promise.reject(new Error(CANARY)), "SWEEP_THREW"],
    ["گزارش undefined", () => undefined, "BAD_REPORT"],
    ["گزارش ناقص", () => ({ examined: 1 }), "BAD_REPORT"],
    ["گزارش با عددِ منفی", () => sweepReport({ settled: -1 }), "BAD_REPORT"],
  ])("%s ⇒ خطای %s اعلام و عقب‌نشینی", async (_n, step, kind) => {
    const x = mk(step);
    x.loop.start();
    await x.timer.advance(4000);
    const st = x.loop.status();
    expect(st.lastFault).toBe(kind);
    expect(st.consecutiveFailures).toBeGreaterThanOrEqual(2);
    expect(st.lastSuccessAtMs).toBeNull();
    expect(x.ev.faults.length).toBe(st.runs);
    expect(x.ev.faults[0]).toMatchObject({ kind, consecutiveFailures: 1, nextDelayMs: INTERVAL });
    expect(x.ev.faults[1]).toMatchObject({ kind, consecutiveFailures: 2, nextDelayMs: 2 * INTERVAL });
    expect(st.totals.faults).toBe(st.runs);
    expect(JSON.stringify([st, x.ev])).not.toContain(CANARY);
  });
  it("outboxFailures با پیشرفتِ هم‌زمان هم شکست حساب می‌شود (عقب‌نشینی، نه تخلیه)", async () => {
    const x = mk(() => sweepReport({ examined: 4, settled: 3, outboxFailures: 1 }));
    x.loop.start();
    await x.timer.advance(3000);
    expect(x.timer.delays.slice(0, 4)).toEqual([0, 1000, 2000, 4000]);
  });
  it("retryLater و raced شکستِ حلقه نیستند (فاصلهٔ عادی)", async () => {
    const x = mk(() => sweepReport({ examined: 5, retryLater: 3, raced: 2 }));
    x.loop.start();
    await x.timer.advance(3 * INTERVAL);
    expect(x.timer.delays.every((d, i) => d === (i === 0 ? 0 : INTERVAL))).toBe(true);
    expect(x.loop.status()).toMatchObject({ consecutiveFailures: 0, lastFault: null });
    expect(x.ev.faults).toEqual([]);
  });
  it("پس از شکست‌های پیاپی یک گذرِ سالم شمارندهٔ شکست را صفر و lastSuccessAtMs را ثبت می‌کند", async () => {
    const x = mk((n) => (n <= 3 ? sweepReport({ listFailed: true }) : idle()));
    x.loop.start();
    await x.timer.advance(20_000);
    const st = x.loop.status();
    expect(st.consecutiveFailures).toBe(0);
    expect(st.lastFault).toBe("LIST_FAILED"); // آخرین خطا برای عیب‌یابی می‌ماند
    expect(st.lastSuccessAtMs).not.toBeNull();
    expect(st.totals.faults).toBe(3);
  });
  it("هیچ تأخیری هرگز از ⌊grace/2⌋ بیشتر نیست (ناوردای ۲) در ترکیبِ تصادفیِ نتیجه‌ها", async () => {
    let s = 12345;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    const x = mk(() => {
      const k = rnd();
      if (k < 0.3) return sweepReport({ listFailed: true });
      if (k < 0.4) return new Error("x");
      if (k < 0.5) return undefined;
      if (k < 0.8) return sweepReport({ examined: 2, settled: 2 });
      return idle();
    });
    x.loop.start();
    await x.timer.advance(600_000);
    expect(x.timer.delays.length).toBeGreaterThan(100);
    for (const d of x.timer.delays) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(HALF);
    }
    expect(x.sw.maxActive()).toBe(1);
  });
});

describe("settlement · حلقه · تخلیهٔ پیاپیِ گذرِ پربار", () => {
  it("گذرِ پربار ⇒ گذرِ بعد بی‌انتظار، تا maxDrainRuns؛ سپس فاصلهٔ عادی", async () => {
    const x = mk(() => sweepReport({ examined: 5, settled: 5 }), { maxDrainRuns: 3 });
    x.loop.start();
    await x.timer.advance(0);
    expect(x.timer.delays).toEqual([0, 0, 0, 0, INTERVAL]);
    await x.timer.advance(INTERVAL);
    expect(x.timer.delays.slice(0, 8)).toEqual([0, 0, 0, 0, INTERVAL, 0, 0, 0]);
  });
  it("مرگ هم پیشرفت است", async () => {
    const x = mk(() => sweepReport({ examined: 1, buried: [BURIED as never] }), { maxDrainRuns: 2 });
    x.loop.start();
    await x.timer.advance(0);
    expect(x.timer.delays.slice(0, 4)).toEqual([0, 0, 0, INTERVAL]);
  });
  it("گذرِ بی‌پیشرفت (فقط retryLater) تخلیه نمی‌کند", async () => {
    const x = mk(() => sweepReport({ examined: 3, retryLater: 3 }));
    x.loop.start();
    await x.timer.advance(0);
    expect(x.timer.delays).toEqual([0, INTERVAL]);
  });
  it("حلقهٔ داغ نیست: با رفتگرِ همیشه‌پربار در یک بازهٔ کوتاه گذرها از سقفِ تخلیه فراتر نمی‌روند", async () => {
    const x = mk(() => sweepReport({ examined: 1, settled: 1 }), { maxDrainRuns: 5 });
    x.loop.start();
    await x.timer.advance(INTERVAL - 1);
    expect(x.sw.calls()).toBe(6); // نخستین + ۵ تخلیه
  });
  it("پس از یک شکست شمارندهٔ تخلیه از صفر شروع می‌شود", async () => {
    const x = mk((n) => (n === 3 ? sweepReport({ listFailed: true }) : sweepReport({ examined: 1, settled: 1 })), { maxDrainRuns: 2 });
    x.loop.start();
    await x.timer.advance(INTERVAL);
    expect(x.timer.delays.slice(0, 6)).toEqual([0, 0, 0, INTERVAL, 0, 0]);
  });
  it("stop هنگام تخلیه، زنجیر را می‌برد", async () => {
    const x = mk(() => sweepReport({ examined: 1, settled: 1 }), { maxDrainRuns: 1000 });
    x.loop.start();
    await flush(3);
    await x.loop.stop();
    const calls = x.sw.calls();
    await x.timer.advance(10 * INTERVAL);
    expect(x.sw.calls()).toBe(calls);
  });
});

describe("settlement · حلقه · مشاهده‌گر", () => {
  it("onBuried با اقلامِ مرگ؛ onReport با اطلاعاتِ گذر؛ هیچ‌کدام برای گذرِ ساکت زنگ نمی‌زنند", async () => {
    const x = mk((n) => (n === 2 ? sweepReport({ examined: 1, buried: [BURIED as never] }) : idle()));
    x.loop.start();
    await x.timer.advance(2 * INTERVAL);
    expect(x.ev.buried).toHaveLength(1);
    expect(x.ev.buried[0]).toEqual([BURIED]);
    expect(x.ev.reports.length).toBeGreaterThanOrEqual(3);
    expect(x.ev.reports.map((r) => r.info.run)).toEqual(x.ev.reports.map((_r, i) => i + 1));
    expect(x.ev.reports[1]?.info.nextDelayMs).toBe(0); // مرگ پیشرفت است ⇒ تخلیه
    expect(x.ev.faults).toEqual([]);
  });
  it("info.atMs ساعتِ پایان و nextDelayMs تأخیرِ زمان‌بندی‌شده است؛ پس از stop مقدارِ null", async () => {
    let release: (() => void) | undefined;
    const x = mk(() => new Promise<SweepReport>((res) => void (release = () => res(idle()))));
    x.loop.start();
    await x.timer.advance(0);
    const p = x.loop.stop();
    release?.();
    await p;
    expect(x.ev.reports).toHaveLength(1);
    expect(x.ev.reports[0]?.info).toEqual({ run: 1, atMs: x.timer.now(), nextDelayMs: null });
  });
  it("ناوردای ۴: گذری که پس از stop ناپاک تمام می‌شود، onBuried را صدا می‌زند", async () => {
    let release: (() => void) | undefined;
    const x = mk(() => new Promise<SweepReport>((res) => void (release = () => res(sweepReport({ examined: 1, buried: [BURIED as never] })))), { stopTimeoutMs: 10 });
    x.loop.start();
    await x.timer.advance(0);
    const p = x.loop.stop();
    await x.timer.advance(10);
    await expect(p).resolves.toEqual({ clean: false });
    expect(x.ev.buried).toHaveLength(0);
    release?.();
    await flush();
    expect(x.ev.buried).toEqual([[BURIED]]);
    expect(x.loop.status().totals.buried).toBe(1);
    expect(x.timer.pending()).toBe(0);
  });
  it("ترتیب رویدادها: onBuried، سپس onFault، سپس onReport", async () => {
    const order: string[] = [];
    const x = mk(
      () => sweepReport({ examined: 1, outboxFailures: 1, buried: [BURIED as never] }),
      {},
      { onBuried: () => void order.push("buried"), onFault: () => void order.push("fault"), onReport: () => void order.push("report") },
    );
    x.loop.start();
    await x.timer.advance(0);
    expect(order.slice(0, 3)).toEqual(["buried", "fault", "report"]);
  });
  it("مشاهده‌گرِ پرتاب‌کننده، رد‌شونده و آویزان حلقه را نمی‌شکند و فقط observerFailures زیاد می‌شود", async () => {
    const x = mk(
      () => sweepReport({ examined: 1, buried: [BURIED as never], outboxFailures: 1 }),
      {},
      {
        onBuried: () => {
          throw new Error(CANARY);
        },
        onFault: () => Promise.reject(new Error(CANARY)),
        onReport: () => new Promise(() => undefined),
      },
    );
    x.loop.start();
    await x.timer.advance(5000);
    const st = x.loop.status();
    expect(st.runs).toBeGreaterThanOrEqual(3);
    expect(st.state).toBe("running");
    expect(st.totals.observerFailures).toBe(st.runs * 2);
    expect(JSON.stringify(st)).not.toContain(CANARY);
    expect(x.sw.maxActive()).toBe(1);
  });
  it("مشاهده‌گرِ thenable با then پرتاب‌کننده یا getter پرتاب‌کننده هم بی‌خطر است", async () => {
    const evilThen = { then: () => { throw new Error(CANARY); } };
    const evilGetter = {};
    Object.defineProperty(evilGetter, "then", { get() { throw new Error(CANARY); } });
    const x = mk(() => sweepReport({ examined: 1, outboxFailures: 1, buried: [BURIED as never] }), {}, { onBuried: () => evilThen, onFault: () => evilGetter, onReport: () => 5 });
    x.loop.start();
    await x.timer.advance(3000);
    expect(x.loop.status().state).toBe("running");
    expect(x.loop.status().totals.observerFailures).toBeGreaterThanOrEqual(2);
  });
  it("مشاهده‌گر کپیِ منجمد می‌گیرد: دستکاری‌اش نه گزارشِ بعدی را عوض می‌کند نه آمار را", async () => {
    const source = sweepReport({ examined: 1, settled: 1, buried: [{ ...BURIED }] as never });
    const seen: SweepReport[] = [];
    const x = mk(() => source, {}, { onReport: (r: SweepReport) => void seen.push(r), onBuried: (items: unknown[]) => { try { items.push({}); (items[0] as { reservationId: string }).reservationId = "hacked"; } catch { /* منجمد */ } } });
    x.loop.start();
    await x.timer.advance(0);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(seen[0]).not.toBe(source);
    expect(seen[0]?.buried[0]?.reservationId).toBe("r1");
    expect(x.loop.status().totals.buried).toBe(x.loop.status().runs);
  });
  it("مشاهده‌گر سنجه‌ای از «فیلدِ اضافهٔ خام» نمی‌گیرد", async () => {
    const seen: unknown[] = [];
    const x = mk(() => ({ ...sweepReport({ examined: 1 }), message: CANARY, buried: [{ ...BURIED, message: CANARY }] }), {}, { onReport: (r: unknown) => void seen.push(r), onBuried: (r: unknown) => void seen.push(r) });
    x.loop.start();
    await x.timer.advance(0);
    expect(JSON.stringify(seen)).not.toContain(CANARY);
    expect(seen.length).toBeGreaterThan(0);
  });
  it("بی‌مشاهده‌گر کار می‌کند", async () => {
    const timer = manualTimer();
    const sw = fakeSweeper(() => sweepReport({ examined: 1, buried: [BURIED as never], outboxFailures: 1 }));
    const r = createSweepLoop({ sweeper: sw, timer, clock: timer.clock, graceMs: GRACE, intervalMs: INTERVAL });
    if (!r.ok) throw new Error("x");
    r.value.start();
    await timer.advance(5000);
    expect(r.value.status().runs).toBeGreaterThan(2);
    expect(r.value.status().totals.observerFailures).toBe(0);
  });
  it("مشاهده‌گرِ فقط‌بخشی (فقط onFault) کار می‌کند", async () => {
    const faults: LoopFault[] = [];
    const x = mk(() => sweepReport({ listFailed: true }), {}, { onFault: (f: LoopFault) => void faults.push(f) });
    x.loop.start();
    await x.timer.advance(1000);
    expect(faults.length).toBeGreaterThan(1);
    expect(x.loop.status().totals.observerFailures).toBe(0);
  });
});

describe("settlement · حلقه · خرابیِ زمان‌سنج و ساعت", () => {
  it("timer.after در start می‌پرتابد ⇒ SCHEDULE_FAILED، حلقه متوقف، خطا اعلام و بی‌نشت", async () => {
    const x = mk(idle);
    x.timer.failAfter(1);
    expect(x.loop.start()).toEqual({ started: false, reason: "SCHEDULE_FAILED" });
    expect(x.loop.status().state).toBe("stopped");
    expect(x.ev.faults).toEqual([{ kind: "SCHEDULE_FAILED", consecutiveFailures: 0, nextDelayMs: null }]);
    expect(JSON.stringify(x.ev)).not.toContain("LEAK-CANARY");
    // اصلاحِ زمان‌سنج ⇒ start دوباره کار می‌کند
    expect(x.loop.start()).toEqual({ started: true });
    await x.timer.advance(INTERVAL);
    expect(x.sw.calls()).toBeGreaterThan(0);
  });
  it("timer.after میانِ کار می‌پرتابد ⇒ وضعیتِ stalled + SCHEDULE_FAILED (خاموشیِ ساکت نیست)", async () => {
    const x = mk(idle);
    x.loop.start();
    await x.timer.advance(0); // گذر ۱ → تایمرِ بعدی
    x.timer.failAfter(1);
    await x.timer.advance(INTERVAL); // گذر ۲ تمام می‌شود و نمی‌تواند زمان‌بندی کند
    const st = x.loop.status();
    expect(st.state).toBe("stalled");
    expect(x.ev.faults.at(-1)).toMatchObject({ kind: "SCHEDULE_FAILED", nextDelayMs: null });
    expect(x.timer.pending()).toBe(0);
    const calls = x.sw.calls();
    await x.timer.advance(100 * INTERVAL);
    expect(x.sw.calls()).toBe(calls);
    // از stalled با start برمی‌گردد
    expect(x.loop.start()).toEqual({ started: true });
    await x.timer.advance(INTERVAL);
    expect(x.sw.calls()).toBeGreaterThan(calls);
    expect(x.loop.status().state).toBe("running");
  });
  it("stop از stalled ⇒ stopped", async () => {
    const x = mk(idle);
    x.loop.start();
    await x.timer.advance(0);
    x.timer.failAfter(1);
    await x.timer.advance(INTERVAL);
    expect(x.loop.status().state).toBe("stalled");
    await x.loop.stop();
    expect(x.loop.status().state).toBe("stopped");
  });
  it("timer.after برای مهلتِ stop می‌پرتابد ⇒ بی‌آویزان clean=false", async () => {
    let release: (() => void) | undefined;
    const x = mk(() => new Promise<SweepReport>((res) => void (release = () => res(idle()))));
    x.loop.start();
    await x.timer.advance(0);
    x.timer.failAfter(1);
    await expect(x.loop.stop()).resolves.toEqual({ clean: false });
    release?.();
    await flush();
    expect(x.loop.status().state).toBe("stopped");
    expect(x.timer.pending()).toBe(0);
  });
  it("ساعتِ پرتاب‌کننده یا نامعتبر ⇒ حلقه می‌چرخد، زمان‌ها null", async () => {
    for (const bad of [() => { throw new Error(CANARY); }, () => Number.NaN, () => -1, () => 1.5]) {
      const timer = manualTimer();
      const sw = fakeSweeper(idle);
      const r = createSweepLoop({ sweeper: sw, timer, clock: { nowMs: bad }, graceMs: GRACE, intervalMs: INTERVAL });
      if (!r.ok) throw new Error("x");
      r.value.start();
      await timer.advance(3 * INTERVAL);
      const st = r.value.status();
      expect(st.runs).toBe(4);
      expect(st.lastRunAtMs).toBeNull();
      expect(st.lastSuccessAtMs).toBeNull();
      expect(st.state).toBe("running");
      expect(JSON.stringify(st)).not.toContain(CANARY);
    }
  });
});

describe("settlement · حلقه · status", () => {
  it("جمع‌ها دقیقاً مجموعِ گزارش‌ها و عکسِ وضعیت منجمد است", async () => {
    const reports = [sweepReport({ examined: 3, settled: 2, retryLater: 1 }), sweepReport({ examined: 2, raced: 2 }), sweepReport({ examined: 1, outboxFailures: 1 }), sweepReport({ examined: 1, buried: [BURIED as never] })];
    const x = mk((n) => reports[n - 1] ?? idle(), { maxDrainRuns: 1 });
    x.loop.start();
    await x.timer.advance(20_000);
    const st: SweepLoopStatus = x.loop.status();
    expect(st.totals).toMatchObject({ examined: 7, settled: 2, retryLater: 1, raced: 2, outboxFailures: 1, buried: 1, faults: 1, observerFailures: 0 });
    expect(Object.isFrozen(st)).toBe(true);
    expect(Object.isFrozen(st.totals)).toBe(true);
    expect(x.loop.status()).not.toBe(st);
  });
  it("lastRunAtMs و lastSuccessAtMs ساعتِ تزریقی‌اند و پس از شکست lastSuccessAtMs ثابت می‌ماند", async () => {
    const x = mk((n) => (n === 1 ? idle() : sweepReport({ listFailed: true })));
    x.loop.start();
    await x.timer.advance(0);
    const t0 = x.timer.now();
    expect(x.loop.status()).toMatchObject({ lastRunAtMs: t0, lastSuccessAtMs: t0 });
    await x.timer.advance(INTERVAL);
    expect(x.loop.status()).toMatchObject({ lastRunAtMs: t0 + INTERVAL, lastSuccessAtMs: t0 });
  });
  it("busy فقط هنگام اجرای گذر true است و state در حال کار running", async () => {
    let release: (() => void) | undefined;
    const x = mk(() => new Promise<SweepReport>((res) => void (release = () => res(idle()))));
    expect(x.loop.status().busy).toBe(false);
    x.loop.start();
    expect(x.loop.status().busy).toBe(false);
    await x.timer.advance(0);
    expect(x.loop.status()).toMatchObject({ busy: true, state: "running" });
    release?.();
    await flush();
    expect(x.loop.status().busy).toBe(false);
  });
});

describe("settlement · حلقه · بی‌پرتابیِ سطحِ عمومی", () => {
  it("start/stop/status هرگز نمی‌پرتابند حتی با زمان‌سنجِ کاملاً خراب", async () => {
    const timer = { after: () => { throw new Error("x"); }, cancel: () => { throw new Error("y"); } };
    const r = createSweepLoop({ sweeper: fakeSweeper(idle), timer, clock: { nowMs: () => 1 }, graceMs: GRACE, intervalMs: INTERVAL });
    if (!r.ok) throw new Error("x");
    expect(r.value.start()).toEqual({ started: false, reason: "SCHEDULE_FAILED" });
    await expect(r.value.stop()).resolves.toEqual({ clean: true });
    expect(r.value.status().state).toBe("stopped");
  });
  it("sweeper که sweep را همگام می‌پرتابد هم به SWEEP_THREW تبدیل می‌شود", async () => {
    const timer = manualTimer();
    const sweeper = { sweep: () => { throw new Error(CANARY); } };
    const r = createSweepLoop({ sweeper, timer, clock: timer.clock, graceMs: GRACE, intervalMs: INTERVAL });
    if (!r.ok) throw new Error("x");
    r.value.start();
    await timer.advance(2 * INTERVAL);
    expect(r.value.status()).toMatchObject({ lastFault: "SWEEP_THREW", state: "running" });
  });
  it("sweeper که شیء thenable با then پرتاب‌کننده برمی‌گرداند ⇒ بی‌خطر", async () => {
    const timer = manualTimer();
    const sweeper = { sweep: () => ({ then: () => { throw new Error(CANARY); } }) };
    const r = createSweepLoop({ sweeper, timer, clock: timer.clock, graceMs: GRACE, intervalMs: INTERVAL });
    if (!r.ok) throw new Error("x");
    r.value.start();
    await timer.advance(2 * INTERVAL);
    expect(r.value.status().state).toBe("running");
    expect(JSON.stringify(r.value.status())).not.toContain(CANARY);
  });
});

describe("settlement · حلقه · مرزهای پیش‌فرض و پایداری", () => {
  it("پیش‌فرضِ maxDrainRuns برابر SETTLEMENT_LIMITS (۲۰) است", async () => {
    const x = mk(() => sweepReport({ examined: 1, settled: 1 }));
    x.loop.start();
    await x.timer.advance(0);
    expect(x.timer.delays.filter((d) => d === 0)).toHaveLength(21); // نخستین + ۲۰ تخلیه
    expect(x.timer.delays.at(-1)).toBe(INTERVAL);
  });
  it("جمع‌ها در MAX_SAFE_INTEGER سقف می‌خورند (بی‌سرریز)", async () => {
    const big = Number.MAX_SAFE_INTEGER;
    const x = mk(() => sweepReport({ examined: big, settled: big, retryLater: big, raced: big, outboxFailures: 0 }));
    x.loop.start();
    await x.timer.advance(3 * INTERVAL);
    const t = x.loop.status().totals;
    for (const v of [t.examined, t.settled, t.retryLater, t.raced]) expect(v).toBe(big);
  });
  it("ساعتِ صفر معتبر است (۰ ثبت می‌شود نه null)", async () => {
    const timer = manualTimer();
    const r = createSweepLoop({ sweeper: fakeSweeper(idle), timer, clock: { nowMs: () => 0 }, graceMs: GRACE, intervalMs: INTERVAL });
    if (!r.ok) throw new Error("x");
    r.value.start();
    await timer.advance(0);
    expect(r.value.status()).toMatchObject({ lastRunAtMs: 0, lastSuccessAtMs: 0 });
  });
  it("پس از stop ناپاک و start دوباره، stopِ بعدی نتیجهٔ تازه می‌دهد نه وعدهٔ کهنه", async () => {
    const releases: Array<() => void> = [];
    const x = mk(() => new Promise<SweepReport>((res) => void releases.push(() => res(idle()))), { stopTimeoutMs: 100 });
    x.loop.start();
    await x.timer.advance(0);
    const first = x.loop.stop();
    await x.timer.advance(100);
    await expect(first).resolves.toEqual({ clean: false });
    releases[0]?.();
    await flush();
    expect(x.loop.start()).toEqual({ started: true });
    await x.timer.advance(0);
    expect(x.loop.status().busy).toBe(true);
    const second = x.loop.stop();
    expect(second).not.toBe(first);
    releases[1]?.();
    await expect(second).resolves.toEqual({ clean: true });
  });
  it("تایمرِ مهلتِ stop پس از پایانِ پاکِ گذر لغو می‌شود و بعداً clean=false نمی‌دهد", async () => {
    let release: (() => void) | undefined;
    const x = mk(() => new Promise<SweepReport>((res) => void (release = () => res(idle()))), { stopTimeoutMs: 100 });
    x.loop.start();
    await x.timer.advance(0);
    const p = x.loop.stop();
    release?.();
    await expect(p).resolves.toEqual({ clean: true });
    expect(x.timer.cancelled).toBeGreaterThanOrEqual(1);
    expect(x.timer.pending()).toBe(0);
  });
});
