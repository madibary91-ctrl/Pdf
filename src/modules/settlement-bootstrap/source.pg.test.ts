/**
 * settlement-bootstrap · منبعِ `SETTLEMENT_BACKLOG_SOURCE=pending` روی PostgreSQL واقعی (ADR-0051، م۳‑ه‑۴‑الف‑۲‑۴‑ب‑۲‑۳): از env تا پروبِ HTTP.
 * ثابت می‌کند: (۱) با نمایهٔ نصب‌شده، پایش همان تأییدنشده‌ها را می‌شمارد و تأیید آن را کم می‌کند؛ (۲) خواندن **واقعاً** از نمایه است
 * (با TRIGGER خاموش، outbox مرده می‌بیند و نمایه نه ⇒ پایش صفر می‌بیند؛ همان شکافی که فقط `verify` می‌گیرد)؛ (۳) نمایهٔ نصب‌نشده ⇒ **هرگز ok** و هرگز
 * بازگشتِ بی‌صدا به outbox (که ۲ مرده را می‌دید) و بوتِ رفتگر مختل نمی‌شود؛ (۴) برگشتِ رسمیِ نمایه در حینِ اجرا ⇒ degraded و با نصبِ دوباره بی‌ری‌استارت ok؛
 * (۵) لاگ فقط برای pending نشانهٔ منبع دارد. شِماهای یک‌بارمصرفِ `bs_*` (بدونِ دست‌زدن به `public`). فایلِ تازه؛ `backlog.pg.test.ts` دست‌نخورده.
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createPgSettlementOutbox } from "@/modules/settlement";
import type { SettlementOutbox } from "@/modules/settlement";
import { SETTLEMENT_BACKLOG_WATCH_ENV as E } from "@/modules/settlement-backlog-watch";
import { getSettlementHost } from "@/modules/settlement-host";
import { createPendingDeadIndex } from "@/modules/settlement-pending";
import { createPgSettlementRuntime } from "@/modules/settlement-runtime";
import { startSettlementBootstrap } from "./bootstrap";
import { BACKLOG_WATCH_STORE_KEY, probeHttpResponse } from "./http";
import { ON_ENV, collector, fakeSignals } from "./test-kit";
import type { BootstrapEvent, BootstrapOutcome } from "./types";

config({ quiet: true });
const DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const dbDescribe = typeof DB_URL === "string" && DB_URL !== "" ? describe : describe.skip;
const IDLE_MS = 50;
const GRACE = 60_000;
const PENDING = { SETTLEMENT_BACKLOG_WATCH: "on", SETTLEMENT_BACKLOG_SOURCE: "pending", [E.intervalMs]: "40", [E.timeoutMs]: "2000", [E.degradedCount]: "1", [E.downCount]: "2" } as const;

type Body = { ok: boolean; state: string; backlog?: { status: string; count: number | null; policy: string; reasons: string[] } };
type Ready = { status: number; body: Body };

dbDescribe("settlement-bootstrap · SETTLEMENT_BACKLOG_SOURCE=pending · PostgreSQL", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  async function rig(opts: { index: boolean; dead: number; acked?: number }) {
    const tag = randomBytes(5).toString("hex");
    const ledgerSchema = `bs_ledger_${tag}`;
    const settlementSchema = `bs_settle_${tag}`;
    const pool = new Pool({ connectionString: DB_URL, max: 4, idleTimeoutMillis: IDLE_MS });
    const db = drizzle(pool);
    cleanups.push(async () => {
      const p = new Pool({ connectionString: DB_URL, max: 1, idleTimeoutMillis: IDLE_MS });
      try {
        await p.query(`DROP SCHEMA IF EXISTS "${ledgerSchema}" CASCADE`);
        await p.query(`DROP SCHEMA IF EXISTS "${settlementSchema}" CASCADE`);
      } finally {
        await p.end();
      }
      if (!pool.ended) await pool.end();
    });
    const pgOutbox = createPgSettlementOutbox(db, { schema: settlementSchema });
    if (!pgOutbox.ok) throw new Error("outbox");
    const outbox: SettlementOutbox = pgOutbox.value;
    const rt = createPgSettlementRuntime({ db, ledgerSchema, settlementSchema, graceMs: GRACE, deadLetters: false });
    if (!rt.ok) throw new Error(rt.error.issues.join(";"));
    const m = await rt.value.migrate();
    if (!m.ok) throw new Error(`migrate: ${m.code}`);
    const index = createPendingDeadIndex(db, { schema: settlementSchema });
    if (!index.ok) throw new Error("index");
    if (opts.index) {
      const up = await index.value.migrate();
      if (!up.ok) throw new Error(`index.migrate: ${up.error.code}`);
    }
    const ref = (n: number) => ({ tenantId: "t1", accountId: "a1", reservationId: `r${n}` });
    const bury = async (n: number): Promise<void> => {
      const b = await outbox.begin({ ...ref(n), unit: "IRR_MICROS", reserved: 500, createdAtMs: 1_000, expiresAtMs: 61_000, dueAtMs: 11_000, orphanRemainder: "forfeit" });
      if (!b.ok) throw new Error(`begin: ${b.error.code}`);
      const d = await outbox.bury(ref(n), { reason: "ATTEMPTS_EXHAUSTED", errorCode: null, atMs: Date.now() - 1_000 });
      if (!d.ok) throw new Error(`bury: ${d.error.code}`);
    };
    for (let n = 1; n <= opts.dead; n++) await bury(n);
    for (let n = 1; n <= (opts.acked ?? 0); n++) {
      const a = await outbox.acknowledgeDead(ref(n), { atMs: Date.now() });
      if (!a.ok) throw new Error(`ack: ${a.error.code}`);
    }
    const store: Record<symbol, unknown> = {};
    cleanups.push(async () => void (await getSettlementHost(store)?.shutdown()));
    const logs = collector();
    const cfg = (env: Record<string, string>) => ({
      env: { ...ON_ENV, SETTLEMENT_LEDGER_SCHEMA: ledgerSchema, SETTLEMENT_OUTBOX_SCHEMA: settlementSchema, ...env },
      store,
      processOwner: "host" as const,
      openDatabase: () => ({ db, close: async () => void (await pool.end()) }),
      log: logs.log,
      signals: fakeSignals(),
      exit: () => undefined,
    });
    const ready = async (): Promise<Ready> => {
      const r = probeHttpResponse(store, "ready");
      return { status: r.status, body: (await r.json()) as Body };
    };
    const until = async (what: string, ok: (r: Ready) => boolean): Promise<Ready> => {
      let last = await ready();
      for (let i = 0; i < 300 && !ok(last); i++) {
        await new Promise((res) => setTimeout(res, 20));
        last = await ready();
      }
      if (!ok(last)) throw new Error(`شرطِ «${what}» برقرار نشد؛ آخرین: ${JSON.stringify(last)}`);
      return last;
    };
    const slot = () => store[BACKLOG_WATCH_STORE_KEY] as { view(): { status: string; count: number | null } } | undefined;
    return { cfg, store, pool, db, logs, outbox, index: index.value, schema: settlementSchema, ref, bury, ready, until, slot };
  }
  const started = (o: BootstrapOutcome) => {
    if (o.status !== "started") throw new Error(`انتظار started بود: ${JSON.stringify(o)}`);
    return o;
  };
  const watchLogs = (events: readonly BootstrapEvent[]) => events.filter((e) => e.type === "bootstrap.backlog_watch");

  it("نمایهٔ نصب‌شده: پایش همان تأییدنشده‌ها را از نمایه می‌شمارد (۳ مرده − ۱ تأییدشده = ۲ ⇒ down با downCount=۲)", async () => {
    const t = await rig({ index: true, dead: 3, acked: 1 });
    const o = started(await startSettlementBootstrap(t.cfg(PENDING)));
    expect(await o.booting).toMatchObject({ booted: true });
    const r = await t.until("backlog down", (x) => x.body.backlog?.status === "down");
    expect(r.status).toBe(200); // report: هرگز مسدود نمی‌کند
    expect(r.body.backlog).toMatchObject({ status: "down", count: 2, policy: "report" });
    expect(await t.index.verify()).toMatchObject({ ok: true, value: { consistent: true, expected: 2, indexed: 2 } });
  });

  it("تأییدِ یک مرده (از راهِ outbox) ردیفِ نمایه را برمی‌دارد ⇒ پایش به degraded می‌رود؛ تأییدِ همه ⇒ ok", async () => {
    const t = await rig({ index: true, dead: 2 });
    const o = started(await startSettlementBootstrap(t.cfg(PENDING)));
    await o.booting;
    await t.until("down", (x) => x.body.backlog?.status === "down");
    expect((await t.outbox.acknowledgeDead(t.ref(1), { atMs: Date.now() })).ok).toBe(true);
    const mid = await t.until("degraded", (x) => x.body.backlog?.status === "degraded");
    expect(mid.body.backlog?.count).toBe(1);
    expect((await t.outbox.acknowledgeDead(t.ref(2), { atMs: Date.now() })).ok).toBe(true);
    const back = await t.until("ok", (x) => x.body.backlog?.status === "ok");
    expect(back.body.backlog?.count).toBe(0);
  });

  it("خواندن واقعاً از نمایه است: با TRIGGER خاموش outbox مردهٔ تازه را می‌بیند ولی پایشِ pending نه (شکافی که فقط verify می‌گیرد)", async () => {
    const t = await rig({ index: true, dead: 0 });
    for (const trg of ["settlement_pending_dead_ins", "settlement_pending_dead_upd"]) await t.pool.query(`ALTER TABLE "${t.schema}".settlement_outbox DISABLE TRIGGER ${trg}`);
    await t.bury(1);
    const truth = await t.outbox.listUnacknowledgedDead({ limit: 10 });
    expect(truth.ok && truth.value.length).toBe(1); // حقیقت: یک مردهٔ تأییدنشده
    expect(await t.index.verify()).toMatchObject({ ok: true, value: { consistent: false, missing: 1 } });
    const o = started(await startSettlementBootstrap(t.cfg(PENDING)));
    await o.booting;
    const r = await t.until("ok", (x) => x.body.backlog?.status === "ok");
    expect(r.body.backlog?.count).toBe(0); // پایش فقط نمایه را می‌خواند (حدّ مستند: TRIGGERِ خاموش را verify می‌گیرد، نه پایش)
  });

  it("نمایهٔ نصب‌نشده: رفتگر بوت می‌شود؛ پایش degraded با SAMPLE_UNREADABLE و count=null؛ **هرگز ok** و بازگشتِ بی‌صدا به outbox (۲ مرده) نیست", async () => {
    const t = await rig({ index: false, dead: 2 });
    const truth = await t.outbox.listUnacknowledgedDead({ limit: 10 });
    expect(truth.ok && truth.value.length).toBe(2); // outbox می‌توانست ۲ را نشان دهد؛ نمی‌دهد
    const o = started(await startSettlementBootstrap(t.cfg(PENDING)));
    expect(await o.booting).toMatchObject({ booted: true });
    const r = await t.until("unreadable", (x) => x.body.backlog?.reasons.includes("SAMPLE_UNREADABLE") === true);
    expect(r.body.backlog).toMatchObject({ status: "degraded", count: null });
    expect(r.body.backlog?.status).not.toBe("ok");
    expect(r.body.state).toBe("running");
    for (let i = 0; i < 10; i++) {
      await new Promise((res) => setTimeout(res, 40));
      const again = await t.ready();
      expect(again.body.backlog?.status, "هرگز ok/down با شمارِ outbox").toBe("degraded");
      expect(again.body.backlog?.count).toBeNull();
    }
  });

  it("برگشتِ رسمیِ نمایه در حینِ اجرا ⇒ degraded؛ نصبِ دوباره ⇒ بی‌ری‌استارت دوباره ok (پایش خودترمیم است)", async () => {
    const t = await rig({ index: true, dead: 0 });
    const o = started(await startSettlementBootstrap(t.cfg(PENDING)));
    await o.booting;
    await t.until("ok", (x) => x.body.backlog?.status === "ok" && x.body.backlog.count === 0);
    const down = await t.index.down();
    expect(down).toMatchObject({ ok: true });
    const lost = await t.until("unreadable", (x) => x.body.backlog?.reasons.includes("SAMPLE_UNREADABLE") === true);
    expect(lost.body.backlog?.status).toBe("degraded");
    const up = await t.index.migrate();
    expect(up.ok).toBe(true);
    const back = await t.until("ok دوباره", (x) => x.body.backlog?.status === "ok");
    expect(back.body.backlog?.count).toBe(0);
    expect(t.slot()?.view().status).toBe("ok");
  });

  it("پیش‌فرض (بی‌منبع) روی همان پایگاهِ بی‌نمایه: پایش از outbox می‌خواند (۲ مرده ⇒ down) و نصبِ نمایه لازم نیست — رفتارِ امروز", async () => {
    const t = await rig({ index: false, dead: 2 });
    const { SETTLEMENT_BACKLOG_SOURCE: _omit, ...plain } = PENDING;
    void _omit;
    const o = started(await startSettlementBootstrap(t.cfg(plain)));
    await o.booting;
    const r = await t.until("down", (x) => x.body.backlog?.status === "down");
    expect(r.body.backlog?.count).toBe(2);
    expect(watchLogs(t.logs.events).every((e) => !("source" in e))).toBe(true);
  });

  it("لاگ: pending ⇒ armed و started (و stopped با SIGTERM) همه source=pending", async () => {
    const t = await rig({ index: true, dead: 0 });
    const o = started(await startSettlementBootstrap(t.cfg(PENDING)));
    await o.booting;
    await t.until("ok", (x) => x.body.backlog?.status === "ok");
    expect(watchLogs(t.logs.events)).toEqual([
      { type: "bootstrap.backlog_watch", state: "armed", readyPolicy: "report", source: "pending" },
      { type: "bootstrap.backlog_watch", state: "started", readyPolicy: "report", source: "pending" },
    ]);
    await o.host.shutdown();
    expect(watchLogs(t.logs.events).map((e) => (e.type === "bootstrap.backlog_watch" ? `${e.state}:${e.source}` : ""))).toEqual(["armed:pending", "started:pending", "stopped:pending"]);
  });

  it("gate_down + منبعِ pending: شمارِ نمایه ready را ۵۰۳ می‌کند و تأیید آن را برمی‌گرداند (همان سیاستِ پایش، منبعِ دیگر)", async () => {
    const t = await rig({ index: true, dead: 2 });
    const o = started(await startSettlementBootstrap(t.cfg({ ...PENDING, [E.readyPolicy]: "gate_down" })));
    await o.booting;
    const blocked = await t.until("۵۰۳", (x) => x.status === 503 && x.body.backlog?.status === "down");
    expect(blocked.body).toMatchObject({ ok: false, backlog: { count: 2, policy: "gate_down" } });
    for (const n of [1, 2]) expect((await t.outbox.acknowledgeDead(t.ref(n), { atMs: Date.now() })).ok).toBe(true);
    const back = await t.until("۲۰۰", (x) => x.status === 200 && x.body.backlog?.status === "ok");
    expect(back.body.ok).toBe(true);
  });
});
