/**
 * مرزِ برنامهٔ سیاستِ ابزار (ADR-0076) روی PostgreSQL **واقعی**: env ← ریشهٔ PG ← میزبان ← پروب‌های HTTP، و اجارهٔ شمارشیِ استخرِ واقعی.
 * بدونِ پایگاه رد می‌شود (دروازهٔ صفر-رد قرمزش می‌کند). ثابت می‌شود: سالم ⇒ ready ۲۰۰ و خاموشیِ مرتب؛ مهاجرت‌نشده ⇒ NOT_MIGRATED بی‌بازتلاش
 * (حتی با BOOT_ATTEMPTS=5) و بی‌جدول؛ شکستِ بوت استخرِ مشترکِ برنامه را نمی‌بندد؛ بستنِ استخر فقط توسطِ آخرین اجاره‌دار و فقط یک بار.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { acquirePoolLease } from "../src/db/pool-lease";
import { getToolPolicyHost } from "@/modules/tool-policy-host";
import { probeHttpResponse, startToolPolicyBootstrap } from "@/modules/tool-policy-bootstrap";
import type { BootstrapOutcome } from "@/modules/tool-policy-bootstrap";
import { dbDescribe, openPgPolicyStore, TEST_DB_URL, TEST_POOL_IDLE_MS } from "../src/modules/tool-policy-store-pg/test-db";
import type { TestPolicyStore } from "../src/modules/tool-policy-store-pg/test-db";

const TUNING_ENV = {
  TOOL_POLICY_INTERVAL_MS: "10000",
  TOOL_POLICY_RETRY_MS: "2000",
  TOOL_POLICY_ATTEMPT_DEADLINE_MS: "6000",
  TOOL_POLICY_REFRESH_TIMEOUT_MS: "5000",
  TOOL_POLICY_MAX_STALE_MS: "30000",
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, label: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(5);
  }
}

dbDescribe("tool-policy-bootstrap · PostgreSQL واقعی", () => {
  const disposers: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const d of disposers.splice(0).reverse()) await d();
  });

  async function schemaOf(opts: Parameters<typeof openPgPolicyStore>[0] = {}): Promise<TestPolicyStore> {
    const t = await openPgPolicyStore(opts);
    disposers.push(() => t.dispose());
    return t;
  }

  function envFor(t: TestPolicyStore, extra: Record<string, string> = {}): Record<string, string> {
    return { TOOL_POLICY_HOST: "on", ...TUNING_ENV, TOOL_POLICY_SCHEMA: t.schema, ...extra };
  }

  function wire(db: unknown, calls: { close: number; release: number }, extra: Record<string, unknown> = {}) {
    const store: Record<symbol, unknown> = {};
    disposers.push(async () => void (await getToolPolicyHost(store)?.shutdown()));
    return {
      store,
      cfg: {
        store,
        processOwner: "next" as const,
        signals: false as const,
        openDatabase: async () => ({ db, close: () => void (calls.close += 1), release: () => void (calls.release += 1) }),
        ...extra,
      },
    };
  }

  it("پایگاهِ سالم: بوت ⇒ آماده ⇒ پروب‌های HTTP ۲۰۰ ⇒ خاموشیِ مرتب و close یک بار؛ هرگز نمی‌نویسد", async () => {
    const t = await schemaOf();
    const calls = { close: 0, release: 0 };
    const w = wire(t.db, calls);
    const out = await startToolPolicyBootstrap({ ...w.cfg, env: envFor(t) });
    expect(out.status).toBe("started");
    expect(out.status === "started" && (await out.booting)).toEqual({ booted: true, attempts: 1 });
    await until(() => probeHttpResponse(w.store, "ready").status === 200, "ready");
    expect(await probeHttpResponse(w.store, "ready").json()).toEqual({ probe: "ready", ok: true, state: "running", reason: null });
    expect(probeHttpResponse(w.store, "startup").status).toBe(200);
    expect(probeHttpResponse(w.store, "live").status).toBe(200);

    const host = getToolPolicyHost(w.store);
    expect(await host?.shutdown()).toEqual({ ok: true, clean: true, timedOut: false, closed: "ok", reason: "MANUAL" });
    expect(calls).toEqual({ close: 1, release: 0 });
    expect(probeHttpResponse(w.store, "ready").status).toBe(503);
    const rows = await t.raw("SELECT count(*)::int AS n FROM {{s}}.tool_policy_versions");
    expect(rows[0]?.["n"]).toBe(0);
  });

  it("مهاجرت‌نشده ⇒ NOT_MIGRATED بی‌بازتلاش (حتی با BOOT_ATTEMPTS=5)، بی‌جدول، ready ۵۰۳، live ۲۰۰؛ پایگاه بسته نمی‌شود", async () => {
    const t = await schemaOf({ migrate: false });
    const calls = { close: 0, release: 0 };
    const w = wire(t.db, calls);
    const out = await startToolPolicyBootstrap({ ...w.cfg, env: envFor(t, { TOOL_POLICY_BOOT_ATTEMPTS: "5", TOOL_POLICY_BOOT_RETRY_DELAY_MS: "20" }) });
    expect(out.status === "started" && (await out.booting)).toEqual({ booted: false, reason: "NOT_MIGRATED", attempts: 1 });
    expect(probeHttpResponse(w.store, "ready").status).toBe(503);
    expect(probeHttpResponse(w.store, "startup").status).toBe(503);
    expect(probeHttpResponse(w.store, "live").status).toBe(200);
    expect(calls).toEqual({ close: 0, release: 0 });
    const tables = await t.raw("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1", [t.schema]);
    expect(tables[0]?.["n"]).toBe(0);
  });

  it("SIGTERMِ ساختگی با صاحبِ خروج host: خاموشیِ مرتب ⇒ close یک بار ⇒ exit(0)", async () => {
    const t = await schemaOf();
    const calls = { close: 0, release: 0 };
    const listeners = new Map<string, () => void>();
    const exits: number[] = [];
    const signals = { on: (s: string, l: () => void): unknown => void listeners.set(s, l), off: (s: string): unknown => void listeners.delete(s) };
    const w = wire(t.db, calls, { processOwner: "host", signals, exit: (c: number) => void exits.push(c) });
    const out = await startToolPolicyBootstrap({ ...w.cfg, env: envFor(t) });
    if (out.status === "started") await out.booting;
    await until(() => probeHttpResponse(w.store, "ready").status === 200, "ready");
    listeners.get("SIGTERM")?.();
    await until(() => exits.length > 0, "exit");
    expect(exits).toEqual([0]);
    expect(calls).toEqual({ close: 1, release: 0 });
  });

  describe("استخرِ واقعی با اجارهٔ شمارشی", () => {
    async function realPool(): Promise<Pool> {
      const pool = new Pool({ connectionString: TEST_DB_URL, max: 3, idleTimeoutMillis: TEST_POOL_IDLE_MS });
      disposers.push(async () => {
        if (!pool.ended) await pool.end();
      });
      return pool;
    }

    it("شکستِ بوتِ سیاست (شِمای نامعتبر) استخرِ مشترکِ برنامه را نمی‌بندد (وبِ اصلی هنوز می‌خواند)", async () => {
      const t = await schemaOf();
      const pool = await realPool();
      const lease = acquirePoolLease(pool);
      const out: BootstrapOutcome = await startToolPolicyBootstrap({
        store: {},
        processOwner: "next",
        signals: false,
        env: envFor(t, { TOOL_POLICY_SCHEMA: "bad-schema; drop" }),
        openDatabase: async () => {
          const l = acquirePoolLease(pool);
          return { db: drizzle(pool), close: () => l.close(), release: () => l.release() };
        },
      });
      expect(out).toMatchObject({ status: "failed", code: "RUNTIME_INVALID" });
      expect(pool.ended).toBe(false);
      expect((await pool.query("SELECT 1 AS one")).rows[0]).toEqual({ one: 1 });
      await lease.close();
      expect(pool.ended).toBe(true);
    });

    it("دو اجاره‌دار (تسویه‌نما و سیاست): خاموشیِ سیاست استخر را نمی‌بندد؛ آخرین close یک بار می‌بندد", async () => {
      const t = await schemaOf();
      const pool = await realPool();
      const other = acquirePoolLease(pool);
      const w = wire(null, { close: 0, release: 0 });
      const out = await startToolPolicyBootstrap({
        ...w.cfg,
        env: envFor(t),
        openDatabase: async () => {
          const l = acquirePoolLease(pool);
          return { db: drizzle(pool), close: () => l.close(), release: () => l.release() };
        },
      });
      expect(out.status === "started" && (await out.booting)).toEqual({ booted: true, attempts: 1 });
      await until(() => probeHttpResponse(w.store, "ready").status === 200, "ready");
      expect((await getToolPolicyHost(w.store)?.shutdown())?.ok).toBe(true);
      expect(pool.ended).toBe(false); // تسویه‌نما هنوز نگه داشته است
      expect((await pool.query("SELECT 1 AS one")).rows[0]).toEqual({ one: 1 });
      await other.close();
      expect(pool.ended).toBe(true);
    });
  });
});
