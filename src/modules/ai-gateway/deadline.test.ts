import { describe, expect, it } from "vitest";
import { raceDeadline } from "./deadline";
import { ManualTimers, deferred } from "./test-kit";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("ai-gateway · raceDeadline", () => {
  it("کار پیش از مهلت: value؛ تایمر پاک می‌شود", async () => {
    const t = new ManualTimers();
    const d = deferred<number>();
    const p = raceDeadline(d.promise, 100, t);
    expect(t.pending).toBe(1);
    d.resolve(7);
    expect(await p).toEqual({ kind: "value", value: 7 });
    expect(t.pending).toBe(0);
  });

  it("رد شدن کار: threw با همان خطا", async () => {
    const t = new ManualTimers();
    const boom = new Error("x");
    expect(await raceDeadline(Promise.reject(boom), 100, t)).toEqual({ kind: "threw", error: boom });
    expect(t.pending).toBe(0);
  });

  it("مهلت: timeout در لحظهٔ دقیق (۹۹ نه، ۱۰۰ بله)؛ پایان دیرهنگام کار اثری ندارد", async () => {
    const t = new ManualTimers();
    const d = deferred<number>();
    const p = raceDeadline(d.promise, 100, t);
    t.advance(99);
    let settled = false;
    void p.then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    t.advance(1);
    expect(await p).toEqual({ kind: "timeout" });
    d.resolve(1);
    await tick();
  });

  it("لغو: aborted و شنوندهٔ سیگنال برداشته می‌شود", async () => {
    const t = new ManualTimers();
    const c = new AbortController();
    let removed = 0;
    const orig = c.signal.removeEventListener.bind(c.signal);
    c.signal.removeEventListener = ((...a: Parameters<typeof orig>) => { removed++; return orig(...a); }) as typeof orig;
    const p = raceDeadline(new Promise<never>(() => undefined), 100, t, c.signal);
    c.abort();
    expect(await p).toEqual({ kind: "aborted" });
    expect(removed).toBe(1);
    expect(t.pending).toBe(0);
  });

  it("سیگنالِ از پیش لغوشده: بی‌درنگ aborted و بدون تایمر باقی‌مانده یا شنونده", async () => {
    const t = new ManualTimers();
    const c = new AbortController();
    c.abort();
    let added = 0;
    const orig = c.signal.addEventListener.bind(c.signal);
    c.signal.addEventListener = ((...a: Parameters<typeof orig>) => { added++; return orig(...a); }) as typeof orig;
    expect(await raceDeadline(new Promise<never>(() => undefined), 100, t, c.signal)).toEqual({ kind: "aborted" });
    expect(added).toBe(0);
    expect(t.pending).toBe(0);
  });

  it("اولین پایان برنده است: پایان کار سپس مهلت/لغو، نتیجه را عوض نمی‌کند", async () => {
    const t = new ManualTimers();
    const c = new AbortController();
    const p = raceDeadline(Promise.resolve("ok"), 100, t, c.signal);
    expect(await p).toEqual({ kind: "value", value: "ok" });
    c.abort();
    t.advance(1000);
    expect(await p).toEqual({ kind: "value", value: "ok" });
  });
});
