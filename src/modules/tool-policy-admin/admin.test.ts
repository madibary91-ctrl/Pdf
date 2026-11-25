import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_POLICY } from "@/modules/tool-policy";
import { createToolPolicyAdmin } from "./admin";
import { createMemoryPolicyStore } from "./memory-store";
import { ACTOR, REASON, compat, deepFrozen, defaultsPolicy, fakeClock, newAdmin, rollback, sampleRecord, setPolicy, unwrap, wrapStore } from "./test-kit";
import type { HistoryPage, PolicyVersionRecord } from "./types";

const err = <T>(r: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: { code: string; issues: readonly string[]; currentVersion: number | null } }>) => {
  if (r.ok) throw new Error("خطا انتظار می‌رفت");
  return r.error;
};
const A = compat(60_000, 20_000);
const B = compat(120_000, 40_000);

describe("tool-policy-admin · ساخت", () => {
  it("پورتِ ناقص ⇒ INVALID_ARGUMENT", () => {
    for (const deps of [undefined, {}, { store: createMemoryPolicyStore() }, { clock: fakeClock() }, { store: {}, clock: fakeClock() }, { store: createMemoryPolicyStore(), clock: {} }, null]) {
      const r = createToolPolicyAdmin(deps as never);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error.code).toBe("INVALID_ARGUMENT");
    }
  });
  it("مدیرِ ساخته‌شده یخ‌زده است", () => {
    expect(Object.isFrozen(newAdmin().admin)).toBe(true);
  });
});

describe("tool-policy-admin · current", () => {
  it("بدون نسخه: پیش‌فرض‌های کد، نسخهٔ ۰، بی‌رانش", async () => {
    const { admin } = newAdmin();
    const c = unwrap(await admin.current());
    expect(c).toMatchObject({ version: 0, source: "defaults", drift: false, updatedAtMs: null, overrides: {} });
    expect(c.policy).toEqual(DEFAULT_TOOL_POLICY);
    expect(deepFrozen(c)).toBe(true);
  });
  it("پس از set: نسخهٔ ۱، سیاستِ مؤثر، بازنویسیِ کانونی، زمانِ ثبت", async () => {
    const { admin, clock } = newAdmin();
    unwrap(await setPolicy(admin, 0, A));
    const c = unwrap(await admin.current());
    expect(c).toMatchObject({ version: 1, source: "stored", drift: false, updatedAtMs: clock.nowMs() });
    expect(c.policy.timing).toEqual(A.timing);
    expect(c.policy.model.timeoutMs).toBe(20_000);
    expect(c.overrides).toEqual({ model: { timeoutMs: 20_000 }, timing: A.timing });
    expect(deepFrozen(c)).toBe(true);
  });
  it("رانش: عکسِ ذخیره‌شده با سیاستِ مؤثرِ کدِ جاری فرق دارد ⇒ drift=true و سیاستِ کدِ جاری برگردانده می‌شود", async () => {
    const store = createMemoryPolicyStore();
    const stale = { ...defaultsPolicy(), timing: { ...defaultsPolicy().timing, graceMs: 91_000 } };
    await store.append(sampleRecord(1, { overrides: {}, policy: stale as never }));
    const c = unwrap(await newAdmin(store).admin.current());
    expect(c.drift).toBe(true);
    expect(c.policy.timing.graceMs).toBe(DEFAULT_TOOL_POLICY.timing.graceMs);
  });
  it("سابقه‌ای که با کدِ جاری نامعتبر است ⇒ STORED_POLICY_INVALID (بسته‌شدنِ شکست، نه پیش‌فرضِ بی‌صدا) با currentVersion", async () => {
    const store = createMemoryPolicyStore();
    await store.append(sampleRecord(1, { overrides: { timing: { graceMs: 60_000 } } as never }));
    const e = err(await newAdmin(store).admin.current());
    expect(e.code).toBe("STORED_POLICY_INVALID");
    expect(e.currentVersion).toBe(1);
    expect(e.issues.length).toBeGreaterThan(0);
  });
  it("اصلاحِ سابقهٔ نامعتبر فقط با نسخهٔ تازه؛ سپس current سالم است", async () => {
    const store = createMemoryPolicyStore();
    await store.append(sampleRecord(1, { overrides: { timing: { graceMs: 60_000 } } as never }));
    const { admin } = newAdmin(store);
    const r = unwrap(await setPolicy(admin, 1, A));
    expect(r.version).toBe(2);
    expect(unwrap(await admin.current()).version).toBe(2);
    const h = unwrap(await admin.history());
    expect(h.entries.map((e) => e.version)).toEqual([2, 1]);
  });
  it("آخرین رکوردِ خراب ⇒ STORE_FAILURE (نه پیش‌فرض)", async () => {
    const store = wrapStore(createMemoryPolicyStore(), { latest: async () => ({ ok: true, value: { version: "x" } }) });
    expect(err(await newAdmin(store).admin.current()).code).toBe("STORE_FAILURE");
    expect(err(await setPolicy(newAdmin(store).admin, 0, A)).code).toBe("STORE_FAILURE");
  });
});

describe("tool-policy-admin · set", () => {
  it("نسخهٔ ۱: changes نسبت به پیش‌فرض‌های کد، مرتب و با مقدارِ مؤثر؛ بازیگر و دلیل ثبت می‌شود", async () => {
    const { admin, clock } = newAdmin();
    const r = unwrap(await setPolicy(admin, 0, A, { reason: `  ${REASON}  ` }));
    expect(r.version).toBe(1);
    expect(r.createdAtMs).toBe(clock.nowMs());
    expect(r.changes).toEqual([
      { path: "model.timeoutMs", from: 30_000, to: 20_000 },
      { path: "timing.graceMs", from: 90_000, to: 60_000 },
      { path: "timing.maxCallMs", from: 36_000, to: 24_000 },
      { path: "timing.reservationTtlMs", from: 360_000, to: 240_000 },
    ]);
    const h = unwrap(await admin.history());
    expect(h.entries[0]).toMatchObject({ version: 1, actor: ACTOR, reason: REASON, source: { kind: "set" } });
  });
  it("نسخهٔ ۲: changes نسبت به نسخهٔ پیشین (عکسِ ذخیره‌شده)", async () => {
    const { admin } = newAdmin();
    unwrap(await setPolicy(admin, 0, A));
    const r = unwrap(await setPolicy(admin, 1, B));
    expect(r.version).toBe(2);
    expect(r.changes).toContainEqual({ path: "timing.graceMs", from: 60_000, to: 120_000 });
    expect(r.changes).toContainEqual({ path: "model.timeoutMs", from: 20_000, to: 40_000 });
  });
  it("جایگزینیِ کامل است نه ادغام: کلیدی که در ورودیِ تازه نیست به پیش‌فرض برمی‌گردد", async () => {
    const { admin } = newAdmin();
    unwrap(await setPolicy(admin, 0, { ...A, loop: { maxSteps: 4 } }));
    unwrap(await setPolicy(admin, 1, A));
    const c = unwrap(await admin.current());
    expect(c.policy.loop.maxSteps).toBe(DEFAULT_TOOL_POLICY.loop.maxSteps);
    expect(c.overrides).toEqual({ model: { timeoutMs: 20_000 }, timing: A.timing });
  });
  it("{} ⇒ بازگشت به پیش‌فرض‌های کد (نسخهٔ تازه با بازنویسیِ تهی)", async () => {
    const { admin } = newAdmin();
    unwrap(await setPolicy(admin, 0, A));
    const r = unwrap(await setPolicy(admin, 1, {}));
    expect(r.version).toBe(2);
    expect(r.overrides).toEqual({});
    expect(r.policy).toEqual(DEFAULT_TOOL_POLICY);
    expect(r.changes).toHaveLength(4);
  });
  it("NO_CHANGE: {} در نسخهٔ ۰، و بازنویسیِ برابرِ نسخهٔ فعلی (حتی با ترتیبِ کلیدِ دیگر یا بخشِ خالی)؛ چیزی نوشته نمی‌شود", async () => {
    const store = wrapStore(createMemoryPolicyStore());
    const { admin } = newAdmin(store);
    expect(err(await setPolicy(admin, 0, {})).code).toBe("NO_CHANGE");
    expect(err(await setPolicy(admin, 0, { loop: {} })).code).toBe("NO_CHANGE");
    unwrap(await setPolicy(admin, 0, A));
    const reordered = { timing: { reservationTtlMs: A.timing["reservationTtlMs"], maxCallMs: A.timing["maxCallMs"], graceMs: A.timing["graceMs"] }, loop: {}, model: A.model };
    const e = err(await setPolicy(admin, 1, reordered));
    expect(e.code).toBe("NO_CHANGE");
    expect(e.currentVersion).toBe(1);
    expect(store.calls["append"]).toBe(1);
  });
  it("پین‌کردنِ مقدارِ پیش‌فرض نیتِ تازه است: نسخه ساخته می‌شود با changes تهی", async () => {
    const { admin } = newAdmin();
    const r = unwrap(await setPolicy(admin, 0, { timing: { graceMs: DEFAULT_TOOL_POLICY.timing.graceMs } }));
    expect(r.version).toBe(1);
    expect(r.changes).toEqual([]);
    expect(r.overrides).toEqual({ timing: { graceMs: DEFAULT_TOOL_POLICY.timing.graceMs } });
  });
  it("VERSION_CONFLICT: کهنه یا آینده؛ با currentVersion؛ چیزی نوشته نمی‌شود", async () => {
    const store = wrapStore(createMemoryPolicyStore());
    const { admin } = newAdmin(store);
    unwrap(await setPolicy(admin, 0, A));
    for (const expected of [0, 2, 5]) {
      const e = err(await setPolicy(admin, expected, B));
      expect(e.code).toBe("VERSION_CONFLICT");
      expect(e.currentVersion).toBe(1);
    }
    expect(store.calls["append"]).toBe(1);
  });
  it("کهنه‌بودن بر NO_CHANGE مقدم است", async () => {
    const { admin } = newAdmin();
    unwrap(await setPolicy(admin, 0, A));
    expect(err(await setPolicy(admin, 0, A)).code).toBe("VERSION_CONFLICT");
  });
  it("رقابتِ هم‌زمانِ دو ادمین روی یک نسخه: یکی موفق، دیگری VERSION_CONFLICT", async () => {
    const { admin } = newAdmin();
    const [x, y] = await Promise.all([setPolicy(admin, 0, A), setPolicy(admin, 0, B)]);
    expect([x.ok, y.ok].filter(Boolean)).toHaveLength(1);
    const loser = x.ok ? y : x;
    expect(err(loser).code).toBe("VERSION_CONFLICT");
    expect(unwrap(await admin.current()).version).toBe(1);
  });
  it("ده ادمینِ هم‌زمان: دقیقاً یک نسخه ساخته می‌شود", async () => {
    const { admin } = newAdmin();
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => setPolicy(admin, 0, compat(60_000 + i * 1000, 15_000), { actor: `u${i}` })));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.filter((r) => !r.ok && r.error.code === "VERSION_CONFLICT")).toHaveLength(9);
  });
  it("رقابتِ پس از خواندن (کهنه‌ماندنِ latest): CAS ذخیره‌ساز نقشِ آخر را دارد و currentVersion درست برمی‌گردد", async () => {
    const inner = createMemoryPolicyStore();
    await inner.append(sampleRecord(1, { overrides: {}, policy: defaultsPolicy() }));
    let first = true;
    const store = wrapStore(inner, { latest: async () => (first ? ((first = false), { ok: true, value: null }) : inner.latest()) });
    const e = err(await setPolicy(newAdmin(store).admin, 0, A));
    expect(e.code).toBe("VERSION_CONFLICT");
    expect(e.currentVersion).toBe(1);
  });
  it("INVALID_OVERRIDES: کلیدِ ناشناخته، رابطهٔ ناسازگار (بی‌اصلاحِ خودکار)، نوع و کران؛ هیچ نسخه‌ای ساخته نمی‌شود", async () => {
    const store = wrapStore(createMemoryPolicyStore());
    const { admin } = newAdmin(store);
    const cases: unknown[] = [
      { nope: { a: 1 } },
      { timing: { nope: 1 } },
      { timing: { graceMs: 60_000 } }, // maxCallMs پیش‌فرض > graceMs/۲
      { timing: { graceMs: 1000 } },
      { loop: { maxSteps: 0 } },
      { loop: { maxSteps: "8" } },
      { metering: { onUnknownCost: "free" } },
      { model: { name: "bad name!" } },
      { timing: { graceMs: undefined } },
    ];
    for (const c of cases) {
      const e = err(await setPolicy(admin, 0, c));
      expect(e.code, JSON.stringify(c)).toBe("INVALID_OVERRIDES");
      expect(e.issues.length).toBeGreaterThan(0);
    }
    expect(store.calls["append"]).toBe(0);
    expect(unwrap(await admin.current()).version).toBe(0);
  });
  it("overrides غیرِ شیء (null/آرایه/رشته/undefined) ⇒ INVALID_OVERRIDES؛ نبودنِ کلید ⇒ INVALID_ARGUMENT", async () => {
    const { admin } = newAdmin();
    for (const o of [null, undefined, [], "x", 5]) expect(err(await setPolicy(admin, 0, o)).code).toBe("INVALID_OVERRIDES");
    expect(err(await admin.set({ expectedVersion: 0, actor: ACTOR, reason: REASON })).code).toBe("INVALID_ARGUMENT");
  });
  it("هیچ مقدارِ ورودی در issues بازتاب نمی‌شود", async () => {
    const { admin } = newAdmin();
    const e = err(await setPolicy(admin, 0, { model: { name: "sk-SECRET-123 bad name" }, nope: { x: "TOPSECRET" } }));
    expect(JSON.stringify(e)).not.toMatch(/SECRET/);
  });
  it("INVALID_ARGUMENT: expectedVersion، actor، reason و کلیدِ اضافه؛ و ورودیِ غیرِ شیء؛ ذخیره‌ساز لمس نمی‌شود", async () => {
    const store = wrapStore(createMemoryPolicyStore());
    const { admin } = newAdmin(store);
    const base = { expectedVersion: 0, overrides: A, actor: ACTOR, reason: REASON };
    const bads: unknown[] = [
      { ...base, expectedVersion: -1 },
      { ...base, expectedVersion: 1.5 },
      { ...base, expectedVersion: "0" },
      { ...base, expectedVersion: undefined },
      { ...base, actor: "" },
      { ...base, actor: "a b" },
      { ...base, actor: "x".repeat(129) },
      { ...base, actor: 5 },
      { ...base, reason: "" },
      { ...base, reason: "   " },
      { ...base, reason: "x".repeat(501) },
      { ...base, reason: "a\u202eb" },
      { ...base, extra: 1 },
      null,
      5,
      [],
    ];
    for (const b of bads) expect(err(await admin.set(b)).code, JSON.stringify(b)).toBe("INVALID_ARGUMENT");
    expect(store.calls).toEqual({ latest: 0, get: 0, append: 0, list: 0 });
  });
  it("issues دربارهٔ actor/reason مقدارِ ورودی را بازتاب نمی‌دهد", async () => {
    const e = err(await newAdmin().admin.set({ expectedVersion: 0, overrides: A, actor: "PASSWORD hunter2", reason: "" }));
    expect(JSON.stringify(e)).not.toContain("hunter2");
  });
  it("INVALID_CLOCK: NaN، منفی، اعشاری، پرتاب؛ چیزی نوشته نمی‌شود", async () => {
    for (const bad of [Number.NaN, -1, 1.5, Infinity, "5" as unknown as number]) {
      const store = wrapStore(createMemoryPolicyStore());
      const { admin } = newAdmin(store, { nowMs: () => bad } as never);
      expect(err(await setPolicy(admin, 0, A)).code).toBe("INVALID_CLOCK");
      expect(store.calls["append"]).toBe(0);
    }
    const thrower = { nowMs: (): number => { throw new Error("CLOCKSECRET"); } };
    const e = err(await setPolicy(newAdmin(createMemoryPolicyStore(), thrower as never).admin, 0, A));
    expect(e.code).toBe("INVALID_CLOCK");
    expect(JSON.stringify(e)).not.toContain("CLOCKSECRET");
  });
  it("ساعتِ صفر مجاز است (مرز)", async () => {
    const { admin } = newAdmin(createMemoryPolicyStore(), fakeClock(0));
    expect(unwrap(await setPolicy(admin, 0, A)).createdAtMs).toBe(0);
  });
  it("خروجی عمیق‌یخ‌زده و مستقل از ورودی", async () => {
    const { admin } = newAdmin();
    const input = { timing: { ...A.timing }, model: { ...A.model } };
    const r = unwrap(await setPolicy(admin, 0, input));
    expect(deepFrozen(r)).toBe(true);
    input.timing["graceMs"] = 1;
    expect(unwrap(await admin.current()).policy.timing.graceMs).toBe(60_000);
  });
  it("سیاستِ ثبت‌شده با projectToolPolicy (پایین‌دست) سازگار است", async () => {
    const { projectToolPolicy } = await import("@/modules/tool-policy");
    const { admin } = newAdmin();
    unwrap(await setPolicy(admin, 0, A));
    const c = unwrap(await admin.current());
    const p = projectToolPolicy(c.policy);
    expect(p.ok && p.value.durable.graceMs).toBe(60_000);
    expect(p.ok && p.value.deadline.maxCallMs).toBe(24_000);
  });
});

describe("tool-policy-admin · rollbackTo", () => {
  async function seeded() {
    const ctx = newAdmin();
    unwrap(await setPolicy(ctx.admin, 0, A)); // v1
    unwrap(await setPolicy(ctx.admin, 1, B)); // v2
    unwrap(await setPolicy(ctx.admin, 2, {})); // v3
    return ctx;
  }
  it("نسخهٔ تازه با بازنویسیِ نسخهٔ قدیمی و منبعِ rollback؛ تاریخچه دست‌نخورده", async () => {
    const { admin } = await seeded();
    const before = unwrap(await admin.history()).entries.map((e) => JSON.stringify(e));
    const r = unwrap(await rollback(admin, 3, 1));
    expect(r.version).toBe(4);
    expect(r.overrides).toEqual({ model: { timeoutMs: 20_000 }, timing: A.timing });
    expect(r.changes).toContainEqual({ path: "timing.graceMs", from: 90_000, to: 60_000 });
    const after = unwrap(await admin.history()).entries;
    expect(after.slice(1).map((e) => JSON.stringify(e))).toEqual(before);
    expect(after[0]).toMatchObject({ version: 4, source: { kind: "rollback", toVersion: 1 } });
    expect(unwrap(await admin.current()).policy.timing.graceMs).toBe(60_000);
  });
  it("بازگشت به نسخهٔ فعلی ⇒ NO_CHANGE", async () => {
    const { admin } = await seeded();
    expect(err(await rollback(admin, 3, 3)).code).toBe("NO_CHANGE");
  });
  it("بازگشت به نسخه‌ای با بازنویسیِ برابرِ فعلی ⇒ NO_CHANGE (نه نسخهٔ تکراری)", async () => {
    const { admin } = newAdmin();
    unwrap(await setPolicy(admin, 0, A));
    unwrap(await setPolicy(admin, 1, B));
    unwrap(await setPolicy(admin, 2, A)); // v3 هم‌بازنویسی با v1
    expect(err(await rollback(admin, 3, 1)).code).toBe("NO_CHANGE");
  });
  it("INVALID_ARGUMENT: toVersion صفر/منفی/اعشاری/بزرگ‌تر از expectedVersion؛ کلیدِ اضافه", async () => {
    const { admin } = await seeded();
    for (const t of [0, -1, 1.5, "1", 4, undefined]) expect(err(await rollback(admin, 3, t as number)).code, String(t)).toBe("INVALID_ARGUMENT");
    expect(err(await rollback(admin, 3, 1, { extra: 1 })).code).toBe("INVALID_ARGUMENT");
    expect(err(await rollback(admin, -1, 1)).code).toBe("INVALID_ARGUMENT");
    expect(err(await admin.rollbackTo(null)).code).toBe("INVALID_ARGUMENT");
  });
  it("VERSION_CONFLICT: expectedVersion کهنه", async () => {
    const { admin } = await seeded();
    const e = err(await rollback(admin, 2, 1));
    expect(e.code).toBe("VERSION_CONFLICT");
    expect(e.currentVersion).toBe(3);
  });
  it("تعارضِ نسخه پیش از خواندنِ نسخهٔ هدف می‌آید (ذخیره‌ساز بی‌دلیل خوانده نمی‌شود)", async () => {
    const inner = createMemoryPolicyStore();
    await inner.append(sampleRecord(1, { overrides: {}, policy: defaultsPolicy() }));
    const store = wrapStore(inner, { get: async () => ({ ok: true, value: null }) });
    const e = err(await rollback(newAdmin(store).admin, 5, 1));
    expect(e.code).toBe("VERSION_CONFLICT");
    expect(store.calls["get"]).toBe(0);
  });
  it("VERSION_NOT_FOUND: ذخیره‌ساز نسخه را ندارد", async () => {
    const inner = createMemoryPolicyStore();
    await inner.append(sampleRecord(1, { overrides: {}, policy: defaultsPolicy() }));
    const store = wrapStore(inner, { get: async () => ({ ok: true, value: null }) });
    expect(err(await rollback(newAdmin(store).admin, 1, 1)).code).toBe("VERSION_NOT_FOUND");
  });
  it("نسخهٔ هدفِ خراب یا با شمارهٔ دیگر ⇒ STORE_FAILURE", async () => {
    const inner = createMemoryPolicyStore();
    await inner.append(sampleRecord(1, { overrides: {}, policy: defaultsPolicy() }));
    await inner.append(sampleRecord(2, { overrides: { loop: { maxSteps: 3 } } as never }));
    for (const got of [{ version: 1, bad: true }, sampleRecord(2)]) {
      const store = wrapStore(inner, { get: async () => ({ ok: true, value: got }) });
      expect(err(await rollback(newAdmin(store).admin, 2, 1)).code).toBe("STORE_FAILURE");
    }
  });
  it("هدفی که با کدِ جاری دیگر معتبر نیست ⇒ INVALID_OVERRIDES و نسخه‌ای ساخته نمی‌شود", async () => {
    const inner = createMemoryPolicyStore();
    await inner.append(sampleRecord(1, { overrides: { timing: { graceMs: 60_000 } } as never }));
    await inner.append(sampleRecord(2, { overrides: {} }));
    const store = wrapStore(inner);
    const e = err(await rollback(newAdmin(store).admin, 2, 1));
    expect(e.code).toBe("INVALID_OVERRIDES");
    expect(store.calls["append"]).toBe(0);
  });
  it("هدفِ ذخیره‌ساز شکست ⇒ STORE_FAILURE", async () => {
    const inner = createMemoryPolicyStore();
    await inner.append(sampleRecord(1, { overrides: {}, policy: defaultsPolicy() }));
    const store = wrapStore(inner, { get: async () => ({ ok: false, error: { code: "UNAVAILABLE" } }) });
    expect(err(await rollback(newAdmin(store).admin, 1, 1)).code).toBe("STORE_FAILURE");
  });
});

describe("tool-policy-admin · history", () => {
  async function five() {
    const ctx = newAdmin();
    for (let i = 0; i < 5; i++) unwrap(await setPolicy(ctx.admin, i, compat(60_000 + i * 10_000, 15_000)));
    return ctx;
  }
  it("پیش‌فرض: نزولی؛ بدون ورودی (undefined) مجاز", async () => {
    const { admin } = await five();
    const h = unwrap(await admin.history());
    expect(h.entries.map((e) => e.version)).toEqual([5, 4, 3, 2, 1]);
    expect(h.nextBefore).toBeNull();
    expect(unwrap(await admin.history({})).entries).toHaveLength(5);
  });
  it("صفحه‌بندی با nextBefore تا پایان، بی‌تکرار", async () => {
    const { admin } = await five();
    const seen: number[] = [];
    let before: number | null = null;
    for (let i = 0; i < 10; i++) {
      const p: HistoryPage = unwrap(await admin.history({ beforeVersion: before, limit: 2 }));
      seen.push(...p.entries.map((e) => e.version));
      if (p.nextBefore === null) break;
      before = p.nextBefore;
    }
    expect(seen).toEqual([5, 4, 3, 2, 1]);
  });
  it("صفحهٔ دقیقاً به‌اندازهٔ باقیمانده که به نسخهٔ ۱ می‌رسد ⇒ nextBefore=null؛ صفحهٔ پر با باقیمانده ⇒ مقدار", async () => {
    const { admin } = await five();
    expect(unwrap(await admin.history({ limit: 5 })).nextBefore).toBeNull();
    expect(unwrap(await admin.history({ limit: 4 })).nextBefore).toBe(2);
    expect(unwrap(await admin.history({ beforeVersion: 3, limit: 2 })).nextBefore).toBeNull();
  });
  it("صفحهٔ کوتاه از ذخیره‌ساز (کمتر از limit) پایانِ تاریخچه است ⇒ nextBefore=null", async () => {
    const store = wrapStore(createMemoryPolicyStore(), { list: async () => ({ ok: true, value: [sampleRecord(3)] }) });
    const h = unwrap(await newAdmin(store).admin.history({ limit: 2 }));
    expect(h.entries.map((e) => e.version)).toEqual([3]);
    expect(h.nextBefore).toBeNull();
  });
  it("ذخیره‌سازِ خالی ⇒ entries تهی و nextBefore=null", async () => {
    const h = unwrap(await newAdmin().admin.history());
    expect(h).toEqual({ entries: [], nextBefore: null });
  });
  it("ورودیِ نامعتبر ⇒ INVALID_ARGUMENT", async () => {
    const { admin } = newAdmin();
    for (const i of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "5" }, { beforeVersion: 0 }, { beforeVersion: -2 }, { beforeVersion: "3" }, { extra: 1 }, null, 5, []]) {
      expect(err(await admin.history(i)).code, JSON.stringify(i)).toBe("INVALID_ARGUMENT");
    }
    expect(unwrap(await admin.history({ limit: 100 })).entries).toEqual([]);
    expect(unwrap(await admin.history({ limit: 1, beforeVersion: null })).entries).toEqual([]);
  });
  it("پاسخِ ذخیره‌ساز: غیرِ آرایه، بیش از limit، نامرتب، تکراری یا ≥ beforeVersion ⇒ STORE_FAILURE", async () => {
    const r1 = sampleRecord(1);
    const r2 = sampleRecord(2);
    const r3 = sampleRecord(3);
    const cases: [unknown, number | null][] = [
      [{}, null],
      [[r3, r2, r1], null], // limit=2 پایین‌تر
      [[r2, r3], null],
      [[r2, r2], null],
      [[r3, { version: 2 }], null],
      [[r2], 2],
    ];
    for (const [value, before] of cases) {
      const store = wrapStore(createMemoryPolicyStore(), { list: async () => ({ ok: true, value }) });
      expect(err(await newAdmin(store).admin.history({ beforeVersion: before, limit: 2 })).code, JSON.stringify(value).slice(0, 40)).toBe("STORE_FAILURE");
    }
  });
});
