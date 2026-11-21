/**
 * settlement-bootstrap · سقفِ زمانِ سمتِ پایگاهِ خواندنِ پایش روی PostgreSQL واقعی (ADR-0045، م۳‑ه‑۴‑الف‑۲‑۴‑آ): از env تا پرسشِ پشتِ قفل.
 * جدولِ outbox را اتصالِ دیگری قفلِ انحصاری می‌کند؛ خواندنِ پایش پشتِ قفل می‌ماند. ثابت می‌کند: (۱) پایش به‌جای ماندنِ نامحدود، `SAMPLE_UNREADABLE`
 * می‌گیرد (مهلتِ برنامه)؛ (۲) **پرسشِ رهاشده در پایگاه هم تمام می‌شود**: عمرِ هیچ پرسشِ پایشِ منتظرِ قفل از مهلت + فرجه (+ حاشیه) فراتر نمی‌رود
 * (بدونِ سیم‌کشی با قفلِ نگه‌داشته‌شده تا پایانِ پنجره پیر می‌شد)؛ (۳) پس از آزادشدنِ قفل پایش به `ok` برمی‌گردد (استخر گیر نکرده).
 * شِماهای یک‌بارمصرفِ `bw_ledger_*`/`bw_settle_*`؛ فایلِ تازه.
 */
import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { SETTLEMENT_BACKLOG_WATCH_ENV as E } from "@/modules/settlement-backlog-watch";
import { getSettlementHost } from "@/modules/settlement-host";
import { createPgSettlementRuntime } from "@/modules/settlement-runtime";
import { startSettlementBootstrap } from "./bootstrap";
import { probeHttpResponse } from "./http";
import { ON_ENV, collector, fakeSignals } from "./test-kit";

config({ quiet: true });
const DB_URL: string | undefined = process.env["KB_TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];
const dbDescribe = typeof DB_URL === "string" && DB_URL !== "" ? describe : describe.skip;
const IDLE_MS = 50;
const GRACE = 60_000;
/** مهلتِ پایش ۳۰۰ms ⇒ سقفِ پایگاه ۱۳۰۰ms؛ بازه ۵۰۰ms (کفِ کهنگی = بازه + ۲×مهلت = ۱۱۰۰ ≤ پیش‌فرضِ ۲۲۰۰). */
const ENV = { SETTLEMENT_BACKLOG_WATCH: "on", [E.intervalMs]: "500", [E.timeoutMs]: "300" } as const;
const CAP_MS = 1_300;
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

type Body = { ok: boolean; backlog?: { status: string; count: number | null; reasons: string[] } };

dbDescribe("settlement-bootstrap · سقفِ سمتِ پایگاهِ پایش · PostgreSQL", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await (cleanups.pop() as () => Promise<void>)();
  });

  it("پرسشِ پایشِ پشتِ قفل: SAMPLE_UNREADABLE، عمرِ پرسش در پایگاه ≤ مهلت+فرجه، و پس از آزادشدنِ قفل بازگشت به ok", async () => {
    const tag = randomBytes(5).toString("hex");
    const ledgerSchema = `bw_ledger_${tag}`;
    const settlementSchema = `bw_settle_${tag}`;
    const pool = new Pool({ connectionString: DB_URL, max: 6, idleTimeoutMillis: IDLE_MS });
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
    const rt = createPgSettlementRuntime({ db, ledgerSchema, settlementSchema, graceMs: GRACE, deadLetters: false });
    if (!rt.ok) throw new Error(rt.error.issues.join(";"));
    const m = await rt.value.migrate();
    if (!m.ok) throw new Error(`migrate: ${m.code}`);

    const store: Record<symbol, unknown> = {};
    cleanups.push(async () => void (await getSettlementHost(store)?.shutdown()));
    const outcome = await startSettlementBootstrap({
      env: { ...ON_ENV, SETTLEMENT_LEDGER_SCHEMA: ledgerSchema, SETTLEMENT_OUTBOX_SCHEMA: settlementSchema, ...ENV },
      store,
      processOwner: "host" as const,
      openDatabase: () => ({ db, close: async () => void (await pool.end()) }),
      log: collector().log,
      signals: fakeSignals(),
      exit: () => undefined,
    });
    if (outcome.status !== "started") throw new Error(`started نشد: ${JSON.stringify(outcome)}`);
    await outcome.booting;

    const ready = async (): Promise<Body> => (await probeHttpResponse(store, "ready").json()) as Body;
    const until = async (what: string, ok: (b: Body) => boolean, tries = 300): Promise<Body> => {
      let last = await ready();
      for (let i = 0; i < tries && !ok(last); i++) {
        await sleep(20);
        last = await ready();
      }
      if (!ok(last)) throw new Error(`شرطِ «${what}» برقرار نشد؛ آخرین: ${JSON.stringify(last)}`);
      return last;
    };
    await until("نمونهٔ سالمِ نخست", (b) => b.backlog?.status === "ok");

    // اتصالِ جدا: قفلِ انحصاریِ جدولِ outbox تا آزادسازی.
    const lockPool = new Pool({ connectionString: DB_URL, max: 1, idleTimeoutMillis: IDLE_MS });
    const lockClient = await lockPool.connect();
    await lockClient.query("BEGIN");
    await lockClient.query(`LOCK TABLE "${settlementSchema}"."settlement_outbox" IN ACCESS EXCLUSIVE MODE`);
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      await lockClient.query("ROLLBACK").catch(() => undefined);
      lockClient.release();
      await lockPool.end();
    };
    cleanups.push(release);

    // پنجرهٔ مشاهده: عمرِ پرسش‌های پایشِ منتظرِ قفل (متنِ ضدپیوند `NOT EXISTS` فقط در `listUnacknowledgedDead` است؛ رفتگر بی‌سقف است و فیلتر می‌شود).
    const probe = new Pool({ connectionString: DB_URL, max: 1, idleTimeoutMillis: IDLE_MS });
    cleanups.push(() => probe.end());
    let maxAgeMs = 0;
    let sawWaiting = false;
    let sawUnreadable = false;
    const deadline = Date.now() + 3_600;
    while (Date.now() < deadline) {
      const r = await probe.query(
        `SELECT COALESCE(MAX(EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000), -1)::int AS age
           FROM pg_stat_activity
          WHERE pid <> pg_backend_pid() AND datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'
            AND query LIKE '%NOT EXISTS%' AND query LIKE $1`,
        [`%${settlementSchema}%`],
      );
      const age = Number((r.rows[0] as { age: number }).age);
      if (age >= 0) {
        sawWaiting = true;
        maxAgeMs = Math.max(maxAgeMs, age);
      }
      const b = await ready();
      if (b.backlog?.reasons.includes("SAMPLE_UNREADABLE") === true) sawUnreadable = true;
      await sleep(30);
    }
    expect(sawWaiting).toBe(true); // پرسش واقعاً به پایگاه رسید و پشتِ قفل ماند (آزمون توخالی نیست)
    expect(sawUnreadable).toBe(true); // مهلتِ برنامه: پایش degraded/SAMPLE_UNREADABLE می‌شود
    // پنجره (≈۳٫۶s) از عمرِ بدونِ سقف (تا آزادسازی) بلندتر است؛ با سقف هیچ پرسشی بیش از ۱۳۰۰ms (+حاشیهٔ زمان‌بندی) زنده نمی‌ماند.
    expect(maxAgeMs).toBeLessThan(CAP_MS + 900);
    expect(maxAgeMs).toBeGreaterThan(200); // و واقعاً تا نزدیکِ سقف منتظر ماند، نه اینکه زود رها شده باشد

    await release();
    const back = await until("بازگشت به ok", (b) => b.backlog?.status === "ok" && b.backlog.reasons.length === 0, 400);
    expect(back.backlog?.count).toBe(0);
  }, 40_000);
});
