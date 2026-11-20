/**
 * settlement-backlog-watch · حلقهٔ پس‌زمینه، کش و نمای همگام (ADR-0042). زمان مجازی؛ بی‌پایگاه.
 * outbox یا ساختگیِ قابل‌کنترل است یا outboxِ حافظه‌ایِ واقعیِ settlement (همان قراردادِ `listUnacknowledgedDead`).
 */
import { describe, expect, it } from "vitest";
import { createMemoryOutbox } from "@/modules/settlement";
import type { SettlementOutbox } from "@/modules/settlement";
import { createBacklogWatch } from "./index";
import { FAST, HOUR, T0, ackMany, buryMany, deadEntry, listOutbox, must, okList, scriptedOutbox, virtual, world } from "./test-kit";

const names = (w: { watch: { view(): { reasons: readonly { code: string }[] } } }): string[] => w.watch.view().reasons.map((r) => r.code);

describe("settlement-backlog-watch · پیش از start", () => {
  it("نمای اولیه «unknown» است: نه ok (نمی‌دانم)، نه مسدودکننده؛ بی‌I/O", () => {
    const { outbox } = scriptedOutbox();
    const w = world({}, outbox);
    const v = w.watch.view();
    expect(v).toMatchObject({ phase: "idle", status: "unknown", reasons: [], count: null, truncated: null, oldestAgeMs: null, sampleAgeMs: null, byReason: null, failure: null, readyPolicy: "report" });
    expect(outbox.calls).toHaveLength(0);
  });

  it("stop پیش از start بی‌اثر است و فاز idle می‌ماند", () => {
    const w = world();
    expect(w.watch.stop()).toEqual({ stopped: true, abandonedRead: false });
    expect(w.watch.view().phase).toBe("idle");
  });
});

describe("settlement-backlog-watch · start و زمان‌بندی", () => {
  it("start همگام است و نمونهٔ اول را بی‌انتظار و بی‌تأخیر آغاز می‌کند (با سقفِ پیش‌فرضِ خواندن)", () => {
    const { outbox } = scriptedOutbox();
    const w = world({}, outbox);
    expect(w.watch.start()).toEqual({ started: true });
    expect(outbox.calls).toEqual([{ limit: 1000 }]);
    expect(w.watch.view().phase).toBe("running");
  });

  it("پس از نمونهٔ اول، پایگاهِ خالی ok است با شمارِ صفر و سنِ نمونهٔ صفر", async () => {
    const { outbox } = scriptedOutbox();
    const w = world({}, outbox);
    w.watch.start();
    await w.settle();
    expect(w.watch.view()).toMatchObject({ phase: "running", status: "ok", reasons: [], count: 0, truncated: false, oldestAgeMs: null, sampleAgeMs: 0, failure: null });
  });

  it("start دوم ALREADY_RUNNING می‌دهد و خواندنِ دوم یا حلقهٔ دوم نمی‌سازد", async () => {
    const { outbox } = scriptedOutbox();
    const w = world({}, outbox);
    w.watch.start();
    expect(w.watch.start()).toEqual({ started: false, reason: "ALREADY_RUNNING" });
    await w.advance(FAST.intervalMs);
    expect(outbox.calls).toHaveLength(2); // نه ۴
    expect(w.pending()).toBe(1); // فقط یک زمان‌سنجِ فاصله
  });

  it("درست یک خواندن در هر فاصله (نه کمتر، نه بیشتر)", async () => {
    const { outbox } = scriptedOutbox();
    const w = world({}, outbox);
    w.watch.start();
    await w.settle();
    expect(outbox.calls).toHaveLength(1);
    await w.advance(FAST.intervalMs - 1);
    expect(outbox.calls).toHaveLength(1);
    await w.advance(1);
    expect(outbox.calls).toHaveLength(2);
    await w.advance(3 * FAST.intervalMs);
    expect(outbox.calls).toHaveLength(5);
  });

  it("بی‌هم‌پوشانی: خواندنِ آویزان تا مهلت می‌ماند و فاصله از «پایان» شمرده می‌شود، نه از آغاز", async () => {
    const { outbox, state } = scriptedOutbox();
    state.mode = "hang";
    const w = world({}, outbox);
    w.watch.start();
    await w.advance(FAST.timeoutMs - 1);
    expect(outbox.calls).toHaveLength(1);
    expect(w.watch.view().status).toBe("unknown"); // هنوز مهلت تمام نشده
    await w.advance(1); // مهلتِ ۵۰۰ ⇒ TIMEOUT
    expect(w.watch.view()).toMatchObject({ status: "degraded", failure: "TIMEOUT" });
    await w.advance(FAST.intervalMs - 1);
    expect(outbox.calls).toHaveLength(1); // پایان در ۵۰۰ + فاصله ۱۰۰۰ = ۱۵۰۰
    await w.advance(1);
    expect(outbox.calls).toHaveLength(2);
  });

  it("حلقهٔ سالم زمان‌سنجِ نمی‌نشتد: هر مهلتِ نمونه لغو می‌شود و فقط یک زمان‌سنجِ فاصله زنده است", async () => {
    const w = world();
    w.watch.start();
    await w.advance(10 * FAST.intervalMs);
    expect(w.pending()).toBe(1);
    // هر نمونه یک زمان‌سنجِ مهلت می‌سازد و پس از پایان لغوش می‌کند؛ زمان‌سنجِ فاصله پس از شلیک دیگر لغو نمی‌شود.
    expect(w.stats.cancelled).toBeGreaterThanOrEqual(10);
    expect(w.stats.created - w.stats.cancelled).toBeLessThanOrEqual(11);
  });
});

describe("settlement-backlog-watch · ارزیابیِ آستانه‌های پیش‌فرض", () => {
  it("یک مردهٔ تأییدنشده ⇒ degraded (COUNT_HIGH)؛ ده ⇒ down (COUNT_CRITICAL) با شمارِ دقیق", async () => {
    const { outbox, state } = scriptedOutbox();
    const w = world({}, outbox);
    w.watch.start();
    state.list = [deadEntry(1)];
    await w.advance(FAST.intervalMs);
    expect(w.watch.view()).toMatchObject({ status: "degraded", count: 1 });
    expect(names(w)).toContain("COUNT_HIGH");
    state.list = Array.from({ length: 10 }, (_, i) => deadEntry(i + 1));
    await w.advance(FAST.intervalMs);
    expect(w.watch.view()).toMatchObject({ status: "down", count: 10, truncated: false });
    expect(names(w)).toContain("COUNT_CRITICAL");
  });

  it("سنِ قدیمی‌ترین: بیش از ۱ ساعت ⇒ OLDEST_AGED؛ بیش از ۲۴ ساعت ⇒ OLDEST_STUCK (down)", async () => {
    const { outbox, state } = scriptedOutbox();
    const w = world({}, outbox, T0 + 30 * HOUR);
    w.watch.start();
    state.list = [deadEntry(1, { settledAtMs: T0 + 30 * HOUR - 2 * HOUR })];
    await w.advance(FAST.intervalMs);
    expect(names(w)).toContain("OLDEST_AGED");
    expect(w.watch.view().status).toBe("degraded");
    state.list = [deadEntry(1, { settledAtMs: T0 + 30 * HOUR - 25 * HOUR })];
    await w.advance(FAST.intervalMs);
    expect(names(w)).toContain("OLDEST_STUCK");
    expect(w.watch.view()).toMatchObject({ status: "down" });
  });

  it("آستانه‌ها قابل‌تنظیم‌اند: با degradedCount=۵ یک مرده هنوز ok است", async () => {
    const { outbox, state } = scriptedOutbox();
    const w = world({ degradedCount: 5, downCount: 8 }, outbox);
    w.watch.start();
    state.list = [deadEntry(1)];
    await w.advance(FAST.intervalMs);
    expect(w.watch.view().status).toBe("ok");
    state.list = Array.from({ length: 5 }, (_, i) => deadEntry(i + 1));
    await w.advance(FAST.intervalMs);
    expect(w.watch.view().status).toBe("degraded");
  });

  it("فهرستِ به‌سقف‌رسیده truncated است و دست‌کم down (بریدن آستانه را پنهان نمی‌کند)", async () => {
    const { outbox, state } = scriptedOutbox();
    const w = world({ sampleLimit: 10 }, outbox);
    state.list = Array.from({ length: 10 }, (_, i) => deadEntry(i + 1));
    w.watch.start();
    await w.settle();
    expect(outbox.calls[0]).toEqual({ limit: 10 });
    expect(w.watch.view()).toMatchObject({ status: "down", truncated: true, count: 10 });
  });
});

describe("settlement-backlog-watch · view همگام و بی‌I/O", () => {
  it("با پیشروی ساعت (بی‌هیچ نمونهٔ تازه‌ای) سن بالا می‌رود و آستانه رد می‌شود؛ outbox دوباره خوانده نمی‌شود", async () => {
    const { outbox, state } = scriptedOutbox();
    const w = world({}, outbox);
    w.watch.start();
    state.list = [deadEntry(1, { settledAtMs: T0 - 100 })];
    await w.advance(FAST.intervalMs);
    const calls = outbox.calls.length;
    expect(names(w)).not.toContain("OLDEST_AGED");
    w.clock.now += HOUR; // بدونِ تیکِ زمان‌سنج
    const v = w.watch.view();
    expect(outbox.calls).toHaveLength(calls);
    expect(v.oldestAgeMs).toBe(HOUR + FAST.intervalMs + 100);
    expect(names(w)).toContain("OLDEST_AGED");
    expect(names(w)).toContain("SAMPLE_STALE");
  });

  it("نتیجه منجمد و JSON‌پذیر است و شناسه یا مبلغی در آن نیست", async () => {
    const { outbox, state } = scriptedOutbox();
    state.list = [deadEntry(7, { tenantId: "TENANT-SECRET", reserved: 987_654_321, lastErrorCode: "SECRET-CODE" })];
    const w = world({}, outbox);
    w.watch.start();
    await w.settle();
    const v = w.watch.view();
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.reasons)).toBe(true);
    expect(JSON.parse(JSON.stringify(v))).toEqual(v);
    const text = JSON.stringify(v);
    for (const secret of ["TENANT-SECRET", "987654321", "SECRET-CODE", "r7"]) expect(text).not.toContain(secret);
  });

  it("ساعتِ خراب پس از نمونهٔ سالم ⇒ down با INPUT_INVALID (شکستِ بسته، مثلِ health.ts)؛ نمی‌پرتابد", async () => {
    const w = world();
    w.watch.start();
    await w.settle();
    const badClock = { nowMs: (): number => Number.NaN };
    const v = must(createBacklogWatch({ outbox: scriptedOutbox().outbox, clock: w.clock, timer: w.timer, ...FAST }));
    expect(v.view().status).toBe("unknown");
    w.clock.nowMs = badClock.nowMs;
    expect(w.watch.view()).toMatchObject({ status: "down" });
    expect(names(w)).toContain("INPUT_INVALID");
    w.clock.nowMs = (): number => {
      throw new Error("SECRET-CLOCK");
    };
    expect(() => w.watch.view()).not.toThrow();
    expect(JSON.stringify(w.watch.view())).not.toContain("SECRET-CLOCK");
  });

  it("ساعتِ خراب از آغاز ⇒ نمونه CLOCK_INVALID و نما degraded (نه down و نه ok)", async () => {
    const w = world();
    w.clock.nowMs = (): number => Number.NaN;
    w.watch.start();
    await w.settle();
    expect(w.watch.view()).toMatchObject({ status: "degraded", failure: "CLOCK_INVALID" });
  });
});

describe("settlement-backlog-watch · شکستِ نمونه‌گیری", () => {
  it.each([
    ["fail", "LIST_FAILED"],
    ["reject", "LIST_FAILED"],
    ["bad", "BAD_LIST"],
  ] as const)("outbox حالتِ %s و بی‌هیچ نمونهٔ سالم ⇒ degraded با %s (هرگز ok و هرگز down)", async (mode, code) => {
    const { outbox, state } = scriptedOutbox();
    state.mode = mode;
    const w = world({}, outbox);
    w.watch.start();
    await w.settle();
    expect(w.watch.view()).toMatchObject({ status: "degraded", failure: code, count: null });
    expect(names(w)).toEqual(["SAMPLE_UNREADABLE"]);
  });

  it("پیامِ خطای پایگاه (با رشتهٔ اتصال) هرگز به نما نمی‌رسد", async () => {
    const { outbox, state } = scriptedOutbox();
    state.mode = "reject";
    const w = world({}, outbox);
    w.watch.start();
    await w.settle();
    const text = JSON.stringify(w.watch.view());
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("postgres");
  });

  it("شکستِ گذرا شدتِ شناخته‌شده را پایین نمی‌آورد: down می‌ماند، SAMPLE_UNREADABLE اضافه می‌شود، با بهبود پاک می‌شود", async () => {
    const { outbox, state } = scriptedOutbox();
    state.list = Array.from({ length: 10 }, (_, i) => deadEntry(i + 1));
    const w = world({}, outbox);
    w.watch.start();
    await w.settle();
    expect(w.watch.view().status).toBe("down");
    state.mode = "reject";
    await w.advance(FAST.intervalMs);
    const v = w.watch.view();
    expect(v).toMatchObject({ status: "down", failure: "LIST_FAILED", count: 10 });
    expect(names(w)).toEqual(expect.arrayContaining(["COUNT_CRITICAL", "SAMPLE_UNREADABLE"]));
    expect(v.reasons[0]?.severity).toBe("down"); // خطرناک‌ترین اول
    state.mode = "ok";
    state.list = [];
    await w.advance(FAST.intervalMs);
    expect(w.watch.view()).toMatchObject({ status: "ok", failure: null, count: 0 });
  });

  it("شکستِ گذرا روی نمونهٔ ok آن را degraded می‌کند (نمی‌دانم ≠ ok)", async () => {
    const { outbox, state } = scriptedOutbox();
    const w = world({}, outbox);
    w.watch.start();
    await w.settle();
    state.mode = "fail";
    await w.advance(FAST.intervalMs);
    expect(w.watch.view()).toMatchObject({ status: "degraded", failure: "LIST_FAILED" });
  });

  it("نمونه‌گیریِ مرده (آویزانِ دائمی) با کهنه‌شدنِ نمونه دیده می‌شود، نه سکوت", async () => {
    const { outbox, state } = scriptedOutbox();
    const w = world({}, outbox);
    w.watch.start();
    await w.settle();
    state.mode = "hang";
    await w.advance(3 * FAST.intervalMs);
    const v = w.watch.view();
    expect(v.status).toBe("degraded");
    expect(v.failure).toBe("TIMEOUT");
  });
});

describe("settlement-backlog-watch · کهنگیِ پیش‌فرض (مرزِ اکیدِ >)", () => {
  it("کهنگیِ پیش‌فرض ۲×فاصله + ۴×مهلت = ۴۰۰۰: در ۴۰۰۰ هنوز ok، در ۴۰۰۱ degraded", async () => {
    const w = world();
    w.watch.start();
    await w.settle();
    w.watch.stop();
    w.clock.now += 4_000;
    expect(w.watch.view().status).toBe("ok");
    w.clock.now += 1;
    expect(w.watch.view().status).toBe("degraded");
    expect(names(w)).toContain("SAMPLE_STALE");
  });

  it("حلقهٔ سالم هرگز «کهنه» گزارش نمی‌شود (بدترین فاصلهٔ دو نمونه زیرِ کهنگیِ مجاز است)", async () => {
    const { outbox } = scriptedOutbox();
    const w = world({}, outbox);
    w.watch.start();
    for (let i = 0; i < 40; i++) {
      await w.advance(250);
      expect(names(w), `گام ${i}`).not.toContain("SAMPLE_STALE");
    }
  });
});

describe("settlement-backlog-watch · stop و نسل‌ها", () => {
  it("stop زمان‌سنج را لغو می‌کند، خواندنِ تازه نمی‌سازد و فاز stopped می‌شود", async () => {
    const { outbox } = scriptedOutbox();
    const w = world({}, outbox);
    w.watch.start();
    await w.settle();
    expect(w.pending()).toBe(1);
    expect(w.watch.stop()).toEqual({ stopped: true, abandonedRead: false });
    expect(w.pending()).toBe(0);
    await w.advance(10 * FAST.intervalMs);
    expect(outbox.calls).toHaveLength(1);
    expect(w.watch.view().phase).toBe("stopped");
  });

  it("stop idempotent است", async () => {
    const w = world();
    w.watch.start();
    await w.settle();
    w.watch.stop();
    expect(w.watch.stop()).toEqual({ stopped: true, abandonedRead: false });
    expect(w.watch.view().phase).toBe("stopped");
  });

  it("stop هنگامِ خواندن آویزان نمی‌شود و abandonedRead=true می‌دهد؛ پاسخِ دیرهنگام نادیده است و تایمری نمی‌سازد", async () => {
    const pend: Array<(v: unknown) => void> = [];
    const outbox = listOutbox(() => new Promise((res) => pend.push(res)));
    const w = world({}, outbox);
    w.watch.start();
    const cancelsBefore = w.stats.cancelled;
    expect(w.watch.stop()).toEqual({ stopped: true, abandonedRead: true });
    expect(w.stats.cancelled).toBe(cancelsBefore); // دستگیرهٔ فاصله‌ای وجود نداشت؛ لغوِ بی‌دستگیره ممنوع
    expect(w.watch.stop()).toEqual({ stopped: true, abandonedRead: false }); // خواندنِ رهاشده فقط یک بار گزارش می‌شود
    pend[0]?.(okList(Array.from({ length: 10 }, (_, i) => deadEntry(i + 1))));
    await w.advance(5 * FAST.intervalMs);
    expect(w.watch.view()).toMatchObject({ phase: "stopped", status: "unknown", count: null });
    expect(w.pending()).toBe(0);
    expect(outbox.calls).toHaveLength(1);
  });

  it("پس از stop، آخرین نمونه می‌ماند و با کهنه‌شدن degraded می‌شود", async () => {
    const { outbox, state } = scriptedOutbox();
    state.list = [deadEntry(1)];
    const w = world({}, outbox);
    w.watch.start();
    await w.settle();
    w.watch.stop();
    expect(w.watch.view()).toMatchObject({ phase: "stopped", count: 1 });
    await w.advance(10_000);
    expect(names(w)).toContain("SAMPLE_STALE");
  });

  it("start پس از stop ممکن است؛ خواندنِ رهاشدهٔ نسلِ قبل کشِ نسلِ تازه را خراب نمی‌کند", async () => {
    const pend: Array<(v: unknown) => void> = [];
    const outbox = listOutbox(() => new Promise((res) => pend.push(res)));
    const w = world({}, outbox);
    w.watch.start(); // خواندن ۱
    w.watch.stop();
    expect(w.watch.start()).toEqual({ started: true }); // خواندن ۲
    expect(outbox.calls).toHaveLength(2);
    pend[0]?.(okList(Array.from({ length: 10 }, (_, i) => deadEntry(i + 1)))); // قدیمی ⇒ نادیده
    await w.settle();
    expect(w.watch.view()).toMatchObject({ phase: "running", status: "unknown" });
    pend[1]?.(okList([]));
    await w.settle();
    expect(w.watch.view()).toMatchObject({ status: "ok", count: 0 });
    expect(w.pending()).toBe(1); // فقط یک زمان‌سنجِ فاصله (نه دو حلقه)
  });
});

const ms500 = (h: unknown): boolean => (h as { at: number }).at - T0 === FAST.timeoutMs;

describe("settlement-backlog-watch · زمان‌سنجِ خراب", () => {
  it("شکستِ ساختنِ زمان‌سنجِ فاصله ⇒ فازِ stalled (دیده می‌شود) و نمونه کهنه می‌شود؛ start دوباره حلقه را زنده می‌کند", async () => {
    const v = virtual();
    let broken = true;
    const timer = {
      after(fn: () => void, ms: number): unknown {
        if (broken && ms === FAST.intervalMs) throw new Error("SECRET-TIMER");
        return v.timer.after(fn, ms);
      },
      cancel: (h: unknown): void => v.timer.cancel(h),
    };
    const outbox = scriptedOutbox().outbox;
    const watch = must(createBacklogWatch({ outbox, clock: v.clock, timer, ...FAST }));
    watch.start();
    await v.settle();
    expect(watch.view()).toMatchObject({ phase: "stalled", status: "ok" });
    expect(JSON.stringify(watch.view())).not.toContain("SECRET");
    await v.advance(10_000);
    expect(watch.view().reasons.map((r) => r.code)).toContain("SAMPLE_STALE");
    expect(outbox.calls).toHaveLength(1);
    broken = false;
    expect(watch.start()).toEqual({ started: true });
    await v.advance(FAST.intervalMs);
    expect(watch.view()).toMatchObject({ phase: "running", status: "ok" });
    expect(outbox.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("cancel که می‌پرتابد stop را نمی‌شکند", async () => {
    const v = virtual();
    let threw = false;
    const timer = {
      after: (fn: () => void, ms: number): unknown => v.timer.after(fn, ms),
      cancel: (h: unknown): void => {
        if (ms500(h)) return;
        threw = true; // لغوِ مهلتِ نمونه عادی است؛ فقط لغوِ زمان‌سنجِ فاصله می‌پرتابد.
        throw new Error("SECRET-CANCEL");
      },
    };
    const watch = must(createBacklogWatch({ outbox: scriptedOutbox().outbox, clock: v.clock, timer, ...FAST }));
    watch.start();
    await v.settle();
    expect(() => watch.stop()).not.toThrow();
    expect(threw).toBe(true);
    expect(watch.view().phase).toBe("stopped");
  });
});

describe("settlement-backlog-watch · زمان‌سنجِ لغوناپذیر", () => {
  it("تیکِ نسلِ قدیمی پس از stop/start حلقهٔ دوم یا خواندنِ اضافه نمی‌سازد (لغوِ زمان‌سنج بی‌اثر است)", async () => {
    const v = virtual();
    const kinds = new WeakMap<object, number>();
    const timer = {
      after(fn: () => void, ms: number): unknown {
        const h = v.timer.after(fn, ms) as object;
        kinds.set(h, ms);
        return h;
      },
      cancel(h: unknown): void {
        if (kinds.get(h as object) !== FAST.intervalMs) v.timer.cancel(h); // لغوِ زمان‌سنجِ فاصله را نادیده می‌گیرد
      },
    };
    const { outbox } = scriptedOutbox();
    const watch = must(createBacklogWatch({ outbox, clock: v.clock, timer, ...FAST }));
    watch.start();
    await v.settle();
    watch.stop();
    expect(watch.start()).toEqual({ started: true });
    await v.settle();
    expect(outbox.calls).toHaveLength(2);
    await v.advance(FAST.intervalMs);
    expect(outbox.calls).toHaveLength(3); // نه ۴: تیکِ قدیمی خنثی شد
    await v.advance(FAST.intervalMs);
    expect(outbox.calls).toHaveLength(4);
  });
});

describe("settlement-backlog-watch · روی outboxِ حافظه‌ایِ واقعیِ settlement", () => {
  it("مرده‌ها دیده می‌شوند و با تأییدِ رسیدگی پسماند تخلیه و نما ok می‌شود", async () => {
    const outbox: SettlementOutbox = createMemoryOutbox();
    const w = world({}, outbox);
    await buryMany(outbox, 3);
    w.watch.start();
    await w.settle();
    expect(w.watch.view()).toMatchObject({ status: "degraded", count: 3 });
    expect(w.watch.view().byReason).toEqual({ EXPIRED_UNBILLED: 0, ATTEMPTS_EXHAUSTED: 3, LEDGER_REJECTED: 0 });
    await ackMany(outbox, 3, T0);
    await w.advance(FAST.intervalMs);
    expect(w.watch.view()).toMatchObject({ status: "ok", count: 0 });
  });

  it("ده مردهٔ تأییدنشده ⇒ down؛ پایش چیزی را تأیید یا تغییر نمی‌دهد (فقط‌خواندنی)", async () => {
    const outbox: SettlementOutbox = createMemoryOutbox();
    await buryMany(outbox, 10);
    const w = world({}, outbox);
    w.watch.start();
    await w.advance(3 * FAST.intervalMs);
    expect(w.watch.view().status).toBe("down");
    const counts = await outbox.counts();
    expect(counts.ok && counts.value.dead).toBe(10);
    const still = await outbox.listUnacknowledgedDead({ limit: 100 });
    expect(still.ok && still.value.length).toBe(10);
  });
});
