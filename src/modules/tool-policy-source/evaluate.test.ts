import { describe, expect, it } from "vitest";
import { evaluate, stable } from "./evaluate";
import { okCurrent, policyFor } from "./test-kit";

/** کلیدها را به‌طور عمیق وارونه می‌کند (jsonb ترتیبِ کلید را عوض می‌کند). */
function reversed(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reversed);
  if (typeof v !== "object" || v === null) return v;
  return Object.fromEntries(
    Object.entries(v)
      .reverse()
      .map(([k, x]) => [k, reversed(x)]),
  );
}

describe("tool-policy-source · evaluate (داورِ خالص)", () => {
  it("stable مستقل از ترتیبِ کلید، حساس به آرایه و مقدار، و برای نامتناهی علامتِ جدا", () => {
    expect(stable({ a: 1, b: { c: [1, 2], d: "x" } })).toBe(stable({ b: { d: "x", c: [1, 2] }, a: 1 }));
    expect(stable([1, 2])).not.toBe(stable([2, 1]));
    expect(stable([1, 2])).not.toBe(stable([]));
    expect(stable({ a: [1] })).not.toBe(stable({ a: [2] }));
    expect(stable({ a: 1 })).not.toBe(stable({ a: 2 }));
    expect(stable(Infinity)).not.toBe(stable(1));
    expect(stable(NaN)).toBe(stable(Infinity));
    expect(stable(undefined)).toBe("!");
  });

  it("سیاستِ کامل با ترتیبِ کلیدِ دیگر (مثل jsonb) پذیرفته می‌شود و projection یکسان است", () => {
    const base = okCurrent(2);
    if (!base.ok) throw new Error("x");
    const shuffled = { ok: true, value: { ...base.value, policy: reversed(policyFor(2)) } };
    const a = evaluate(base, null);
    const b = evaluate(shuffled, null);
    expect(a.kind).toBe("accept");
    expect(b.kind).toBe("accept");
    if (a.kind === "accept" && b.kind === "accept") expect(b.candidate.fingerprint).toBe(a.candidate.fingerprint);
  });

  it("پاسخِ ok غیرِ true (رشته/غایب) حتی با value معتبر پذیرفته نمی‌شود", () => {
    const base = okCurrent(1);
    if (!base.ok) throw new Error("x");
    for (const flag of ["yes", 1, undefined, null, "true"]) {
      const d = evaluate({ ok: flag, value: base.value }, null);
      expect(d, String(flag)).toEqual({ kind: "reject", code: "INVALID_RESPONSE" });
    }
    expect(evaluate({ value: base.value }, null)).toEqual({ kind: "reject", code: "INVALID_RESPONSE" });
  });

  it("نسخهٔ یکسان با اثرانگشتِ یکسان unchanged؛ بالاتر updated؛ پایین‌تر رد", () => {
    const first = evaluate(okCurrent(3), null);
    if (first.kind !== "accept") throw new Error("x");
    const held = { ...first.candidate, loadedAtMs: 1, confirmedAtMs: 1 };
    expect(evaluate(okCurrent(3), held)).toMatchObject({ kind: "accept", outcome: "unchanged" });
    expect(evaluate(okCurrent(4), held)).toMatchObject({ kind: "accept", outcome: "updated" });
    expect(evaluate(okCurrent(2), held)).toEqual({ kind: "reject", code: "VERSION_REGRESSED" });
    expect(evaluate(okCurrent(3, 5), held)).toEqual({ kind: "reject", code: "VERSION_CONTENT_MISMATCH" });
  });
});
