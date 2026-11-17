/**
 * نوع‌های محاسبهٔ خسارت تأخیر تأدیه (ماده ۵۲۲ ق.آ.د.م).
 * این فایل فقط «شکل» داده را تعریف می‌کند؛ هیچ شاخص، نرخ یا قاعدهٔ عددیِ حقوقی اینجا نیست.
 * قاعده‌ها و سری‌های شاخص در `late-payment-indices.ts` هستند.
 */
import type { JalaliDate } from "@/modules/shared-types";
import type { ReviewStatus, RoundingMode } from "./court-fee-types";

export type ReviewInfo = Readonly<{ status: ReviewStatus; reviewedBy: string | null; reviewedOn: string | null }>;

/**
 * ریزدانگی سری شاخص.
 * - `monthly`: یک عدد برای هر ماه (کلید «YYYY-MM»).
 * - `annual`: یک عدد برای هر سال (کلید «YYYY»).
 * این‌که کدام‌یک مبنای حقوقی است، به تعیین حقوقدان واگذار شده (یادداشت تحویل ۰۰۰۳)؛ موتور هیچ‌کدام را پیش‌فرض نمی‌گیرد.
 */
export type IndexGranularity = "monthly" | "annual";

/**
 * سیاست موتور وقتی شاخص زمان تأدیه از شاخص مبنا کمتر است.
 * - `zero-damages`: خسارت صفر (هرگز منفی نمی‌شود).
 * - `error`: خطا.
 */
export type IndexDecreasePolicy = "zero-damages" | "error";

/** قاعده‌های عمومی محاسبه؛ همه در فایل داده. */
export type LatePaymentRules = Readonly<{
  review: ReviewInfo;
  sources: readonly string[];
  /** گردکردن کسر ریال */
  rounding: RoundingMode;
  onIndexDecrease: IndexDecreasePolicy;
}>;

/**
 * یک سری شاخص (مثلاً «شاخص تأخیر تأدیه» بانک مرکزی با پایهٔ مشخص).
 * مقدارها **رشتهٔ اعشاریِ لاتین** هستند (مثل "1174.5") تا با عدد صحیح بزرگ (BigInt) و بدون خطای اعشار محاسبه شوند.
 */
export type IndexSeries = Readonly<{
  /** شناسهٔ یکتا، مثلاً `cbi-late-payment-1395` */
  id: string;
  title: string;
  granularity: IndexGranularity;
  /** سال پایه و توضیح سری (مثل «پایهٔ ۱۳۹۵=۱۰۰»)؛ سری‌های با پایه‌های مختلف نباید قاطی شوند */
  baseNote: string;
  review: ReviewInfo;
  sources: readonly string[];
  /** کلید ماهانه «YYYY-MM» یا سالانه «YYYY» ← رشتهٔ اعشاری */
  values: Readonly<Record<string, string>>;
}>;

/** شاخصی که کاربر مستقیماً از جدول رسمی وارد می‌کند. */
export type ManualIndexSource = Readonly<{
  mode: "manual";
  /** شاخص زمان سررسید (مبنا)؛ رشتهٔ اعشاریِ لاتین */
  baseIndex: string;
  /** شاخص زمان تأدیه؛ رشتهٔ اعشاریِ لاتین */
  paymentIndex: string;
  /** برچسب اختیاری برای نمایش، مثل «فروردین ۱۴۰۲» */
  baseLabel?: string;
  paymentLabel?: string;
}>;

/** شاخص از سری ثبت‌شده در فایل داده، بر اساس تاریخ‌ها. */
export type SeriesIndexSource = Readonly<{
  mode: "series";
  seriesId: string;
  /** تاریخ سررسید (مبدأ محاسبه). تعیین مبدأ حقوقی (سررسید/مطالبه) با فراخواننده است. */
  dueDate: JalaliDate;
  /** تاریخ تأدیه (پایان محاسبه) */
  paymentDate: JalaliDate;
}>;

export type LatePaymentInput = Readonly<{
  /** اصل دین به ریالِ عدد صحیح */
  principalRials: number;
  index: ManualIndexSource | SeriesIndexSource;
}>;

export type IndexPoint = Readonly<{
  /** برچسب خوانا (کلید سری یا متن کاربر) */
  label: string;
  /** مقدار نرمال‌شدهٔ رشتهٔ اعشاری */
  value: string;
}>;

export type LatePaymentResult = Readonly<{
  mode: "manual" | "series";
  seriesId: string | null;
  granularity: IndexGranularity | null;
  principalRials: number;
  /** خسارت تأخیر تأدیه (ریال) */
  damagesRials: number;
  /** اصل دین + خسارت (همان «مبلغ دین با احتساب خسارت» در رأی وحدت رویه) */
  totalRials: number;
  baseIndex: IndexPoint;
  paymentIndex: IndexPoint;
  /** تغییر شاخص به نقطهٔ مبنا (۱۰۰ = ۱٪؛ برش به سمت صفر). فقط برای نمایش؛ در محاسبهٔ پول به‌کار نمی‌رود. */
  changeBps: number;
  /** شاخص تأدیه کمتر از شاخص مبنا بود */
  indexDecreased: boolean;
  rounding: RoundingMode;
  roundingApplied: boolean;
  review: ReviewInfo;
  sources: readonly string[];
  notes: readonly string[];
}>;

export type LatePaymentBatchItem = Readonly<{ label?: string; input: LatePaymentInput }>;

export type LatePaymentBatchResult = Readonly<{
  items: readonly LatePaymentResult[];
  totalPrincipalRials: number;
  totalDamagesRials: number;
  totalRials: number;
  review: ReviewInfo;
  notes: readonly string[];
}>;
