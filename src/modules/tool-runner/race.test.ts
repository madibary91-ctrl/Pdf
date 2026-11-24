import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { race } from "./race";
import { fakeTimers, tick } from "./test-kit";

describe("race", () => {
  it("مقدار: کار زودتر تمام شود ⇒ value و تایمر پاک می‌شود", async () => {
    const f = fakeTimers();
    expect(await race(() => 7, 100, f.timers)).toEqual({ kind: "value", value: 7 });
    expect(f.pending()).toBe(0);
  });

  it("پرتابِ همگام و ناهمگام ⇒ threw (علت دور ریخته می‌شود)", async () => {
    const f = fakeTimers();
    const sync = await race(() => { throw new Error("SECRET"); }, 100, f.timers);
    const asyn = await race(() => Promise.reject(new Error("SECRET")), 100, f.timers);
    expect(sync).toEqual({ kind: "threw" });
    expect(asyn).toEqual({ kind: "threw" });
    expect(JSON.stringify([sync, asyn])).not.toContain("SECRET");
    expect(f.pending()).toBe(0);
  });

  it("مهلت ⇒ timeout و ردِ دیرهنگامِ کارِ رهاشده unhandled نمی‌شود", async () => {
    const f = fakeTimers();
    const unhandled: unknown[] = [];
    const on = (e: unknown): void => void unhandled.push(e);
    process.on("unhandledRejection", on);
    try {
      let rej: (e: unknown) => void = () => {};
      const p = race(() => new Promise((_, r) => (rej = r)), 100, f.timers);
      await tick();
      expect(f.fire(100)).toBe(1);
      expect(await p).toEqual({ kind: "timeout" });
      rej(new Error("late"));
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", on);
    }
  });

  it("لغو حین اجرا ⇒ aborted؛ شنونده برداشته می‌شود", async () => {
    const f = fakeTimers();
    const ac = new AbortController();
    const p = race(() => new Promise(() => {}), 100, f.timers, ac.signal);
    expect(getEventListeners(ac.signal, "abort")).toHaveLength(1);
    ac.abort();
    expect(await p).toEqual({ kind: "aborted" });
    expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
    expect(f.pending()).toBe(0);
  });

  it("پیش‌ازلغو ⇒ aborted و کار هرگز شروع نمی‌شود، تایمری ساخته نمی‌شود", async () => {
    const f = fakeTimers();
    const ac = new AbortController();
    ac.abort();
    let started = 0;
    expect(await race(() => void started++, 100, f.timers, ac.signal)).toEqual({ kind: "aborted" });
    expect(started).toBe(0);
    expect(f.pending()).toBe(0);
  });

  it("Infinity ⇒ بی‌تایمر؛ فقط لغو یا مقدار", async () => {
    const f = fakeTimers();
    const ac = new AbortController();
    const p = race(() => new Promise<number>((r) => setTimeout(() => r(1), 5)), Infinity, f.timers, ac.signal);
    expect(f.pending()).toBe(0);
    expect(await p).toEqual({ kind: "value", value: 1 });
    expect(getEventListeners(ac.signal, "abort")).toHaveLength(0);
  });

  it("نخستین رویداد برنده است؛ رویدادهای بعدی بی‌اثر", async () => {
    const f = fakeTimers();
    const ac = new AbortController();
    const p = race(() => new Promise<number>((r) => setTimeout(() => r(1), 20)), 100, f.timers, ac.signal);
    ac.abort();
    f.fire(100);
    expect(await p).toEqual({ kind: "aborted" });
  });

  it("مقدارِ همزمان با لغو: ثبتِ مقدارِ ناهمگام پس از لغو بی‌اثر", async () => {
    const f = fakeTimers();
    const ac = new AbortController();
    let res: (v: number) => void = () => {};
    const p = race(() => new Promise<number>((r) => (res = r)), 100, f.timers, ac.signal);
    await tick();
    ac.abort();
    res(9);
    expect(await p).toEqual({ kind: "aborted" });
  });
});
