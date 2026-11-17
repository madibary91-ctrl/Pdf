/**
 * محاسبهٔ هزینهٔ دادرسی دعاوی مالی — موتور خالص.
 *
 * قاعدهٔ طلایی این فایل: **هیچ عدد حقوقی اینجا نیست.** نرخ‌ها، آستانه‌ها، مبلغ ثابت و قاعدهٔ گردکردن
 * همه از `court-fee-tariffs.ts` خوانده می‌شوند (تست خودکار این را نگه می‌دارد).
 * فقط ثابت فنیِ تبدیل «نقطهٔ مبنا» به نسبت اینجاست.
 *
 * مبلغ‌ها همه «ریالِ عدد صحیح» هستند؛ پول هرگز اعشاری نیست. جمع صورت‌کسرها یک‌جا و فقط یک بار گرد می‌شود.
 */
import { validateJalaliDate } from "@/modules/jalali-date";
import { err, ok, type Result } from "@/modules/shared-types";
import { COURT_FEE_TARIFFS } from "./court-fee-tariffs";
import {
  COURT_FEE_STAGE_ORDER,
  type CourtFeeInput,
  type CourtFeeResult,
  type CourtFeeStage,
  type CourtFeeStep,
  type CourtFeeTariff,
  type RateTier,
  type RoundingMode,
  type StageRule,
  type TierMethod,
} from "./court-fee-types";

/** ثابت فنیِ واحد: نرخ‌ها به نقطهٔ مبنا (basis point) نوشته می‌شوند. */
const BPS_DENOMINATOR = 10000;

const ROUNDING_MODES: readonly RoundingMode[] = ["ceil", "floor", "nearest"];
const TIER_METHODS: readonly TierMethod[] = ["progressive", "whole-amount"];

const ROUNDING_LABEL: Readonly<Record<RoundingMode, string>> = {
  ceil: "گرد به بالا",
  floor: "گرد به پایین",
  nearest: "گرد به نزدیک‌ترین ریال",
};

type OwnRule = Extract<StageRule, { kind: "own" }>;

/** جدول سال مورد نظر؛ `undefined` اگر آن سال در فایل نرخ‌ها نباشد. هرگز جدول سال دیگر را جایگزین نمی‌کند. */
export function findCourtFeeTariff(
  year: number,
  tariffs: readonly CourtFeeTariff[] = COURT_FEE_TARIFFS,
): CourtFeeTariff | undefined {
  return tariffs.find((t) => t.year === year);
}

const isSafeNonNegative = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/**
 * بررسی یکپارچگی یک جدول نرخ. فهرست مشکل‌ها را برمی‌گرداند؛ خالی = سالم.
 * هم در تست و هم هنگام محاسبه اجرا می‌شود تا جدول ناقص/خراب نتیجهٔ بی‌صدا ندهد.
 */
export function validateCourtFeeTariff(t: CourtFeeTariff): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(t.year)) problems.push("سال جدول عدد صحیح نیست.");
  if (!ROUNDING_MODES.includes(t.rounding)) problems.push(`قاعدهٔ گردکردن نامعتبر: ${String(t.rounding)}`);
  if (t.review.status === "legally-verified" && (!t.review.reviewedBy || !t.review.reviewedOn)) {
    problems.push("جدول «تأییدشده» باید نام بازبین و تاریخ بازبینی داشته باشد.");
  }
  if (t.sources.length === 0) problems.push("جدول باید دست‌کم یک منبع داشته باشد.");

  for (const stage of COURT_FEE_STAGE_ORDER) {
    const rule = t.stages[stage];
    if (!rule) {
      problems.push(`مرحلهٔ ${stage} در جدول نیست.`);
      continue;
    }
    if (rule.kind === "same-as") {
      const target = t.stages[rule.sameAs];
      if (rule.sameAs === stage || !target || target.kind !== "own") {
        problems.push(`مرحلهٔ ${stage}: هدف «هم‌نرخ» باید مرحله‌ای دیگر با نرخ مستقل باشد.`);
      }
      continue;
    }
    if (rule.tiers.length === 0) problems.push(`مرحلهٔ ${stage}: بدون پله.`);
    let prev = 0;
    rule.tiers.forEach((tier, i) => {
      const last = i === rule.tiers.length - 1;
      if (!isSafeNonNegative(tier.rateBps)) problems.push(`مرحلهٔ ${stage}: نرخ پلهٔ ${i} عدد صحیح نامنفی نیست.`);
      if (last) {
        if (tier.upToRials !== null) problems.push(`مرحلهٔ ${stage}: آخرین پله باید بدون سقف (null) باشد.`);
      } else if (!isSafeNonNegative(tier.upToRials) || tier.upToRials <= prev) {
        problems.push(`مرحلهٔ ${stage}: سقف پلهٔ ${i} باید عدد صحیح و اکیداً صعودی باشد.`);
      } else {
        prev = tier.upToRials;
      }
    });
    if (rule.unknownValueFeeRials !== null && !isSafeNonNegative(rule.unknownValueFeeRials)) {
      problems.push(`مرحلهٔ ${stage}: هزینهٔ «بهای نامعلوم» عدد صحیح نامنفی نیست.`);
    }
  }
  return problems;
}

function resolveRule(t: CourtFeeTariff, stage: CourtFeeStage): { own: OwnRule; shown: StageRule } {
  const shown = t.stages[stage];
  const own = shown.kind === "same-as" ? t.stages[shown.sameAs] : shown;
  // validateCourtFeeTariff تضمین کرده own از نوع "own" است.
  return { own: own as OwnRule, shown };
}

/** بیشترین مبلغی که ضرب در بیشترین نرخ جدول هنوز عدد صحیحِ امن می‌ماند (حد فنی، نه حقوقی). */
function maxSafeAmount(tiers: readonly RateTier[]): number {
  const maxBps = Math.max(1, ...tiers.map((x) => x.rateBps));
  return Math.floor(Number.MAX_SAFE_INTEGER / maxBps);
}

type Tally = Readonly<{ numerator: number; steps: readonly CourtFeeStep[] }>;

function tallyProgressive(amount: number, tiers: readonly RateTier[]): Tally {
  const steps: CourtFeeStep[] = [];
  let numerator = 0;
  let lower = 0;
  for (const tier of tiers) {
    const top = tier.upToRials === null ? amount : Math.min(amount, tier.upToRials);
    const part = top - lower;
    if (part > 0) {
      steps.push({ fromRials: lower, toRials: tier.upToRials, baseRials: part, rateBps: tier.rateBps });
      numerator += part * tier.rateBps;
    }
    if (tier.upToRials === null || amount <= tier.upToRials) break;
    lower = tier.upToRials;
  }
  return { numerator, steps };
}

function tallyWholeAmount(amount: number, tiers: readonly RateTier[]): Tally {
  const tier = tiers.find((x) => x.upToRials === null || amount <= x.upToRials) ?? tiers[tiers.length - 1]!;
  return {
    numerator: amount * tier.rateBps,
    steps: [{ fromRials: 0, toRials: tier.upToRials, baseRials: amount, rateBps: tier.rateBps }],
  };
}

/** گرد کردن صورت‌کسر/مخرج؛ فقط با حساب عدد صحیح. */
function roundFraction(numerator: number, mode: RoundingMode): { value: number; applied: boolean } {
  const whole = Math.floor(numerator / BPS_DENOMINATOR);
  const rest = numerator % BPS_DENOMINATOR;
  if (rest === 0) return { value: whole, applied: false };
  if (mode === "ceil") return { value: whole + 1, applied: true };
  if (mode === "floor") return { value: whole, applied: true };
  return { value: rest * 2 >= BPS_DENOMINATOR ? whole + 1 : whole, applied: true };
}

/**
 * محاسبهٔ هزینهٔ دادرسی دعوای مالی.
 *
 * @param tariffs جدول‌های نرخ؛ پیش‌فرض همان فایل `court-fee-tariffs.ts`. (تزریق‌پذیر برای تست)
 *
 * رفتارهای مهم (بدون فرض پنهان):
 * - جدول سالِ `input.date` انتخاب می‌شود؛ اگر سال در جدول نبود خطا می‌دهد، نه جدول سال دیگر.
 * - اگر مبلغ از آستانهٔ اول بگذرد، `tierMethod` الزامی است؛ نتیجه با روش دیگر هم برگردانده می‌شود.
 * - نتیجه همیشه وضعیت بازبینی حقوقدان را در `review` و `notes` دارد.
 */
export function calculateCourtFee(
  input: CourtFeeInput,
  tariffs: readonly CourtFeeTariff[] = COURT_FEE_TARIFFS,
): Result<CourtFeeResult> {
  const date = validateJalaliDate(input.date);
  if (!date.ok) return date;

  const tariff = findCourtFeeTariff(date.value.year, tariffs);
  if (!tariff) {
    return err(
      "OUT_OF_RANGE",
      `جدول هزینهٔ دادرسی برای سال ${date.value.year} در فایل نرخ‌ها ثبت نشده است. جدول سال دیگری جایگزین نمی‌شود؛ ابتدا ورودی آن سال را به court-fee-tariffs.ts اضافه و حقوقدان تأیید کند.`,
    );
  }
  const problems = validateCourtFeeTariff(tariff);
  if (problems.length > 0) {
    return err("INVALID_INPUT", `جدول نرخ سال ${tariff.year} ناقص یا نامعتبر است: ${problems[0]}`);
  }

  if (!COURT_FEE_STAGE_ORDER.includes(input.stage)) {
    return err("INVALID_INPUT", "مرحلهٔ رسیدگی ناشناخته است.");
  }
  if (input.tierMethod !== undefined && !TIER_METHODS.includes(input.tierMethod)) {
    return err("INVALID_INPUT", "روش اعمال نرخ پله‌ای ناشناخته است.");
  }

  const { own, shown } = resolveRule(tariff, input.stage);
  const notes: string[] = [];
  if (tariff.review.status !== "legally-verified") {
    notes.push(
      `نرخ‌های جدول سال ${tariff.year} هنوز توسط حقوقدان تأیید نشده‌اند؛ این مبلغ فقط برآورد اولیه است و پیش از اتکا باید با متن رسمی و حقوقدان سنجیده شود.`,
    );
  }
  if (shown.kind === "same-as") notes.push(`نرخ این مرحله از «${shown.source}» گرفته شده است.`);

  const common = {
    tariffYear: tariff.year,
    review: tariff.review,
    stage: input.stage,
    stageLabel: shown.label,
    basisLabel: shown.basis,
    rounding: tariff.rounding,
    sources: tariff.sources,
  } as const;

  // ── بهای خواسته نامعلوم ──
  if (input.claim.kind === "unknown") {
    if (own.unknownValueFeeRials === null) {
      return err(
        "INVALID_INPUT",
        `در مرحلهٔ «${shown.label}» حالت «بهای خواسته نامعلوم» در جدول نرخ تعریف نشده؛ بهای خواسته (یا محکوم‌به) باید معلوم باشد.`,
      );
    }
    notes.push("هزینهٔ ثابتِ حالت «بهای خواسته هنگام تقدیم دادخواست نامعلوم است» اعمال شد.");
    return ok({
      ...common,
      baseAmountRials: null,
      feeRials: own.unknownValueFeeRials,
      tierMethod: null,
      alternativeFeeRials: null,
      roundingApplied: false,
      steps: [],
      notes,
    });
  }

  // ── بهای خواسته معلوم ──
  const amount = input.claim.amountRials;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 1) {
    return err("INVALID_INPUT", "مبلغ باید عدد صحیحِ مثبت (ریال) باشد.");
  }
  const limit = maxSafeAmount(own.tiers);
  if (amount > limit) {
    return err("OUT_OF_RANGE", `مبلغ از حد پشتیبانی‌شده (${limit} ریال) بیشتر است.`);
  }

  const first = own.tiers[0]!;
  const ambiguous = own.tiers.length > 1 && first.upToRials !== null && amount > first.upToRials;

  if (!ambiguous) {
    const t = tallyProgressive(amount, own.tiers);
    const r = roundFraction(t.numerator, tariff.rounding);
    if (r.applied) notes.push(`کسر ریال با قاعدهٔ «${ROUNDING_LABEL[tariff.rounding]}» گرد شد؛ برای این قاعده منبع رسمی پیدا نشد.`);
    return ok({
      ...common,
      baseAmountRials: amount,
      feeRials: r.value,
      tierMethod: null,
      alternativeFeeRials: null,
      roundingApplied: r.applied,
      steps: t.steps,
      notes,
    });
  }

  if (input.tierMethod === undefined) {
    return err(
      "INVALID_INPUT",
      "مبلغ از آستانهٔ پلهٔ اول بیشتر است و متن قانون بودجه روشن نمی‌کند نرخ پلهٔ بالاتر روی کل مبلغ اعمال شود یا فقط روی مازاد. روش محاسبه را صریحاً انتخاب کنید.",
    );
  }
  const chosen: TierMethod = input.tierMethod;
  const other: TierMethod = chosen === "progressive" ? "whole-amount" : "progressive";
  const tally = (m: TierMethod) => (m === "progressive" ? tallyProgressive(amount, own.tiers) : tallyWholeAmount(amount, own.tiers));
  const main = tally(chosen);
  const mainFee = roundFraction(main.numerator, tariff.rounding);
  const altFee = roundFraction(tally(other).numerator, tariff.rounding);
  notes.push(
    "قانون بودجه دربارهٔ نحوهٔ اعمال نرخ پلهٔ بالاتر (کل مبلغ یا فقط مازاد بر آستانه) ساکت است؛ نتیجه با روش دیگر هم در خروجی آمده است. تعیین روش درست با حقوقدان است.",
  );
  if (mainFee.applied) notes.push(`کسر ریال با قاعدهٔ «${ROUNDING_LABEL[tariff.rounding]}» گرد شد؛ برای این قاعده منبع رسمی پیدا نشد.`);

  return ok({
    ...common,
    baseAmountRials: amount,
    feeRials: mainFee.value,
    tierMethod: chosen,
    alternativeFeeRials: altFee.value,
    roundingApplied: mainFee.applied,
    steps: main.steps,
    notes,
  });
}
