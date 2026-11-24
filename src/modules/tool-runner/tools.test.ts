import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { FAILURE_CONTENT } from "./errors";
import { judgeExecution, runToolCalls, type ToolRunContext } from "./tools";
import { call, fakeTimers, tick } from "./test-kit";
import type { ToolExecutor, ToolRunRecord } from "./types";

describe("judgeExecution", () => {
  it("موفق با reviewPending صریح (هر دو مقدار)", () => {
    expect(judgeExecution({ ok: true, content: "x", reviewPending: true }, 100)).toEqual({ result: { content: "x", reviewPending: true }, code: null });
    expect(judgeExecution({ ok: true, content: "x", reviewPending: false }, 100)).toEqual({ result: { content: "x", reviewPending: false }, code: null });
  });

  it("نتیجهٔ موفق بی‌reviewPending یا با reviewPending غیربولی «تأییدشده» حساب نمی‌شود، رد می‌شود", () => {
    for (const bad of [{ ok: true, content: "x" }, { ok: true, content: "x", reviewPending: "no" }, { ok: true, content: "x", reviewPending: undefined }, { ok: true, content: "x", reviewPending: 0 }]) {
      expect(judgeExecution(bad, 100)).toEqual({ result: { content: FAILURE_CONTENT.TOOL_RESULT_INVALID, isError: true }, code: "TOOL_RESULT_INVALID" });
    }
  });

  it("خطای گزارش‌شدهٔ ابزار: متن عبور می‌کند، isError، بی‌reviewPending", () => {
    expect(judgeExecution({ ok: false, content: '{"error":"BAD_ARGS"}' }, 100)).toEqual({ result: { content: '{"error":"BAD_ARGS"}', isError: true }, code: "TOOL_REPORTED_ERROR" });
  });

  it("ok:false با reviewPending ⇒ نامعتبر (کلیدِ اضافه)", () => {
    expect(judgeExecution({ ok: false, content: "x", reviewPending: true }, 100).code).toBe("TOOL_RESULT_INVALID");
  });

  it.each([null, undefined, 5, "x", [], [{ ok: true }], () => 1])("غیرشیء (%s) ⇒ نامعتبر", (v) => {
    expect(judgeExecution(v, 100).code).toBe("TOOL_RESULT_INVALID");
  });

  it.each([
    ["ok غیربولی", { ok: 1, content: "x", reviewPending: false }],
    ["content غیررشته", { ok: true, content: 5, reviewPending: false }],
    ["content تهی", { ok: true, content: "", reviewPending: false }],
    ["NUL", { ok: true, content: "a\u0000b", reviewPending: false }],
    ["جفت‌جانشینِ تنها (بالا)", { ok: true, content: "a\uD800b", reviewPending: false }],
    ["جفت‌جانشینِ تنها (پایین)", { ok: true, content: "a\uDC00b", reviewPending: false }],
    ["کلیدِ ناشناخته", { ok: true, content: "x", reviewPending: false, extra: 1 }],
  ])("%s ⇒ TOOL_RESULT_INVALID", (_n, v) => {
    expect(judgeExecution(v, 100).code).toBe("TOOL_RESULT_INVALID");
  });

  it("جفت‌جانشینِ سالم (ایموجی) و فارسی مجازند", () => {
    expect(judgeExecution({ ok: true, content: "هزینه 😀", reviewPending: false }, 100).code).toBeNull();
  });

  it("سقف: برابر مجاز، یک نویسه بیش ⇒ TOOL_RESULT_TOO_LARGE (حتی برای ok:false)", () => {
    expect(judgeExecution({ ok: true, content: "x".repeat(100), reviewPending: false }, 100).code).toBeNull();
    expect(judgeExecution({ ok: true, content: "x".repeat(101), reviewPending: true }, 100)).toEqual({ result: { content: FAILURE_CONTENT.TOOL_RESULT_TOO_LARGE, isError: true }, code: "TOOL_RESULT_TOO_LARGE" });
    expect(judgeExecution({ ok: false, content: "x".repeat(101) }, 100).code).toBe("TOOL_RESULT_TOO_LARGE");
  });

  it("Proxy/getterِ خصمانه پرتاب نمی‌کند", () => {
    const hostile = new Proxy({}, { ownKeys() { throw new Error("S"); } });
    expect(judgeExecution(hostile, 100).code).toBe("TOOL_RESULT_INVALID");
  });

  it("متنِ ثابتِ خطا همه JSON معتبرند و دقیقاً همین‌اند (قراردادِ رفتاریِ مدل)", () => {
    for (const v of Object.values(FAILURE_CONTENT)) expect(() => JSON.parse(v)).not.toThrow();
    expect(FAILURE_CONTENT).toEqual({
      UNKNOWN_TOOL: '{"error":"UNKNOWN_TOOL"}',
      TOOL_TIMEOUT: '{"error":"TOOL_TIMEOUT"}',
      TOOL_FAILED: '{"error":"TOOL_FAILED"}',
      TOOL_RESULT_INVALID: '{"error":"TOOL_RESULT_INVALID"}',
      TOOL_RESULT_TOO_LARGE: '{"error":"TOOL_RESULT_TOO_LARGE"}',
    });
  });
});

const ctx = (over: Partial<ToolRunContext> = {}): ToolRunContext & { ac: AbortController; f: ReturnType<typeof fakeTimers> } => {
  const ac = new AbortController();
  const f = fakeTimers();
  return { allowed: new Set(["court_fee"]), executeTool: () => ({ ok: true, content: "r", reviewPending: false }), toolTimeoutMs: 100, maxResultChars: 100, timers: f.timers, signal: ac.signal, ...over, ac, f };
};

describe("runToolCalls", () => {
  it("signalِ از پیش لغوشده: هیچ ابزاری شروع نمی‌شود و رکوردی (حتی TOOL_ABORTED) ثبت نمی‌شود", async () => {
    const c = ctx();
    c.ac.abort();
    let hit = 0;
    const records: ToolRunRecord[] = [];
    expect(await runToolCalls([call("a")], { ...c, executeTool: () => (hit++, { ok: true, content: "r", reviewPending: false }) }, records)).toEqual({ kind: "aborted" });
    expect(hit).toBe(0);
    expect(records).toEqual([]);
  });

  it("پس از هر مسیر (موفق، خطا، مهلت، لغو) شنوندهٔ signalِ کل برداشته می‌شود", async () => {
    for (const exec of [(() => ({ ok: true, content: "r", reviewPending: false })) as ToolExecutor, (() => { throw new Error("x"); }) as ToolExecutor]) {
      const c = ctx({ executeTool: exec });
      await runToolCalls([call("a"), call("b")], c, []);
      expect(getEventListeners(c.ac.signal, "abort")).toHaveLength(0);
    }
    const c = ctx({ executeTool: () => new Promise(() => {}) });
    const p = runToolCalls([call("a")], c, []);
    await tick();
    c.f.fire(100);
    await p;
    expect(getEventListeners(c.ac.signal, "abort")).toHaveLength(0);
  });

  it("ترتیبی: هر فراخوانی پس از تمامِ قبلی شروع می‌شود و ترتیبِ مدل حفظ می‌شود", async () => {
    let running = 0;
    let maxRunning = 0;
    const order: string[] = [];
    const exec: ToolExecutor = async (c) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await tick(3);
      order.push(c.id);
      running--;
      return { ok: true, content: c.id, reviewPending: false };
    };
    const records: ToolRunRecord[] = [];
    const r = await runToolCalls([call("a"), call("b"), call("c")], ctx({ executeTool: exec }), records);
    expect(maxRunning).toBe(1);
    expect(order).toEqual(["a", "b", "c"]);
    expect(r).toMatchObject({ kind: "done" });
    expect(records.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });

  it("ابزارِ بیرون از فهرست: پورت صدا زده نمی‌شود", async () => {
    let hit = 0;
    const records: ToolRunRecord[] = [];
    const r = await runToolCalls([call("a", {}, "rm_rf"), call("b", {}, "COURT_FEE"), call("c", {}, "court_fee ")], ctx({ executeTool: () => (hit++, { ok: true, content: "r", reviewPending: false }) }), records);
    expect(hit).toBe(0);
    expect(r.kind === "done" && r.results.every((x) => x.isError === true && x.content === FAILURE_CONTENT.UNKNOWN_TOOL)).toBe(true);
    expect(records.every((x) => x.code === "UNKNOWN_TOOL" && x.status === "error")).toBe(true);
  });

  it("پرتابِ ابزار: متنِ ثابت، پیامِ استثنا هیچ‌جا نیست", async () => {
    const records: ToolRunRecord[] = [];
    const r = await runToolCalls([call("a")], ctx({ executeTool: () => { throw new Error("پروندهٔ علی ۱۲۳"); } }), records);
    expect(JSON.stringify([r, records])).not.toContain("علی");
    expect(records[0]).toMatchObject({ code: "TOOL_FAILED", status: "error", reviewPending: false });
  });

  it("پورتِ ناهمگام که رد می‌شود هم همین‌طور", async () => {
    const records: ToolRunRecord[] = [];
    await runToolCalls([call("a")], ctx({ executeTool: () => Promise.reject(new Error("S")) }), records);
    expect(records[0]!.code).toBe("TOOL_FAILED");
  });

  it("مهلتِ ابزار: خطای TOOL_TIMEOUT و signalِ ابزار لغو می‌شود؛ بعدی‌ها ادامه می‌یابند", async () => {
    const c = ctx();
    const signals: AbortSignal[] = [];
    const exec: ToolExecutor = (cl, x) => {
      signals.push(x.signal);
      return cl.id === "a" ? new Promise(() => {}) : { ok: true, content: "ok", reviewPending: true };
    };
    const records: ToolRunRecord[] = [];
    const p = runToolCalls([call("a"), call("b")], { ...c, executeTool: exec }, records);
    await tick();
    expect(c.f.fire(100)).toBe(1);
    const r = await p;
    expect(signals[0]!.aborted).toBe(true);
    expect(records.map((x) => x.code)).toEqual(["TOOL_TIMEOUT", null]);
    expect(r.kind === "done" && r.results[1]).toEqual({ id: "b", content: "ok", reviewPending: true });
    expect(c.f.pending()).toBe(0);
  });

  it("لغوِ کل حین اجرا: aborted؛ ابزارِ شروع‌شده در ممیزی می‌ماند (TOOL_ABORTED)؛ signalِ ابزار لغو؛ شنونده‌ها برداشته", async () => {
    const c = ctx();
    let sig: AbortSignal | undefined;
    const records: ToolRunRecord[] = [];
    const p = runToolCalls([call("a"), call("b")], { ...c, executeTool: (_c, x) => ((sig = x.signal), new Promise(() => {})) }, records);
    await tick();
    c.ac.abort();
    expect(await p).toEqual({ kind: "aborted" });
    expect(sig!.aborted).toBe(true);
    expect(records).toEqual([{ id: "a", name: "court_fee", status: "error", code: "TOOL_ABORTED", reviewPending: false }]);
    expect(c.f.pending()).toBe(0);
  });

  it("لغو میانِ دو فراخوانی: دومی هرگز اجرا نمی‌شود، رکوردِ اولی (لغوشده حین اجرا) می‌ماند", async () => {
    const c = ctx();
    const ran: string[] = [];
    const records: ToolRunRecord[] = [];
    const exec: ToolExecutor = (cl) => {
      ran.push(cl.id);
      c.ac.abort();
      return { ok: true, content: "r", reviewPending: false };
    };
    const r = await runToolCalls([call("a"), call("b")], { ...c, executeTool: exec }, records);
    expect(r).toEqual({ kind: "aborted" });
    expect(ran).toEqual(["a"]);
    expect(records.map((x) => [x.id, x.code])).toEqual([["a", "TOOL_ABORTED"]]);
  });

  it("reviewPending در رکورد: فقط برای موفقِ تأییدنشده", async () => {
    const records: ToolRunRecord[] = [];
    const seq = [{ ok: true, content: "x", reviewPending: true }, { ok: true, content: "x", reviewPending: false }, { ok: false, content: "x" }];
    let i = 0;
    await runToolCalls([call("a"), call("b"), call("c")], ctx({ executeTool: () => seq[i++] as never }), records);
    expect(records.map((r) => r.reviewPending)).toEqual([true, false, false]);
  });

  it("رکورد آرگومان و نتیجه ندارد (حریمِ دادهٔ پرونده)", async () => {
    const records: ToolRunRecord[] = [];
    await runToolCalls([call("a", { secret: "راز" })], ctx({ executeTool: () => ({ ok: true, content: "نتیجهٔ محرمانه", reviewPending: false }) }), records);
    expect(Object.keys(records[0]!).sort()).toEqual(["code", "id", "name", "reviewPending", "status"]);
    expect(JSON.stringify(records)).not.toMatch(/راز|محرمانه/);
  });
});
