/**
 * تأیید رسیدگی به مرده‌ها روی PostgreSQL واقعی (ADR-0025):
 *  ۱) همان قراردادِ مشترکِ outbox حافظه‌ای، بی‌تغییر؛
 *  ۲) ناورداهای خودِ پایگاه حتی وقتی کسی از کنار آداپتور بنویسد (TRIGGER، دامنه، کلید)؛
 *  ۳) ماندگاری: تأیید از ریستارتِ فرایند جان به در می‌برد، و «فهرست‌کردنِ بی‌تأیید» (مرگ پیش از رسیدنِ زنگ) چیزی را گم نمی‌کند؛
 *  ۴) مسیرِ ارتقا: پایگاهِ 0001 با رکوردهای مردهٔ پیشین ⇒ سپرِ مهاجرت، سپس 0002، و مرده‌های قدیمی «تأییدنشده» می‌شوند؛
 *  ۵) آزمون تفاضلی: همان دنبالهٔ تصادفی روی حافظه‌ای و PostgreSQL نتایج و وضعیتِ یکسان بدهد.
 */
import { afterAll, describe, expect, it } from "vitest";
import { describeDeadAckContract } from "../contract/dead-ack-contract";
import { createMemoryOutbox } from "../memory-outbox";
import type { OutboxResult, ReservationRef, SettlementOutbox } from "../types";
import { MIGRATIONS, migrationChecksum, renderStatement } from "./migrations";
import { dbDescribe, newSchemaName, openPgOutbox, type TestOutbox } from "./test-db";

dbDescribe("settlement/pg · تأیید رسیدگی", () => {
  describeDeadAckContract("postgres", async () => {
    const t = await openPgOutbox(6);
    return { outbox: t.outbox, dispose: t.dispose };
  });
});

const must = <T>(r: OutboxResult<T>): T => {
  if (!r.ok) throw new Error(`انتظار موفقیت بود: ${r.error.code}`);
  return r.value;
};
const BEGIN = { unit: "IRR_MICROS", reserved: 500, createdAtMs: 1_000, expiresAtMs: 61_000, dueAtMs: 11_000, orphanRemainder: "forfeit" as const };
const ref = (reservationId: string, o: Partial<ReservationRef> = {}): ReservationRef => ({ tenantId: "t1", accountId: "a1", reservationId, ...o });

async function makeDead(o: SettlementOutbox, id: string, atMs = 20_000): Promise<ReservationRef> {
  const r = ref(id);
  must(await o.begin({ ...r, ...BEGIN }));
  must(await o.bury(r, { reason: "LEDGER_REJECTED", errorCode: null, atMs }));
  return r;
}
/** کدِ SQLSTATE خطای دستورِ خام (یا null اگر موفق). */
async function state(t: TestOutbox, statement: string, params: readonly unknown[] = []): Promise<string | null> {
  try {
    await t.raw(statement, params);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "unknown";
  }
}
const ACK = "INSERT INTO {{s}}.settlement_dead_ack (tenant_id, account_id, reservation_id, acked_at_ms) VALUES ($1, $2, $3, $4)";

dbDescribe("settlement/pg · تأیید رسیدگی · ناورداهای خودِ پایگاه", () => {
  const opened: TestOutbox[] = [];
  afterAll(async () => {
    for (const t of opened) await t.dispose();
  });
  const fresh = async (): Promise<TestOutbox> => {
    const t = await openPgOutbox(4);
    opened.push(t);
    return t;
  };

  it("درجِ مستقیمِ تأیید فقط برای رکوردِ موجودِ dead پذیرفته است؛ نبودن، open، settling و done رد می‌شوند (۲۳۰۰۰)", async () => {
    const t = await fresh();
    const o = t.outbox;
    must(await o.begin({ ...ref("r-open"), ...BEGIN }));
    must(await o.begin({ ...ref("r-settling"), ...BEGIN }));
    must(await o.recordCharge(ref("r-settling"), { attemptId: "a1", amount: 3 }));
    must(await o.begin({ ...ref("r-done"), ...BEGIN }));
    must(await o.recordClose(ref("r-done"), { remainder: "release", origin: "caller" }));
    must(await o.finish(ref("r-done"), 9));
    await makeDead(o, "r-dead");
    for (const id of ["r-ghost", "r-open", "r-settling", "r-done"]) expect(await state(t, ACK, ["t1", "a1", id, 5]), id).toBe("23000");
    // هویتِ سه‌بخشی: رکوردِ مرده فقط زیرِ (t1, a1) هست؛ هم‌نامِ آن زیرِ مستأجر/حسابِ دیگر وجود ندارد و تأییدش رد می‌شود
    expect(await state(t, ACK, ["t2", "a1", "r-dead", 5])).toBe("23000");
    expect(await state(t, ACK, ["t1", "a2", "r-dead", 5])).toBe("23000");
    expect(await state(t, ACK, ["t1", "a1", "r-dead", 5])).toBeNull();
    expect(await t.raw("SELECT reservation_id FROM {{s}}.settlement_dead_ack")).toEqual([{ reservation_id: "r-dead" }]);
  });

  it("ردیفِ تأیید نوشتن‌یک‌بار است: تکرار ⇒ تکراریِ کلید (۲۳۵۰۵)، UPDATE/DELETE/TRUNCATE ⇒ ۲۳۰۰۰ و ردیف همان می‌ماند", async () => {
    const t = await fresh();
    await makeDead(t.outbox, "r1");
    expect(await state(t, ACK, ["t1", "a1", "r1", 5])).toBeNull();
    expect(await state(t, ACK, ["t1", "a1", "r1", 6])).toBe("23505");
    expect(await state(t, "UPDATE {{s}}.settlement_dead_ack SET acked_at_ms = 99")).toBe("23000");
    expect(await state(t, "DELETE FROM {{s}}.settlement_dead_ack")).toBe("23000");
    expect(await state(t, "TRUNCATE {{s}}.settlement_dead_ack")).toBe("23000");
    expect(await t.raw("SELECT acked_at_ms FROM {{s}}.settlement_dead_ack")).toEqual([{ acked_at_ms: "5" }]);
  });

  it("دامنه‌ها: زمانِ منفی یا فراتر از صحیحِ ایمن و شناسهٔ نامعتبر رد می‌شود (۲۳۵۱۴)", async () => {
    const t = await fresh();
    await makeDead(t.outbox, "r1");
    expect(await state(t, ACK, ["t1", "a1", "r1", -1])).toBe("23514");
    expect(await state(t, ACK, ["t1", "a1", "r1", "9007199254740992"])).toBe("23514");
    expect(await state(t, ACK, ["t1", "a1", "bad id", 1])).toBe("23514");
    expect(await t.raw("SELECT 1 FROM {{s}}.settlement_dead_ack")).toHaveLength(0);
  });

  it("رکوردِ outbox پس از تأیید همچنان نهایی و حذف‌ناپذیر است (ناورداهای 0001 دست‌نخورده)", async () => {
    const t = await fresh();
    await makeDead(t.outbox, "r1");
    must(await t.outbox.acknowledgeDead(ref("r1"), { atMs: 7 }));
    expect(await state(t, "UPDATE {{s}}.settlement_outbox SET attempts = attempts + 1")).toBe("23000");
    expect(await state(t, "DELETE FROM {{s}}.settlement_outbox")).toBe("23000");
    expect(await state(t, "TRUNCATE {{s}}.settlement_outbox")).toBe("23000");
  });

  it("زمانِ تأیید همان است که فراخواننده داد و تکرار با زمانِ دیگر آن را عوض نمی‌کند (اولین تأیید برنده است)", async () => {
    const t = await fresh();
    await makeDead(t.outbox, "r1");
    must(await t.outbox.acknowledgeDead(ref("r1"), { atMs: 111 }));
    must(await t.outbox.acknowledgeDead(ref("r1"), { atMs: 222 }));
    expect(await t.raw("SELECT acked_at_ms FROM {{s}}.settlement_dead_ack")).toEqual([{ acked_at_ms: "111" }]);
  });

  it("اتصال‌های جدا (۲ استخر) هم‌زمان تأیید می‌کنند: دقیقاً یک ردیف و یک «تازه»", async () => {
    const t = await fresh();
    await makeDead(t.outbox, "r1");
    const other = await t.reopen();
    try {
      const rs = await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? t.outbox : other.outbox).acknowledgeDead(ref("r1"), { atMs: i })));
      expect(rs.every((r) => r.ok)).toBe(true);
      expect(rs.filter((r) => r.ok && !r.value.replayed)).toHaveLength(1);
      expect(await t.raw("SELECT count(*)::int AS n FROM {{s}}.settlement_dead_ack")).toEqual([{ n: 1 }]);
    } finally {
      await other.close();
    }
  });
});

dbDescribe("settlement/pg · تأیید رسیدگی · ماندگاری و ریستارتِ فرایند", () => {
  it("تأیید پس از مرگِ فرایند می‌ماند؛ فهرست‌کردنِ بی‌تأیید پیش از مرگ، رکورد را در فرایندِ تازه همچنان تأییدنشده نشان می‌دهد", async () => {
    const t = await openPgOutbox(4);
    try {
      await makeDead(t.outbox, "r1", 10);
      await makeDead(t.outbox, "r2", 20);
      await makeDead(t.outbox, "r3", 30);
      // فرایندِ ۱: فهرست می‌کند، r1 را تأیید می‌کند و پیش از رسیدنِ زنگِ r2 و r3 می‌میرد.
      expect(must(await t.outbox.listUnacknowledgedDead({ limit: 10 })).map((e) => e.reservationId)).toEqual(["r1", "r2", "r3"]);
      must(await t.outbox.acknowledgeDead(ref("r1"), { atMs: 99 }));
      await t.kill();
      // فرایندِ ۲ (استخرِ تازه): r1 برنمی‌گردد، r2 و r3 هنوز برای زنگ می‌مانند.
      const again = await t.reopen();
      try {
        expect(must(await again.outbox.listUnacknowledgedDead({ limit: 10 })).map((e) => e.reservationId)).toEqual(["r2", "r3"]);
        expect(must(await again.outbox.listDead({ limit: 10 })).map((e) => e.reservationId)).toEqual(["r1", "r2", "r3"]);
        expect(await again.outbox.acknowledgeDead(ref("r1"), { atMs: 1 })).toEqual({ ok: true, value: { replayed: true } });
      } finally {
        await again.close();
      }
    } finally {
      await t.dispose();
    }
  });

  it("خطای اتصال پس از commitِ تأیید (نتیجهٔ مبهم): تکرارِ فراخوان replayed است، نه CONFLICT و نه خطای دوم", async () => {
    const t = await openPgOutbox(4);
    try {
      await makeDead(t.outbox, "r1");
      expect(must(await t.outbox.acknowledgeDead(ref("r1"), { atMs: 5 }))).toEqual({ replayed: false });
      // فراخوانندهٔ بی‌خبر از commit دوباره صدا می‌زند
      expect(must(await t.outbox.acknowledgeDead(ref("r1"), { atMs: 6 }))).toEqual({ replayed: true });
      expect(must(await t.outbox.listUnacknowledgedDead({ limit: 5 }))).toEqual([]);
    } finally {
      await t.dispose();
    }
  });
});

dbDescribe("settlement/pg · تأیید رسیدگی · مسیر ارتقا از 0001 به 0002", () => {
  it("پایگاهِ فقط-0001: عملیات پیش از migrate با STORE_FAILURE رد؛ migrate فقط 0002 را اعمال می‌کند؛ مرده‌های قدیمی تأییدنشده‌اند و دادهٔ قدیم دست‌نخورده", async () => {
    const t = await openPgOutbox(4, newSchemaName(), false);
    try {
      // شبیه‌سازیِ نسخهٔ قدیم: فقط 0001 و دفتر مهاجرتش
      await t.raw("CREATE SCHEMA {{s}}");
      await t.raw("CREATE TABLE {{s}}.settlement_migration_ledger (name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), CONSTRAINT settlement_migration_ledger_pk PRIMARY KEY (name))");
      const first = MIGRATIONS[0] as (typeof MIGRATIONS)[number];
      for (const st of first.statements) await t.raw(renderStatement(st, t.schema));
      await t.raw("INSERT INTO {{s}}.settlement_migration_ledger (name, checksum) VALUES ($1, $2)", [first.name, migrationChecksum(first)]);
      // دادهٔ قدیم با SQL خام (نسخهٔ قدیم هنوز مفهومِ تأیید نداشت)
      const ins = (id: string, st: string, extra: string, vals: unknown[]) =>
        t.raw(`INSERT INTO {{s}}.settlement_outbox (tenant_id, account_id, reservation_id, unit, reserved, created_at_ms, expires_at_ms, due_at_ms, orphan_remainder, state ${extra.split("|")[0]}) VALUES ('t1', 'a1', '${id}', 'IRR_MICROS', 5, 1, 9, 5, 'forfeit', '${st}' ${extra.split("|")[1]})`, vals);
      await ins("old-dead", "dead", ", dead_reason, settled_at_ms|, 'EXPIRED_UNBILLED', 40", []);
      await ins("old-done", "done", ", close_remainder, close_origin, settled_at_ms|, 'release', 'caller', 41", []);
      await ins("old-open", "open", "|", []);

      expect(await t.outbox.status()).toEqual({ ok: true, value: { applied: ["0001_init"], pending: ["0002_dead_ack"] } });
      for (const r of [await t.outbox.listUnacknowledgedDead({ limit: 5 }), await t.outbox.acknowledgeDead(ref("old-dead"), { atMs: 1 }), await t.outbox.counts()]) {
        expect(r).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
      }

      expect(await t.outbox.migrate()).toEqual({ ok: true, value: { applied: ["0002_dead_ack"], alreadyApplied: ["0001_init"] } });
      expect(await t.outbox.migrate()).toEqual({ ok: true, value: { applied: [], alreadyApplied: ["0001_init", "0002_dead_ack"] } });

      expect(must(await t.outbox.counts())).toEqual({ open: 1, settling: 0, done: 1, dead: 1 });
      expect(must(await t.outbox.listUnacknowledgedDead({ limit: 5 })).map((e) => [e.reservationId, e.deadReason, e.settledAtMs])).toEqual([["old-dead", "EXPIRED_UNBILLED", 40]]);
      expect(await t.outbox.acknowledgeDead(ref("old-done"), { atMs: 50 })).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
      expect(await t.outbox.acknowledgeDead(ref("old-dead"), { atMs: 50 })).toEqual({ ok: true, value: { replayed: false } });
      expect(must(await t.outbox.listUnacknowledgedDead({ limit: 5 }))).toEqual([]);
      expect(must(await t.outbox.listDead({ limit: 5 })).map((e) => e.reservationId)).toEqual(["old-dead"]);
    } finally {
      await t.dispose();
    }
  });

  it("تأییدهای ثبت‌شده با دستکاریِ checksum ِ 0002 سپر را فعال می‌کند (MIGRATION_TAMPERED)", async () => {
    const t = await openPgOutbox(4);
    try {
      await t.raw("UPDATE {{s}}.settlement_migration_ledger SET checksum = $1 WHERE name = '0002_dead_ack'", ["0".repeat(64)]);
      expect(await t.outbox.listUnacknowledgedDead({ limit: 1 })).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
      expect(await t.outbox.status()).toMatchObject({ ok: false, error: { code: "MIGRATION_TAMPERED" } });
    } finally {
      await t.dispose();
    }
  });
});

// ───────────────────────── تفاضلی: حافظه‌ای (مرجعِ معنایی) ⇄ PostgreSQL ─────────────────────────
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
  const ref0 = () => (r() < 0.04 ? pick([{ tenantId: "bad id", accountId: "a1", reservationId: "r1" }, null, { tenantId: "t1" }]) : pick(ALL_REFS));
  const w = r();
  if (w < 0.2) return { name: "begin", args: [{ ...pick(ALL_REFS), unit: "IRR_MICROS", reserved: pick([1, 500]), createdAtMs: 0, expiresAtMs: 61_000, dueAtMs: pick([0, 10, 20]), orphanRemainder: pick(["forfeit", "release"] as const) }] };
  if (w < 0.28) return { name: "recordCharge", args: [ref0(), { attemptId: "a1", amount: pick([0, 5]) }] };
  if (w < 0.34) return { name: "recordClose", args: [ref0(), { remainder: pick(["release", "forfeit"]), origin: "caller" }] };
  if (w < 0.4) return { name: "finish", args: [ref0(), pick([0, 7, 40])] };
  if (w < 0.55) return { name: "bury", args: [ref0(), { reason: pick(["EXPIRED_UNBILLED", "ATTEMPTS_EXHAUSTED", "LEDGER_REJECTED"]), errorCode: pick([null, "STORE_FAILURE"]), atMs: pick([1, 9, 9, 30]) }] };
  if (w < 0.78) return { name: "acknowledgeDead", args: [ref0(), r() < 0.06 ? pick([null, { atMs: -1 }, {}]) : { atMs: pick([0, 5, 50]) }] };
  if (w < 0.9) return { name: "listUnacknowledgedDead", args: [r() < 0.05 ? { limit: 0 } : { limit: pick([1, 2, 3, 50]) }] };
  if (w < 0.95) return { name: "listDead", args: [{ limit: pick([1, 2, 50]) }] };
  return { name: "get", args: [ref0()] };
}
const call = (o: SettlementOutbox, op: Op): Promise<unknown> => (o[op.name] as (...a: unknown[]) => Promise<unknown>)(...op.args);
const norm = (v: unknown): string => JSON.stringify(v);
const SEEDS = Array.from({ length: 10 }, (_, i) => i + 1);

dbDescribe("settlement/pg · تأیید رسیدگی · تفاضلی (حافظه‌ای ⇄ PostgreSQL)", () => {
  it.each(SEEDS.map((s) => [s]))("بذر %i: ۱۸۰ عملیات؛ هر نتیجه و وضعیتِ کلی (فهرست‌های مرده/تأییدنشده، counts) یکسان", async (seed) => {
    const r = rng(seed * 104729);
    const mem = createMemoryOutbox();
    const t = await openPgOutbox(3);
    try {
      for (let i = 0; i < 180; i += 1) {
        const op = genOp(r);
        const [a, b] = [await call(mem, op), await call(t.outbox, op)];
        expect(norm(b), `بذر ${seed} گام ${i} ${op.name} ${norm(op.args)}`).toBe(norm(a));
        if (i % 6 === 0) {
          for (const read of [(o: SettlementOutbox) => o.listUnacknowledgedDead({ limit: 1000 }), (o: SettlementOutbox) => o.listDead({ limit: 1000 }), (o: SettlementOutbox) => o.counts()]) {
            expect(norm(await read(t.outbox)), `بذر ${seed} گام ${i} وضعیت`).toBe(norm(await read(mem)));
          }
        }
      }
    } finally {
      await t.dispose();
    }
  });
});
