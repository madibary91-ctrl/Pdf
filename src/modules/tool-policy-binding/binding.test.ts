import { describe, expect, it } from "vitest";
import { createPolicyBinding } from "./binding";
import { deepFrozen, newBinding, projectionFor, RAW_UNDEFINED, snapErr, snapOk } from "./test-kit";

const reasonOf = (r: ReturnType<ReturnType<typeof newBinding>["binding"]["acquire"]>): string => (r.ok ? "OK" : r.error.reason);

describe("tool-policy-binding · پیکربندی", () => {
  const good = { snapshot: () => snapOk(1) };
  it("منبع، ساخت و ناظر: فقط تابع", () => {
    expect(createPolicyBinding({ source: good, build: () => ({ ok: true, value: {} }) }).ok).toBe(true);
    for (const o of [undefined, null, {}, { source: good }, { build: () => 1 }, { source: {}, build: () => 1 }, { source: null, build: () => 1 }, { source: { snapshot: 1 }, build: () => 1 }, { source: good, build: "x" }, { source: good, build: () => 1, observer: 5 }]) {
      const r = createPolicyBinding(o as never);
      expect(r.ok, JSON.stringify(o)).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("INVALID_CONFIG");
        expect(r.error.issues.length).toBeGreaterThan(0);
      }
    }
  });
  it("گزینهٔ پرتاب‌کننده (getter) ⇒ INVALID_CONFIG، بی‌پرتاب و بی‌بازتابِ متنِ خطا", () => {
    const evil = { get source(): never { throw new Error("sk-SECRET"); } };
    const r = createPolicyBinding(evil as never);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("sk-SECRET");
    const evil2 = { source: { get snapshot(): never { throw new Error("sk-SECRET"); } }, build: () => 1 };
    expect(createPolicyBinding(evil2 as never).ok).toBe(false);
  });
  it("پیکربندی بدون observer معتبر است و پیوندِ ساخته‌شده یخ‌زده است", () => {
    const r = createPolicyBinding({ source: good, build: () => ({ ok: true, value: {} }) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.isFrozen(r.value)).toBe(true);
      expect(Object.keys(r.value).sort()).toEqual(["acquire", "status"]);
    }
  });
});

describe("tool-policy-binding · مسیرِ سالم", () => {
  it("اجارهٔ سالم: نسخه/منبع/سن/projectionِ بازساخته و نمونهٔ ساخته‌شده", () => {
    const t = newBinding(snapOk(2, 2, { ageMs: 77, drift: true }));
    const r = t.binding.acquire();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ version: 2, source: "stored", drift: true, ageMs: 77, instance: { id: 1 } });
    expect(r.value.projection).toEqual(projectionFor(2));
    expect(Object.isFrozen(r.value)).toBe(true);
    expect(deepFrozen(r.value.projection)).toBe(true);
  });

  it("یک ساخت به‌ازای هر نسخه: درخواست‌های بعدیِ همان نسخه همان نمونه را می‌گیرند", () => {
    const t = newBinding(snapOk(1));
    const a = t.binding.acquire();
    const b = t.binding.acquire();
    const c = t.binding.acquire();
    expect(t.calls).toHaveLength(1);
    if (a.ok && b.ok && c.ok) {
      expect(b.value.instance).toBe(a.value.instance);
      expect(c.value.instance).toBe(a.value.instance);
    } else throw new Error("expected ok");
  });

  it("build projectionِ بازساخته (یخ‌زده) می‌گیرد، نه شیءِ خامِ منبع", () => {
    const t = newBinding(snapOk(1));
    t.binding.acquire();
    expect(t.calls).toHaveLength(1);
    expect(deepFrozen(t.calls[0])).toBe(true);
    const raw = (snapOk(1) as { value: { projection: unknown } }).value.projection;
    expect(t.calls[0]).not.toBe(raw);
  });

  it("پین: اجارهٔ درخواستِ در جریان با فعال‌شدنِ نسخهٔ تازه عوض نمی‌شود؛ درخواستِ بعدی نسخهٔ تازه را می‌گیرد", () => {
    const t = newBinding(snapOk(1));
    const first = t.binding.acquire();
    t.state.next = snapOk(2);
    const second = t.binding.acquire();
    if (!first.ok || !second.ok) throw new Error("expected ok");
    expect(first.value.version).toBe(1);
    expect(first.value.projection).toEqual(projectionFor(1));
    expect(first.value.instance).toEqual({ id: 1 });
    expect(second.value.version).toBe(2);
    expect(second.value.instance).toEqual({ id: 2 });
    expect(second.value.instance).not.toBe(first.value.instance);
    expect(t.calls).toHaveLength(2);
  });

  it("نسخهٔ ۰ (پیش‌فرضِ کد) هم مجاز است و ساخته می‌شود", () => {
    const t = newBinding(snapOk(0));
    const r = t.binding.acquire();
    expect(r.ok && r.value.source === "defaults" && r.value.version === 0).toBe(true);
  });

  it("نسخهٔ تازه با محتوای یکسان هم نمونهٔ تازه می‌سازد (نسخه مبنای هویت است)", () => {
    const t = newBinding(snapOk(1, 0));
    t.binding.acquire();
    t.state.next = snapOk(2, 0);
    const r = t.binding.acquire();
    expect(r.ok && r.value.instance.id === 2).toBe(true);
  });

  it("هر acquire منبع را دقیقاً یک بار می‌خواند", () => {
    const t = newBinding(snapOk(1));
    t.binding.acquire();
    t.binding.acquire();
    expect(t.state.calls).toBe(2);
  });
});

describe("tool-policy-binding · شکست‌بسته", () => {
  it.each(["NOT_LOADED", "STALE", "CLOCK_INVALID"])("خطای منبع %s ⇒ همان دلیل و بی‌ساخت", (code) => {
    const t = newBinding(snapErr(code));
    const r = t.binding.acquire();
    expect(reasonOf(r)).toBe(code);
    expect(t.calls).toHaveLength(0);
    if (!r.ok) {
      expect(r.error.code).toBe("POLICY_UNAVAILABLE");
      expect(r.error.message.length).toBeGreaterThan(0);
    }
  });

  it("پس از نسخهٔ سالم، STALE بسته می‌شود و به آخرین‌خوب برنمی‌گردد؛ بازگشتِ همان نسخه بی‌ساختِ دوباره", () => {
    const t = newBinding(snapOk(1));
    expect(t.binding.acquire().ok).toBe(true);
    t.state.next = snapErr("STALE");
    expect(reasonOf(t.binding.acquire())).toBe("STALE");
    t.state.next = snapOk(1);
    expect(t.binding.acquire().ok).toBe(true);
    expect(t.calls).toHaveLength(1);
  });

  it("منبعِ پرتاب‌کننده/بدشکل ⇒ SOURCE_INVALID و بی‌پرتاب", () => {
    for (const bad of [() => { throw new Error("sk-SECRET"); }, null, undefined, 5, "x", { ok: "yes" }]) {
      const t = newBinding(bad);
      expect(() => t.binding.acquire()).not.toThrow();
      const r = t.binding.acquire();
      expect(reasonOf(r)).toBe("SOURCE_INVALID");
      expect(JSON.stringify(r)).not.toContain("sk-SECRET");
    }
  });

  it("projectionِ نامعتبر ⇒ PROJECTION_INVALID و بی‌ساخت", () => {
    const bad = projectionFor(1) as unknown as { gatewayModel: { timeoutMs: number } };
    const t = newBinding(snapOk(1, 1, { projection: { ...bad, gatewayModel: { timeoutMs: 10_000_000 } } }));
    expect(reasonOf(t.binding.acquire())).toBe("PROJECTION_INVALID");
    expect(t.calls).toHaveLength(0);
  });

  it("عقب‌گردِ نسخه ⇒ VERSION_REGRESSED (حتی اگر محتوا معتبر باشد)", () => {
    const t = newBinding(snapOk(3));
    t.binding.acquire();
    t.state.next = snapOk(2);
    expect(reasonOf(t.binding.acquire())).toBe("VERSION_REGRESSED");
    t.state.next = snapOk(0);
    expect(reasonOf(t.binding.acquire())).toBe("VERSION_REGRESSED");
    t.state.next = snapOk(3);
    expect(t.binding.acquire().ok).toBe(true);
    expect(t.calls).toHaveLength(1);
  });

  it("همان نسخه با projection دیگر ⇒ VERSION_CONTENT_MISMATCH", () => {
    const t = newBinding(snapOk(2, 2));
    t.binding.acquire();
    t.state.next = snapOk(2, 3);
    expect(reasonOf(t.binding.acquire())).toBe("VERSION_CONTENT_MISMATCH");
    t.state.next = snapOk(2, 2);
    expect(t.binding.acquire().ok).toBe(true);
    expect(t.calls).toHaveLength(1);
  });

  it("ترازوی عقب‌گرد فقط با projectionِ معتبر بالا می‌رود (نسخهٔ جعلیِ بزرگ با projectionِ بد قفل نمی‌کند)", () => {
    const t = newBinding(snapOk(2));
    t.binding.acquire();
    t.state.next = snapOk(1_000_000, 1, { projection: { nope: 1 } });
    expect(reasonOf(t.binding.acquire())).toBe("PROJECTION_INVALID");
    t.state.next = snapOk(3);
    expect(t.binding.acquire().ok).toBe(true);
    expect(t.binding.status().highestVersion).toBe(3);
  });

  it("ساختنِ ناموفق ⇒ BUILD_FAILED؛ به نسخهٔ قبلی برنمی‌گردد و برای همان نسخه دوباره نمی‌سازد", () => {
    const t = newBinding(snapOk(1), { fail: (n) => (n === 2 ? { ok: false, error: { code: "INVALID_OPTIONS", message: "sk-SECRET" } } : undefined) });
    expect(t.binding.acquire().ok).toBe(true);
    t.state.next = snapOk(2);
    const r = t.binding.acquire();
    expect(reasonOf(r)).toBe("BUILD_FAILED");
    expect(JSON.stringify(r)).not.toContain("sk-SECRET");
    expect(reasonOf(t.binding.acquire())).toBe("BUILD_FAILED");
    expect(t.calls).toHaveLength(2); // نسخهٔ ۲ یک بار ساخته شد
    t.state.next = snapOk(1);
    expect(reasonOf(t.binding.acquire())).toBe("VERSION_REGRESSED"); // بازگشت به ۱ هم ممنوع
    t.state.next = snapOk(3);
    expect(t.binding.acquire().ok).toBe(true); // نسخهٔ ۳ دوباره سالم
  });

  it.each([
    ["پرتاب", () => { throw new Error("sk-SECRET"); }],
    ["undefined", () => RAW_UNDEFINED],
    ["null", () => null],
    ["ok:false", () => ({ ok: false })],
    ["ok:1", () => ({ ok: 1, value: {} })],
    ["value:null", () => ({ ok: true, value: null })],
    ["value:عدد", () => ({ ok: true, value: 5 })],
    ["value:رشته", () => ({ ok: true, value: "x" })],
    ["وعده", () => Promise.resolve({ ok: true, value: {} })],
  ])("خروجیِ ناجورِ build (%s) ⇒ BUILD_FAILED", (_n, make) => {
    const t = newBinding(snapOk(1), { fail: () => make() });
    expect(reasonOf(t.binding.acquire())).toBe("BUILD_FAILED");
  });

  it("نمونهٔ تابعی هم پذیرفته می‌شود (value تابع)", () => {
    const fn = (): number => 1;
    const t = newBinding(snapOk(1), { fail: () => ({ ok: true, value: fn }) });
    const r = t.binding.acquire();
    expect(r.ok && (r.value.instance as unknown) === fn).toBe(true);
  });
});

describe("tool-policy-binding · رویدادها و وضعیت", () => {
  it("activated: نسخهٔ نخست با previous=null؛ بعدی با نسخهٔ قبلی", () => {
    const t = newBinding(snapOk(1));
    t.binding.acquire();
    t.binding.acquire();
    t.state.next = snapOk(4);
    t.binding.acquire();
    expect(t.events).toEqual([
      { type: "policy.activated", version: 1, previousVersion: null },
      { type: "policy.activated", version: 4, previousVersion: 1 },
    ]);
  });

  it("unavailable فقط روی تغییرِ دلیل (نه به‌ازای هر درخواست)؛ recovered یک بار با نسخهٔ سالم", () => {
    const t = newBinding(snapErr("NOT_LOADED"));
    for (let i = 0; i < 5; i++) t.binding.acquire();
    t.state.next = snapErr("STALE");
    for (let i = 0; i < 3; i++) t.binding.acquire();
    t.state.next = snapOk(1);
    t.binding.acquire();
    t.binding.acquire();
    expect(t.events).toEqual([
      { type: "policy.unavailable", reason: "NOT_LOADED" },
      { type: "policy.unavailable", reason: "STALE" },
      { type: "policy.activated", version: 1, previousVersion: null },
      { type: "policy.recovered", version: 1 },
    ]);
  });

  it("شکستِ ساخت activated نمی‌دهد و previous به نسخهٔ سالمِ قبلی اشاره می‌کند، نه نسخهٔ شکسته", () => {
    const t = newBinding(snapOk(1), { fail: (n) => (n === 2 ? { ok: false } : undefined) });
    t.binding.acquire();
    t.state.next = snapOk(2);
    t.binding.acquire();
    t.state.next = snapOk(3);
    t.binding.acquire();
    expect(t.events.map((e) => e.type)).toEqual(["policy.activated", "policy.unavailable", "policy.activated", "policy.recovered"]);
    expect(t.events[2]).toEqual({ type: "policy.activated", version: 3, previousVersion: null });
  });

  it("ناظرِ پرتاب‌کننده یا ناهمگامِ ردشونده مسیر را نمی‌شکند", async () => {
    const t = newBinding(snapOk(1), { observer: () => { throw new Error("boom"); } });
    expect(t.binding.acquire().ok).toBe(true);
    const unhandled: unknown[] = [];
    const h = (e: unknown): void => void unhandled.push(e);
    process.on("unhandledRejection", h);
    const t2 = newBinding(snapOk(1), { observer: () => Promise.reject(new Error("async-boom")) });
    expect(t2.binding.acquire().ok).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", h);
    expect(unhandled).toEqual([]);
  });

  it("status: شمارنده‌ها و نسخه‌ها", () => {
    const t = newBinding(snapErr("NOT_LOADED"));
    expect(t.binding.status()).toEqual({ activeVersion: null, highestVersion: null, lastUnavailable: null, activations: 0, buildFailures: 0, acquired: 0, rejected: 0 });
    t.binding.acquire();
    t.state.next = snapOk(2);
    t.binding.acquire();
    t.binding.acquire();
    expect(t.binding.status()).toEqual({ activeVersion: 2, highestVersion: 2, lastUnavailable: null, activations: 1, buildFailures: 0, acquired: 2, rejected: 1 });
    t.state.next = snapErr("STALE");
    t.binding.acquire();
    expect(t.binding.status()).toMatchObject({ activeVersion: null, highestVersion: 2, lastUnavailable: "STALE", rejected: 2 });
    expect(Object.isFrozen(t.binding.status())).toBe(true);
  });

  it("status: buildFailures و خالی‌بودنِ activeVersion", () => {
    const t = newBinding(snapOk(1), { fail: () => ({ ok: false }) });
    t.binding.acquire();
    t.binding.acquire();
    expect(t.binding.status()).toMatchObject({ activeVersion: null, highestVersion: 1, lastUnavailable: "BUILD_FAILED", buildFailures: 1, activations: 0, rejected: 2 });
  });

  it("وضعیت و پیام‌ها هرگز مقدارِ سیاست یا متنِ خطا را نشت نمی‌دهند", () => {
    const t = newBinding(snapOk(1, 1, { projection: { x: "sk-SECRET" } }));
    const r = t.binding.acquire();
    expect(JSON.stringify([r, t.binding.status(), t.events])).not.toContain("sk-SECRET");
  });
});
