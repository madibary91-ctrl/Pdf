/**
 * حلقهٔ تازه‌سازی روی منبعِ **واقعی** و مدیرِ نسخه‌دارِ **واقعی** (ADR-0072): ساعتِ منبع و زمان‌سنجِ حلقه با هم جلو می‌روند.
 * ثابت می‌شود که حلقه + منبع در برابرِ خرابی، تلاشِ بی‌پاسخ و تلاشِ کُند همان رفتارِ بستهٔ طراحی را دارند، و رابطهٔ پیکربندی
 * (interval + 3·deadline + retry ≤ maxStale) واقعاً «یک چرخهٔ ازدست‌رفته» را بدونِ STALE تحمل می‌کند.
 */
import { describe, expect, it } from "vitest";
import { createPolicyRefresher } from "@/modules/tool-policy-refresher";
import { createPolicySource } from "@/modules/tool-policy-source";
import { createMemoryPolicyStore, createToolPolicyAdmin } from "@/modules/tool-policy-admin";
import { compat, fakeClock, setPolicy, wrapStore } from "../src/modules/tool-policy-admin/test-kit";
import { fakeTimer, flush } from "../src/modules/tool-policy-refresher/test-kit";

const INTERVAL = 10_000;
const RETRY = 2_000;
const DEADLINE = 6_000;
const REFRESH_TIMEOUT = 5_000;
const STEP = 100;

type Mode = "normal" | "broken" | "hang" | { slowMs: number };

function world(maxStaleMs = 60_000) {
  const clock = fakeClock(1_800_000_000_000);
  const inner = createMemoryPolicyStore();
  let mode: Mode = "normal";
  const slow: { at: number; release: () => void }[] = [];
  const store = wrapStore(inner, {
    latest: (() => {
      if (mode === "broken") return Promise.resolve({ ok: false, error: { code: "UNAVAILABLE" } });
      if (mode === "hang") return new Promise(() => undefined);
      if (typeof mode === "object") {
        const ms = mode.slowMs;
        return new Promise((resolve) => slow.push({ at: clock.nowMs() + ms, release: () => resolve(inner.latest()) }));
      }
      return inner.latest();
    }) as never,
  });
  const a = createToolPolicyAdmin({ store, clock });
  if (!a.ok) throw new Error("admin");
  const s = createPolicySource({ reader: a.value, clock, maxStaleMs, refreshTimeoutMs: REFRESH_TIMEOUT });
  if (!s.ok) throw new Error("source");
  const source = s.value;
  const timer = fakeTimer();
  const r = createPolicyRefresher({ source, timer: timer.timer, intervalMs: INTERVAL, retryMs: RETRY, attemptDeadlineMs: DEADLINE, refreshTimeoutMs: REFRESH_TIMEOUT, maxStaleMs });
  if (!r.ok) throw new Error(`refresher ${r.error.issues.join(",")}`);
  /** زمان را STEP‌به‌STEP جلو می‌برد و پس از هر گام وضعیتِ snapshot را به `observe` می‌دهد. */
  async function run(ms: number, observe?: (code: string) => void): Promise<void> {
    for (let done = 0; done < ms; done += STEP) {
      clock.advance(STEP);
      timer.advance(STEP);
      for (const q of slow.splice(0).filter((x) => (x.at <= clock.nowMs() ? (x.release(), false) : true))) slow.push(q);
      await flush();
      const snap = source.snapshot();
      observe?.(snap.ok ? "OK" : snap.error.code);
    }
  }
  return { admin: a.value, source, refresher: r.value, clock, timer, run, setMode: (m: Mode) => void (mode = m) };
}

describe("tool-policy-refresher ⇄ منبع و مدیرِ واقعی", () => {
  it("start ← بارِ نخست (نسخهٔ ۰ صریحاً از مدیر)؛ پیش از آن NOT_LOADED؛ سپس نسخهٔ تازهٔ ادمین در دورهٔ بعد دیده می‌شود", async () => {
    const w = world();
    expect(w.source.snapshot()).toMatchObject({ ok: false, error: { code: "NOT_LOADED" } });
    w.refresher.start();
    await flush();
    expect(w.source.snapshot()).toMatchObject({ ok: true, value: { version: 0, source: "defaults" } });
    expect((await setPolicy(w.admin, 0, compat(60_000, 20_000))).ok).toBe(true);
    await w.run(INTERVAL - STEP);
    expect(w.source.snapshot()).toMatchObject({ ok: true, value: { version: 0 } });
    await w.run(STEP);
    expect(w.source.snapshot()).toMatchObject({ ok: true, value: { version: 1, source: "stored" } });
    expect(w.refresher.status()).toMatchObject({ state: "running", lastOutcome: "ok", consecutiveFailures: 0 });
  });

  it("خرابیِ ذخیره‌ساز: آخرین‌خوب تا سقف می‌ماند، سپس STALE (بسته، هرگز پیش‌فرض)؛ حلقه با retryMs می‌کوشد؛ بهبود ⇒ دوباره FRESH", async () => {
    const w = world(60_000);
    w.refresher.start();
    await setPolicy(w.admin, 0, compat(90_000, 30_000));
    await w.run(INTERVAL + STEP);
    expect(w.source.snapshot()).toMatchObject({ ok: true, value: { version: 1 } });
    w.setMode("broken");
    const codes = new Set<string>();
    await w.run(90_000, (c) => codes.add(c));
    expect(codes.has("STALE")).toBe(true);
    expect(w.source.snapshot()).toMatchObject({ ok: false, error: { code: "STALE" } });
    const st = w.refresher.status();
    expect(st.consecutiveFailures).toBeGreaterThan(20);
    expect(st.lastFailure).toBe("READ_FAILED");
    w.setMode("normal");
    await w.run(RETRY + STEP);
    expect(w.source.snapshot()).toMatchObject({ ok: true, value: { version: 1, source: "stored" } });
    expect(w.refresher.status()).toMatchObject({ consecutiveFailures: 0, lastOutcome: "ok" });
  });

  it("خواندنِ بی‌پاسخ برای همیشه حلقه را قفل نمی‌کند: نگهبانِ مهلت، سپس منبع تلاشِ قدیمی را رها و تلاشِ نو موفق می‌شود", async () => {
    const w = world();
    w.setMode("hang");
    w.refresher.start();
    await w.run(DEADLINE);
    expect(w.refresher.status()).toMatchObject({ lastOutcome: "timed_out", inFlight: false });
    expect(w.source.snapshot()).toMatchObject({ ok: false, error: { code: "NOT_LOADED" } });
    w.setMode("normal");
    await w.run(RETRY);
    expect(w.refresher.status()).toMatchObject({ lastOutcome: "ok", consecutiveFailures: 0 });
    expect(w.source.snapshot()).toMatchObject({ ok: true, value: { version: 0 } });
  });

  it("رابطهٔ تحمل در بدترین حالت (maxStale = کمینهٔ مجاز): تلاشِ کُندِ موفق (۵٫۹ث) ← یک تلاشِ بی‌پاسخ ← تلاشِ کُندِ موفق ⇒ هرگز STALE نمی‌شود", async () => {
    const maxStale = INTERVAL + 3 * DEADLINE + RETRY;
    const w = world(maxStale);
    await setPolicy(w.admin, 0, compat(60_000, 20_000));
    w.setMode({ slowMs: 5_900 });
    w.refresher.start();
    await w.run(5_900);
    expect(w.refresher.status()).toMatchObject({ lastOutcome: "ok" });
    w.setMode("hang");
    const bad: string[] = [];
    await w.run(INTERVAL + STEP, (c) => c !== "OK" && bad.push(c)); // تلاشِ بی‌پاسخ در t=۱۵٫۹ آغاز شد
    w.setMode({ slowMs: 5_900 });
    await w.run(14_300, (c) => c !== "OK" && bad.push(c)); // مهلت ← retry ← تلاشِ کُند ← موفقیت در t≈۲۹٫۸
    expect(bad).toEqual([]);
    expect(w.refresher.status()).toMatchObject({ lastOutcome: "ok", consecutiveFailures: 0 });
  });

  it("رابطه فقط «یک» چرخهٔ ازدست‌رفته را تحمل می‌کند: دو تلاشِ بی‌پاسخِ پیاپی با همان maxStale ⇒ STALE (بسته؛ طراحی)", async () => {
    const w = world(INTERVAL + 3 * DEADLINE + RETRY);
    w.refresher.start();
    await flush();
    w.setMode("hang");
    const codes = new Set<string>();
    await w.run(60_000, (c) => codes.add(c));
    expect(codes.has("STALE")).toBe(true);
    expect(w.source.snapshot()).toMatchObject({ ok: false, error: { code: "STALE" } });
  });

  it("stop پایانِ مرتب: هیچ تایمر یا خواندنِ تازه‌ای نمی‌ماند و پس از آن snapshot به‌تدریج STALE می‌شود (بسته)", async () => {
    const w = world(30_000);
    w.refresher.start();
    await flush();
    await expect(w.refresher.stop()).resolves.toEqual({ stopped: true, abandonedInFlight: false });
    expect(w.timer.pending()).toBe(0);
    await w.run(31_000);
    expect(w.source.snapshot()).toMatchObject({ ok: false, error: { code: "STALE" } });
  });
});
