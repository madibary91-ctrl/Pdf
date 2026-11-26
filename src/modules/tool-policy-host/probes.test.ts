/**
 * tool-policy-host · پروب‌ها: جدولِ کاملِ حالت × پروب، آمادگیِ سخت‌گیرانه (شکستِ بسته)، بدنهٔ بسته.
 */
import { describe, expect, it } from "vitest";
import { evaluateProbe } from "./index";
import type { HostState, NotReadyReason, ProbeKind } from "./index";
import { NOT_READY_REASONS, readReadiness } from "./probes";
import { CANARY, KEYS_OF } from "./test-kit";

const STATES: HostState[] = ["idle", "booting", "running", "failed", "stopping", "stopped"];
const ready = (): unknown => ({ state: "RUNNING", ready: true, reason: null, source: null, refresher: null });
const notReady = (reason: unknown) => (): unknown => ({ state: "RUNNING", ready: false, reason, source: null, refresher: null });
const call = (kind: ProbeKind, state: HostState | "absent", hasBeenReady: boolean, readHealth: () => unknown = ready) => evaluateProbe(kind, { state, hasBeenReady, readHealth });
const boom = (): never => {
  throw new Error(`boom ${CANARY}`);
};

describe("tool-policy-host · پروب‌ها", () => {
  it.each(STATES)("live در حالتِ %s همیشه ۲۰۰ است و سلامت را نمی‌خواند", (s) => {
    for (const seen of [true, false]) {
      const r = call("live", s, seen, boom);
      expect(r.httpStatus).toBe(200);
      expect(r.body).toEqual({ probe: "live", ok: true, state: s, reason: null });
    }
  });
  it.each(STATES)("startup در حالتِ %s فقط از روی hasBeenReady (چسبنده) تصمیم می‌گیرد و سلامت را نمی‌خواند", (s) => {
    expect(call("startup", s, true, boom).httpStatus).toBe(200);
    expect(call("startup", s, false, ready).httpStatus).toBe(503);
    expect(call("startup", s, false, ready).body).toEqual({ probe: "startup", ok: false, state: s, reason: null });
  });
  it.each(STATES.filter((s) => s !== "running"))("ready در حالتِ %s همیشه ۵۰۳ است و سلامت را نمی‌خواند", (s) => {
    let reads = 0;
    const r = call("ready", s, true, () => (reads += 1, ready()));
    expect(r.httpStatus).toBe(503);
    expect(r.body).toEqual({ probe: "ready", ok: false, state: s, reason: null });
    expect(reads).toBe(0);
  });
  it("ready در running با سلامتِ سازگار ⇒ ۲۰۰ و reason=null (حتی اگر hasBeenReady هنوز false باشد)", () => {
    expect(call("ready", "running", false, ready)).toEqual({ httpStatus: 200, body: { probe: "ready", ok: true, state: "running", reason: null } });
  });
  it.each(NOT_READY_REASONS)("ready در running با ready=false و دلیلِ %s ⇒ ۵۰۳ با همان دلیل", (reason) => {
    expect(call("ready", "running", true, notReady(reason))).toEqual({ httpStatus: 503, body: { probe: "ready", ok: false, state: "running", reason } });
  });
  it("مجموعهٔ دلایل عیناً همان هشت کدِ ریشه است", () => {
    expect([...NOT_READY_REASONS].sort()).toEqual(["CLOCK_INVALID", "HEALTH_UNAVAILABLE", "NOT_LOADED", "NOT_STARTED", "REFRESHER_HALTED", "STALE", "STARTING", "STOPPING"]);
  });
  it.each<[string, unknown]>([
    ["ready=true با reason غیرتهی", { state: "RUNNING", ready: true, reason: "STALE" }],
    ["ready=true با reason تعریف‌نشده", { state: "RUNNING", ready: true }],
    ["ready=true با state غیر RUNNING", { state: "STARTING", ready: true, reason: null }],
    ["ready=true بدونِ state", { ready: true, reason: null }],
    ["ready رشتهٔ true", { state: "RUNNING", ready: "true", reason: null }],
    ["ready=1", { state: "RUNNING", ready: 1, reason: null }],
    ["ready تعریف‌نشده", { state: "RUNNING", reason: null }],
    ["ready رشتهٔ false با دلیلِ معتبر", { state: "RUNNING", ready: "false", reason: "STALE" }],
    ["ready=0 با دلیلِ معتبر", { state: "RUNNING", ready: 0, reason: "STALE" }],
    ["ready=false با دلیلِ ناشناخته", { state: "RUNNING", ready: false, reason: "FINE" }],
    ["ready=false با reason=null", { state: "RUNNING", ready: false, reason: null }],
    ["ready=false با دلیلِ غیررشته", { state: "RUNNING", ready: false, reason: 7 }],
    ["null", null],
    ["رشته", "ready"],
    ["عدد", 1],
    ["آرایه", [true]],
  ])("آمادگیِ ناسازگار/بدشکل (%s) ⇒ ۵۰۳ با HEALTH_UNAVAILABLE", (_label, h) => {
    expect(call("ready", "running", true, () => h)).toEqual({ httpStatus: 503, body: { probe: "ready", ok: false, state: "running", reason: "HEALTH_UNAVAILABLE" } });
    expect(readReadiness(() => h)).toEqual({ ready: false, reason: "HEALTH_UNAVAILABLE" });
  });
  it("خوانندهٔ سلامتِ پرتابگر و getterِ بدجنس ⇒ ۵۰۳ بی‌نشت", () => {
    for (const read of [boom, () => ({ get ready(): boolean { return boom(); } }), () => ({ ready: false, get reason(): string { return boom(); } })]) {
      const r = call("ready", "running", true, read);
      expect(r).toEqual({ httpStatus: 503, body: { probe: "ready", ok: false, state: "running", reason: "HEALTH_UNAVAILABLE" } });
      expect(JSON.stringify(r)).not.toContain(CANARY);
    }
  });
  it("دلیلِ بدجنسِ آزاد (حاوی CANARY) هرگز بیرون نمی‌رود", () => {
    const r = call("ready", "running", true, notReady(`STALE ${CANARY}`));
    expect(r.body.reason).toBe("HEALTH_UNAVAILABLE");
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });
  it("بدنه بسته است: همیشه همین چهار کلید و شیء قفل‌شده", () => {
    for (const kind of ["live", "startup", "ready"] as const) {
      for (const s of [...STATES, "absent" as const]) {
        const r = call(kind, s, true, () => ({ state: "RUNNING", ready: true, reason: null, secret: CANARY, source: { version: 9 } }));
        expect(KEYS_OF(r.body)).toEqual(["ok", "probe", "reason", "state"]);
        expect(KEYS_OF(r)).toEqual(["body", "httpStatus"]);
        expect(Object.isFrozen(r) && Object.isFrozen(r.body)).toBe(true);
        expect(JSON.stringify(r)).not.toContain(CANARY);
        expect(r.httpStatus === 200).toBe(r.body.ok);
      }
    }
  });
  it("ok ⇒ reason=null؛ reason غیرتهی ⇒ ok=false (ناوردا)", () => {
    for (const reason of NOT_READY_REASONS as readonly NotReadyReason[]) {
      const r = call("ready", "running", true, notReady(reason));
      expect(r.body.ok).toBe(false);
    }
    expect(call("ready", "running", true, ready).body.reason).toBeNull();
  });
  it("kind ناشناخته ⇒ ۵۰۳ و بی‌پرتاب", () => {
    const r = evaluateProbe("bogus" as ProbeKind, { state: "running", hasBeenReady: true, readHealth: ready });
    expect(r.httpStatus).toBe(503);
  });
  it("ورودیِ خراب (state getter پرتابگر) بی‌پرتاب است: live ۲۰۰ و بقیه ۵۰۳ با absent", () => {
    const evil = { get state(): never { return boom(); }, hasBeenReady: true, readHealth: ready } as never;
    expect(evaluateProbe("live", evil)).toMatchObject({ httpStatus: 200, body: { state: "absent" } });
    expect(evaluateProbe("startup", evil)).toMatchObject({ httpStatus: 503, body: { state: "absent" } });
    expect(evaluateProbe("ready", evil)).toMatchObject({ httpStatus: 503, body: { state: "absent" } });
  });
});
