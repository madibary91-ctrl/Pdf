/**
 * شاخه‌های دفاعیِ پیش‌بازرسی که با ورودیِ عادی نمی‌رسند (resolve سالم ولی نگاشت/اعتبارسنجیِ مجدد رد کند ⇒ یعنی باگ در tool-policy).
 * با `vi.mock` فقط فراخوانیِ شمارهٔ مشخصی از `projectToolPolicy` دست‌کاری می‌شود.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBuild } from "./test-kit";

const hooks: { replace: Map<number, unknown>; n: number } = { replace: new Map(), n: 0 };

vi.mock("@/modules/tool-policy", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/modules/tool-policy")>();
  return {
    ...mod,
    projectToolPolicy: (policy?: unknown) => {
      hooks.n += 1;
      return hooks.replace.has(hooks.n) ? hooks.replace.get(hooks.n) : mod.projectToolPolicy(policy);
    },
  };
});

import { preflightToolPolicy } from "./preflight";

beforeEach(() => {
  hooks.replace = new Map();
  hooks.n = 0;
});

describe("tool-policy-preflight · شاخه‌های دفاعی", () => {
  it("نگاشتِ سیاست شکست بخورد ⇒ PROJECTION_INVALID بی‌ساخت", () => {
    hooks.replace.set(1, { ok: false, error: { code: "INVALID_POLICY", message: "x", issues: ["y"] } });
    const t = fakeBuild();
    const r = preflightToolPolicy({ overrides: {}, build: t.build });
    expect(!r.ok && r.error.stage).toBe("PROJECTION_INVALID");
    expect(t.state.calls).toHaveLength(0);
  });

  it("projectionِ بدشکل از نگاشت ⇒ اعتبارسنجیِ مجددِ پیوند رد می‌کند ⇒ PROJECTION_INVALID بی‌ساخت", () => {
    hooks.replace.set(1, { ok: true, value: { loop: {}, extra: 1 } });
    const t = fakeBuild();
    const r = preflightToolPolicy({ overrides: {}, build: t.build });
    expect(!r.ok && r.error.stage).toBe("PROJECTION_INVALID");
    expect(t.state.calls).toHaveLength(0);
  });

  it("بدون دست‌کاری همین مسیر سالم است (شاهدِ آزمون)", () => {
    const t = fakeBuild();
    expect(preflightToolPolicy({ overrides: {}, build: t.build }).ok).toBe(true);
    expect(hooks.n).toBe(2); // یک بار نگاشتِ پیش‌بازرسی، یک بار اعتبارسنجیِ مجددِ پیوند
  });
});
