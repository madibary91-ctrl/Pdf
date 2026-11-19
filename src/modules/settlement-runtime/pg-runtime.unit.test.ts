/**
 * createPgSettlementRuntime بی‌پایگاهِ واقعی: اعتبارسنجیِ مرز، «ساختن به پایگاه دست نمی‌زند» و نگاشتِ خطای پایگاه به کدِ بستهٔ پیش‌بازرسی
 * با `db`ِ ساختگی که خطای pg با کدِ SQLSTATE می‌دهد. (آزمونِ پایگاهِ واقعی: runtime.pg.test.ts)
 */
import { describe, expect, it } from "vitest";
import type { LedgerDatabase } from "@/modules/ledger";
import { createPgSettlementRuntime } from "./index";
import { CANARY, FAKE_DSN, GRACE, manualTimer } from "./test-kit";

type FakeDb = LedgerDatabase & { calls: number };

/** هر دسترسی به پایگاه (execute/transaction) می‌شمارد و با SQLSTATEِ داده‌شده می‌پرتابد (یا `null` ⇒ خطای بی‌کد). */
function fakeDb(sqlState: string | null): FakeDb {
  const db = {
    calls: 0,
    async execute() {
      db.calls += 1;
      throw Object.assign(new Error(`boom ${FAKE_DSN}`), sqlState === null ? {} : { code: sqlState });
    },
    async transaction() {
      db.calls += 1;
      throw Object.assign(new Error(`boom ${FAKE_DSN}`), sqlState === null ? {} : { code: sqlState });
    },
  };
  return db as unknown as FakeDb;
}

function cfg(db: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
  const t = manualTimer();
  return { db, clock: t.clock, timer: t, graceMs: GRACE, deadLetters: false, ...over };
}
const issuesOf = (r: ReturnType<typeof createPgSettlementRuntime>): readonly string[] => (r.ok ? [] : r.error.issues);

describe("settlement-runtime · createPgSettlementRuntime · اعتبارسنجی", () => {
  it("پیکربندیِ معتبر پذیرفته می‌شود و ساختن به پایگاه دست نمی‌زند؛ migrate و ports دارد", () => {
    const db = fakeDb("42P01");
    const r = createPgSettlementRuntime(cfg(db));
    expect(r.ok).toBe(true);
    expect(db.calls).toBe(0);
    if (r.ok) {
      expect(typeof r.value.migrate).toBe("function");
      expect(typeof r.value.ports.ledger.balance).toBe("function");
      expect(Object.isFrozen(r.value)).toBe(true);
    }
  });
  it("clock و timer اختیاری‌اند (پیش‌فرض: ساعتِ سیستم و زمان‌سنجِ Node)", () => {
    const r = createPgSettlementRuntime({ db: fakeDb(null), graceMs: GRACE, deadLetters: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.health().health.status).toBe("down"); // ساعتِ واقعی کار می‌کند؛ هنوز start نشده
  });
  it.each([null, undefined, 5, "x", []])("پیکربندیِ غیرشیء (%s) رد می‌شود", (raw) => {
    expect(createPgSettlementRuntime(raw).ok).toBe(false);
  });
  it.each([undefined, null, 5, "x", {}, { execute: () => 1 }, { transaction: () => 1 }, { execute: 1, transaction: 1 }])("db نامعتبر (%j) رد می‌شود", (db) => {
    const r = createPgSettlementRuntime(cfg(db));
    expect(r.ok).toBe(false);
    expect(issuesOf(r).join("|")).toContain("db");
  });
  it.each(["Public", "public", "x;drop schema", "1abc", "a".repeat(41), "pg_x", "information_schema", ""])("نامِ شِمای دفتر نامعتبر (%s) رد می‌شود", (name) => {
    const r = createPgSettlementRuntime(cfg(fakeDb(null), { ledgerSchema: name }));
    expect(r.ok).toBe(false);
    expect(issuesOf(r).join("|")).toContain("ledgerSchema");
    expect(JSON.stringify(r)).not.toContain(name.length > 3 ? name : "\u0000");
  });
  it.each(["Public", "x;drop schema", "pg_x"])("نامِ شِمای outbox نامعتبر (%s) رد می‌شود", (name) => {
    const r = createPgSettlementRuntime(cfg(fakeDb(null), { settlementSchema: name }));
    expect(r.ok).toBe(false);
    expect(issuesOf(r).join("|")).toContain("settlementSchema");
  });
  it.each([5, null, {}, true])("شِمای غیررشته (%j) رد می‌شود", (v) => {
    expect(issuesOf(createPgSettlementRuntime(cfg(fakeDb(null), { ledgerSchema: v }))).join("|")).toContain("ledgerSchema");
    expect(issuesOf(createPgSettlementRuntime(cfg(fakeDb(null), { settlementSchema: v }))).join("|")).toContain("settlementSchema");
  });
  it("کلیدِ ناشناخته (از جمله ledger/outbox که این سازنده خودش می‌سازد) و clock/timer ناقص رد می‌شود", () => {
    const db = fakeDb(null);
    expect(issuesOf(createPgSettlementRuntime(cfg(db, { outbox: {} }))).join("|")).toContain("outbox");
    expect(issuesOf(createPgSettlementRuntime(cfg(db, { ledger: {} }))).join("|")).toContain("ledger");
    expect(issuesOf(createPgSettlementRuntime(cfg(db, { clock: {} }))).join("|")).toContain("clock");
    expect(issuesOf(createPgSettlementRuntime(cfg(db, { timer: { after: () => 1 } }))).join("|")).toContain("timer");
  });
  it("تنظیماتِ مشترک (deadLetters، graceMs، …) همان اعتبارسنجیِ ریشهٔ ترکیب را می‌گیرند", () => {
    const db = fakeDb(null);
    const c = cfg(db);
    delete c["deadLetters"];
    expect(issuesOf(createPgSettlementRuntime(c)).join("|")).toContain("deadLetters");
    expect(issuesOf(createPgSettlementRuntime(cfg(db, { graceMs: 0 }))).join("|")).toContain("graceMs");
    expect(issuesOf(createPgSettlementRuntime(cfg(db, { limit: 0 }))).join("|")).toContain("limit");
  });
  it("هیچ مقدارِ حساس در خطا نمی‌آید و getterِ پرتابگر بی‌پرتاب رد می‌شود", () => {
    const bad = FAKE_DSN;
    for (const k of ["db", "ledgerSchema", "settlementSchema", "clock", "timer", "graceMs"]) expect(JSON.stringify(createPgSettlementRuntime(cfg(fakeDb(null), { [k]: bad }))), k).not.toContain(CANARY);
    const evil = cfg(fakeDb(null));
    Object.defineProperty(evil, "db", {
      enumerable: true,
      get() {
        throw new Error(CANARY);
      },
    });
    const r = createPgSettlementRuntime(evil);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });
});

describe("settlement-runtime · createPgSettlementRuntime · نگاشتِ خطای پایگاه به کدِ پیش‌بازرسی", () => {
  it.each([
    ["42P01", "NOT_MIGRATED"],
    ["3F000", "NOT_MIGRATED"],
    ["08006", "UNAVAILABLE"],
    ["53300", "UNAVAILABLE"],
    ["57P01", "UNAVAILABLE"],
    [null, "UNAVAILABLE"],
  ] as const)("خطای SQLSTATE=%s ⇒ %s (بی‌نشتِ پیام و رشتهٔ اتصال)", async (state, code) => {
    const db = fakeDb(state);
    const r = createPgSettlementRuntime(cfg(db));
    if (!r.ok) throw new Error("ساخت");
    const s = await r.value.start();
    expect(s).toEqual({ started: false, reason: "PREFLIGHT_FAILED", code });
    expect(db.calls).toBeGreaterThan(0);
    expect(JSON.stringify([s, r.value.health(), r.value.status()])).not.toMatch(/LEAK-CANARY|postgres:\/\//);
  });
  it("migrate با پایگاهِ خراب: stage=ledger با کدِ بسته، بی‌پرتاب و بی‌نشت", async () => {
    const r = createPgSettlementRuntime(cfg(fakeDb("08006")));
    if (!r.ok) throw new Error("ساخت");
    const m = await r.value.migrate();
    expect(m).toMatchObject({ ok: false, stage: "ledger" });
    expect(JSON.stringify(m)).not.toMatch(/LEAK-CANARY|postgres:\/\//);
  });
});
