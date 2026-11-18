/**
 * زنگِ ماندگارِ مرده‌ها در حلقهٔ رفتگر (ADR-0026، م۳‑د‑۲): `deadLetters` — فهرستِ مرده‌های تأییدنشده، `deliver` (await‌شونده با مهلت)،
 * تأیید فقط پس از موفقیت، تحویلِ دست‌کم‌یک‌بار، عقب‌نشینی، تخلیه و خرابیِ هر وابسته. روی outbox حافظه‌ایِ واقعی و زمانِ مجازی.
 * فایلِ تازه است؛ هیچ آزمونِ موجودی تغییر نکرده است.
 */
import { describe, expect, it } from "vitest";
import { createMemoryOutbox, createSweepLoop } from "./index";
import type { DeadLetter, LoopFault, SettlementOutbox, SweepLoop } from "./index";
import { beginOf, refOf } from "./outbox-contract";
import { fakeSweeper, flush, manualTimer, sweepReport } from "./test-kit";
import type { ManualTimer } from "./test-kit";

const GRACE = 20_000;
const INTERVAL = 1000;
const HALF = GRACE / 2;
const DELIVER_TIMEOUT = 30_000; // پیش‌فرضِ deliverTimeoutMs
const CANARY = "LEAK-CANARY-dead-letter-4b7e";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!r.ok) throw new Error(`انتظار موفقیت بود: ${r.error.code}`);
  return r.value;
};

async function seedDead(o: SettlementOutbox, ids: readonly string[], atMs = 5_000): Promise<void> {
  for (const id of ids) {
    must(await o.begin(beginOf({ reservationId: id })));
    must(await o.bury(refOf(id), { reason: "EXPIRED_UNBILLED", errorCode: "RESERVATION_EXPIRED", atMs }));
  }
}

type Hooks = {
  /** پیش از متدِ واقعی صدا می‌شود؛ مقدارِ برگشتیِ غیر‌undefined جایگزینِ نتیجه می‌شود (پرتاب هم مجاز است). */
  list?: (n: number) => unknown;
  ack?: (n: number, ref: { reservationId: string }) => unknown;
};

/** پوششِ outbox که فقط دو متدِ زنگ را ردیابی/خراب می‌کند. */
function tracedOutbox(real: SettlementOutbox, log: string[], hooks: Hooks) {
  const n = { list: 0, ack: 0 };
  const outbox = {
    async listUnacknowledgedDead(q: { limit: number }) {
      n.list += 1;
      log.push(`list(${q.limit})`);
      const r = hooks.list ? await hooks.list(n.list) : undefined;
      return r !== undefined ? r : real.listUnacknowledgedDead(q);
    },
    async acknowledgeDead(ref: { tenantId: string; accountId: string; reservationId: string }, ack: { atMs: number }) {
      n.ack += 1;
      log.push(`ack:${ref.reservationId}`);
      const r = hooks.ack ? await hooks.ack(n.ack, ref) : undefined;
      return r !== undefined ? r : real.acknowledgeDead(ref, ack);
    },
  } as unknown as SettlementOutbox;
  return { outbox, n };
}

type Rig = { loop: SweepLoop; timer: ManualTimer; real: SettlementOutbox; log: string[]; faults: LoopFault[]; delivered: DeadLetter[]; n: { list: number; ack: number } };

async function mk(
  o: {
    ids?: readonly string[];
    deliver?: (l: DeadLetter) => unknown;
    dead?: Record<string, unknown>;
    hooks?: Hooks;
    sweep?: (n: number) => unknown;
    real?: SettlementOutbox;
    timer?: ManualTimer;
    over?: Record<string, unknown>;
  } = {},
): Promise<Rig> {
  const timer = o.timer ?? manualTimer();
  const real = o.real ?? createMemoryOutbox();
  if (o.ids) await seedDead(real, o.ids);
  const log: string[] = [];
  const t = tracedOutbox(real, log, o.hooks ?? {});
  const faults: LoopFault[] = [];
  const delivered: DeadLetter[] = [];
  const user = o.deliver ?? (() => undefined);
  const deliver = (l: DeadLetter): unknown => {
    log.push(`deliver:${l.reservationId}`);
    delivered.push(l);
    return user(l);
  };
  const made = createSweepLoop({
    sweeper: fakeSweeper(o.sweep ?? (() => sweepReport({ examined: 0 }))),
    timer,
    clock: timer.clock,
    graceMs: GRACE,
    intervalMs: INTERVAL,
    observer: { onFault: (f: LoopFault) => void faults.push(f) },
    deadLetters: { outbox: t.outbox, deliver, ...(o.dead ?? {}) },
    ...(o.over ?? {}),
  });
  if (!made.ok) throw new Error(`createSweepLoop failed: ${made.error.issues.join("; ")}`);
  return { loop: made.value, timer, real, log, faults, delivered, n: t.n };
}

const unacked = async (o: SettlementOutbox): Promise<string[]> => must(await o.listUnacknowledgedDead({ limit: 1000 })).map((e) => e.reservationId);
/** تأخیرهای زمان‌بندیِ خودِ حلقه (بدونِ تایمرهای مهلتِ deliver). */
const loopDelays = (x: Rig): number[] => x.timer.delays.filter((d) => d !== DELIVER_TIMEOUT);
const dbad = { ok: false, error: { code: "STORE_FAILURE", message: CANARY } };
const deadRow = (over: Record<string, unknown> = {}) => ({ tenantId: "t", accountId: "a", reservationId: "r", unit: "u", reserved: 1, state: "dead", deadReason: "EXPIRED_UNBILLED", lastErrorCode: null, attempts: 0, settledAtMs: 1, ...over });

describe("settlement · زنگِ ماندگار · پیکربندی", () => {
  const base = () => {
    const timer = manualTimer();
    return { sweeper: fakeSweeper(() => sweepReport()), timer, clock: timer.clock, graceMs: GRACE, intervalMs: INTERVAL };
  };
  /** `dead` شیء ⇒ روی پیکربندیِ معتبر ادغام می‌شود؛ غیرشیء/آرایه/null ⇒ خام. */
  const cfg = (dead: unknown) => {
    const merged = typeof dead === "object" && dead !== null && !Array.isArray(dead) ? { outbox: createMemoryOutbox(), deliver: () => 1, ...dead } : dead;
    return createSweepLoop({ ...base(), deadLetters: merged });
  };

  it("deadLetters اختیاری است: بدونِ آن حلقه معتبر است و آمارِ زنگ غیرفعال، صفر و منجمد است", () => {
    const r = createSweepLoop(base());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.status().deadLetters).toEqual({ enabled: false, delivered: 0, acknowledged: 0, deliverFailures: 0, ackFailures: 0, listFailures: 0, lastAckAtMs: null });
      expect(Object.isFrozen(r.value.status().deadLetters)).toBe(true);
    }
  });
  it("پیکربندیِ کمینه معتبر است و آمارِ زنگ فعال می‌شود", () => {
    const r = cfg({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.status().deadLetters.enabled).toBe(true);
  });
  it.each<[string, unknown]>([
    ["غیرشیء", 5],
    ["null", null],
    ["آرایه", []],
    ["بی‌outbox", { outbox: undefined }],
    ["outbox بی‌listUnacknowledgedDead", { outbox: { acknowledgeDead: () => 1 } }],
    ["outbox بی‌acknowledgeDead", { outbox: { listUnacknowledgedDead: () => 1 } }],
    ["بی‌deliver", { deliver: undefined }],
    ["deliver غیرتابع", { deliver: "x" }],
    ["batchLimit صفر", { batchLimit: 0 }],
    ["batchLimit بزرگ", { batchLimit: 1001 }],
    ["batchLimit اعشاری", { batchLimit: 1.5 }],
    ["maxBatchesPerRun صفر", { maxBatchesPerRun: 0 }],
    ["maxBatchesPerRun بزرگ", { maxBatchesPerRun: 101 }],
    ["deliverTimeoutMs صفر", { deliverTimeoutMs: 0 }],
    ["deliverTimeoutMs بزرگ", { deliverTimeoutMs: 3_600_001 }],
    ["deliverTimeoutMs رشته", { deliverTimeoutMs: "30000" }],
    ["کلید ناشناخته", { ackAll: true }],
  ])("%s ⇒ INVALID_CONFIG با نامِ فیلد", (_n, dead) => {
    const r = cfg(dead);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_CONFIG");
      expect(r.error.issues.some((i) => i.includes("deadLetters"))).toBe(true);
    }
  });
  it("مرزها پذیرفته می‌شوند", () => {
    expect(cfg({ batchLimit: 1, maxBatchesPerRun: 1, deliverTimeoutMs: 1 }).ok).toBe(true);
    expect(cfg({ batchLimit: 1000, maxBatchesPerRun: 100, deliverTimeoutMs: 3_600_000 }).ok).toBe(true);
  });
  it("مقدارِ نامعتبر پژواک نمی‌شود", () => {
    const r = cfg({ ackAll: CANARY, batchLimit: CANARY });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).not.toContain(CANARY);
  });
  it("getter پرتاب‌کننده در deadLetters ⇒ INVALID_CONFIG بی‌پرتاب و بی‌نشت", () => {
    const evil = { outbox: createMemoryOutbox(), deliver: () => 1 };
    Object.defineProperty(evil, "batchLimit", { get: () => { throw new Error(CANARY); }, enumerable: true });
    const r = createSweepLoop({ ...base(), deadLetters: evil });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r.error)).not.toContain(CANARY);
  });
  it("ساختن هیچ کاری نمی‌کند: نه تایمر، نه فهرست، نه تحویل", async () => {
    const x = await mk({ ids: ["a"] });
    await x.timer.advance(60_000);
    expect(x.timer.delays).toEqual([]);
    expect(x.n.list).toBe(0);
  });
});

describe("settlement · زنگِ ماندگار · تحویل و تأیید", () => {
  it("نخستین گذرِ پس از start (ریستارت) همهٔ مرده‌های تأییدنشده را می‌رساند؛ ترتیبِ هر رکورد: تحویل ← تأیید", async () => {
    const x = await mk({ ids: ["a", "b", "c"] });
    expect(x.loop.start()).toEqual({ started: true });
    await x.timer.advance(0);
    expect(x.delivered.map((l) => l.reservationId)).toEqual(["a", "b", "c"]);
    expect(x.log.filter((l) => l.startsWith("deliver:") || l.startsWith("ack:"))).toEqual(["deliver:a", "ack:a", "deliver:b", "ack:b", "deliver:c", "ack:c"]);
    expect(await unacked(x.real)).toEqual([]);
    expect(x.loop.status().deadLetters).toMatchObject({ enabled: true, delivered: 3, acknowledged: 3, deliverFailures: 0, ackFailures: 0, listFailures: 0, lastAckAtMs: x.timer.now() });
    await x.loop.stop();
  });

  it("نامه فقط فیلدهای شناخته‌شده را دارد و منجمد است؛ فیلدِ اضافهٔ outbox هرگز به deliver نمی‌رسد", async () => {
    const real = createMemoryOutbox();
    await seedDead(real, ["a"], 7_777);
    const listing = async (q: { limit: number }) => ({ ok: true as const, value: must(await real.listUnacknowledgedDead(q)).map((e) => ({ ...e, secret: CANARY, message: CANARY })) });
    const got: DeadLetter[] = [];
    const timer = manualTimer();
    const made = createSweepLoop({
      sweeper: fakeSweeper(() => sweepReport()),
      timer,
      clock: timer.clock,
      graceMs: GRACE,
      intervalMs: INTERVAL,
      deadLetters: { outbox: { listUnacknowledgedDead: listing, acknowledgeDead: real.acknowledgeDead }, deliver: (l: DeadLetter) => void got.push(l) },
    });
    if (!made.ok) throw new Error("cfg");
    made.value.start();
    await timer.advance(0);
    expect(got).toHaveLength(1);
    expect(got[0]).toEqual({ tenantId: "t1", accountId: "a1", reservationId: "a", unit: "IRR_MICROS", reserved: 500, reason: "EXPIRED_UNBILLED", errorCode: "RESERVATION_EXPIRED", attempts: 0, deadAtMs: 7_777 });
    expect(JSON.stringify(got)).not.toContain(CANARY);
    expect(Object.isFrozen(got[0])).toBe(true);
    await made.value.stop();
  });

  it("deliver شکست‌خورده ⇒ تأیید نمی‌شود؛ گذر بعد دوباره می‌رسد؛ پس از موفقیت تأیید و دیگر نمی‌آید", async () => {
    let calls = 0;
    const x = await mk({
      ids: ["a"],
      deliver: () => {
        calls += 1;
        if (calls < 3) throw new Error(CANARY);
      },
    });
    x.loop.start();
    await x.timer.advance(0);
    expect(await unacked(x.real)).toEqual(["a"]);
    expect(x.n.ack).toBe(0);
    expect(x.faults.map((f) => f.kind)).toEqual(["DEAD_DELIVER_FAILED"]);
    await x.timer.advance(INTERVAL);
    expect(await unacked(x.real)).toEqual(["a"]);
    await x.timer.advance(2 * INTERVAL);
    expect(calls).toBe(3);
    expect(await unacked(x.real)).toEqual([]);
    await x.timer.advance(10 * INTERVAL);
    expect(calls).toBe(3); // تأییدشده دوباره نمی‌آید
    expect(x.loop.status().deadLetters).toMatchObject({ delivered: 1, acknowledged: 1, deliverFailures: 2 });
    expect(JSON.stringify([x.faults, x.loop.status()])).not.toContain(CANARY);
    await x.loop.stop();
  });

  it.each<[string, () => unknown]>([
    ["رد‌شدنِ وعده", () => Promise.reject(new Error(CANARY))],
    ["thenableِ پرتاب‌کننده", () => ({ then: () => { throw new Error(CANARY); } })],
    ["getterِ then پرتاب‌کننده", () => Object.defineProperty({}, "then", { get: () => { throw new Error(CANARY); } })],
  ])("deliver با %s ⇒ شکستِ بی‌نشت و تأییدنشده", async (_n, deliver) => {
    const x = await mk({ ids: ["a"], deliver });
    x.loop.start();
    await x.timer.advance(0);
    expect(await unacked(x.real)).toEqual(["a"]);
    expect(x.faults.map((f) => f.kind)).toEqual(["DEAD_DELIVER_FAILED"]);
    expect(JSON.stringify([x.faults, x.loop.status()])).not.toContain(CANARY);
    await x.loop.stop();
  });

  it("deliver غیرهمگام و کند await می‌شود: تأیید فقط پس از resolve", async () => {
    let release: () => void = () => undefined;
    const x = await mk({ ids: ["a"], deliver: () => new Promise<void>((res) => (release = res)) });
    x.loop.start();
    await x.timer.advance(0);
    expect(x.n.ack).toBe(0);
    expect(x.loop.status().busy).toBe(true);
    release();
    await flush();
    expect(x.n.ack).toBe(1);
    expect(await unacked(x.real)).toEqual([]);
    await x.loop.stop();
  });

  it("deliverِ آویزان: پس از deliverTimeoutMs شکست حساب می‌شود، حلقه آزاد می‌ماند و رکورد برای گذر بعد می‌ماند", async () => {
    const x = await mk({ ids: ["a"], deliver: () => new Promise(() => undefined), dead: { deliverTimeoutMs: 5_000 } });
    x.loop.start();
    await x.timer.advance(0);
    expect(x.loop.status().busy).toBe(true);
    expect(x.timer.delays).toContain(5_000);
    await x.timer.advance(4_999);
    expect(x.loop.status().busy).toBe(true);
    await x.timer.advance(1);
    expect(x.loop.status().busy).toBe(false);
    expect(x.faults.map((f) => f.kind)).toEqual(["DEAD_DELIVER_FAILED"]);
    expect(await unacked(x.real)).toEqual(["a"]);
    expect(x.loop.status().state).toBe("running");
    await x.loop.stop();
  });

  it("deliverِ دیر (resolve پس از مهلت) هیچ تأییدِ دیرهنگامی نمی‌نویسد", async () => {
    let release: () => void = () => undefined;
    const x = await mk({ ids: ["a"], deliver: () => new Promise<void>((res) => (release = res)), dead: { deliverTimeoutMs: 1_000 } });
    x.loop.start();
    await x.timer.advance(1_000);
    release();
    await flush();
    expect(x.n.ack).toBe(0);
    expect(await unacked(x.real)).toEqual(["a"]);
    await x.loop.stop();
  });

  it("زمان‌سنجِ مهلت خراب ⇒ deliver اصلاً صدا زده نمی‌شود و حلقه آویزان نمی‌ماند", async () => {
    const x = await mk({ ids: ["a"] });
    x.loop.start(); // تایمرِ گذرِ نخست ساخته شد
    x.timer.failAfter(1); // تایمرِ بعدی (مهلتِ deliver) خراب
    await x.timer.advance(0);
    expect(x.delivered).toEqual([]);
    expect(await unacked(x.real)).toEqual(["a"]);
    expect(x.faults.map((f) => f.kind)).toContain("DEAD_DELIVER_FAILED");
    expect(x.loop.status().busy).toBe(false);
    await x.loop.stop();
  });

  it("رکوردِ مسموم گرسنگی نمی‌دهد: با batchLimit=2 و دو رکوردِ مسمومِ اول، بقیه در همان گذر می‌رسند", async () => {
    // فهرست به ترتیبِ (زمان مرگ، شناسه) است: شناسهٔ مسموم‌ها عمداً پیش از سالم‌ها مرتب می‌شود.
    const poison = new Set(["a-p1", "a-p2"]);
    const x = await mk({
      ids: ["a-p1", "a-p2", "b-g1", "b-g2", "b-g3"],
      dead: { batchLimit: 2, maxBatchesPerRun: 5 },
      deliver: (l) => {
        if (poison.has(l.reservationId)) throw new Error("bad");
      },
    });
    x.loop.start();
    await x.timer.advance(0);
    expect(await unacked(x.real)).toEqual(["a-p1", "a-p2"]);
    const tries = (id: string) => x.log.filter((l) => l === `deliver:${id}`).length;
    expect(tries("a-p1")).toBe(1); // یک تلاش در هر گذر
    expect(tries("a-p2")).toBe(1);
    expect(x.loop.status().deadLetters).toMatchObject({ acknowledged: 3, deliverFailures: 2 });
    await x.loop.stop();
  });

  it("رکوردِ مسموم میانِ سالم‌ها: فقط خودش می‌ماند", async () => {
    const x = await mk({
      ids: ["g1", "p", "g2"],
      deliver: (l) => {
        if (l.reservationId === "p") throw new Error("x");
      },
    });
    x.loop.start();
    await x.timer.advance(0);
    expect(await unacked(x.real)).toEqual(["p"]);
    await x.loop.stop();
  });

  it("ناپایداریِ تأیید: زنگ رسید ولی تأیید ثبت نشد ⇒ DEAD_ACK_FAILED و دوباره می‌رسد (دست‌کم‌یک‌بار)", async () => {
    const x = await mk({ ids: ["a"], hooks: { ack: (n) => (n === 1 ? dbad : undefined) } });
    x.loop.start();
    await x.timer.advance(0);
    expect(x.faults.map((f) => f.kind)).toEqual(["DEAD_ACK_FAILED"]);
    expect(await unacked(x.real)).toEqual(["a"]);
    await x.timer.advance(INTERVAL);
    expect(await unacked(x.real)).toEqual([]);
    expect(x.delivered.length).toBe(2); // دو بار تحویل: دست‌کم‌یک‌بار
    expect(x.loop.status().deadLetters).toMatchObject({ delivered: 2, acknowledged: 1, ackFailures: 1 });
    expect(JSON.stringify([x.faults, x.loop.status()])).not.toContain(CANARY);
    await x.loop.stop();
  });

  it.each<[string, () => unknown]>([
    ["پرتاب", () => { throw new Error(CANARY); }],
    ["undefined", () => undefined],
    ["شکلِ نامعتبر", () => ({ ok: "yes" })],
    ["ok:false", () => dbad],
  ])("acknowledgeDead با %s ⇒ DEAD_ACK_FAILED (هرگز «تأییدشده» فرض نمی‌شود)", async (_n, result) => {
    const real = createMemoryOutbox();
    await seedDead(real, ["a"]);
    const timer = manualTimer();
    const faults: LoopFault[] = [];
    const made = createSweepLoop({
      sweeper: fakeSweeper(() => sweepReport()),
      timer,
      clock: timer.clock,
      graceMs: GRACE,
      intervalMs: INTERVAL,
      observer: { onFault: (f: LoopFault) => void faults.push(f) },
      deadLetters: { outbox: { listUnacknowledgedDead: real.listUnacknowledgedDead, acknowledgeDead: (async () => result()) as never }, deliver: () => undefined },
    });
    if (!made.ok) throw new Error("cfg");
    made.value.start();
    await timer.advance(0);
    expect(faults[0]?.kind).toBe("DEAD_ACK_FAILED");
    expect(made.value.status().deadLetters).toMatchObject({ acknowledged: 0, ackFailures: 1 });
    expect(JSON.stringify([faults, made.value.status()])).not.toContain(CANARY);
    await made.value.stop();
  });

  it("ساعتِ نامعتبر ⇒ تأیید ثبت نمی‌شود (atMs ساختگی نمی‌نویسیم)، DEAD_ACK_FAILED، حلقه می‌ماند و با ساعتِ سالم جبران می‌شود", async () => {
    const real = createMemoryOutbox();
    await seedDead(real, ["a"]);
    const timer = manualTimer();
    let bad = true;
    const faults: LoopFault[] = [];
    const made = createSweepLoop({
      sweeper: fakeSweeper(() => sweepReport()),
      timer,
      clock: { nowMs: () => (bad ? Number.NaN : timer.now()) },
      graceMs: GRACE,
      intervalMs: INTERVAL,
      observer: { onFault: (f: LoopFault) => void faults.push(f) },
      deadLetters: { outbox: real, deliver: () => undefined },
    });
    if (!made.ok) throw new Error("cfg");
    made.value.start();
    await timer.advance(0);
    expect(faults.map((f) => f.kind)).toEqual(["DEAD_ACK_FAILED"]);
    expect(await unacked(real)).toEqual(["a"]);
    bad = false;
    await timer.advance(INTERVAL);
    expect(await unacked(real)).toEqual([]);
    await made.value.stop();
  });
});

describe("settlement · زنگِ ماندگار · خرابیِ فهرست", () => {
  it.each<[string, () => unknown]>([
    ["نتیجهٔ ok:false", () => dbad],
    ["پرتاب", () => { throw new Error(CANARY); }],
    ["غیرشیء", () => 42],
    ["مقدارِ غیرآرایه", () => ({ ok: true, value: "x" })],
    ["رکوردِ غیرمرده", () => ({ ok: true, value: [deadRow({ state: "done", deadReason: null })] })],
    ["رکوردِ باز با دلیلِ مرگِ معتبر (فقط state فرق دارد)", () => ({ ok: true, value: [deadRow({ state: "open" })] })],
    ["کدِ خطای تهی", () => ({ ok: true, value: [deadRow({ lastErrorCode: "" })] })],
    ["کدِ خطای غیررشته", () => ({ ok: true, value: [deadRow({ lastErrorCode: 5 })] })],
    ["شناسهٔ تهی", () => ({ ok: true, value: [deadRow({ tenantId: "" })] })],
    ["دلیلِ ناشناخته", () => ({ ok: true, value: [deadRow({ deadReason: "WHATEVER" })] })],
    ["مبلغِ منفی", () => ({ ok: true, value: [deadRow({ reserved: -1 })] })],
    ["زمانِ مرگِ نامعتبر", () => ({ ok: true, value: [deadRow({ settledAtMs: 1.5 })] })],
    ["بیش از limit", () => ({ ok: true, value: Array.from({ length: 51 }, (_x, i) => deadRow({ reservationId: `r${i}` })) })],
    ["یک رکوردِ خراب میانِ سالم‌ها (کلِ فهرست رد می‌شود)", () => ({ ok: true, value: [deadRow(), deadRow({ reservationId: "r2", unit: "" })] })],
  ])("%s ⇒ DEAD_LIST_FAILED؛ هیچ تحویل و تأییدی نیست و حلقه نمی‌میرد", async (_n, result) => {
    const x = await mk({ ids: ["a"], hooks: { list: () => result() } });
    x.loop.start();
    await x.timer.advance(0);
    expect(x.delivered).toEqual([]);
    expect(x.n.ack).toBe(0);
    expect(x.faults.map((f) => f.kind)).toEqual(["DEAD_LIST_FAILED"]);
    expect(x.loop.status()).toMatchObject({ state: "running", lastFault: "DEAD_LIST_FAILED", deadLetters: { listFailures: 1 } });
    expect(JSON.stringify([x.faults, x.loop.status()])).not.toContain(CANARY);
    await x.loop.stop();
  });

  it("پس از بهبودِ outbox خودبه‌خود جبران می‌شود", async () => {
    const x = await mk({ ids: ["a"], hooks: { list: (n) => (n <= 3 ? dbad : undefined) } });
    x.loop.start();
    await x.timer.advance(60_000);
    expect(await unacked(x.real)).toEqual([]);
    expect(x.loop.status()).toMatchObject({ consecutiveFailures: 0, lastFault: "DEAD_LIST_FAILED" });
    await x.loop.stop();
  });
});

describe("settlement · زنگِ ماندگار · زمان‌بندی، عقب‌نشینی و تخلیه", () => {
  it("شکستِ زنگ همان عقب‌نشینیِ ADR-0023 را می‌گیرد و فاصله هرگز از ⌊graceMs/2⌋ بیشتر نمی‌شود (تسویه کند نمی‌شود)", async () => {
    const x = await mk({
      ids: ["a"],
      deliver: () => {
        throw new Error("x");
      },
    });
    x.loop.start();
    await x.timer.advance(10 * 60_000);
    const d = loopDelays(x);
    expect(d.slice(0, 7)).toEqual([0, INTERVAL, 2 * INTERVAL, 4 * INTERVAL, 8 * INTERVAL, HALF, HALF]);
    expect(Math.max(...d)).toBe(HALF);
    expect(x.loop.status().consecutiveFailures).toBe(x.loop.status().runs);
    await x.loop.stop();
  });

  it("خطای رفتگر و خطای زنگ هم‌زمان: هر دو اعلام می‌شوند ولی شکستِ پیاپی برای هر گذر یک بار شمرده می‌شود", async () => {
    const y = await mk({
      ids: ["a"],
      deliver: () => {
        throw new Error("x");
      },
      sweep: () => sweepReport({ listFailed: true }),
    });
    y.loop.start();
    await y.timer.advance(0);
    expect(y.faults.map((f) => f.kind)).toEqual(["LIST_FAILED", "DEAD_DELIVER_FAILED"]);
    expect(y.loop.status()).toMatchObject({ consecutiveFailures: 1, runs: 1 });
    expect(y.loop.status().totals.faults).toBe(2);
    await y.loop.stop();
  });

  it("شکستِ رفتگر (گزارشِ LIST_FAILED یا پرتاب) مانعِ رسیدنِ زنگ نمی‌شود (مستقل)", async () => {
    const a = await mk({ ids: ["a", "b"], sweep: () => sweepReport({ listFailed: true }) });
    a.loop.start();
    await a.timer.advance(0);
    expect(await unacked(a.real)).toEqual([]);
    expect(a.faults.map((f) => f.kind)).toEqual(["LIST_FAILED"]);
    const b = await mk({ ids: ["a", "b"], sweep: () => new Error("boom") });
    b.loop.start();
    await b.timer.advance(0);
    expect(await unacked(b.real)).toEqual([]);
    expect(b.faults.map((f) => f.kind)).toEqual(["SWEEP_THREW"]);
    await a.loop.stop();
    await b.loop.stop();
  });

  it("تخلیه: بیش از batchLimit×maxBatchesPerRun ⇒ گذرِ بعد بی‌انتظار (تأخیر ۰) تا تمام شود؛ سپس فاصلهٔ عادی", async () => {
    const ids = Array.from({ length: 11 }, (_x, i) => `r${String(i).padStart(2, "0")}`);
    const x = await mk({ ids, dead: { batchLimit: 2, maxBatchesPerRun: 2 } });
    x.loop.start();
    await x.timer.advance(0);
    expect(await unacked(x.real)).toEqual([]);
    expect(x.loop.status().deadLetters.acknowledged).toBe(11);
    expect(x.loop.status().runs).toBe(3); // ۴ + ۴ + ۳
    expect(loopDelays(x)).toEqual([0, 0, 0, INTERVAL]); // دو گذرِ بی‌انتظار، سپس عادی
    await x.loop.stop();
  });

  it("تخلیه سقف دارد: maxDrainRuns گذرِ پیاپی، سپس فاصلهٔ عادی (حلقهٔ داغ نمی‌شود)", async () => {
    const ids = Array.from({ length: 30 }, (_x, i) => `r${String(i).padStart(2, "0")}`);
    const x = await mk({ ids, dead: { batchLimit: 1, maxBatchesPerRun: 1 }, over: { maxDrainRuns: 3 } });
    x.loop.start();
    await x.timer.advance(0);
    expect(loopDelays(x).slice(0, 5)).toEqual([0, 0, 0, 0, INTERVAL]);
    expect(x.loop.status().deadLetters.acknowledged).toBe(4);
    await x.loop.stop();
  });

  it("بدون مرده: هر گذر یک فهرستِ خالی می‌خواند؛ هیچ تحویل/تأییدی نیست و فاصله عادی است", async () => {
    const x = await mk();
    x.loop.start();
    await x.timer.advance(3 * INTERVAL);
    expect(x.n.list).toBe(x.loop.status().runs);
    expect(x.n.ack).toBe(0);
    expect(x.timer.delays.every((d) => d === 0 || d === INTERVAL)).toBe(true);
    await x.loop.stop();
  });

  it("بدونِ deadLetters رفتار قبلی است: هیچ فراخوانیِ outbox زنگ و هیچ تایمرِ مهلتی نیست", async () => {
    const timer = manualTimer();
    const r = createSweepLoop({ sweeper: fakeSweeper(() => sweepReport()), timer, clock: timer.clock, graceMs: GRACE, intervalMs: INTERVAL });
    if (!r.ok) throw new Error("cfg");
    r.value.start();
    await timer.advance(5 * INTERVAL);
    expect(timer.delays.every((d) => d === 0 || d === INTERVAL)).toBe(true);
    expect(r.value.status().deadLetters.enabled).toBe(false);
    await r.value.stop();
  });
});

describe("settlement · زنگِ ماندگار · چرخهٔ عمر", () => {
  it("stop میانِ رکوردها: رکوردهای مانده تأییدنشده می‌مانند؛ ریستارت همان‌ها را می‌رساند و تأییدشده‌ها را نه", async () => {
    const real = createMemoryOutbox();
    const timer = manualTimer();
    let ref: SweepLoop | null = null;
    const first = await mk({
      real,
      timer,
      ids: ["a", "b", "c"],
      deliver: (l) => {
        if (l.reservationId === "a") void ref?.stop(); // وسطِ گذر
      },
    });
    ref = first.loop;
    first.loop.start();
    await timer.advance(0);
    expect(await unacked(real)).toEqual(["b", "c"]); // a رسید و تأیید شد؛ بقیه نه
    expect(first.loop.status().busy).toBe(false);
    expect(first.log.filter((l) => l.startsWith("ack:"))).toEqual(["ack:a"]);

    const second = await mk({ real, timer });
    second.loop.start();
    await timer.advance(0);
    expect(second.delivered.map((l) => l.reservationId)).toEqual(["b", "c"]);
    expect(await unacked(real)).toEqual([]);
    await second.loop.stop();
  });

  it("مرگِ فرایند میانِ تحویل و تأیید ⇒ در ریستارت دوباره می‌رسد (دست‌کم‌یک‌بار) و پس از آن هرگز", async () => {
    const real = createMemoryOutbox();
    const timer = manualTimer();
    await seedDead(real, ["a"]);
    // «فرایندِ ۱»: deliver موفق می‌شود ولی تأیید هرگز نمی‌رسد (مرگ).
    const p1 = await mk({ real, timer, hooks: { ack: () => new Promise(() => undefined) } });
    p1.loop.start();
    await timer.advance(0);
    expect(p1.delivered).toHaveLength(1);
    expect(await unacked(real)).toEqual(["a"]);
    const p2 = await mk({ real, timer });
    p2.loop.start();
    await timer.advance(0);
    expect(p2.delivered.map((l) => l.reservationId)).toEqual(["a"]);
    expect(await unacked(real)).toEqual([]);
    await timer.advance(10 * INTERVAL);
    expect(p2.delivered).toHaveLength(1);
    await p2.loop.stop();
  });

  it("مرده‌ای که همین گذر دفن شد در همان گذر می‌رسد: onBuried (سریع و درون‌حافظه) و deliver (ماندگار) هر دو", async () => {
    const real = createMemoryOutbox();
    const timer = manualTimer();
    const buriedSeen: unknown[] = [];
    const got: DeadLetter[] = [];
    let first = true;
    const sweeper = {
      async sweep() {
        if (!first) return sweepReport();
        first = false;
        await seedDead(real, ["z"]);
        return sweepReport({ examined: 1, buried: [{ tenantId: "t1", accountId: "a1", reservationId: "z", reason: "EXPIRED_UNBILLED", errorCode: "RESERVATION_EXPIRED" }] });
      },
    };
    const made = createSweepLoop({ sweeper, timer, clock: timer.clock, graceMs: GRACE, intervalMs: INTERVAL, observer: { onBuried: (i: readonly unknown[]) => void buriedSeen.push(...i) }, deadLetters: { outbox: real, deliver: (l: DeadLetter) => void got.push(l) } });
    if (!made.ok) throw new Error("cfg");
    made.value.start();
    await timer.advance(0);
    expect(buriedSeen).toHaveLength(1);
    expect(got.map((l) => l.reservationId)).toEqual(["z"]);
    expect(await unacked(real)).toEqual([]);
    await made.value.stop();
  });

  it("stop در حینِ deliverِ آویزان: پس از stopTimeoutMs با clean:false برمی‌گردد و رکورد تأییدنشده می‌ماند", async () => {
    const x = await mk({ ids: ["a"], deliver: () => new Promise(() => undefined), dead: { deliverTimeoutMs: 3_600_000 }, over: { stopTimeoutMs: 2_000 } });
    x.loop.start();
    await x.timer.advance(0);
    const p = x.loop.stop();
    await x.timer.advance(2_000);
    await expect(p).resolves.toEqual({ clean: false });
    expect(await unacked(x.real)).toEqual(["a"]);
  });
});

describe("settlement · زنگِ ماندگار · مرزهای ریز (تکمیلِ پوششِ جهشی)", () => {
  it("ساعتِ نامعتبر: acknowledgeDead اصلاً صدا زده نمی‌شود (نه فقط ردِ outbox)", async () => {
    const real = createMemoryOutbox();
    await seedDead(real, ["a"]);
    const timer = manualTimer();
    const log: string[] = [];
    const t = tracedOutbox(real, log, {});
    const made = createSweepLoop({
      sweeper: fakeSweeper(() => sweepReport()),
      timer,
      clock: { nowMs: () => Number.NaN },
      graceMs: GRACE,
      intervalMs: INTERVAL,
      deadLetters: { outbox: t.outbox, deliver: () => undefined },
    });
    if (!made.ok) throw new Error("cfg");
    made.value.start();
    await timer.advance(0);
    expect(t.n.ack).toBe(0);
    expect(made.value.status().deadLetters).toMatchObject({ delivered: 1, acknowledged: 0, ackFailures: 1 });
    await made.value.stop();
  });

  it("زمان‌سنجِ همگام (مهلت را فوراً صدا می‌زند) ⇒ deliver پس از گذشتنِ مهلت صدا زده نمی‌شود", async () => {
    const base = manualTimer();
    const eager = {
      ...base,
      clock: base.clock,
      after(fn: () => void, ms: number): unknown {
        if (ms === 7_000) {
          fn(); // مهلت همگام می‌گذرد
          return 0;
        }
        return base.after(fn, ms);
      },
      cancel: (h: unknown) => base.cancel(h),
    };
    const real = createMemoryOutbox();
    await seedDead(real, ["a"]);
    const got: string[] = [];
    const made = createSweepLoop({
      sweeper: fakeSweeper(() => sweepReport()),
      timer: eager,
      clock: base.clock,
      graceMs: GRACE,
      intervalMs: INTERVAL,
      deadLetters: { outbox: real, deliver: (l: DeadLetter) => void got.push(l.reservationId), deliverTimeoutMs: 7_000 },
    });
    if (!made.ok) throw new Error("cfg");
    made.value.start();
    await base.advance(0);
    expect(got).toEqual([]);
    expect(made.value.status().deadLetters.deliverFailures).toBe(1);
    expect(await unacked(real)).toEqual(["a"]);
    await made.value.stop();
  });

  it("تایمرِ مهلت پس از پایانِ هر deliver لغو می‌شود: بیکار فقط تایمرِ گذرِ بعد معلق است", async () => {
    const x = await mk({ ids: ["a", "b", "c"] });
    x.loop.start();
    await x.timer.advance(0);
    expect(await unacked(x.real)).toEqual([]);
    expect(x.timer.pending()).toBe(1);
    expect(x.timer.cancelled).toBeGreaterThanOrEqual(3);
    await x.loop.stop();
  });

  it("رکوردی که تأییدش شکست می‌خورد در همان گذر دوباره تحویل نمی‌شود (یک تلاش در هر گذر) و رکوردهای پشتِ آن می‌رسند", async () => {
    const x = await mk({ ids: ["a", "b"], dead: { batchLimit: 1 }, hooks: { ack: (_n, ref) => (ref.reservationId === "a" ? dbad : undefined) } });
    x.loop.start();
    await x.timer.advance(0);
    expect(x.log.filter((l) => l === "deliver:a")).toHaveLength(1);
    expect(x.log.filter((l) => l === "deliver:b")).toHaveLength(1);
    expect(await unacked(x.real)).toEqual(["a"]);
    expect(x.loop.status().deadLetters).toMatchObject({ acknowledged: 1, ackFailures: 1 });
    await x.loop.stop();
  });

  it("stop در میانِ دسته‌ها: پس از ایستادن فهرستِ تازه‌ای خوانده نمی‌شود", async () => {
    let ref: SweepLoop | null = null;
    const x = await mk({
      ids: ["a", "b", "c"],
      dead: { batchLimit: 1 },
      deliver: (l) => {
        if (l.reservationId === "a") void ref?.stop();
      },
    });
    ref = x.loop;
    x.loop.start();
    await x.timer.advance(0);
    expect(x.n.list).toBe(1);
    expect(await unacked(x.real)).toEqual(["b", "c"]);
  });

  it("پیش‌فرض‌ها: ۵۰ رکورد در دسته و ۵ دسته در گذر ⇒ ۳۰۰ مرده در دو گذرِ پیاپی تخلیه می‌شود", async () => {
    const ids = Array.from({ length: 300 }, (_x, i) => `r${String(i).padStart(3, "0")}`);
    const x = await mk({ ids });
    x.loop.start();
    await x.timer.advance(0);
    expect(x.loop.status().runs).toBe(2);
    expect(x.loop.status().deadLetters.acknowledged).toBe(300);
    expect(x.log.filter((l) => l.startsWith("list(")).slice(0, 2)).toEqual(["list(50)", "list(50)"]);
    await x.loop.stop();
  });
});
