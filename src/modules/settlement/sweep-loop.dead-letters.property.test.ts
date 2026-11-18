/**
 * زنگِ ماندگار · آزمونِ خاصیتی (ADR-0026): ۳۰ بذرِ تصادفی با خرابیِ هم‌زمانِ فهرست، تحویل (پرتاب/ردّ/آویزان)، تأیید و ریستارتِ حلقه.
 * ناوردا: (۱) تأیید **هرگز** پیش از موفقیتِ تحویلِ همان رکورد نیست؛ (۲) هر رکوردِ مرده در نهایت (پس از فروکش‌کردنِ خرابی) رسیده و تأیید شده؛
 * (۳) هر تأییدشده دستِ‌کم یک‌بار تحویل شده؛ (۴) پس از تأیید دیگر هرگز تحویل نمی‌شود؛ (۵) هیچ پیامِ خامی نمی‌چکد.
 * فایلِ تازه است.
 */
import { describe, expect, it } from "vitest";
import { createMemoryOutbox, createSweepLoop } from "./index";
import type { DeadLetter, LoopFault, SettlementOutbox, SweepLoop } from "./index";
import { beginOf, refOf } from "./outbox-contract";
import { fakeSweeper, manualTimer, sweepReport } from "./test-kit";
import type { ManualTimer } from "./test-kit";

const GRACE = 20_000;
const INTERVAL = 1000;
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
const dbad = { ok: false, error: { code: "STORE_FAILURE", message: CANARY } };

function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

describe("settlement · زنگِ ماندگار · خاصیتی (۳۰ بذر × خرابیِ تصادفی و ریستارت)", () => {
  for (let seed = 1; seed <= 30; seed++) {
    it(`بذر ${seed}: تأیید فقط پس از تحویلِ موفق؛ پس از فروکشِ خرابی همه رسیده و تأیید شده‌اند؛ تأییدشده دوباره نمی‌آید`, async () => {
      const rnd = prng(seed * 7919);
      const real = createMemoryOutbox();
      const timer = manualTimer();
      let chaos = true;
      const state = new Map<string, "ok" | "fail" | "pending">();
      const deliveries = new Map<string, number>();
      const ackedAt = new Map<string, number>(); // id ← شمارِ تحویل‌ها در لحظهٔ تأیید
      const violations: string[] = [];
      const seeded: string[] = [];
      let nextId = 0;

      const instance = (): Promise<Rig> =>
        mk({
          real,
          timer,
          dead: { batchLimit: 1 + Math.floor(rnd() * 4), maxBatchesPerRun: 1 + Math.floor(rnd() * 3), deliverTimeoutMs: 500 },
          deliver: (l) => {
            const id = l.reservationId;
            if (ackedAt.has(id)) violations.push(`تحویلِ پس از تأیید: ${id}`);
            deliveries.set(id, (deliveries.get(id) ?? 0) + 1);
            state.set(id, "pending");
            const r = chaos ? rnd() : 1;
            if (r < 0.15) {
              state.set(id, "fail");
              throw new Error(CANARY);
            }
            if (r < 0.3) {
              state.set(id, "fail");
              return Promise.reject(new Error(CANARY));
            }
            if (r < 0.4) return new Promise(() => undefined); // آویزان؛ مهلت می‌گیرد
            return Promise.resolve().then(() => void state.set(id, "ok"));
          },
          hooks: {
            list: () => (chaos && rnd() < 0.12 ? dbad : undefined),
            ack: (_n, ref) => {
              if (state.get(ref.reservationId) !== "ok") violations.push(`تأیید پیش از تحویلِ موفق: ${ref.reservationId}`);
              if (chaos && rnd() < 0.2) return dbad;
              ackedAt.set(ref.reservationId, deliveries.get(ref.reservationId) ?? 0);
              return undefined;
            },
          },
        });

      let cur = await instance();
      cur.loop.start();
      for (let step = 0; step < 60; step++) {
        if (rnd() < 0.45) {
          const id = `r${String(nextId++).padStart(3, "0")}`;
          await seedDead(real, [id]);
          seeded.push(id);
        }
        if (rnd() < 0.08) {
          void cur.loop.stop(); // «مرگ»
          cur = await instance();
          cur.loop.start();
        }
        await timer.advance(Math.floor(rnd() * 3000));
        expect(cur.faults.length).toBe(cur.loop.status().totals.faults);
      }
      chaos = false;
      void cur.loop.stop();
      cur = await instance();
      cur.loop.start();
      await timer.advance(60_000);

      expect(violations).toEqual([]);
      expect(await unacked(real)).toEqual([]);
      for (const id of seeded) expect(deliveries.get(id) ?? 0, `رکورد ${id} هرگز نرسید`).toBeGreaterThanOrEqual(1);
      for (const [id, n] of ackedAt) expect(n, `تأییدِ ${id} بی‌تحویل`).toBeGreaterThanOrEqual(1);
      expect(ackedAt.size).toBe(seeded.length);
      expect(JSON.stringify([cur.faults, cur.loop.status()])).not.toContain(CANARY);
      await cur.loop.stop();
    });
  }
});
