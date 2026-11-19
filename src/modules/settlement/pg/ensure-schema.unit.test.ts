/**
 * `ensureSchema` (ADR-0035) بی‌پایگاه: ترتیبِ دقیقِ SQL، پارامتری‌بودنِ نام، و شکست‌بسته بودن.
 * اجراکنندهٔ ساختگی هر `sql` را با PgDialect به متن+پارامتر تبدیل و ثبت می‌کند؛ هیچ پایگاهی لازم نیست.
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import type { LedgerDatabase, LedgerExecutor } from "@/modules/ledger";
import { SettlementStoreError } from "./errors";
import { ensureSchema, migrate } from "./migrate";

const dialect = new PgDialect();
type Call = Readonly<{ text: string; params: readonly unknown[] }>;
type Reply = { rows: Record<string, unknown>[] } | Error | "malformed";

function recorder(reply: (call: Call) => Reply = () => ({ rows: [] })): { ex: LedgerExecutor; calls: Call[] } {
  const calls: Call[] = [];
  const ex: LedgerExecutor = {
    execute(query: SQL) {
      const q = dialect.sqlToQuery(query);
      const call: Call = { text: q.sql, params: q.params };
      calls.push(call);
      const r = reply(call);
      if (r instanceof Error) return Promise.reject(r);
      return Promise.resolve(r === "malformed" ? (undefined as unknown as { rows: Record<string, unknown>[] }) : r);
    },
  };
  return { ex, calls };
}

const isLock = (c: Call): boolean => /pg_advisory_xact_lock/.test(c.text);
const isNsSelect = (c: Call): boolean => /from "?pg_catalog"?\."?pg_namespace"?/i.test(c.text);
const isCreateSchema = (c: Call): boolean => /^create schema/i.test(c.text.trim());

describe("settlement/pg · ensureSchema (واحد)", () => {
  it("شِما نیست ⇒ دقیقاً به ترتیب: قفلِ مشترکِ شِما، SELECT از pg_namespace، CREATE SCHEMA IF NOT EXISTS", async () => {
    const { ex, calls } = recorder();
    await ensureSchema(ex, "settlement_x");
    expect(calls).toHaveLength(3);
    expect(isLock(calls[0] as Call)).toBe(true);
    expect((calls[0] as Call).params).toEqual(["schema:ensure:settlement_x"]);
    expect(isNsSelect(calls[1] as Call)).toBe(true);
    expect((calls[1] as Call).params).toEqual(["settlement_x"]);
    expect((calls[2] as Call).text).toBe('CREATE SCHEMA IF NOT EXISTS "settlement_x"');
    expect((calls[2] as Call).params).toEqual([]);
  });

  it("شِما هست ⇒ CREATE SCHEMA اصلاً فرستاده نمی‌شود (نه حتی با IF NOT EXISTS)", async () => {
    const { ex, calls } = recorder((c) => (isNsSelect(c) ? { rows: [{ present: 1 }] } : { rows: [] }));
    await ensureSchema(ex, "settlement_x");
    expect(calls.map((c) => (isLock(c) ? "lock" : isNsSelect(c) ? "select" : "other"))).toEqual(["lock", "select"]);
    expect(calls.some(isCreateSchema)).toBe(false);
  });

  it("خطای SELECT بلعیده نمی‌شود و پس از آن هیچ CREATE ای نمی‌آید", async () => {
    const boom = new Error("select failed");
    const { ex, calls } = recorder((c) => (isNsSelect(c) ? boom : { rows: [] }));
    await expect(ensureSchema(ex, "settlement_x")).rejects.toBe(boom);
    expect(calls.some(isCreateSchema)).toBe(false);
  });

  it("خطای قفل بلعیده نمی‌شود و نه SELECT می‌آید نه CREATE", async () => {
    const boom = new Error("lock failed");
    const { ex, calls } = recorder((c) => (isLock(c) ? boom : { rows: [] }));
    await expect(ensureSchema(ex, "settlement_x")).rejects.toBe(boom);
    expect(calls).toHaveLength(1);
  });

  it("خطای CREATE بلعیده نمی‌شود (همان شیء پرتاب می‌شود)", async () => {
    const boom = new Error("create failed");
    const { ex } = recorder((c) => (isCreateSchema(c) ? boom : { rows: [] }));
    await expect(ensureSchema(ex, "settlement_x")).rejects.toBe(boom);
  });

  it("پاسخ‌های نامعتبرِ SELECT ⇒ شکست‌بسته (CORRUPT_DATA)، هرگز «پس بسازیم»", async () => {
    const bad: Reply[] = ["malformed", { rows: undefined as unknown as Record<string, unknown>[] }, { rows: null as unknown as Record<string, unknown>[] }, { rows: "x" as unknown as Record<string, unknown>[] }];
    for (const reply of bad) {
      const { ex, calls } = recorder((c) => (isNsSelect(c) ? reply : { rows: [] }));
      const err = await ensureSchema(ex, "settlement_x").then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SettlementStoreError);
      expect((err as SettlementStoreError).error.code).toBe("CORRUPT_DATA");
      expect(calls.some(isCreateSchema)).toBe(false);
    }
  });

  it("خاصیتی (۳۰۰ نام): نام فقط پارامترِ پیوندی (قفل/SELECT) یا شناسهٔ نقل‌قول‌شدهٔ CREATE است؛ هرگز بی‌نقل در متن SQL", async () => {
    let seed = 20261119;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const alpha = "abcdefghijklmnopqrstuvwxyz";
    const tail = "abcdefghijklmnopqrstuvwxyz0123456789_";
    const lockTexts = new Set<string>();
    const selectTexts = new Set<string>();
    for (let i = 0; i < 300; i++) {
      let name = alpha[rnd(26)] as string;
      const len = rnd(39);
      for (let k = 0; k < len; k++) name += tail[rnd(tail.length)] as string;
      const { ex, calls } = recorder();
      await ensureSchema(ex, name);
      expect(calls).toHaveLength(3);
      expect((calls[0] as Call).params).toEqual([`schema:ensure:${name}`]);
      expect((calls[1] as Call).params).toEqual([name]);
      expect((calls[2] as Call).text).toBe(`CREATE SCHEMA IF NOT EXISTS "${name}"`);
      lockTexts.add((calls[0] as Call).text);
      selectTexts.add((calls[1] as Call).text);
    }
    // متنِ SQLِ قفل و SELECT برای هر ۳۰۰ نام دقیقاً یکی است ⇒ نام هرگز در متن نیست (فقط پارامتر)
    expect(lockTexts.size).toBe(1);
    expect(selectTexts.size).toBe(1);
  });
});

describe("settlement/pg · migrate از ensureSchema استفاده می‌کند (واحد)", () => {
  function fakeDb(reply: (call: Call) => Reply): { db: LedgerDatabase; calls: Call[] } {
    const { ex, calls } = recorder(reply);
    const db: LedgerDatabase = { execute: ex.execute.bind(ex), transaction: (run) => run(ex) };
    return { db, calls };
  }

  it("ترتیب: قفلِ ماژول ← قفلِ شِما ← SELECT pg_namespace ← CREATE SCHEMA ← CREATE TABLE (همه در یک تراکنش)", async () => {
    const { db, calls } = fakeDb(() => ({ rows: [] }));
    const res = await migrate(db, "settlement_y");
    expect(res.ok).toBe(true);
    expect(calls[0]?.params).toEqual(["settlement:migrate:settlement_y"]);
    expect(calls[1]?.params).toEqual(["schema:ensure:settlement_y"]);
    expect(isNsSelect(calls[2] as Call)).toBe(true);
    expect((calls[3] as Call).text).toBe('CREATE SCHEMA IF NOT EXISTS "settlement_y"');
    expect(calls[4]?.text).toMatch(/^CREATE TABLE IF NOT EXISTS "settlement_y"\."settlement_migration_ledger"/);
  });

  it("شِما از قبل هست ⇒ migrate هیچ CREATE SCHEMA ای نمی‌فرستد ولی جدول و مهاجرت‌ها را می‌سازد", async () => {
    const { db, calls } = fakeDb((c) => (isNsSelect(c) ? { rows: [{ present: 1 }] } : { rows: [] }));
    const res = await migrate(db, "settlement_y");
    expect(res.ok).toBe(true);
    expect(calls.some(isCreateSchema)).toBe(false);
    expect(calls.some((c) => /^CREATE TABLE IF NOT EXISTS "settlement_y"\."settlement_migration_ledger"/.test(c.text))).toBe(true);
  });

  it("خطای SELECT ⇒ migrate شکست می‌خورد (ok:false) و هیچ DDL ای نمی‌فرستد", async () => {
    const { db, calls } = fakeDb((c) => (isNsSelect(c) ? new Error("down") : { rows: [] }));
    const res = await migrate(db, "settlement_y");
    expect(res.ok).toBe(false);
    expect(calls.some((c) => /^(CREATE|ALTER|DROP)/i.test(c.text.trim()))).toBe(false);
  });
});
