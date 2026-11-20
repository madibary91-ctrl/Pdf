/**
 * settlement-bootstrap · http · پسماندِ زنگ (ADR-0043، م۳‑ه‑۴‑الف‑۲‑۲): کلیدِ اختیاریِ `backlog` در بدنهٔ ready/startup و مسدودسازیِ ready فقط با `gate_down ∧ down`.
 * فایلِ تازه است؛ `http.test.ts` دست نخورده (و بدونِ پایشِ ثبت‌شده همان آزمون‌ها بایت‌به‌بایت می‌گذرند).
 * پایشِ واقعی (`createBacklogWatch`) روی outboxِ حافظه‌ایِ واقعیِ `settlement` با زمانِ مجازی؛ بی‌پایگاه.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryOutbox } from "@/modules/settlement";
import type { SettlementOutbox } from "@/modules/settlement";
import { createBacklogWatch } from "@/modules/settlement-backlog-watch";
import type { BacklogReadyPolicy, BacklogWatch } from "@/modules/settlement-backlog-watch";
import { SETTLEMENT_HOST_STORE_KEY, createSettlementHost, getSettlementHost, probeSettlementHost } from "@/modules/settlement-host";
import type { ProbeKind } from "@/modules/settlement-host";
import { BACKLOG_WATCH_STORE_KEY, probeHttpResponse } from "./http";
import { CANARY, flush, manualTimer } from "./test-kit";

const NOW = 50_000_000;
const stores: Record<symbol, unknown>[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await getSettlementHost(s)?.shutdown();
});

const OK_HEALTH = { health: { status: "ok" }, httpStatus: 200 };
async function runningStore(): Promise<Record<symbol, unknown>> {
  const runtime = { start: async () => ({ started: true as const, atMs: 1 }), stop: async () => ({ clean: true }), health: () => OK_HEALTH as never };
  const made = createSettlementHost({ runtime, timer: manualTimer(), signals: false });
  if (!made.ok) throw new Error(made.error.issues.join(";"));
  const store: Record<symbol, unknown> = { [SETTLEMENT_HOST_STORE_KEY]: made.value };
  stores.push(store);
  await made.value.boot();
  return store;
}

const REF = (n: number) => ({ tenantId: "t1", accountId: "a1", reservationId: `r${n}` });
async function bury(outbox: SettlementOutbox, n: number, atMs = NOW - 100): Promise<void> {
  for (let i = 1; i <= n; i++) {
    const b = await outbox.begin({ ...REF(i), unit: "IRR_MICROS", reserved: 500, createdAtMs: 1_000, expiresAtMs: 61_000, dueAtMs: 11_000, orphanRemainder: "forfeit" });
    if (!b.ok) throw new Error(`begin: ${b.error.code}`);
    const d = await outbox.bury(REF(i), { reason: "ATTEMPTS_EXHAUSTED", errorCode: null, atMs });
    if (!d.ok) throw new Error(`bury: ${d.error.code}`);
  }
}

type Rig = { store: Record<symbol, unknown>; watch: BacklogWatch; outbox: SettlementOutbox; timer: ReturnType<typeof manualTimer>; clock: { now: number } };
async function rig(opts: { dead: number; policy?: BacklogReadyPolicy; start?: boolean; register?: boolean }): Promise<Rig> {
  const store = await runningStore();
  const outbox = createMemoryOutbox();
  await bury(outbox, opts.dead);
  const timer = manualTimer();
  const clock = { now: NOW };
  const made = createBacklogWatch({ outbox, clock: { nowMs: () => clock.now }, timer, intervalMs: 1_000, timeoutMs: 500, ...(opts.policy === undefined ? {} : { readyPolicy: opts.policy }) });
  if (!made.ok) throw new Error(made.error.issues.join(";"));
  if (opts.register !== false) store[BACKLOG_WATCH_STORE_KEY] = made.value;
  if (opts.start !== false) {
    made.value.start();
    await flush();
  }
  return { store, watch: made.value, outbox, timer, clock };
}

const read = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, unknown>, headers: r.headers });
const SECTION_KEYS = ["count", "oldestAgeMs", "policy", "reasons", "status", "truncated"];

describe("settlement-bootstrap · http · بدونِ پایشِ ثبت‌شده (ناوردا)", () => {
  it("بدنه و کد دقیقاً همان ProbeResultِ میزبان است و کلیدِ backlog ندارد", async () => {
    const store = await runningStore();
    for (const kind of ["live", "startup", "ready"] as const) {
      const r = await read(probeHttpResponse(store, kind));
      const host = probeSettlementHost(store, kind);
      expect(r.status).toBe(host.httpStatus);
      expect(r.body).toEqual(host.body);
      expect(Object.keys(r.body).sort()).toEqual(["ok", "probe", "state", "sweep"]);
    }
  });
});

describe("settlement-bootstrap · http · پایشِ فعال و سالم", () => {
  it("ready و startup بخشِ backlog با دقیقاً شش کلید دارند؛ live هرگز", async () => {
    const t = await rig({ dead: 0 });
    for (const kind of ["startup", "ready"] as const) {
      const r = await read(probeHttpResponse(t.store, kind));
      expect(r.status).toBe(200);
      expect(r.body["backlog"]).toEqual({ status: "ok", count: 0, truncated: false, oldestAgeMs: null, reasons: [], policy: "report" });
      expect(Object.keys(r.body["backlog"] as object).sort()).toEqual(SECTION_KEYS);
      expect(Object.keys(r.body).sort()).toEqual(["backlog", "ok", "probe", "state", "sweep"]);
    }
    const live = await read(probeHttpResponse(t.store, "live"));
    expect(live.status).toBe(200);
    expect(Object.keys(live.body).sort()).toEqual(["ok", "probe", "state", "sweep"]);
  });

  it("سرایندها همان no-store و JSON/utf-8 می‌مانند", async () => {
    const t = await rig({ dead: 0 });
    for (const kind of ["live", "startup", "ready"] as const) {
      const r = probeHttpResponse(t.store, kind);
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
    }
  });
});

describe("settlement-bootstrap · http · سیاستِ مالک (ADR-0042) روی مسیرِ HTTP", () => {
  it("report (پیش‌فرض) و down: فقط گزارش؛ ready=۲۰۰ و ok=true", async () => {
    const t = await rig({ dead: 10 });
    const r = await read(probeHttpResponse(t.store, "ready"));
    expect(r.status).toBe(200);
    expect(r.body["ok"]).toBe(true);
    expect(r.body["backlog"]).toMatchObject({ status: "down", count: 10, policy: "report" });
  });

  it("gate_down و down: فقط ready ۵۰۳ و ok=false؛ sweep و state دست‌نخورده؛ startup و live ۲۰۰", async () => {
    const t = await rig({ dead: 10, policy: "gate_down" });
    const ready = await read(probeHttpResponse(t.store, "ready"));
    expect(ready.status).toBe(503);
    expect(ready.body).toMatchObject({ probe: "ready", ok: false, state: "running", sweep: "ok", backlog: { status: "down", count: 10, policy: "gate_down" } });
    const startup = await read(probeHttpResponse(t.store, "startup"));
    expect(startup.status).toBe(200);
    expect(startup.body).toMatchObject({ ok: true, backlog: { status: "down", policy: "gate_down" } });
    const live = await read(probeHttpResponse(t.store, "live"));
    expect(live).toMatchObject({ status: 200, body: { ok: true } });
    expect(live.body["backlog"]).toBeUndefined();
  });

  it("gate_down و degraded: ready هنوز ۲۰۰ (فقط down مسدود می‌کند)", async () => {
    const t = await rig({ dead: 1, policy: "gate_down" });
    const r = await read(probeHttpResponse(t.store, "ready"));
    expect(r.status).toBe(200);
    expect(r.body["backlog"]).toMatchObject({ status: "degraded", count: 1 });
  });

  it("بازگشت: پس از تأییدِ مرده‌ها و نمونهٔ بعدی ready دوباره ۲۰۰ می‌شود", async () => {
    const t = await rig({ dead: 10, policy: "gate_down" });
    expect((await read(probeHttpResponse(t.store, "ready"))).status).toBe(503);
    for (let i = 1; i <= 10; i++) await t.outbox.acknowledgeDead(REF(i), { atMs: NOW });
    t.clock.now += 1_000;
    await t.timer.advance(1_000);
    const r = await read(probeHttpResponse(t.store, "ready"));
    expect(r.status).toBe(200);
    expect(r.body["backlog"]).toMatchObject({ status: "ok", count: 0, policy: "gate_down" });
  });

  it("پسماند هرگز ۵۰۳ را ۲۰۰ نمی‌کند: میزبانِ غایب/در خاموشی با پایشِ سالم همچنان ۵۰۳ است (و بخش گزارش می‌شود)", async () => {
    const t = await rig({ dead: 0, policy: "gate_down" });
    const absent: Record<symbol, unknown> = { [BACKLOG_WATCH_STORE_KEY]: t.watch };
    const a = await read(probeHttpResponse(absent, "ready"));
    expect(a.status).toBe(503);
    expect(a.body).toMatchObject({ ok: false, state: "absent", backlog: { status: "ok" } });
    expect((await read(probeHttpResponse(absent, "startup"))).status).toBe(503);
    expect((await read(probeHttpResponse(absent, "live"))).status).toBe(200);
    await getSettlementHost(t.store)?.shutdown();
    expect((await read(probeHttpResponse(t.store, "ready"))).status).toBe(503);
    await flush();
  });

  it("پایشِ ثبت‌شده ولی شروع‌نشده ⇒ بخشِ unknown و هرگز مسدودسازی (حتی gate_down)", async () => {
    const t = await rig({ dead: 50, policy: "gate_down", start: false });
    const r = await read(probeHttpResponse(t.store, "ready"));
    expect(r.status).toBe(200);
    expect(r.body["backlog"]).toEqual({ status: "unknown", count: null, truncated: null, oldestAgeMs: null, reasons: [], policy: "gate_down" });
  });

  it("پایشِ متوقف‌شده: آخرین نمونه می‌ماند و به‌مرور کهنه می‌شود؛ هرگز ok پنداشته نمی‌شود", async () => {
    const t = await rig({ dead: 10, policy: "gate_down" });
    t.watch.stop();
    t.clock.now += 10_000_000;
    const r = await read(probeHttpResponse(t.store, "ready"));
    expect(r.body["backlog"]).toMatchObject({ status: "down" });
    expect((r.body["backlog"] as { reasons: string[] }).reasons).toContain("SAMPLE_STALE");
  });
});

describe("settlement-bootstrap · http · ثبتِ خراب و دشمنانه (شکست‌بسته به «نمی‌دانم»، نه ۵۰۳)", () => {
  const UNKNOWN = { status: "unknown", count: null, truncated: null, oldestAgeMs: null, reasons: [], policy: "report" };
  it.each<[string, unknown]>([
    ["رشته", "x"],
    ["عدد", 5],
    ["null", null],
    ["شیءِ بی‌view", {}],
    ["viewِ غیرتابع", { view: 1 }],
    ["viewِ پرتاب‌کننده", { view: () => { throw new Error(CANARY); } }],
    ["viewِ برگرداننده‌یِ رشته", { view: () => "x" }],
    ["viewِ برگرداننده‌یِ نمایِ ناقص", { view: () => ({ status: "down" }) }],
  ])("ثبتِ %s ⇒ بخشِ unknown، کدِ میزبان دست‌نخورده، بی‌پرتاب و بی‌نشت", async (_n, slot) => {
    const store = await runningStore();
    store[BACKLOG_WATCH_STORE_KEY] = slot;
    for (const kind of ["startup", "ready"] as const) {
      const text = await probeHttpResponse(store, kind).text();
      const body = JSON.parse(text) as Record<string, unknown>;
      expect(body["ok"]).toBe(true);
      expect(body["backlog"]).toEqual(UNKNOWN);
      expect(text).not.toContain(CANARY);
    }
    expect(probeHttpResponse(store, "ready").status).toBe(200);
    expect(probeHttpResponse(store, "live").status).toBe(200);
  });

  it("ظرفِ دشمنانه که فقط خواندنِ کلیدِ پایش را می‌پرتابد ⇒ پاسخِ میزبان بی‌تغییر", async () => {
    const real = await runningStore();
    const hostile = new Proxy(real, { get: (t, k) => (k === BACKLOG_WATCH_STORE_KEY ? (() => { throw new Error(CANARY); })() : Reflect.get(t, k)) });
    for (const kind of ["live", "startup", "ready"] as const) {
      const r = await read(probeHttpResponse(hostile, kind));
      expect(r.status).toBe(200);
      expect(Object.keys(r.body).sort()).toEqual(["ok", "probe", "state", "sweep"]);
    }
  });

  it("فیلدهای اضافی/قناری در نمای پایش هرگز به بدنه نمی‌رسند", async () => {
    const store = await runningStore();
    const view = { phase: "running", status: "degraded", reasons: [{ code: "COUNT_HIGH", message: CANARY }], count: 3, truncated: false, oldestAgeMs: 10, sampleAgeMs: 1, byReason: { A: CANARY }, failure: null, readyPolicy: "report", ids: [CANARY], dsn: CANARY };
    store[BACKLOG_WATCH_STORE_KEY] = { view: () => view };
    const text = await probeHttpResponse(store, "ready").text();
    expect(text).not.toContain(CANARY);
    expect(JSON.parse(text).backlog).toEqual({ status: "degraded", count: 3, truncated: false, oldestAgeMs: 10, reasons: ["COUNT_HIGH"], policy: "report" });
  });
});

describe("settlement-bootstrap · http · خاصیتی روی مسیرِ کامل (۳۰۰۰ ترکیب)", () => {
  it("status=۵۰۳ ⇔ میزبان ناسالم یا (ready ∧ gate_down ∧ down)؛ live بی‌بخش؛ startup بی‌مسدودسازی؛ ok ⇔ ۲۰۰", async () => {
    const running = await runningStore();
    const absent: Record<symbol, unknown> = {};
    const statuses = ["ok", "degraded", "down", "unknown"] as const;
    const kinds: ProbeKind[] = ["live", "startup", "ready"];
    let seed = 20261120;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff);
    for (let i = 0; i < 3000; i++) {
      const kind = kinds[next() % 3] as ProbeKind;
      const hostUp = next() % 2 === 0;
      const status = statuses[next() % 4] as (typeof statuses)[number];
      const policy: BacklogReadyPolicy = next() % 2 === 0 ? "report" : "gate_down";
      const base = hostUp ? running : absent;
      const store: Record<symbol, unknown> = Object.create(base) as Record<symbol, unknown>;
      store[BACKLOG_WATCH_STORE_KEY] = { view: () => ({ phase: "running", status, reasons: [], count: 0, truncated: false, oldestAgeMs: null, sampleAgeMs: 0, byReason: null, failure: null, readyPolicy: policy }) };
      const hostCode = probeSettlementHost(base, kind).httpStatus;
      const r = probeHttpResponse(store, kind);
      const body = (await r.json()) as Record<string, unknown>;
      const blocks = kind === "ready" && policy === "gate_down" && status === "down";
      const label = JSON.stringify({ kind, hostUp, status, policy });
      expect(r.status, label).toBe(hostCode === 503 || blocks ? 503 : 200);
      expect(body["ok"], label).toBe(r.status === 200);
      if (kind === "live") expect(body["backlog"], label).toBeUndefined();
      else expect(body["backlog"], label).toMatchObject({ status, policy });
    }
  });
});
