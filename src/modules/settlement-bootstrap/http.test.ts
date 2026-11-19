/**
 * settlement-bootstrap · پاسخ HTTP پروب‌ها (ADR-0033 تصمیم ۴): ترجمهٔ بسته، بی‌کش، بی‌نشت، بی‌پرتاب.
 */
import { afterEach, describe, expect, it } from "vitest";
import { SETTLEMENT_HOST_STORE_KEY, createSettlementHost, getSettlementHost } from "@/modules/settlement-host";
import type { ProbeKind, SettlementHost } from "@/modules/settlement-host";
import { probeHttpResponse } from "./http";
import { CANARY, flush, manualTimer } from "./test-kit";

const stores: Record<symbol, unknown>[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await getSettlementHost(s)?.shutdown();
});

function hostWith(health: unknown): { store: Record<symbol, unknown>; host: SettlementHost } {
  const runtime = { start: async () => ({ started: true as const, atMs: 1 }), stop: async () => ({ clean: true }), health: () => health as never };
  const made = createSettlementHost({ runtime, timer: manualTimer(), signals: false });
  if (!made.ok) throw new Error(made.error.issues.join(";"));
  const store: Record<symbol, unknown> = { [SETTLEMENT_HOST_STORE_KEY]: made.value };
  stores.push(store);
  return { store, host: made.value };
}
const OK_HEALTH = { health: { status: "ok" }, httpStatus: 200 };
const read = async (r: Response) => ({ status: r.status, body: (await r.json()) as Record<string, unknown>, headers: r.headers });

describe("settlement-bootstrap · http · بدونِ میزبان", () => {
  it.each<[ProbeKind, number]>([["live", 200], ["startup", 503], ["ready", 503]])("%s ⇒ %i با state absent", async (kind, status) => {
    const r = await read(probeHttpResponse({}, kind));
    expect(r.status).toBe(status);
    expect(r.body).toEqual({ probe: kind, ok: status === 200, state: "absent", sweep: null });
  });
});

describe("settlement-bootstrap · http · با میزبان", () => {
  it("running ⇒ هر سه ۲۰۰", async () => {
    const { store, host } = hostWith(OK_HEALTH);
    await host.boot();
    for (const kind of ["live", "startup", "ready"] as const) {
      const r = await read(probeHttpResponse(store, kind));
      expect(r).toMatchObject({ status: 200, body: { probe: kind, ok: true, state: "running" } });
    }
    expect((await read(probeHttpResponse(store, "ready"))).body["sweep"]).toBe("ok");
  });

  it("وضعیتِ degraded هنوز ready=۲۰۰ است و down ۵۰۳", async () => {
    const a = hostWith({ health: { status: "degraded" }, httpStatus: 200 });
    await a.host.boot();
    expect(await read(probeHttpResponse(a.store, "ready"))).toMatchObject({ status: 200, body: { sweep: "degraded" } });
    const b = hostWith({ health: { status: "down" }, httpStatus: 503 });
    await b.host.boot();
    expect(await read(probeHttpResponse(b.store, "ready"))).toMatchObject({ status: 503, body: { sweep: "down", ok: false } });
    expect((await read(probeHttpResponse(b.store, "live"))).status).toBe(200);
  });

  it("پس از شروعِ خاموشی ready=۵۰۳ ولی live=۲۰۰ و startup چسبنده ۲۰۰", async () => {
    const { store, host } = hostWith(OK_HEALTH);
    await host.boot();
    await host.shutdown();
    expect((await read(probeHttpResponse(store, "ready"))).status).toBe(503);
    expect((await read(probeHttpResponse(store, "live"))).status).toBe(200);
    expect((await read(probeHttpResponse(store, "startup"))).status).toBe(200);
    await flush();
  });

  it("بدنه فقط چهار کلیدِ بسته دارد و پیامِ خطا/قناری نشت نمی‌کند", async () => {
    const { store, host } = hostWith({ health: { status: "ok", message: CANARY, ids: [CANARY] }, httpStatus: 200, message: CANARY });
    await host.boot();
    const text = await probeHttpResponse(store, "ready").text();
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(["ok", "probe", "state", "sweep"]);
    expect(text).not.toContain(CANARY);
  });
});

describe("settlement-bootstrap · http · سرایندها و شکلِ پاسخ", () => {
  it("همیشه no-store و JSON با utf-8؛ هر سه پروب و هر وضعیت", async () => {
    const { store } = hostWith(OK_HEALTH);
    for (const s of [{}, store]) {
      for (const kind of ["live", "startup", "ready"] as const) {
        const r = probeHttpResponse(s, kind);
        expect(r.headers.get("cache-control")).toBe("no-store");
        expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
      }
    }
  });

  it("هر پاسخ سرایندِ تازه دارد (دست‌کاریِ یکی روی بعدی اثر ندارد)", () => {
    const a = probeHttpResponse({}, "live");
    a.headers.set("x-test", "1");
    expect(probeHttpResponse({}, "live").headers.get("x-test")).toBeNull();
  });
});

describe("settlement-bootstrap · http · بی‌پرتاب", () => {
  it.each(["", "LIVE", "ready ", "__proto__", undefined, null, 5, {}])("kindِ ناشناخته (%j) ⇒ ۵۰۳ با بدنهٔ ثابت", async (kind) => {
    const r = await read(probeHttpResponse({}, kind as never));
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ ok: false });
  });

  it("میزبانِ خراب (probe پرتاب می‌کند) ⇒ مثلِ نبودنِ میزبان، نه پرتاب", async () => {
    const bad = { boot() {}, shutdown() {}, status() {}, probes: { live() { throw new Error(CANARY); }, startup() { throw new Error(CANARY); }, ready() { throw new Error(CANARY); } } };
    const store = { [SETTLEMENT_HOST_STORE_KEY]: bad };
    expect((await read(probeHttpResponse(store, "live"))).status).toBe(200);
    const ready = probeHttpResponse(store, "ready");
    expect(ready.status).toBe(503);
    expect(await ready.text()).not.toContain(CANARY);
  });

  it("ظرفِ نامعتبر (null/رشته/عدد) ⇒ مثلِ نبودنِ میزبان", async () => {
    for (const s of [null, undefined, "x", 5]) expect((await read(probeHttpResponse(s, "ready"))).status).toBe(503);
  });
});
