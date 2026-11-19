/**
 * گلوی `instrumentation` (ADR-0033): فقط نگهبانِ زمانِ‌اجرا و واگذاری. منطقِ اصلی در settlement-bootstrap آزموده می‌شود.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ registerSettlement: vi.fn(async () => undefined) }));
vi.mock("./instrumentation-node", () => ({ registerSettlement: hoisted.registerSettlement }));

import { register } from "./instrumentation";

afterEach(() => {
  vi.unstubAllEnvs();
  hoisted.registerSettlement.mockReset();
  hoisted.registerSettlement.mockImplementation(async () => undefined);
});

describe("instrumentation · register", () => {
  it("در runtime «nodejs» رفتگر را یک بار واگذار می‌کند", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "phase-production-server");
    await register();
    expect(hoisted.registerSettlement).toHaveBeenCalledTimes(1);
  });

  it.each(["edge", "", "browser"])("در runtime «%s» هیچ کاری نمی‌کند (لبه بی‌پایگاه و بی‌process است)", async (rt) => {
    vi.stubEnv("NEXT_RUNTIME", rt);
    await register();
    expect(hoisted.registerSettlement).not.toHaveBeenCalled();
  });

  it("بدونِ NEXT_RUNTIME هیچ کاری نمی‌کند", async () => {
    vi.stubEnv("NEXT_RUNTIME", undefined as unknown as string);
    delete process.env["NEXT_RUNTIME"];
    await register();
    expect(hoisted.registerSettlement).not.toHaveBeenCalled();
  });

  it("در فازِ ساختِ تولید (next build) هرگز رفتگر را نمی‌سازد", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    await register();
    expect(hoisted.registerSettlement).not.toHaveBeenCalled();
  });
});
