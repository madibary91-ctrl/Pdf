import { describe, expect, it } from "vitest";
import { ADMIN_LIMITS, checkActor, isSafeInt, normalizeReason, parseRecord, readFields } from "./validate";
import { deepFrozen, sampleRecord } from "./test-kit";

describe("tool-policy-admin/validate · actor", () => {
  it("شناسه‌های معتبر", () => {
    for (const a of ["a", "admin:alice", "svc.policy-bot", "u@example", "A1_b", "x".repeat(128)]) expect(checkActor(a), a).toBe(true);
  });
  it("نامعتبر: تهی، فاصله، آغازِ نمادین، بلند، غیرِ لاتین، غیررشته", () => {
    for (const a of ["", " a", "a b", "-a", ".a", "x".repeat(129), "علی", "a\n", "a/b", 5, null, undefined, {}]) expect(checkActor(a), String(a)).toBe(false);
  });
});

describe("tool-policy-admin/validate · reason", () => {
  it("trim می‌شود و متنِ فارسی با نیم‌فاصله مجاز است", () => {
    expect(normalizeReason("  افزایش مهلت‌ها  ")).toBe("افزایش مهلت‌ها");
    expect(normalizeReason("a")).toBe("a");
  });
  it("مرزِ طول: ۵۰۰ مجاز، ۵۰۱ رد", () => {
    expect(normalizeReason("x".repeat(ADMIN_LIMITS.maxReasonChars))).not.toBeNull();
    expect(normalizeReason("x".repeat(ADMIN_LIMITS.maxReasonChars + 1))).toBeNull();
  });
  it("تهی/فقط‌فاصله/غیررشته رد", () => {
    for (const r of ["", "   ", "\t", 5, null, undefined, {}]) expect(normalizeReason(r)).toBeNull();
  });
  it("کنترل‌ها، جداکنندهٔ خط/بند و کنترل‌های جهتِ دوسویه رد (Trojan Source)", () => {
    for (const bad of ["a\nb", "a\u0000b", "a\u007fb", "a\u2028b", "a\u2029b", "a\u202eb", "a\u202ab", "a\u2066b", "a\u2069b", "a\u0085b"]) expect(normalizeReason(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("tool-policy-admin/validate · isSafeInt", () => {
  it("مرزها", () => {
    expect(isSafeInt(0, 0)).toBe(true);
    expect(isSafeInt(-1, 0)).toBe(false);
    expect(isSafeInt(1, 1)).toBe(true);
    expect(isSafeInt(0, 1)).toBe(false);
    for (const v of [1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null]) expect(isSafeInt(v, 0)).toBe(false);
    expect(isSafeInt(Number.MAX_SAFE_INTEGER, 0)).toBe(true);
  });
});

describe("tool-policy-admin/validate · readFields", () => {
  it("کلیدهای مجاز خوانده می‌شوند؛ ناشناخته گزارش و مقدارش بازتاب نمی‌شود", () => {
    const r = readFields({ a: 1, SECRETKEY: "hunter2" }, ["a"]);
    expect(r.values.get("a")).toBe(1);
    expect(r.issues).toHaveLength(1);
    expect(r.issues.join()).not.toContain("hunter2");
  });
  it("کلیدِ ناشناختهٔ بلند بریده می‌شود", () => {
    const r = readFields({ ["k".repeat(500)]: 1 }, ["a"]);
    expect(r.issues[0]!.length).toBeLessThan(120);
  });
  it("غیرِ شیء/آرایه/Proxy پرتاب‌کننده ⇒ مشکل، بی‌استثنا", () => {
    for (const v of [null, undefined, 5, "x", []]) expect(readFields(v, ["a"]).issues).toHaveLength(1);
    expect(readFields(new Proxy({}, { ownKeys: () => { throw new Error("x"); } }), ["a"]).issues).toHaveLength(1);
  });
  it("هر کلید یک‌بار خوانده می‌شود", () => {
    let n = 0;
    readFields({ get a() { n++; return 1; } }, ["a"]);
    expect(n).toBe(1);
  });
});

describe("tool-policy-admin/validate · parseRecord", () => {
  it("رکوردِ معتبر ⇒ برابر، مستقل و عمیق‌یخ‌زده", () => {
    const src = sampleRecord(3, { overrides: { timing: { graceMs: 60_000 } } as never });
    const r = parseRecord(src)!;
    expect(r).toEqual(src);
    expect(r).not.toBe(src);
    expect(deepFrozen(r)).toBe(true);
  });
  it("منبعِ rollback معتبر: toVersion ≤ version", () => {
    expect(parseRecord(sampleRecord(3, { source: { kind: "rollback", toVersion: 3 } }))).not.toBeNull();
    expect(parseRecord(sampleRecord(3, { source: { kind: "rollback", toVersion: 1 } }))).not.toBeNull();
  });
  it("بازگشتیِ jsonb با ترتیبِ کلیدِ دیگر پذیرفته می‌شود", () => {
    const src = sampleRecord(1);
    const shuffled = Object.fromEntries(Object.entries(src).reverse());
    expect(parseRecord(shuffled)).toEqual(src);
  });

  const bad: [string, (r: Record<string, unknown>) => unknown][] = [
    ["version صفر", (r) => ({ ...r, version: 0 })],
    ["version اعشاری", (r) => ({ ...r, version: 1.5 })],
    ["version رشته", (r) => ({ ...r, version: "1" })],
    ["کلیدِ اضافه", (r) => ({ ...r, extra: 1 })],
    ["کلیدِ کم", (r) => { const { reason: _r, ...rest } = r; return rest; }],
    ["actor بد", (r) => ({ ...r, actor: "a b" })],
    ["reason با فاصلهٔ ابتدا", (r) => ({ ...r, reason: " x" })],
    ["reason تهی", (r) => ({ ...r, reason: "" })],
    ["reason بلند", (r) => ({ ...r, reason: "x".repeat(501) })],
    ["createdAtMs منفی", (r) => ({ ...r, createdAtMs: -1 })],
    ["createdAtMs اعشاری", (r) => ({ ...r, createdAtMs: 1.5 })],
    ["rollback با toVersion بزرگ‌تر", (r) => ({ ...r, version: 2, source: { kind: "rollback", toVersion: 3 } })],
    ["rollback با toVersion صفر", (r) => ({ ...r, source: { kind: "rollback", toVersion: 0 } })],
    ["منبعِ ناشناخته", (r) => ({ ...r, source: { kind: "x" } })],
    ["منبعِ set با کلیدِ اضافه", (r) => ({ ...r, source: { kind: "set", toVersion: 1 } })],
    ["منبع رشته", (r) => ({ ...r, source: "set" })],
    ["changes غیرآرایه", (r) => ({ ...r, changes: {} })],
    ["changes بیش از سقف", (r) => ({ ...r, changes: Array.from({ length: ADMIN_LIMITS.maxChanges + 1 }, (_, i) => ({ path: `a.b${i}`, from: 1, to: 2 })) })],
    ["change با کلیدِ اضافه", (r) => ({ ...r, changes: [{ path: "a.b", from: 1, to: 2, x: 1 }] })],
    ["change با مسیرِ بلند", (r) => ({ ...r, changes: [{ path: "a".repeat(65), from: 1, to: 2 }] })],
    ["change با from شیء", (r) => ({ ...r, changes: [{ path: "a.b", from: {}, to: 2 }] })],
    ["change با مسیرِ تهی", (r) => ({ ...r, changes: [{ path: "", from: 1, to: 2 }] })],
    ["overrides غیرشیء", (r) => ({ ...r, overrides: [] })],
    ["overrides با برگِ بولی", (r) => ({ ...r, overrides: { a: { b: true } } })],
    ["overrides با بخشِ اولیه", (r) => ({ ...r, overrides: { a: 1 } })],
    ["overrides تودرتوِ بیش از حد", (r) => ({ ...r, overrides: { a: { b: { c: 1 } } } })],
    ["policy با برگِ null", (r) => ({ ...r, policy: { a: { b: null } } })],
    ["عددِ NaN", (r) => ({ ...r, overrides: { a: { b: Number.NaN } } })],
    ["عددِ بی‌نهایت", (r) => ({ ...r, policy: { a: { b: Infinity } } })],
    ["رشتهٔ بسیار بلند", (r) => ({ ...r, overrides: { a: { b: "x".repeat(2001) } } })],
    ["تابع", (r) => ({ ...r, overrides: { a: { b: () => 1 } } })],
    ["نمونهٔ کلاس", (r) => ({ ...r, overrides: new (class A { x = 1; })() })],
    ["__proto__", () => JSON.parse('{"version":1,"overrides":{"__proto__":{}},"policy":{},"changes":[],"source":{"kind":"set"},"actor":"a","reason":"r","createdAtMs":1}')],
  ];
  for (const [name, mut] of bad) {
    it(`خراب ⇒ null: ${name}`, () => {
      expect(parseRecord(mut({ ...sampleRecord(1) }))).toBeNull();
    });
  }
  it("غیرِ شیء، null، آرایه و Proxy پرتاب‌کننده ⇒ null بی‌استثنا", () => {
    for (const v of [null, undefined, 5, "x", [], new Proxy({}, { ownKeys: () => { throw new Error("x"); } })]) expect(parseRecord(v)).toBeNull();
  });
  it("بودجهٔ گره‌ها: رکوردِ بسیار بزرگ رد می‌شود", () => {
    const big = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, { a: 1 }]));
    expect(parseRecord({ ...sampleRecord(1), overrides: big })).toBeNull();
  });
});
