/**
 * محاسبهٔ خسارت تأخیر تأدیه (ماده ۵۲۲ ق.آ.د.م) — موتور خالص.
 *
 * فرمول (رأی وحدت رویهٔ ۸۵۰؛ منبع و وضعیت بازبینی در `late-payment-indices.ts`):
 *   دین با احتساب خسارت = اصل دین × (شاخص تأدیه ÷ شاخص سررسید)،  خسارت = آن − اصل دین
 * یک بار و بدون سود مرکب.
 *
 * قاعدهٔ طلایی (مثل court-fee.ts): **هیچ عدد حقوقی اینجا نیست.** گردکردن، سیاست کاهش شاخص و سری‌های شاخص
 * از فایل داده می‌آیند. فقط ثابت‌های فنی (۰، ۱، ۲، مخرج نقطهٔ مبنا) و حدود فنیِ قالب ورودی (در رشتهٔ regex) اینجاست.
 *
 * حساب: همهٔ کار با BigInt و عدد صحیح؛ شاخص‌های اعشاری به‌صورت «رقم‌ها + تعداد رقم اعشار» نگه داشته می‌شوند،
 * پس هیچ‌جا Float در محاسبهٔ پول نیست. تنها یک گردکردن، روی مبلغ نهایی.
 */
import { compareJalaliDates, validateJalaliDate } from "@/modules/jalali-date";
import { err, ok, type JalaliDate, type Result } from "@/modules/shared-types";
import type { RoundingMode } from "./court-fee-types";
import { LATE_PAYMENT_INDEX_SERIES, LATE_PAYMENT_RULES } from "./late-payment-indices";
import type {
  IndexGranularity,
  IndexPoint,
  IndexSeries,
  LatePaymentBatchItem,
  LatePaymentBatchResult,
  LatePaymentInput,
  LatePaymentResult,
  LatePaymentRules,
  ReviewInfo,
} from "./late-payment-types";

/** ثابت فنیِ واحد: تغییر شاخص برای نمایش به نقطهٔ مبنا. */
const BPS_DENOMINATOR = 10000;

const ROUNDING_MODES: readonly RoundingMode[] = ["ceil", "floor", "nearest"];
const GRANULARITIES: readonly IndexGranularity[] = ["monthly", "annual"];
const DECREASE_POLICIES: readonly LatePaymentRules["onIndexDecrease"][] = ["zero-damages", "error"];

/**
 * قالب مقدار شاخص: رقم لاتین، نقطهٔ اعشاری اختیاری. حدود تعداد رقم فقط **فنی** است (جلوگیری از ورودی‌های عظیم)، نه حقوقی.
 * با `new RegExp(string)` ساخته می‌شود (known-pitfalls: target=ES2017).
 */
const INDEX_VALUE_RE = new RegExp("^\\d{1,15}(\\.\\d{1,9})?$");
const MONTH_KEY_RE = new RegExp("^\\d{4}-(0[1-9]|1[0-2])$");
const YEAR_KEY_RE = new RegExp("^\\d{4}$");

const ROUNDING_LABEL: Readonly<Record<RoundingMode, string>> = {
  ceil: "گرد به بالا",
  floor: "گرد به پایین",
  nearest: "گرد به نزدیک‌ترین ریال",
};

type Decimal = Readonly<{ digits: bigint; scale: number; text: string }>;

function parseDecimal(value: unknown, what: string): Result<Decimal> {
  if (typeof value !== "string") return err("INVALID_INPUT", `${what} باید به‌صورت متن عددی داده شود.`);
  const text = value.trim();
  if (!INDEX_VALUE_RE.test(text)) {
    return err(
      "PARSE_ERROR",
      `${what} باید عدد اعشاریِ مثبت با ارقام لاتین و نقطهٔ اعشار باشد (مثل 1174.5)؛ ویرگول، علامت و نماد علمی پذیرفته نمی‌شود.`,
    );
  }
  const parts = text.split(".");
  const whole = parts[0] ?? "";
  const fraction = parts[1] ?? "";
  const digits = BigInt(whole + fraction);
  if (digits === BigInt(0)) return err("INVALID_INPUT", `${what} باید بزرگ‌تر از صفر باشد.`);
  return ok({ digits, scale: fraction.length, text: fraction === "" ? whole : `${whole}.${fraction}` });
}

const pow10 = (n: number): bigint => BigInt("1" + "0".repeat(n));

/** کلید سری برای یک تاریخ: «YYYY-MM» (ماهانه) یا «YYYY» (سالانه). */
export function indexKeyFor(granularity: IndexGranularity, date: JalaliDate): string {
  return granularity === "monthly" ? `${date.year}-${String(date.month).padStart(2, "0")}` : String(date.year);
}

/**
 * بررسی یکپارچگی یک سری شاخص. فهرست مشکل‌ها را برمی‌گرداند؛ خالی = سالم.
 * هم در تست و هم هنگام محاسبه اجرا می‌شود تا سری ناقص/خراب نتیجهٔ بی‌صدا ندهد.
 */
export function validateIndexSeries(s: IndexSeries): string[] {
  const problems: string[] = [];
  if (typeof s.id !== "string" || s.id.trim() === "") problems.push("شناسهٔ سری خالی است.");
  if (!GRANULARITIES.includes(s.granularity)) problems.push(`ریزدانگی نامعتبر: ${String(s.granularity)}`);
  if (s.review.status === "legally-verified" && (!s.review.reviewedBy || !s.review.reviewedOn)) {
    problems.push("سری «تأییدشده» باید نام بازبین و تاریخ بازبینی داشته باشد.");
  }
  if (s.sources.length === 0) problems.push("سری باید دست‌کم یک منبع داشته باشد.");
  if (typeof s.baseNote !== "string" || s.baseNote.trim() === "") problems.push("پایهٔ سری (baseNote) مشخص نشده است.");
  const keys = Object.keys(s.values);
  if (keys.length === 0) problems.push("سری بدون مقدار است.");
  const keyRe = s.granularity === "monthly" ? MONTH_KEY_RE : YEAR_KEY_RE;
  for (const key of keys) {
    if (!keyRe.test(key)) {
      problems.push(`کلید «${key}» با ریزدانگی ${String(s.granularity)} سازگار نیست.`);
      continue;
    }
    const parsed = parseDecimal(s.values[key], `مقدار ${key}`);
    if (!parsed.ok) problems.push(parsed.error.message);
  }
  return problems;
}

/** بررسی یکپارچگی قاعده‌های عمومی. خالی = سالم. */
export function validateLatePaymentRules(r: LatePaymentRules): string[] {
  const problems: string[] = [];
  if (!ROUNDING_MODES.includes(r.rounding)) problems.push(`قاعدهٔ گردکردن نامعتبر: ${String(r.rounding)}`);
  if (!DECREASE_POLICIES.includes(r.onIndexDecrease)) problems.push(`سیاست کاهش شاخص نامعتبر: ${String(r.onIndexDecrease)}`);
  if (r.review.status === "legally-verified" && (!r.review.reviewedBy || !r.review.reviewedOn)) {
    problems.push("قاعده‌های «تأییدشده» باید نام بازبین و تاریخ بازبینی داشته باشند.");
  }
  if (r.sources.length === 0) problems.push("قاعده‌ها باید دست‌کم یک منبع داشته باشند.");
  return problems;
}

/** سری با شناسهٔ مورد نظر؛ `undefined` اگر نباشد. هرگز سری دیگری جایگزین نمی‌شود. */
export function findIndexSeries(
  id: string,
  series: readonly IndexSeries[] = LATE_PAYMENT_INDEX_SERIES,
): IndexSeries | undefined {
  return series.find((s) => s.id === id);
}

/** بازبینی ترکیبی: فقط وقتی هر دو «تأییدشده» باشند تأییدشده است. */
function combineReview(a: ReviewInfo, b: ReviewInfo): ReviewInfo {
  if (a.status === "legally-verified" && b.status === "legally-verified") return b;
  return { status: "pending-legal-review", reviewedBy: null, reviewedOn: null };
}

/** تقسیم عدد صحیحِ نامنفی با قاعدهٔ گردکردن؛ فقط BigInt. */
function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): { value: bigint; applied: boolean } {
  const whole = numerator / denominator;
  const rest = numerator % denominator;
  if (rest === BigInt(0)) return { value: whole, applied: false };
  if (mode === "ceil") return { value: whole + BigInt(1), applied: true };
  if (mode === "floor") return { value: whole, applied: true };
  return { value: rest * BigInt(2) >= denominator ? whole + BigInt(1) : whole, applied: true };
}

type ResolvedIndices = Readonly<{
  base: Decimal;
  payment: Decimal;
  baseLabel: string;
  paymentLabel: string;
  seriesId: string | null;
  granularity: IndexGranularity | null;
  review: ReviewInfo;
  sources: readonly string[];
  notes: readonly string[];
}>;

function resolveManual(input: Extract<LatePaymentInput["index"], { mode: "manual" }>, rules: LatePaymentRules): Result<ResolvedIndices> {
  const base = parseDecimal(input.baseIndex, "شاخص زمان سررسید");
  if (!base.ok) return base;
  const payment = parseDecimal(input.paymentIndex, "شاخص زمان تأدیه");
  if (!payment.ok) return payment;
  return ok({
    base: base.value,
    payment: payment.value,
    baseLabel: input.baseLabel?.trim() || "شاخص سررسید",
    paymentLabel: input.paymentLabel?.trim() || "شاخص تأدیه",
    seriesId: null,
    granularity: null,
    review: rules.review,
    sources: rules.sources,
    notes: [
      "شاخص‌ها را خودتان وارد کرده‌اید و موتور نمی‌تواند درستی آن‌ها را بسنجد: باید از جدول رسمی «شاخص تأخیر تأدیه» بانک مرکزی، برای ماه (یا دورهٔ) سررسید و ماه (یا دورهٔ) تأدیه، و با یک سال پایه خوانده شوند.",
    ],
  });
}

function resolveSeries(
  input: Extract<LatePaymentInput["index"], { mode: "series" }>,
  seriesList: readonly IndexSeries[],
  rules: LatePaymentRules,
): Result<ResolvedIndices> {
  const series = typeof input.seriesId === "string" ? findIndexSeries(input.seriesId, seriesList) : undefined;
  if (!series) {
    return err(
      "INVALID_INPUT",
      `سری شاخصی با شناسهٔ «${String(input.seriesId)}» در فایل داده ثبت نشده است. سری دیگری جایگزین نمی‌شود؛ یا سری را به late-payment-indices.ts اضافه کنید یا شاخص‌ها را دستی وارد کنید.`,
    );
  }
  const problems = validateIndexSeries(series);
  if (problems.length > 0) return err("INVALID_INPUT", `سری شاخص «${series.id}» ناقص یا نامعتبر است: ${problems[0]}`);

  const due = validateJalaliDate(input.dueDate);
  if (!due.ok) return err(due.error.code, `تاریخ سررسید: ${due.error.message}`);
  const paid = validateJalaliDate(input.paymentDate);
  if (!paid.ok) return err(paid.error.code, `تاریخ تأدیه: ${paid.error.message}`);
  if (compareJalaliDates(paid.value, due.value) < 0) {
    return err("INVALID_INPUT", "تاریخ تأدیه نمی‌تواند پیش از تاریخ سررسید باشد.");
  }

  const baseKey = indexKeyFor(series.granularity, due.value);
  const paymentKey = indexKeyFor(series.granularity, paid.value);
  const lookup = (key: string, what: string): Result<Decimal> => {
    if (!Object.prototype.hasOwnProperty.call(series.values, key)) {
      return err(
        "OUT_OF_RANGE",
        `در سری «${series.id}» شاخصِ ${what} (${key}) ثبت نشده است. ماه یا سال دیگری جایگزین نمی‌شود؛ ابتدا مقدار را از جدول رسمی به فایل داده اضافه کنید.`,
      );
    }
    return parseDecimal(series.values[key], `شاخص ${key}`);
  };
  const base = lookup(baseKey, "سررسید");
  if (!base.ok) return base;
  const payment = lookup(paymentKey, "تأدیه");
  if (!payment.ok) return payment;

  const notes: string[] = [];
  if (baseKey === paymentKey) {
    notes.push(`سررسید و تأدیه در یک دوره (${baseKey}) قرار دارند؛ دو شاخص برابرند و خسارت صفر است.`);
  }
  return ok({
    base: base.value,
    payment: payment.value,
    baseLabel: baseKey,
    paymentLabel: paymentKey,
    seriesId: series.id,
    granularity: series.granularity,
    review: combineReview(series.review, rules.review),
    sources: [...series.sources, ...rules.sources],
    notes,
  });
}

/**
 * محاسبهٔ خسارت تأخیر تأدیه.
 *
 * @param seriesList سری‌های شاخص؛ پیش‌فرض همان فایل داده. (تزریق‌پذیر برای تست)
 * @param rules قاعده‌های عمومی؛ پیش‌فرض همان فایل داده. (تزریق‌پذیر برای تست)
 *
 * رفتارهای مهم (بدون فرض پنهان):
 * - حالت `manual`: دو شاخص را فراخواننده می‌دهد؛ موتور فقط ریاضیات را انجام می‌دهد.
 * - حالت `series`: سری با شناسهٔ صریح؛ ماه/سالِ غایب = خطا (نه نزدیک‌ترین).
 * - کاهش شاخص: طبق `rules.onIndexDecrease` (فعلاً خسارت صفر، هرگز منفی).
 * - شرایط ماده ۵۲۲ (دین پولی، مطالبه، تمکن، تغییر فاحش) را موتور نمی‌سنجد؛ در `notes` یادآوری می‌شود.
 */
export function calculateLatePayment(
  input: LatePaymentInput,
  seriesList: readonly IndexSeries[] = LATE_PAYMENT_INDEX_SERIES,
  rules: LatePaymentRules = LATE_PAYMENT_RULES,
): Result<LatePaymentResult> {
  const ruleProblems = validateLatePaymentRules(rules);
  if (ruleProblems.length > 0) return err("INVALID_INPUT", `قاعده‌های محاسبهٔ تأخیر تأدیه ناقص یا نامعتبرند: ${ruleProblems[0]}`);

  const principal = input.principalRials;
  if (typeof principal !== "number" || !Number.isSafeInteger(principal) || principal < 1) {
    return err("INVALID_INPUT", "اصل دین باید عدد صحیحِ مثبت (ریال) باشد.");
  }
  if (typeof input.index !== "object" || input.index === null) return err("INVALID_INPUT", "منبع شاخص مشخص نشده است.");

  let resolved: Result<ResolvedIndices>;
  if (input.index.mode === "manual") resolved = resolveManual(input.index, rules);
  else if (input.index.mode === "series") resolved = resolveSeries(input.index, seriesList, rules);
  else return err("INVALID_INPUT", "حالت منبع شاخص ناشناخته است.");
  if (!resolved.ok) return resolved;
  const r = resolved.value;

  // هم‌مقیاس کردن دو شاخص اعشاری با ضرب در توان ده (عدد صحیح)
  const scale = Math.max(r.base.scale, r.payment.scale);
  const b = r.base.digits * pow10(scale - r.base.scale);
  const p = r.payment.digits * pow10(scale - r.payment.scale);
  const changeBps = Number(((p - b) * BigInt(BPS_DENOMINATOR)) / b);
  const decreased = p < b;

  const notes: string[] = [];
  if (r.review.status !== "legally-verified") {
    notes.push(
      "قاعده‌ها و (در صورت استفاده) سری شاخص هنوز توسط حقوقدان تأیید نشده‌اند؛ این مبلغ فقط برآورد اولیه است و پیش از اتکا باید با حقوقدان و جدول رسمی سنجیده شود.",
    );
  }
  notes.push(...r.notes);
  notes.push(
    "خسارت یک‌بار از نسبت دو شاخص به دست می‌آید (بدون سود مرکب). شرایط ماده ۵۲۲ — دین پولی، مطالبهٔ طلبکار، تمکن و امتناع مدیون، تغییر فاحش شاخص — را موتور نمی‌سنجد و بر عهدهٔ حقوقدان است.",
  );

  let total: bigint;
  let roundingApplied = false;
  if (decreased && rules.onIndexDecrease === "error") {
    return err("INVALID_INPUT", "شاخص زمان تأدیه از شاخص سررسید کمتر است و طبق قاعده‌های فعلی این حالت خطاست.");
  }
  if (p <= b) {
    // بدون افزایش شاخص: خسارتی نیست (و هرگز منفی نمی‌شود)
    total = BigInt(principal);
    if (decreased) notes.push("شاخص تأدیه از شاخص سررسید کمتر است؛ طبق قاعده‌های فعلی خسارت صفر در نظر گرفته شد (منفی نمی‌شود).");
  } else {
    const q = divideRounded(BigInt(principal) * p, b, rules.rounding);
    total = q.value;
    roundingApplied = q.applied;
    if (q.applied) {
      notes.push(`کسر ریال با قاعدهٔ «${ROUNDING_LABEL[rules.rounding]}» گرد شد؛ برای این قاعده منبع رسمی پیدا نشد.`);
    }
  }

  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    return err("OUT_OF_RANGE", "نتیجه از حد عدد صحیحِ امن بیشتر است؛ مبلغ را کوچک‌تر کنید.");
  }
  const totalRials = Number(total);
  const baseIndex: IndexPoint = { label: r.baseLabel, value: r.base.text };
  const paymentIndex: IndexPoint = { label: r.paymentLabel, value: r.payment.text };

  return ok({
    mode: input.index.mode,
    seriesId: r.seriesId,
    granularity: r.granularity,
    principalRials: principal,
    damagesRials: totalRials - principal,
    totalRials,
    baseIndex,
    paymentIndex,
    changeBps,
    indexDecreased: decreased,
    rounding: rules.rounding,
    roundingApplied,
    review: r.review,
    sources: r.sources,
    notes,
  });
}

/**
 * جمع خسارت چند دین مستقل (مثلاً چند چک یا قسط با سررسیدهای مختلف).
 * هر ردیف جداگانه محاسبه و جمع می‌شود. اولین خطا با شمارهٔ ردیف برگردانده می‌شود.
 * ⚠️ پرداخت‌های جزئی/تهاتر (اول خسارت یا اصل؟) پشتیبانی نمی‌شود — مسئلهٔ حقوقی باز است.
 */
export function calculateLatePaymentBatch(
  items: readonly LatePaymentBatchItem[],
  seriesList: readonly IndexSeries[] = LATE_PAYMENT_INDEX_SERIES,
  rules: LatePaymentRules = LATE_PAYMENT_RULES,
): Result<LatePaymentBatchResult> {
  if (!Array.isArray(items) || items.length === 0) return err("INVALID_INPUT", "دست‌کم یک ردیف دین لازم است.");

  const results: LatePaymentResult[] = [];
  let principal = BigInt(0);
  let damages = BigInt(0);
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const r = calculateLatePayment(item.input, seriesList, rules);
    if (!r.ok) {
      const name = item.label?.trim() ? ` («${item.label.trim()}»)` : "";
      return err(r.error.code, `ردیف ${i + 1}${name}: ${r.error.message}`);
    }
    results.push(r.value);
    principal += BigInt(r.value.principalRials);
    damages += BigInt(r.value.damagesRials);
  }
  if (principal + damages > BigInt(Number.MAX_SAFE_INTEGER)) {
    return err("OUT_OF_RANGE", "جمع مبلغ‌ها از حد عدد صحیحِ امن بیشتر است.");
  }
  const anyPending = results.some((x) => x.review.status !== "legally-verified");
  const review: ReviewInfo = anyPending
    ? { status: "pending-legal-review", reviewedBy: null, reviewedOn: null }
    : results[0]!.review;
  return ok({
    items: results,
    totalPrincipalRials: Number(principal),
    totalDamagesRials: Number(damages),
    totalRials: Number(principal + damages),
    review,
    notes: Array.from(new Set(results.flatMap((x) => x.notes))),
  });
}
