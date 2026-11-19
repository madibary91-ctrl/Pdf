/**
 * settlement-host · singleton روی ظرفِ تزریقی و پروبِ مسیرهای HTTP.
 */
import { describe, expect, it } from "vitest";
import { SETTLEMENT_HOST_STORE_KEY, acquireSettlementHost, createSettlementHost, getSettlementHost, probeSettlementHost } from "./index";
import type { HostResult, ProbeKind, SettlementHost } from "./index";
import { CANARY, rig } from "./test-kit";

const make = (): HostResult<SettlementHost> => createSettlementHost(rig().config);
const must = (r: { ok: boolean }): void => {
  if (!r.ok) throw new Error("انتظار موفقیت بود");
};

describe("settlement-host · singleton", () => {
  it("کلید Symbol.for ثابت است (بسته‌های جدا یک کلید را می‌بینند)", () => {
    expect(SETTLEMENT_HOST_STORE_KEY).toBe(Symbol.for("legal-platform.settlement-host"));
  });
  it("همان ظرف ⇒ همان میزبان و create فقط یک بار", () => {
    const store: Record<symbol, unknown> = {};
    let calls = 0;
    const a = acquireSettlementHost(store, () => (calls += 1, make()));
    const b = acquireSettlementHost(store, () => (calls += 1, make()));
    must(a);
    must(b);
    if (!a.ok || !b.ok) return;
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.value).toBe(a.value);
    expect(calls).toBe(1);
    expect(store[SETTLEMENT_HOST_STORE_KEY]).toBe(a.value);
    expect(getSettlementHost(store)).toBe(a.value);
  });
  it("ظرف‌های جدا ⇒ میزبان‌های جدا", () => {
    const s1: Record<symbol, unknown> = {};
    const s2: Record<symbol, unknown> = {};
    const a = acquireSettlementHost(s1, make);
    const b = acquireSettlementHost(s2, make);
    if (!a.ok || !b.ok) throw new Error("x");
    expect(a.value).not.toBe(b.value);
  });
  it("کار با globalThis-مانند: ظرفِ تابع هم پذیرفته می‌شود", () => {
    const store = (() => undefined) as unknown as Record<symbol, unknown>;
    const a = acquireSettlementHost(store, make);
    expect(a.ok).toBe(true);
  });
  it("شکستِ create ذخیره نمی‌شود و بعداً می‌شود دوباره تلاش کرد (خطای اصلی بی‌تغییر می‌رسد)", () => {
    const store: Record<symbol, unknown> = {};
    const bad = acquireSettlementHost(store, () => createSettlementHost({}));
    expect(bad).toMatchObject({ ok: false, error: { code: "INVALID_CONFIG" } });
    expect(store[SETTLEMENT_HOST_STORE_KEY]).toBeUndefined();
    expect(getSettlementHost(store)).toBeNull();
    const good = acquireSettlementHost(store, make);
    expect(good).toMatchObject({ ok: true, created: true });
  });
  it("create که بپرتابد ⇒ CREATE_FAILED بی‌نشت و ذخیره نمی‌شود", () => {
    const store: Record<symbol, unknown> = {};
    const r = acquireSettlementHost(store, () => { throw new Error(`boom ${CANARY}`); });
    expect(r).toMatchObject({ ok: false, error: { code: "CREATE_FAILED" } });
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(store[SETTLEMENT_HOST_STORE_KEY]).toBeUndefined();
  });
  it.each([undefined, null, 5, "x", {}, { ok: true }, { ok: true, value: {} }, { ok: true, value: { boot() {}, shutdown() {}, status() {} } }, { ok: true, value: { boot() {}, shutdown() {}, status() {}, probes: {} } }, { ok: true, value: { boot() {}, shutdown() {}, status() {}, probes: { live() {}, startup() {} } } }, { ok: false }, { ok: false, error: null }])("create با نتیجهٔ نامعتبر %j ⇒ CREATE_FAILED و ذخیره نمی‌شود", (value) => {
    const store: Record<symbol, unknown> = {};
    const r = acquireSettlementHost(store, () => value as never);
    expect(r).toMatchObject({ ok: false, error: { code: "CREATE_FAILED" } });
    expect(store[SETTLEMENT_HOST_STORE_KEY]).toBeUndefined();
  });
  it("create غیرتابع ⇒ CREATE_FAILED", () => {
    expect(acquireSettlementHost({}, 5 as never)).toMatchObject({ ok: false, error: { code: "CREATE_FAILED" } });
  });
  it.each([undefined, null, 1, "s", true])("ظرفِ نامعتبر %s ⇒ INVALID_STORE", (store) => {
    let called = false;
    const r = acquireSettlementHost(store, () => (called = true, make()));
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_STORE" } });
    expect(called).toBe(false);
  });
  it.each([5, "host", {}, { boot() {}, shutdown() {} }, null])("مقدارِ بیگانهٔ %j زیرِ کلید بازنویسی نمی‌شود ⇒ INVALID_STORE", (foreign) => {
    const store: Record<symbol, unknown> = { [SETTLEMENT_HOST_STORE_KEY]: foreign };
    let called = false;
    const r = acquireSettlementHost(store, () => (called = true, make()));
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_STORE" } });
    expect(called).toBe(false);
    expect(store[SETTLEMENT_HOST_STORE_KEY]).toBe(foreign);
    expect(getSettlementHost(store)).toBeNull();
  });
  it("ظرفِ قفل‌شده (frozen) ⇒ INVALID_STORE و بی‌پرتاب", () => {
    const store = Object.freeze({}) as Record<symbol, unknown>;
    const r = acquireSettlementHost(store, make);
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_STORE" } });
  });
  it("ظرفی که نوشتن را بی‌صدا نادیده می‌گیرد (setter بی‌اثر) ⇒ INVALID_STORE", () => {
    const store: Record<symbol, unknown> = {};
    Object.defineProperty(store, SETTLEMENT_HOST_STORE_KEY, { get: () => undefined, set: () => undefined, configurable: true });
    expect(acquireSettlementHost(store, make)).toMatchObject({ ok: false, error: { code: "INVALID_STORE" } });
  });
  it("Proxyِ بدجنس ⇒ بی‌پرتاب", () => {
    const evil = new Proxy({}, { get() { throw new Error(CANARY); }, set() { throw new Error(CANARY); } });
    const r = acquireSettlementHost(evil, make);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(getSettlementHost(evil)).toBeNull();
    expect(probeSettlementHost(evil, "live").httpStatus).toBe(200);
    expect(probeSettlementHost(evil, "ready").httpStatus).toBe(503);
  });
});

describe("settlement-host · probeSettlementHost", () => {
  it("بدونِ میزبان: live ۲۰۰ و startup/ready ۵۰۳ با state:absent", () => {
    const store: Record<symbol, unknown> = {};
    expect(probeSettlementHost(store, "live")).toEqual({ httpStatus: 200, body: { probe: "live", ok: true, state: "absent", sweep: null } });
    expect(probeSettlementHost(store, "startup")).toEqual({ httpStatus: 503, body: { probe: "startup", ok: false, state: "absent", sweep: null } });
    expect(probeSettlementHost(store, "ready")).toEqual({ httpStatus: 503, body: { probe: "ready", ok: false, state: "absent", sweep: null } });
  });
  it.each([undefined, null, 3, "x"])("ظرفِ نامعتبر %s هم بی‌پرتاب است", (store) => {
    expect(probeSettlementHost(store, "live").httpStatus).toBe(200);
    expect(probeSettlementHost(store, "startup").httpStatus).toBe(503);
  });
  it("با میزبانِ واقعی همان پروبِ میزبان را می‌دهد (پیش و پس از بوت)", async () => {
    const r = rig();
    const store: Record<symbol, unknown> = {};
    const a = acquireSettlementHost(store, () => createSettlementHost(r.config));
    if (!a.ok) throw new Error("x");
    expect(probeSettlementHost(store, "ready")).toMatchObject({ httpStatus: 503, body: { state: "idle" } });
    await a.value.boot();
    for (const k of ["live", "startup", "ready"] as const) expect(probeSettlementHost(store, k)).toEqual(a.value.probes[k]());
    expect(probeSettlementHost(store, "ready")).toMatchObject({ httpStatus: 200, body: { state: "running", sweep: "ok" } });
    await a.value.shutdown();
    expect(probeSettlementHost(store, "ready")).toMatchObject({ httpStatus: 503, body: { state: "stopped" } });
  });
  it("پروبِ ناشناخته بی‌پرتاب و ۵۰۳ است (حتی با میزبان)", async () => {
    const store: Record<symbol, unknown> = {};
    const a = acquireSettlementHost(store, make);
    must(a);
    expect(probeSettlementHost(store, "bogus" as ProbeKind).httpStatus).toBe(503);
    expect(probeSettlementHost({}, "bogus" as ProbeKind).httpStatus).toBe(503);
  });
  it("میزبانِ خرابِ ساختگی که پروبش می‌پرتابد مثلِ نبودنِ میزبان است", () => {
    const fake = { boot() {}, shutdown() {}, status() {}, probes: { live() { throw new Error(CANARY); }, startup() { throw new Error(CANARY); }, ready() { throw new Error(CANARY); } } };
    const store: Record<symbol, unknown> = { [SETTLEMENT_HOST_STORE_KEY]: fake };
    expect(probeSettlementHost(store, "live")).toMatchObject({ httpStatus: 200, body: { state: "absent" } });
    expect(probeSettlementHost(store, "ready")).toMatchObject({ httpStatus: 503, body: { state: "absent" } });
  });
});
