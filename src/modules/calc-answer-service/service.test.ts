import { describe, expect, it } from "vitest";
import { CALC_TOOLS } from "@/modules/calc-tools";
import { ANSWER_MESSAGES, createCalcAnswerService, MODEL_NAME_MAX, OPTIONS_MESSAGE } from "./index";
import { baseOptions, call, makeLoop, makeService, scripted, stepErr, stepOk, stubGateway, USER } from "./test-kit";

const gw = () => stubGateway(scripted([])).gateway;
const REQUIRED = ["gateway", "loop", "model", "maxOutputTokens", "maxCards", "totalTimeoutMs", "toolTimeoutMs", "maxResultChars"] as const;

describe("createCalcAnswerService · گزینه‌ها", () => {
  it("پیکربندیِ درست ⇒ سرویسِ یخ‌زده", () => {
    const r = createCalcAnswerService(baseOptions(gw()));
    expect(r.ok).toBe(true);
    expect(r.ok && Object.isFrozen(r.value)).toBe(true);
  });

  it.each(REQUIRED)("%s الزامی و بی‌پیش‌فرض است", (key) => {
    const o: Record<string, unknown> = { ...baseOptions(gw()) };
    delete o[key];
    const r = createCalcAnswerService(o);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe("INVALID_OPTIONS");
    expect(!r.ok && r.error.message).toBe(OPTIONS_MESSAGE);
    expect(!r.ok && r.error.issues.length).toBeGreaterThan(0);
  });

  it.each([
    ["شیء نیست", null],
    ["آرایه", []],
    ["رشته", "x"],
    ["کلید ناشناخته", { ...baseOptions(gw()), apiKey: "sk-LEAK-123" }],
  ])("%s ⇒ INVALID_OPTIONS و مقدار بازتاب نمی‌شود", (_n, o) => {
    const r = createCalcAnswerService(o);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("sk-LEAK-123");
  });

  it.each([
    ["model خالی", { model: "" }],
    ["model فقط فاصله", { model: "   " }],
    ["model غیررشته", { model: 5 }],
    ["model بلند", { model: "m".repeat(MODEL_NAME_MAX + 1) }],
    ["maxOutputTokens صفر", { maxOutputTokens: 0 }],
    ["maxOutputTokens اعشاری", { maxOutputTokens: 1.5 }],
    ["maxOutputTokens رشته", { maxOutputTokens: "500" }],
    ["maxCards صفر", { maxCards: 0 }],
    ["maxCards بزرگ‌تر از سقفِ فنی", { maxCards: 51 }],
    ["totalTimeoutMs منفی", { totalTimeoutMs: -1 }],
    ["toolTimeoutMs صفر", { toolTimeoutMs: 0 }],
    ["maxResultChars صفر", { maxResultChars: 0 }],
    ["gateway ناقص", { gateway: { completeStep: () => 1 } }],
    ["loop ناقص", { loop: { start: () => 1 } }],
    ["timers ناقص", { timers: { setTimeout: () => 1 } }],
  ])("%s ⇒ رد در زمانِ ساخت (نه در نخستین پرسش)", (_n, over) => {
    const r = createCalcAnswerService({ ...baseOptions(gw()), ...over });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.issues.length).toBeGreaterThan(0);
  });

  it("خطای زیرین فقط با نامِ کلید و پیشوندِ ماژول گزارش می‌شود", () => {
    const r = createCalcAnswerService({ ...baseOptions(gw()), maxCards: 0, totalTimeoutMs: 0 });
    expect(!r.ok && r.error.issues.some((i) => i.startsWith("calc-answer-cards: maxCards"))).toBe(true);
    expect(!r.ok && r.error.issues.some((i) => i.startsWith("tool-runner: "))).toBe(true);
  });

  it("گزینهٔ بدجنس (getter پرتاب‌کننده/Proxy) ⇒ INVALID_OPTIONS بی‌پرتاب و بی‌نشتِ متنِ استثنا", () => {
    const evil = { get model(): string { throw new Error("SECRET-getter"); } };
    const r1 = createCalcAnswerService(evil);
    const r2 = createCalcAnswerService(new Proxy({}, { ownKeys: () => { throw new Error("SECRET-proxy"); } }));
    for (const r of [r1, r2]) {
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain("SECRET");
    }
  });

  it("خروجیِ خطا یخ‌زده و issues حداکثر ۱۰ است", () => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) o[`k${i}`] = 1;
    const r = createCalcAnswerService(o);
    expect(!r.ok && r.error.issues.length).toBe(10);
    expect(!r.ok && Object.isFrozen(r.error)).toBe(true);
  });
});

describe("service.answer · مسیرِ شاد", () => {
  it("فراخوانیِ ابزار ⇒ پاسخ با یک کارت، هشدارِ تأییدنشدگی و متنِ دست‌نخوردهٔ مدل", async () => {
    const { service } = makeService(scripted([stepOk({ calls: [call("c1")] }), stepOk({ text: "هزینهٔ دادرسی دقیقاً ۱ ریال است." })]));
    const r = await service.answer(USER());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = r.value.answer;
    expect(a.status).toBe("answered");
    expect(a.text).toBe("هزینهٔ دادرسی دقیقاً ۱ ریال است.");
    expect(a.cards).toHaveLength(1);
    expect(a.cards[0]).toMatchObject({ callId: "c1", tool: "court_fee", reviewPending: true });
    expect(a.reviewPending).toBe(true);
    expect(a.notices).toHaveLength(2);
    expect(r.value.steps).toBe(2);
    expect(r.value.toolCalls).toBe(1);
    expect(r.value.spend).toMatchObject({ steps: 2, complete: true });
  });

  it("بدونِ ابزار ⇒ پاسخِ بی‌کارت و بی‌هشدار", async () => {
    const { service } = makeService(scripted([stepOk({ text: "سلام" })]));
    const r = await service.answer(USER("سلام"));
    expect(r.ok && r.value.answer).toMatchObject({ status: "answered", text: "سلام", cards: [], reviewPending: false, notices: [], droppedCards: 0 });
  });

  it("خروجی ژرف‌یخ‌زده است (کارت، هزینه، پاسخ)", async () => {
    const { service } = makeService(scripted([stepOk({ calls: [call("c1")] }), stepOk({ text: "تمام" })]));
    const r = await service.answer(USER());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.isFrozen(r.value)).toBe(true);
    expect(Object.isFrozen(r.value.spend)).toBe(true);
    expect(Object.isFrozen(r.value.spend.cost)).toBe(true);
    expect(Object.isFrozen(r.value.answer)).toBe(true);
    expect(Object.isFrozen(r.value.answer.cards[0])).toBe(true);
  });

  it("درخواستِ گام: مدل، سقفِ توکن و فهرستِ مجازِ ابزار از سرویس می‌آید", async () => {
    const { service, inputs } = makeService(scripted([stepOk({ text: "x" })]), { model: "custom-model-z", maxOutputTokens: 321 });
    await service.answer({ messages: [{ role: "user", content: "سلام" }], requestId: "req-1" });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ model: "custom-model-z", maxOutputTokens: 321, requestId: "req-1" });
    expect((inputs[0]!["tools"] as { name: string }[]).map((t) => t.name)).toEqual(CALC_TOOLS.map((t) => t.name));
  });

  it("فراخوانیِ پی‌درپی با یک سرویس: شناسهٔ یکسانِ ابزار تداخل نمی‌کند (جمع‌آورندهٔ تازه برای هر اجرا)", async () => {
    const { service } = makeService((input, idx) => (idx % 2 === 0 ? stepOk({ calls: [call("call_1")] }) : stepOk({ text: `پاسخ ${String(input["model"])}` })));
    const a = await service.answer(USER());
    const b = await service.answer(USER());
    expect(a.ok && a.value.answer.cards.map((c) => c.callId)).toEqual(["call_1"]);
    expect(b.ok && b.value.answer.cards.map((c) => c.callId)).toEqual(["call_1"]);
  });

  it("اجراهای هم‌زمان با هم قاطی نمی‌شوند (کارت و هزینهٔ هر اجرا از خودش)", async () => {
    const amounts: Record<string, number> = { a: 100_000_000, b: 200_000_000, c: 150_000_000 };
    const { service } = makeService(async (input) => {
      const msgs = input["messages"] as { content: string }[];
      const who = msgs[0]!.content;
      await new Promise((r) => setTimeout(r, who === "a" ? 15 : who === "b" ? 5 : 1));
      if ((input["continuation"] as unknown[]).length === 0) return stepOk({ calls: [call(`id_${who}`, { ...GOOD_ARGS, claim: { kind: "known", amountRials: amounts[who]! } })] });
      return stepOk({ text: `پاسخِ ${who}` });
    });
    const rs = await Promise.all(["a", "b", "c"].map((w) => service.answer(USER(w))));
    rs.forEach((r, i) => {
      const who = ["a", "b", "c"][i]!;
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.answer.text).toBe(`پاسخِ ${who}`);
      expect(r.value.answer.cards.map((c) => c.callId)).toEqual([`id_${who}`]);
      expect(JSON.stringify(r.value.answer.cards[0]!.result)).toContain(String(amounts[who]));
      expect(r.value.spend.steps).toBe(2);
    });
    expect(new Set(rs.map((r) => (r.ok ? JSON.stringify(r.value.answer.cards[0]!.result) : ""))).size).toBe(3);
  });
});
const GOOD_ARGS = { date: { year: 1404, month: 6, day: 15 }, stage: "first-instance", claim: { kind: "known", amountRials: 100_000_000 } };

describe("service.answer · ورودی", () => {
  it.each([
    ["شیء نیست", "سلام"],
    ["null", null],
    ["آرایه", []],
    ["بدونِ messages", {}],
    ["messages غیرِ آرایه", { messages: "x" }],
    ["messages خالی", { messages: [] }],
    ["پیامِ غیرشیء", { messages: ["سلام"] }],
    ["نقشِ نامعتبر", { messages: [{ role: "tool", content: "x" }] }],
    ["محتوای غیررشته", { messages: [{ role: "user", content: 5 }] }],
    ["محتوای خالی", { messages: [{ role: "user", content: "" }] }],
    ["آخرین پیام user نیست", { messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }] }],
    ["کلیدِ tools (بازکردنِ فهرستِ مجاز)", { ...USER(), tools: [{ name: "evil", description: "d", parameters: { type: "object" } }] }],
    ["کلیدِ model (تغییرِ مدل)", { ...USER(), model: "expensive" }],
    ["کلیدِ maxOutputTokens", { ...USER(), maxOutputTokens: 99999 }],
    ["کلیدِ continuation", { ...USER(), continuation: [] }],
    ["requestId غیررشته", { ...USER(), requestId: 5 }],
  ])("%s ⇒ INVALID_INPUT پیش از هر تماس با دروازه", async (_n, input) => {
    const { service, inputs } = makeService(scripted([]));
    const r = await service.answer(input);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatchObject({ code: "INVALID_INPUT", message: ANSWER_MESSAGES.INVALID_INPUT, spend: null });
    expect(inputs).toHaveLength(0);
  });

  it("نامِ فیلدِ نامعتبر در issues می‌آید و محتوای پیام بازتاب نمی‌شود", async () => {
    const { service } = makeService(scripted([]));
    const r = await service.answer({ messages: [{ role: "user", content: 5 }, { role: "tool", content: "sk-LEAK-msg" }] });
    expect(!r.ok && r.error.issues).toEqual(["messages[0].content: باید رشتهٔ ناتهی باشد", "messages[1].role: باید system، user یا assistant باشد"]);
    expect(JSON.stringify(r)).not.toContain("sk-LEAK-msg");
  });

  it("پیامِ بلند و بسیار تا سقفِ دروازه قبول می‌شود (طول را دروازه می‌سنجد، نه سرویس)", async () => {
    const { service, inputs } = makeService(scripted([stepOk({ text: "ok" })]));
    const r = await service.answer({ messages: [{ role: "user", content: "الف".repeat(5000) }] });
    expect(r.ok).toBe(true);
    expect(inputs).toHaveLength(1);
  });

  it("گزینهٔ دوم نامعتبر ⇒ INVALID_INPUT", async () => {
    const { service, inputs } = makeService(scripted([]));
    for (const opt of ["x", { signal: "no" }, { extra: 1 }, null]) {
      const r = await service.answer(USER(), opt as never);
      expect(!r.ok && r.error.code).toBe("INVALID_INPUT");
    }
    expect(inputs).toHaveLength(0);
  });

  it("ورودیِ بدجنس (getter/Proxy) ⇒ INVALID_INPUT بی‌پرتاب و بی‌نشت", async () => {
    const { service } = makeService(scripted([]));
    const r1 = await service.answer({ get messages(): unknown { throw new Error("SECRET-in"); } });
    const r2 = await service.answer(new Proxy({}, { ownKeys: () => { throw new Error("SECRET-px"); } }));
    for (const r of [r1, r2]) {
      expect(!r.ok && r.error.code).toBe("INVALID_INPUT");
      expect(JSON.stringify(r)).not.toContain("SECRET");
    }
  });
});

describe("service.answer · ایست، لغو و شکست", () => {
  it("سقفِ گام ⇒ stopped با text:null، کارت‌های اجراشده و هزینه می‌مانند", async () => {
    const { service } = makeService(scripted([stepOk({ calls: [call("c1")] }), stepOk({ calls: [call("c2", { ...GOOD_ARGS, claim: { kind: "known", amountRials: 7_000_000 } })] })]), { loop: makeLoop({ maxSteps: 2 }) });
    const r = await service.answer(USER());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.answer).toMatchObject({ status: "stopped", text: null, stopReason: "MAX_STEPS", reviewPending: true });
    expect(r.value.answer.cards.length).toBeGreaterThan(0);
    expect(r.value.spend.steps).toBe(2);
  });

  it("خطای گامِ مدل ⇒ stopped/STEP_FAILED با text:null و هزینه", async () => {
    const { service } = makeService(scripted([stepErr("PROVIDER_ERROR")]));
    const r = await service.answer(USER());
    expect(r.ok && r.value.answer).toMatchObject({ status: "stopped", text: null, stopReason: "STEP_FAILED" });
  });

  it("لغوِ پیش از شروع ⇒ stopped با abortedBy=caller و بی‌تماس با دروازه", async () => {
    const { service, inputs } = makeService(scripted([stepOk({ text: "نباید بیاید" })]));
    const ac = new AbortController();
    ac.abort();
    const r = await service.answer(USER(), { signal: ac.signal });
    expect(r.ok && r.value.answer).toMatchObject({ status: "stopped", text: null, abortedBy: "caller" });
    expect(inputs).toHaveLength(0);
  });

  it("مدلِ بی‌پشتیبانیِ ابزار در زمانِ ساخت رد می‌شود؛ اگر بعداً بی‌پشتیبان شد ⇒ RUN_FAILED/MODEL_UNSUPPORTED و بی‌هزینه", async () => {
    expect(createCalcAnswerService(baseOptions(stubGateway(scripted([]), { format: null }).gateway)).ok).toBe(false);
    const { gateway, inputs, state } = stubGateway(scripted([]));
    const s = createCalcAnswerService(baseOptions(gateway));
    if (!s.ok) throw new Error("x");
    state.format = null;
    const r = await s.value.answer(USER());
    expect(!r.ok && r.error).toMatchObject({ code: "RUN_FAILED", cause: "MODEL_UNSUPPORTED", message: ANSWER_MESSAGES.RUN_FAILED, spend: null });
    expect(inputs).toHaveLength(0);
  });

  it("خطای پیکربندیِ مدل (سقفِ توکن بیش از سقفِ مدل، مدلِ ناشناخته، دروازهٔ پرتاب‌کننده) در زمانِ ساخت رد می‌شود، نه به‌نامِ ورودیِ کاربر", () => {
    const over = createCalcAnswerService(baseOptions(gw(), { maxOutputTokens: 5000 }));
    expect(!over.ok && over.error.issues).toEqual(["maxOutputTokens: از سقفِ مدل در دروازه بیشتر است"]);
    const unknown = createCalcAnswerService(baseOptions(stubGateway(scripted([]), { limits: null }).gateway));
    expect(!unknown.ok && unknown.error.issues).toEqual(["model: مدل در دروازه نیست"]);
    const boom = createCalcAnswerService(baseOptions(stubGateway(scripted([]), { throwOnLimits: true }).gateway));
    expect(!boom.ok && boom.error.issues).toEqual(["gateway: بررسیِ مدل ناموفق بود"]);
    expect(JSON.stringify(boom)).not.toContain("SECRET");
    expect(createCalcAnswerService(baseOptions(gw(), { maxOutputTokens: 2000 })).ok).toBe(true);
  });

  it("ورودی با کلیدهای ناشناختهٔ بسیار ⇒ حداکثر ۱۰ مورد در issues", async () => {
    const { service } = makeService(scripted([]));
    const extra: Record<string, number> = {};
    for (let i = 0; i < 30; i++) extra[`k${i}`] = 1;
    const r = await service.answer({ ...USER(), ...extra });
    expect(!r.ok && r.error.issues).toHaveLength(10);
    expect(!r.ok && Object.isFrozen(r.error)).toBe(true);
  });

  it("دروازهٔ پرتاب‌کننده ⇒ هرگز پرتاب/نشتِ متنِ استثنا", async () => {
    const { service } = makeService(() => { throw new Error("sk-SECRET-gw"); });
    const r = await service.answer(USER());
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("ابزارِ بیرون از فهرست اجرا نمی‌شود و کارتی نمی‌سازد", async () => {
    const { service } = makeService(scripted([stepOk({ calls: [call("c1", GOOD_ARGS, "delete_everything")] }), stepOk({ text: "تمام" })]));
    const r = await service.answer(USER());
    expect(r.ok && r.value.answer.cards).toEqual([]);
  });

  it("سقفِ کارت پر شود ⇒ فراخوانیِ بعدی TOOL_FAILED و پاسخ فقط با کارتِ درست", async () => {
    const { service } = makeService(
      scripted([stepOk({ calls: [call("c1")] }), stepOk({ calls: [call("c2", { ...GOOD_ARGS, claim: { kind: "known", amountRials: 200_000_000 } })] }), stepOk({ text: "پایان" })]),
      { maxCards: 1 },
    );
    const r = await service.answer(USER());
    expect(r.ok && r.value.answer.cards.map((c) => c.callId)).toEqual(["c1"]);
  });

  it("نتیجهٔ بزرگ‌تر از سقف ⇒ کارت نمایش داده نمی‌شود و droppedCards می‌شمارد", async () => {
    const { service } = makeService(scripted([stepOk({ calls: [call("c1")] }), stepOk({ text: "نتیجه‌ای نشد." })]), { maxResultChars: 64 });
    const r = await service.answer(USER());
    expect(r.ok && r.value.answer).toMatchObject({ cards: [], droppedCards: 1, text: "نتیجه‌ای نشد." });
  });
});
