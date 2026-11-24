import { describe, expect, it } from "vitest";
import { COMPOSE_MESSAGES, NOTICES, REVIEW_PENDING_LABEL } from "./index";
import { VERIFIED_REVIEW, collector, obs, outcomeOf, reportOf, runOf } from "./test-kit";

describe("compose · مسیرِ شاد", () => {
  it("answered با یک کارتِ تأییدنشده: متنِ مدل دست‌نخورده، کارت از ناظر، دو اعلانِ ثابت به ترتیب", () => {
    const c = collector();
    c.observe(obs());
    const r = c.compose(reportOf());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ status: "answered", text: "متنِ مدل", stopReason: null, abortedBy: null, reviewPending: true, droppedCards: 0 });
    expect(r.value.cards.map((x) => x.callId)).toEqual(["call_1"]);
    expect(r.value.notices).toEqual([NOTICES.reviewPending, NOTICES.cardPrecedence]);
    expect(Object.isFrozen(r.value)).toBe(true);
    expect(Object.isFrozen(r.value.cards)).toBe(true);
    expect(Object.isFrozen(r.value.notices)).toBe(true);
  });

  it("همه‌چیز تأییدشده ⇒ فقط اعلانِ اولویتِ کارت و reviewPending=false", () => {
    const c = collector();
    c.observe(obs({ review: VERIFIED_REVIEW, reviewPending: false }));
    const r = c.compose(reportOf({ outcome: outcomeOf("answered", false), toolRuns: [runOf("call_1", "court_fee", "ok", false)] }));
    expect(r.ok && r.value.reviewPending).toBe(false);
    expect(r.ok && r.value.notices).toEqual([NOTICES.cardPrecedence]);
  });

  it("بی‌ابزار: بی‌کارت و بی‌اعلان؛ متن دست‌نخورده", () => {
    const r = collector().compose(reportOf({ outcome: outcomeOf("answered", false), toolRuns: [] }));
    expect(r.ok && r.value).toMatchObject({ cards: [], notices: [], reviewPending: false, text: "متنِ مدل" });
  });

  it("کارت‌ها به ترتیبِ اجرا (نه ترتیبِ دیده‌شدن)", () => {
    const c = collector();
    c.observe(obs({ callId: "b", tool: "late_payment" }));
    c.observe(obs({ callId: "a" }));
    const r = c.compose(reportOf({ toolRuns: [runOf("a", "court_fee", "ok", true), runOf("b", "late_payment", "ok", true)] }));
    expect(r.ok && r.value.cards.map((x) => x.callId)).toEqual(["a", "b"]);
  });

  it("stopped: متن null، علت و abortedBy حفظ؛ کارت‌های اجراشده می‌مانند با اعلانِ تأییدنشدگی ولی بی‌اولویتِ-متن", () => {
    const c = collector();
    c.observe(obs());
    const r = c.compose(reportOf({ outcome: outcomeOf("stopped", true), abortedBy: "deadline" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ status: "stopped", text: null, stopReason: "MAX_STEPS", abortedBy: "deadline", reviewPending: true });
    expect(r.value.cards).toHaveLength(1);
    expect(r.value.notices).toEqual([NOTICES.reviewPending]);
  });
});

describe("compose · شکست‌بستگی", () => {
  it("اجرای موفقِ بی‌کارت ⇒ CARD_MISSING با شناسه؛ متنِ مدل در خطا نیست", () => {
    const r = collector().compose(reportOf());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toEqual({ code: "CARD_MISSING", message: COMPOSE_MESSAGES.CARD_MISSING, issues: ["call_1"] });
    expect(JSON.stringify(r)).not.toContain("متنِ مدل");
  });

  it("اگر یکی از دو اجرای موفق کارت نداشته باشد کلِ پاسخ رد می‌شود", () => {
    const c = collector();
    c.observe(obs({ callId: "a" }));
    const r = c.compose(reportOf({ toolRuns: [runOf("a", "court_fee", "ok", true), runOf("b", "court_fee", "ok", true)] }));
    expect(!r.ok && r.error.issues).toEqual(["b"]);
  });

  it("نامِ ابزارِ رکورد با کارت نخواند ⇒ TOOL_MISMATCH", () => {
    const c = collector();
    c.observe(obs({ tool: "court_fee" }));
    const r = c.compose(reportOf({ toolRuns: [runOf("call_1", "late_payment", "ok", true)] }));
    expect(!r.ok && r.error.code).toBe("TOOL_MISMATCH");
  });

  it("اجرایِ موفقِ ابزارِ غیرِ calc بی‌کارت ⇒ CARD_MISSING (نتیجه‌ای که کاربر نمی‌بیند مبنای پاسخ نیست)", () => {
    const r = collector().compose(reportOf({ toolRuns: [runOf("x1", "other_tool", "ok", false)] }));
    expect(!r.ok && r.error.code).toBe("CARD_MISSING");
  });

  it("شناسهٔ تکراری در رکوردها ⇒ DUPLICATE_CALL_ID (حتی اگر یکی خطا باشد)", () => {
    const c = collector();
    c.observe(obs());
    const r = c.compose(reportOf({ toolRuns: [runOf("call_1", "court_fee", "error", false), runOf("call_1", "court_fee", "ok", true)] }));
    expect(!r.ok && r.error.code).toBe("DUPLICATE_CALL_ID");
  });

  it("issues حداکثر ۱۰ و شناسهٔ بلند بریده", () => {
    const runs = Array.from({ length: 15 }, (_, i) => runOf(`${"z".repeat(100)}${i}`, "court_fee", "ok", true));
    const r = collector().compose(reportOf({ toolRuns: runs }));
    expect(!r.ok && r.error.issues.length).toBe(10);
    expect(!r.ok && r.error.issues[0]!.length).toBeLessThan(70);
  });
});

describe("compose · کارتِ بی‌اجرای موفق", () => {
  it("کارتی که اجرایش خطا شد (نتیجه به مدل نرسید) نمایش داده نمی‌شود و شمرده می‌شود", () => {
    const c = collector();
    c.observe(obs({ callId: "big" }));
    c.observe(obs({ callId: "good" }));
    const r = c.compose(reportOf({ toolRuns: [runOf("big", "court_fee", "error", false), runOf("good", "court_fee", "ok", true)] }));
    expect(r.ok && r.value.cards.map((x) => x.callId)).toEqual(["good"]);
    expect(r.ok && r.value.droppedCards).toBe(1);
  });

  it("کارتِ بی‌هیچ رکورد هم حذف و شمرده می‌شود", () => {
    const c = collector();
    c.observe(obs({ callId: "ghost" }));
    const r = c.compose(reportOf({ outcome: outcomeOf("answered", false), toolRuns: [] }));
    expect(r.ok && r.value).toMatchObject({ cards: [], droppedCards: 1, reviewPending: false });
  });
});

describe("compose · تأییدنشدگی فقط بالا می‌رود", () => {
  const verifiedCollector = () => {
    const c = collector();
    c.observe(obs({ review: VERIFIED_REVIEW, reviewPending: false }));
    return c;
  };
  it("کارت تأییدشده ولی رکوردِ اجرا تأییدنشده ⇒ کارت هم تأییدنشده با برچسبِ ثابت", () => {
    const r = verifiedCollector().compose(reportOf({ outcome: outcomeOf("answered", false), toolRuns: [runOf("call_1", "court_fee", "ok", true)] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cards[0]).toMatchObject({ reviewPending: true, reviewLabel: REVIEW_PENDING_LABEL });
    expect(r.value.reviewPending).toBe(true);
    expect(r.value.notices[0]).toBe(NOTICES.reviewPending);
  });
  it("کارت و رکورد تأییدشده ولی outcome تأییدنشده ⇒ پاسخ تأییدنشده", () => {
    const r = verifiedCollector().compose(reportOf({ outcome: outcomeOf("answered", true), toolRuns: [runOf("call_1", "court_fee", "ok", false)] }));
    expect(r.ok && r.value.reviewPending).toBe(true);
    expect(r.ok && r.value.cards[0]!.reviewPending).toBe(false);
  });
  it("کارتِ تأییدنشده ولی رکورد و outcome تأییدشده ⇒ پاسخ تأییدنشده", () => {
    const c = collector();
    c.observe(obs());
    const r = c.compose(reportOf({ outcome: outcomeOf("answered", false), toolRuns: [runOf("call_1", "court_fee", "ok", false)] }));
    expect(r.ok && r.value.reviewPending).toBe(true);
  });
  it("کارتِ ژرف‌یخ‌زدهٔ جمع‌آورنده با ارتقای رکورد تغییر نمی‌کند", () => {
    const c = verifiedCollector();
    c.compose(reportOf({ outcome: outcomeOf("answered", false), toolRuns: [runOf("call_1", "court_fee", "ok", true)] }));
    expect(c.snapshot()[0]!.reviewPending).toBe(false);
  });
});

describe("compose · گزارشِ نامعتبر", () => {
  const good = reportOf();
  const cases: [string, unknown][] = [
    ["غیرشیء", "x"],
    ["null", null],
    ["بی‌outcome", { ...good, outcome: undefined }],
    ["status ناشناخته", { ...good, outcome: { ...good.outcome, status: "weird" } }],
    ["answered بی‌text", { ...good, outcome: { ...good.outcome, text: 5 } }],
    ["stopped بی‌reason", { ...good, outcome: outcomeOf("stopped", true, { reason: undefined }) }],
    ["outcome.reviewPending غیربولی", { ...good, outcome: { ...good.outcome, reviewPending: "no" } }],
    ["abortedBy ناشناخته", { ...good, abortedBy: "someone" }],
    ["toolRuns غیرآرایه", { ...good, toolRuns: {} }],
    ["رکوردِ بی‌id", { ...good, toolRuns: [{ ...good.toolRuns[0], id: "" }] }],
    ["رکوردِ status ناشناخته", { ...good, toolRuns: [{ ...good.toolRuns[0], status: "maybe" }] }],
    ["رکوردِ بی‌reviewPendingِ بولی", { ...good, toolRuns: [{ ...good.toolRuns[0], reviewPending: undefined }] }],
  ];
  it.each(cases)("%s ⇒ INVALID_REPORT، بی‌پرتاب", (_n, rep) => {
    const r = collector().compose(rep);
    expect(!r.ok && r.error.code).toBe("INVALID_REPORT");
  });
  it("Proxy بدجنس ⇒ INVALID_REPORT بی‌نشتِ متن", () => {
    const evil = new Proxy({}, { get: () => { throw new Error("leak-SECRET"); }, getPrototypeOf: () => { throw new Error("leak-SECRET"); } });
    const r = collector().compose(evil);
    expect(!r.ok && r.error.code).toBe("INVALID_REPORT");
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });
});

describe("compose · متن‌های ثابتِ رابط (قفل با رشتهٔ لفظی، نه ثابتِ import‌شده)", () => {
  it("برچسب و اعلانِ تأییدنشدگی با «تأییدنشده» شروع/شامل می‌شوند، نه «تأییدشده»", () => {
    expect(REVIEW_PENDING_LABEL.startsWith("تأییدنشده")).toBe(true);
    expect(NOTICES.reviewPending).toContain("تأیید حقوقدان ندارد");
    expect(NOTICES.cardPrecedence).toContain("کارت معتبر است");
  });
  it("toolRuns غیرآرایه ⇒ issuesِ دقیقاً [toolRuns] (نه خطای عمومیِ report)", () => {
    const r = collector().compose({ ...reportOf(), toolRuns: {} });
    expect(!r.ok && r.error).toMatchObject({ code: "INVALID_REPORT", issues: ["toolRuns"] });
  });
});
