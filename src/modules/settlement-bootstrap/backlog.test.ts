/**
 * settlement-bootstrap · سیم‌کشیِ پایشِ پسماندِ زنگ (ADR-0043، م۳‑ه‑۴‑الف‑۲‑۲) بی‌پایگاهِ واقعی: خاموشِ پیش‌فرض، شکست‌بستهٔ پیکربندی پیش از ساختنِ میزبان،
 * ثبت در ظرف، «شروع فقط پس از بوتِ موفق» (اینجا بوت با پایگاهِ مرده شکست می‌خورد ⇒ پایش هرگز شروع نمی‌شود)، بی‌نشت.
 * مسیرِ موفقِ بوت و توقف پیش از بستنِ استخر با PostgreSQLِ واقعی در `backlog.pg.test.ts` است. فایلِ تازه؛ هیچ آزمونِ موجودی دست نخورده.
 */
import { afterEach, describe, expect, it } from "vitest";
import { SETTLEMENT_BACKLOG_WATCH_ENV as E } from "@/modules/settlement-backlog-watch";
import { getSettlementHost } from "@/modules/settlement-host";
import { startSettlementBootstrap } from "./bootstrap";
import { BACKLOG_WATCH_STORE_KEY, probeHttpResponse } from "./http";
import { CANARY, ON_ENV, SECRET_URL, collector, deadDatabase, fakeSignals, flush, manualTimer } from "./test-kit";
import type { BootstrapEvent, BootstrapOutcome } from "./types";

const stores: Record<symbol, unknown>[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await getSettlementHost(s)?.shutdown();
});

function setup(env: Record<string, string> = {}, store: Record<symbol, unknown> = {}) {
  stores.push(store);
  const signals = fakeSignals();
  const timer = manualTimer();
  const db = deadDatabase();
  const logs = collector();
  let opens = 0;
  const cfg = {
    env: { ...ON_ENV, ...env },
    store,
    processOwner: "host" as const,
    openDatabase: () => {
      opens++;
      return db.opened;
    },
    log: logs.log,
    timer,
    signals,
    exit: () => undefined,
  };
  return { cfg, store, timer, db, logs, signals, opens: () => opens };
}
const started = (o: BootstrapOutcome) => {
  if (o.status !== "started") throw new Error(`انتظار started بود: ${JSON.stringify(o)}`);
  return o;
};
const failed = (o: BootstrapOutcome) => {
  if (o.status !== "failed") throw new Error(`انتظار failed بود: ${o.status}`);
  return o;
};
const backlogEvents = (events: readonly BootstrapEvent[]) => events.filter((e) => e.type === "bootstrap.backlog_watch");
const states = (events: readonly BootstrapEvent[]) => backlogEvents(events).map((e) => (e.type === "bootstrap.backlog_watch" ? e.state : null));
const SW = { SETTLEMENT_BACKLOG_WATCH: "on" };

describe("settlement-bootstrap · پایشِ پسماند · خاموشِ پیش‌فرض", () => {
  it("بدونِ کلید: هیچ پایشی ساخته/ثبت نمی‌شود، رویدادِ پایش نیست، بدنهٔ پروب چهار کلید است و رفتارِ امروز بی‌تغییر", async () => {
    const t = setup();
    const o = started(await startSettlementBootstrap(t.cfg));
    await o.booting;
    expect(t.store[BACKLOG_WATCH_STORE_KEY]).toBeUndefined();
    expect(backlogEvents(t.logs.events)).toEqual([]);
    const body = (await probeHttpResponse(t.store, "ready").json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["ok", "probe", "state", "sweep"]);
  });

  it("میزبانِ خاموش با کلیدِ پایش: نه پایگاه باز می‌شود نه چیزی ثبت", async () => {
    const t = setup({ SETTLEMENT_HOST: "off", ...SW });
    expect(await startSettlementBootstrap(t.cfg)).toEqual({ status: "disabled" });
    expect(t.opens()).toBe(0);
    expect(t.store[BACKLOG_WATCH_STORE_KEY]).toBeUndefined();
  });

  it("آستانهٔ تنظیم‌شده بی‌کلید ⇒ INVALID_ENV و پایگاه هرگز باز نمی‌شود", async () => {
    const t = setup({ [E.readyPolicy]: "gate_down" });
    const o = failed(await startSettlementBootstrap(t.cfg));
    expect(o).toMatchObject({ code: "INVALID_ENV", issues: [`${E.readyPolicy} تنظیم شده ولی SETTLEMENT_BACKLOG_WATCH روشن (on) نیست.`] });
    expect(t.opens()).toBe(0);
    expect(getSettlementHost(t.store)).toBeNull();
  });
});

describe("settlement-bootstrap · پایشِ پسماند · پیکربندیِ شکست‌بسته", () => {
  it("آستانهٔ غیرمجاز (کهنگی زیرِ کف) ⇒ BACKLOG_INVALID؛ پایگاه بسته؛ میزبان و پایش ساخته نمی‌شوند؛ بی‌نشتِ مقدار", async () => {
    const t = setup({ ...SW, [E.sampleMaxAgeMs]: "1", [E.intervalMs]: "1000", [E.timeoutMs]: "500" });
    const o = failed(await startSettlementBootstrap(t.cfg));
    expect(o.code).toBe("BACKLOG_INVALID");
    expect(o.issues.length).toBeGreaterThan(0);
    expect(t.opens()).toBe(1);
    expect(t.db.closed()).toBe(1);
    expect(getSettlementHost(t.store)).toBeNull();
    expect(t.store[BACKLOG_WATCH_STORE_KEY]).toBeUndefined();
    expect(t.signals.count()).toBe(0);
    expect(t.db.executes()).toBe(0);
    expect(t.timer.pending()).toBe(0);
    expect(t.logs.events).toEqual([{ type: "bootstrap.failed", code: "BACKLOG_INVALID", issues: o.issues }]);
    expect(JSON.stringify([o, t.logs.events])).not.toContain(CANARY);
  });

  it("ترتیبِ degradedCount>downCount ⇒ BACKLOG_INVALID (قواعدِ دامنه در یک جا: createBacklogWatch)", async () => {
    const t = setup({ ...SW, [E.degradedCount]: "9", [E.downCount]: "2" });
    expect(failed(await startSettlementBootstrap(t.cfg)).code).toBe("BACKLOG_INVALID");
    expect(t.db.closed()).toBe(1);
  });

  it("مقدارِ نامعتبرِ env ⇒ INVALID_ENV پیش از باز شدنِ پایگاه و مقدار در پیام نیست", async () => {
    const t = setup({ ...SW, [E.downCount]: SECRET_URL });
    const o = failed(await startSettlementBootstrap(t.cfg));
    expect(o.code).toBe("INVALID_ENV");
    expect(t.opens()).toBe(0);
    expect(JSON.stringify([o, t.logs.events])).not.toContain(CANARY);
  });
});

describe("settlement-bootstrap · پایشِ پسماند · ثبت و چرخهٔ عمر", () => {
  it("روشن: پایش در ظرف ثبت می‌شود و رویدادِ armed با سیاست (نه مقدارِ آستانه) می‌آید؛ پیش‌فرض report", async () => {
    const t = setup(SW);
    const o = started(await startSettlementBootstrap(t.cfg));
    const slot = t.store[BACKLOG_WATCH_STORE_KEY] as { view(): { phase: string } };
    expect(typeof slot.view).toBe("function");
    expect(backlogEvents(t.logs.events)).toEqual([{ type: "bootstrap.backlog_watch", state: "armed", readyPolicy: "report" }]);
    await o.booting;
  });

  it("سیاستِ gate_down از env تا رویداد و نما می‌رسد", async () => {
    const t = setup({ ...SW, [E.readyPolicy]: "gate_down" });
    const o = started(await startSettlementBootstrap(t.cfg));
    expect(backlogEvents(t.logs.events)).toEqual([{ type: "bootstrap.backlog_watch", state: "armed", readyPolicy: "gate_down" }]);
    const slot = t.store[BACKLOG_WATCH_STORE_KEY] as { view(): { readyPolicy: string } };
    expect(slot.view().readyPolicy).toBe("gate_down");
    await o.booting;
  });

  it("بوتِ ناموفق (پایگاهِ مرده) ⇒ پایش هرگز شروع نمی‌شود: فاز idle، بی‌خواندن، بی‌تایمرِ پایش؛ پروب‌ها unknown و ready ۵۰۳ به‌خاطرِ میزبان", async () => {
    const t = setup(SW);
    const o = started(await startSettlementBootstrap(t.cfg));
    const boot = await o.booting;
    expect(boot).toMatchObject({ booted: false });
    await flush();
    const slot = t.store[BACKLOG_WATCH_STORE_KEY] as { view(): { phase: string; status: string } };
    expect(slot.view()).toMatchObject({ phase: "idle", status: "unknown" });
    expect(t.timer.delays).toEqual([]); // نه بازتلاشِ میزبان و نه گذرِ پایش
    expect(states(t.logs.events)).toEqual(["armed"]);
    // شمارِ پرسش‌های پایگاه همان پیش‌بازرسیِ میزبان است (پایش پرسشی نزده): با اجرای بی‌پایش یکی است.
    const base = setup();
    await started(await startSettlementBootstrap(base.cfg)).booting;
    expect(t.db.executes()).toBe(base.db.executes());
    const ready = await probeHttpResponse(t.store, "ready").json();
    expect(ready).toMatchObject({ ok: false, backlog: { status: "unknown", count: null } });
    const live = await probeHttpResponse(t.store, "live");
    expect(live.status).toBe(200);
    expect(Object.keys(await live.json()).sort()).toEqual(["ok", "probe", "state", "sweep"]);
  });

  it("خاموشی پس از بوتِ ناموفق: پایگاه یک بار بسته و رویدادِ stopped نیست (هیچ‌وقت شروع نشده بود)", async () => {
    const t = setup(SW);
    const o = started(await startSettlementBootstrap(t.cfg));
    await o.booting;
    await o.host.shutdown();
    expect(t.db.closed()).toBe(1);
    expect(states(t.logs.events)).toEqual(["armed"]);
  });

  it("فراخوانیِ دوباره با میزبانِ موجود پایشِ تازه نمی‌سازد و همان را نگه می‌دارد", async () => {
    const t = setup(SW);
    const o = started(await startSettlementBootstrap(t.cfg));
    const first = t.store[BACKLOG_WATCH_STORE_KEY];
    await o.booting;
    await flush();
    const again = started(await startSettlementBootstrap(t.cfg));
    expect(again.created).toBe(false);
    expect(t.store[BACKLOG_WATCH_STORE_KEY]).toBe(first);
    expect(t.opens()).toBe(1);
    expect(backlogEvents(t.logs.events)).toHaveLength(1);
  });

  it("ظرفی که ثبتِ کلیدِ پایش را رد می‌کند ⇒ پایش نادیده (بی‌رویدادِ armed)، بوتِ میزبان سالم و پروب بی‌کلیدِ backlog", async () => {
    const base: Record<symbol, unknown> = {};
    const store = new Proxy(base, { set: (tgt, key, val) => (key === BACKLOG_WATCH_STORE_KEY ? (() => { throw new Error(CANARY); })() : Reflect.set(tgt, key, val)) });
    const t = setup(SW, store);
    const o = started(await startSettlementBootstrap(t.cfg));
    expect(await o.booting).toMatchObject({ booted: false });
    expect(backlogEvents(t.logs.events)).toEqual([]);
    expect(base[BACKLOG_WATCH_STORE_KEY]).toBeUndefined();
    expect(Object.keys((await probeHttpResponse(base, "ready").json()) as object).sort()).toEqual(["ok", "probe", "state", "sweep"]);
    expect(JSON.stringify(t.logs.events)).not.toContain(CANARY);
  });

  it("ظرفی که ثبت را بی‌صدا نادیده می‌گیرد (set ⇒ true بی‌ذخیره) هم همان است", async () => {
    const base: Record<symbol, unknown> = {};
    const store = new Proxy(base, { set: (tgt, key, val) => (key === BACKLOG_WATCH_STORE_KEY ? true : Reflect.set(tgt, key, val)) });
    const t = setup(SW, store);
    const o = started(await startSettlementBootstrap(t.cfg));
    await o.booting;
    expect(backlogEvents(t.logs.events)).toEqual([]);
  });

  it("پایش از همان زمان‌سنجِ تزریقیِ میزبان استفاده می‌کند (پس از خاموشی هیچ تایمرِ آویزانی نمی‌ماند)", async () => {
    const t = setup(SW);
    const o = started(await startSettlementBootstrap(t.cfg));
    await o.booting;
    await o.host.shutdown();
    await flush();
    expect(t.timer.pending()).toBe(0);
  });
});
