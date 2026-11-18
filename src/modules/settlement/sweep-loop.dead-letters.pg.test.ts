/**
 * زنگِ ماندگارِ مرده‌ها روی PostgreSQL واقعی (ADR-0026، م۳‑د‑۲). «فرایند» = نمونهٔ outbox روی استخرِ اتصالِ جدا؛ «مرگ» = بستنِ استخر.
 * ثابت می‌کند: (۱) مرگِ فرایند میانِ `bury` و زنگ — رکوردِ dead در پایگاه می‌ماند و فرایندِ تازه با `start` آن را می‌رساند و تأییدش ماندگار است؛
 * (۲) مرگِ فرایند میانِ تحویل و تأیید ⇒ دوباره می‌رسد (دست‌کم‌یک‌بار) و پس از تأیید هرگز؛ (۳) دو حلقهٔ هم‌زمان (دو فرایند): هر مرده دست‌کم یک‌بار
 * می‌رسد و دقیقاً یک ردیفِ تأیید دارد؛ (۴) قطعِ پایگاه حلقه را نمی‌کشد و پس از وصلِ دوباره جبران می‌شود.
 * زمان مجازی است ولی I/O واقعی؛ پس پیشروی پس از هر گام منتظرِ پایانِ واقعیِ گذر می‌ماند.
 */
import { afterEach, expect, it } from "vitest";
import { createSweepLoop } from "./index";
import type { DeadLetter, LoopFault, SettlementOutbox, SweepLoop } from "./index";
import { beginOf, refOf } from "./outbox-contract";
import { fakeSweeper, manualTimer, sweepReport } from "./test-kit";
import type { ManualTimer } from "./test-kit";
import { dbDescribe, openPgOutbox } from "./pg/test-db";
import type { TestOutbox } from "./pg/test-db";

const GRACE = 20_000;
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
const must = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!r.ok) throw new Error(`انتظار موفقیت بود: ${r.error.code}`);
  return r.value;
};

async function until(cond: () => Promise<boolean> | boolean, what: string): Promise<void> {
  for (let i = 0; i < 2500; i++) {
    if (await cond()) return;
    await sleep(2);
  }
  throw new Error(`انتظار برای «${what}» به پایان رسید`);
}

dbDescribe("settlement · زنگِ ماندگارِ مرده‌ها روی PostgreSQL", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  async function world() {
    const t = await openPgOutbox(4);
    cleanups.push(t.dispose);
    return { t, timer: manualTimer() };
  }

  async function process_(t: TestOutbox) {
    const h = await t.reopen();
    cleanups.push(h.close);
    return { outbox: h.outbox as SettlementOutbox, kill: h.close };
  }

  function loopOf(outbox: SettlementOutbox, timer: ManualTimer, deliver: (l: DeadLetter) => unknown, dead: Record<string, unknown> = {}) {
    const faults: LoopFault[] = [];
    const made = createSweepLoop({
      sweeper: fakeSweeper(() => sweepReport()),
      timer,
      clock: timer.clock,
      graceMs: GRACE,
      intervalMs: 1000,
      observer: { onFault: (f: LoopFault) => void faults.push(f) },
      deadLetters: { outbox, deliver, ...dead },
    });
    if (!made.ok) throw new Error(made.error.issues.join(";"));
    return { loop: made.value as SweepLoop, faults };
  }

  async function bury(o: SettlementOutbox, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      must(await o.begin(beginOf({ reservationId: id })));
      must(await o.bury(refOf(id), { reason: "EXPIRED_UNBILLED", errorCode: "RESERVATION_EXPIRED", atMs: 5_000 }));
    }
  }

  async function drive(timer: ManualTimer, loops: readonly SweepLoop[], cond: () => Promise<boolean>, what: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      await timer.advance(1000);
      await until(() => loops.every((l) => !l.status().busy), "پایانِ گذر");
      if (await cond()) return;
    }
    throw new Error(`drive: «${what}» برقرار نشد`);
  }

  const unacked = async (o: SettlementOutbox): Promise<string[]> => must(await o.listUnacknowledgedDead({ limit: 1000 })).map((e) => e.reservationId).sort();
  const ackRows = async (t: TestOutbox): Promise<number> => Number((await t.raw("SELECT count(*)::int AS n FROM {{s}}.settlement_dead_ack"))[0]?.["n"]);

  it("مرگِ فرایند میانِ دفن و زنگ: فرایندِ تازه با start مرده را می‌رساند؛ تأیید ماندگار است و پس از ریستارتِ بعدی دوباره نمی‌آید", async () => {
    const w = await world();
    const a = await process_(w.t);
    await bury(a.outbox, ["d1", "d2"]);
    await a.kill(); // فرایندِ نخست پیش از هر زنگ می‌میرد

    const b = await process_(w.t);
    const got: string[] = [];
    const x = loopOf(b.outbox, w.timer, (l) => void got.push(l.reservationId));
    expect(x.loop.start()).toEqual({ started: true });
    await drive(w.timer, [x.loop], async () => (await unacked(b.outbox)).length === 0, "تأییدِ هر دو");
    expect(got.sort()).toEqual(["d1", "d2"]);
    expect(await ackRows(w.t)).toBe(2);
    await x.loop.stop();
    await b.kill();

    const c = await process_(w.t);
    const again: string[] = [];
    const y = loopOf(c.outbox, w.timer, (l) => void again.push(l.reservationId));
    y.loop.start();
    for (let i = 0; i < 4; i++) {
      await w.timer.advance(1000);
      await until(() => !y.loop.status().busy, "پایانِ گذر");
    }
    expect(again).toEqual([]);
    expect(await ackRows(w.t)).toBe(2);
    expect(y.loop.status().deadLetters).toMatchObject({ delivered: 0, acknowledged: 0, listFailures: 0 });
    await y.loop.stop();
  });

  it("مرگِ فرایند میانِ تحویل و تأیید (استخر وسطِ deliver بسته می‌شود) ⇒ تأیید ثبت نمی‌شود، DEAD_ACK_FAILED یا خطای فهرست؛ فرایندِ تازه دوباره می‌رساند", async () => {
    const w = await world();
    const a = await process_(w.t);
    await bury(a.outbox, ["m1"]);
    const delivered1: string[] = [];
    const x = loopOf(a.outbox, w.timer, async (l) => {
      delivered1.push(l.reservationId);
      await a.kill(); // مرگ پس از رسیدنِ زنگ، پیش از تأیید
    });
    x.loop.start();
    await w.timer.advance(0);
    await until(() => !x.loop.status().busy, "پایانِ گذر");
    expect(delivered1).toEqual(["m1"]);
    expect(x.faults.map((f) => f.kind)).toEqual(["DEAD_ACK_FAILED"]);
    expect(await ackRows(w.t)).toBe(0);
    await x.loop.stop();

    const b = await process_(w.t);
    const delivered2: string[] = [];
    const y = loopOf(b.outbox, w.timer, (l) => void delivered2.push(l.reservationId));
    y.loop.start();
    await drive(w.timer, [y.loop], async () => (await unacked(b.outbox)).length === 0, "تأیید پس از ریستارت");
    expect(delivered2).toEqual(["m1"]); // دست‌کم‌یک‌بار: یک بار دیگر
    expect(await ackRows(w.t)).toBe(1);
    await y.loop.stop();
  });

  it("دو حلقهٔ زندهٔ هم‌زمان (دو فرایند) روی یک outbox: ۲۵ مرده، هر کدام دست‌کم یک‌بار می‌رسد و دقیقاً یک ردیفِ تأیید دارد", async () => {
    const w = await world();
    const a = await process_(w.t);
    const b = await process_(w.t);
    const ids = Array.from({ length: 25 }, (_x, i) => `c${String(i).padStart(2, "0")}`);
    await bury(a.outbox, ids);
    const seen = new Map<string, number>();
    const note = (l: DeadLetter) => void seen.set(l.reservationId, (seen.get(l.reservationId) ?? 0) + 1);
    const la = loopOf(a.outbox, w.timer, note, { batchLimit: 4 });
    const lb = loopOf(b.outbox, w.timer, note, { batchLimit: 5 });
    la.loop.start();
    lb.loop.start();
    await drive(w.timer, [la.loop, lb.loop], async () => (await unacked(a.outbox)).length === 0, "تأییدِ همه");
    for (const id of ids) expect(seen.get(id) ?? 0, `مردهٔ ${id}`).toBeGreaterThanOrEqual(1);
    expect(await ackRows(w.t)).toBe(25);
    expect(la.faults.concat(lb.faults).filter((f) => f.kind !== "DEAD_ACK_FAILED")).toEqual([]);
    const s = [la.loop.status().deadLetters, lb.loop.status().deadLetters];
    expect(s[0]!.acknowledged + s[1]!.acknowledged).toBeGreaterThanOrEqual(25); // تأییدِ تکراری replayed است، نه خطا
    await la.loop.stop();
    await lb.loop.stop();
  });

  it("قطعِ پایگاه (استخر بسته) حلقه را نمی‌کشد: DEAD_LIST_FAILED با عقب‌نشینی و بدونِ نشتِ پیامِ پایگاه؛ فرایندِ تازه جبران می‌کند", async () => {
    const w = await world();
    const a = await process_(w.t);
    await bury(a.outbox, ["q1"]);
    await a.kill();
    const got: string[] = [];
    const x = loopOf(a.outbox, w.timer, (l) => void got.push(l.reservationId));
    x.loop.start();
    for (let i = 0; i < 6; i++) {
      await w.timer.advance(2000);
      await until(() => !x.loop.status().busy, "پایانِ گذر");
    }
    const st = x.loop.status();
    expect(st.state).toBe("running");
    expect(st.deadLetters.listFailures).toBeGreaterThan(0);
    expect(got).toEqual([]);
    expect(JSON.stringify([st, x.faults])).not.toMatch(/postgres|connection|ECONN|password|Cannot use a pool/i);
    expect(x.faults.every((f) => f.kind === "DEAD_LIST_FAILED")).toBe(true);
    await x.loop.stop();

    const b = await process_(w.t);
    const y = loopOf(b.outbox, w.timer, (l) => void got.push(l.reservationId));
    y.loop.start();
    await drive(w.timer, [y.loop], async () => (await unacked(b.outbox)).length === 0, "جبران");
    expect(got).toEqual(["q1"]);
    await y.loop.stop();
  });
});
