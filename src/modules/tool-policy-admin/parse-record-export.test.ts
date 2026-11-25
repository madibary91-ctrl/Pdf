import { describe, expect, it } from "vitest";
import * as api from "./index";
import { deepFrozen, sampleRecord } from "./test-kit";

describe("tool-policy-admin · parsePolicyRecord (صادرات برای آداپتورهای ذخیره‌ساز؛ ADR-0070)", () => {
  it("از رابط عمومی صادر می‌شود و رکوردِ معتبر را مستقل و عمیق‌یخ‌زده برمی‌گرداند", () => {
    const rec = sampleRecord(3, { source: { kind: "rollback", toVersion: 1 } });
    const out = api.parsePolicyRecord(rec);
    expect(out).toEqual(rec);
    expect(out).not.toBe(rec);
    expect(deepFrozen(out)).toBe(true);
  });

  it("رکوردِ بدشکل، فیلدِ اضافه، actor بد و rollback به نسخهٔ آینده ⇒ null", () => {
    expect(api.parsePolicyRecord(null)).toBeNull();
    expect(api.parsePolicyRecord({ ...sampleRecord(1), extra: 1 })).toBeNull();
    expect(api.parsePolicyRecord({ ...sampleRecord(1), actor: "x y" })).toBeNull();
    expect(api.parsePolicyRecord({ ...sampleRecord(1), source: { kind: "rollback", toVersion: 2 } })).toBeNull();
    expect(api.parsePolicyRecord({ ...sampleRecord(1), version: 0 })).toBeNull();
  });

  it("سطحِ صادراتِ عمومی فقط افزوده شده است (نام‌های قبلی هنوز هستند)", () => {
    for (const k of ["createToolPolicyAdmin", "createMemoryPolicyStore", "ADMIN_LIMITS", "ACTOR_RE", "parsePolicyRecord"]) expect(Object.keys(api), k).toContain(k);
  });
});
