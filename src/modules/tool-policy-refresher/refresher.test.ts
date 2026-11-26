import { describe, expect, it } from "vitest";
import { createPolicyRefresher } from "./refresher";
import type { PolicyRefresher, RefresherOptions } from "./types";
import { controlledSource, DEADLINE, failResult, fakeTimer, flush, goodOptions, INTERVAL, okResult, RETRY, type FakeTimerOptions } from "./test-kit";

function world(timerOpts: FakeTimerOptions = {}, extra: Partial<Record<keyof RefresherOptions, unknown>> = {}) {
  const t = fakeTimer(timerOpts);
  const s = controlledSource();
  const r = createPolicyRefresher(goodOptions(s.source, t.timer, extra));
  if (!r.ok) throw new Error("refresher");
  return { t, s, r: r.value as PolicyRefresher };
}

describe("tool-policy-refresher · آغاز و دورهٔ موفق", () => {
  it("start نخستین تلاش را بی‌درنگ آغاز می‌کند، منتظرش نمی‌ماند و فقط نگهبانِ مهلت زمان‌بندی می‌شود", () => {
    const { t, s, r } = world();
    expect(r.start()).toEqual({ started: true });
    expect(s.calls()).toBe(1);
    expect(r.status()).toMatchObject({ state: "running", inFlight: true, attempts: 1, lastOutcome: null });
    expect(t.delays()).toEqual([DEADLINE]);
  });

  it("پس از موفقیت: نگهبانِ مهلت لغو و تلاشِ بعد دقیقاً پس از intervalMs (نه یک واحد زودتر)", async () => {
    const { t, s, r } = world();
    r.start();
    s.last().resolve(okResult);
    await flush();
    expect(r.status()).toMatchObject({ inFlight: false, lastOutcome: "ok", consecutiveFailures: 0, lastFailure: null });
    expect(t.delays()).toEqual([INTERVAL]);
    t.advance(INTERVAL - 1);
    expect(s.calls()).toBe(1);
    t.advance(1);
    expect(s.calls()).toBe(2);
    expect(r.status()).toMatchObject({ inFlight: true, attempts: 2 });
    expect(t.delays()).toEqual([DEADLINE]);
  });

  it("هرگز هم‌زمان دو تلاش ندارد: تلاشِ بعد فقط پس از پایانِ تلاشِ قبل زمان‌بندی می‌شود", async () => {
    const { t, s, r } = world();
    r.start();
    t.advance(DEADLINE - 1);
    expect(s.calls()).toBe(1);
    expect(t.pending()).toBe(1);
    s.last().resolve(okResult);
    await flush();
    expect(t.pending()).toBe(1);
    expect(s.calls()).toBe(1);
  });

  it("نتیجهٔ ok با هر شکلِ دیگر (ok غیرِ true، ok رشته، بی‌ok) موفقیت نیست", async () => {
    for (const bad of [{ ok: "true", value: {} }, { ok: 1, value: {} }, { value: {} }, { ok: undefined }]) {
      const { s, r } = world();
      r.start();
      s.last().resolve(bad);
      await flush();
      expect(r.status(), JSON.stringify(bad)).toMatchObject({ lastOutcome: "failed", lastFailure: "INVALID_RESULT", consecutiveFailures: 1 });
    }
  });
});

describe("tool-policy-refresher · شکست و تلاشِ مجدد", () => {
  it("شکستِ منبع با retryMs دوباره می‌کوشد و کدِ منبع را نگه می‌دارد؛ موفقیت شمارنده را صفر می‌کند", async () => {
    const { t, s, r } = world();
    r.start();
    s.last().resolve(failResult("READ_FAILED"));
    await flush();
    expect(r.status()).toMatchObject({ lastOutcome: "failed", lastFailure: "READ_FAILED", consecutiveFailures: 1 });
    expect(t.delays()).toEqual([RETRY]);
    t.advance(RETRY - 1);
    expect(s.calls()).toBe(1);
    t.advance(1);
    expect(s.calls()).toBe(2);
    s.last().resolve(failResult("PROJECTION_INVALID"));
    await flush();
    expect(r.status()).toMatchObject({ lastFailure: "PROJECTION_INVALID", consecutiveFailures: 2 });
    t.advance(RETRY);
    s.last().resolve(okResult);
    await flush();
    expect(r.status()).toMatchObject({ lastOutcome: "ok", lastFailure: null, consecutiveFailures: 0 });
    expect(t.delays()).toEqual([INTERVAL]);
  });

  it("هر هفت کدِ شکستِ شناخته‌شدهٔ منبع همان‌طور گزارش می‌شود", async () => {
    for (const code of ["INVALID_CLOCK", "READ_FAILED", "STORED_POLICY_INVALID", "INVALID_RESPONSE", "PROJECTION_INVALID", "VERSION_REGRESSED", "VERSION_CONTENT_MISMATCH"]) {
      const { s, r } = world();
      r.start();
      s.last().resolve(failResult(code));
      await flush();
      expect(r.status().lastFailure).toBe(code);
    }
  });

  it("کدِ ناشناخته، نتیجهٔ غیرِ شیء، ok:false بی‌خطا و دریافتِ پرتاب‌کننده ⇒ INVALID_RESULT (و کدِ prototype هم شناخته نیست)", async () => {
    const throwing = {
      get ok(): never {
        throw new Error("secret-getter");
      },
    };
    const throwingError = { ok: false, get error(): never { throw new Error("secret-getter"); } };
    const throwingCode = { ok: false, error: { get code(): never { throw new Error("secret-getter"); } } };
    for (const bad of [failResult("NEW_CODE"), failResult("toString"), failResult("constructor"), failResult(5 as never), undefined, null, 7, "x", { ok: false }, { ok: false, error: null }, { ok: false, error: "READ_FAILED" }, { ok: 1, error: { code: "READ_FAILED" } }, { ok: "false", error: { code: "READ_FAILED" } }, throwing, throwingError, throwingCode]) {
      const { s, r } = world();
      r.start();
      s.last().resolve(bad);
      await flush();
      expect(r.status(), String(bad)).toMatchObject({ lastOutcome: "failed", lastFailure: "INVALID_RESULT" });
    }
  });

  it("SUPERSEDED شکستِ منبع نیست: شمارنده و lastFailure دست‌نخورده، ولی با retryMs ادامه می‌دهد", async () => {
    const { t, s, r } = world();
    r.start();
    s.last().resolve(failResult("READ_FAILED"));
    await flush();
    t.advance(RETRY);
    s.last().resolve(failResult("SUPERSEDED"));
    await flush();
    expect(r.status()).toMatchObject({ lastOutcome: "superseded", consecutiveFailures: 1, lastFailure: "READ_FAILED" });
    expect(t.delays()).toEqual([RETRY]);
  });

  it("پرتابِ همگامِ refresh، ردِ وعده و بازگرداندنِ مقدارِ غیروعده همه REFRESH_THREW/INVALID_RESULT و بی‌استثنا", async () => {
    const t = fakeTimer();
    let mode = 0;
    const r = createPolicyRefresher(
      goodOptions(
        {
          refresh: () => {
            mode += 1;
            if (mode === 1) throw new Error("secret-sync");
            if (mode === 2) return Promise.reject(new Error("secret-async"));
            return 5 as unknown as Promise<unknown>;
          },
        },
        t.timer,
      ),
    );
    if (!r.ok) throw new Error("x");
    expect(() => r.value.start()).not.toThrow();
    await flush();
    expect(r.value.status()).toMatchObject({ lastFailure: "REFRESH_THREW", consecutiveFailures: 1, inFlight: false });
    t.advance(RETRY);
    await flush();
    expect(r.value.status()).toMatchObject({ lastFailure: "REFRESH_THREW", consecutiveFailures: 2 });
    t.advance(RETRY);
    await flush();
    expect(r.value.status()).toMatchObject({ lastFailure: "INVALID_RESULT", consecutiveFailures: 3 });
    expect(JSON.stringify(r.value.status())).not.toContain("secret");
  });
});

describe("tool-policy-refresher · تلاشِ بی‌پاسخ (قفلِ همیشگی ممنوع)", () => {
  it("پس از attemptDeadlineMs تلاش timed_out می‌شود و حلقه با retryMs ادامه می‌دهد", async () => {
    const { t, s, r } = world();
    r.start();
    t.advance(DEADLINE - 1);
    expect(r.status()).toMatchObject({ inFlight: true, lastOutcome: null });
    t.advance(1);
    expect(r.status()).toMatchObject({ inFlight: false, lastOutcome: "timed_out", lastFailure: "TIMED_OUT", consecutiveFailures: 1 });
    expect(t.delays()).toEqual([RETRY]);
    t.advance(RETRY);
    expect(s.calls()).toBe(2);
    expect(r.status()).toMatchObject({ inFlight: true, attempts: 2 });
  });

  it("نتیجهٔ دیرهنگامِ تلاشِ رهاشده نادیده است (نه وضعیت، نه زمان‌بندی را عوض می‌کند)", async () => {
    const { t, s, r } = world();
    r.start();
    const first = s.last();
    t.advance(DEADLINE);
    const before = r.status();
    const timers = t.delays();
    first.resolve(okResult);
    await flush();
    expect(r.status()).toEqual(before);
    expect(t.delays()).toEqual(timers);
    first.reject(new Error("late")); // وعدهٔ از‌پیش‌تسویه‌شده؛ بی‌اثر
    await flush();
    expect(s.calls()).toBe(1);
  });

  it("نتیجهٔ دیرهنگامِ رهاشده تلاشِ جدیدِ در جریان را تمام‌شده حساب نمی‌کند", async () => {
    const { t, s, r } = world();
    r.start();
    const first = s.last();
    t.advance(DEADLINE + RETRY);
    expect(r.status()).toMatchObject({ inFlight: true, attempts: 2 });
    first.resolve(okResult);
    await flush();
    expect(r.status()).toMatchObject({ inFlight: true, attempts: 2, lastOutcome: "timed_out" });
    expect(t.delays()).toEqual([DEADLINE]);
  });

  it("پس از ok، نگهبانِ مهلت لغو شده و دیگر timed_out نمی‌شود", async () => {
    const { t, s, r } = world();
    r.start();
    s.last().resolve(okResult);
    await flush();
    t.advance(INTERVAL - 1);
    expect(r.status()).toMatchObject({ lastOutcome: "ok", consecutiveFailures: 0 });
  });
});

describe("tool-policy-refresher · چرخهٔ عمر", () => {
  it("start دوباره ALREADY_RUNNING می‌دهد و تلاشِ دومی نمی‌زند", () => {
    const { s, r } = world();
    r.start();
    expect(r.start()).toEqual({ started: false, reason: "ALREADY_RUNNING" });
    expect(s.calls()).toBe(1);
  });

  it("stop در حالتِ idle بی‌خطر است (stopped، بی‌رهاسازی)", async () => {
    const { r } = world();
    await expect(r.stop()).resolves.toEqual({ stopped: true, abandonedInFlight: false });
    expect(r.status().state).toBe("idle");
  });

  it("stop میانِ دو تلاش: تایمرِ بعد لغو، هیچ تلاشِ تازه‌ای نیست، idle", async () => {
    const { t, s, r } = world();
    r.start();
    s.last().resolve(okResult);
    await flush();
    await expect(r.stop()).resolves.toEqual({ stopped: true, abandonedInFlight: false });
    expect(t.pending()).toBe(0);
    t.advance(10 * INTERVAL);
    expect(s.calls()).toBe(1);
    expect(r.status().state).toBe("idle");
  });

  it("stop با تلاشِ در جریان: stopping تا پایانِ تلاش؛ پس از آن هیچ تایمری نمی‌ماند", async () => {
    const { t, s, r } = world();
    r.start();
    let done = false;
    const p = r.stop().then((v) => {
      done = true;
      return v;
    });
    await flush();
    expect(done).toBe(false);
    expect(r.status()).toMatchObject({ state: "stopping", inFlight: true });
    s.last().resolve(okResult);
    await expect(p).resolves.toEqual({ stopped: true, abandonedInFlight: false });
    expect(r.status()).toMatchObject({ state: "idle", inFlight: false, lastOutcome: "ok" });
    expect(t.pending()).toBe(0);
  });

  it("stop با تلاشِ بی‌پاسخ در سقفِ مهلت تمام می‌شود و abandonedInFlight=true می‌دهد (قفل نمی‌شود)", async () => {
    const { t, r } = world();
    r.start();
    const p = r.stop();
    t.advance(DEADLINE - 1);
    await flush();
    expect(r.status().state).toBe("stopping");
    t.advance(1);
    await expect(p).resolves.toEqual({ stopped: true, abandonedInFlight: true });
    expect(r.status()).toMatchObject({ state: "idle", lastOutcome: "timed_out" });
    expect(t.pending()).toBe(0);
  });

  it("stopهای هم‌زمان یک وعده را شریک‌اند؛ stop پس از پایان دوباره idle می‌دهد", async () => {
    const { s, r } = world();
    r.start();
    const a = r.stop();
    const b = r.stop();
    expect(a).toBe(b);
    s.last().resolve(okResult);
    await a;
    await expect(r.stop()).resolves.toEqual({ stopped: true, abandonedInFlight: false });
  });

  it("start هنگامِ stopping رد می‌شود (STOPPING)", async () => {
    const { s, r } = world();
    r.start();
    const p = r.stop();
    expect(r.start()).toEqual({ started: false, reason: "STOPPING" });
    expect(s.calls()).toBe(1);
    s.last().resolve(okResult);
    await p;
  });

  it("پس از stop می‌شود دوباره start کرد و شمارنده‌ها تجمعی‌اند", async () => {
    const { t, s, r } = world();
    r.start();
    s.last().resolve(failResult("READ_FAILED"));
    await flush();
    await r.stop();
    expect(r.start()).toEqual({ started: true });
    expect(s.calls()).toBe(2);
    expect(r.status()).toMatchObject({ state: "running", attempts: 2, consecutiveFailures: 1 });
    expect(t.pending()).toBe(1);
  });

  it("زمان‌سنجِ نشتی (cancel بی‌اثر): تیکِ کهنه و نگهبانِ تمام‌شده پس از stop تلاش نمی‌سازند", async () => {
    const { t, s, r } = world({ leakyCancel: true });
    r.start();
    s.last().resolve(okResult);
    await flush();
    await r.stop();
    t.fireAll();
    expect(s.calls()).toBe(1);
    expect(r.status()).toMatchObject({ state: "idle", attempts: 1 });
  });

  it("تیکِ نسلِ قبل پس از restart تلاش نمی‌سازد (نسل)", async () => {
    const { t, s, r } = world({ leakyCancel: true });
    r.start(); // نسل ۱، t=0
    s.last().resolve(okResult);
    await flush(); // تیکِ نسل ۱ در t=۱۰۰۰۰ (و cancel نشتی است)
    await r.stop();
    r.start(); // نسل ۲، تلاشِ ۲
    s.last().resolve(okResult);
    await flush(); // تیکِ نسل ۲ در t=۱۰۰۰۰ نیز؛ ولی ترتیب: نسل ۱ زودتر ساخته شد
    expect(s.calls()).toBe(2);
    t.advance(INTERVAL); // هر دو تیک اجرا می‌شوند: فقط تیکِ نسلِ ۲ تلاش می‌سازد
    expect(s.calls()).toBe(3);
    expect(r.status().attempts).toBe(3);
  });

  it("status و نتیجه‌ها یخ‌زده‌اند", async () => {
    const { s, r } = world();
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.status())).toBe(true);
    expect(Object.isFrozen(r.start())).toBe(true);
    expect(Object.isFrozen(r.start())).toBe(true);
    const p = r.stop();
    s.last().resolve(okResult);
    expect(Object.isFrozen(await p)).toBe(true);
    expect(Object.isFrozen(await r.stop())).toBe(true);
  });
});

describe("tool-policy-refresher · شکستِ زمان‌بندی (بی‌صدا نیست)", () => {
  it("نگهبانِ نخستین تلاش ساخته نشد ⇒ SCHEDULE_FAILED، هیچ تلاشی (حتی بی‌نگهبان) نمی‌شود، halted", () => {
    const { s, r } = world({ throwOnAfter: () => true });
    expect(r.start()).toEqual({ started: false, reason: "SCHEDULE_FAILED" });
    expect(s.calls()).toBe(0);
    expect(r.status()).toMatchObject({ state: "halted", haltReason: "SCHEDULE_FAILED", inFlight: false, attempts: 0 });
  });

  it("زمان‌بندیِ تیکِ بعد ناموفق ⇒ halted؛ دیگر تلاشی نیست؛ stop آن را idle می‌کند و start بازیابی می‌دهد", async () => {
    let failNext = false;
    const { t, s, r } = world({ throwOnAfter: (ms) => failNext && ms === INTERVAL });
    r.start();
    failNext = true;
    s.last().resolve(okResult);
    await flush();
    expect(r.status()).toMatchObject({ state: "halted", haltReason: "SCHEDULE_FAILED", inFlight: false });
    t.advance(10 * INTERVAL);
    expect(s.calls()).toBe(1);
    failNext = false;
    expect(r.start()).toEqual({ started: true });
    expect(r.status()).toMatchObject({ state: "running", haltReason: null });
    expect(s.calls()).toBe(2);
  });

  it("نگهبانِ تلاشِ تیک ناموفق ⇒ halted و تلاشِ بی‌نگهبان آغاز نمی‌شود", async () => {
    let calls = 0;
    const { t, s, r } = world({ throwOnAfter: () => (calls += 1) >= 3 });
    r.start(); // after#1: watchdog
    s.last().resolve(okResult);
    await flush(); // after#2: tick
    t.advance(INTERVAL); // after#3: watchdog ⇒ throws
    expect(s.calls()).toBe(1);
    expect(r.status()).toMatchObject({ state: "halted", haltReason: "SCHEDULE_FAILED", inFlight: false, attempts: 1 });
  });

  it("stop روی halted ⇒ idle و haltReason پاک", async () => {
    const { r } = world({ throwOnAfter: () => true });
    r.start();
    await expect(r.stop()).resolves.toEqual({ stopped: true, abandonedInFlight: false });
    expect(r.status()).toMatchObject({ state: "idle", haltReason: null });
  });

  it("cancelِ پرتاب‌کننده حلقه را نمی‌شکند و متنِ آن هرگز بیرون نمی‌آید", async () => {
    const { s, r } = world({ throwOnCancel: true });
    r.start();
    s.last().resolve(okResult);
    await flush();
    await expect(r.stop()).resolves.toEqual({ stopped: true, abandonedInFlight: false });
    expect(JSON.stringify(r.status())).not.toContain("secret");
  });
});

describe("tool-policy-refresher · پیکربندی در ساخت", () => {
  it("ساخت شکست‌خورده شیءِ خطا می‌دهد و هیچ تایمر/تلاشی نمی‌زند", () => {
    const t = fakeTimer();
    const s = controlledSource();
    const r = createPolicyRefresher({ ...goodOptions(s.source, t.timer), intervalMs: 1 });
    expect(r.ok).toBe(false);
    expect(s.calls()).toBe(0);
    expect(t.afterCalls()).toBe(0);
  });
});
