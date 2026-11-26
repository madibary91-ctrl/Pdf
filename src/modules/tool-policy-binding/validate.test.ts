import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_POLICY } from "@/modules/tool-policy";
import { deriveProjection, parseSnapshot } from "./validate";
import { defaultsProjection, deepFrozen, projectionFor, snapErr, snapOk } from "./test-kit";

const clone = (p: unknown): Record<string, Record<string, unknown>> => JSON.parse(JSON.stringify(p)) as Record<string, Record<string, unknown>>;

const ZERO_OK = new Set(["truncationRetries", "perMessageOverheadTokens"]);

describe("tool-policy-binding · deriveProjection", () => {
  it("projectionِ معتبرِ پیش‌فرض و هر چهار سطح پذیرفته و عیناً برابر برمی‌گردد", () => {
    expect(deriveProjection(defaultsProjection())).toEqual(defaultsProjection());
    for (let l = 0; l < 4; l++) expect(deriveProjection(projectionFor(l))).toEqual(projectionFor(l));
  });

  it("خروجی شیءِ تازه و ژرف‌یخ‌زده است، نه شیءِ ورودی", () => {
    const input = clone(projectionFor(1));
    const out = deriveProjection(input);
    expect(out).not.toBeNull();
    expect(out).not.toBe(input);
    expect(deepFrozen(out)).toBe(true);
    input.loop!.maxSteps = 1;
    expect(out!.loop.maxSteps).toBe(projectionFor(1).loop.maxSteps);
  });

  it.each([[null], [undefined], [1], ["x"], [[]], [true]])("غیرشیء %j ⇒ null", (v) => {
    expect(deriveProjection(v)).toBeNull();
  });

  it("کلیدِ بخشِ بالا کم یا اضافه ⇒ null", () => {
    for (const s of ["loop", "service", "deadline", "durable", "gatewayModel"]) {
      const p = clone(projectionFor(0));
      delete p[s];
      expect(deriveProjection(p), `missing ${s}`).toBeNull();
    }
    expect(deriveProjection({ ...clone(projectionFor(0)), extra: {} })).toBeNull();
  });

  it("کلیدِ بخش کم، اضافه یا بخشِ غیرشیء ⇒ null (هیچ‌چیز با پیش‌فرض پر نمی‌شود)", () => {
    const p0 = clone(projectionFor(0));
    for (const [s, sec] of Object.entries(p0)) {
      for (const k of Object.keys(sec)) {
        const p = clone(p0);
        delete p[s]![k];
        expect(deriveProjection(p), `missing ${s}.${k}`).toBeNull();
      }
      for (const k of Object.keys(sec)) {
        const renamed = clone(p0); // هم‌تعداد ولی با نامِ دیگر: نباید پذیرفته شود
        renamed[s]![`${k}X`] = renamed[s]![k];
        delete renamed[s]![k];
        expect(deriveProjection(renamed), `renamed ${s}.${k}`).toBeNull();
      }
      const extra = clone(p0);
      extra[s]!.zzz = 1;
      expect(deriveProjection(extra), `extra ${s}`).toBeNull();
      expect(deriveProjection({ ...p0, [s]: null })).toBeNull();
      expect(deriveProjection({ ...p0, [s]: [] })).toBeNull();
    }
  });

  it("هر فیلدِ عددی با مقدارِ نامعتبر (رشته، NaN، ممیز، منفی، صفر، بسیار بزرگ) ⇒ null", () => {
    const p0 = clone(projectionFor(0));
    const bads: unknown[] = ["5", Number.NaN, Infinity, 1.5, -1, 0, Number.MAX_SAFE_INTEGER + 2, null, undefined, {}];
    for (const [s, sec] of Object.entries(p0)) {
      for (const [k, v] of Object.entries(sec)) {
        if (typeof v !== "number") continue;
        for (const b of bads) {
          if (b === 0 && ZERO_OK.has(k)) continue; // کفِ این دو فیلد در سیاست ۰ است
          const p = clone(p0);
          p[s]![k] = b;
          expect(deriveProjection(p), `${s}.${k}=${String(b)}`).toBeNull();
        }
      }
    }
  });

  it("onUnknownCost و نامِ مدل: فقط مقدارِ مجاز", () => {
    const p0 = clone(projectionFor(0));
    for (const v of ["FORFEIT", "", "other", 1, null]) {
      const p = clone(p0);
      p.durable!.onUnknownCost = v;
      expect(deriveProjection(p), `onUnknownCost=${String(v)}`).toBeNull();
    }
    for (const v of ["", "a b", "x".repeat(200), 5, null, "../x"]) {
      const p = clone(p0);
      p.service!.model = v;
      expect(deriveProjection(p), `model=${String(v)}`).toBeNull();
    }
    for (const v of ["forfeit", "release"]) {
      const p = clone(p0);
      p.durable!.onUnknownCost = v;
      expect(deriveProjection(p)).not.toBeNull();
    }
  });

  it("رابطه‌های پول از همان منبعِ حقیقت سنجیده می‌شوند (هر ناسازگاری ⇒ null)", () => {
    const p0 = clone(projectionFor(0));
    const mut = (f: (p: Record<string, Record<string, unknown>>) => void): unknown => {
      const p = clone(p0);
      f(p);
      return deriveProjection(p);
    };
    const maxCall = p0.deadline!.maxCallMs as number;
    const grace = p0.durable!.graceMs as number;
    expect(mut((p) => (p.gatewayModel!.timeoutMs = maxCall))).toBeNull(); // مهلتِ مدل ≥ سقفِ سخت
    expect(mut((p) => (p.gatewayModel!.timeoutMs = maxCall + 1))).toBeNull();
    expect(mut((p) => (p.service!.totalTimeoutMs = maxCall - 1))).toBeNull(); // یک گام در مهلتِ کل نمی‌گنجد
    expect(mut((p) => (p.durable!.reservationTtlMs = grace))).toBeNull(); // ttl < ۲×grace
    expect(mut((p) => (p.durable!.graceMs = 1))).toBeNull(); // زیر کفِ grace
    expect(mut((p) => (p.deadline!.maxCallMs = grace))).toBeNull(); // سقفِ تماس ≥ grace
  });

  it("getter/Proxy: هر کلید فقط یک بار خوانده می‌شود و تغییرِ پنهان اثر ندارد", () => {
    const good = clone(projectionFor(0));
    let reads = 0;
    const loop = { ...(good.loop as object) } as Record<string, unknown>;
    const sneaky = {
      ...good,
      loop: new Proxy(loop, {
        get(t, k) {
          if (k === "maxSteps") {
            reads += 1;
            return reads === 1 ? t.maxSteps : "evil";
          }
          return t[k as string];
        },
      }),
    };
    const out = deriveProjection(sneaky);
    expect(reads).toBe(1);
    expect(out).not.toBeNull();
    expect(out!.loop.maxSteps).toBe(good.loop!.maxSteps);
  });

  it("Proxy/getter پرتاب‌کننده ⇒ null و پرتاب نمی‌کند", () => {
    const boom = new Proxy({}, { ownKeys: () => { throw new Error("sk-SECRET"); } });
    expect(() => deriveProjection(boom)).not.toThrow();
    expect(deriveProjection(boom)).toBeNull();
    const g = clone(projectionFor(0));
    Object.defineProperty(g.loop, "maxSteps", { enumerable: true, get() { throw new Error("sk-SECRET"); } });
    expect(deriveProjection(g)).toBeNull();
  });

  it("سیاستِ پیش‌فرض با DEFAULT_TOOL_POLICY همخوان است (نگاشتِ معکوس هیچ کلیدی را گم نکرده)", () => {
    const d = defaultsProjection();
    expect(d.service.model).toBe(DEFAULT_TOOL_POLICY.model.name);
    expect(d.gatewayModel.timeoutMs).toBe(DEFAULT_TOOL_POLICY.model.timeoutMs);
    expect(d.deadline.maxCallMs).toBe(DEFAULT_TOOL_POLICY.timing.maxCallMs);
    expect(d.durable.perMessageOverheadTokens).toBe(DEFAULT_TOOL_POLICY.metering.perMessageOverheadTokens);
  });
});

describe("tool-policy-binding · parseSnapshot", () => {
  it("پاسخِ سالم: همهٔ فیلدها منتقل می‌شوند", () => {
    const r = parseSnapshot(snapOk(2, 2, { ageMs: 123, drift: true }));
    expect(r).toMatchObject({ ok: true, version: 2, source: "stored", drift: true, ageMs: 123 });
    if (r.ok) expect(r.projection).toEqual(projectionFor(2));
  });

  it("نسخهٔ ۰ ⇔ پیش‌فرضِ کد", () => {
    expect(parseSnapshot(snapOk(0))).toMatchObject({ ok: true, version: 0, source: "defaults" });
    expect(parseSnapshot(snapOk(0, 0, { source: "stored" }))).toEqual({ ok: false, reason: "SOURCE_INVALID" });
    expect(parseSnapshot(snapOk(3, 3, { source: "defaults" }))).toEqual({ ok: false, reason: "SOURCE_INVALID" });
  });

  it.each(["NOT_LOADED", "STALE", "CLOCK_INVALID"])("خطای منبع %s عیناً می‌ماند", (code) => {
    expect(parseSnapshot(snapErr(code))).toEqual({ ok: false, reason: code });
  });

  it.each([["OTHER"], [""], [5], [null], [undefined]])("کدِ خطای ناشناخته %j ⇒ SOURCE_INVALID", (code) => {
    expect(parseSnapshot({ ok: false, error: { code } })).toEqual({ ok: false, reason: "SOURCE_INVALID" });
  });

  it("ok غیرِ دقیقاً true/false (۱، «true»، نبودن) ⇒ SOURCE_INVALID؛ هرگز موفقیت نیست", () => {
    for (const ok of [1, "true", undefined, null, {}]) {
      const s = snapOk(1) as { value: unknown };
      expect(parseSnapshot({ ok, value: s.value })).toEqual({ ok: false, reason: "SOURCE_INVALID" });
    }
    expect(parseSnapshot({ ok: false })).toEqual({ ok: false, reason: "SOURCE_INVALID" });
  });

  it.each([[null], [undefined], [3], ["x"], [[]], [{}], [{ ok: true }], [{ ok: true, value: null }]])("غیرِ شیءِ معتبر %j ⇒ SOURCE_INVALID", (raw) => {
    expect(parseSnapshot(raw)).toEqual({ ok: false, reason: "SOURCE_INVALID" });
  });

  it("فیلدِ بدنوع: version/source/drift/ageMs", () => {
    const bad: [string, unknown][] = [
      ["version", -1], ["version", 1.5], ["version", "1"], ["version", Number.NaN], ["version", Number.MAX_SAFE_INTEGER + 2],
      ["source", "other"], ["source", null],
      ["drift", "false"], ["drift", 0], ["drift", undefined],
      ["ageMs", -1], ["ageMs", Number.NaN], ["ageMs", Infinity], ["ageMs", "5"],
    ];
    for (const [k, v] of bad) {
      expect(parseSnapshot(snapOk(2, 2, { [k]: v })), `${k}=${String(v)}`).toEqual({ ok: false, reason: "SOURCE_INVALID" });
    }
  });

  it("projectionِ نامعتبر ⇒ PROJECTION_INVALID (و ترتیبِ بررسی: ساختارِ اسنپ‌شات پیش از projection)", () => {
    expect(parseSnapshot(snapOk(2, 2, { projection: {} }))).toEqual({ ok: false, reason: "PROJECTION_INVALID" });
    expect(parseSnapshot(snapOk(2, 2, { projection: null }))).toEqual({ ok: false, reason: "PROJECTION_INVALID" });
    expect(parseSnapshot(snapOk(2, 2, { projection: null, drift: 1 }))).toEqual({ ok: false, reason: "SOURCE_INVALID" });
  });

  it("پرتابِ getter ⇒ SOURCE_INVALID و بی‌پرتاب", () => {
    const evil = { get ok(): boolean { throw new Error("sk-SECRET"); } };
    expect(() => parseSnapshot(evil)).not.toThrow();
    expect(parseSnapshot(evil)).toEqual({ ok: false, reason: "SOURCE_INVALID" });
  });

  it("ورودیِ منبع هرگز تغییر نمی‌کند", () => {
    const s = snapOk(2) as { value: { projection: unknown } };
    const before = JSON.stringify(s);
    parseSnapshot(s);
    expect(JSON.stringify(s)).toBe(before);
  });
});
