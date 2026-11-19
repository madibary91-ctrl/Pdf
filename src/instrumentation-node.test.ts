/**
 * ترکیبِ سمتِ Node (ADR-0033): ورودی‌های دقیقِ startSettlementBootstrap، لاگِ ساختاریافته، بازشدنِ تنبلِ پایگاه و صاحبِ خروجِ فرایند.
 * ماژولِ bootstrap و `@/db` ساختگی‌اند؛ با پایگاهِ واقعی در smoke (tooling/smoke) و آزمونِ pg ماژول سنجیده می‌شوند.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  start: vi.fn(async (_cfg: unknown) => ({ status: "disabled" as const })),
  dbLoaded: vi.fn(),
  end: vi.fn(async () => undefined),
}));
vi.mock("@/modules/settlement-bootstrap", () => ({ startSettlementBootstrap: hoisted.start }));
vi.mock("@/db", () => {
  hoisted.dbLoaded();
  return { db: { tag: "db" }, pool: { end: hoisted.end } };
});

import { registerSettlement } from "./instrumentation-node";

type Cfg = { env: unknown; store: unknown; processOwner: string; openDatabase: () => Promise<{ db: unknown; close: () => unknown }>; log: (e: unknown) => unknown };
const cfg = (): Cfg => hoisted.start.mock.calls[0]?.[0] as Cfg;

beforeEach(() => {
  hoisted.start.mockClear();
  hoisted.dbLoaded.mockClear();
  hoisted.end.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("instrumentation-node · registerSettlement", () => {
  it("process.env و globalThis را بی‌واسطه می‌دهد و منتظر می‌ماند", async () => {
    await registerSettlement();
    expect(hoisted.start).toHaveBeenCalledTimes(1);
    expect(cfg().env).toBe(process.env);
    expect(cfg().store).toBe(globalThis);
  });

  it("پایگاه تنبل است: تا openDatabase صدا نخورد @/db بارگذاری نمی‌شود (پیش‌فرضِ خاموش اتصال نمی‌سازد)", async () => {
    await registerSettlement();
    expect(hoisted.dbLoaded).not.toHaveBeenCalled();
    const opened = await cfg().openDatabase();
    expect(hoisted.dbLoaded).toHaveBeenCalledTimes(1);
    expect(opened.db).toEqual({ tag: "db" });
    expect(hoisted.end).not.toHaveBeenCalled();
    await opened.close();
    expect(hoisted.end).toHaveBeenCalledTimes(1);
  });

  it("NEXT_MANUAL_SIG_HANDLE تنظیم‌شده ⇒ ما صاحبِ خروجیم (همان شرطِ درستیِ رشتهٔ Next)", async () => {
    for (const v of ["1", "true", "0", "x"]) {
      vi.stubEnv("NEXT_MANUAL_SIG_HANDLE", v);
      hoisted.start.mockClear();
      await registerSettlement();
      expect(cfg().processOwner, v).toBe("host");
    }
  });

  it("NEXT_MANUAL_SIG_HANDLE نبود یا خالی ⇒ Next صاحبِ خروج است", async () => {
    vi.stubEnv("NEXT_MANUAL_SIG_HANDLE", "");
    await registerSettlement();
    expect(cfg().processOwner).toBe("next");
    hoisted.start.mockClear();
    delete process.env["NEXT_MANUAL_SIG_HANDLE"];
    await registerSettlement();
    expect(cfg().processOwner).toBe("next");
  });

  it("لاگ یک خطِ JSON با scope=settlement روی console.log است و رویداد را بی‌تغییر نگه می‌دارد", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await registerSettlement();
    cfg().log({ type: "bootstrap.disabled" });
    cfg().log({ type: "bootstrap.failed", code: "INVALID_ENV", issues: ["SETTLEMENT_HOST باید on یا off باشد."] });
    expect(spy.mock.calls.map((c) => JSON.parse(c[0] as string))).toEqual([
      { scope: "settlement", type: "bootstrap.disabled" },
      { scope: "settlement", type: "bootstrap.failed", code: "INVALID_ENV", issues: ["SETTLEMENT_HOST باید on یا off باشد."] },
    ]);
  });

  it("پیش‌فرضِ واقعی (بدونِ SETTLEMENT_HOST) با ماژولِ واقعی هیچ میزبان و اتصالی نمی‌سازد", async () => {
    vi.resetModules();
    vi.doUnmock("@/modules/settlement-bootstrap");
    vi.stubEnv("SETTLEMENT_HOST", "");
    delete process.env["SETTLEMENT_HOST"];
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const real = await import("./instrumentation-node");
    const { getSettlementHost } = await import("@/modules/settlement-host");
    await real.registerSettlement();
    expect(getSettlementHost(globalThis)).toBeNull();
    expect(hoisted.dbLoaded).not.toHaveBeenCalled();
    expect(spy.mock.calls.map((c) => JSON.parse(c[0] as string))).toEqual([{ scope: "settlement", type: "bootstrap.disabled" }]);
  });
});
