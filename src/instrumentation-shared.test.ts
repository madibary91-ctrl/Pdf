/**
 * بخشِ مشترکِ گلوی Node (ADR-0076): استخرِ اجاره‌ایِ `@/db` تنبل و شمارشی؛ خروجِ هماهنگ به `process.exit` وصل است ولی این‌جا هرگز صدا زده نمی‌شود.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ dbLoaded: vi.fn(), end: vi.fn(async () => undefined) }));
vi.mock("@/db", () => {
  hoisted.dbLoaded();
  return { db: { tag: "db" }, pool: { end: hoisted.end } };
});

import { openSharedDatabase, sharedExit } from "./instrumentation-shared";

beforeEach(() => {
  hoisted.end.mockClear();
});

describe("instrumentation-shared · openSharedDatabase", () => {
  it("db را می‌دهد و close فقط وقتی آخرین اجاره‌دار است pool.end می‌زند", async () => {
    const a = await openSharedDatabase();
    const b = await openSharedDatabase();
    expect(a.db).toEqual({ tag: "db" });
    await a.close();
    expect(hoisted.end).not.toHaveBeenCalled();
    await b.close();
    expect(hoisted.end).toHaveBeenCalledTimes(1);
  });

  it("پس از بسته‌شدنِ استخر اجارهٔ تازه می‌پرتابد (بوت DATABASE_UNAVAILABLE می‌شود)", async () => {
    await expect(openSharedDatabase()).rejects.toThrow("POOL_ENDED");
  });
});

describe("instrumentation-shared · sharedExit", () => {
  it("تابع است و بی‌هم‌تایی در ظرف، process.exit را با کد صدا می‌زند", () => {
    expect(typeof sharedExit).toBe("function");
    const spy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      sharedExit(0);
      expect(spy).toHaveBeenCalledWith(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("کدِ شکست (۱) را حفظ می‌کند", () => {
    const spy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      sharedExit(1);
      expect(spy).toHaveBeenLastCalledWith(1);
    } finally {
      spy.mockRestore();
    }
  });
});
