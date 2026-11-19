/**
 * settlement-runtime · آداپتورِ زمان‌سنجِ Node. بخشِ نخست با `scheduler` تزریقی (قطعی)؛ بخشِ پایانی با زمانِ واقعی (دودی).
 */
import { describe, expect, it } from "vitest";
import { MAX_TIMEOUT_MS, createNodeTimer } from "./node-timer";
import type { Scheduler } from "./node-timer";

type Fake = Scheduler & { scheduled: { fn: () => void; ms: number; handle: { unref?: () => void; unrefCalls: number } }[]; cleared: unknown[] };

function fakeScheduler(handleFactory: () => unknown = () => ({ unrefCalls: 0, unref() { (this as { unrefCalls: number }).unrefCalls += 1; } })): Fake {
  const scheduled: Fake["scheduled"] = [];
  const cleared: unknown[] = [];
  return {
    scheduled,
    cleared,
    setTimeout(fn, ms) {
      const handle = handleFactory() as Fake["scheduled"][number]["handle"];
      scheduled.push({ fn, ms, handle });
      return handle;
    },
    clearTimeout(h) {
      cleared.push(h);
    },
  };
}

describe("settlement-runtime · createNodeTimer · قرارداد", () => {
  it("after پس از اجرا یک دستگیره می‌دهد و fn را فقط با اجرای زمان‌سنج صدا می‌زند", () => {
    const s = fakeScheduler();
    const t = createNodeTimer({}, s);
    let calls = 0;
    const h = t.after(() => void (calls += 1), 250);
    expect(calls).toBe(0);
    expect(s.scheduled).toHaveLength(1);
    expect(s.scheduled[0]?.ms).toBe(250);
    expect(h).toBe(s.scheduled[0]?.handle);
    s.scheduled[0]?.fn();
    expect(calls).toBe(1);
  });
  it.each([0, 1, 1000, MAX_TIMEOUT_MS])("تأخیرِ معتبر %i پذیرفته می‌شود", (ms) => {
    const s = fakeScheduler();
    expect(() => createNodeTimer({}, s).after(() => undefined, ms)).not.toThrow();
    expect(s.scheduled[0]?.ms).toBe(ms);
  });
  it.each([
    ["منفی", -1],
    ["بی‌نهایت", Number.POSITIVE_INFINITY],
    ["منفی‌بی‌نهایت", Number.NEGATIVE_INFINITY],
    ["NaN", Number.NaN],
    ["بیش از سقف", MAX_TIMEOUT_MS + 1],
    ["رشته", "100"],
    ["null", null],
    ["undefined", undefined],
    ["BigInt", BigInt(5)],
    ["شیء", {}],
  ])("تأخیرِ نامعتبر (%s) می‌پرتابد و هیچ تایمری نمی‌سازد", (_name, ms) => {
    const s = fakeScheduler();
    expect(() => createNodeTimer({}, s).after(() => undefined, ms as never)).toThrow();
    expect(s.scheduled).toHaveLength(0);
  });
  it("fn غیرتابع می‌پرتابد و تایمری نمی‌سازد", () => {
    const s = fakeScheduler();
    expect(() => createNodeTimer({}, s).after("x" as never, 10)).toThrow();
    expect(s.scheduled).toHaveLength(0);
  });
  it("پیام خطای تأخیر مقدارِ ورودی را نمی‌پژواکد", () => {
    try {
      createNodeTimer({}, fakeScheduler()).after(() => undefined, "SECRET-VALUE-123" as never);
      throw new Error("باید می‌پرتابید");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("SECRET-VALUE-123");
    }
  });
  it("fn که می‌پرتابد، از زمان‌سنج به بیرون نشت نمی‌کند (فرایند نمی‌میرد)", () => {
    const s = fakeScheduler();
    createNodeTimer({}, s).after(() => {
      throw new Error("boom");
    }, 1);
    expect(() => s.scheduled[0]?.fn()).not.toThrow();
  });
});

describe("settlement-runtime · createNodeTimer · لغو", () => {
  it("cancel دستگیرهٔ خودش را به clearTimeout می‌دهد", () => {
    const s = fakeScheduler();
    const t = createNodeTimer({}, s);
    const h = t.after(() => undefined, 5);
    t.cancel(h);
    expect(s.cleared).toEqual([h]);
  });
  it("لغوِ تکراری فقط یک بار clearTimeout می‌زند", () => {
    const s = fakeScheduler();
    const t = createNodeTimer({}, s);
    const h = t.after(() => undefined, 5);
    t.cancel(h);
    t.cancel(h);
    expect(s.cleared).toHaveLength(1);
  });
  it.each([undefined, null, 0, 7, "abc", {}, [], () => undefined, Symbol("x")])("دستگیرهٔ بیگانه (%s) بی‌اثر و بی‌پرتاب است", (h) => {
    const s = fakeScheduler();
    const t = createNodeTimer({}, s);
    expect(() => t.cancel(h)).not.toThrow();
    expect(s.cleared).toHaveLength(0);
  });
  it("دستگیرهٔ زمان‌سنجِ دیگر را لغو نمی‌کند", () => {
    const a = createNodeTimer({}, fakeScheduler());
    const sb = fakeScheduler();
    const b = createNodeTimer({}, sb);
    const ha = a.after(() => undefined, 5);
    b.cancel(ha);
    expect(sb.cleared).toHaveLength(0);
  });
});

describe("settlement-runtime · createNodeTimer · unref", () => {
  it("پیش‌فرض: unref می‌شود", () => {
    const s = fakeScheduler();
    createNodeTimer({}, s).after(() => undefined, 5);
    expect(s.scheduled[0]?.handle.unrefCalls).toBe(1);
  });
  it("unref:true صریح هم unref می‌کند", () => {
    const s = fakeScheduler();
    createNodeTimer({ unref: true }, s).after(() => undefined, 5);
    expect(s.scheduled[0]?.handle.unrefCalls).toBe(1);
  });
  it("unref:false: unref نمی‌شود (کارگرِ مستقل)", () => {
    const s = fakeScheduler();
    createNodeTimer({ unref: false }, s).after(() => undefined, 5);
    expect(s.scheduled[0]?.handle.unrefCalls).toBe(0);
  });
  it("دستگیرهٔ بی‌unref (غیرِ Node) خطا نمی‌دهد", () => {
    const s = fakeScheduler(() => ({}));
    const t = createNodeTimer({}, s);
    expect(() => t.after(() => undefined, 5)).not.toThrow();
  });
  it("دستگیرهٔ ابتدایی (عدد) پذیرفته می‌شود ولی cancel آن را لغو نمی‌کند (فقط شیء‌ها پیگیری می‌شوند)", () => {
    const s = fakeScheduler(() => 42);
    const t = createNodeTimer({}, s);
    const h = t.after(() => undefined, 5);
    expect(h).toBe(42);
    t.cancel(h);
    expect(s.cleared).toHaveLength(0);
  });
  it("شیء منجمد است", () => {
    const t = createNodeTimer({}, fakeScheduler());
    expect(Object.isFrozen(t)).toBe(true);
  });
});

describe("settlement-runtime · createNodeTimer · زمانِ واقعی (دودی)", () => {
  it("پس از تأخیر دقیقاً یک بار اجرا می‌شود", async () => {
    const t = createNodeTimer();
    let calls = 0;
    t.after(() => void (calls += 1), 5);
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(1);
  });
  it("لغوشده هرگز اجرا نمی‌شود", async () => {
    const t = createNodeTimer();
    let calls = 0;
    const h = t.after(() => void (calls += 1), 10);
    t.cancel(h);
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(0);
  });
  it("تأخیرِ بیش از سقف (که setTimeout بی‌صدا به ۱ms می‌برد) می‌پرتابد و چیزی اجرا نمی‌شود", async () => {
    const t = createNodeTimer();
    let calls = 0;
    expect(() => t.after(() => void (calls += 1), MAX_TIMEOUT_MS + 1)).toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(0);
  });
});
