/**
 * settlement-bootstrap روی PostgreSQL واقعی (ADR-0033): از env تا پروب، با runtime و دفترِ واقعی.
 * شِماهای یک‌بارمصرفِ `bs_ledger_*`/`bs_settle_*` (بدونِ دست‌زدن به `public`)؛ زمان‌سنجِ واقعیِ Node (unref)، سیگنالِ ساختگی.
 * بودجهٔ اتصال (ADR-0024): استخرها اتصالِ بیکار را زود پس می‌دهند و همه بسته می‌شوند.
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { getSettlementHost } from "@/modules/settlement-host";
import { createPgSettlementRuntime } from "@/modules/settlement-runtime";
import { startSettlementBootstrap } from "./bootstrap";
import { probeHttpResponse } from "./http";
import { ON_ENV, collector, fakeSignals, flush } from "./test-kit";
import type { BootstrapOutcome } from "./types";

config({ quiet: true });
const DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const dbDescribe = typeof DB_URL === "string" && DB_URL !== "" ? describe : describe.skip;
const IDLE_MS = 50;
const GRACE = 60_000;

dbDescribe("settlement-bootstrap · PostgreSQL", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  async function rig(opts: { migrate: boolean }) {
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
    if (opts.migrate) {
      const rt = createPgSettlementRuntime({ db, ledgerSchema, settlementSchema, graceMs: GRACE, deadLetters: false });
      if (!rt.ok) throw new Error(rt.error.issues.join(";"));
      const m = await rt.value.migrate();
      if (!m.ok) throw new Error(`migrate: ${m.code}`);
    }
    const store: Record<symbol, unknown> = {};
    cleanups.push(async () => void (await getSettlementHost(store)?.shutdown()));
    const signals = fakeSignals();
    const logs = collector();
    const exits: number[] = [];
    let closes = 0;
    const cfg = (env: Record<string, string> = {}) => ({
      env: { ...ON_ENV, SETTLEMENT_LEDGER_SCHEMA: ledgerSchema, SETTLEMENT_OUTBOX_SCHEMA: settlementSchema, ...env },
      store,
      processOwner: "host" as const,
      openDatabase: () => ({
        db,
        close: async () => {
          closes++;
          await pool.end();
        },
      }),
      log: logs.log,
      signals,
      exit: (c: number) => void exits.push(c),
    });
    return { cfg, store, pool, signals, logs, exits, closes: () => closes };
  }
  const started = (o: BootstrapOutcome) => {
    if (o.status !== "started") throw new Error(`انتظار started بود: ${JSON.stringify(o)}`);
    return o;
  };

  it("پایگاهِ مهاجرت‌شده: بوت ⇒ running، ready ۲۰۰ با سلامتِ واقعیِ runtime، SIGTERM ⇒ توقفِ تمیز، استخر بسته، exit(0)", async () => {
    const t = await rig({ migrate: true });
    const o = started(await startSettlementBootstrap(t.cfg()));
    expect(await o.booting).toMatchObject({ booted: true, attempts: 1 });
    expect(o.host.status()).toMatchObject({ state: "running", hasBooted: true });
    for (const kind of ["live", "startup", "ready"] as const) {
      const r = probeHttpResponse(t.store, kind);
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ probe: kind, ok: true, state: "running" });
    }
    expect(probeHttpResponse(t.store, "ready").headers.get("cache-control")).toBe("no-store");

    t.signals.emit("SIGTERM");
    expect(probeHttpResponse(t.store, "ready").status).toBe(503); // همگام: همان لحظه ready می‌افتد
    for (let i = 0; i < 400 && t.exits.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(t.exits).toEqual([0]);
    expect(t.closes()).toBe(1);
    expect(t.pool.ended).toBe(true);
    expect(o.host.status().state).toBe("stopped");
    expect(t.signals.count()).toBe(0);
    const fin = t.logs.events.find((e) => e.type === "host" && e.event.type === "shutdown.finished");
    expect(fin).toMatchObject({ event: { ok: true, clean: true, timedOut: false, closed: "ok" } });
  });

  it("پایگاهِ مهاجرت‌نشده: NOT_MIGRATED، بی‌بازتلاش حتی با ۳ تلاش، ready و startup ۵۰۳، live ۲۰۰؛ start مهاجرت نمی‌کند", async () => {
    const t = await rig({ migrate: false });
    const o = started(await startSettlementBootstrap(t.cfg({ SETTLEMENT_BOOT_ATTEMPTS: "3", SETTLEMENT_BOOT_RETRY_DELAY_MS: "10" })));
    expect(await o.booting).toEqual({ booted: false, reason: "PREFLIGHT_FAILED", code: "NOT_MIGRATED", attempts: 1 });
    expect(o.host.status()).toMatchObject({ state: "failed", lastBootFailure: { code: "NOT_MIGRATED" } });
    expect(probeHttpResponse(t.store, "live").status).toBe(200);
    expect(probeHttpResponse(t.store, "startup").status).toBe(503);
    expect(probeHttpResponse(t.store, "ready").status).toBe(503);
    const p = new Pool({ connectionString: DB_URL, max: 1, idleTimeoutMillis: IDLE_MS });
    try {
      const r = await p.query("select count(*)::int as n from information_schema.schemata where schema_name = any($1)", [[(t.cfg().env as Record<string, string>)["SETTLEMENT_LEDGER_SCHEMA"], (t.cfg().env as Record<string, string>)["SETTLEMENT_OUTBOX_SCHEMA"]]]);
      expect(r.rows[0].n).toBe(0); // بوت هیچ شِمایی نساخت
    } finally {
      await p.end();
    }
    expect(t.logs.events.filter((e) => e.type === "host" && e.event.type === "boot.attempt_failed")).toHaveLength(1);
  });

  it("پایگاهِ قطع‌شده (استخرِ بسته): UNAVAILABLE ⇒ بازتلاشِ گذرا تا سقفِ تلاش، سپس failed؛ بدونِ پرتاب و بی‌نشتِ آدرس", async () => {
    const t = await rig({ migrate: true });
    await t.pool.end();
    const o = started(await startSettlementBootstrap(t.cfg({ SETTLEMENT_BOOT_ATTEMPTS: "2", SETTLEMENT_BOOT_RETRY_DELAY_MS: "5" })));
    expect(await o.booting).toEqual({ booted: false, reason: "PREFLIGHT_FAILED", code: "UNAVAILABLE", attempts: 2 });
    expect(JSON.stringify([t.logs.events, o.host.status()])).not.toMatch(/postgres(ql)?:\/\//);
    await flush();
  });

  it("بعد از failed، بازتلاشِ دستیِ boot() روی همان میزبان پس از مهاجرت موفق می‌شود (بی‌ساختنِ میزبانِ دوم)", async () => {
    const t = await rig({ migrate: false });
    const o = started(await startSettlementBootstrap(t.cfg()));
    expect((await o.booting)?.booted).toBe(false);
    const rt = createPgSettlementRuntime({ db: drizzle(t.pool), ledgerSchema: (t.cfg().env as Record<string, string>)["SETTLEMENT_LEDGER_SCHEMA"], settlementSchema: (t.cfg().env as Record<string, string>)["SETTLEMENT_OUTBOX_SCHEMA"], graceMs: GRACE, deadLetters: false });
    if (!rt.ok) throw new Error("cfg");
    expect((await rt.value.migrate()).ok).toBe(true); // مهاجرتِ صریحِ زمانِ استقرار
    const again = await startSettlementBootstrap(t.cfg());
    expect(started(again)).toMatchObject({ created: false, booting: null }); // همان میزبان؛ دوباره ساخته نمی‌شود
    expect(await o.host.boot()).toMatchObject({ booted: true });
    expect(probeHttpResponse(t.store, "ready").status).toBe(200);
  });
});
