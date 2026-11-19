/**
 * settlement-bootstrap · بوت (ADR-0033): هیچ‌چیز بدونِ on، پایگاه فقط در صورتِ لزوم، بوتِ بی‌مسدودی، تک‌نمونه،
 * بی‌نشتِ پیامِ خطای پایگاه، صاحبِ خروجِ فرایند. زمانِ مجازی و سیگنالِ ساختگی؛ پایگاهِ ساختگیِ مرده
 * (مسیرِ PostgreSQL واقعی در integration.pg.test.ts).
 */
import { afterEach, describe, expect, it } from "vitest";
import { SETTLEMENT_HOST_STORE_KEY, getSettlementHost, probeSettlementHost } from "@/modules/settlement-host";
import { startSettlementBootstrap } from "./bootstrap";
import { CANARY, ON_ENV, SECRET_URL, collector, deadDatabase, fakeSignals, flush, manualTimer } from "./test-kit";
import type { BootstrapOutcome, OpenedDatabase } from "./types";

const stores: Record<symbol, unknown>[] = [];
const newStore = (): Record<symbol, unknown> => {
  const s: Record<symbol, unknown> = {};
  stores.push(s);
  return s;
};
const quiet = { log: () => undefined };

afterEach(async () => {
  for (const s of stores.splice(0)) await getSettlementHost(s)?.shutdown();
});

function setup(over: Record<string, unknown> = {}) {
  const store = newStore();
  const signals = fakeSignals();
  const timer = manualTimer();
  const db = deadDatabase();
  const exits: number[] = [];
  const logs = collector();
  let opens = 0;
  const cfg = {
    env: { ...ON_ENV },
    store,
    processOwner: "host" as const,
    openDatabase: () => {
      opens++;
      return db.opened;
    },
    log: logs.log,
    timer,
    signals,
    exit: (c: number) => void exits.push(c),
    ...over,
  };
  return { cfg, store, signals, timer, db, exits, logs, opens: () => opens };
}

const started = (o: BootstrapOutcome) => {
  if (o.status !== "started") throw new Error(`انتظار started بود: ${JSON.stringify(o)}`);
  return o;
};
const failed = (o: BootstrapOutcome) => {
  if (o.status !== "failed") throw new Error(`انتظار failed بود: ${o.status}`);
  return o;
};

describe("settlement-bootstrap · خاموش و نامعتبر", () => {
  it("پیش‌فرض خاموش: نه پایگاه باز می‌شود، نه میزبانی ساخته می‌شود، نه سیگنالی نصب", async () => {
    for (const env of [{}, { SETTLEMENT_HOST: "off" }, { SETTLEMENT_HOST: "" }]) {
      const t = setup({ env });
      expect(await startSettlementBootstrap(t.cfg)).toEqual({ status: "disabled" });
      expect(t.opens()).toBe(0);
      expect(getSettlementHost(t.store)).toBeNull();
      expect(t.signals.count()).toBe(0);
      expect(t.logs.events).toEqual([{ type: "bootstrap.disabled" }]);
    }
  });

  it("env نامعتبر ⇒ failed/INVALID_ENV؛ پایگاه باز نمی‌شود؛ مقدار در لاگ نمی‌آید", async () => {
    const t = setup({ env: { SETTLEMENT_HOST: "on", SETTLEMENT_GRACE_MS: SECRET_URL } });
    const o = failed(await startSettlementBootstrap(t.cfg));
    expect(o.code).toBe("INVALID_ENV");
    expect(o.issues).toEqual(["SETTLEMENT_GRACE_MS باید عددِ صحیحِ مثبتِ لاتین باشد."]);
    expect(t.opens()).toBe(0);
    expect(getSettlementHost(t.store)).toBeNull();
    expect(t.logs.events).toEqual([{ type: "bootstrap.failed", code: "INVALID_ENV", issues: o.issues }]);
    expect(JSON.stringify([o, t.logs.events])).not.toContain(CANARY);
  });

  it("غلطِ تایپی در نامِ متغیر ⇒ بوت نمی‌شود (نه پیش‌فرضِ خطرناک)", async () => {
    const t = setup({ env: { ...ON_ENV, SETTLEMENT_SHUTDOWN_TIMEOUT: "1000" } });
    expect(failed(await startSettlementBootstrap(t.cfg)).code).toBe("INVALID_ENV");
    expect(t.opens()).toBe(0);
  });

  it("probeها بدونِ میزبان: live=۲۰۰، startup/ready=۵۰۳ با state absent", async () => {
    const t = setup({ env: {} });
    await startSettlementBootstrap(t.cfg);
    expect(probeSettlementHost(t.store, "live").httpStatus).toBe(200);
    expect(probeSettlementHost(t.store, "startup")).toMatchObject({ httpStatus: 503, body: { state: "absent" } });
    expect(probeSettlementHost(t.store, "ready")).toMatchObject({ httpStatus: 503, body: { state: "absent" } });
  });
});

describe("settlement-bootstrap · پیکربندیِ نامعتبر", () => {
  const valid = () => setup().cfg;
  it.each([
    ["null", null],
    ["آرایه", []],
    ["رشته", "x"],
    ["بی‌env", { ...valid(), env: undefined }],
    ["envِ آرایه", { ...valid(), env: [] }],
    ["بی‌store", { ...valid(), store: undefined }],
    ["storeِ رشته", { ...valid(), store: "x" }],
    ["بی‌openDatabase", { ...valid(), openDatabase: undefined }],
    ["openDatabase غیرتابع", { ...valid(), openDatabase: {} }],
    ["بی‌processOwner", { ...valid(), processOwner: undefined }],
    ["processOwner نامعتبر", { ...valid(), processOwner: "both" }],
    ["logِ غیرتابع", { ...valid(), log: 5 }],
    ["کلیدِ ناشناخته", { ...valid(), extra: 1 }],
  ])("%s ⇒ INVALID_CONFIG و بی‌پرتاب", async (_n, raw) => {
    const o = failed(await startSettlementBootstrap(raw));
    expect(o.code).toBe("INVALID_CONFIG");
    expect(o.issues.length).toBeGreaterThan(0);
  });

  it("پیکربندیِ پرتاب‌کننده (Proxy) ⇒ INVALID_CONFIG", async () => {
    const hostile = new Proxy({}, { get() { throw new Error(CANARY); }, ownKeys() { throw new Error(CANARY); } });
    const o = failed(await startSettlementBootstrap(hostile));
    expect(o).toEqual({ status: "failed", code: "INVALID_CONFIG", issues: ["خواندنِ پیکربندی ناموفق بود."] });
  });
});

describe("settlement-bootstrap · بوتِ روشن", () => {
  it("بوت بدونِ انتظار آغاز می‌شود؛ پایگاه یک بار باز و میزبان singleton می‌شود", async () => {
    const t = setup();
    const o = started(await startSettlementBootstrap(t.cfg));
    expect(o.created).toBe(true);
    expect(t.opens()).toBe(1);
    expect(getSettlementHost(t.store)).toBe(o.host);
    expect(t.store[SETTLEMENT_HOST_STORE_KEY]).toBe(o.host);
    expect(t.logs.events[0]).toEqual({ type: "bootstrap.started", created: true, processOwner: "host" });
    expect(o.booting).not.toBeNull();
  });

  it("پایگاهِ مرده ⇒ بوت شکست (PREFLIGHT_FAILED/UNAVAILABLE)، startup و ready ۵۰۳، live ۲۰۰؛ بی‌نشتِ پیامِ خطا", async () => {
    const t = setup();
    const o = started(await startSettlementBootstrap(t.cfg));
    const boot = await (o.booting as Promise<unknown>);
    expect(boot).toEqual({ booted: false, reason: "PREFLIGHT_FAILED", code: "UNAVAILABLE", attempts: 1 });
    expect(probeSettlementHost(t.store, "live").httpStatus).toBe(200);
    expect(probeSettlementHost(t.store, "startup").httpStatus).toBe(503);
    expect(probeSettlementHost(t.store, "ready").httpStatus).toBe(503);
    expect(JSON.stringify([o.host.status(), t.logs.events, probeSettlementHost(t.store, "ready")])).not.toContain(CANARY);
    expect(t.db.executes()).toBeGreaterThan(0);
  });

  it("startSettlementBootstrap منتظرِ پایانِ بوت نمی‌ماند (پایگاهِ کند سرور را نگه نمی‌دارد)", async () => {
    let release!: () => void;
    const hang = new Promise<never>((_r, rej) => (release = () => rej(new Error("late"))));
    const slow = { db: { execute: () => hang, transaction: () => hang }, close: () => undefined };
    const t = setup({ openDatabase: () => slow });
    const o = started(await startSettlementBootstrap(t.cfg)); // با پایگاهِ آویزان هم برمی‌گردد
    expect(o.host.status().state).toBe("booting");
    expect(probeSettlementHost(t.store, "startup").httpStatus).toBe(503);
    release();
    await o.booting;
  });

  it("بازتلاشِ گذرا: SETTLEMENT_BOOT_ATTEMPTS و تأخیر به host می‌رسند (UNAVAILABLE بازتلاش می‌شود)", async () => {
    const t = setup({ env: { ...ON_ENV, SETTLEMENT_BOOT_ATTEMPTS: "3", SETTLEMENT_BOOT_RETRY_DELAY_MS: "750" } });
    const o = started(await startSettlementBootstrap(t.cfg));
    await flush();
    expect(t.timer.delays).toEqual([750]);
    await t.timer.advance(750);
    await flush();
    expect(t.timer.delays).toEqual([750, 750]);
    await t.timer.advance(750);
    expect(await o.booting).toEqual({ booted: false, reason: "PREFLIGHT_FAILED", code: "UNAVAILABLE", attempts: 3 });
    const retried = t.logs.events.filter((e) => e.type === "host" && e.event.type === "boot.attempt_failed");
    expect(retried).toHaveLength(3);
  });

  it("بدونِ بازتلاشِ پیش‌فرض: یک تلاش و بی‌تایمر", async () => {
    const t = setup();
    const o = started(await startSettlementBootstrap(t.cfg));
    expect(await o.booting).toMatchObject({ attempts: 1 });
    expect(t.timer.delays).toEqual([]);
  });

  it("رویدادهای host به لاگ می‌روند و فقط نوعِ بسته‌اند", async () => {
    const t = setup();
    await started(await startSettlementBootstrap(t.cfg)).booting;
    const types = t.logs.events.map((e) => (e.type === "host" ? `host:${e.event.type}` : e.type));
    expect(types).toEqual(["bootstrap.started", "host:boot.attempt_failed", "host:boot.failed"]);
  });

  it("logِ پرتاب‌کننده یا رد‌شونده بوت را نمی‌شکند", async () => {
    const t1 = setup({ log: () => { throw new Error(CANARY); } });
    expect((await startSettlementBootstrap(t1.cfg)).status).toBe("started");
    const t2 = setup({ log: () => Promise.reject(new Error(CANARY)) });
    const o = started(await startSettlementBootstrap(t2.cfg));
    await o.booting;
    await flush();
    expect(o.host.status().state).toBe("failed");
  });
});

describe("settlement-bootstrap · تک‌نمونه و هم‌زمانی", () => {
  it("بار دوم میزبانِ موجود را برمی‌گرداند و پایگاهِ تازه باز نمی‌کند", async () => {
    const t = setup();
    const a = started(await startSettlementBootstrap(t.cfg));
    await a.booting;
    const b = started(await startSettlementBootstrap(t.cfg));
    expect(b.created).toBe(false);
    expect(b.host).toBe(a.host);
    expect(b.booting).toBeNull();
    expect(t.opens()).toBe(1);
  });

  it("دو فراخوانیِ هم‌زمان ⇒ یک باز کردنِ پایگاه و یک نتیجه", async () => {
    const t = setup();
    const [a, b] = await Promise.all([startSettlementBootstrap(t.cfg), startSettlementBootstrap(t.cfg)]);
    expect(a).toBe(b);
    expect(t.opens()).toBe(1);
    expect(t.signals.count()).toBe(2); // SIGTERM و SIGINT، فقط یک بار
  });

  it("نشانگرِ هم‌زمانی پس از پایان پاک می‌شود (بازتلاشِ بعدی ممکن است)", async () => {
    let n = 0;
    const t = setup({ openDatabase: () => { if (n++ === 0) throw new Error(CANARY); return deadDatabase().opened; } });
    expect(failed(await startSettlementBootstrap(t.cfg)).code).toBe("DATABASE_UNAVAILABLE");
    expect(Object.getOwnPropertySymbols(t.store)).toEqual([]);
    expect(started(await startSettlementBootstrap(t.cfg)).created).toBe(true);
  });

  it("میزبانِ ثبت‌شده توسطِ بسته‌بندیِ دیگر پیش از بوت ⇒ همان برمی‌گردد و پایگاه باز نمی‌شود", async () => {
    const t = setup();
    const other = setup();
    const first = started(await startSettlementBootstrap(other.cfg));
    t.store[SETTLEMENT_HOST_STORE_KEY] = first.host;
    const second = started(await startSettlementBootstrap(t.cfg));
    expect(second).toMatchObject({ created: false, booting: null });
    expect(second.host).toBe(first.host);
    expect(t.opens()).toBe(0);
  });

  it("مسابقه: میزبانِ دیگری در فاصلهٔ باز کردنِ پایگاه ثبت شود ⇒ پایگاهِ اضافه بسته و برنده برگردانده می‌شود", async () => {
    const other = setup();
    const first = started(await startSettlementBootstrap(other.cfg));
    const t = setup();
    const extra = deadDatabase();
    const racing = setup({
      store: t.store,
      openDatabase: async () => {
        await flush(2);
        t.store[SETTLEMENT_HOST_STORE_KEY] = first.host; // «بستهٔ دیگر» در همین فاصله ثبت کرد
        return extra.opened;
      },
    });
    const o = started(await startSettlementBootstrap(racing.cfg));
    expect(o).toMatchObject({ created: false, booting: null });
    expect(o.host).toBe(first.host);
    expect(extra.closed()).toBe(1);
    expect(racing.signals.count()).toBe(0);
  });
});

describe("settlement-bootstrap · شکست‌های سازه‌ای (پایگاه بسته می‌شود، چیزی ذخیره نمی‌شود، بی‌نشت)", () => {
  it("openDatabase پرتاب کند ⇒ DATABASE_UNAVAILABLE؛ پیامِ پرتاب در هیچ‌جا نیست", async () => {
    const t = setup({ openDatabase: () => { throw new Error(`boom ${SECRET_URL}`); } });
    const o = failed(await startSettlementBootstrap(t.cfg));
    expect(o).toMatchObject({ code: "DATABASE_UNAVAILABLE", issues: ["openDatabase پرتاب کرد."] });
    expect(JSON.stringify([o, t.logs.events])).not.toContain(CANARY);
    expect(getSettlementHost(t.store)).toBeNull();
    expect(t.signals.count()).toBe(0);
  });

  it("openDatabase رد شود (Promise) ⇒ همان", async () => {
    const t = setup({ openDatabase: () => Promise.reject(new Error(CANARY)) });
    const o = failed(await startSettlementBootstrap(t.cfg));
    expect(o.code).toBe("DATABASE_UNAVAILABLE");
    expect(JSON.stringify([o, t.logs.events])).not.toContain(CANARY);
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["بی‌db", { close: () => undefined }],
    ["بی‌close", { db: {} }],
    ["dbِ رشته", { db: "x", close: () => undefined }],
    ["رشته", "x"],
  ])("openDatabaseِ نتیجهٔ نامعتبر (%s) ⇒ DATABASE_UNAVAILABLE", async (_n, bogus) => {
    const t = setup({ openDatabase: () => bogus });
    expect(failed(await startSettlementBootstrap(t.cfg)).code).toBe("DATABASE_UNAVAILABLE");
    expect(getSettlementHost(t.store)).toBeNull();
  });

  it("شِمای نامعتبر ⇒ RUNTIME_INVALID، پایگاه بسته، مقدارِ شِما در نتیجه نیست", async () => {
    const t = setup({ env: { ...ON_ENV, SETTLEMENT_LEDGER_SCHEMA: `x"; drop schema ${CANARY};--` } });
    const o = failed(await startSettlementBootstrap(t.cfg));
    expect(o.code).toBe("RUNTIME_INVALID");
    expect(o.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify([o, t.logs.events])).not.toContain(CANARY);
    expect(t.db.closed()).toBe(1);
    expect(getSettlementHost(t.store)).toBeNull();
    expect(t.signals.count()).toBe(0);
  });

  it("graceMs خارج از بازهٔ settlement ⇒ RUNTIME_INVALID و پایگاه بسته", async () => {
    const t = setup({ env: { ...ON_ENV, SETTLEMENT_GRACE_MS: "9999999999" } });
    expect(failed(await startSettlementBootstrap(t.cfg)).code).toBe("RUNTIME_INVALID");
    expect(t.db.closed()).toBe(1);
  });

  it("مهلتِ خاموشیِ خارج از بازه ⇒ HOST_INVALID، پایگاه بسته، سیگنالی نصب نشده", async () => {
    const t = setup({ env: { ...ON_ENV, SETTLEMENT_SHUTDOWN_TIMEOUT_MS: "999999999" } });
    expect(failed(await startSettlementBootstrap(t.cfg)).code).toBe("HOST_INVALID");
    expect(t.db.closed()).toBe(1);
    expect(getSettlementHost(t.store)).toBeNull();
    expect(t.signals.count()).toBe(0);
  });

  it("مقدارِ بیگانه زیرِ کلیدِ میزبان ⇒ STORE_INVALID، بازنویسی نمی‌شود، پایگاه بسته", async () => {
    const t = setup();
    const foreign = { hello: CANARY };
    t.store[SETTLEMENT_HOST_STORE_KEY] = foreign;
    const o = failed(await startSettlementBootstrap(t.cfg));
    expect(o.code).toBe("STORE_INVALID");
    expect(t.store[SETTLEMENT_HOST_STORE_KEY]).toBe(foreign);
    expect(t.db.closed()).toBe(1);
    expect(JSON.stringify(o)).not.toContain(CANARY);
  });

  it("ظرفِ فریزشده ⇒ STORE_INVALID و پایگاه بسته (بدونِ پرتاب)", async () => {
    const t = setup({ store: Object.freeze({}) });
    expect(failed(await startSettlementBootstrap(t.cfg)).code).toBe("STORE_INVALID");
    expect(t.db.closed()).toBe(1);
  });

  it("closeِ پایگاه هنگام شکستِ سازه‌ای پرتاب کند ⇒ باز هم نتیجهٔ بسته (نه پرتاب)", async () => {
    const t = setup({
      env: { ...ON_ENV, SETTLEMENT_SHUTDOWN_TIMEOUT_MS: "999999999" },
      openDatabase: () => ({ db: deadDatabase().opened.db, close: () => { throw new Error(CANARY); } }),
    });
    const o = failed(await startSettlementBootstrap(t.cfg));
    expect(o.code).toBe("HOST_INVALID");
    expect(JSON.stringify(o)).not.toContain(CANARY);
  });
});

describe("settlement-bootstrap · خاموشی و صاحبِ خروجِ فرایند", () => {
  it("processOwner=host: SIGTERM ⇒ خاموشیِ مرتب، close فقط پس از توقفِ تمیز، سپس exit(0)", async () => {
    const t = setup({ processOwner: "host" });
    const o = started(await startSettlementBootstrap(t.cfg));
    await o.booting;
    t.signals.emit("SIGTERM");
    await flush();
    expect(t.db.closed()).toBe(1);
    expect(t.exits).toEqual([0]);
    expect(o.host.status().state).toBe("stopped");
    expect(t.signals.count()).toBe(0);
    const fin = t.logs.events.find((e) => e.type === "host" && e.event.type === "shutdown.finished");
    expect(fin).toMatchObject({ event: { ok: true, clean: true, closed: "ok", reason: "SIGTERM" } });
  });

  it("processOwner=next: خاموشی انجام می‌شود ولی ما هرگز exit نمی‌زنیم (Next می‌زند)", async () => {
    const t = setup({ processOwner: "next" });
    const o = started(await startSettlementBootstrap(t.cfg));
    await o.booting;
    expect(t.logs.events[0]).toEqual({ type: "bootstrap.started", created: true, processOwner: "next" });
    t.signals.emit("SIGINT");
    await flush();
    expect(t.db.closed()).toBe(1);
    expect(t.exits).toEqual([]);
    expect(o.host.status().state).toBe("stopped");
  });

  it("processOwner=next حتی اگر exit داده شود نادیده می‌گیرد (دو exit رقیب نمی‌خواهیم)", async () => {
    const t = setup({ processOwner: "next", exit: () => { throw new Error("نباید صدا زده شود"); } });
    const o = started(await startSettlementBootstrap(t.cfg));
    await o.booting;
    t.signals.emit("SIGTERM");
    await flush();
    expect(o.host.status().state).toBe("stopped");
  });

  it("نصبِ سیگنال ناموفق ⇒ رفتگر شروع نمی‌شود (شکست‌بسته) و ready ۵۰۳", async () => {
    const broken = { on: () => { throw new Error(CANARY); }, off: () => undefined };
    const t = setup({ signals: broken });
    const o = started(await startSettlementBootstrap(t.cfg));
    expect(await o.booting).toMatchObject({ booted: false, reason: "SIGNALS_UNAVAILABLE" });
    expect(t.db.executes()).toBe(0); // حتی پیش‌بازرسیِ پایگاه هم اجرا نشد
    expect(probeSettlementHost(t.store, "ready").httpStatus).toBe(503);
  });
});

describe("settlement-bootstrap · سیگنالِ واقعیِ سیستم‌عامل", () => {
  it("SIGTERMِ واقعی به process خودش ⇒ شنوندهٔ ما اجرا می‌شود، exit تزریقی صدا می‌خورد و شنونده‌ها برداشته می‌شوند", async () => {
    const before = [process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")];
    const t = setup({ signals: undefined, processOwner: "host" });
    const o = started(await startSettlementBootstrap(t.cfg));
    await o.booting;
    expect([process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")]).toEqual([before[0]! + 1, before[1]! + 1]);
    process.kill(process.pid, "SIGTERM");
    for (let i = 0; i < 200 && t.exits.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(t.exits).toEqual([0]);
    expect(t.db.closed()).toBe(1);
    expect([process.listenerCount("SIGTERM"), process.listenerCount("SIGINT")]).toEqual(before);
  });
});
