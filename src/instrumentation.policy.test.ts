/**
 * ثبتِ میزبانِ سیاست در `register()` (ADR-0076): بعد از تسویه، مستقل از آن؛ شکستِ سیاست هرگز بوتِ سرور را نمی‌شکند؛
 * در لبه و در ساختِ تولید هیچ‌کدام اجرا نمی‌شود. (آزمونِ موجودِ `instrumentation.test.ts` دست‌نخورده است.)
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ order: [] as string[], registerSettlement: vi.fn(async () => undefined), registerToolPolicy: vi.fn(async () => undefined) }));
vi.mock("./instrumentation-node", () => ({
  registerSettlement: async () => {
    hoisted.order.push("settlement");
    await hoisted.registerSettlement();
  },
}));
vi.mock("./instrumentation-policy", () => ({
  registerToolPolicy: async () => {
    hoisted.order.push("policy");
    await hoisted.registerToolPolicy();
  },
}));

import { register } from "./instrumentation";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  hoisted.order.length = 0;
  hoisted.registerSettlement.mockReset();
  hoisted.registerSettlement.mockImplementation(async () => undefined);
  hoisted.registerToolPolicy.mockReset();
  hoisted.registerToolPolicy.mockImplementation(async () => undefined);
});

describe("instrumentation · register · میزبانِ سیاست", () => {
  it("در nodejs: اول تسویه، بعد سیاست (هر کدام یک بار)", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "phase-production-server");
    await register();
    expect(hoisted.order).toEqual(["settlement", "policy"]);
  });

  it.each(["edge", "", "browser"])("در runtime «%s» هیچ‌کدام اجرا نمی‌شود", async (rt) => {
    vi.stubEnv("NEXT_RUNTIME", rt);
    await register();
    expect(hoisted.order).toEqual([]);
  });

  it("در فازِ ساختِ تولید هیچ‌کدام اجرا نمی‌شود (next build پایگاه باز نمی‌کند)", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    await register();
    expect(hoisted.order).toEqual([]);
  });

  it("پرتابِ سیاست register را نمی‌شکند و فقط یک خطِ ثابتِ بی‌متنِ خطا لاگ می‌شود", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "phase-production-server");
    hoisted.registerToolPolicy.mockRejectedValue(new Error("LEAK-CANARY-register"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(register()).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spy.mock.calls[0]?.[0] as string)).toEqual({ scope: "tool-policy", type: "register.crashed" });
    expect(String(spy.mock.calls[0]?.[0])).not.toContain("LEAK-CANARY");
  });

  it("پرتابِ تسویه همچنان به‌همان شکلِ قبل منتشر می‌شود و سیاست اجرا نمی‌شود (رفتارِ موجود بی‌تغییر)", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "phase-production-server");
    hoisted.registerSettlement.mockRejectedValue(new Error("settlement"));
    await expect(register()).rejects.toThrow("settlement");
    expect(hoisted.order).toEqual(["settlement"]);
  });
});
