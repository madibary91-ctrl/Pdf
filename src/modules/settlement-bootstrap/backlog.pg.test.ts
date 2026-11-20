/**
 * settlement-bootstrap · پایشِ پسماندِ زنگ روی PostgreSQL واقعی (ADR-0043، م۳‑ه‑۴‑الف‑۲‑۲): از env تا پروبِ HTTP با outboxِ واقعی و زمان‌سنجِ واقعیِ Node.
 * ثابت می‌کند: شروع فقط پس از بوتِ موفق، گزارش در ready/startup (live هرگز)، `gate_down` ⇒ فقط ready ۵۰۳ و بازگشت پس از تأیید، `report` هرگز مسدود نمی‌کند،
 * و پایش پیش از بستنِ استخر متوقف می‌شود. شِماهای یک‌بارمصرفِ `bw_ledger_*`/`bw_settle_*` (بدونِ دست‌زدن به `public`)؛ بودجهٔ اتصال مثلِ ADR-0024.
 * فایلِ تازه؛ `integration.pg.test.ts` دست نخورده. اندازه‌گیریِ هزینهٔ خواندن (الف‑۲‑۳) این‌جا نیست.
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
const FAST = { SETTLEMENT_BACKLOG_WATCH: "on", [E.intervalMs]: "40", [E.timeoutMs]: "2000" } as const;

type View = { phase: string; status: string; count: number | null };
type Body = { ok: boolean; state: string; backlog?: { status: string; count: number | null; policy: string; reasons: string[] } };

dbDescribe("settlement-bootstrap · پایشِ پسماند · PostgreSQL", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  async function rig(opts: { migrate: boolean; dead?: number }) {
    const tag = randomBytes(5).toString("hex");
    const ledgerSchema = `bw_ledger_${tag}`;
    const settlementSchema = `bw_settle_${tag}`;
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
    if (opts.migrate) {
      const rt = createPgSettlementRuntime({ db, ledgerSchema, settlementSchema, graceMs: GRACE, deadLetters: false });
      if (!rt.ok) throw new Error(rt.error.issues.join(";"));
      const m = await rt.value.migrate();
      if (!m.ok) throw new Error(`migrate: ${m.code}`);
      for (let n = 1; n <= (opts.dead ?? 0); n++) {
        const ref = { tenantId: "t1", accountId: "a1", reservationId: `r${n}` };
        const b = await outbox.begin({ ...ref, unit: "IRR_MICROS", reserved: 500, createdAtMs: 1_000, expiresAtMs: 61_000, dueAtMs: 11_000, orphanRemainder: "forfeit" });
        if (!b.ok) throw new Error(`begin: ${b.error.code}`);
        const d = await outbox.bury(ref, { reason: "ATTEMPTS_EXHAUSTED", errorCode: null, atMs: Date.now() - 1_000 });
        if (!d.ok) throw new Error(`bury: ${d.error.code}`);
      }
    }
    const store: Record<symbol, unknown> = {};
    cleanups.push(async () => void (await getSettlementHost(store)?.shutdown()));
    const signals = fakeSignals();
    const logs = collector();
    const exits: number[] = [];
    const closePhases: Array<string | null> = [];
    let closes = 0;
    const slotView = (): View | null => {
      const slot = store[BACKLOG_WATCH_STORE_KEY] as { view(): View } | undefined;
      return slot === undefined ? null : slot.view();
    };
    const cfg = (env: Record<string, string> = {}) => ({
      env: { ...ON_ENV, SETTLEMENT_LEDGER_SCHEMA: ledgerSchema, SETTLEMENT_OUTBOX_SCHEMA: settlementSchema, ...env },
      store,
      processOwner: "host" as const,
      openDatabase: () => ({
        db,
        close: async () => {
          closes++;
          closePhases.push(slotView()?.phase ?? null); // لحظهٔ بستنِ استخر: پایش باید از پیش متوقف باشد
          await pool.end();
        },
      }),
      log: logs.log,
      signals,
      exit: (c: number) => void exits.push(c),
    });
    const ready = async (): Promise<{ status: number; body: Body }> => {
      const r = probeHttpResponse(store, "ready");
      return { status: r.status, body: (await r.json()) as Body };
    };
    /** تا برقراریِ شرط (با زمان‌سنجِ واقعی) منتظر می‌ماند؛ شکست ⇒ آخرین مقدار در پیام. */
    const until = async (what: string, ok: (r: { status: number; body: Body }) => boolean): Promise<{ status: number; body: Body }> => {
      let last = await ready();
      for (let i = 0; i < 300 && !ok(last); i++) {
        await new Promise((res) => setTimeout(res, 20));
        last = await ready();
      }
      if (!ok(last)) throw new Error(`شرطِ «${what}» برقرار نشد؛ آخرین: ${JSON.stringify(last)}`);
      return last;
    };
    return { cfg, store, pool, signals, logs, exits, closes: () => closes, closePhases, outbox, slotView, ready, until };
  }
  const started = (o: BootstrapOutcome) => {
    if (o.status !== "started") throw new Error(`انتظار started بود: ${JSON.stringify(o)}`);
    return o;
  };
  const states = (events: readonly BootstrapEvent[]) => events.flatMap((e) => (e.type === "bootstrap.backlog_watch" ? [e.state] : []));

  it("پسماندِ صفر: بوت ⇒ شروع ⇒ ready ۲۰۰ با backlog=ok؛ live بی‌بخش؛ SIGTERM ⇒ پایش پیش از بستنِ استخر متوقف", async () => {
    const t = await rig({ migrate: true });
    const o = started(await startSettlementBootstrap(t.cfg(FAST)));
    expect(await o.booting).toMatchObject({ booted: true });
    const r = await t.until("backlog ok", (x) => x.body.backlog?.status === "ok");
    expect(r.status).toBe(200);
    expect(r.body.backlog).toEqual({ status: "ok", count: 0, truncated: false, oldestAgeMs: null, reasons: [], policy: "report" });
    expect(t.slotView()).toMatchObject({ phase: "running", status: "ok", count: 0 });
    const startup = await (probeHttpResponse(t.store, "startup").json() as Promise<Body>);
    expect(startup.backlog?.status).toBe("ok");
    const live = probeHttpResponse(t.store, "live");
    expect(live.status).toBe(200);
    expect(Object.keys(await live.json()).sort()).toEqual(["ok", "probe", "state", "sweep"]);
    expect(states(t.logs.events)).toEqual(["armed", "started"]);

    t.signals.emit("SIGTERM");
    expect(t.slotView()?.phase).toBe("stopped"); // همگام با شروعِ خاموشی
    for (let i = 0; i < 400 && t.exits.length === 0; i++) await new Promise((res) => setTimeout(res, 5));
    expect(t.exits).toEqual([0]);
    expect(t.closes()).toBe(1);
    expect(t.closePhases).toEqual(["stopped"]);
    expect(t.pool.ended).toBe(true);
    expect(states(t.logs.events)).toEqual(["armed", "started", "stopped"]);
    await new Promise((res) => setTimeout(res, 200)); // پایش پس از بسته‌شدنِ استخر خوانشِ تازه‌ای نمی‌زند (خطای استخرِ بسته ⇒ رد‌نشده/پرتاب‌نشده)
    expect(t.slotView()?.phase).toBe("stopped");
  });

  it("report (پیش‌فرض): چند مرده ⇒ down گزارش می‌شود ولی ready ۲۰۰ می‌ماند", async () => {
    const t = await rig({ migrate: true, dead: 3 });
    const o = started(await startSettlementBootstrap(t.cfg({ ...FAST, [E.degradedCount]: "1", [E.downCount]: "3" })));
    await o.booting;
    const r = await t.until("backlog down", (x) => x.body.backlog?.status === "down");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, backlog: { status: "down", count: 3, policy: "report" } });
  });

  it("gate_down: down ⇒ فقط ready ۵۰۳ (startup و live ۲۰۰)؛ پس از تأییدِ مرده‌ها ready برمی‌گردد", async () => {
    const t = await rig({ migrate: true, dead: 3 });
    const o = started(await startSettlementBootstrap(t.cfg({ ...FAST, [E.degradedCount]: "1", [E.downCount]: "3", [E.readyPolicy]: "gate_down" })));
    await o.booting;
    const blocked = await t.until("ready مسدود", (x) => x.status === 503 && x.body.backlog?.status === "down");
    expect(blocked.body).toMatchObject({ ok: false, state: "running", backlog: { count: 3, policy: "gate_down" } });
    expect(probeHttpResponse(t.store, "startup").status).toBe(200);
    expect(probeHttpResponse(t.store, "live").status).toBe(200);
    for (let n = 1; n <= 3; n++) expect((await t.outbox.acknowledgeDead({ tenantId: "t1", accountId: "a1", reservationId: `r${n}` }, { atMs: Date.now() })).ok).toBe(true);
    const back = await t.until("ready برگشت", (x) => x.status === 200 && x.body.backlog?.status === "ok");
    expect(back.body).toMatchObject({ ok: true, backlog: { count: 0 } });
  });

  it("gate_down و فقط degraded (۱ مرده با downCount=۱۰): ready ۲۰۰", async () => {
    const t = await rig({ migrate: true, dead: 1 });
    const o = started(await startSettlementBootstrap(t.cfg({ ...FAST, [E.readyPolicy]: "gate_down" })));
    await o.booting;
    const r = await t.until("backlog degraded", (x) => x.body.backlog?.status === "degraded");
    expect(r.status).toBe(200);
    expect(r.body.backlog).toMatchObject({ count: 1 });
  });

  it("پایگاهِ مهاجرت‌نشده: بوت شکست ⇒ پایش هرگز شروع نمی‌شود (idle)، ready ۵۰۳ به‌خاطرِ میزبان، backlog=unknown", async () => {
    const t = await rig({ migrate: false });
    const o = started(await startSettlementBootstrap(t.cfg({ ...FAST, [E.readyPolicy]: "gate_down" })));
    expect(await o.booting).toMatchObject({ booted: false, code: "NOT_MIGRATED" });
    await new Promise((res) => setTimeout(res, 150));
    expect(t.slotView()).toMatchObject({ phase: "idle", status: "unknown" });
    const r = await t.ready();
    expect(r.status).toBe(503);
    expect(r.body.backlog).toMatchObject({ status: "unknown", count: null });
    expect(states(t.logs.events)).toEqual(["armed"]);
  });

  it("ظرفی که ثبتِ پایش را رد می‌کند: بوت موفق ولی پایش هرگز شروع نمی‌شود (نمونه‌گیریِ بی‌گزارش هزینه است) و پروب بی‌کلیدِ backlog", async () => {
    const t = await rig({ migrate: true, dead: 3 });
    const cfg = t.cfg({ ...FAST, [E.degradedCount]: "1", [E.downCount]: "3", [E.readyPolicy]: "gate_down" });
    const guarded = new Proxy(t.store, { set: (tgt, key, val) => (key === BACKLOG_WATCH_STORE_KEY ? (() => { throw new TypeError("sealed"); })() : Reflect.set(tgt, key, val)) });
    const o = started(await startSettlementBootstrap({ ...cfg, store: guarded }));
    expect(await o.booting).toMatchObject({ booted: true });
    await new Promise((res) => setTimeout(res, 200));
    expect(t.store[BACKLOG_WATCH_STORE_KEY]).toBeUndefined();
    expect(states(t.logs.events)).toEqual([]);
    const r = await t.ready();
    expect(r.status).toBe(200); // پایشی نیست که مسدود کند
    expect(r.body.backlog).toBeUndefined();
  });

  it("بوتِ دستیِ موفق پس از شکست، پایش را هم شروع می‌کند (چرخهٔ عمر از رویدادِ booted است)", async () => {
    const t = await rig({ migrate: false });
    const o = started(await startSettlementBootstrap(t.cfg(FAST)));
    expect((await o.booting)?.booted).toBe(false);
    expect(t.slotView()?.phase).toBe("idle");
    const rt = createPgSettlementRuntime({ db: drizzle(t.pool), ledgerSchema: t.cfg().env["SETTLEMENT_LEDGER_SCHEMA"], settlementSchema: t.cfg().env["SETTLEMENT_OUTBOX_SCHEMA"], graceMs: GRACE, deadLetters: false });
    if (!rt.ok) throw new Error("cfg");
    expect((await rt.value.migrate()).ok).toBe(true);
    expect(await o.host.boot()).toMatchObject({ booted: true });
    const r = await t.until("backlog ok", (x) => x.body.backlog?.status === "ok");
    expect(r.status).toBe(200);
    expect(states(t.logs.events)).toEqual(["armed", "started"]);
  });
});
