import { describe, expect, it } from "vitest";
import { createPreflightedAdmin } from "./guarded-admin";
import type { PreflightedAdmin } from "./types";
import { ACTOR, compat, fakeBuild, realAdmin, REASON, spyAdmin } from "./test-kit";

const setIn = (expectedVersion: number, overrides: unknown, extra: Record<string, unknown> = {}) => ({ expectedVersion, overrides, actor: ACTOR, reason: REASON, ...extra });
const rbIn = (expectedVersion: number, toVersion: unknown, extra: Record<string, unknown> = {}) => ({ expectedVersion, toVersion, actor: ACTOR, reason: REASON, ...extra });

function made(admin: unknown, build: unknown): PreflightedAdmin {
  const r = createPreflightedAdmin({ admin, build });
  if (!r.ok) throw new Error(`config: ${r.error.issues.join(",")}`);
  return r.value;
}
function real(reject: (p: never) => boolean = () => false) {
  const t = fakeBuild(reject as never);
  const a = realAdmin();
  return { ...t, ...a, pre: made(a.admin, t.build) };
}
const errCode = (r: { ok: boolean; error?: { code: string } }): string => (r.ok ? "OK" : (r.error as { code: string }).code);
const stage = (r: unknown): string => ((r as { error?: { stage?: string } }).error?.stage ?? "-");

describe("tool-policy-preflight · پیکربندیِ مدیر", () => {
  const good = spyAdmin().admin;
  it("admin با چهار متد و build تابع لازم است", () => {
    expect(createPreflightedAdmin({ admin: good, build: () => 1 }).ok).toBe(true);
    const bad: unknown[] = [undefined, null, {}, { admin: good }, { build: () => 1 }, { admin: {}, build: () => 1 }, { admin: null, build: () => 1 }, { admin: { ...good, history: 1 }, build: () => 1 }, { admin: { set: good.set }, build: () => 1 }, { admin: good, build: "x" }];
    for (const o of bad) {
      const r = createPreflightedAdmin(o);
      expect(r.ok, JSON.stringify(o)).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("INVALID_CONFIG");
        expect(r.error.issues.length).toBeGreaterThan(0);
      }
    }
  });
  it("هر چهار متد لازم است (هرکدام جدا)", () => {
    for (const m of ["set", "rollbackTo", "current", "history"]) {
      const partial = { ...good, [m]: undefined };
      expect(createPreflightedAdmin({ admin: partial, build: () => 1 }).ok, m).toBe(false);
    }
  });
  it("getterِ پرتاب‌کننده ⇒ INVALID_CONFIG بی‌نشتِ متن", () => {
    const evil = { get admin(): never { throw new Error("sk-SECRET"); } };
    const r1 = createPreflightedAdmin(evil);
    const r2 = createPreflightedAdmin({ admin: { get set(): never { throw new Error("sk-SECRET"); }, rollbackTo: 1, current: 1, history: 1 }, build: () => 1 });
    expect(r1.ok || r2.ok).toBe(false);
    expect(JSON.stringify([r1, r2])).not.toContain("sk-SECRET");
  });
  it("مدیرِ ساخته‌شده یخ‌زده با چهار متد", () => {
    const m = made(good, () => 1);
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.keys(m).sort()).toEqual(["current", "history", "rollbackTo", "set"]);
  });
});

describe("tool-policy-preflight · set", () => {
  it("بازنویسیِ سالم: ثبت می‌شود و build یک بار صدا زده می‌شود", async () => {
    const t = real();
    const r = await t.pre.set(setIn(0, compat(90_000, 30_000)));
    expect(r.ok).toBe(true);
    expect(t.state.calls).toHaveLength(1);
    const latest = await t.store.latest();
    expect(latest.ok && latest.value?.version).toBe(1);
  });

  it("build رد کند ⇒ BUILD_FAILED و **هیچ نسخه‌ای ثبت نمی‌شود**، مدیر صدا زده نمی‌شود", async () => {
    const s = spyAdmin();
    const pre = made(s.admin, () => ({ ok: false }));
    const r = await pre.set(setIn(0, compat(90_000, 30_000)));
    expect(stage(r)).toBe("BUILD_FAILED");
    expect(errCode(r as never)).toBe("PREFLIGHT_REJECTED");
    expect(s.calls.set).toHaveLength(0);
    const t = real(() => true);
    await t.pre.set(setIn(0, compat(90_000, 30_000)));
    const latest = await t.store.latest();
    expect(latest.ok && latest.value).toBe(null);
  });

  it("بازنویسیِ نامعتبر ⇒ OVERRIDES_INVALID با issues؛ مدیر صدا زده نمی‌شود", async () => {
    const s = spyAdmin();
    const pre = made(s.admin, () => ({ ok: true, value: {} }));
    const r = await pre.set(setIn(0, { timing: { graceMs: 30_000 } }));
    expect(stage(r)).toBe("OVERRIDES_INVALID");
    expect((r as unknown as { error: { issues: string[] } }).error.issues.length).toBeGreaterThan(0);
    expect(s.calls.set).toHaveLength(0);
  });

  it("بدون کلیدِ overrides: پیش‌بازرسی با پیش‌فرض‌ها و سپس خطای خودِ مدیر", async () => {
    const t = real();
    const r = await t.pre.set({ expectedVersion: 0, actor: ACTOR, reason: REASON });
    expect(errCode(r as never)).toBe("INVALID_ARGUMENT");
  });

  it("خطاهای خودِ مدیر عیناً بیرون می‌آید (actor بد، تعارضِ نسخه، بی‌تغییر)", async () => {
    const t = real();
    expect(errCode((await t.pre.set(setIn(0, {}, { actor: "bad actor" }))) as never)).toBe("INVALID_ARGUMENT");
    expect(errCode((await t.pre.set(setIn(0, {}))) as never)).toBe("NO_CHANGE");
    expect(errCode((await t.pre.set(setIn(7, compat(90_000, 30_000)))) as never)).toBe("VERSION_CONFLICT");
  });

  it("مدیر **همان کلونِ** پیش‌بازرسی‌شده را می‌گیرد، نه شیءِ ورودی", async () => {
    const s = spyAdmin();
    const pre = made(s.admin, () => ({ ok: true, value: {} }));
    const input = setIn(0, compat(90_000, 30_000));
    await pre.set(input);
    const got = s.calls.set[0] as { overrides: unknown };
    expect(got).toEqual(input);
    expect(got).not.toBe(input);
    expect(got.overrides).not.toBe(input.overrides);
  });

  it("TOCTOU: getterِ دوچهره فقط یک بار خوانده می‌شود و مدیر همان مقدارِ سنجیده را می‌بیند", async () => {
    const s = spyAdmin();
    const rejectUnsafe = (p: { service: { maxCards: number } }) => (p.service.maxCards === 3 ? { ok: false } : { ok: true, value: {} });
    const pre = made(s.admin, rejectUnsafe);
    let reads = 0;
    const input = {
      expectedVersion: 0,
      actor: ACTOR,
      reason: REASON,
      get overrides() {
        reads += 1;
        return reads === 1 ? { answer: { maxCards: 4 } } : { answer: { maxCards: 3 } };
      },
    };
    await pre.set(input);
    expect(reads).toBe(1);
    expect((s.calls.set[0] as { overrides: unknown }).overrides).toEqual({ answer: { maxCards: 4 } });
  });

  it("ورودیِ ناپذیرفتنی ⇒ INPUT_UNREADABLE بی‌صدا زدنِ مدیر", async () => {
    const cyc: Record<string, unknown> = { expectedVersion: 0 };
    cyc.self = cyc;
    const huge = setIn(0, {}, { reason: "ا".repeat(20_000) });
    const inputs: unknown[] = [null, undefined, [], "x", 5, true, cyc, { a: BigInt(1) }, { get x(): never { throw new Error("sk-SECRET"); } }, new Proxy({}, { ownKeys: () => { throw new Error("sk-SECRET"); } }), huge];
    for (const i of inputs) {
      const s = spyAdmin();
      const pre = made(s.admin, () => ({ ok: true, value: {} }));
      const r = await pre.set(i);
      expect(stage(r), String(i)).toBe("INPUT_UNREADABLE");
      expect(JSON.stringify(r)).not.toContain("sk-SECRET");
      expect(s.calls.set).toHaveLength(0);
    }
  });

  it("سقفِ اندازه: درست در مرز پذیرفته و یک نویسه بیشتر رد", async () => {
    const mk = (n: number) => {
      const base = JSON.stringify({ expectedVersion: 0, overrides: {}, actor: ACTOR, reason: "" });
      return setIn(0, {}, { reason: "a".repeat(n - base.length) });
    };
    const s1 = spyAdmin();
    await made(s1.admin, () => ({ ok: true, value: {} })).set(mk(16_384));
    expect(s1.calls.set).toHaveLength(1);
    const s2 = spyAdmin();
    const r = await made(s2.admin, () => ({ ok: true, value: {} })).set(mk(16_385));
    expect(stage(r)).toBe("INPUT_UNREADABLE");
    expect(s2.calls.set).toHaveLength(0);
  });

  it("مدیرِ پرتاب‌کننده ⇒ STORE_FAILUREِ ثابت بی‌نشتِ متن", async () => {
    const s = spyAdmin({ set: () => { throw new Error("sk-SECRET"); } });
    const r = await made(s.admin, () => ({ ok: true, value: {} })).set(setIn(0, {}));
    expect(errCode(r as never)).toBe("STORE_FAILURE");
    expect(JSON.stringify(r)).not.toContain("sk-SECRET");
    const s2 = spyAdmin({ set: () => Promise.reject(new Error("sk-SECRET")) });
    expect(errCode((await made(s2.admin, () => ({ ok: true, value: {} })).set(setIn(0, {}))) as never)).toBe("STORE_FAILURE");
  });
});

describe("tool-policy-preflight · rollbackTo", () => {
  async function twoVersions() {
    const t = real();
    expect((await t.pre.set(setIn(0, { answer: { maxCards: 4 } }))).ok).toBe(true);
    expect((await t.pre.set(setIn(1, { answer: { maxCards: 5 } }))).ok).toBe(true);
    return t;
  }

  it("هدفِ سالم: نسخهٔ تازه با منبعِ rollback ثبت می‌شود", async () => {
    const t = await twoVersions();
    const r = await t.pre.rollbackTo(rbIn(2, 1));
    expect(r.ok).toBe(true);
    const latest = await t.store.latest();
    expect(latest.ok && latest.value?.version).toBe(3);
    expect(latest.ok && latest.value?.source).toEqual({ kind: "rollback", toVersion: 1 });
  });

  it("هدفی که با کدِ جاری ساخته نمی‌شود ⇒ BUILD_FAILED و چیزی ثبت نمی‌شود", async () => {
    const t = await twoVersions();
    t.state.reject = (p) => p.service.maxCards === 4; // کدِ/محیطِ جاری دیگر نسخهٔ ۱ را نمی‌سازد
    const r = await t.pre.rollbackTo(rbIn(2, 1));
    expect(stage(r)).toBe("BUILD_FAILED");
    const latest = await t.store.latest();
    expect(latest.ok && latest.value?.version).toBe(2);
    // و هدفِ ساخته‌شدنی هنوز مجاز است
    t.state.reject = (p) => p.service.maxCards === 5;
    expect((await t.pre.rollbackTo(rbIn(2, 1))).ok).toBe(true);
  });

  it("history با beforeVersion=toVersion+1 و limit=1 صدا زده می‌شود و سپس rollbackTo با کلون", async () => {
    const s = spyAdmin({ history: () => ({ ok: true, value: { entries: [], nextBefore: null } }) });
    const pre = made(s.admin, () => ({ ok: true, value: {} }));
    const input = rbIn(5, 3);
    await pre.rollbackTo(input);
    expect(s.calls.history).toEqual([{ beforeVersion: 4, limit: 1 }]);
    expect(s.calls.rollbackTo).toHaveLength(1);
    expect(s.calls.rollbackTo[0]).toEqual(input);
    expect(s.calls.rollbackTo[0]).not.toBe(input);
  });

  it("هدفِ ناموجود/نامعتبر به مدیر می‌رسد تا خطای خودش را بدهد (بی‌history برای نامعتبر)", async () => {
    const t = await twoVersions();
    expect(errCode((await t.pre.rollbackTo(rbIn(2, 2))) as never)).toBe("NO_CHANGE");
    const s = spyAdmin();
    const pre = made(s.admin, () => ({ ok: true, value: {} }));
    for (const to of [0, -1, 1.5, "1", null, undefined, Number.NaN]) {
      s.calls.history.length = 0;
      await pre.rollbackTo(rbIn(2, to));
      expect(s.calls.history, String(to)).toHaveLength(0);
    }
    expect(s.calls.rollbackTo).toHaveLength(7);
    expect(errCode((await t.pre.rollbackTo(rbIn(2, 0))) as never)).toBe("INVALID_ARGUMENT");
  });

  it("خطای history بیرون می‌آید و rollbackTo صدا زده نمی‌شود", async () => {
    const err = { ok: false, error: { code: "STORE_FAILURE", message: "x", issues: [], currentVersion: 1 } };
    const s = spyAdmin({ history: () => err });
    const r = await made(s.admin, () => ({ ok: true, value: {} })).rollbackTo(rbIn(2, 1));
    expect(r).toEqual(err);
    expect(s.calls.rollbackTo).toHaveLength(0);
  });

  it("history پرتاب کند ⇒ STORE_FAILURE و rollbackTo صدا زده نمی‌شود", async () => {
    const s = spyAdmin({ history: () => { throw new Error("sk-SECRET"); } });
    const r = await made(s.admin, () => ({ ok: true, value: {} })).rollbackTo(rbIn(2, 1));
    expect(errCode(r as never)).toBe("STORE_FAILURE");
    expect(JSON.stringify(r)).not.toContain("sk-SECRET");
    expect(s.calls.rollbackTo).toHaveLength(0);
  });

  it("رکوردِ ناهمنسخه در history سنجیده نمی‌شود و به مدیر می‌رسد", async () => {
    const entry = { version: 9, overrides: { nope: 1 } };
    const s = spyAdmin({ history: () => ({ ok: true, value: { entries: [entry], nextBefore: null } }) });
    await made(s.admin, () => ({ ok: false })).rollbackTo(rbIn(5, 3));
    expect(s.calls.rollbackTo).toHaveLength(1);
  });

  it("هدفِ هم‌نسخه با بازنویسیِ نامعتبرِ امروز ⇒ OVERRIDES_INVALID بی‌صدا زدنِ rollbackTo", async () => {
    const entry = { version: 3, overrides: { timing: { graceMs: 30_000 } } };
    const s = spyAdmin({ history: () => ({ ok: true, value: { entries: [entry], nextBefore: null } }) });
    const r = await made(s.admin, () => ({ ok: true, value: {} })).rollbackTo(rbIn(5, 3));
    expect(stage(r)).toBe("OVERRIDES_INVALID");
    expect(s.calls.rollbackTo).toHaveLength(0);
  });

  it("TOCTOU: toVersion یک بار خوانده می‌شود و مدیر همان را می‌گیرد", async () => {
    const s = spyAdmin();
    let reads = 0;
    const input = { expectedVersion: 5, actor: ACTOR, reason: REASON, get toVersion() { reads += 1; return reads === 1 ? 3 : 2; } };
    await made(s.admin, () => ({ ok: true, value: {} })).rollbackTo(input);
    expect(reads).toBe(1);
    expect((s.calls.rollbackTo[0] as { toVersion: number }).toVersion).toBe(3);
  });

  it("ورودیِ ناپذیرفتنی ⇒ INPUT_UNREADABLE؛ مدیر و history صدا زده نمی‌شوند", async () => {
    for (const i of [null, undefined, [], "x", { a: BigInt(1) }]) {
      const s = spyAdmin();
      const r = await made(s.admin, () => ({ ok: true, value: {} })).rollbackTo(i);
      expect(stage(r)).toBe("INPUT_UNREADABLE");
      expect(s.calls.history).toHaveLength(0);
      expect(s.calls.rollbackTo).toHaveLength(0);
    }
  });

  it("مدیرِ پرتاب‌کننده در rollbackTo ⇒ STORE_FAILURE", async () => {
    const s = spyAdmin({ rollbackTo: () => { throw new Error("sk-SECRET"); } });
    const r = await made(s.admin, () => ({ ok: true, value: {} })).rollbackTo(rbIn(5, 3));
    expect(errCode(r as never)).toBe("STORE_FAILURE");
  });
});

describe("tool-policy-preflight · current/history", () => {
  it("عیناً به مدیر می‌رود", async () => {
    const t = real();
    await t.pre.set(setIn(0, compat(90_000, 30_000)));
    expect(await t.pre.current()).toEqual(await t.admin.current());
    expect(await t.pre.history({ limit: 5 })).toEqual(await t.admin.history({ limit: 5 }));
    expect(await t.pre.history()).toEqual(await t.admin.history());
  });
  it("ورودیِ history بی‌تغییر منتقل می‌شود", async () => {
    const s = spyAdmin();
    const input = { limit: 3 };
    await made(s.admin, () => 1).history(input);
    expect(s.calls.history[0]).toBe(input);
  });
  it("پرتابِ مدیر ⇒ STORE_FAILUREِ ثابت", async () => {
    const s = spyAdmin({ current: () => { throw new Error("sk-SECRET"); }, history: () => Promise.reject(new Error("sk-SECRET")) });
    const m = made(s.admin, () => 1);
    for (const r of [await m.current(), await m.history()]) {
      expect(errCode(r as never)).toBe("STORE_FAILURE");
      expect(JSON.stringify(r)).not.toContain("sk-SECRET");
    }
  });
});
