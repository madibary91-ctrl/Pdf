/**
 * قراردادهای نامرئیِ نگهبانِ `error`ِ استخرِ مشترک (ADR-0084) که با آزمونِ واحد/PG دیده نمی‌شوند:
 *  ۱) `@/db` واقعاً نگهبان را روی استخرِ خودش می‌نصبد (حذفِ یک خط از `src/db/index.ts` بی‌آزمونِ PostgreSQL هم قرمز شود)،
 *     یک‌باره: دوباره‌ارزیابیِ ماژول (HMR) با استخرِ cache‌شدهٔ `globalThis` شنونده را دو برابر نمی‌کند؛
 *  ۲) نصب پیش از `drizzle(pool)` و بعد از ساختِ استخر است (هیچ پنجره‌ای بی‌شنونده نیست)؛
 *  ۳) کدِ نگهبان `message`/`stack` را نمی‌خواند و فرایند را نمی‌بُرد؛
 *  ۴) مستندات (ریسک، ADR، خطاهای شناخته‌شده) فایل و رویداد را می‌گویند.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");
const GLOBAL_KEY = "__arenaNextJsPostgresqlPool";

describe("db-pool-error-guard · سیم‌کشیِ @/db", () => {
  afterEach(async () => {
    const g = globalThis as unknown as Record<string, { end?: () => Promise<void> } | undefined>;
    await g[GLOBAL_KEY]?.end?.();
    delete g[GLOBAL_KEY];
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("@/db نگهبان را روی استخرِ خودش می‌نصبد (یک error، یک connect) بی‌آن‌که اتصال بسازد", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@127.0.0.1:1/none");
    const { pool } = await import("@/db");
    expect(pool.listenerCount("error")).toBe(1);
    expect(pool.listenerCount("connect")).toBe(1);
    expect(pool.totalCount).toBe(0);
  });

  it("دوباره‌ارزیابیِ ماژول (HMR) با همان استخرِ globalThis شنونده را دو برابر نمی‌کند", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://u:p@127.0.0.1:1/none");
    const first = (await import("@/db")).pool;
    vi.resetModules();
    const second = (await import("@/db")).pool;
    expect(second).toBe(first);
    expect(second.listenerCount("error")).toBe(1);
    expect(second.listenerCount("connect")).toBe(1);
  });

  it("بدونِ DATABASE_URL همچنان می‌پرتابد (رفتارِ موجود بی‌تغییر)", async () => {
    vi.stubEnv("DATABASE_URL", "");
    await expect(import("@/db")).rejects.toThrow("DATABASE_URL is required");
  });
});

describe("db-pool-error-guard · ترتیبِ نصب در src/db/index.ts", () => {
  const src = stripComments(read("src/db/index.ts"));
  it("پس از ساختِ استخر و پیش از drizzle(pool) نصب می‌شود", () => {
    const make = src.indexOf("new Pool(");
    const install = src.indexOf("installPoolErrorGuard(pool)");
    const wrap = src.indexOf("drizzle(pool)");
    expect(make).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(make);
    expect(wrap).toBeGreaterThan(install);
  });
  it("از همان ماژولِ هم‌جوار import می‌شود", () => {
    expect(src).toContain('from "./pool-error-guard"');
  });
});

describe("db-pool-error-guard · کدِ نگهبان", () => {
  const code = stripComments(read("src/db/pool-error-guard.ts"));
  it("message/stack را نمی‌خواند، فرایند را نمی‌بُرد و رشتهٔ اتصال/env نمی‌خواند", () => {
    expect(code).not.toMatch(/\.message\b/);
    expect(code).not.toMatch(/\.stack\b/);
    expect(code).not.toMatch(/process\.(exit|env)/);
    expect(code).not.toMatch(/DATABASE_URL|connectionString/);
  });
  it("هیچ وابستگیِ تازه‌ای نیاورده (فقط نوعِ node:events)", () => {
    const imports = [...code.matchAll(/^import\s.*$/gm)].map((m) => m[0]);
    expect(imports).toEqual(['import type { EventEmitter } from "node:events";']);
  });
});

describe("db-pool-error-guard · مستندات", () => {
  it("high-risk-areas فایلِ نگهبان را نام می‌برد", () => {
    expect(read("docs/high-risk-areas.md")).toContain("src/db/pool-error-guard.ts");
  });
  it("ADR-0084 دو مسیرِ خطا و رویدادِ لاگ را می‌گوید", () => {
    const adr = read("docs/adr/0084-shared-pool-error-guard.md");
    for (const needle of ["db.pool.error", "pool.on(\"error\")", "connect", "57P01", "Symbol.for"]) expect(adr, needle).toContain(needle);
  });
  it("known-pitfalls خطرِ استخرِ بی‌شنونده را ثبت کرده", () => {
    expect(read("docs/known-pitfalls.md")).toContain("pool-error-guard");
  });
});
