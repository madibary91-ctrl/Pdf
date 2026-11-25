import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEADLINE_MESSAGES } from "./index";
import { INPUT, MAX_CALL, build, cost, deferred, flush, stepErr, stepOk } from "./test-kit";
import type { ToolStepResult } from "@/modules/ai-gateway";

const unhandled: unknown[] = [];
const onUnhandled = (e: unknown): void => void unhandled.push(e);
beforeEach(() => {
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
});
afterEach(() => void process.off("unhandledRejection", onUnhandled));

const errOf = (r: ToolStepResult) => (r.ok ? null : r.error);

describe("tool-call-deadline · مسیر در مهلت (شفاف)", () => {
  it("جوابِ درمهلت عیناً و با همان مرجع برمی‌گردد؛ تایمر پاک می‌شود و رویدادی نیست", async () => {
    const reply = stepOk(100);
    const t = build(reply);
    const r = await t.gw.completeStep(INPUT);
    expect(r).toBe(reply);
    expect(t.timers.pending()).toBe(0);
    expect(t.timers.cleared()).toBe(1);
    expect(t.events).toEqual([]);
  });

  it("خطای خودِ دروازه (با هزینهٔ معلوم) دست‌نخورده می‌ماند", async () => {
    const reply = stepErr("PROVIDER_ERROR", { cost: cost(40) });
    const t = build(reply);
    expect(await t.gw.completeStep(INPUT)).toBe(reply);
  });

  it("ورودی عیناً (همان مرجع) به دروازهٔ درونی می‌رسد؛ سیگنال همیشه داده می‌شود", async () => {
    const t = build(stepOk(1));
    await t.gw.completeStep(INPUT);
    expect(t.inner.seen[0]!.input).toBe(INPUT);
    expect(t.inner.seen[0]!.options?.signal).toBeInstanceOf(AbortSignal);
    expect(t.inner.seen[0]!.options?.signal?.aborted).toBe(false);
  });

  it("toolFormat و limits مستقیم و بی‌تایمر عبور می‌کنند", () => {
    const t = build(stepOk(1));
    expect(t.gw.toolFormat("legal")).toBe("openai-chat");
    expect(t.gw.limits("legal")).toMatchObject({ maxOutputTokens: 1000 });
    expect(t.inner.formatCalls).toEqual(["legal"]);
    expect(t.inner.limitCalls).toEqual(["legal"]);
    expect(t.timers.pending()).toBe(0);
  });

  it("دقیقاً یک میلی‌ثانیه پیش از سقف جواب بدهد ⇒ جواب می‌رسد؛ مرزِ سقف", async () => {
    const d = deferred<ToolStepResult>();
    const t = build(() => d.promise);
    const call = t.gw.completeStep(INPUT);
    await flush();
    t.timers.advance(MAX_CALL - 1);
    d.resolve(stepOk(7));
    expect((await call).ok).toBe(true);
    expect(t.events).toEqual([]);
  });
});

describe("tool-call-deadline · رسیدنِ سقف (گامِ زامبی ناممکن می‌شود)", () => {
  it("تماسِ آویزان: درست در سقف TIMEOUT برمی‌گردد (نه یک میلی‌ثانیه زودتر)، سیگنال لغو می‌شود و رویداد deadline می‌آید", async () => {
    const t = build(() => new Promise(() => undefined));
    let settled = false;
    const call = t.gw.completeStep(INPUT).then((r) => {
      settled = true;
      return r;
    });
    await flush();
    t.timers.advance(MAX_CALL - 1);
    await flush();
    expect(settled).toBe(false);
    expect(t.inner.seen[0]!.options?.signal?.aborted).toBe(false);
    t.timers.advance(1);
    const r = await call;
    expect(errOf(r)).toMatchObject({ code: "TIMEOUT", message: DEADLINE_MESSAGES.TIMEOUT, retryable: false, usage: null, cost: null, warnings: [] });
    expect(t.inner.seen[0]!.options?.signal?.aborted).toBe(true);
    expect(t.events).toEqual([{ kind: "deadline", maxCallMs: MAX_CALL }]);
    expect(t.timers.pending()).toBe(0);
  });

  it("نتیجهٔ سقف یخ‌زده است و کدش «پیش از ارائه‌دهنده» نیست (هزینهٔ نامعلوم، نه صفر)", async () => {
    const t = build(() => new Promise(() => undefined));
    const call = t.gw.completeStep(INPUT);
    await flush();
    t.timers.advance(MAX_CALL);
    const r = await call;
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(errOf(r))).toBe(true);
    expect(["INVALID_REQUEST", "UNKNOWN_MODEL", "INVALID_CONFIG"]).not.toContain(errOf(r)!.code);
  });

  it("جوابِ دیرهنگامِ موفق دورریخته می‌شود و فقط رویدادِ بی‌متنِ late-result با هزینهٔ معلوم می‌آید", async () => {
    const d = deferred<ToolStepResult>();
    const t = build(() => d.promise);
    const call = t.gw.completeStep(INPUT);
    await flush();
    t.timers.advance(MAX_CALL);
    const r = await call;
    expect(errOf(r)?.code).toBe("TIMEOUT");
    d.resolve(stepOk(100));
    await flush();
    expect(t.events).toEqual([{ kind: "deadline", maxCallMs: MAX_CALL }, { kind: "late-result", ok: true, cost: { currency: "IRR", micros: 100 } }]);
    expect(JSON.stringify(t.events)).not.toMatch(/"t"|assistantMessage|text/);
  });

  it("جوابِ دیرهنگامِ خطا و رد شدنِ دیرهنگام: بی‌rejectionِ کنترل‌نشده؛ رویداد با ok=false/null", async () => {
    const d1 = deferred<ToolStepResult>();
    const d2 = deferred<ToolStepResult>();
    const ds = [d1, d2];
    const t = build((_i, _o, n) => ds[n]!.promise);
    const c1 = t.gw.completeStep(INPUT);
    const c2 = t.gw.completeStep(INPUT);
    await flush();
    t.timers.advance(MAX_CALL);
    await Promise.all([c1, c2]);
    d1.resolve(stepErr("ABORTED", { cost: cost(5) }));
    d2.reject(new Error("LEAK-CANARY-late"));
    await flush();
    await new Promise((res) => setImmediate(res));
    expect(unhandled).toEqual([]);
    const late = t.events.filter((e) => e.kind === "late-result");
    expect(late).toEqual([{ kind: "late-result", ok: false, cost: { currency: "IRR", micros: 5 } }, { kind: "late-result", ok: null, cost: null }]);
    expect(JSON.stringify(t.events)).not.toContain("LEAK-CANARY");
  });

  it("دروازهٔ درونی که سیگنالِ لغو را رعایت می‌کند: ABORTED با هزینهٔ معلوم پس از سقف دورریخته و TIMEOUT می‌ماند", async () => {
    const t = build((_i, o) => new Promise((res) => o?.signal?.addEventListener("abort", () => res(stepErr("ABORTED", { cost: cost(9) })))));
    const call = t.gw.completeStep(INPUT);
    await flush();
    t.timers.advance(MAX_CALL);
    expect(errOf(await call)?.code).toBe("TIMEOUT");
    await flush();
    expect(t.events.at(-1)).toEqual({ kind: "late-result", ok: false, cost: { currency: "IRR", micros: 9 } });
  });

  it("گام‌های هم‌زمان: هر کدام سقفِ مستقلِ خود را دارد (آغازِ متفاوت)", async () => {
    const ds = [0, 1, 2].map(() => deferred<ToolStepResult>());
    const t = build((_i, _o, n) => ds[n]!.promise);
    const calls: Promise<ToolStepResult>[] = [];
    calls.push(t.gw.completeStep(INPUT));
    await flush();
    t.timers.advance(1000);
    calls.push(t.gw.completeStep(INPUT));
    await flush();
    t.timers.advance(1000);
    calls.push(t.gw.completeStep(INPUT));
    await flush();
    ds[1]!.resolve(stepOk(2)); // دومی در مهلت جواب می‌دهد
    expect((await calls[1]!).ok).toBe(true);
    t.timers.advance(1000); // t=3000: سقفِ اولی
    expect(errOf(await calls[0]!)?.code).toBe("TIMEOUT");
    expect(t.timers.pending()).toBe(1);
    t.timers.advance(2000); // t=5000: سقفِ سومی
    expect(errOf(await calls[2]!)?.code).toBe("TIMEOUT");
    expect(t.timers.pending()).toBe(0);
    expect(t.events.filter((e) => e.kind === "deadline")).toHaveLength(2);
  });
});

describe("tool-call-deadline · لغوِ فراخواننده، پرتاب و خرابیِ تایمر", () => {
  it("لغوِ فراخواننده به تماس می‌رسد؛ جوابِ ABORTED با هزینهٔ معلوم دست‌نخورده برمی‌گردد و شنونده برداشته می‌شود", async () => {
    const ac = new AbortController();
    const reply = stepErr("ABORTED", { cost: cost(3) });
    const t = build((_i, o) => new Promise((res) => o?.signal?.addEventListener("abort", () => res(reply))));
    const call = t.gw.completeStep(INPUT, { signal: ac.signal });
    await flush();
    ac.abort();
    expect(await call).toBe(reply);
    expect(t.timers.pending()).toBe(0);
    expect(t.events).toEqual([]);
  });

  it("فراخوانندهٔ از پیش لغوشده: تماس با سیگنالِ لغوشده شروع می‌شود", async () => {
    const ac = new AbortController();
    ac.abort();
    const t = build(stepErr("ABORTED"));
    await t.gw.completeStep(INPUT, { signal: ac.signal });
    expect(t.inner.seen[0]!.options?.signal?.aborted).toBe(true);
  });

  it("دروازه‌ای که لغو را نادیده می‌گیرد هم از سقف رد نمی‌شود (لغوِ فراخواننده سقف را برنمی‌دارد)", async () => {
    const ac = new AbortController();
    const t = build(() => new Promise(() => undefined));
    const call = t.gw.completeStep(INPUT, { signal: ac.signal });
    await flush();
    ac.abort();
    await flush();
    t.timers.advance(MAX_CALL);
    expect(errOf(await call)?.code).toBe("TIMEOUT");
  });

  it("شنوندهٔ لغوِ فراخواننده پس از پایان برداشته می‌شود (نشتِ شنونده نیست)", async () => {
    const added: string[] = [];
    const signal = { aborted: false, addEventListener: () => void added.push("add"), removeEventListener: () => void added.push("remove") } as unknown as AbortSignal;
    const t = build(stepOk(1));
    await t.gw.completeStep(INPUT, { signal });
    expect(added).toEqual(["add", "remove"]);
  });

  it("دروازهٔ درونی که می‌پرتابد (نقضِ قرارداد) ⇒ INTERNAL_ERROR با هزینهٔ نامعلوم؛ متنِ استثنا نشت نمی‌کند و تایمر پاک می‌شود", async () => {
    const t = build(() => {
      throw new Error("SECRET-KEY-123");
    });
    const r = await t.gw.completeStep(INPUT);
    expect(errOf(r)).toMatchObject({ code: "INTERNAL_ERROR", message: DEADLINE_MESSAGES.INTERNAL_ERROR, cost: null });
    expect(JSON.stringify(r)).not.toContain("SECRET-KEY-123");
    expect(t.timers.pending()).toBe(0);
  });

  it("رد شدنِ وعدهٔ دروازهٔ درونی هم همین‌طور", async () => {
    const t = build(() => Promise.reject(new Error("SECRET-KEY-123")));
    const r = await t.gw.completeStep(INPUT);
    expect(errOf(r)?.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(r)).not.toContain("SECRET-KEY-123");
    expect(unhandled).toEqual([]);
  });

  it("برپا نشدنِ تایمر ⇒ تماس اصلاً شروع نمی‌شود (تماسِ بی‌سقف بدتر از تماسِ انجام‌نشده است)", async () => {
    const t = build(stepOk(1));
    t.timers.failSet();
    const r = await t.gw.completeStep(INPUT);
    expect(errOf(r)?.code).toBe("INTERNAL_ERROR");
    expect(t.inner.seen).toHaveLength(0);
    expect(JSON.stringify(r)).not.toContain("SECRET-TIMER-CANARY");
  });

  it("خرابیِ پاک‌سازیِ تایمر نتیجهٔ گام را عوض نمی‌کند", async () => {
    const reply = stepOk(1);
    const t = build(reply);
    t.timers.failClear();
    expect(await t.gw.completeStep(INPUT)).toBe(reply);
  });

  it("ناظرِ پرتاب‌کننده نتیجه را عوض نمی‌کند و بلعیده می‌شود", async () => {
    const t = build(() => new Promise(() => undefined), { onEvent: () => { throw new Error("SECRET-OBSERVER"); } });
    const call = t.gw.completeStep(INPUT);
    await flush();
    t.timers.advance(MAX_CALL);
    const r = await call;
    expect(errOf(r)?.code).toBe("TIMEOUT");
    expect(JSON.stringify(r)).not.toContain("SECRET-OBSERVER");
    expect(unhandled).toEqual([]);
  });

  it("بدونِ ناظر هم کار می‌کند", async () => {
    const t = build(() => new Promise(() => undefined), { onEvent: undefined });
    const call = t.gw.completeStep(INPUT);
    await flush();
    t.timers.advance(MAX_CALL);
    expect(errOf(await call)?.code).toBe("TIMEOUT");
  });
});
