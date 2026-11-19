/**
 * `ensureSchema` (ADR-0036) بی‌پایگاه: ترتیبِ دقیقِ SQL، پارامتری‌بودنِ نام، و شکست‌بسته بودن، هم در خودِ تابع و هم در
 * `migrate` و `migrateSearch`. اجراکنندهٔ ساختگی هر `sql` را با PgDialect به متن+پارامتر تبدیل و ثبت می‌کند.
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { StoreAbort } from "./errors";
import { ensureSchema, migrate } from "./migrate";
import { migrateSearch } from "./search-migrate";
import type { KbDatabase, KbExecutor } from "./types";

const dialect = new PgDialect();
type Call = Readonly<{ text: string; params: readonly unknown[] }>;
type Reply = { rows: Record<string, unknown>[] } | Error | "malformed";

function recorder(reply: (call: Call) => Reply = () => ({ rows: [] })): { ex: KbExecutor; calls: Call[] } {
  const calls: Call[] = [];
  const ex: KbExecutor = {
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

function fakeDb(reply: (call: Call) => Reply): { db: KbDatabase; calls: Call[] } {
  const { ex, calls } = recorder(reply);
  return { db: { execute: ex.execute.bind(ex), transaction: (run) => run(ex) }, calls };
}

const isLock = (c: Call): boolean => /pg_advisory_xact_lock/.test(c.text);
const isNsSelect = (c: Call): boolean => /from "?pg_catalog"?\."?pg_namespace"?/i.test(c.text);
const isCreateSchema = (c: Call): boolean => /^create schema/i.test(c.text.trim());

describe("legal-kb-store · ensureSchema (واحد)", () => {
  it("شِما نیست ⇒ دقیقاً به ترتیب: قفلِ مشترکِ شِما، SELECT از pg_namespace، CREATE SCHEMA IF NOT EXISTS", async () => {
    const { ex, calls } = recorder();
    await ensureSchema(ex, "legal_kb_x");
    expect(calls).toHaveLength(3);
    expect(isLock(calls[0] as Call)).toBe(true);
    expect((calls[0] as Call).params).toEqual(["schema:ensure:legal_kb_x"]);
    expect(isNsSelect(calls[1] as Call)).toBe(true);
    expect((calls[1] as Call).params).toEqual(["legal_kb_x"]);
    expect((calls[2] as Call).text).toBe('CREATE SCHEMA IF NOT EXISTS "legal_kb_x"');
    expect((calls[2] as Call).params).toEqual([]);
  });

  it("شِما هست ⇒ CREATE SCHEMA اصلاً فرستاده نمی‌شود (نه حتی با IF NOT EXISTS)", async () => {
    const { ex, calls } = recorder((c) => (isNsSelect(c) ? { rows: [{ present: 1 }] } : { rows: [] }));
    await ensureSchema(ex, "legal_kb_x");
    expect(calls.map((c) => (isLock(c) ? "lock" : isNsSelect(c) ? "select" : "other"))).toEqual(["lock", "select"]);
  });

  it("خطای SELECT بلعیده نمی‌شود و پس از آن هیچ CREATE ای نمی‌آید", async () => {
    const boom = new Error("select failed");
    const { ex, calls } = recorder((c) => (isNsSelect(c) ? boom : { rows: [] }));
    await expect(ensureSchema(ex, "legal_kb_x")).rejects.toBe(boom);
    expect(calls.some(isCreateSchema)).toBe(false);
  });

  it("خطای قفل بلعیده نمی‌شود و نه SELECT می‌آید نه CREATE", async () => {
    const boom = new Error("lock failed");
    const { ex, calls } = recorder((c) => (isLock(c) ? boom : { rows: [] }));
    await expect(ensureSchema(ex, "legal_kb_x")).rejects.toBe(boom);
    expect(calls).toHaveLength(1);
  });

  it("خطای CREATE بلعیده نمی‌شود (همان شیء پرتاب می‌شود)", async () => {
    const boom = new Error("create failed");
    const { ex } = recorder((c) => (isCreateSchema(c) ? boom : { rows: [] }));
    await expect(ensureSchema(ex, "legal_kb_x")).rejects.toBe(boom);
  });

  it("پاسخ‌های نامعتبرِ SELECT ⇒ شکست‌بسته (CORRUPT_DATA)، هرگز «پس بسازیم»", async () => {
    const bad: Reply[] = ["malformed", { rows: undefined as unknown as Record<string, unknown>[] }, { rows: null as unknown as Record<string, unknown>[] }, { rows: "x" as unknown as Record<string, unknown>[] }];
    for (const reply of bad) {
      const { ex, calls } = recorder((c) => (isNsSelect(c) ? reply : { rows: [] }));
      const err = await ensureSchema(ex, "legal_kb_x").then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(StoreAbort);
      expect((err as StoreAbort).error.code).toBe("CORRUPT_DATA");
      expect(calls.some(isCreateSchema)).toBe(false);
    }
  });

  it("خاصیتی (۳۰۰ نام): نام فقط پارامترِ پیوندی (قفل/SELECT) یا شناسهٔ نقل‌قول‌شدهٔ CREATE است؛ هرگز بی‌نقل در متن SQL", async () => {
    let seed = 20261120;
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
    expect(lockTexts.size).toBe(1);
    expect(selectTexts.size).toBe(1);
  });

  it("شِمایی با نقل‌قول/نقطه‌ویرگول در نام: هرگز بی‌نقل در متن؛ شناسه دوبرابرِ نقل‌قول می‌شود (دفاع در عمق؛ ورودی عمومی از parseSchemaName می‌گذرد)", async () => {
    const evil = 'x"; DROP SCHEMA public CASCADE; --';
    const { ex, calls } = recorder();
    await ensureSchema(ex, evil);
    expect((calls[0] as Call).params).toEqual([`schema:ensure:${evil}`]);
    expect((calls[1] as Call).params).toEqual([evil]);
    expect((calls[0] as Call).text + (calls[1] as Call).text).not.toContain("DROP");
    expect((calls[2] as Call).text).toBe('CREATE SCHEMA IF NOT EXISTS "x""; DROP SCHEMA public CASCADE; --"');
  });
});

describe("legal-kb-store · migrate و migrateSearch از ensureSchema استفاده می‌کنند (واحد)", () => {
  it("migrate · ترتیب: قفلِ ماژول ← CREATE EXTENSION ← قفلِ شِما ← SELECT pg_namespace ← CREATE SCHEMA ← CREATE TABLE", async () => {
    const { db, calls } = fakeDb(() => ({ rows: [] }));
    const res = await migrate(db, "legal_kb_y");
    expect(res.ok).toBe(true);
    expect(calls[0]?.params).toEqual(["legal-kb-store:migrate"]);
    expect(calls[1]?.text).toMatch(/^CREATE EXTENSION IF NOT EXISTS btree_gist/);
    expect(calls[2]?.params).toEqual(["schema:ensure:legal_kb_y"]);
    expect(isNsSelect(calls[3] as Call)).toBe(true);
    expect((calls[4] as Call).text).toBe('CREATE SCHEMA IF NOT EXISTS "legal_kb_y"');
    expect(calls[5]?.text).toMatch(/^CREATE TABLE IF NOT EXISTS "legal_kb_y"\."migration_ledger"/);
  });

  it("migrateSearch · ترتیب: قفلِ ماژول ← قفلِ شِمای نمایه ← SELECT pg_namespace ← CREATE SCHEMA <schema>_search ← CREATE TABLE", async () => {
    const { db, calls } = fakeDb(() => ({ rows: [] }));
    const res = await migrateSearch(db, "legal_kb_y");
    expect(res.ok).toBe(true);
    expect(calls[0]?.params).toEqual(["legal-kb-store:search-migrate"]);
    expect(calls[1]?.params).toEqual(["schema:ensure:legal_kb_y_search"]);
    expect(isNsSelect(calls[2] as Call)).toBe(true);
    expect(calls[2]?.params).toEqual(["legal_kb_y_search"]);
    expect((calls[3] as Call).text).toBe('CREATE SCHEMA IF NOT EXISTS "legal_kb_y_search"');
    expect(calls[4]?.text).toMatch(/^CREATE TABLE IF NOT EXISTS "legal_kb_y_search"\."search_ledger"/);
  });

  it("شِما از قبل هست ⇒ هیچ‌کدام CREATE SCHEMA IF NOT EXISTS نمی‌فرستند ولی جدول را می‌سازند", async () => {
    for (const run of [(db: KbDatabase) => migrate(db, "legal_kb_y"), (db: KbDatabase) => migrateSearch(db, "legal_kb_y")]) {
      const { db, calls } = fakeDb((c) => (isNsSelect(c) ? { rows: [{ present: 1 }] } : { rows: [] }));
      const res = await run(db);
      expect(res.ok).toBe(true);
      // مهاجرتِ ۰۰۰۲ شِمای ممیزی را با `CREATE SCHEMA` ساده می‌سازد (SQLِ اعمال‌شده؛ ویرایش‌ناپذیر)؛ فقط شکلِ `IF NOT EXISTS` از ensureSchema است.
      expect(calls.some((c) => /^create schema if not exists/i.test(c.text.trim()))).toBe(false);
      expect(calls.some((c) => /^CREATE TABLE IF NOT EXISTS/.test(c.text))).toBe(true);
    }
  });

  it("خطای SELECT ⇒ هر دو ok:false برمی‌گردانند و هیچ DDL ی (CREATE SCHEMA/TABLE) نمی‌فرستند", async () => {
    for (const run of [(db: KbDatabase) => migrate(db, "legal_kb_y"), (db: KbDatabase) => migrateSearch(db, "legal_kb_y")]) {
      const { db, calls } = fakeDb((c) => (isNsSelect(c) ? new Error("down") : { rows: [] }));
      const res = await run(db);
      expect(res.ok).toBe(false);
      expect(calls.some((c) => /^(CREATE SCHEMA|CREATE TABLE|ALTER|DROP)/i.test(c.text.trim()))).toBe(false);
    }
  });

  it("پاسخِ نامعتبرِ SELECT ⇒ هر دو CORRUPT_DATA (شکست‌بسته) و بی‌DDL", async () => {
    for (const run of [(db: KbDatabase) => migrate(db, "legal_kb_y"), (db: KbDatabase) => migrateSearch(db, "legal_kb_y")]) {
      const { db, calls } = fakeDb((c) => (isNsSelect(c) ? "malformed" : { rows: [] }));
      const res = await run(db);
      expect(!res.ok && res.error.code).toBe("CORRUPT_DATA");
      expect(calls.some((c) => /^(CREATE SCHEMA|CREATE TABLE)/i.test(c.text.trim()))).toBe(false);
    }
  });
});
