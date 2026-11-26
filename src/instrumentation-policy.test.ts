/**
 * گلوی میزبانِ سیاستِ ابزار (ADR-0076): ورودی‌های دقیقِ startToolPolicyBootstrap، لاگِ ساختاریافته، پایگاهِ اجاره‌ایِ تنبل و صاحبِ خروج.
 * ماژولِ bootstrap ساختگی است؛ با پایگاهِ واقعی در `tooling/tool-policy-bootstrap.pg.test.ts` سنجیده می‌شود.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  start: vi.fn(async (_cfg: unknown) => ({ status: "disabled" as const })),
  dbLoaded: vi.fn(),
  end: vi.fn(async () => undefined),
}));
vi.mock("@/modules/tool-policy-bootstrap", () => ({ startToolPolicyBootstrap: hoisted.start }));
vi.mock("@/db", () => {
  hoisted.dbLoaded();
  return { db: { tag: "db" }, pool: { end: hoisted.end } };
});

import { openSharedDatabase, sharedExit } from "./instrumentation-shared";
import { registerToolPolicy } from "./instrumentation-policy";

type Cfg = { env: unknown; store: unknown; processOwner: string; exit: unknown; openDatabase: unknown; log: (e: unknown) => unknown };
const cfg = (): Cfg => hoisted.start.mock.calls[0]?.[0] as Cfg;

beforeEach(() => {
  hoisted.start.mockClear();
  hoisted.dbLoaded.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("instrumentation-policy · registerToolPolicy", () => {
  it("process.env و globalThis را بی‌واسطه می‌دهد، منتظر می‌ماند و یک بار صدا می‌زند", async () => {
    await registerToolPolicy();
    expect(hoisted.start).toHaveBeenCalledTimes(1);
    expect(cfg().env).toBe(process.env);
    expect(cfg().store).toBe(globalThis);
  });

  it("پایگاهِ اجاره‌ای و خروجِ هماهنگِ مشترک با تسویه را می‌دهد (نه تابعِ تازه)", async () => {
    await registerToolPolicy();
    expect(cfg().openDatabase).toBe(openSharedDatabase);
    expect(cfg().exit).toBe(sharedExit);
  });

  it("پایگاه تنبل است: تا openDatabase صدا نخورد @/db بارگذاری نمی‌شود", async () => {
    await registerToolPolicy();
    expect(hoisted.dbLoaded).not.toHaveBeenCalled();
  });

  it("NEXT_MANUAL_SIG_HANDLE تنظیم‌شده ⇒ ما صاحبِ خروجیم (همان شرطِ درستیِ رشته)", async () => {
    for (const v of ["1", "true", "0", "x"]) {
      vi.stubEnv("NEXT_MANUAL_SIG_HANDLE", v);
      hoisted.start.mockClear();
      await registerToolPolicy();
      expect(cfg().processOwner, v).toBe("host");
    }
  });

  it("NEXT_MANUAL_SIG_HANDLE نبود یا خالی ⇒ Next صاحبِ خروج است", async () => {
    vi.stubEnv("NEXT_MANUAL_SIG_HANDLE", "");
    await registerToolPolicy();
    expect(cfg().processOwner).toBe("next");
    hoisted.start.mockClear();
    delete process.env["NEXT_MANUAL_SIG_HANDLE"];
    await registerToolPolicy();
    expect(cfg().processOwner).toBe("next");
  });

  it("لاگ یک خطِ JSON با scope=tool-policy (نه settlement) روی console.log است و رویداد را بی‌تغییر نگه می‌دارد", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await registerToolPolicy();
    cfg().log({ type: "bootstrap.disabled" });
    cfg().log({ type: "bootstrap.failed", code: "INVALID_ENV", issues: ["TOOL_POLICY_HOST باید on یا off باشد."] });
    expect(spy.mock.calls.map((c) => JSON.parse(c[0] as string))).toEqual([
      { scope: "tool-policy", type: "bootstrap.disabled" },
      { scope: "tool-policy", type: "bootstrap.failed", code: "INVALID_ENV", issues: ["TOOL_POLICY_HOST باید on یا off باشد."] },
    ]);
  });

  it("پیش‌فرضِ واقعی (بدونِ TOOL_POLICY_HOST) با ماژولِ واقعی هیچ میزبان و اتصالی نمی‌سازد", async () => {
    vi.resetModules();
    vi.doUnmock("@/modules/tool-policy-bootstrap");
    delete process.env["TOOL_POLICY_HOST"];
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const real = await import("./instrumentation-policy");
    const { getToolPolicyHost } = await import("@/modules/tool-policy-host");
    await real.registerToolPolicy();
    expect(getToolPolicyHost(globalThis)).toBeNull();
    expect(hoisted.dbLoaded).not.toHaveBeenCalled();
    expect(spy.mock.calls.map((c) => JSON.parse(c[0] as string))).toEqual([{ scope: "tool-policy", type: "bootstrap.disabled" }]);
  });
});
