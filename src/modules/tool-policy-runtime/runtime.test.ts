import { describe, expect, it } from "vitest";
import { createToolPolicyRuntime } from "./runtime";
import type { ToolPolicyRuntime } from "./types";
import { DEADLINE, SECRET, deferred, flush, freshSource, makePorts, refresherStatus } from "./test-kit";

function build(opts: Parameters<typeof makePorts>[0] = {}) {
  const k = makePorts(opts);
  const r = createToolPolicyRuntime(k.ports);
  if (!r.ok) throw new Error(`config failed: ${r.error.issues.join(",")}`);
  return { ...k, rt: r.value };
}

describe("tool-policy-runtime · اعتبارسنجیِ پورت‌ها", () => {
  it("پورت‌های درست ⇒ شیءِ یخ‌زده با چهار متد", () => {
    const { rt } = build();
    expect(Object.isFrozen(rt)).toBe(true);
    expect(Object.keys(rt).sort()).toEqual(["health", "snapshot", "start", "stop"]);
  });

  const broken: [string, (p: Record<string, unknown>) => Record<string, unknown>][] = [
    ["preflight", (p) => ({ ...p, preflight: 1 })],
    ["source.snapshot", (p) => ({ ...p, source: { health: () => 1 } })],
    ["source.health", (p) => ({ ...p, source: { snapshot: () => 1 } })],
    ["refresher.start", (p) => ({ ...p, refresher: { stop: () => 1, status: () => 1 } })],
    ["refresher.stop", (p) => ({ ...p, refresher: { start: () => 1, status: () => 1 } })],
    ["refresher.status", (p) => ({ ...p, refresher: { start: () => 1, stop: () => 1 } })],
    ["timer.after", (p) => ({ ...p, timer: { cancel: () => 1 } })],
    ["timer.cancel", (p) => ({ ...p, timer: { after: () => 1 } })],
    ["preflightDeadlineMs", (p) => ({ ...p, preflightDeadlineMs: undefined })],
  ];
  it.each(broken)("پورتِ ناقص «%s» گزارش می‌شود", (issue, mutate) => {
    const r = createToolPolicyRuntime(mutate({ ...makePorts().ports }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_CONFIG");
      expect(r.error.issues).toContain(issue);
    }
  });

  it("کرانِ دقیقِ preflightDeadlineMs: ۱۰۰ و ۳۰۰٬۰۰۰ مجاز؛ ۹۹، ۳۰۰٬۰۰۱، اعشار و رشته نامجاز", () => {
    const ports = makePorts().ports;
    for (const v of [100, 300_000]) expect(createToolPolicyRuntime({ ...ports, preflightDeadlineMs: v }).ok).toBe(true);
    for (const v of [99, 300_001, 1.5, "100", Number.NaN, -1, Infinity]) expect(createToolPolicyRuntime({ ...ports, preflightDeadlineMs: v }).ok, String(v)).toBe(false);
  });

  it("کلیدِ ناشناخته، ورودیِ غیرشیء و getterِ پرتاب‌کننده: شکستِ بسته و بی‌نشت", () => {
    const ports = makePorts().ports;
    const unk = createToolPolicyRuntime({ ...ports, extra: 1 });
    expect(unk.ok === false && unk.error.issues).toContain("unknown:extra");
    for (const v of [null, undefined, 5, "x", [], () => 1]) expect(createToolPolicyRuntime(v).ok).toBe(false);
    const hostile = { ...ports };
    Object.defineProperty(hostile, "timer", {
      enumerable: true,
      get() {
        throw new Error(SECRET);
      },
    });
    const r = createToolPolicyRuntime(hostile);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("s3cr3t");
    const member = createToolPolicyRuntime({
      ...ports,
      source: {
        get snapshot(): unknown {
          throw new Error(SECRET);
        },
        health: () => 1,
      },
    });
    expect(member.ok).toBe(false);
    expect(JSON.stringify(member)).not.toContain("s3cr3t");
  });

  it("هر کلید یک بار خوانده می‌شود (getterِ شمارنده)", () => {
    const ports = makePorts().ports;
    let reads = 0;
    const counted = { ...ports };
    Object.defineProperty(counted, "preflight", {
      enumerable: true,
      get() {
        reads += 1;
        return ports.preflight;
      },
    });
    expect(createToolPolicyRuntime(counted).ok).toBe(true);
    expect(reads).toBe(1);
  });
});

describe("tool-policy-runtime · start", () => {
  it("حالتِ آغازین: IDLE، آماده نیست (NOT_STARTED)، هیچ پورتی صدا نخورده", () => {
    const { rt, s, ft } = build();
    const h = rt.health();
    expect(h).toMatchObject({ state: "IDLE", ready: false, reason: "NOT_STARTED" });
    expect(s.preflightCalls + s.startCalls + s.stopCalls).toBe(0);
    expect(ft.log).toHaveLength(0);
  });

  it("موفقیت: نگهبانِ مهلت پیش از پیش‌بازرسی ساخته و پس از آن لغو می‌شود؛ سپس حلقه یک بار آغاز می‌شود", async () => {
    const { rt, s, ft } = build();
    const order: string[] = [];
    const inner = s.preflight;
    s.preflight = () => {
      order.push(`preflight(timers=${ft.log.length})`);
      return inner();
    };
    expect(await rt.start()).toEqual({ started: true });
    expect(order).toEqual(["preflight(timers=1)"]);
    expect(ft.log).toEqual([{ ms: DEADLINE, cancelled: true }]);
    expect(ft.pending()).toBe(0);
    expect(s.startCalls).toBe(1);
    expect(rt.health()).toMatchObject({ state: "RUNNING", ready: true, reason: null });
  });

  it("start هم‌زمان/تکراری: ALREADY_STARTED و پیش‌بازرسی/حلقه فقط یک بار", async () => {
    const d = deferred<unknown>();
    const { rt, s } = build({ preflight: () => d.promise });
    const first = rt.start();
    expect(await rt.start()).toEqual({ started: false, reason: "ALREADY_STARTED" });
    expect(rt.health()).toMatchObject({ state: "STARTING", ready: false, reason: "STARTING" });
    d.resolve({ ok: true });
    expect(await first).toEqual({ started: true });
    expect(await rt.start()).toEqual({ started: false, reason: "ALREADY_STARTED" });
    expect(s.preflightCalls).toBe(1);
    expect(s.startCalls).toBe(1);
  });

  it.each(["NOT_MIGRATED", "SCHEMA_MISMATCH", "UNAVAILABLE"] as const)("پیش‌بازرسیِ %s: حلقه راه نمی‌افتد، حالت IDLE و بازتلاش ممکن", async (code) => {
    let mode: "bad" | "good" = "bad";
    const { rt, s } = build({ preflight: () => Promise.resolve(mode === "bad" ? { ok: false, code } : { ok: true }) });
    expect(await rt.start()).toEqual({ started: false, reason: code });
    expect(s.startCalls).toBe(0);
    expect(rt.health()).toMatchObject({ state: "IDLE", ready: false, reason: "NOT_STARTED" });
    mode = "good";
    expect(await rt.start()).toEqual({ started: true });
    expect(s.startCalls).toBe(1);
  });

  it("نتیجهٔ پیش‌بازرسی ورودیِ ناشناخته است: هر چیزِ نامعتبر ⇒ UNAVAILABLE", async () => {
    const hostile = {
      get ok(): boolean {
        throw new Error(SECRET);
      },
    };
    const samples: unknown[] = [null, undefined, 5, "ok", [], {}, { ok: "true" }, { ok: 1 }, { ok: false }, { ok: false, code: "constructor" }, { ok: false, code: "toString" }, { ok: false, code: 5 }, { ok: "false", code: "NOT_MIGRATED" }, { ok: 0, code: "SCHEMA_MISMATCH" }, { code: "NOT_MIGRATED" }, hostile];
    for (const [i, v] of samples.entries()) {
      const { rt, s } = build({ preflight: () => Promise.resolve(v) });
      expect(await rt.start(), `sample ${i}`).toEqual({ started: false, reason: "UNAVAILABLE" });
      expect(s.startCalls).toBe(0);
    }
  });

  it("پیش‌بازرسی که همگام می‌پرتابد یا رد می‌شود ⇒ UNAVAILABLE، بی‌نشت، بی‌رد‌شدنِ مدیریت‌نشده", async () => {
    const a = build({
      preflight: () => {
        throw new Error(SECRET);
      },
    });
    expect(await a.rt.start()).toEqual({ started: false, reason: "UNAVAILABLE" });
    const b = build({ preflight: () => Promise.reject(new Error(SECRET)) });
    expect(await b.rt.start()).toEqual({ started: false, reason: "UNAVAILABLE" });
    expect(JSON.stringify([a.rt.health(), b.rt.health()])).not.toContain("s3cr3t");
  });

  it("پیش‌بازرسیِ بی‌پاسخ: با رسیدنِ مهلت UNAVAILABLE؛ نتیجهٔ دیرهنگام بی‌اثر؛ حلقه راه نمی‌افتد", async () => {
    const d = deferred<unknown>();
    const { rt, s, ft } = build({ preflight: () => d.promise });
    const p = rt.start();
    await flush();
    ft.advance(DEADLINE - 1);
    await flush();
    expect(rt.health().state).toBe("STARTING");
    ft.advance(1);
    expect(await p).toEqual({ started: false, reason: "UNAVAILABLE" });
    d.resolve({ ok: true });
    await flush();
    expect(s.startCalls).toBe(0);
    expect(rt.health().state).toBe("IDLE");
  });

  it("timer.after بپرتابد ⇒ پیش‌بازرسی اصلاً صدا نمی‌خورد (تلاشِ بی‌نگهبان ممنوع)", async () => {
    const { rt, s } = build({ timer: { throwOnAfter: true } });
    expect(await rt.start()).toEqual({ started: false, reason: "UNAVAILABLE" });
    expect(s.preflightCalls).toBe(0);
    expect(s.startCalls).toBe(0);
  });

  it("timer.cancel بپرتابد بی‌اثر است و نشت نمی‌کند", async () => {
    const { rt } = build({ timer: { throwOnCancel: true } });
    expect(await rt.start()).toEqual({ started: true });
  });

  it.each([
    ["started:false", () => ({ started: false, reason: "SCHEDULE_FAILED" })],
    ["ALREADY_RUNNING", () => ({ started: false, reason: "ALREADY_RUNNING" })],
    ["garbage", () => "yes"],
    ["undefined", () => undefined],
    [
      "throws",
      () => {
        throw new Error(SECRET);
      },
    ],
  ])("حلقه آغاز نشد (%s) ⇒ SCHEDULE_FAILED، stop برای پاک‌سازی صدا می‌خورد، حالت IDLE", async (_n, result) => {
    const { rt, s } = build();
    s.startResult = result;
    expect(await rt.start()).toEqual({ started: false, reason: "SCHEDULE_FAILED" });
    expect(s.stopCalls).toBe(1);
    expect(s.running).toBe(false);
    expect(rt.health().state).toBe("IDLE");
  });
});

describe("tool-policy-runtime · stop", () => {
  it("stop پیش از start بی‌اثر و idempotent است و به حلقه دست نمی‌زند", async () => {
    const { rt, s } = build();
    expect(await rt.stop()).toEqual({ stopped: true, abandonedInFlight: false });
    expect(await rt.stop()).toEqual({ stopped: true, abandonedInFlight: false });
    expect(s.stopCalls).toBe(0);
    expect(rt.health().state).toBe("IDLE");
  });

  it("stopِ هم‌زمان یک وعده را شریک است و حلقه یک بار بسته می‌شود؛ stopِ بعدی idempotent", async () => {
    const { rt, s } = build();
    await rt.start();
    const d = deferred<unknown>();
    s.stopResult = () => d.promise;
    const a = rt.stop();
    const b = rt.stop();
    expect(a).toBe(b);
    expect(rt.health()).toMatchObject({ state: "STOPPING", ready: false, reason: "STOPPING" });
    expect(await rt.start()).toEqual({ started: false, reason: "STOPPING" });
    d.resolve({ stopped: true, abandonedInFlight: false });
    expect(await a).toEqual({ stopped: true, abandonedInFlight: false });
    expect(s.stopCalls).toBe(1);
    expect(rt.health()).toMatchObject({ state: "STOPPED", ready: false, reason: "NOT_STARTED" });
    expect(await rt.stop()).toEqual({ stopped: true, abandonedInFlight: false });
    expect(s.stopCalls).toBe(1);
  });

  it("abandonedInFlight از حلقه منتقل می‌شود؛ ناشناخته/پرتاب محافظه‌کارانه true", async () => {
    const cases: [() => Promise<unknown>, boolean][] = [
      [() => Promise.resolve({ stopped: true, abandonedInFlight: true }), true],
      [() => Promise.resolve({ stopped: true, abandonedInFlight: false }), false],
      [() => Promise.resolve({ stopped: true }), true],
      [() => Promise.resolve("x"), true],
      [() => Promise.resolve(null), true],
      [() => Promise.reject(new Error(SECRET)), true],
    ];
    for (const [fn, expected] of cases) {
      const { rt, s } = build();
      await rt.start();
      s.stopResult = fn;
      expect(await rt.stop()).toEqual({ stopped: true, abandonedInFlight: expected });
      expect(rt.health().state).toBe("STOPPED");
    }
  });

  it("stop که همگام می‌پرتابد هم بسته می‌شود (STOPPED، abandoned)", async () => {
    const { rt, s } = build();
    await rt.start();
    s.stopResult = () => {
      throw new Error(SECRET);
    };
    expect(await rt.stop()).toEqual({ stopped: true, abandonedInFlight: true });
    expect(rt.health().state).toBe("STOPPED");
  });

  it("stop در میانهٔ start: حلقه هرگز راه نمی‌افتد و start STOPPED_DURING_START می‌دهد", async () => {
    const d = deferred<unknown>();
    const { rt, s } = build({ preflight: () => d.promise });
    const started = rt.start();
    const stopped = rt.stop();
    expect(rt.health().state).toBe("STOPPING");
    d.resolve({ ok: true });
    expect(await started).toEqual({ started: false, reason: "STOPPED_DURING_START" });
    expect(await stopped).toEqual({ stopped: true, abandonedInFlight: false });
    expect(s.startCalls).toBe(0);
    expect(s.running).toBe(false);
    expect(rt.health().state).toBe("STOPPED");
  });

  it("stop تا پایانِ startِ در جریان منتظر می‌ماند (پس از stop هیچ کارِ ناهمگامِ باقی‌مانده‌ای نیست)", async () => {
    const d = deferred<unknown>();
    const { rt } = build({ preflight: () => d.promise });
    const started = rt.start();
    let stopSettled = false;
    const stopped = rt.stop().then((r) => {
      stopSettled = true;
      return r;
    });
    await flush();
    expect(stopSettled).toBe(false);
    d.resolve({ ok: true });
    await stopped;
    expect(stopSettled).toBe(true);
    expect(await started).toEqual({ started: false, reason: "STOPPED_DURING_START" });
  });

  it("stop در میانهٔ start که پیش‌بازرسی‌اش شکست می‌خورد: STOPPED_DURING_START، نه کدِ پیش‌بازرسی", async () => {
    const d = deferred<unknown>();
    const { rt } = build({ preflight: () => d.promise });
    const started = rt.start();
    const stopped = rt.stop();
    d.resolve({ ok: false, code: "NOT_MIGRATED" });
    expect(await started).toEqual({ started: false, reason: "STOPPED_DURING_START" });
    await stopped;
    expect(rt.health().state).toBe("STOPPED");
  });

  it("پس از STOPPED، start دوباره ممکن است و حلقه دوباره آغاز می‌شود", async () => {
    const { rt, s } = build();
    await rt.start();
    await rt.stop();
    expect(await rt.start()).toEqual({ started: true });
    expect(s.startCalls).toBe(2);
    expect(s.preflightCalls).toBe(2);
    expect(rt.health()).toMatchObject({ state: "RUNNING", ready: true });
  });
});

describe("tool-policy-runtime · health", () => {
  const running = async (): Promise<ReturnType<typeof build>> => {
    const b = build();
    await b.rt.start();
    return b;
  };

  it("جدولِ دلیلِ ناآمادگی در حالتِ RUNNING (ترتیبِ اولویت: halted پیش از وضعیتِ منبع)", async () => {
    const rows: [string, Partial<ReturnType<typeof freshSource>>, Partial<ReturnType<typeof refresherStatus>>, string | null][] = [
      ["همه سالم", {}, {}, null],
      ["منبع NOT_LOADED", { state: "NOT_LOADED", version: null }, {}, "NOT_LOADED"],
      ["منبع STALE", { state: "STALE" }, {}, "STALE"],
      ["منبع CLOCK_INVALID", { state: "CLOCK_INVALID" }, {}, "CLOCK_INVALID"],
      ["حلقه halted ولی منبع هنوز FRESH", {}, { state: "halted", haltReason: "SCHEDULE_FAILED" }, "REFRESHER_HALTED"],
      ["حلقه halted و منبع STALE", { state: "STALE" }, { state: "halted", haltReason: "SCHEDULE_FAILED" }, "REFRESHER_HALTED"],
      ["حلقه idle در حالِ RUNNING (ناهمخوان)", {}, { state: "idle" }, "HEALTH_UNAVAILABLE"],
      ["حلقه stopping در حالِ RUNNING (ناهمخوان)", {}, { state: "stopping" }, "HEALTH_UNAVAILABLE"],
    ];
    for (const [name, src, ref, reason] of rows) {
      const { rt, s } = await running();
      s.sourceHealth = () => freshSource(src);
      s.refresherStatus = () => refresherStatus(ref);
      const h = rt.health();
      expect(h.reason, name).toBe(reason);
      expect(h.ready, name).toBe(reason === null);
      expect(h.state).toBe("RUNNING");
    }
  });

  it("منبع FRESH ولی runtime آغاز نشده/متوقف ⇒ آماده نیست", async () => {
    const { rt } = build();
    expect(rt.health().ready).toBe(false);
    await rt.start();
    expect(rt.health().ready).toBe(true);
    await rt.stop();
    expect(rt.health()).toMatchObject({ ready: false, reason: "NOT_STARTED", state: "STOPPED" });
  });

  it("وضعیتِ منبع/حلقه در خروجی می‌آید (فقط کد و عدد)", async () => {
    const { rt } = await running();
    const h = rt.health();
    expect(h.source).toMatchObject({ state: "FRESH", version: 3 });
    expect(h.refresher).toMatchObject({ state: "running" });
  });

  it("health هرگز نمی‌پرتابد: خطای منبع/حلقه یا حالتِ ناشناخته ⇒ HEALTH_UNAVAILABLE و بی‌نشت", async () => {
    const a = await running();
    a.s.sourceHealth = () => {
      throw new Error(SECRET);
    };
    expect(a.rt.health()).toMatchObject({ ready: false, reason: "HEALTH_UNAVAILABLE", source: null });
    const b = await running();
    b.s.refresherStatus = () => {
      throw new Error(SECRET);
    };
    expect(b.rt.health()).toMatchObject({ ready: false, reason: "HEALTH_UNAVAILABLE", refresher: null });
    const c = await running();
    c.s.sourceHealth = () => ({ state: "constructor" }) as never;
    expect(c.rt.health()).toMatchObject({ ready: false, reason: "HEALTH_UNAVAILABLE", source: null });
    const d = await running();
    d.s.refresherStatus = () => ({ state: "toString" }) as never;
    expect(d.rt.health()).toMatchObject({ ready: false, reason: "HEALTH_UNAVAILABLE", refresher: null });
    const e = await running();
    e.s.sourceHealth = () => null as never;
    expect(e.rt.health().ready).toBe(false);
    expect(JSON.stringify([a.rt.health(), b.rt.health()])).not.toContain("s3cr3t");
  });
});

describe("tool-policy-runtime · snapshot", () => {
  it("همان نتیجهٔ منبع را (بی‌تغییر) می‌دهد، حتی پیش از start و پس از stop (بسته‌شدنِ زمانی با منبع است)", async () => {
    const { rt, s } = build();
    const ok = { ok: true, value: { version: 7 } } as never;
    s.snapshot = () => ok;
    expect(rt.snapshot()).toBe(ok);
    await rt.start();
    expect(rt.snapshot()).toBe(ok);
    await rt.stop();
    expect(rt.snapshot()).toBe(ok);
  });

  it("شکستِ منبع (STALE) بی‌تغییر منتقل می‌شود", () => {
    const { rt, s } = build();
    const stale = { ok: false, error: { code: "STALE", message: "x" } } as never;
    s.snapshot = () => stale;
    expect(rt.snapshot()).toBe(stale);
  });

  it("پرتاب یا پاسخِ ناشناخته ⇒ NOT_LOADED (بسته) و بی‌نشت", () => {
    const samples: unknown[] = [null, undefined, 5, "x", {}, { ok: "true" }, { ok: true }, { ok: true, value: null }, { ok: false }, { ok: false, error: {} }, { ok: false, error: { code: 5 } }];
    for (const v of samples) {
      const { rt, s } = build();
      s.snapshot = () => v as never;
      const r = rt.snapshot();
      expect(r, JSON.stringify(v)).toMatchObject({ ok: false, error: { code: "NOT_LOADED" } });
    }
    const { rt, s } = build();
    s.snapshot = () => {
      throw new Error(SECRET);
    };
    const r = rt.snapshot();
    expect(r).toMatchObject({ ok: false, error: { code: "NOT_LOADED" } });
    expect(JSON.stringify(r)).not.toContain("s3cr3t");
  });
});

describe("tool-policy-runtime · وابستگی به this (پورت‌های کلاس‌محور)", () => {
  it("همهٔ پورت‌ها با this صحیح فراخوانی می‌شوند (پورتِ وابسته به this با گمشدنِ this می‌شکند)", async () => {
    class Timer {
      live = new Set<object>();
      afters = 0;
      cancels = 0;
      after(fn: () => void, ms: number): unknown {
        void fn;
        void ms;
        this.afters += 1;
        const h = {};
        this.live.add(h);
        return h;
      }
      cancel(h: unknown): void {
        this.cancels += 1;
        this.live.delete(h as object);
      }
    }
    class Source {
      reads = 0;
      snapshot(): never {
        this.reads += 1;
        return { ok: true, value: { version: 9 } } as never;
      }
      health(): never {
        this.reads += 1;
        return freshSource() as never;
      }
    }
    class Refresher {
      started = 0;
      stopped = 0;
      start(): unknown {
        this.started += 1;
        return { started: true };
      }
      stop(): Promise<unknown> {
        this.stopped += 1;
        return Promise.resolve({ stopped: true, abandonedInFlight: false });
      }
      status(): never {
        this.started += 0;
        return refresherStatus() as never;
      }
    }
    const timer = new Timer();
    const source = new Source();
    const refresher = new Refresher();
    const r = createToolPolicyRuntime({ preflight: () => Promise.resolve({ ok: true }), source, refresher, timer, preflightDeadlineMs: DEADLINE });
    if (!r.ok) throw new Error("config");
    expect(await r.value.start()).toEqual({ started: true });
    expect(timer.afters).toBe(1);
    expect(timer.cancels).toBe(1);
    expect(timer.live.size).toBe(0);
    expect(r.value.snapshot()).toMatchObject({ ok: true, value: { version: 9 } });
    expect(r.value.health()).toMatchObject({ ready: true });
    expect(await r.value.stop()).toEqual({ stopped: true, abandonedInFlight: false });
    expect(refresher.started).toBe(1);
    expect(refresher.stopped).toBe(1);
    expect(source.reads).toBeGreaterThanOrEqual(2);
  });
});

describe("tool-policy-runtime · مدل‌محور (چرخهٔ عمر)", () => {
  const prng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };

  it("۲۰۰ بذر × ۳۰ گام start/stop/پیش‌بازرسیِ دیرهنگام: هرگز دو حلقهٔ هم‌زمان؛ پس از stopِ نهایی حلقه خاموش؛ حالت همیشه معتبر", async () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const rnd = prng(seed);
      const pending: ReturnType<typeof deferred<unknown>>[] = [];
      const { rt, s } = build({
        preflight: () => {
          const d = deferred<unknown>();
          pending.push(d);
          return d.promise;
        },
      });
      const starts: Promise<unknown>[] = [];
      const stops: Promise<unknown>[] = [];
      for (let step = 0; step < 30; step += 1) {
        const x = rnd();
        if (x < 0.3) starts.push(rt.start());
        else if (x < 0.5) stops.push(rt.stop());
        else if (x < 0.85 && pending.length > 0) {
          const d = pending.splice(Math.floor(rnd() * pending.length), 1)[0]!;
          d.resolve(rnd() < 0.7 ? { ok: true } : { ok: false, code: "NOT_MIGRATED" });
        }
        await flush(4);
        const h = rt.health();
        expect(["IDLE", "STARTING", "RUNNING", "STOPPING", "STOPPED"]).toContain(h.state);
        expect(s.startWhileRunning, `seed ${seed}`).toBe(0);
        if (h.ready) expect(h.state).toBe("RUNNING");
      }
      for (const d of pending.splice(0)) d.resolve({ ok: true });
      await Promise.all(starts);
      await rt.stop();
      await Promise.all(stops);
      expect(s.running, `seed ${seed}`).toBe(false);
      expect(["IDLE", "STOPPED"]).toContain(rt.health().state);
      expect(s.startWhileRunning).toBe(0);
    }
  });
});

describe("tool-policy-runtime · نوع", () => {
  it("ToolPolicyRuntime قراردادِ چهارمتدی است (آزمونِ نوع)", () => {
    const f = (r: ToolPolicyRuntime): number => [r.start, r.stop, r.snapshot, r.health].length;
    expect(f(build().rt)).toBe(4);
  });
});
