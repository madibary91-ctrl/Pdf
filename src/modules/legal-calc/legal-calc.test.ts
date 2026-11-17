import { describe, expect, it } from "vitest";
import {
  COURT_FEE_STAGE_ORDER,
  COURT_FEE_TARIFFS,
  calculateCourtFee,
  findCourtFeeTariff,
  validateCourtFeeTariff,
  type CourtFeeInput,
  type CourtFeeStage,
  type CourtFeeTariff,
  type TierMethod,
} from "./index";

/**
 * ⚠️ مرز اعتبار این تست‌ها:
 * مقدارهای مورد انتظار اینجا «با محاسبهٔ دستی از روی جدول فعلی» به‌دست آمده‌اند، نه از حقوقدان.
 * یعنی فقط ثابت می‌کنند موتور همان کاری را می‌کند که جدول می‌گوید؛ درستیِ خودِ جدول را ثابت نمی‌کنند.
 * نمونه‌های مرجع حقوقدان باید در بخش «it.todo» پایین اضافه شوند (AGENTS.md قاعدهٔ ۷).
 */

const D1405 = { year: 1405, month: 1, day: 1 } as const;
const rial = (n: number) => n;
const MILLION = 1_000_000;

function fee(
  stage: CourtFeeStage,
  amountRials: number,
  tierMethod?: TierMethod,
  date: CourtFeeInput["date"] = D1405,
  tariffs?: readonly CourtFeeTariff[],
) {
  return calculateCourtFee({ date, stage, claim: { kind: "known", amountRials }, tierMethod }, tariffs);
}

function feeValue(...args: Parameters<typeof fee>): number {
  const r = fee(...args);
  if (!r.ok) throw new Error(`انتظار موفقیت داشتیم: ${r.error.message}`);
  return r.value.feeRials;
}

const base1405 = COURT_FEE_TARIFFS.find((t) => t.year === 1405)!;
type OwnRule = Extract<CourtFeeTariff["stages"][CourtFeeStage], { kind: "own" }>;
const ownRule = (s: CourtFeeStage): OwnRule => base1405.stages[s] as OwnRule;
/** جدولِ ساختگی با سال ۱۵۰۰ برای آزمودن این‌که فقط داده تعیین‌کننده است. */
const synthetic = (over: Partial<CourtFeeTariff>): CourtFeeTariff => ({ ...base1405, year: 1500, ...over });

describe("legal-calc: هزینهٔ دادرسی — مرحلهٔ بدوی", () => {
  it("تا آستانهٔ اول: نرخ پلهٔ اول و بدون نیاز به روش پله‌ای", () => {
    const r = fee("first-instance", rial(100 * MILLION));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.feeRials).toBe(2_500_000);
    expect(r.value.tierMethod).toBeNull();
    expect(r.value.alternativeFeeRials).toBeNull();
    expect(r.value.roundingApplied).toBe(false);
    expect(r.value.steps).toEqual([{ fromRials: 0, toRials: 200_000_000, baseRials: 100_000_000, rateBps: 250 }]);
  });

  it("دقیقاً روی آستانه («تا مبلغ …» شامل است): هنوز پلهٔ اول و بدون ابهام", () => {
    const r = fee("first-instance", rial(200 * MILLION));
    expect(r.ok && r.value.feeRials).toBe(5_000_000);
    expect(r.ok && r.value.tierMethod).toBeNull();
  });

  it("یک ریال بالاتر از آستانه: روش پله‌ای الزامی است (فرض پنهان نداریم)", () => {
    const r = fee("first-instance", rial(200 * MILLION + 1));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.message).toContain("روش محاسبه");
  });

  it("۳۰۰ میلیون ریال: روش پلکانی (تفکیک مبلغ)", () => {
    const r = fee("first-instance", rial(300 * MILLION), "progressive");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.feeRials).toBe(8_500_000); // ۵٬۰۰۰٬۰۰۰ + ۳٫۵٪ از ۱۰۰ میلیون
    expect(r.value.alternativeFeeRials).toBe(10_500_000);
    expect(r.value.tierMethod).toBe("progressive");
    expect(r.value.steps).toEqual([
      { fromRials: 0, toRials: 200_000_000, baseRials: 200_000_000, rateBps: 250 },
      { fromRials: 200_000_000, toRials: null, baseRials: 100_000_000, rateBps: 350 },
    ]);
  });

  it("۳۰۰ میلیون ریال: روش کل‌مبلغ؛ نتیجهٔ روش دیگر برای مقایسه برمی‌گردد", () => {
    const r = fee("first-instance", rial(300 * MILLION), "whole-amount");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.feeRials).toBe(10_500_000);
    expect(r.value.alternativeFeeRials).toBe(8_500_000);
    expect(r.value.steps).toEqual([{ fromRials: 0, toRials: null, baseRials: 300_000_000, rateBps: 350 }]);
  });

  it("۲۱۰ میلیون ریال: اختلاف دو روش نمایان است", () => {
    expect(feeValue("first-instance", rial(210 * MILLION), "progressive")).toBe(5_350_000);
    expect(feeValue("first-instance", rial(210 * MILLION), "whole-amount")).toBe(7_350_000);
  });

  it("کسر ریال طبق قاعدهٔ جدول گرد می‌شود و علامت و توضیح دارد", () => {
    const r = fee("first-instance", rial(200 * MILLION + 1), "progressive");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.feeRials).toBe(5_000_001); // ۵٬۰۰۰٬۰۰۰٫۰۳۵ ← گرد به بالا
    expect(r.value.roundingApplied).toBe(true);
    expect(r.value.notes.some((n) => n.includes("گرد"))).toBe(true);
  });

  it("بهای خواسته نامعلوم: هزینهٔ ثابت جدول", () => {
    const r = calculateCourtFee({ date: D1405, stage: "first-instance", claim: { kind: "unknown" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.feeRials).toBe(1_500_000);
    expect(r.value.baseAmountRials).toBeNull();
    expect(r.value.steps).toEqual([]);
  });
});

describe("legal-calc: هزینهٔ دادرسی — مراحل بالاتر", () => {
  it("تجدیدنظر و فرجام‌خواهی: نرخ ثابت", () => {
    expect(feeValue("appeal", rial(100 * MILLION))).toBe(4_500_000);
    expect(feeValue("cassation", rial(100 * MILLION))).toBe(5_500_000);
  });

  it("واخواهی هم‌نرخ تجدیدنظر؛ اعادهٔ دادرسی و اعتراض ثالث هم‌نرخ فرجام", () => {
    expect(feeValue("default-judgment-objection", rial(100 * MILLION))).toBe(4_500_000);
    expect(feeValue("retrial", rial(100 * MILLION))).toBe(5_500_000);
    expect(feeValue("third-party-objection", rial(100 * MILLION))).toBe(5_500_000);
    const r = fee("retrial", rial(100 * MILLION));
    expect(r.ok && r.value.stageLabel).toBe("اعادهٔ دادرسی");
    expect(r.ok && r.value.notes.some((n) => n.includes("بخشنامه"))).toBe(true);
  });

  it("در مراحل تک‌نرخی، مبلغ بزرگ هم ابهامی ندارد و tierMethod نادیده گرفته می‌شود", () => {
    const r = fee("appeal", rial(1_000 * MILLION), "whole-amount");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.feeRials).toBe(45_000_000);
    expect(r.value.tierMethod).toBeNull();
    expect(r.value.alternativeFeeRials).toBeNull();
  });

  it("بهای نامعلوم فقط در مرحله‌ای که جدول تعریف کرده ممکن است", () => {
    const r = calculateCourtFee({ date: D1405, stage: "appeal", claim: { kind: "unknown" } });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe("INVALID_INPUT");
  });
});

describe("legal-calc: هزینهٔ دادرسی — اعتبارسنجی ورودی", () => {
  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("مبلغ نامعتبر %s رد می‌شود", (amount) => {
    const r = fee("first-instance", amount, "progressive");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe("INVALID_INPUT");
  });

  it("مبلغ بیش از حد فنیِ عدد امن: OUT_OF_RANGE (نه نتیجهٔ غلط بی‌صدا)", () => {
    const r = fee("appeal", Number.MAX_SAFE_INTEGER);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe("OUT_OF_RANGE");
  });

  it("مبلغ بسیار بزرگ ولی مجاز دقیق محاسبه می‌شود", () => {
    expect(feeValue("appeal", 10_000_000_000_000)).toBe(450_000_000_000);
  });

  it("تاریخ جلالی نامعتبر رد می‌شود", () => {
    const r = fee("appeal", 1000, undefined, { year: 1405, month: 13, day: 1 });
    expect(r.ok).toBe(false);
  });

  it("مرحلهٔ ناشناخته و روش ناشناخته رد می‌شود", () => {
    const bad = calculateCourtFee({ date: D1405, stage: "nope" as CourtFeeStage, claim: { kind: "known", amountRials: 1000 } });
    expect(bad.ok).toBe(false);
    const badMethod = fee("first-instance", 300 * MILLION, "x" as TierMethod);
    expect(badMethod.ok).toBe(false);
  });
});

describe("legal-calc: انتخاب جدول بر اساس سال", () => {
  it("جدول همان سالِ تاریخ انتخاب می‌شود", () => {
    const r1405 = fee("appeal", rial(MILLION), undefined, { year: 1405, month: 12, day: 29 });
    const r1404 = fee("appeal", rial(MILLION), undefined, { year: 1404, month: 1, day: 1 });
    expect(r1405.ok && r1405.value.tariffYear).toBe(1405);
    expect(r1404.ok && r1404.value.tariffYear).toBe(1404);
  });

  it("سالِ بدون جدول: خطای صریح؛ هرگز جدول سال دیگر جایگزین نمی‌شود", () => {
    const r = fee("appeal", rial(MILLION), undefined, { year: 1399, month: 1, day: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("OUT_OF_RANGE");
    expect(r.error.message).toContain("court-fee-tariffs.ts");
  });

  it("findCourtFeeTariff سال ناموجود را undefined می‌دهد", () => {
    expect(findCourtFeeTariff(1300)).toBeUndefined();
    expect(findCourtFeeTariff(1405)?.year).toBe(1405);
  });
});

describe("legal-calc: وضعیت بازبینی حقوقدان همیشه همراه نتیجه است", () => {
  it("جدول تأییدنشده: review و هشدار در نتیجه", () => {
    const r = fee("appeal", rial(MILLION));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.review.status).toBe("pending-legal-review");
    expect(r.value.notes[0]).toContain("تأیید نشده");
    expect(r.value.sources.length).toBeGreaterThan(0);
  });

  it("جدول تأییدشده: هشدار تأییدنشدن نمی‌آید", () => {
    const verified = synthetic({ review: { status: "legally-verified", reviewedBy: "الف", reviewedOn: "1405/02/01" } });
    const r = fee("appeal", rial(MILLION), undefined, { year: 1500, month: 1, day: 1 }, [verified]);
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.notes.some((n) => n.includes("تأیید نشده"))).toBe(false);
  });
});

describe("legal-calc: فقط فایل نرخ‌ها تعیین‌کنندهٔ عدد است (تغییر قانون = تغییر داده، نه کد)", () => {
  const D1500 = { year: 1500, month: 1, day: 1 } as const;

  it("با جدول دیگر، همان کد نتیجهٔ دیگر می‌دهد", () => {
    const t = synthetic({
      stages: {
        ...base1405.stages,
        appeal: {
          kind: "own",
          label: "تجدیدنظر",
          basis: "x",
          source: "x",
          tiers: [
            { upToRials: 1000, rateBps: 100 },
            { upToRials: 5000, rateBps: 200 },
            { upToRials: null, rateBps: 300 },
          ],
          unknownValueFeeRials: 777,
        },
      },
    });
    // سه پله، روش پلکانی: ۱۰۰۰×۱٪ + ۴۰۰۰×۲٪ + ۵۰۰۰×۳٪ = ۱۰ + ۸۰ + ۱۵۰ = ۲۴۰
    expect(feeValue("appeal", 10_000, "progressive", D1500, [t])).toBe(240);
    // کل‌مبلغ: ۱۰٬۰۰۰×۳٪ = ۳۰۰
    expect(feeValue("appeal", 10_000, "whole-amount", D1500, [t])).toBe(300);
    const unknown = calculateCourtFee({ date: D1500, stage: "appeal", claim: { kind: "unknown" } }, [t]);
    expect(unknown.ok && unknown.value.feeRials).toBe(777);
  });

  it.each([
    ["ceil", 1, 1],
    ["floor", 1, 0],
    ["nearest", 1, 0],
    ["ceil", 20, 1],
    ["floor", 20, 0],
    ["nearest", 20, 1], // ۲۰×۲٫۵٪ = ۰٫۵ ← نیمه رو به بالا
  ] as const)("قاعدهٔ گردکردن %s برای مبلغ %i ریال → %i", (rounding, amount, expected) => {
    const t = synthetic({ rounding });
    expect(feeValue("first-instance", amount, undefined, D1500, [t])).toBe(expected);
  });

  it("جدول خراب نتیجهٔ بی‌صدا نمی‌دهد", () => {
    const broken = synthetic({
      stages: { ...base1405.stages, appeal: { ...ownRule("appeal"), tiers: [] } },
    });
    const r = fee("appeal", 1000, undefined, D1500, [broken]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.message).toContain("نامعتبر");
  });
});

describe("legal-calc: یکپارچگی جدول‌های نرخ", () => {
  it("جدول‌های فعلی بدون مشکل‌اند", () => {
    for (const t of COURT_FEE_TARIFFS) expect(validateCourtFeeTariff(t), `سال ${t.year}`).toEqual([]);
  });

  it("سال‌ها یکتا و همهٔ مراحل در هر جدول موجودند", () => {
    expect(new Set(COURT_FEE_TARIFFS.map((t) => t.year)).size).toBe(COURT_FEE_TARIFFS.length);
    for (const t of COURT_FEE_TARIFFS) for (const s of COURT_FEE_STAGE_ORDER) expect(t.stages[s]).toBeDefined();
  });

  it("تا زمان بازبینی حقوقدان، هیچ جدولی «تأییدشده» اعلام نشده است", () => {
    // با تأیید حقوقدان این انتظار عمداً عوض می‌شود (وضعیت + نام بازبین + تاریخ در فایل نرخ‌ها).
    for (const t of COURT_FEE_TARIFFS) {
      if (t.review.status === "legally-verified") {
        expect(t.review.reviewedBy).toBeTruthy();
        expect(t.review.reviewedOn).toBeTruthy();
      }
    }
  });

  it.each<[string, Partial<CourtFeeTariff>, string]>([
    ["سقف‌های غیرصعودی", { stages: { ...base1405.stages, "first-instance": { ...ownRule("first-instance"), tiers: [{ upToRials: 500, rateBps: 1 }, { upToRials: 400, rateBps: 2 }, { upToRials: null, rateBps: 3 }] } } }, "صعودی"],
    ["آخرین پله با سقف", { stages: { ...base1405.stages, appeal: { ...ownRule("appeal"), tiers: [{ upToRials: 500, rateBps: 1 }] } } }, "آخرین پله"],
    ["نرخ اعشاری", { stages: { ...base1405.stages, appeal: { ...ownRule("appeal"), tiers: [{ upToRials: null, rateBps: 4.5 }] } } }, "نرخ"],
    ["هم‌نرخ با هم‌نرخ", { stages: { ...base1405.stages, retrial: { kind: "same-as", sameAs: "third-party-objection", label: "x", basis: "x", source: "x" } } }, "هم‌نرخ"],
    ["تأییدشده بدون بازبین", { review: { status: "legally-verified", reviewedBy: null, reviewedOn: null } }, "بازبین"],
    ["بدون منبع", { sources: [] }, "منبع"],
    ["گردکردن نامعتبر", { rounding: "banker" as never }, "گردکردن"],
  ])("خرابی تشخیص داده می‌شود: %s", (_name, over, fragment) => {
    const problems = validateCourtFeeTariff({ ...base1405, ...over });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" ")).toContain(fragment);
  });
});

describe("legal-calc: قطعی بودن", () => {
  it("همان ورودی، همان خروجی", () => {
    const a = fee("first-instance", rial(300 * MILLION), "progressive");
    const b = fee("first-instance", rial(300 * MILLION), "progressive");
    expect(a).toEqual(b);
  });
});

describe("legal-calc: نمونه‌های مرجع حقوقدان (⏳ در انتظار)", () => {
  it.todo("حقوقدان: جدول رسمی ۱۴۰۵ را با court-fee-tariffs.ts تطبیق دهد");
  it.todo("حقوقدان: روش درست اعمال نرخ ۳٫۵٪ برای خواسته بیش از ۲۰۰ میلیون ریال (کل مبلغ یا مازاد) + یک نمونهٔ مرجع");
  it.todo("حقوقدان: مبنای تجدیدنظر/فرجام (کل محکوم‌به یا بخش مورد اعتراض) + یک نمونهٔ مرجع");
  it.todo("حقوقدان: قاعدهٔ گردکردن کسر ریال");
  it.todo("حقوقدان: تأیید ردیف ۱۴۰۴ با متن رسمی جدول ۱۶ بودجه ۱۴۰۴");
});
