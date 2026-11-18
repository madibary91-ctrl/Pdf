/**
 * آزمون تفاضلی (ADR-0022): همان دنبالهٔ تصادفی از عملیات (شامل ورودی نامعتبر، تکرار، تعارض و رکوردهای نهایی) هم‌زمان روی outbox حافظه‌ای (مرجعِ معنایی) و
 * PostgreSQL اجرا می‌شود؛ **هر** نتیجه (ok/خطا/پیام) و پس از هر گام وضعیتِ کلی (counts، listDue، listDead، get همهٔ رکوردها) باید با هم برابر باشد.
 * این آزمون جدا از قراردادِ پورت است: قرارداد «چه باید باشد» را مثال‌به‌مثال می‌گوید؛ این‌جا هزاران ترکیبِ پیش‌بینی‌نشده را می‌سنجد.
 * بذرها ثابت‌اند (بازتولیدپذیر)؛ شناسه‌ها عمداً حرف بزرگ/کوچک و نقطه/خط‌تیره دارند تا ترتیبِ COLLATE "C" سنجیده شود.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createMemoryOutbox } from "../memory-outbox";
import type { SettlementOutbox } from "../types";
import { dbDescribe, openPgOutbox, type TestOutbox } from "./test-db";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TENANTS = ["t1", "T1"];
const ACCOUNTS = ["a1", "a.1"];
const RES = ["r1", "R1", "r.1", "r-1", "r_1", "r:1"];
const ALL_REFS = TENANTS.flatMap((tenantId) => ACCOUNTS.flatMap((accountId) => RES.map((reservationId) => ({ tenantId, accountId, reservationId }))));

type Op = Readonly<{ name: keyof SettlementOutbox; args: unknown[] }>;

function genOp(r: () => number): Op {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const ref = () => (r() < 0.04 ? pick([{ tenantId: "bad id", accountId: "a1", reservationId: "r1" }, null, { tenantId: "t1" }]) : pick(ALL_REFS));
  const w = r();
  if (w < 0.18) {
    const b = { ...pick(ALL_REFS), unit: pick(["IRR_MICROS", "IRR_MICROS", "USD_MICROS"]), reserved: pick([1, 500, 500, 501]), createdAtMs: pick([0, 1_000]), expiresAtMs: pick([61_000, 61_000, 62_000]), dueAtMs: pick([0, 5, 10, 10, 20, 30]), orphanRemainder: pick(["forfeit", "release"] as const) };
    return { name: "begin", args: [r() < 0.05 ? { ...b, reserved: 0 } : b] };
  }
  if (w < 0.3) return { name: "recordCharge", args: [ref(), r() < 0.05 ? { attemptId: "", amount: 1 } : { attemptId: pick(["a1", "a1", "a2"]), amount: pick([0, 5, 5, 9]) }] };
  if (w < 0.4) return { name: "recordClose", args: [ref(), r() < 0.05 ? { remainder: "x", origin: "caller" } : { remainder: pick(["release", "forfeit"]), origin: pick(["caller", "sweeper"]) }] };
  if (w < 0.5) return { name: "resolveClose", args: [ref()] };
  if (w < 0.66) return { name: "finish", args: [ref(), r() < 0.05 ? -1 : pick([0, 7, 40])] };
  if (w < 0.74) return { name: "recordFailure", args: [ref(), r() < 0.05 ? { errorCode: "bad", dueAtMs: 1 } : { errorCode: pick(["STORE_FAILURE", "INTERNAL_ERROR"]), dueAtMs: pick([5, 15, 25, 50]) }] };
  if (w < 0.8) return { name: "bury", args: [ref(), r() < 0.05 ? { reason: "NOPE", errorCode: null, atMs: 1 } : { reason: pick(["EXPIRED_UNBILLED", "ATTEMPTS_EXHAUSTED", "LEDGER_REJECTED"]), errorCode: pick([null, "STORE_FAILURE", "RESERVATION_EXPIRED"]), atMs: pick([1, 9, 30]) }] };
  if (w < 0.88) return { name: "get", args: [ref()] };
  if (w < 0.95) return { name: "listDue", args: [r() < 0.05 ? { nowMs: 5, limit: 0 } : { nowMs: pick([0, 10, 20, 100]), limit: pick([1, 2, 3, 50]) }] };
  return { name: "listDead", args: [{ limit: pick([1, 2, 50]) }] };
}

const call = (o: SettlementOutbox, op: Op): Promise<unknown> => (o[op.name] as (...a: unknown[]) => Promise<unknown>)(...op.args);

/** وضعیتِ کامل: counts + همهٔ رکوردهای ممکن + صفحهٔ کاملِ listDue/listDead. */
async function snapshot(o: SettlementOutbox): Promise<unknown> {
  return {
    counts: await o.counts(),
    due: await o.listDue({ nowMs: 1_000_000, limit: 1000 }),
    dead: await o.listDead({ limit: 1000 }),
    all: await Promise.all(ALL_REFS.map((r) => o.get(r))),
  };
}

dbDescribe("settlement/pg · آزمون تفاضلی (حافظه‌ای ⇄ PostgreSQL)", () => {
  const SEEDS = 24;
  const STEPS = 90;
  const opened: TestOutbox[] = [];
  afterAll(async () => {
    for (const t of opened) await t.dispose();
  });

  it.each(Array.from({ length: SEEDS }, (_, i) => i + 1))(`بذر %i: ${STEPS} عملیاتِ تصادفی، نتیجه و وضعیتِ هر گام یکسان`, async (seed) => {
    const t = await openPgOutbox(4);
    opened.push(t);
    const mem = createMemoryOutbox();
    const r = rng(seed * 7919);
    const seen = new Set<string>();
    for (let step = 0; step < STEPS; step++) {
      const op = genOp(r);
      const a = await call(mem, op);
      const b = await call(t.outbox, op);
      expect(b, `بذر ${seed} گام ${step}: ${op.name}(${JSON.stringify(op.args)})`).toEqual(a);
      const res = a as { ok: boolean; error?: { code: string } };
      seen.add(`${op.name}:${res.ok ? "ok" : res.error?.code}`);
      if (step % 10 === 9) expect(await snapshot(t.outbox), `بذر ${seed} پس از گام ${step}`).toEqual(await snapshot(mem));
    }
    expect(await snapshot(t.outbox)).toEqual(await snapshot(mem));
    expect(seen.size).toBeGreaterThan(8);
  });

  it("پوششِ مولد: در مجموعِ بذرها همهٔ متدها و کدهای خطای اصلی دیده می‌شوند (تا مولد ضعیف نشود)", async () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = rng(seed * 7919);
      const mem = createMemoryOutbox();
      for (let step = 0; step < STEPS; step++) {
        const op = genOp(r);
        const res = (await call(mem, op)) as { ok: boolean; error?: { code: string } };
        seen.add(`${op.name}:${res.ok ? "ok" : res.error?.code}`);
      }
    }
    for (const need of [
      "begin:ok", "begin:CONFLICT", "begin:INVALID_INPUT",
      "recordCharge:ok", "recordCharge:CONFLICT", "recordCharge:NOT_ACTIVE", "recordCharge:NOT_FOUND", "recordCharge:INVALID_INPUT",
      "recordClose:ok", "recordClose:CONFLICT", "recordClose:NOT_ACTIVE",
      "resolveClose:ok", "resolveClose:NOT_ACTIVE", "resolveClose:NOT_FOUND",
      "finish:ok", "finish:CONFLICT", "finish:NOT_ACTIVE", "finish:NOT_FOUND",
      "recordFailure:ok", "recordFailure:NOT_ACTIVE",
      "bury:ok", "bury:CONFLICT", "bury:NOT_ACTIVE",
      "get:ok", "listDue:ok", "listDead:ok",
    ]) expect(seen.has(need), `پوشش: ${need}`).toBe(true);
  });
});
