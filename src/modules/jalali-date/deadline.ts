import { err, ok, type JalaliDate, type Result } from "@/modules/shared-types";
import { addDays, addMonths, isFriday } from "./calendar";
import { formatJalaliDate } from "./format";

export type DeadlineUnit = "day" | "month" | "year";

export type DeadlineInput = Readonly<{
  /** مبدأ مهلت، مثلاً تاریخ ابلاغ */
  start: JalaliDate;
  amount: number;
  unit: DeadlineUnit;
  /** آیا خودِ روز مبدأ جزو مهلت شمرده شود؟ پیش‌فرض: خیر */
  countStartDay?: boolean;
  /** اگر آخرین روز مهلت غیرکاری بود، به نخستین روز کاریِ بعد منتقل شود. پیش‌فرض: خیر */
  rollOverNonWorkingDay?: boolean;
  /**
   * تشخیص روز غیرکاری. پیش‌فرض: فقط جمعه.
   * تعطیلات رسمی داده‌ای نسخه‌دار است و باید از بیرون تزریق شود (این ماژول جدول تعطیلات ندارد).
   */
  isNonWorkingDay?: (d: JalaliDate) => boolean;
}>;

export type DeadlineResult = Readonly<{
  /** تاریخ نهایی پس از اعمال گزینه‌ها */
  due: JalaliDate;
  /** تاریخ پیش از انتقال به روز کاری */
  rawDue: JalaliDate;
  rolledOver: boolean;
  /** شرح گام‌های محاسبه برای نمایش به کاربر (شفافیت محاسبات حقوقی) */
  steps: readonly string[];
}>;

const MAX_AMOUNT = 36500;
const MAX_ROLL_STEPS = 31;

const UNIT_FA: Record<DeadlineUnit, string> = { day: "روز", month: "ماه", year: "سال" };

function show(d: JalaliDate): string {
  const r = formatJalaliDate(d, { style: "full" });
  return r.ok ? r.value : "؟";
}

/**
 * محاسبهٔ مهلت (روزی/ماهی/سالی) با قواعد صریح و قابل‌تنظیم.
 *
 * ⚠ ناحیهٔ پرریسک: اینکه در هر مورد قانونی روز ابلاغ شمرده شود یا انتقال به روز کاری
 * اعمال شود، تصمیم حقوقی است. این تابع هیچ فرضی را «قانون» نمی‌داند؛
 * فقط همان گزینه‌هایی را که صدا زننده می‌دهد دقیق اجرا می‌کند. تأیید با حقوقدان مالک کیفیت.
 */
export function computeDeadline(input: DeadlineInput): Result<DeadlineResult> {
  const { start, amount, unit, countStartDay = false, rollOverNonWorkingDay = false } = input;
  const isOff = input.isNonWorkingDay ?? isFriday;

  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT) {
    return err("INVALID_INPUT", `مقدار مهلت باید عدد صحیح بین ۱ تا ${MAX_AMOUNT} باشد.`);
  }
  if (unit !== "day" && unit !== "month" && unit !== "year") {
    return err("INVALID_INPUT", "واحد مهلت باید روز، ماه یا سال باشد.");
  }

  const steps: string[] = [`مبدأ: ${show(start)}`];
  steps.push(`مدت: ${amount} ${UNIT_FA[unit]}${countStartDay ? " (روز مبدأ جزو مهلت)" : " (روز مبدأ شمرده نمی‌شود)"}`);

  let raw;
  if (unit === "day") {
    raw = addDays(start, countStartDay ? amount - 1 : amount);
  } else {
    raw = addMonths(start, unit === "month" ? amount : amount * 12, "clamp");
    if (raw.ok && countStartDay) raw = addDays(raw.value, -1);
  }
  if (!raw.ok) return raw;
  steps.push(`پایان مهلت: ${show(raw.value)}`);

  let due = raw.value;
  let rolledOver = false;
  if (rollOverNonWorkingDay) {
    let guard = 0;
    while (isOff(due)) {
      if (guard >= MAX_ROLL_STEPS) return err("INVALID_INPUT", "تابع روز غیرکاری همهٔ روزها را غیرکاری برمی‌گرداند.");
      const next = addDays(due, 1);
      if (!next.ok) return next;
      steps.push(`${show(due)} غیرکاری است ← انتقال به روز بعد`);
      due = next.value;
      rolledOver = true;
      guard += 1;
    }
    if (rolledOver) steps.push(`مهلت نهایی: ${show(due)}`);
  }

  return ok({ due, rawDue: raw.value, rolledOver, steps });
}
