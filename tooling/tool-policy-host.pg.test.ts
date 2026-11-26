/**
 * میزبانِ فرایندیِ سیاستِ ابزار (ADR-0075) روی ریشهٔ واقعی و PostgreSQL **واقعی**: ذخیره‌ساز PG ← مدیر ← منبع ← حلقه ← میزبان.
 * زمان‌سنجِ میزبان واقعیِ Node است؛ ساعت/زمان‌سنجِ ریشه مجازی‌اند (قطعی). بدونِ پایگاه رد می‌شود (دروازهٔ صفر-رد قرمزش می‌کند).
 * ثابت می‌شود: مهاجرت‌نشده ⇒ NOT_MIGRATED بی‌بازتلاش و بی‌حلقه؛ بوت ≠ آماده؛ آمادگیِ واقعی ⇒ ready/startup؛ خاموشیِ مرتب؛
 * جدولِ قفل‌شده ⇒ UNAVAILABLE ⇒ بازتلاشِ میزبان ⇒ بالا آمدن پس از رهاسازی.
 */
import { Pool, type PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createPgToolPolicyRuntime } from "@/modules/tool-policy-runtime";
import { createToolPolicyHost } from "@/modules/tool-policy-host";
import type { ToolPolicyHost } from "@/modules/tool-policy-host";
import { createNodeTimer } from "@/modules/settlement-runtime";
import { dbDescribe, openPgPolicyStore, TEST_DB_URL, TEST_POOL_IDLE_MS } from "../src/modules/tool-policy-store-pg/test-db";
import type { TestPolicyStore } from "../src/modules/tool-policy-store-pg/test-db";
import { fakeClock } from "../src/modules/tool-policy-admin/test-kit";
import { fakeTimer } from "../src/modules/tool-policy-refresher/test-kit";

const TUNING = { intervalMs: 10_000, retryMs: 2_000, attemptDeadlineMs: 6_000, refreshTimeoutMs: 5_000, maxStaleMs: 30_000 };
const SAFETY_RELEASE_MS = 4_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, label: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(5);
  }
}

dbDescribe("tool-policy-host · PostgreSQL واقعی", () => {
  const disposers: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const d of disposers.splice(0).reverse()) await d();
  });

  async function schemaOf(opts: Parameters<typeof openPgPolicyStore>[0] = {}): Promise<TestPolicyStore> {
    const t = await openPgPolicyStore(opts);
    disposers.push(() => t.dispose());
    return t;
  }

  function world(t: TestPolicyStore, hostExtra: Record<string, unknown> = {}, rtExtra: Record<string, unknown> = {}) {
    const ft = fakeTimer();
    const made = createPgToolPolicyRuntime({ db: t.db, schema: t.schema, tuning: TUNING, clock: fakeClock(1_000), timer: ft.timer, ...rtExtra });
    if (!made.ok) throw new Error(`runtime: ${made.error.issues.join(",")}`);
    const runtime = made.value;
    const closes = { n: 0 };
    const hostMade = createToolPolicyHost({ runtime, timer: createNodeTimer(), signals: false, closeResources: () => void (closes.n += 1), ...hostExtra });
    if (!hostMade.ok) throw new Error(`host: ${hostMade.error.issues.join(",")}`);
    const host: ToolPolicyHost = hostMade.value;
    disposers.push(() => host.shutdown());
    return { host, runtime, ft, closes };
  }

  async function lockVersions(t: TestPolicyStore): Promise<{ release(): Promise<void> }> {
    const pool = new Pool({ connectionString: TEST_DB_URL, max: 1, idleTimeoutMillis: TEST_POOL_IDLE_MS });
    const client: PoolClient = await pool.connect();
    await client.query("BEGIN");
    await client.query(`LOCK TABLE "${t.schema}".tool_policy_versions IN ACCESS EXCLUSIVE MODE`);
    let done = false;
    const release = async (): Promise<void> => {
      if (done) return;
      done = true;
      clearTimeout(safety);
      try {
        await client.query("ROLLBACK");
      } finally {
        client.release();
        await pool.end();
      }
    };
    const safety = setTimeout(() => void release(), SAFETY_RELEASE_MS); // قفلِ ایمنی: رگرسیون آزمون را آویزان نمی‌کند.
    disposers.push(release);
    return { release };
  }

  it("شِمای مهاجرت‌نشده ⇒ NOT_MIGRATED بی‌بازتلاش؛ حلقه راه نمی‌افتد؛ هیچ جدولی ساخته نمی‌شود؛ ready/startup ⇒ ۵۰۳", async () => {
    const t = await schemaOf({ migrate: false });
    const w = world(t, { bootRetry: { maxAttempts: 5, delayMs: 20 } });
    expect(await w.host.boot()).toEqual({ booted: false, reason: "NOT_MIGRATED", attempts: 1 });
    expect(w.ft.pending()).toBe(0);
    expect(w.host.status()).toMatchObject({ state: "failed", lastBootFailure: { reason: "NOT_MIGRATED" } });
    expect(w.host.probes.ready().httpStatus).toBe(503);
    expect(w.host.probes.startup().httpStatus).toBe(503);
    expect(w.host.probes.live().httpStatus).toBe(200);
    const tables = await t.raw("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1", [t.schema]);
    expect(tables[0]?.["n"]).toBe(0);
  });

  it("نگهبانِ فقط‌افزودنی خاموش (تریگر غیرفعال) ⇒ SCHEMA_MISMATCH بی‌بازتلاش", async () => {
    const t = await schemaOf();
    await t.raw("ALTER TABLE {{s}}.tool_policy_versions DISABLE TRIGGER USER");
    const w = world(t, { bootRetry: { maxAttempts: 5, delayMs: 20 } });
    expect(await w.host.boot()).toEqual({ booted: false, reason: "SCHEMA_MISMATCH", attempts: 1 });
    expect(w.ft.pending()).toBe(0);
  });

  it("پایگاهِ سالم: running ← (نخستین تازه‌سازی) ← ready و startup ← خاموشیِ مرتب و بستنِ منابع", async () => {
    const t = await schemaOf();
    const w = world(t);
    expect(await w.host.boot()).toEqual({ booted: true, attempts: 1 });
    expect(w.host.status()).toMatchObject({ state: "running", hasBooted: true });
    await until(() => w.host.probes.ready().httpStatus === 200, "ready");
    expect(w.host.probes.ready()).toEqual({ httpStatus: 200, body: { probe: "ready", ok: true, state: "running", reason: null } });
    expect(w.host.probes.startup().httpStatus).toBe(200);
    expect(w.host.status().hasBeenReady).toBe(true);
    expect(w.runtime.health()).toMatchObject({ state: "RUNNING", ready: true, reason: null });

    expect(await w.host.shutdown()).toEqual({ ok: true, clean: true, timedOut: false, closed: "ok", reason: "MANUAL" });
    expect(w.closes.n).toBe(1);
    expect(w.ft.pending()).toBe(0);
    expect(w.runtime.health()).toMatchObject({ state: "STOPPED", ready: false });
    expect(w.host.probes.ready()).toMatchObject({ httpStatus: 503, body: { state: "stopped" } });
    expect(w.host.probes.startup().httpStatus).toBe(200); // چسبنده
    const rows = await t.raw("SELECT count(*)::int AS n FROM {{s}}.tool_policy_versions");
    expect(rows[0]?.["n"]).toBe(0); // میزبان و ریشه هرگز نمی‌نویسند
  });

  it("جدولِ قفل‌شده: تلاشِ نخست UNAVAILABLE (مهلتِ پایگاه)، میزبان بازتلاش می‌کند و پس از رهاسازیِ قفل بالا می‌آید", async () => {
    const t = await schemaOf();
    const lock = await lockVersions(t);
    const w = world(t, { bootRetry: { maxAttempts: 6, delayMs: 20 } }, { statementTimeoutMs: 200 });
    const p = w.host.boot();
    await sleep(300);
    expect(w.host.status().state).toBe("booting"); // هنوز یا در تلاش یا در انتظارِ بازتلاش؛ نه آماده و نه شکست‌خورده
    await lock.release();
    const res = await p;
    expect(res.booted).toBe(true);
    expect(res.attempts).toBeGreaterThanOrEqual(2);
    await until(() => w.host.probes.ready().httpStatus === 200, "ready");
    expect((await w.host.shutdown()).ok).toBe(true);
  });

  it("جدولِ قفل‌شده و بدونِ بازتلاش: بوت با UNAVAILABLE می‌شکند، ریشه راه نمی‌افتد و ready ۵۰۳ می‌ماند", async () => {
    const t = await schemaOf();
    const lock = await lockVersions(t);
    const w = world(t, {}, { statementTimeoutMs: 200 });
    const res = await w.host.boot();
    expect(res).toEqual({ booted: false, reason: "UNAVAILABLE", attempts: 1 });
    expect(w.ft.pending()).toBe(0);
    expect(w.host.probes.ready().httpStatus).toBe(503);
    await lock.release();
  });
});
