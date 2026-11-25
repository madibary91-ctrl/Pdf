import { describe, expect, it } from "vitest";
import { CALL_DEADLINE_LIMITS, createDeadlineToolGateway } from "./index";
import { MAX_CALL, fakeTimers, stepOk, stub } from "./test-kit";

const good = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ gateway: stub(stepOk(1)).gateway, maxCallMs: MAX_CALL, timers: fakeTimers(), ...over });
const issuesOf = (r: ReturnType<typeof createDeadlineToolGateway>): readonly string[] => (r.ok ? [] : r.error.issues);

describe("tool-call-deadline · پیکربندی", () => {
  it("پیکربندیِ درست ⇒ دروازهٔ یخ‌زده با همان سه تابعِ ToolGateway", () => {
    const r = createDeadlineToolGateway(good());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.isFrozen(r.value)).toBe(true);
    expect(Object.keys(r.value).sort()).toEqual(["completeStep", "limits", "toolFormat"]);
  });

  it("maxCallMs الزامی و بی‌پیش‌فرض است", () => {
    const { maxCallMs: _m, ...rest } = good();
    void _m;
    const r = createDeadlineToolGateway(rest);
    expect(r.ok).toBe(false);
    expect(issuesOf(r).join(" ")).toContain("maxCallMs");
  });

  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, CALL_DEADLINE_LIMITS.maxMs + 1, "100", null, {}])("maxCallMs=%s رد می‌شود", (bad) => {
    const r = createDeadlineToolGateway(good({ maxCallMs: bad }));
    expect(r.ok).toBe(false);
    expect(issuesOf(r)).toEqual([`maxCallMs باید عدد صحیح ${CALL_DEADLINE_LIMITS.minMs} تا ${CALL_DEADLINE_LIMITS.maxMs} باشد.`]);
  });

  it("مرزهای مجازِ maxCallMs پذیرفته می‌شوند", () => {
    expect(createDeadlineToolGateway(good({ maxCallMs: CALL_DEADLINE_LIMITS.minMs })).ok).toBe(true);
    expect(createDeadlineToolGateway(good({ maxCallMs: CALL_DEADLINE_LIMITS.maxMs })).ok).toBe(true);
  });

  it.each([undefined, null, {}, { completeStep: () => 1 }, { completeStep: 1, toolFormat: () => 1, limits: () => 1 }, "gw"])("gateway=%j رد می‌شود", (bad) => {
    const r = createDeadlineToolGateway(good({ gateway: bad }));
    expect(r.ok).toBe(false);
    expect(issuesOf(r)).toContain("gateway باید completeStep، toolFormat و limits داشته باشد.");
  });

  it("کلیدِ ناشناخته رد می‌شود (غلطِ املایی مثل maxCallMS بی‌صدا نادیده گرفته نمی‌شود)", () => {
    const r = createDeadlineToolGateway(good({ maxCallMS: 5 }));
    expect(r.ok).toBe(false);
    expect(issuesOf(r).join(" ")).toContain("کلید ناشناخته");
  });

  it("timers و onEvent نامعتبر رد می‌شوند؛ timers نبودن ⇒ پیش‌فرضِ سیستم", () => {
    expect(issuesOf(createDeadlineToolGateway(good({ timers: { setTimeout: () => 1 } })))).toContain("timers باید setTimeout و clearTimeout داشته باشد.");
    expect(issuesOf(createDeadlineToolGateway(good({ onEvent: 5 })))).toContain("onEvent باید تابع باشد.");
    const { timers: _t, ...rest } = good();
    void _t;
    expect(createDeadlineToolGateway(rest).ok).toBe(true);
  });

  it("همهٔ خطاها یک‌جا گزارش می‌شوند", () => {
    const r = createDeadlineToolGateway({ gateway: 1, maxCallMs: 0, timers: 3, onEvent: 4, extra: 1 });
    expect(issuesOf(r)).toHaveLength(5);
  });

  it("غیرشیء ⇒ INVALID_CONFIG", () => {
    for (const v of [null, undefined, 3, "x", [], () => 1]) {
      const r = createDeadlineToolGateway(v);
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.error.code).toBe("INVALID_CONFIG");
    }
  });

  it("getterِ پرتاب‌کننده/Proxy ⇒ INVALID_CONFIG؛ متنِ استثنا نشت نمی‌کند", () => {
    const trap = { ...good() };
    Object.defineProperty(trap, "maxCallMs", { enumerable: true, get: () => { throw new Error("SECRET-KEY-123"); } });
    const proxy = new Proxy({}, { ownKeys: () => { throw new Error("SECRET-KEY-123"); } });
    for (const v of [trap, proxy]) {
      const r = createDeadlineToolGateway(v);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain("SECRET-KEY-123");
    }
  });

  it("خطا یخ‌زده است و مقدارِ پیکربندی در issues نمی‌آید", () => {
    const r = createDeadlineToolGateway(good({ maxCallMs: "sk-LIVE-SECRET-999" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.isFrozen(r.error)).toBe(true);
    expect(Object.isFrozen(r.error.issues)).toBe(true);
    expect(JSON.stringify(r)).not.toContain("sk-LIVE-SECRET-999");
  });

  it("خواندنِ یک‌بارهٔ هر کلید: getterِ دوپهلو نمی‌تواند بین سنجش و ساخت مقدار را عوض کند", () => {
    const cfg = { ...good() };
    let reads = 0;
    Object.defineProperty(cfg, "maxCallMs", { enumerable: true, get: () => (++reads === 1 ? MAX_CALL : 99_999_999) });
    expect(createDeadlineToolGateway(cfg).ok).toBe(true);
    expect(reads).toBe(1);
  });

  it("دروازهٔ درونی پس از ساخت جایگزین‌شدنی نیست (توابع یک‌بار گرفته می‌شوند)", async () => {
    const s = stub(stepOk(5));
    const gw = { ...s.gateway };
    const r = createDeadlineToolGateway(good({ gateway: gw }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    (gw as { completeStep: unknown }).completeStep = () => Promise.resolve("evil");
    const out = await r.value.completeStep({ a: 1 });
    expect(out.ok).toBe(true);
    expect(s.seen).toHaveLength(1);
  });
});
