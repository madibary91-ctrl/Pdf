/**
 * settlement-backlog · نمونه‌گیری (ADR-0039): روی outbox حافظه‌ای واقعی و روی outboxهای خراب. هرگز نمی‌پرتابد؛ هر خرابی یک کدِ بسته است؛
 * فقط‌خواندنی؛ مهلت و لغوِ تایمر؛ نشتِ هیچ فیلدِ رکورد.
 */
import { describe, expect, it } from "vitest";
import { createMemoryOutbox } from "@/modules/settlement";
import type { SettlementOutbox } from "@/modules/settlement";
import { REF, T0, TH, buryMany, deadEntry, listOutbox, manualClock, manualTimer, monitorOf, ok } from "./test-kit";

const sleep0 = () => new Promise<void>((r) => setTimeout(r, 0));

describe("settlement-backlog · نمونه‌گیری روی outbox واقعی (حافظه‌ای)", () => {
  it("outboxِ خالی ⇒ نمونهٔ سالمِ صفر", async () => {
    const m = monitorOf();
    expect(await m.sample()).toEqual({ ok: true, atMs: T0, count: 0, truncated: false, oldestDeadAtMs: null, undated: 0, byReason: { EXPIRED_UNBILLED: 0, ATTEMPTS_EXHAUSTED: 0, LEDGER_REJECTED: 0 } });
  });

  it("شمار، قدیمی‌ترین زمانِ مرگ و تفکیکِ دلیل را دقیق می‌دهد", async () => {
    const outbox = createMemoryOutbox();
    await buryMany(outbox, 2, (i) => 5_000 + i * 10, "ATTEMPTS_EXHAUSTED");
    for (const [n, reason, at] of [[3, "EXPIRED_UNBILLED", 4_000], [4, "LEDGER_REJECTED", 9_000], [5, "EXPIRED_UNBILLED", 4_500]] as const) {
      await outbox.begin({ ...REF(n), unit: "IRR_MICROS", reserved: 5, createdAtMs: 1, expiresAtMs: 99, dueAtMs: 2, orphanRemainder: "forfeit" });
      await outbox.bury(REF(n), { reason, errorCode: null, atMs: at });
    }
    const s = await monitorOf({}, outbox).sample();
    expect(s).toMatchObject({ ok: true, count: 5, truncated: false, oldestDeadAtMs: 4_000, undated: 0, byReason: { EXPIRED_UNBILLED: 2, ATTEMPTS_EXHAUSTED: 2, LEDGER_REJECTED: 1 } });
  });

  it("مرده‌های تأییدشده شمرده نمی‌شوند (پسماند = فقط تأییدنشده‌ها)", async () => {
    const outbox = createMemoryOutbox();
    await buryMany(outbox, 4);
    await outbox.acknowledgeDead(REF(1), { atMs: T0 });
    await outbox.acknowledgeDead(REF(3), { atMs: T0 });
    const s = await monitorOf({}, outbox).sample();
    expect(s).toMatchObject({ ok: true, count: 2 });
  });

  it("رکوردهای غیرِمرده (open/settling/done) شمرده نمی‌شوند", async () => {
    const outbox = createMemoryOutbox();
    await outbox.begin({ ...REF(1), unit: "IRR_MICROS", reserved: 5, createdAtMs: 1, expiresAtMs: 99, dueAtMs: 2, orphanRemainder: "forfeit" });
    expect(await monitorOf({}, outbox).sample()).toMatchObject({ ok: true, count: 0 });
  });

  it("فقط‌خواندنی است: نمونه‌گیری، outbox را تغییر نمی‌دهد (شمارش، تأییدها و رکوردها همان می‌مانند)", async () => {
    const outbox = createMemoryOutbox();
    await buryMany(outbox, 3);
    const before = JSON.stringify([await outbox.listDead({ limit: 10 }), await outbox.listUnacknowledgedDead({ limit: 10 }), await outbox.counts()]);
    const m = monitorOf({}, outbox);
    await m.sample();
    await m.check();
    expect(JSON.stringify([await outbox.listDead({ limit: 10 }), await outbox.listUnacknowledgedDead({ limit: 10 }), await outbox.counts()])).toBe(before);
  });

  it("فقط متدِ listUnacknowledgedDead صدا زده می‌شود (هیچ متدِ نویسنده‌ای)", async () => {
    const calls: string[] = [];
    const spy = new Proxy(createMemoryOutbox() as SettlementOutbox, {
      get(t, k) {
        calls.push(String(k));
        return Reflect.get(t, k);
      },
    });
    await monitorOf({}, spy).sample();
    expect(new Set(calls)).toEqual(new Set(["listUnacknowledgedDead"]));
  });

  it("با بریدنِ فهرست: truncated=true، count=سقف و قدیمی‌ترین دقیق می‌ماند", async () => {
    const outbox = createMemoryOutbox();
    await buryMany(outbox, 15, (i) => 20_000 - i); // قدیمی‌ترین: شمارهٔ ۱۵ ولی outbox به ترتیبِ مرگ برمی‌گرداند
    const s = await monitorOf({ sampleLimit: 10, downCount: 10 }, outbox).sample();
    expect(s).toMatchObject({ ok: true, count: 10, truncated: true });
    if (s.ok) expect(s.oldestDeadAtMs).toBe(19_985);
  });

  it("دقیقاً به اندازهٔ سقف ⇒ truncated=true (بیشتر بودنش قابل‌تشخیص نیست؛ حداقلِ شمار)", async () => {
    const outbox = createMemoryOutbox();
    await buryMany(outbox, 10);
    expect(await monitorOf({}, outbox).sample()).toMatchObject({ count: 10, truncated: true });
    const outbox9 = createMemoryOutbox();
    await buryMany(outbox9, 9);
    expect(await monitorOf({}, outbox9).sample()).toMatchObject({ count: 9, truncated: false });
  });

  it("به ترتیبِ فهرست تکیه نمی‌کند: کمینه می‌گیرد", async () => {
    const o = listOutbox(async () => ok([deadEntry(1, { settledAtMs: 900 }), deadEntry(2, { settledAtMs: 100 }), deadEntry(3, { settledAtMs: 500 })]));
    expect(await monitorOf({}, o).sample()).toMatchObject({ ok: true, count: 3, oldestDeadAtMs: 100 });
  });

  it("رکوردِ بی‌زمانِ مرگ شمرده می‌شود و undated را زیاد می‌کند؛ کمینه فقط از تاریخ‌دارها", async () => {
    const o = listOutbox(async () => ok([deadEntry(1, { settledAtMs: null }), deadEntry(2, { settledAtMs: 700 })]));
    expect(await monitorOf({}, o).sample()).toMatchObject({ ok: true, count: 2, undated: 1, oldestDeadAtMs: 700 });
    const all = listOutbox(async () => ok([deadEntry(1, { settledAtMs: null })]));
    expect(await monitorOf({}, all).sample()).toMatchObject({ ok: true, count: 1, undated: 1, oldestDeadAtMs: null });
  });

  it("سقفِ خواندن به outbox داده می‌شود و پرسشِ ارسالی منجمد است", async () => {
    let seen: unknown;
    const o = listOutbox(async (q) => {
      seen = q;
      return ok([]);
    });
    await monitorOf({ sampleLimit: 7, downCount: 7 }, o).sample();
    expect(o.calls).toEqual([{ limit: 7 }]);
    expect(Object.isFrozen(seen)).toBe(true);
    await monitorOf({ sampleLimit: undefined }, o).sample();
    expect(o.calls[1]).toEqual({ limit: 1000 });
  });

  it("نتیجه منجمد و JSON‌پذیر است و بی‌نشت: هیچ شناسه/مبلغ/کدِ خطا در آن نیست", async () => {
    const o = listOutbox(async () => ok([deadEntry(1, { tenantId: "TENANT-SECRET", accountId: "ACCT-SECRET", lastErrorCode: "ERR-SECRET", reserved: 987654 })]));
    const s = await monitorOf({}, o).sample();
    expect(Object.isFrozen(s)).toBe(true);
    if (s.ok) expect(Object.isFrozen(s.byReason)).toBe(true);
    const json = JSON.stringify(s);
    for (const secret of ["TENANT-SECRET", "ACCT-SECRET", "ERR-SECRET", "987654", "r1"]) expect(json).not.toContain(secret);
    expect(JSON.parse(json)).toEqual(s);
  });

  it("هر فراخوانی نمونهٔ تازه می‌سازد (نمونه کش نمی‌شود)", async () => {
    const outbox = createMemoryOutbox();
    const m = monitorOf({}, outbox);
    expect(await m.sample()).toMatchObject({ count: 0 });
    await buryMany(outbox, 2);
    expect(await m.sample()).toMatchObject({ count: 2 });
  });

  it("atMs همان ساعتِ لحظهٔ نمونه‌گیری است", async () => {
    const clock = manualClock(42_000);
    const m = monitorOf({}, createMemoryOutbox(), clock);
    expect(await m.sample()).toMatchObject({ atMs: 42_000 });
    clock.advance(5);
    expect(await m.sample()).toMatchObject({ atMs: 42_005 });
  });
});

describe("settlement-backlog · نمونه‌گیری روی outboxهای خراب (هرگز نمی‌پرتابد)", () => {
  const code = async (answer: (q: { limit: number }) => unknown, over: Record<string, unknown> = {}) => (await monitorOf(over, listOutbox(answer)).sample()) as { ok: boolean; code?: string; atMs: number | null };

  it("خطای outbox (ok:false) ⇒ LIST_FAILED با atMs", async () => {
    expect(await code(async () => ({ ok: false, error: { code: "STORE_FAILURE", message: "SECRET-DB-DOWN" } }))).toEqual({ ok: false, code: "LIST_FAILED", atMs: T0 });
  });
  it("پرتابِ همگام و رد‌شدنِ ناهمگام ⇒ LIST_FAILED", async () => {
    expect(await code(() => { throw new Error("sync-boom"); })).toMatchObject({ code: "LIST_FAILED" });
    expect(await code(() => Promise.reject(new Error("async-boom")))).toMatchObject({ code: "LIST_FAILED" });
  });
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["عدد", 5],
    ["ok غیربولی", { ok: "yes", value: [] }],
    ["بدونِ ok", { value: [] }],
    ["value غیرِ آرایه", { ok: true, value: "x" }],
    ["value تهی", { ok: true }],
    ["بیش از سقف", { ok: true, value: Array.from({ length: 11 }, (_, i) => deadEntry(i + 1)) }],
  ])("پاسخِ بدشکل (%s) ⇒ BAD_LIST", async (_n, answer) => {
    expect(await code(async () => answer)).toMatchObject({ ok: false, code: "BAD_LIST", atMs: T0 });
  });
  it.each([
    ["رکوردِ غیرِ شیء", [5]],
    ["رکوردِ null", [null]],
    ["رکوردِ آرایه", [[]]],
    ["وضعیتِ غیرِ dead", [deadEntry(1, { state: "done" })]],
    ["tenantId تهی", [deadEntry(1, { tenantId: "" })]],
    ["accountId غیررشته", [deadEntry(1, { accountId: 7 })]],
    ["reservationId ناموجود", [deadEntry(1, { reservationId: undefined })]],
    ["deadReason ناشناخته", [deadEntry(1, { deadReason: "WHATEVER" })]],
    ["deadReason کلیدِ prototype", [deadEntry(1, { deadReason: "toString" })]],
    ["deadReason تهی", [deadEntry(1, { deadReason: null })]],
    ["settledAtMs منفی", [deadEntry(1, { settledAtMs: -1 })]],
    ["settledAtMs اعشاری", [deadEntry(1, { settledAtMs: 1.5 })]],
    ["settledAtMs رشته", [deadEntry(1, { settledAtMs: "5" })]],
    ["settledAtMs ناموجود", [deadEntry(1, { settledAtMs: undefined })]],
    ["رکوردِ تکراری", [deadEntry(1), deadEntry(1)]],
    ["یکی از چند رکورد بد", [deadEntry(1), deadEntry(2), deadEntry(3, { state: "open" })]],
  ])("%s ⇒ BAD_LIST (شکستِ بسته؛ هیچ نمونهٔ جزئی نیست)", async (_n, list) => {
    expect(await code(async () => ok(list as never))).toMatchObject({ ok: false, code: "BAD_LIST" });
  });
  it("رکوردهای هم‌شناسه با جدا بودنِ هر یک از سه بخش تکراری نیستند (بی‌تصادمِ الحاق)", async () => {
    const list = [deadEntry(1, { tenantId: "a", accountId: "bc", reservationId: "d" }), deadEntry(2, { tenantId: "ab", accountId: "c", reservationId: "d" })];
    expect(await code(async () => ok(list))).toMatchObject({ ok: true });
  });
  it("Proxyِ بدجنس در رکورد یا نتیجه ⇒ BAD_LIST و بی‌پرتاب", async () => {
    const evilEntry = new Proxy({}, { get() { throw new Error("evil-secret"); } });
    expect(await code(async () => ok([evilEntry] as never))).toEqual({ ok: false, atMs: T0, code: "BAD_LIST" });
    const evilResult = new Proxy({}, { get() { throw new Error("evil-secret"); } });
    // Promise.resolve روی Proxy خاصیتِ then را می‌خواند و پرتاب می‌شود ⇒ رد‌شدنِ فراخوانی ⇒ LIST_FAILED
    expect(await code(async () => evilResult)).toEqual({ ok: false, atMs: T0, code: "LIST_FAILED" });
    const evilArray = new Proxy([], { get() { throw new Error("evil-secret"); } });
    expect(await code(async () => ({ ok: true, value: evilArray }))).toEqual({ ok: false, atMs: T0, code: "BAD_LIST" });
  });
  it("نمونهٔ ناموفق منجمد است", async () => {
    expect(Object.isFrozen(await code(async () => ({ ok: false, error: { code: "STORE_FAILURE", message: "m" } })))).toBe(true);
    expect(Object.isFrozen(await code(async () => undefined))).toBe(true);
    expect(Object.isFrozen(await monitorOf({}, listOutbox(async () => ok([])), { nowMs: () => Number.NaN }).sample())).toBe(true);
  });
  it("پیامِ خطای پورت هرگز به نمونه نمی‌رسد", async () => {
    const s = await code(async () => ({ ok: false, error: { code: "STORE_FAILURE", message: "SECRET-DB-DOWN" } }));
    expect(JSON.stringify(s)).not.toContain("SECRET");
    const t = await code(() => Promise.reject(new Error("SECRET-BOOM")));
    expect(JSON.stringify(t)).not.toContain("SECRET");
  });
});

describe("settlement-backlog · ساعت", () => {
  it.each([["پرتاب", () => { throw new Error("clock-boom"); }], ["NaN", () => Number.NaN], ["منفی", () => -1], ["اعشاری", () => 1.5], ["رشته", () => "5"], ["undefined", () => undefined]])("ساعتِ ناسالم (%s) ⇒ CLOCK_INVALID بی‌آنکه outbox خوانده شود", async (_n, nowMs) => {
    const o = listOutbox(async () => ok([]));
    const m = monitorOf({}, o, { nowMs } as never);
    expect(await m.sample()).toEqual({ ok: false, atMs: null, code: "CLOCK_INVALID" });
    expect(o.calls).toHaveLength(0);
  });
  it("ساعتِ صفر معتبر است", async () => {
    expect(await monitorOf({}, createMemoryOutbox(), manualClock(0)).sample()).toMatchObject({ ok: true, atMs: 0 });
  });
});

describe("settlement-backlog · مهلتِ خواندن", () => {
  const never = () => new Promise<never>(() => undefined);

  it("بی‌timer مهلتی نیست و فراخوانیِ کند منتظر می‌ماند و نتیجه می‌دهد", async () => {
    let release: (v: unknown) => void = () => undefined;
    const o = listOutbox(() => new Promise((r) => { release = r; }));
    const p = monitorOf({}, o).sample();
    await sleep0();
    release(ok([deadEntry(1)]));
    expect(await p).toMatchObject({ ok: true, count: 1 });
  });

  it("با timer: پاسخِ به‌موقع نتیجه می‌دهد و تایمر لغو می‌شود (نشتِ تایمر نیست)", async () => {
    const timer = manualTimer();
    const o = listOutbox(async () => ok([deadEntry(1)]));
    const s = await monitorOf({ timer, timeoutMs: 123 }, o).sample();
    expect(s).toMatchObject({ ok: true, count: 1 });
    expect(timer.scheduled).toHaveLength(1);
    expect(timer.scheduled[0]).toMatchObject({ ms: 123, cancelled: true, fired: false });
    expect(timer.cancels).toBe(1);
  });

  it("با timer و بی‌timeoutMs: پیش‌فرض ۵۰۰۰ میلی‌ثانیه", async () => {
    const timer = manualTimer();
    await monitorOf({ timer }, listOutbox(async () => ok([]))).sample();
    expect(timer.scheduled[0]?.ms).toBe(5_000);
  });

  it("فراخوانیِ آویزان ⇒ TIMEOUT با atMs؛ تایمر لغوِ دوباره نمی‌شود", async () => {
    const timer = manualTimer();
    const p = monitorOf({ timer }, listOutbox(never)).sample();
    await sleep0();
    timer.fireAll();
    expect(await p).toEqual({ ok: false, atMs: T0, code: "TIMEOUT" });
    expect(timer.cancels).toBe(0);
  });

  it("پاسخِ دیرهنگام پس از مهلت نادیده است و خطای رد‌نشدهٔ ناخواسته نمی‌سازد", async () => {
    const timer = manualTimer();
    let reject: (e: unknown) => void = () => undefined;
    const p = monitorOf({ timer }, listOutbox(() => new Promise((_, rej) => { reject = rej; }))).sample();
    await sleep0();
    timer.fireAll();
    expect(await p).toMatchObject({ code: "TIMEOUT" });
    reject(new Error("late"));
    await sleep0();
    expect(timer.cancels).toBe(0); // پایانِ دیرهنگام دوباره «پایان» نمی‌دهد و تایمرِ شلیک‌شده را لغو نمی‌کند
  });

  it("شلیکِ دیرهنگامِ تایمر پس از نتیجه چیزی را عوض نمی‌کند و لغو فقط یک بار انجام شده است", async () => {
    const fired: Array<() => void> = [];
    let cancels = 0;
    const timer = { after: (fn: () => void) => { fired.push(fn); return 1; }, cancel: () => { cancels += 1; } };
    const s = await monitorOf({ timer }, listOutbox(async () => ok([deadEntry(1)]))).sample();
    expect(s).toMatchObject({ ok: true, count: 1 });
    fired[0]?.();
    await sleep0();
    expect(cancels).toBe(1);
  });

  it("پرتابِ همگامِ outbox یا زمان‌سنج پیش از ساخته‌شدنِ تایمر ⇒ هیچ cancel ای صدا زده نمی‌شود", async () => {
    const t1 = manualTimer();
    expect(await monitorOf({ timer: t1 }, listOutbox(() => { throw new Error("sync"); })).sample()).toMatchObject({ code: "LIST_FAILED" });
    expect(t1.scheduled).toHaveLength(0);
    expect(t1.cancels).toBe(0);
    let cancels = 0;
    const t2 = { after: () => { throw new Error("no-timer"); }, cancel: () => { cancels += 1; } };
    expect(await monitorOf({ timer: t2 }, listOutbox(async () => ok([]))).sample()).toMatchObject({ code: "LIST_FAILED" });
    expect(cancels).toBe(0);
  });

  it("پرتابِ زمان‌سنج هنگامِ ساخت ⇒ LIST_FAILED (بی‌پرتاب)", async () => {
    const timer = { after: () => { throw new Error("no-timer-secret"); }, cancel: () => undefined };
    const s = await monitorOf({ timer }, listOutbox(never)).sample();
    expect(s).toEqual({ ok: false, atMs: T0, code: "LIST_FAILED" });
  });

  it("پرتابِ cancel نتیجه را خراب نمی‌کند", async () => {
    const timer = { after: () => 1, cancel: () => { throw new Error("cancel-boom"); } };
    expect(await monitorOf({ timer }, listOutbox(async () => ok([]))).sample()).toMatchObject({ ok: true, count: 0 });
  });

  it("زمان‌سنجی که پیش از بازگشت همگام fn را صدا می‌زند ⇒ TIMEOUT و بی‌پرتاب", async () => {
    const timer = { after: (fn: () => void) => { fn(); return 1; }, cancel: () => undefined };
    expect(await monitorOf({ timer }, listOutbox(async () => ok([]))).sample()).toMatchObject({ ok: false, code: "TIMEOUT" });
  });
});

describe("settlement-backlog · مرزِ سقف با TH", () => {
  it("TH سقفِ ۱۰ دارد (قراردادِ کمکی‌تست)", () => {
    expect(TH.sampleLimit).toBe(10);
  });
});
