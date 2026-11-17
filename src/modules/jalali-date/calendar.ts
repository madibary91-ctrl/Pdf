import { err, ok, type GregorianDate, type JalaliDate, type Result } from "@/modules/shared-types";

/**
 * هستهٔ تقویم جلالی — کاملاً خالص (بدون I/O و بدون ساعت سیستم).
 *
 * الگوریتم: جدول «breaks» (همان روش پذیرفته‌شدهٔ jalaali) برای یافتن روز اول فروردین
 * هر سال؛ طول سال از فاصلهٔ دو نوروز پیاپی به‌دست می‌آید، نه از فرمول جدا،
 * تا تبدیل رفت‌وبرگشت همیشه سازگار بماند.
 * دامنهٔ پشتیبانی‌شده: سال‌های ۱۲۰۰ تا ۱۶۰۰ جلالی (حدود ۱۸۲۱ تا ۲۲۲۱ میلادی).
 */

export const MIN_JALALI_YEAR = 1200;
export const MAX_JALALI_YEAR = 1600;

const BREAKS = [
  -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192, 2262, 2324, 2394, 2456, 3178,
] as const;

const div = (a: number, b: number): number => Math.trunc(a / b);
const mod = (a: number, b: number): number => a - Math.trunc(a / b) * b;

/** روز ماهِ مارس که اول فروردینِ سال جلالی در آن می‌افتد. */
function newYearMarchDay(jy: number): number {
  const gy = jy + 621;
  let leapJ = -14;
  let jp: number = BREAKS[0];
  let jump = 0;
  for (let i = 1; i < BREAKS.length; i += 1) {
    const jm = BREAKS[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ += div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  const n = jy - jp;
  leapJ += div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;
  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  return 20 + leapJ - leapG;
}

/** شمارهٔ روز از ۱۹۷۰-۰۱-۰۱ میلادی (روز صفر = پنجشنبه). */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(epochDay: number): GregorianDate {
  const z = epochDay + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

function newYearEpochDay(jy: number): number {
  return daysFromCivil(jy + 621, 3, newYearMarchDay(jy));
}

function leapUnchecked(jy: number): boolean {
  return newYearEpochDay(jy + 1) - newYearEpochDay(jy) === 366;
}

function monthLengthUnchecked(jy: number, jm: number): number {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return leapUnchecked(jy) ? 30 : 29;
}

function toEpochUnchecked(d: JalaliDate): number {
  const dayOfYear = d.month <= 6 ? (d.month - 1) * 31 + d.day : 186 + (d.month - 7) * 30 + d.day;
  return newYearEpochDay(d.year) + dayOfYear - 1;
}

function fromEpochUnchecked(epochDay: number): JalaliDate {
  const gy = civilFromDays(epochDay).year;
  let jy = gy - 621;
  if (epochDay < newYearEpochDay(jy)) jy -= 1;
  const k = epochDay - newYearEpochDay(jy);
  if (k < 186) return { year: jy, month: div(k, 31) + 1, day: mod(k, 31) + 1 };
  const k2 = k - 186;
  return { year: jy, month: 7 + div(k2, 30), day: mod(k2, 30) + 1 };
}

const MIN_EPOCH_DAY = newYearEpochDay(MIN_JALALI_YEAR);
const MAX_EPOCH_DAY = newYearEpochDay(MAX_JALALI_YEAR + 1) - 1;

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

function checkYear(year: unknown): Result<number> {
  if (!isInt(year)) return err("INVALID_INPUT", "سال باید عدد صحیح باشد.");
  if (year < MIN_JALALI_YEAR || year > MAX_JALALI_YEAR) {
    return err("OUT_OF_RANGE", `سال جلالی باید بین ${MIN_JALALI_YEAR} و ${MAX_JALALI_YEAR} باشد.`);
  }
  return ok(year);
}

/** آیا سال جلالی کبیسه است (اسفند ۳۰ روز)؟ */
export function isJalaliLeapYear(year: number): Result<boolean> {
  const y = checkYear(year);
  if (!y.ok) return y;
  return ok(leapUnchecked(year));
}

export function jalaliMonthLength(year: number, month: number): Result<number> {
  const y = checkYear(year);
  if (!y.ok) return y;
  if (!isInt(month) || month < 1 || month > 12) return err("INVALID_DATE", "ماه باید عددی بین ۱ تا ۱۲ باشد.");
  return ok(monthLengthUnchecked(year, month));
}

export function validateJalaliDate(d: JalaliDate): Result<JalaliDate> {
  if (typeof d !== "object" || d === null) return err("INVALID_INPUT", "تاریخ نامعتبر است.");
  const len = jalaliMonthLength(d.year, d.month);
  if (!len.ok) return len;
  if (!isInt(d.day) || d.day < 1 || d.day > len.value) {
    return err("INVALID_DATE", `روز باید بین ۱ تا ${len.value} باشد (ماه ${d.month} سال ${d.year}).`);
  }
  return ok({ year: d.year, month: d.month, day: d.day });
}

export function jalaliToEpochDay(d: JalaliDate): Result<number> {
  const v = validateJalaliDate(d);
  if (!v.ok) return v;
  return ok(toEpochUnchecked(v.value));
}

export function epochDayToJalali(epochDay: number): Result<JalaliDate> {
  if (!isInt(epochDay)) return err("INVALID_INPUT", "شمارهٔ روز باید عدد صحیح باشد.");
  if (epochDay < MIN_EPOCH_DAY || epochDay > MAX_EPOCH_DAY) {
    return err("OUT_OF_RANGE", "تاریخ خارج از دامنهٔ پشتیبانی‌شده است.");
  }
  return ok(fromEpochUnchecked(epochDay));
}

function gregorianMonthLength(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function validateGregorianDate(g: GregorianDate): Result<GregorianDate> {
  if (typeof g !== "object" || g === null || !isInt(g.year) || !isInt(g.month) || !isInt(g.day)) {
    return err("INVALID_INPUT", "تاریخ میلادی نامعتبر است.");
  }
  if (g.month < 1 || g.month > 12) return err("INVALID_DATE", "ماه میلادی باید بین ۱ تا ۱۲ باشد.");
  if (g.day < 1 || g.day > gregorianMonthLength(g.year, g.month)) {
    return err("INVALID_DATE", "روز در این ماهِ میلادی وجود ندارد.");
  }
  return ok({ year: g.year, month: g.month, day: g.day });
}

export function jalaliToGregorian(d: JalaliDate): Result<GregorianDate> {
  const e = jalaliToEpochDay(d);
  if (!e.ok) return e;
  return ok(civilFromDays(e.value));
}

export function gregorianToJalali(g: GregorianDate): Result<JalaliDate> {
  const v = validateGregorianDate(g);
  if (!v.ok) return v;
  return epochDayToJalali(daysFromCivil(v.value.year, v.value.month, v.value.day));
}

/**
 * تاریخ جلالیِ یک لحظه در یک منطقهٔ زمانی (پیش‌فرض تهران).
 * ساعت سیستم را خودش نمی‌خواند؛ `instant` را بیرون می‌دهند تا تابع قابل‌تست بماند.
 */
export function jalaliFromInstant(instant: Date, timeZone = "Asia/Tehran"): Result<JalaliDate> {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    return err("INVALID_INPUT", "لحظهٔ زمانی نامعتبر است.");
  }
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(instant);
  } catch {
    return err("INVALID_INPUT", "منطقهٔ زمانی نامعتبر است.");
  }
  const pick = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return gregorianToJalali({ year: pick("year"), month: pick("month"), day: pick("day") });
}

export function compareJalaliDates(a: JalaliDate, b: JalaliDate): -1 | 0 | 1 {
  if (a.year !== b.year) return a.year < b.year ? -1 : 1;
  if (a.month !== b.month) return a.month < b.month ? -1 : 1;
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  return 0;
}

/** افزودن (یا کاستن، با عدد منفی) روز. */
export function addDays(d: JalaliDate, days: number): Result<JalaliDate> {
  if (!isInt(days)) return err("INVALID_INPUT", "تعداد روز باید عدد صحیح باشد.");
  const e = jalaliToEpochDay(d);
  if (!e.ok) return e;
  return epochDayToJalali(e.value + days);
}

export type MonthOverflow = "clamp" | "reject";

/**
 * افزودن ماه. اگر روز مقصد در ماه جدید وجود نداشته باشد (مثلاً ۳۱ شهریور + ۱ ماه):
 * - `clamp` (پیش‌فرض): آخرین روز ماه مقصد
 * - `reject`: خطا
 */
export function addMonths(d: JalaliDate, months: number, overflow: MonthOverflow = "clamp"): Result<JalaliDate> {
  if (!isInt(months)) return err("INVALID_INPUT", "تعداد ماه باید عدد صحیح باشد.");
  const v = validateJalaliDate(d);
  if (!v.ok) return v;
  const total = v.value.year * 12 + (v.value.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12 + 1;
  const len = jalaliMonthLength(year, month);
  if (!len.ok) return len;
  if (v.value.day > len.value) {
    if (overflow === "reject") {
      return err("INVALID_DATE", `روز ${v.value.day} در ماه ${month} سال ${year} وجود ندارد.`);
    }
    return ok({ year, month, day: len.value });
  }
  return ok({ year, month, day: v.value.day });
}

export function addYears(d: JalaliDate, years: number, overflow: MonthOverflow = "clamp"): Result<JalaliDate> {
  if (!isInt(years)) return err("INVALID_INPUT", "تعداد سال باید عدد صحیح باشد.");
  return addMonths(d, years * 12, overflow);
}

/** تعداد روزِ بین دو تاریخ: (to − from)؛ اگر to بعد از from باشد مثبت است. */
export function diffInDays(from: JalaliDate, to: JalaliDate): Result<number> {
  const a = jalaliToEpochDay(from);
  if (!a.ok) return a;
  const b = jalaliToEpochDay(to);
  if (!b.ok) return b;
  return ok(b.value - a.value);
}

/** روز هفته: ۰ = شنبه … ۶ = جمعه. */
export function weekdayIndex(d: JalaliDate): Result<number> {
  const e = jalaliToEpochDay(d);
  if (!e.ok) return e;
  // تاریخ‌های قبل از ۱۹۷۰ شمارهٔ روز منفی دارند؛ باقی‌ماندهٔ «کف» لازم است.
  return ok((((e.value + 5) % 7) + 7) % 7);
}

export function isFriday(d: JalaliDate): boolean {
  const w = weekdayIndex(d);
  return w.ok && w.value === 6;
}
