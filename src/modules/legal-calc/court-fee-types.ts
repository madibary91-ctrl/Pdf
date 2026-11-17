/**
 * نوع‌های محاسبهٔ هزینهٔ دادرسی (دعاوی مالی).
 * این فایل فقط «شکل» داده را تعریف می‌کند؛ هیچ نرخ، درصد یا آستانهٔ حقوقی اینجا نیست.
 * همهٔ اعداد حقوقی در `court-fee-tariffs.ts` هستند.
 */
import type { JalaliDate } from "@/modules/shared-types";

/** مراحل رسیدگیِ دارای نرخ در دعاوی مالی (بند ۱۲ ماده ۳ قانون وصول برخی از درآمدهای دولت). */
export type CourtFeeStage =
  | "first-instance" // بدوی
  | "default-judgment-objection" // واخواهی
  | "appeal" // تجدیدنظر
  | "cassation" // فرجام‌خواهی
  | "retrial" // اعادهٔ دادرسی
  | "third-party-objection"; // اعتراض شخص ثالث

/** ترتیب نمایش مراحل (فقط ترتیب؛ نه عدد حقوقی). */
export const COURT_FEE_STAGE_ORDER: readonly CourtFeeStage[] = [
  "first-instance",
  "default-judgment-objection",
  "appeal",
  "cassation",
  "retrial",
  "third-party-objection",
];

/**
 * روش اعمال نرخ‌های پله‌ای وقتی بهای خواسته از آستانهٔ اول بیشتر است.
 * - `progressive`: هر بخش از مبلغ با نرخ پلهٔ خودش (تفکیک مبلغ).
 * - `whole-amount`: کل مبلغ با نرخ پله‌ای که مبلغ در آن می‌افتد.
 * متن قانون بودجه دربارهٔ این موضوع ساکت است؛ هیچ پیش‌فرض پنهانی وجود ندارد.
 */
export type TierMethod = "progressive" | "whole-amount";

/** قاعدهٔ گردکردن کسر ریال. منبع رسمی برای آن پیدا نشد؛ در فایل نرخ‌ها قابل تنظیم است. */
export type RoundingMode = "ceil" | "floor" | "nearest";

export type ReviewStatus = "pending-legal-review" | "legally-verified";

/**
 * یک پله. نرخ به «نقطهٔ مبنا» (basis point) است: ۱۰۰ = یک درصد.
 * `upToRials` سقف **شاملِ** پله (مثلاً «تا مبلغ …» یعنی خودِ آن مبلغ در همین پله است)؛
 * `null` یعنی بدون سقف (فقط برای آخرین پله).
 */
export type RateTier = Readonly<{ upToRials: number | null; rateBps: number }>;

type StageRuleBase = Readonly<{
  /** عنوان فارسی مرحله برای نمایش */
  label: string;
  /** مبنای محاسبه به زبان حقوقی (ارزش خواسته / محکوم‌به …) */
  basis: string;
  /** منبع این ردیف (ماده، جدول، بخشنامه) */
  source: string;
}>;

export type StageRule =
  | (StageRuleBase &
      Readonly<{
        kind: "own";
        tiers: readonly RateTier[];
        /** هزینهٔ ثابت وقتی بهای خواسته هنگام تقدیم دادخواست معلوم نیست؛ `null` = این حالت در این مرحله معنا ندارد */
        unknownValueFeeRials: number | null;
      }>)
  | (StageRuleBase & Readonly<{ kind: "same-as"; sameAs: CourtFeeStage }>);

export type CourtFeeTariff = Readonly<{
  /** سال جلالی (سال بودجه) */
  year: number;
  review: Readonly<{ status: ReviewStatus; reviewedBy: string | null; reviewedOn: string | null }>;
  /** منابعی که این جدول از آن‌ها گرفته شده */
  sources: readonly string[];
  rounding: RoundingMode;
  stages: Readonly<Record<CourtFeeStage, StageRule>>;
}>;

export type CourtFeeClaim = Readonly<{ kind: "known"; amountRials: number }> | Readonly<{ kind: "unknown" }>;

export type CourtFeeInput = Readonly<{
  /** تاریخ مبنا (جلالی): فقط برای انتخاب جدول همان سال استفاده می‌شود. */
  date: JalaliDate;
  stage: CourtFeeStage;
  claim: CourtFeeClaim;
  /** فقط وقتی لازم است که مبلغ از آستانهٔ اول بگذرد؛ وگرنه نادیده گرفته می‌شود. */
  tierMethod?: TierMethod;
}>;

export type CourtFeeStep = Readonly<{
  /** مرز پایین (انحصاری) بخش محاسبه‌شده */
  fromRials: number;
  /** مرز بالا (شامل)؛ `null` = بدون سقف */
  toRials: number | null;
  /** مبلغِ همین بخش */
  baseRials: number;
  rateBps: number;
}>;

export type CourtFeeResult = Readonly<{
  tariffYear: number;
  review: CourtFeeTariff["review"];
  stage: CourtFeeStage;
  stageLabel: string;
  basisLabel: string;
  /** `null` وقتی بهای خواسته نامعلوم است */
  baseAmountRials: number | null;
  feeRials: number;
  /** روش پله‌ای به‌کاررفته؛ `null` وقتی ابهامی در کار نبود */
  tierMethod: TierMethod | null;
  /** نتیجه با روش دیگر برای مقایسه؛ `null` وقتی ابهامی در کار نبود */
  alternativeFeeRials: number | null;
  rounding: RoundingMode;
  /** آیا کسر ریال گرد شد؟ */
  roundingApplied: boolean;
  steps: readonly CourtFeeStep[];
  sources: readonly string[];
  /** هشدارها و توضیح‌های فارسی که باید کنار نتیجه نمایش داده شوند */
  notes: readonly string[];
}>;
