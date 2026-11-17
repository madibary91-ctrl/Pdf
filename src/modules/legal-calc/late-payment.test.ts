import { describe, expect, it } from "vitest";
import {
  LATE_PAYMENT_INDEX_SERIES,
  LATE_PAYMENT_RULES,
  calculateLatePayment,
  calculateLatePaymentBatch,
  findIndexSeries,
  indexKeyFor,
  validateIndexSeries,
  validateLatePaymentRules,
  type IndexSeries,
  type LatePaymentInput,
  type LatePaymentRules,
} from "./index";

/**
 * ⚠️ مرز اعتبار این تست‌ها (مثل legal-calc.test.ts):
 * - مقدارهای مورد انتظار با ابزار مستقل (حساب کسر دقیق در Python) به‌دست آمده‌اند، نه از حقوقدان؛
 *   فقط ثابت می‌کنند موتور فرمول را درست و بدون خطای اعشار اجرا می‌کند، نه این‌که فرمول/شاخص حقوقاً درست است.
 * - سری‌های این فایل **ساختگی**‌اند (برای آزمودن موتور) و هیچ ارتباطی با شاخص واقعی بانک مرکزی ندارند.
 * - نمونه‌های مرجع حقوقدان در بخش «it.todo» پایین اضافه شوند (AGENTS.md قاعدهٔ ۷).
 */

const PENDING = { status: "pending-legal-review", reviewedBy: null, reviewedOn: null } as const;
const VERIFIED = { status: "legally-verified", reviewedBy: "حقوقدان آزمایشی", reviewedOn: "1405/01/01" } as const;

const rules = (over: Partial<LatePaymentRules> = {}): LatePaymentRules => ({ ...LATE_PAYMENT_RULES, ...over });

/** سری ماهانهٔ ساختگی */
const MONTHLY: IndexSeries = {
  id: "synthetic-monthly",
  title: "سری ساختگی ماهانه (فقط تست)",
  granularity: "monthly",
  baseNote: "ساختگی",
  review: PENDING,
  sources: ["ساختگی برای تست"],
  values: { "1403-01": "120.0", "1403-02": "125.5", "1403-12": "110.5", "1404-01": "132.6", "1404-02": "150.0", "1404-03": "100" },
};
/** سری سالانهٔ ساختگی */
const ANNUAL: IndexSeries = {
  id: "synthetic-annual",
  title: "سری ساختگی سالانه (فقط تست)",
  granularity: "annual",
  baseNote: "ساختگی",
  review: PENDING,
  sources: ["ساختگی برای تست"],
  values: { "1400": "437", "1404": "1445.8" },
};
const SERIES = [MONTHLY, ANNUAL] as const;

const manual = (principalRials: number, baseIndex: string, paymentIndex: string): LatePaymentInput => ({
  principalRials,
  index: { mode: "manual", baseIndex, paymentIndex },
});
const viaSeries = (
  principalRials: number,
  seriesId: string,
  due: [number, number, number],
  paid: [number, number, number],
): LatePaymentInput => ({
  principalRials,
  index: {
    mode: "series",
    seriesId,
    dueDate: { year: due[0], month: due[1], day: due[2] },
    paymentDate: { year: paid[0], month: paid[1], day: paid[2] },
  },
});

function value(input: LatePaymentInput, s: readonly IndexSeries[] = SERIES, r: LatePaymentRules = LATE_PAYMENT_RULES) {
  const res = calculateLatePayment(input, s, r);
  if (!res.ok) throw new Error(`انتظار موفقیت داشتیم: ${res.error.message}`);
  return res.value;
}
function failure(input: LatePaymentInput, s: readonly IndexSeries[] = SERIES, r: LatePaymentRules = LATE_PAYMENT_RULES) {
  const res = calculateLatePayment(input, s, r);
  if (res.ok) throw new Error("انتظار خطا داشتیم");
  return res.error;
}

describe("legal-calc: تأخیر تأدیه — حالت ورود دستی شاخص", () => {
  it("مثال ساده و دقیق: ۱۰۰ میلیون × (۱۵۰ ÷ ۱۰۰) → خسارت ۵۰ میلیون", () => {
    const r = value(manual(100_000_000, "100", "150"));
    expect(r.totalRials).toBe(150_000_000);
    expect(r.damagesRials).toBe(50_000_000);
    expect(r.principalRials).toBe(100_000_000);
    expect(r.changeBps).toBe(5000);
    expect(r.roundingApplied).toBe(false);
    expect(r.indexDecreased).toBe(false);
    expect(r.mode).toBe("manual");
    expect(r.seriesId).toBeNull();
    expect(r.granularity).toBeNull();
  });

  it("شاخص اعشاری (سه رقم) با کسر ریال: ۱٫۲۳۰٬۹۷۲٬۳۲۹ و گرد شده", () => {
    const r = value(manual(1_000_000_000, "1174.5", "1445.777"));
    expect(r.totalRials).toBe(1_230_972_329);
    expect(r.damagesRials).toBe(230_972_329);
    expect(r.changeBps).toBe(2309);
    expect(r.roundingApplied).toBe(true);
    expect(r.notes.some((n) => n.includes("گرد شد"))).toBe(true);
  });

  it("شاخص‌های اعشاری با تعداد رقم متفاوت هم‌مقیاس می‌شوند (۲۱۴٫۵ و ۳۴۵٫۸)", () => {
    expect(value(manual(250_000_000, "214.5", "345.8")).totalRials).toBe(403_030_303);
  });

  it("بدون خطای اعشار (Float) روی مبلغ بزرگ: ۹۹۹٬۹۹۹٬۹۹۹٬۹۹۹ × ۱٫۳ ÷ ۱٫۱ دقیقاً ۱٬۱۸۱٬۸۱۸٬۱۸۱٬۸۱۷", () => {
    const r = value(manual(999_999_999_999, "1.1", "1.3"));
    expect(r.totalRials).toBe(1_181_818_181_817);
    expect(r.roundingApplied).toBe(false);
  });

  it("شاخص بسیار کوچک و اعشاری (۰٫۰۰۱ → ۰٫۰۰۲) دقیق است", () => {
    expect(value(manual(5_000_000, "0.001", "0.002")).totalRials).toBe(10_000_000);
  });

  it("صفرهای ابتدایی/انتهایی و فاصلهٔ اطراف پذیرفته و نرمال می‌شود", () => {
    const r = value(manual(100, " 0100 ", "150.50 "));
    expect(r.baseIndex.value).toBe("0100");
    expect(r.paymentIndex.value).toBe("150.50");
    expect(r.totalRials).toBe(151); // ۱۰۰ × ۱۵۰٫۵۰ ÷ ۱۰۰ = ۱۵۰٫۵ → نزدیک‌ترین (نیم به بالا)
  });

  it("برچسب‌های اختیاری در نتیجه می‌آیند", () => {
    const r = value({
      principalRials: 100,
      index: { mode: "manual", baseIndex: "1", paymentIndex: "2", baseLabel: "فروردین ۱۴۰۲", paymentLabel: "خرداد ۱۴۰۴" },
    });
    expect(r.baseIndex.label).toBe("فروردین ۱۴۰۲");
    expect(r.paymentIndex.label).toBe("خرداد ۱۴۰۴");
  });

  it("همیشه یادداشت «شاخص‌ها را شما وارد کرده‌اید» و یادآوری شرایط ماده ۵۲۲ دارد", () => {
    const r = value(manual(100, "1", "2"));
    expect(r.notes.some((n) => n.includes("خودتان وارد کرده‌اید"))).toBe(true);
    expect(r.notes.some((n) => n.includes("ماده ۵۲۲"))).toBe(true);
  });
});

describe("legal-calc: تأخیر تأدیه — گردکردن (قاعده از فایل داده)", () => {
  // اصل ۱، شاخص ۳ → ۴: ۱٫۳۳۳…
  it.each([
    ["ceil", 2],
    ["floor", 1],
    ["nearest", 1],
  ] as const)("کسر ۱٫۳۳۳ با قاعدهٔ %s → %i", (mode, expected) => {
    const r = value(manual(1, "3", "4"), SERIES, rules({ rounding: mode }));
    expect(r.totalRials).toBe(expected);
    expect(r.damagesRials).toBe(expected - 1);
    expect(r.roundingApplied).toBe(true);
    expect(r.rounding).toBe(mode);
  });

  it("دقیقاً نیم (۱٫۵): «نزدیک‌ترین» به بالا می‌رود، «پایین» پایین", () => {
    expect(value(manual(1, "2", "3"), SERIES, rules({ rounding: "nearest" })).totalRials).toBe(2);
    expect(value(manual(1, "2", "3"), SERIES, rules({ rounding: "floor" })).totalRials).toBe(1);
  });

  it("وقتی کسری نیست، گردکردنی گزارش نمی‌شود حتی با ceil", () => {
    const r = value(manual(100_000_000, "100", "150"), SERIES, rules({ rounding: "ceil" }));
    expect(r.roundingApplied).toBe(false);
  });

  it("گردکردن فقط یک‌بار و روی مبلغ نهایی است: ۱۲۳٬۴۵۶٬۷۸۹ × ۱۸۷٫۵ ÷ ۱۰۰٫۲۵", () => {
    expect(value(manual(123_456_789, "100.25", "187.5")).totalRials).toBe(230_904_219);
  });
});

describe("legal-calc: تأخیر تأدیه — شاخص برابر یا کاهش‌یافته", () => {
  it("شاخص برابر: خسارت صفر، بدون پرچم کاهش", () => {
    const r = value(manual(50_000, "120", "120"));
    expect(r.damagesRials).toBe(0);
    expect(r.totalRials).toBe(50_000);
    expect(r.indexDecreased).toBe(false);
    expect(r.changeBps).toBe(0);
  });

  it("شاخص برابر با اعشار متفاوت (۱۲۰ و ۱۲۰٫۰۰۰) هم برابر است", () => {
    expect(value(manual(50_000, "120", "120.000")).damagesRials).toBe(0);
  });

  it("کاهش شاخص با سیاست «zero-damages»: خسارت صفر (نه منفی) و یادداشت", () => {
    const r = value(manual(1_000_000, "100", "80"));
    expect(r.damagesRials).toBe(0);
    expect(r.totalRials).toBe(1_000_000);
    expect(r.indexDecreased).toBe(true);
    expect(r.changeBps).toBe(-2000);
    expect(r.notes.some((n) => n.includes("خسارت صفر"))).toBe(true);
  });

  it("کاهش شاخص با سیاست «error»: خطای صریح", () => {
    const e = failure(manual(1_000_000, "100", "80"), SERIES, rules({ onIndexDecrease: "error" }));
    expect(e.code).toBe("INVALID_INPUT");
  });

  it("سیاست «error» برای شاخص برابر خطا نیست", () => {
    expect(value(manual(10, "5", "5"), SERIES, rules({ onIndexDecrease: "error" })).damagesRials).toBe(0);
  });
});

describe("legal-calc: تأخیر تأدیه — ورودی نامعتبر", () => {
  it.each([0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("اصل دین نامعتبر: %s", (bad) => {
    expect(failure(manual(bad, "100", "150")).code).toBe("INVALID_INPUT");
  });

  it("اصل دین غیرعدد", () => {
    expect(failure({ principalRials: "100" as unknown as number, index: { mode: "manual", baseIndex: "1", paymentIndex: "2" } }).code).toBe("INVALID_INPUT");
  });

  it.each(["", " ", "abc", "-1", "+5", "1e3", "1,5", "1٫5", "۱۲۰", "12.", ".5", "1.2.3", "0", "0.000", "1234567890123456", "1.1234567890"])(
    "شاخص با متن نامعتبر «%s» رد می‌شود",
    (bad) => {
      expect(calculateLatePayment(manual(100, bad, "150"), SERIES).ok).toBe(false);
      expect(calculateLatePayment(manual(100, "100", bad), SERIES).ok).toBe(false);
    },
  );

  it("شاخص غیرمتن (عدد JS) رد می‌شود تا دقت اعشاری از دست نرود", () => {
    const e = failure({ principalRials: 100, index: { mode: "manual", baseIndex: 100 as unknown as string, paymentIndex: "150" } });
    expect(e.code).toBe("INVALID_INPUT");
  });

  it("منبع شاخص نامشخص یا حالت ناشناخته", () => {
    expect(failure({ principalRials: 100 } as unknown as LatePaymentInput).code).toBe("INVALID_INPUT");
    expect(failure({ principalRials: 100, index: { mode: "magic" } } as unknown as LatePaymentInput).code).toBe("INVALID_INPUT");
  });

  it("سرریز: نتیجه از عدد صحیح امن بیشتر می‌شود → OUT_OF_RANGE (نه نتیجهٔ غلط)", () => {
    expect(failure(manual(Number.MAX_SAFE_INTEGER, "1", "2")).code).toBe("OUT_OF_RANGE");
  });

  it("نزدیک سقف امن ولی داخل آن، درست حساب می‌شود", () => {
    expect(value(manual(4_503_599_627_370_495, "1", "2")).totalRials).toBe(9_007_199_254_740_990);
  });

  it("ورودی دست‌نخورده می‌ماند و نتیجه فقط داده است", () => {
    const input = Object.freeze({ principalRials: 100, index: Object.freeze({ mode: "manual", baseIndex: "1", paymentIndex: "2" } as const) });
    expect(() => calculateLatePayment(input, SERIES)).not.toThrow();
    expect(JSON.parse(JSON.stringify(value(input)))).toMatchObject({ totalRials: 200 });
  });
});

describe("legal-calc: تأخیر تأدیه — حالت سری شاخص", () => {
  it("سری ماهانه: ۱۴۰۳/۱۲ (۱۱۰٫۵) تا ۱۴۰۴/۰۱ (۱۳۲٫۶) → ۷۰ میلیون به ۸۴ میلیون", () => {
    const r = value(viaSeries(70_000_000, "synthetic-monthly", [1403, 12, 29], [1404, 1, 15]));
    expect(r.totalRials).toBe(84_000_000);
    expect(r.damagesRials).toBe(14_000_000);
    expect(r.baseIndex).toEqual({ label: "1403-12", value: "110.5" });
    expect(r.paymentIndex).toEqual({ label: "1404-01", value: "132.6" });
    expect(r.seriesId).toBe("synthetic-monthly");
    expect(r.granularity).toBe("monthly");
    expect(r.mode).toBe("series");
  });

  it("روز ماه تأثیری ندارد؛ فقط ماه/سال دیده می‌شود (ماهانه)", () => {
    const a = value(viaSeries(200_000_000, "synthetic-monthly", [1403, 1, 1], [1404, 2, 1]));
    const b = value(viaSeries(200_000_000, "synthetic-monthly", [1403, 1, 31], [1404, 2, 30]));
    expect(a.totalRials).toBe(250_000_000);
    expect(b.totalRials).toBe(a.totalRials);
  });

  it("سری سالانه: ۱۴۰۰ → ۱۴۰۴ با کلید فقط سال", () => {
    const r = value(viaSeries(300_000_000, "synthetic-annual", [1400, 6, 1], [1404, 11, 11]));
    expect(r.totalRials).toBe(992_540_046);
    expect(r.granularity).toBe("annual");
    expect(r.baseIndex.label).toBe("1400");
  });

  it("سررسید و تأدیه در یک ماه: خسارت صفر و یادداشت", () => {
    const r = value(viaSeries(1_000, "synthetic-monthly", [1403, 1, 2], [1403, 1, 20]));
    expect(r.damagesRials).toBe(0);
    expect(r.notes.some((n) => n.includes("یک دوره"))).toBe(true);
  });

  it("ماه غایب = OUT_OF_RANGE؛ هرگز ماه نزدیک جایگزین نمی‌شود", () => {
    const e = failure(viaSeries(1_000, "synthetic-monthly", [1403, 3, 1], [1404, 1, 1]));
    expect(e.code).toBe("OUT_OF_RANGE");
    expect(e.message).toContain("1403-03");
  });

  it("سال غایب در سری سالانه = OUT_OF_RANGE", () => {
    expect(failure(viaSeries(1_000, "synthetic-annual", [1401, 1, 1], [1404, 1, 1])).code).toBe("OUT_OF_RANGE");
  });

  it("تأدیه پیش از سررسید رد می‌شود؛ هم‌روز مجاز است", () => {
    expect(failure(viaSeries(1_000, "synthetic-monthly", [1404, 1, 2], [1404, 1, 1])).code).toBe("INVALID_INPUT");
    expect(calculateLatePayment(viaSeries(1_000, "synthetic-monthly", [1404, 1, 1], [1404, 1, 1]), SERIES).ok).toBe(true);
  });

  it("تاریخ نامعتبر (۳۱ مهر) رد می‌شود و پیام می‌گوید کدام تاریخ", () => {
    const e1 = failure(viaSeries(1_000, "synthetic-monthly", [1403, 7, 31], [1404, 1, 1]));
    expect(e1.code).toBe("INVALID_DATE");
    expect(e1.message).toContain("سررسید");
    const e2 = failure(viaSeries(1_000, "synthetic-monthly", [1403, 1, 1], [1404, 7, 31]));
    expect(e2.message).toContain("تأدیه");
  });

  it("شناسهٔ سری ناموجود = خطا و سری دیگری جایگزین نمی‌شود", () => {
    const e = failure(viaSeries(1_000, "nope", [1403, 1, 1], [1404, 1, 1]));
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.message).toContain("nope");
  });

  it("با فایل داده‌ٔ فعلی (بدون سری) هر درخواست سری صریحاً خطاست، نه عدد ساختگی", () => {
    const res = calculateLatePayment(viaSeries(1_000, "cbi-anything", [1403, 1, 1], [1404, 1, 1]));
    expect(res.ok).toBe(false);
  });

  it("سری ناقص/خراب هنگام محاسبه رد می‌شود", () => {
    const broken: IndexSeries = { ...MONTHLY, id: "broken", values: { ...MONTHLY.values, "1403-01": "abc" } };
    const e = failure(viaSeries(1_000, "broken", [1403, 1, 1], [1404, 1, 1]), [broken]);
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.message).toContain("broken");
  });

  it("منبع‌ها شامل منبع سری و قاعده‌هاست", () => {
    const r = value(viaSeries(1_000, "synthetic-monthly", [1403, 1, 1], [1404, 1, 1]));
    expect(r.sources).toContain("ساختگی برای تست");
    expect(r.sources.length).toBeGreaterThan(1);
  });
});

describe("legal-calc: تأخیر تأدیه — وضعیت بازبینی حقوقدان", () => {
  it("با فایل داده‌ٔ فعلی: در انتظار تأیید، هم در review و هم در notes", () => {
    const r = value(manual(100, "1", "2"));
    expect(r.review.status).toBe("pending-legal-review");
    expect(r.notes[0]).toContain("تأیید نشده");
  });

  it("فقط وقتی هم سری و هم قاعده‌ها تأییدشده باشند، نتیجه «تأییدشده» است", () => {
    const verifiedSeries: IndexSeries = { ...MONTHLY, id: "v", review: VERIFIED };
    const verifiedRules = rules({ review: VERIFIED });
    const both = value(viaSeries(1_000, "v", [1403, 1, 1], [1404, 1, 1]), [verifiedSeries], verifiedRules);
    expect(both.review.status).toBe("legally-verified");
    expect(both.notes.some((n) => n.includes("تأیید نشده"))).toBe(false);

    const onlySeries = value(viaSeries(1_000, "v", [1403, 1, 1], [1404, 1, 1]), [verifiedSeries], rules({ review: PENDING }));
    expect(onlySeries.review.status).toBe("pending-legal-review");
    const onlyRules = value(viaSeries(1_000, "synthetic-monthly", [1403, 1, 1], [1404, 1, 1]), SERIES, verifiedRules);
    expect(onlyRules.review.status).toBe("pending-legal-review");
  });

  it("ادعای «تأییدشده» بدون نام بازبین و تاریخ، نامعتبر است", () => {
    expect(validateLatePaymentRules(rules({ review: { status: "legally-verified", reviewedBy: null, reviewedOn: null } }))).not.toEqual([]);
    expect(validateIndexSeries({ ...MONTHLY, review: { status: "legally-verified", reviewedBy: "x", reviewedOn: null } })).not.toEqual([]);
  });

  it("قاعدهٔ خراب هنگام محاسبه رد می‌شود", () => {
    const bad = rules({ rounding: "banker" as unknown as LatePaymentRules["rounding"] });
    expect(failure(manual(100, "1", "2"), SERIES, bad).code).toBe("INVALID_INPUT");
  });
});

describe("legal-calc: تأخیر تأدیه — یکپارچگی فایل داده", () => {
  it("قاعده‌های فعلی سالم‌اند و منبع و وضعیت دارند", () => {
    expect(validateLatePaymentRules(LATE_PAYMENT_RULES)).toEqual([]);
    expect(LATE_PAYMENT_RULES.sources.length).toBeGreaterThan(0);
  });

  it("هر سری ثبت‌شده در فایل داده سالم است و شناسهٔ یکتا دارد (امروز: بدون سری)", () => {
    const ids = LATE_PAYMENT_INDEX_SERIES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of LATE_PAYMENT_INDEX_SERIES) expect(validateIndexSeries(s), s.id).toEqual([]);
  });

  it("سری‌های ساختگی تست سالم‌اند", () => {
    expect(validateIndexSeries(MONTHLY)).toEqual([]);
    expect(validateIndexSeries(ANNUAL)).toEqual([]);
  });

  it.each([
    ["کلید ماهانه با ماه ۱۳", { ...MONTHLY, values: { "1403-13": "1" } }],
    ["کلید ماهانه بدون صفر ابتدایی", { ...MONTHLY, values: { "1403-1": "1" } }],
    ["کلید سالانه در سری ماهانه", { ...MONTHLY, values: { "1403": "1" } }],
    ["کلید ماهانه در سری سالانه", { ...ANNUAL, values: { "1403-01": "1" } }],
    ["مقدار صفر", { ...MONTHLY, values: { "1403-01": "0" } }],
    ["مقدار با ویرگول", { ...MONTHLY, values: { "1403-01": "1,5" } }],
    ["بدون مقدار", { ...MONTHLY, values: {} }],
    ["بدون منبع", { ...MONTHLY, sources: [] }],
    ["بدون پایه", { ...MONTHLY, baseNote: "" }],
    ["شناسهٔ خالی", { ...MONTHLY, id: " " }],
    ["ریزدانگی ناشناخته", { ...MONTHLY, granularity: "weekly" as unknown as IndexSeries["granularity"] }],
  ] as const)("سری نامعتبر شناسایی می‌شود: %s", (_name, series) => {
    expect(validateIndexSeries(series as IndexSeries).length).toBeGreaterThan(0);
  });

  it("findIndexSeries و indexKeyFor", () => {
    expect(findIndexSeries("synthetic-annual", SERIES)).toBe(ANNUAL);
    expect(findIndexSeries("x", SERIES)).toBeUndefined();
    expect(indexKeyFor("monthly", { year: 1403, month: 5, day: 9 })).toBe("1403-05");
    expect(indexKeyFor("monthly", { year: 1403, month: 12, day: 9 })).toBe("1403-12");
    expect(indexKeyFor("annual", { year: 1403, month: 5, day: 9 })).toBe("1403");
  });
});

describe("legal-calc: تأخیر تأدیه — جمع چند دین", () => {
  it("جمع دو چک با سررسید متفاوت", () => {
    const r = calculateLatePaymentBatch(
      [
        { label: "چک اول", input: manual(100_000_000, "100", "150") },
        { label: "چک دوم", input: viaSeries(70_000_000, "synthetic-monthly", [1403, 12, 1], [1404, 1, 1]) },
      ],
      SERIES,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items).toHaveLength(2);
    expect(r.value.totalPrincipalRials).toBe(170_000_000);
    expect(r.value.totalDamagesRials).toBe(64_000_000);
    expect(r.value.totalRials).toBe(234_000_000);
    expect(r.value.review.status).toBe("pending-legal-review");
    expect(new Set(r.value.notes).size).toBe(r.value.notes.length);
  });

  it("خطای یک ردیف با شمارهٔ ردیف و برچسب گزارش می‌شود", () => {
    const r = calculateLatePaymentBatch(
      [
        { input: manual(100, "1", "2") },
        { label: "سفتهٔ دوم", input: manual(0, "1", "2") },
      ],
      SERIES,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("ردیف 2");
    expect(r.error.message).toContain("سفتهٔ دوم");
  });

  it("فهرست خالی رد می‌شود", () => {
    const r = calculateLatePaymentBatch([], SERIES);
    expect(r.ok).toBe(false);
  });

  it("جمع هر ردیف جداگانه گرد می‌شود (نه جمعِ کسرها)", () => {
    // هر دو ردیف: ۱ × ۴ ÷ ۳ → «نزدیک‌ترین» = ۱ ⇒ مجموع ۲، نه گرد(۲٫۶۶۶)=۳
    const r = calculateLatePaymentBatch([{ input: manual(1, "3", "4") }, { input: manual(1, "3", "4") }], SERIES);
    expect(r.ok && r.value.totalRials).toBe(2);
  });

  it("سرریز جمع رد می‌شود", () => {
    const big = Number.MAX_SAFE_INTEGER - 10;
    const r = calculateLatePaymentBatch([{ input: manual(big, "1", "1") }, { input: manual(big, "1", "1") }], SERIES);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("OUT_OF_RANGE");
  });
});

describe("legal-calc: تأخیر تأدیه — نمونه‌های مرجع حقوقدان (منتظر)", () => {
  it.todo("چک با سررسید و تأدیهٔ مشخص و اعداد رسمی جدول «شاخص تأخیر تأدیه»: خسارت دقیق مورد انتظار (حقوقدان بدهد)");
  it.todo("نمونهٔ دادگاه‌محور: مبنای ماهانه یا سالانه بر اساس رأی ۸۵۰ — خروجی مرجع (حقوقدان بدهد)");
  it.todo("قاعدهٔ گردکردن کسر ریال در رویهٔ اجرای احکام (حقوقدان تعیین کند)");
  it.todo("رفتار در کاهش شاخص (صفر یا خطا؟) و آستانهٔ «تغییر فاحش» (حقوقدان تعیین کند)");
  it.todo("پرداخت جزئی در میانهٔ مدت: ترتیب تهاتر (خسارت یا اصل) و نحوهٔ شکستن دوره (حقوقدان تعیین کند)");
});
