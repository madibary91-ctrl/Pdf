import { describe, expect, it } from "vitest";
import { createMemoryPolicyStore } from "./memory-store";
import { describePolicyStoreContract } from "./store-contract";
import { deepFrozen, sampleRecord } from "./test-kit";

describePolicyStoreContract("حافظه", async () => ({ store: createMemoryPolicyStore() }));

describe("tool-policy-admin/memory-store · ویژگی‌های خودش", () => {
  it("رکوردهای برگشتی عمیق‌یخ‌زده‌اند و دست‌کاری‌شان بی‌اثر/ممنوع است", async () => {
    const s = createMemoryPolicyStore();
    await s.append(sampleRecord(1));
    const g = await s.get(1);
    expect(g.ok && deepFrozen(g.value)).toBe(true);
    const l = await s.list({ beforeVersion: null, limit: 5 });
    expect(l.ok && Object.isFrozen(l.value)).toBe(true);
  });

  it("دو ذخیره‌ساز مستقل‌اند", async () => {
    const a = createMemoryPolicyStore();
    const b = createMemoryPolicyStore();
    await a.append(sampleRecord(1));
    expect(await b.latest()).toEqual({ ok: true, value: null });
  });

  it("کلیدِ __proto__ در رکورد رد می‌شود (INVALID) و پروتوتایپ آلوده نمی‌شود", async () => {
    const s = createMemoryPolicyStore();
    const evil = JSON.parse('{"version":1,"overrides":{"__proto__":{"x":1}},"policy":{},"changes":[],"source":{"kind":"set"},"actor":"a","reason":"r","createdAtMs":1}');
    expect(await s.append(evil)).toEqual({ ok: false, error: { code: "INVALID" } });
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });
});
