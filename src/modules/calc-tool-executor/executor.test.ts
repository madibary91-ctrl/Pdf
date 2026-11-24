import { describe, expect, it } from "vitest";
import { CALC_TOOLS, executeCalcTool, executeCalcToolJson } from "@/modules/calc-tools";
import { judgeExecution } from "@/modules/tool-runner";
import { CALC_ABORTED_CONTENT, createCalcToolExecutor, type CalcToolObservation } from "./index";
import { COURT_ARGS, LATE_ARGS, callOf, makeExecutor, parse, runSync } from "./test-kit";

describe("calc-tool-executor: اعتبارسنجیِ گزینه‌ها (مرزِ ساخت)", () => {
  it("بدونِ گزینه یا با {} ساخته می‌شود", () => {
    expect(createCalcToolExecutor().ok).toBe(true);
    expect(createCalcToolExecutor({}).ok).toBe(true);
    expect(createCalcToolExecutor({ deps: {}, onResult: () => {} }).ok).toBe(true);
  });

  it.each([
    ["null", null, "options"],
    ["آرایه", [], "options"],
    ["رشته", "x", "options"],
    ["عدد", 5, "options"],
  ])("گزینهٔ %s ⇒ INVALID_OPTIONS بی‌پرتاب", (_n, v, key) => {
    const r = createCalcToolExecutor(v as never);
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_OPTIONS" } });
    if (!r.ok) expect(r.error.issues[0]).toContain(key);
  });

  it.each([
    ["کلیدِ ناشناخته", { timeoutMs: 5 }, "timeoutMs"],
    ["deps غیرشیء", { deps: 3 }, "deps"],
    ["deps آرایه", { deps: [] }, "deps"],
    ["کلیدِ ناشناختهٔ deps", { deps: { rates: [] } }, "deps.rates"],
    ["onResult غیرتابع", { onResult: "fn" }, "onResult"],
    ["onResult=null", { onResult: null }, "onResult"],
  ])("%s ⇒ رد", (_n, v, key) => {
    const r = createCalcToolExecutor(v as never);
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_OPTIONS" } });
    if (!r.ok) expect(r.error.issues.join("|")).toContain(key);
  });

  it("مقدارِ نامعتبر بازتاب نمی‌شود؛ نامِ کلیدِ بلند بریده و فهرست حداکثر ۱۰ مورد است", () => {
    const secret = "sk-SECRET-VALUE-123";
    const bad: Record<string, unknown> = { onResult: secret };
    for (let i = 0; i < 20; i++) bad[`k${i}${"x".repeat(80)}`] = secret;
    const r = createCalcToolExecutor(bad as never);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(r.error.issues.length).toBeLessThanOrEqual(10);
    for (const i of r.error.issues) expect(i.length).toBeLessThanOrEqual(80);
  });

  it("Proxy/getterِ بدجنس ⇒ خطای گزینه، نه پرتاب", () => {
    const evil = new Proxy({}, { ownKeys: () => { throw new Error("boom"); } });
    expect(createCalcToolExecutor(evil as never)).toMatchObject({ ok: false, error: { code: "INVALID_OPTIONS" } });
    const getter = { get onResult(): never { throw new Error("boom"); } };
    expect(createCalcToolExecutor(getter as never)).toMatchObject({ ok: false, error: { code: "INVALID_OPTIONS" } });
  });
});

describe("calc-tool-executor: نتیجهٔ موفق", () => {
  const exec = makeExecutor();

  it("court_fee: محتوا عیناً خروجیِ calc-tools است و reviewPending=true (جدول‌های پیش‌فرض تأییدنشده‌اند)", () => {
    const out = runSync(exec, callOf("court_fee", COURT_ARGS));
    const direct = executeCalcTool("court_fee", COURT_ARGS);
    expect(out.ok).toBe(true);
    if (!out.ok || !direct.ok) throw new Error("باید موفق باشد");
    expect(out.reviewPending).toBe(true);
    const c = parse(out);
    expect(Object.keys(c)).toEqual(["tool", "result", "review", "reviewPending", "notes"]);
    expect(c).toEqual(JSON.parse(JSON.stringify({ tool: "court_fee", result: direct.value.result, review: direct.value.review, reviewPending: true, notes: direct.value.notes })));
  });

  it("late_payment: دست‌حسابِ ۱٬۰۰۰٬۰۰۰ × ۱۵۰٫۵ ÷ ۱۰۰ − ۱٬۰۰۰٬۰۰۰ = ۵۰۵٬۰۰۰ و هشدارها در محتوا می‌مانند", () => {
    const out = runSync(exec, callOf("late_payment", LATE_ARGS));
    expect(out.ok).toBe(true);
    const c = parse(out);
    expect(c["result"]).toMatchObject({ damagesRials: 505_000, totalRials: 1_505_000 });
    expect((c["notes"] as string[]).length).toBeGreaterThan(0);
    expect(c["reviewPending"]).toBe(true);
    expect((c["review"] as { status: string }).status).toBe("pending-legal-review");
  });

  it("خروجیِ موفق و خطا هر دو از داوریِ شکلِ tool-runner (judgeExecution) درست می‌گذرند", () => {
    const good = runSync(exec, callOf("court_fee", COURT_ARGS));
    expect(judgeExecution(good, 20_000)).toMatchObject({ code: null, result: { reviewPending: true } });
    const bad = runSync(exec, callOf("court_fee", { ...COURT_ARGS, stage: "nope" }));
    expect(judgeExecution(bad, 20_000)).toMatchObject({ code: "TOOL_REPORTED_ERROR", result: { isError: true } });
  });

  it("قطعی و همگام است (Promise نمی‌دهد) و ورودی را دست نمی‌زند", () => {
    const call = callOf("court_fee", COURT_ARGS);
    const snapshot = JSON.stringify(call);
    const a = exec(call, { signal: new AbortController().signal, callId: "call_1" });
    const b = exec(call, { signal: new AbortController().signal, callId: "call_1" });
    expect(a instanceof Promise).toBe(false);
    expect(a).toEqual(b);
    expect(JSON.stringify(call)).toBe(snapshot);
  });
});

describe("calc-tool-executor: خطای محاسبه ⇒ نتیجهٔ خطا برای اصلاحِ مدل", () => {
  const exec = makeExecutor();
  const cases: [string, ReturnType<typeof callOf>][] = [
    ["ابزارِ ناموجود", callOf("delete_everything", {})],
    ["نامِ پروتوتایپ", callOf("__proto__", {})],
    ["JSONِ خراب", callOf("court_fee", "{not json")],
    ["آرگومانِ ناقص", callOf("court_fee", {})],
    ["نوعِ نادرست (رشته به‌جای عدد)", callOf("court_fee", { ...COURT_ARGS, claim: { kind: "known", amountRials: "صد" } })],
    ["JSONِ بیش‌ازحدِ بزرگ", callOf("late_payment", `{"a":"${"x".repeat(9000)}"}`)],
    ["tierMethodِ حدسی/کلیدِ ناشناخته", callOf("court_fee", { ...COURT_ARGS, tierMethod: "marginal" })],
  ];

  it.each(cases)("%s ⇒ ok:false با {error:{code,message}} عیناً از calc-tools و بی‌reviewPending", (_n, call) => {
    const out = runSync(exec, call);
    const direct = executeCalcToolJson(call.name, call.argumentsJson);
    expect(out.ok).toBe(false);
    expect("reviewPending" in out).toBe(false);
    if (direct.ok) throw new Error("calc-tools باید خطا بدهد");
    expect(parse(out)).toEqual({ error: { code: direct.error.code, message: direct.error.message } });
    expect(Object.keys((parse(out)["error"] as object)).sort()).toEqual(["code", "message"]);
    expect(judgeExecution(out, 20_000).code).toBe("TOOL_REPORTED_ERROR");
  });

  it("نامِ کلیدِ سمی (NUL/جانشینِ تنها) در پیامِ خطا هم محتوا را برای داوری معتبر نگه می‌دارد", () => {
    const out = runSync(exec, callOf("court_fee", `{"\\u0000\\ud800x":1}`));
    expect(out.ok).toBe(false);
    expect(judgeExecution(out, 20_000).code).toBe("TOOL_REPORTED_ERROR");
  });

  it("هر ابزارِ CALC_TOOLS واقعاً به calc-tools می‌رسد (فهرستِ توصیف و اجراکننده جدا نمی‌افتند)", () => {
    expect(CALC_TOOLS.length).toBeGreaterThan(0);
    for (const t of CALC_TOOLS) {
      const out = runSync(exec, callOf(t.name, {}));
      expect(out.ok).toBe(false);
      expect(parse(out)).toMatchObject({ error: { code: "INVALID_INPUT" } });
      expect(out.content).not.toContain("وجود ندارد");
    }
  });
});

describe("calc-tool-executor: لغو", () => {
  it("سیگنالِ از پیش لغوشده ⇒ هیچ محاسبه‌ای نمی‌شود، ناظر صدا زده نمی‌شود و شکلِ نتیجه معتبر می‌ماند", () => {
    let touched = 0;
    let observed = 0;
    const deps = { get courtFeeTariffs(): undefined { touched++; return undefined; } };
    const exec = makeExecutor({ deps, onResult: () => void observed++ });
    const ac = new AbortController();
    ac.abort();
    const out = runSync(exec, callOf("court_fee", COURT_ARGS), ac.signal);
    expect(out).toEqual({ ok: false, content: CALC_ABORTED_CONTENT });
    expect(touched).toBe(0);
    expect(observed).toBe(0);
    expect(judgeExecution(out, 20_000).code).toBe("TOOL_REPORTED_ERROR");
    // همان اجرا با سیگنالِ زنده واقعاً به جدول دست می‌زند (آزمونِ شاهد)
    runSync(exec, callOf("court_fee", COURT_ARGS));
    expect(touched).toBeGreaterThan(0);
  });
});

describe("calc-tool-executor: ناظر (onResult) — نتیجهٔ بی‌واسطهٔ legal-calc", () => {
  it("یک بار، پیش از بازگشت، با callIdِ مجری و محتوای هم‌خوان با آنچه به مدل می‌رود", () => {
    const seen: CalcToolObservation[] = [];
    const order: string[] = [];
    const exec = makeExecutor({ onResult: (o) => { order.push("observer"); seen.push(o); } });
    const out = exec(callOf("late_payment", LATE_ARGS, "call_77"), { signal: new AbortController().signal, callId: "ctx_77" }) as { ok: true; content: string };
    order.push("returned");
    expect(order).toEqual(["observer", "returned"]);
    expect(seen).toHaveLength(1);
    const o = seen[0]!;
    expect(o.callId).toBe("ctx_77");
    expect(o.tool).toBe("late_payment");
    expect(o.reviewPending).toBe(true);
    expect(o.notes.length).toBeGreaterThan(0);
    const c = JSON.parse(out.content) as Record<string, unknown>;
    expect(c["result"]).toEqual(JSON.parse(JSON.stringify(o.result)));
    expect(c["notes"]).toEqual([...o.notes]);
    expect(c["review"]).toEqual(JSON.parse(JSON.stringify(o.review)));
  });

  it("رویداد ژرف‌یخ‌زده است (ناظر نمی‌تواند هشدار/وضعیت را دست‌کاری کند)", () => {
    let o: CalcToolObservation | undefined;
    const exec = makeExecutor({ onResult: (x) => void (o = x) });
    runSync(exec, callOf("court_fee", COURT_ARGS));
    expect(o).toBeDefined();
    expect(Object.isFrozen(o)).toBe(true);
    expect(Object.isFrozen(o!.result)).toBe(true);
    expect(Object.isFrozen(o!.notes)).toBe(true);
    expect(() => { (o as { reviewPending: boolean }).reviewPending = false; }).toThrow(TypeError);
  });

  it("برای نتیجهٔ خطا ناظر صدا زده نمی‌شود (نتیجه‌ای برای نمایش نیست)", () => {
    let n = 0;
    const exec = makeExecutor({ onResult: () => void n++ });
    runSync(exec, callOf("court_fee", {}));
    runSync(exec, callOf("nope", {}));
    expect(n).toBe(0);
  });

  it("ناظرِ پرتاب‌کننده ⇒ پرتاب می‌شود (نتیجه به مدل نمی‌رسد)، بی‌بلعیدن", () => {
    const exec = makeExecutor({ onResult: () => { throw new Error("sink down"); } });
    expect(() => runSync(exec, callOf("court_fee", COURT_ARGS))).toThrow("sink down");
  });

  it("باگِ درونیِ محاسبه (getterِ جدولِ تزریقی می‌پرتابد) پنهان نمی‌شود", () => {
    const deps = { get courtFeeTariffs(): never { throw new Error("internal bug"); } };
    const exec = makeExecutor({ deps });
    expect(() => runSync(exec, callOf("court_fee", COURT_ARGS))).toThrow("internal bug");
  });
});
