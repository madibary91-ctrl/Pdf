import { describe, expect, it } from "vitest";
import { MAX_CARDS_CEILING, REVIEW_PENDING_LABEL, TOOL_TITLES, createCardCollector } from "./index";
import { CALC_TOOLS } from "@/modules/calc-tools";
import { PENDING_REVIEW, VERIFIED_REVIEW, collector, obs } from "./test-kit";

const throwsConst = (fn: () => void): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("باید پرتاب می‌کرد");
};

describe("createCardCollector · گزینه‌ها", () => {
  it("maxCards الزامی و بی‌پیش‌فرض است", () => {
    for (const bad of [undefined, null, {}, { maxCards: 0 }, { maxCards: -1 }, { maxCards: 1.5 }, { maxCards: "3" }, { maxCards: MAX_CARDS_CEILING + 1 }, { maxCards: Number.NaN }, [], 5]) {
      const r = createCardCollector(bad as never);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_OPTIONS");
    }
    expect(createCardCollector({ maxCards: 1 }).ok).toBe(true);
    expect(createCardCollector({ maxCards: MAX_CARDS_CEILING }).ok).toBe(true);
  });

  it("کلیدِ ناشناخته (غلطِ املایی) رد می‌شود و مقدارش بازتاب نمی‌یابد", () => {
    const r = createCardCollector({ maxCards: 3, maxcards: "SECRET-VALUE" } as never);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.issues.join("|")).toContain("maxcards");
      expect(JSON.stringify(r.error)).not.toContain("SECRET-VALUE");
    }
  });

  it("Proxy بدجنس ⇒ خطا، نه پرتاب", () => {
    const evil = new Proxy({}, { ownKeys: () => { throw new Error("boom-SECRET"); }, getPrototypeOf: () => { throw new Error("boom-SECRET"); } });
    const r = createCardCollector(evil as never);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("issues حداکثر ۱۰ و نامِ کلیدِ بلند بریده می‌شود", () => {
    const opts: Record<string, unknown> = { maxCards: 3 };
    for (let i = 0; i < 20; i++) opts[`k${i}`] = 1;
    opts["x".repeat(100)] = 1;
    const r = createCardCollector(opts as never);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.issues.length).toBeLessThanOrEqual(10);
    }
    const r2 = createCardCollector({ maxCards: 3, ["y".repeat(100)]: 1 } as never);
    if (!r2.ok) expect(r2.error.issues[0]!.length).toBeLessThan(80);
  });
});

describe("observe · ساختِ کارت", () => {
  it("کارتِ تأییدنشده: عنوانِ ثابت، برچسبِ تأییدنشدگی و نتیجهٔ عیناً", () => {
    const c = collector();
    c.observe(obs());
    const [card] = c.snapshot();
    expect(card).toMatchObject({ callId: "call_1", tool: "court_fee", title: TOOL_TITLES.court_fee, reviewPending: true, reviewLabel: REVIEW_PENDING_LABEL, notes: ["یادداشتِ آزمون"] });
    expect(card!.result).toEqual({ total: 42, parts: [1, 2], nested: { a: null } });
  });

  it("کارتِ تأییدشده فقط با هر چهار نشانه (پرچم، وضعیت، بازبین، تاریخ)", () => {
    const c = collector();
    c.observe(obs({ callId: "ok", review: VERIFIED_REVIEW, reviewPending: false }));
    expect(c.snapshot()[0]).toMatchObject({ reviewPending: false, reviewLabel: "تأییدشده توسط حقوقدانِ آزمون در تاریخ 1405-01-01." });
  });

  it.each([
    ["پرچمِ ناظر true", { review: VERIFIED_REVIEW, reviewPending: true }],
    ["وضعیتِ دیگر", { review: { ...VERIFIED_REVIEW, status: "draft" }, reviewPending: false }],
    ["بی‌بازبین", { review: { ...VERIFIED_REVIEW, reviewedBy: null }, reviewPending: false }],
    ["بازبینِ خالی/فاصله", { review: { ...VERIFIED_REVIEW, reviewedBy: "  " }, reviewPending: false }],
    ["بی‌تاریخ", { review: { ...VERIFIED_REVIEW, reviewedOn: null }, reviewPending: false }],
    ["تاریخِ خالی", { review: { ...VERIFIED_REVIEW, reviewedOn: "" }, reviewPending: false }],
  ])("شکست‌بسته: %s ⇒ تأییدنشده", (_n, over) => {
    const c = collector();
    c.observe(obs(over));
    expect(c.snapshot()[0]).toMatchObject({ reviewPending: true, reviewLabel: REVIEW_PENDING_LABEL });
  });

  it("کارت و نتیجه ژرف‌یخ‌زده‌اند و از منبع جدا (تغییرِ بعدیِ رویداد اثری ندارد)", () => {
    const c = collector();
    const source = { total: 1, inner: { list: [1, 2] } };
    const notes = ["الف"];
    c.observe(obs({ result: source, notes }));
    source.total = 999;
    source.inner.list.push(3);
    notes.push("ب");
    const card = c.snapshot()[0]!;
    expect(card.result).toEqual({ total: 1, inner: { list: [1, 2] } });
    expect(card.notes).toEqual(["الف"]);
    expect(Object.isFrozen(card)).toBe(true);
    expect(Object.isFrozen(card.result)).toBe(true);
    expect(Object.isFrozen((card.result as { inner: object }).inner)).toBe(true);
    expect(Object.isFrozen(card.notes)).toBe(true);
    expect(Object.isFrozen(card.review)).toBe(true);
    expect(Object.isFrozen(c.snapshot())).toBe(true);
  });

  it("هر نامِ calc-tools عنوانِ فارسیِ ثابت دارد", () => {
    for (const t of CALC_TOOLS) {
      expect(TOOL_TITLES[t.name].length, t.name).toBeGreaterThan(3);
      const c = collector();
      c.observe(obs({ tool: t.name }));
      expect(c.snapshot()[0]!.title).toBe(TOOL_TITLES[t.name]);
    }
  });
});

describe("observe · شکست‌بستگی (پرتابِ عمدی، پیامِ ثابت و بی‌بازتاب)", () => {
  const BAD: [string, unknown][] = [
    ["رویدادِ غیرِ شیء", "x"],
    ["null", null],
    ["آرایه", []],
    ["بی‌callId", obs({ callId: "" })],
    ["callIdِ غیررشته", obs({ callId: 5 as never })],
    ["ابزارِ ناشناخته", obs({ tool: "evil_tool_SECRET" })],
    ["reviewPendingِ غیربولی", obs({ reviewPending: "false" })],
    ["review غیرشیء", obs({ review: "legally-verified" })],
    ["review بی‌status", obs({ review: { status: "", reviewedBy: null, reviewedOn: null } })],
    ["reviewedByِ عدد", obs({ review: { status: "x", reviewedBy: 5, reviewedOn: null } })],
    ["reviewedOnِ عدد", obs({ review: { status: "x", reviewedBy: null, reviewedOn: 5 } })],
    ["notes غیرآرایه", obs({ notes: "یادداشت" })],
    ["notes با عضوِ غیررشته", obs({ notes: ["الف", 3] })],
    ["resultِ undefined", obs({ result: undefined })],
    ["resultِ BigInt", obs({ result: { a: BigInt(1) } })],
    ["resultِ چرخه‌دار", (() => { const a: Record<string, unknown> = {}; a["self"] = a; return obs({ result: a }); })()],
  ];
  it.each(BAD)("%s ⇒ پرتاب با پیامِ ثابت؛ کارتی ثبت نمی‌شود", (_n, bad) => {
    const c = collector();
    const msg = throwsConst(() => c.observe(bad as never));
    expect(msg).toBe("ثبتِ کارتِ محاسبه ممکن نشد.");
    expect(c.snapshot()).toHaveLength(0);
  });

  it("callIdِ تکراری پرتاب می‌کند (کارتِ اول دست‌نخورده)", () => {
    const c = collector();
    c.observe(obs({ result: { first: true } }));
    expect(throwsConst(() => c.observe(obs({ result: { first: false } })))).toBe("ثبتِ کارتِ محاسبه ممکن نشد.");
    expect(c.snapshot()).toHaveLength(1);
    expect(c.snapshot()[0]!.result).toEqual({ first: true });
  });

  it("پس از پر شدنِ سقف پرتاب می‌کند؛ سقف دقیق است", () => {
    const c = collector(2);
    c.observe(obs({ callId: "a" }));
    c.observe(obs({ callId: "b" }));
    expect(throwsConst(() => c.observe(obs({ callId: "c" })))).toBe("ثبتِ کارتِ محاسبه ممکن نشد.");
    expect(c.snapshot().map((x) => x.callId)).toEqual(["a", "b"]);
  });

  it("getterِ بدجنس: پرتاب با پیامِ ثابت، متنِ استثنای بومی نشت نمی‌کند", () => {
    const evil = {
      get callId(): string { throw new Error("leak-SECRET"); },
    };
    const c = collector();
    expect(throwsConst(() => c.observe(evil as never))).toBe("ثبتِ کارتِ محاسبه ممکن نشد.");
    expect(c.snapshot()).toHaveLength(0);
  });
});
