/**
 * settlement-host · پروب‌ها: جدولِ کاملِ حالت × پروب، شکستِ بسته، بدنهٔ بسته.
 */
import { describe, expect, it } from "vitest";
import { evaluateProbe } from "./index";
import type { HostState, ProbeKind } from "./index";
import { CANARY, KEYS_OF } from "./test-kit";

const STATES: HostState[] = ["idle", "booting", "running", "failed", "stopping", "stopped"];
const ok = () => ({ health: { status: "ok" }, httpStatus: 200 });
const degraded = () => ({ health: { status: "degraded" }, httpStatus: 200 });
const down = () => ({ health: { status: "down" }, httpStatus: 503 });
const call = (kind: ProbeKind, state: HostState | "absent", hasBooted: boolean, readHealth: () => unknown = ok) => evaluateProbe(kind, { state, hasBooted, readHealth });

describe("settlement-host · پروب‌ها", () => {
  it.each(STATES)("live در حالتِ %s همیشه ۲۰۰ است (به پایگاه/رفتگر وابسته نیست)", (s) => {
    for (const booted of [true, false]) {
      const r = call("live", s, booted, () => { throw new Error("نباید صدا زده شود"); });
      expect(r.httpStatus).toBe(200);
      expect(r.body).toEqual({ probe: "live", ok: true, state: s, sweep: null });
    }
  });
  it.each(STATES)("startup در حالتِ %s فقط از روی hasBooted (چسبنده) تصمیم می‌گیرد", (s) => {
    expect(call("startup", s, true).httpStatus).toBe(200);
    expect(call("startup", s, false).httpStatus).toBe(503);
    expect(call("startup", s, true, () => { throw new Error("x"); }).httpStatus).toBe(200);
  });
  it.each(STATES.filter((s) => s !== "running"))("ready در حالتِ %s همیشه ۵۰۳ است و سلامت را نمی‌خواند", (s) => {
    let reads = 0;
    const r = call("ready", s, true, () => { reads += 1; return ok(); });
    expect(r.httpStatus).toBe(503);
    expect(r.body).toEqual({ probe: "ready", ok: false, state: s, sweep: null });
    expect(reads).toBe(0);
  });
  it("ready در running: ok ⇒ ۲۰۰، degraded ⇒ ۲۰۰، down ⇒ ۵۰۳", () => {
    expect(call("ready", "running", true, ok)).toMatchObject({ httpStatus: 200, body: { ok: true, sweep: "ok" } });
    expect(call("ready", "running", true, degraded)).toMatchObject({ httpStatus: 200, body: { ok: true, sweep: "degraded" } });
    expect(call("ready", "running", true, down)).toMatchObject({ httpStatus: 503, body: { ok: false, sweep: "down" } });
  });
  it.each([
    ["ok با ۵۰۳", { health: { status: "ok" }, httpStatus: 503 }],
    ["degraded با ۵۰۳", { health: { status: "degraded" }, httpStatus: 503 }],
    ["down با ۲۰۰", { health: { status: "down" }, httpStatus: 200 }],
    ["ok بدونِ httpStatus", { health: { status: "ok" } }],
    ["httpStatus رشته", { health: { status: "ok" }, httpStatus: "200" }],
    ["httpStatus ۲۰۱", { health: { status: "ok" }, httpStatus: 201 }],
    ["وضعیتِ ناشناخته", { health: { status: "great" }, httpStatus: 200 }],
    ["وضعیتِ غیررشته", { health: { status: 1 }, httpStatus: 200 }],
    ["بدونِ health", { httpStatus: 200 }],
    ["health=null", { health: null, httpStatus: 200 }],
    ["null", null],
    ["undefined", undefined],
    ["عدد", 200],
    ["رشته", "ok"],
  ])("ناسازگار/خراب شکست‌بسته ⇒ ۵۰۳: %s", (_n, value) => {
    expect(call("ready", "running", true, () => value).httpStatus).toBe(503);
  });
  it("readHealth که بپرتابد ⇒ ۵۰۳ بی‌نشت", () => {
    const r = call("ready", "running", true, () => { throw new Error(`boom ${CANARY}`); });
    expect(r).toMatchObject({ httpStatus: 503, body: { sweep: null, ok: false } });
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });
  it("getter خصمانه روی نتیجهٔ سلامت ⇒ ۵۰۳ بی‌پرتاب", () => {
    const evil = { get health(): never { throw new Error(CANARY); }, httpStatus: 200 };
    expect(call("ready", "running", true, () => evil).httpStatus).toBe(503);
  });
  it("حالتِ absent: live ۲۰۰؛ startup و ready ۵۰۳", () => {
    expect(call("live", "absent", false).httpStatus).toBe(200);
    expect(call("startup", "absent", false)).toMatchObject({ httpStatus: 503, body: { state: "absent" } });
    expect(call("ready", "absent", false)).toMatchObject({ httpStatus: 503, body: { state: "absent" } });
  });
  it("پروبِ ناشناخته (فراخوانیِ JS بدجنس) ⇒ ۵۰۳ و بی‌پرتاب", () => {
    const r = evaluateProbe("bogus" as ProbeKind, { state: "running", hasBooted: true, readHealth: ok });
    expect(r.httpStatus).toBe(503);
  });
  it("ورودیِ ناقابل‌خواندن (getter می‌پرتابد) ⇒ بی‌پرتاب؛ live همچنان ۲۰۰ و بقیه ۵۰۳", () => {
    const evil = { get state(): never { throw new Error(CANARY); }, hasBooted: true, readHealth: ok };
    expect(evaluateProbe("live", evil as never).httpStatus).toBe(200);
    expect(evaluateProbe("startup", evil as never).httpStatus).toBe(503);
    expect(evaluateProbe("ready", evil as never).httpStatus).toBe(503);
  });
  it("بدنه بسته، منجمد و JSON‌پذیر است: فقط چهار کلید (بی‌پیام، بی‌شمارنده)", () => {
    for (const kind of ["live", "startup", "ready"] as const) {
      const r = call(kind, "running", true, () => ({ health: { status: "ok", reasons: [{ code: CANARY }], silenceMs: 5 }, httpStatus: 200 }));
      expect(KEYS_OF(r.body)).toEqual(["ok", "probe", "state", "sweep"]);
      expect(Object.isFrozen(r)).toBe(true);
      expect(Object.isFrozen(r.body)).toBe(true);
      expect(JSON.stringify(r)).not.toContain(CANARY);
      expect(JSON.parse(JSON.stringify(r))).toEqual(r);
      expect(r.httpStatus === 200 || r.httpStatus === 503).toBe(true);
      expect(r.body.ok).toBe(r.httpStatus === 200);
    }
  });
});
