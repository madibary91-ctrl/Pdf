/**
 * سیم‌کشیِ `registerToolPolicy` با `POLICY_DATABASE_URL` (ADR-0083). آزمونِ موجودِ `instrumentation-policy.test.ts` دست‌نخورده است
 * (متغیر نبود ⇒ همان `openSharedDatabase`)؛ این‌جا فقط حالتِ جدا.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  start: vi.fn(async (_cfg: unknown) => ({ status: "disabled" as const })),
  dbLoaded: vi.fn(),
}));
vi.mock("@/modules/tool-policy-bootstrap", () => ({ startToolPolicyBootstrap: hoisted.start }));
vi.mock("@/db", () => {
  hoisted.dbLoaded();
  return { db: {}, pool: { end: async () => undefined } };
});

import { registerToolPolicy } from "./instrumentation-policy";
import { openSharedDatabase } from "./instrumentation-shared";

const opener = (): (() => Promise<unknown>) => (hoisted.start.mock.calls[0]?.[0] as { openDatabase: () => Promise<unknown> }).openDatabase;

beforeEach(() => {
  hoisted.start.mockClear();
  hoisted.dbLoaded.mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("registerToolPolicy · استخرِ اختصاصی", () => {
  it("POLICY_DATABASE_URL تنظیم‌شده ⇒ openDatabase همان openSharedDatabase نیست", async () => {
    vi.stubEnv("POLICY_DATABASE_URL", "postgresql://u:p@127.0.0.1:1/db");
    await registerToolPolicy();
    expect(opener()).not.toBe(openSharedDatabase);
  });

  it("نبود/خالی ⇒ همان openSharedDatabase (رفتارِ امروز)", async () => {
    vi.stubEnv("POLICY_DATABASE_URL", "");
    await registerToolPolicy();
    expect(opener()).toBe(openSharedDatabase);
  });

  it("رشتهٔ نامعتبر ⇒ بازکننده می‌پرتابد، @/db بارگذاری نمی‌شود و لاگِ config-invalid (بی‌مقدار) روی console.log می‌رود", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubEnv("POLICY_DATABASE_URL", "mysql://leaky:topsecret@h/db");
    await registerToolPolicy();
    await expect(opener()()).rejects.toThrow("POLICY_DATABASE_URL_INVALID");
    expect(hoisted.dbLoaded).not.toHaveBeenCalled();
    const lines = spy.mock.calls.map((c) => c[0] as string);
    expect(lines.map((l) => JSON.parse(l))).toEqual([{ scope: "tool-policy", type: "pool.config-invalid", env: "POLICY_DATABASE_URL" }]);
    expect(lines.join("")).not.toContain("topsecret");
  });
});
