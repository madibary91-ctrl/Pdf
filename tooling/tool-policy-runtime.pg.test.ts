/**
 * ریشهٔ I/Oِ سیاستِ ابزار روی PostgreSQL **واقعی** (ADR-0073): ذخیره‌سازِ PG ← مدیرِ واقعی ← منبعِ واقعی ← حلقهٔ واقعی.
 * ساعتِ یکنوا و زمان‌سنج مجازی‌اند (قطعی)، پایگاه واقعی است. بدونِ پایگاه رد می‌شود (دروازهٔ صفر-رد قرمزش می‌کند).
 * ثابت می‌شود: ریشه هرگز مهاجرت نمی‌کند و نمی‌نویسد؛ پیش‌بازرسی NOT_MIGRATED/SCHEMA_MISMATCH؛ بارگذاریِ نخست و نسخهٔ تازه؛
 * خرابیِ پایگاه ⇒ نسخهٔ خوب تا سقفِ سن، سپس STALE (بسته) و بهبود؛ چند نمونه؛ سیم‌کشیِ statement_timeout؛ زمان‌سنجِ واقعی.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createPgToolPolicyRuntime } from "@/modules/tool-policy-runtime";
import type { PgToolPolicyRuntime } from "@/modules/tool-policy-runtime";
import { createToolPolicyAdmin } from "@/modules/tool-policy-admin";
import { dbDescribe, openPgPolicyStore } from "../src/modules/tool-policy-store-pg/test-db";
import type { TestPolicyStore } from "../src/modules/tool-policy-store-pg/test-db";
import { ACTOR, REASON, compat, fakeClock } from "../src/modules/tool-policy-admin/test-kit";
import { fakeTimer } from "../src/modules/tool-policy-refresher/test-kit";

const TUNING = { intervalMs: 10_000, retryMs: 2_000, attemptDeadlineMs: 6_000, refreshTimeoutMs: 5_000, maxStaleMs: 30_000 };
const dialect = new PgDialect();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, label: string, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(5);
  }
}

dbDescribe("tool-policy-runtime · PostgreSQL واقعی", () => {
  const disposers: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    for (const d of disposers.splice(0).reverse()) await d();
  });

  async function schemaOf(opts: Parameters<typeof openPgPolicyStore>[0] = {}): Promise<TestPolicyStore> {
    const t = await openPgPolicyStore(opts);
    disposers.push(() => t.dispose());
    return t;
  }

  function world(t: TestPolicyStore, extra: Record<string, unknown> = {}) {
    const mono = fakeClock(1_000);
    const ft = fakeTimer();
    const made = createPgToolPolicyRuntime({ db: t.db, schema: t.schema, tuning: TUNING, clock: mono, timer: ft.timer, ...extra });
    if (!made.ok) throw new Error(`config: ${made.error.issues.join(",")}`);
    const rt: PgToolPolicyRuntime = made.value;
    disposers.push(() => rt.stop());
    const quiet = async (): Promise<void> => {
      await sleep(0);
      await until(() => rt.health().refresher?.inFlight !== true, "refresh in flight");
    };
    /** زمان (یکنوا + زمان‌سنج) را گام‌به‌گام جلو می‌برد و پس از هر گام منتظرِ پایانِ تلاشِ در جریان می‌ماند. */
    const run = async (ms: number, step = 2_000): Promise<void> => {
      for (let done = 0; done < ms; done += step) {
        mono.advance(step);
        ft.advance(step);
        await quiet();
      }
    };
    const admin = createToolPolicyAdmin({ store: t.store, clock: fakeClock(1_800_000_000_000) });
    if (!admin.ok) throw new Error("admin");
    return { rt, mono, ft, run, quiet, admin: admin.value };
  }

  it("شِمای مهاجرت‌نشده ⇒ NOT_MIGRATED؛ حلقه راه نمی‌افتد؛ ریشه هیچ جدولی نمی‌سازد (هرگز مهاجرت نمی‌کند)", async () => {
    const t = await schemaOf({ migrate: false });
    const { rt, ft } = world(t);
    expect(await rt.start()).toEqual({ started: false, reason: "NOT_MIGRATED" });
    expect(rt.health()).toMatchObject({ state: "IDLE", ready: false, reason: "NOT_STARTED" });
    expect(rt.snapshot()).toMatchObject({ ok: false, error: { code: "NOT_LOADED" } });
    expect(ft.pending()).toBe(0);
    const tables = await t.raw("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1", [t.schema]);
    expect(tables[0]?.["n"]).toBe(0);
  });

  it("شِمای ناموجود ⇒ NOT_MIGRATED (و ساخته نمی‌شود)", async () => {
    const t = await schemaOf({ migrate: false, create: false });
    const { rt } = world(t);
    expect(await rt.start()).toEqual({ started: false, reason: "NOT_MIGRATED" });
    const rows = await t.raw("SELECT count(*)::int AS n FROM information_schema.schemata WHERE schema_name = $1", [t.schema]);
    expect(rows[0]?.["n"]).toBe(0);
  });

  it("نگهبانِ فقط‌افزودنی خاموش (تریگر غیرفعال) ⇒ SCHEMA_MISMATCH و حلقه راه نمی‌افتد", async () => {
    const t = await schemaOf();
    await t.raw("ALTER TABLE {{s}}.tool_policy_versions DISABLE TRIGGER USER");
    const { rt, ft } = world(t);
    const res = await rt.start();
    expect(res.started).toBe(false);
    expect(res).toMatchObject({ reason: "SCHEMA_MISMATCH" });
    expect(ft.pending()).toBe(0);
  });

  it("پایگاهِ مهاجرت‌شده و تهی: start ← بارگذاریِ نسخهٔ ۰ (پیش‌فرض‌های کد) ← آماده ← stop مرتب؛ بی‌نوشتن", async () => {
    const t = await schemaOf();
    const { rt, ft } = world(t);
    expect(rt.health()).toMatchObject({ ready: false, reason: "NOT_STARTED" });
    expect(await rt.start()).toEqual({ started: true });
    await until(() => rt.health().ready, "ready");
    const snap = rt.snapshot();
    expect(snap.ok).toBe(true);
    if (snap.ok) {
      expect(snap.value.version).toBe(0);
      expect(snap.value.source).toBe("defaults");
    }
    expect(rt.health()).toMatchObject({ state: "RUNNING", ready: true, reason: null, source: { state: "FRESH", version: 0 }, refresher: { state: "running", lastOutcome: "ok" } });
    expect(await rt.stop()).toEqual({ stopped: true, abandonedInFlight: false });
    expect(ft.pending()).toBe(0);
    expect(rt.health()).toMatchObject({ state: "STOPPED", ready: false });
    const rows = await t.raw("SELECT count(*)::int AS n FROM {{s}}.tool_policy_versions");
    expect(rows[0]?.["n"]).toBe(0);
  });

  it("نسخهٔ تازه‌ای که ادمین ثبت کرد با تیکِ بعدی دیده می‌شود (نسخهٔ ۱، source=stored)", async () => {
    const t = await schemaOf();
    const w = world(t);
    await w.rt.start();
    await until(() => w.rt.health().ready, "ready");
    const set = await w.admin.set({ expectedVersion: 0, overrides: compat(120_000, 30_000), actor: ACTOR, reason: REASON });
    expect(set.ok).toBe(true);
    const before = w.rt.snapshot();
    expect(before.ok && before.value.version).toBe(0);
    await w.run(TUNING.intervalMs);
    const after = w.rt.snapshot();
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.value.version).toBe(1);
      expect(after.value.source).toBe("stored");
    }
    expect(w.rt.health()).toMatchObject({ ready: true, source: { version: 1 } });
  });

  it("خرابیِ پایگاه: نسخهٔ خوب تا سقفِ سن می‌ماند، سپس STALE (بسته) و ناآماده؛ با بهبودِ پایگاه دوباره FRESH", async () => {
    const t = await schemaOf();
    const w = world(t);
    await w.rt.start();
    await until(() => w.rt.health().ready, "ready");
    await t.raw("ALTER TABLE {{s}}.tool_policy_versions RENAME TO tool_policy_versions_x");
    await w.run(20_000);
    expect(w.rt.snapshot().ok).toBe(true); // هنوز در سقفِ سن
    expect(w.rt.health()).toMatchObject({ ready: true });
    expect(w.rt.health().refresher?.consecutiveFailures).toBeGreaterThan(0);
    await w.run(14_000);
    expect(w.rt.snapshot()).toMatchObject({ ok: false, error: { code: "STALE" } });
    expect(w.rt.health()).toMatchObject({ ready: false, reason: "STALE", state: "RUNNING" });
    await t.raw("ALTER TABLE {{s}}.tool_policy_versions_x RENAME TO tool_policy_versions");
    await w.run(4_000);
    expect(w.rt.snapshot().ok).toBe(true);
    expect(w.rt.health()).toMatchObject({ ready: true, reason: null });
  });

  it("دو نمونهٔ هم‌زمان روی یک پایگاه هر دو یک نسخه را می‌بینند", async () => {
    const t = await schemaOf();
    const a = world(t);
    const b = world(t);
    await Promise.all([a.rt.start(), b.rt.start()]);
    await until(() => a.rt.health().ready && b.rt.health().ready, "both ready");
    await a.admin.set({ expectedVersion: 0, overrides: compat(120_000, 30_000), actor: ACTOR, reason: REASON });
    await Promise.all([a.run(TUNING.intervalMs), b.run(TUNING.intervalMs)]);
    const sa = a.rt.snapshot();
    const sb = b.rt.snapshot();
    expect(sa.ok && sb.ok).toBe(true);
    if (sa.ok && sb.ok) expect(sa.value.version).toBe(sb.value.version);
    if (sa.ok) expect(sa.value.version).toBe(1);
  });

  it("سیم‌کشیِ statement_timeout: پیش‌فرض min(۵۰۰۰، refreshTimeoutMs) و مقدارِ صریح به پایگاه می‌رسد", async () => {
    const t = await schemaOf();
    const spy = (seen: string[]) => ({
      execute: (q: SQL) => t.db.execute(q),
      transaction: <T>(run: Parameters<typeof t.db.transaction<T>>[0], cfg?: Parameters<typeof t.db.transaction<T>>[1]) =>
        t.db.transaction(
          (tx) =>
            run({
              execute: (q: SQL) => {
                const r = dialect.sqlToQuery(q);
                if (r.sql.includes("set_config('statement_timeout'")) seen.push(String(r.params[0]));
                return tx.execute(q);
              },
            }),
          cfg,
        ),
    });
    for (const [extra, expected] of [
      [{}, "5000"],
      [{ statementTimeoutMs: 1_234 }, "1234"],
    ] as const) {
      const seen: string[] = [];
      const made = world({ ...t, db: spy(seen) as never } as TestPolicyStore, extra);
      await made.rt.start();
      await until(() => made.rt.health().ready, "ready");
      expect(seen.length).toBeGreaterThan(0);
      expect([...new Set(seen)]).toEqual([expected]);
      await made.rt.stop();
    }
  });

  it("زمان‌سنجِ واقعیِ Node و ساعتِ یکنوای واقعی: بارگذاری، آمادگی و stop بی‌تایمرِ باقی‌مانده", async () => {
    const t = await schemaOf();
    const made = createPgToolPolicyRuntime({ db: t.db, schema: t.schema, tuning: { ...TUNING, intervalMs: 1_000, retryMs: 500 } });
    if (!made.ok) throw new Error("config");
    disposers.push(() => made.value.stop());
    expect(await made.value.start()).toEqual({ started: true });
    await until(() => made.value.health().ready, "ready (real timer)");
    await sleep(1_300); // دست‌کم یک تیکِ دورهٔ واقعی
    await until(() => (made.value.health().refresher?.attempts ?? 0) >= 2, "second attempt");
    expect(made.value.health().ready).toBe(true);
    expect(await made.value.stop()).toEqual({ stopped: true, abandonedInFlight: false });
    const attempts = made.value.health().refresher?.attempts;
    await sleep(1_300);
    expect(made.value.health().refresher?.attempts).toBe(attempts); // پس از stop تیکی نمی‌خورد
  });
});
