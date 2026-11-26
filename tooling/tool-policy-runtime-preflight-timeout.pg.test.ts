/**
 * پیش‌بازرسیِ ریشهٔ سیاستِ ابزار پشتِ جدولِ قفل‌شده (ADR-0074؛ بندِ ۴.۳ یادداشتِ ۰۰۷۲) روی PostgreSQL **واقعی**.
 * زمان‌سنجِ ریشه مجازی است و هرگز جلو نمی‌رود؛ پس بازگشتِ `start()` فقط از **مهلتِ سمتِ پایگاه** می‌تواند بیاید
 * (پیش از اصلاح: `start()` تا رهاسازیِ قفل آویزان می‌ماند و پرسشِ status روی پایگاه می‌ماند).
 * قفلِ آزمون خودکار پس از ۴ ثانیه رها می‌شود تا رگرسیون آزمون را آویزان نکند.
 */
import { Pool, type PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { createPgToolPolicyRuntime } from "@/modules/tool-policy-runtime";
import { dbDescribe, openPgPolicyStore, TEST_DB_URL, TEST_POOL_IDLE_MS } from "../src/modules/tool-policy-store-pg/test-db";
import type { TestPolicyStore } from "../src/modules/tool-policy-store-pg/test-db";
import { fakeClock } from "../src/modules/tool-policy-admin/test-kit";
import { fakeTimer } from "../src/modules/tool-policy-refresher/test-kit";

const TUNING = { intervalMs: 10_000, retryMs: 2_000, attemptDeadlineMs: 6_000, refreshTimeoutMs: 5_000, maxStaleMs: 30_000 };
const SAFETY_RELEASE_MS = 4_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

dbDescribe("tool-policy-runtime · پیش‌بازرسی پشتِ قفل (PostgreSQL واقعی)", () => {
  const disposers: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const d of disposers.splice(0).reverse()) await d();
  });

  async function schemaOf(): Promise<TestPolicyStore> {
    const t = await openPgPolicyStore();
    disposers.push(() => t.dispose());
    return t;
  }

  async function lockVersions(t: TestPolicyStore): Promise<{ release(): Promise<void>; released(): boolean }> {
    const pool = new Pool({ connectionString: TEST_DB_URL, max: 1, idleTimeoutMillis: TEST_POOL_IDLE_MS });
    const client: PoolClient = await pool.connect();
    await client.query("BEGIN");
    await client.query(`LOCK TABLE "${t.schema}".tool_policy_versions IN ACCESS EXCLUSIVE MODE`);
    let done = false;
    const release = async (): Promise<void> => {
      if (done) return;
      done = true;
      clearTimeout(safety);
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    };
    const safety = setTimeout(() => void release(), SAFETY_RELEASE_MS);
    disposers.push(release);
    return { release, released: () => done };
  }

  function world(t: TestPolicyStore, extra: Record<string, unknown> = {}) {
    const ft = fakeTimer();
    const made = createPgToolPolicyRuntime({ db: t.db, schema: t.schema, tuning: TUNING, clock: fakeClock(1_000), timer: ft.timer, ...extra });
    if (!made.ok) throw new Error(`config: ${made.error.issues.join(",")}`);
    disposers.push(() => made.value.stop());
    return { rt: made.value, ft };
  }

  const waitingOn = async (t: TestPolicyStore): Promise<number> => {
    const rows = await t.raw(
      `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT l.granted`,
      [t.schema],
    );
    return rows[0]?.["n"] as number;
  };

  it("جدولِ قفل‌شده: start() با مهلتِ پایگاه و بی‌حرکتِ زمان‌سنج برمی‌گردد (UNAVAILABLE)، حلقه راه نمی‌افتد و پرسشی روی پایگاه نمی‌ماند", async () => {
    const t = await schemaOf();
    const lock = await lockVersions(t);
    const { rt, ft } = world(t, { statementTimeoutMs: 200 });
    const t0 = Date.now();
    const result = await rt.start();
    const elapsed = Date.now() - t0;
    expect(lock.released(), "بازگشت باید از مهلتِ پایگاه باشد، نه رهاسازیِ قفل").toBe(false);
    expect(result).toEqual({ started: false, reason: "UNAVAILABLE" });
    expect(elapsed).toBeLessThan(2_500);
    expect(rt.health()).toMatchObject({ state: "IDLE", ready: false, reason: "NOT_STARTED" });
    expect(ft.pending()).toBe(0);
    expect(await waitingOn(t)).toBe(0);
    await lock.release();
  });

  it("پس از رهاسازیِ قفل، همان ریشه با start() بعدی بالا می‌آید و آماده می‌شود (خرابیِ گذرا ماندگار نیست)", async () => {
    const t = await schemaOf();
    const lock = await lockVersions(t);
    const { rt } = world(t, { statementTimeoutMs: 200 });
    expect(await rt.start()).toEqual({ started: false, reason: "UNAVAILABLE" });
    await lock.release();
    expect(await rt.start()).toEqual({ started: true });
    for (let i = 0; i < 400 && !rt.health().ready; i++) await sleep(5);
    expect(rt.health().ready).toBe(true);
  });

  it("بدونِ قفل و با مهلتِ کوتاه، پیش‌بازرسیِ سالم همچنان بالا می‌آید (مهلتِ کوتاه خرابیِ کاذب نمی‌سازد)", async () => {
    const t = await schemaOf();
    const { rt } = world(t, { statementTimeoutMs: 100 });
    expect(await rt.start()).toEqual({ started: true });
  });
});
