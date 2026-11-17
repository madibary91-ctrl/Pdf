import { describe, expect, it } from "vitest";
import {
  MAX_JALALI_YEAR,
  MIN_JALALI_YEAR,
  addDays,
  addMonths,
  addYears,
  compareJalaliDates,
  computeDeadline,
  diffInDays,
  epochDayToJalali,
  formatJalaliDate,
  gregorianToJalali,
  isFriday,
  isJalaliLeapYear,
  jalaliFromInstant,
  jalaliMonthLength,
  jalaliToEpochDay,
  jalaliToGregorian,
  parseJalaliDate,
  validateJalaliDate,
  weekdayIndex,
} from "./index";

const j = (year: number, month: number, day: number) => ({ year, month, day });
const g = (year: number, month: number, day: number) => ({ year, month, day });

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** نمونه‌های مرجع شناخته‌شده (نوروزها و رویدادهای تاریخی). */
const REFERENCE: ReadonlyArray<[ReturnType<typeof j>, ReturnType<typeof g>]> = [
  [j(1357, 11, 22), g(1979, 2, 11)],
  [j(1398, 1, 1), g(2019, 3, 21)],
  [j(1399, 12, 30), g(2021, 3, 20)], // سال ۱۳۹۹ کبیسه
  [j(1400, 1, 1), g(2021, 3, 21)],
  [j(1401, 1, 1), g(2022, 3, 21)],
  [j(1402, 1, 1), g(2023, 3, 21)],
  [j(1403, 1, 1), g(2024, 3, 20)],
  [j(1403, 12, 30), g(2025, 3, 20)], // سال ۱۴۰۳ کبیسه
  [j(1404, 1, 1), g(2025, 3, 21)],
  [j(1404, 7, 1), g(2025, 9, 23)],
  [j(1404, 12, 29), g(2026, 3, 20)],
  [j(1405, 1, 1), g(2026, 3, 21)],
];

describe("jalali-date: تبدیل مرجع", () => {
  it.each(REFERENCE)("جلالی %j ⇄ میلادی %j", (jd, gd) => {
    expect(unwrap(jalaliToGregorian(jd))).toEqual(gd);
    expect(unwrap(gregorianToJalali(gd))).toEqual(jd);
  });
});

describe("jalali-date: سال کبیسه و طول ماه", () => {
  it("سال‌های کبیسهٔ شناخته‌شده", () => {
    for (const y of [1399, 1403, 1408, 1412]) expect(unwrap(isJalaliLeapYear(y))).toBe(true);
    for (const y of [1400, 1401, 1402, 1404, 1405, 1406, 1407]) expect(unwrap(isJalaliLeapYear(y))).toBe(false);
  });

  it("طول ماه‌ها: ۳۱/۳۰/اسفند ۲۹ یا ۳۰", () => {
    for (let m = 1; m <= 6; m += 1) expect(unwrap(jalaliMonthLength(1404, m))).toBe(31);
    for (let m = 7; m <= 11; m += 1) expect(unwrap(jalaliMonthLength(1404, m))).toBe(30);
    expect(unwrap(jalaliMonthLength(1404, 12))).toBe(29);
    expect(unwrap(jalaliMonthLength(1403, 12))).toBe(30);
  });

  it("طول سال همیشه ۳۶۵ یا ۳۶۶ و جمع طول ماه‌ها با آن برابر است", () => {
    for (let y = MIN_JALALI_YEAR; y <= MAX_JALALI_YEAR; y += 1) {
      let sum = 0;
      for (let m = 1; m <= 12; m += 1) sum += unwrap(jalaliMonthLength(y, m));
      expect(sum).toBe(unwrap(isJalaliLeapYear(y)) ? 366 : 365);
    }
  });

  it("الگوی ۳۳ ساله: بین دو کبیسه ۴ یا ۵ سال فاصله است (سال‌های ۱۳۰۰–۱۵۰۰)", () => {
    let last = -1;
    for (let y = 1300; y <= 1500; y += 1) {
      if (!unwrap(isJalaliLeapYear(y))) continue;
      if (last > 0) expect([4, 5]).toContain(y - last);
      last = y;
    }
  });
});

describe("jalali-date: سازگاری و رفت‌وبرگشت", () => {
  it("همهٔ روزهای ۱۲۰۰ تا ۱۶۰۰: پیوسته، رفت‌وبرگشت، و ترتیب میلادی درست", () => {
    const first = unwrap(jalaliToEpochDay(j(MIN_JALALI_YEAR, 1, 1)));
    const lastDay = unwrap(jalaliToEpochDay(j(MAX_JALALI_YEAR, 12, unwrap(jalaliMonthLength(MAX_JALALI_YEAR, 12)))));
    let prev = null as null | ReturnType<typeof j>;
    for (let e = first; e <= lastDay; e += 1) {
      const d = unwrap(epochDayToJalali(e));
      expect(unwrap(jalaliToEpochDay(d))).toBe(e);
      if (prev) {
        const expectedNext =
          prev.day < unwrap(jalaliMonthLength(prev.year, prev.month))
            ? j(prev.year, prev.month, prev.day + 1)
            : prev.month < 12
              ? j(prev.year, prev.month + 1, 1)
              : j(prev.year + 1, 1, 1);
        expect(d).toEqual(expectedNext);
      }
      prev = d;
    }
  });

  it("با Intl (تقویم persian سیستم) در سال‌های ۱۳۰۰–۱۴۵۰ هم‌خوان است", () => {
    const fmt = new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn", {
      timeZone: "UTC",
      year: "numeric",
      month: "numeric",
      day: "numeric",
    });
    const start = unwrap(jalaliToEpochDay(j(1300, 1, 1)));
    const end = unwrap(jalaliToEpochDay(j(1450, 12, 29)));
    for (let e = start; e <= end; e += 1) {
      const parts = fmt.formatToParts(new Date(e * 86_400_000));
      const pick = (t: string) => Number(parts.find((p) => p.type === t)?.value);
      expect(unwrap(epochDayToJalali(e))).toEqual(j(pick("year"), pick("month"), pick("day")));
    }
  });
});

describe("jalali-date: اعتبارسنجی", () => {
  it("تاریخ‌های ناموجود رد می‌شوند", () => {
    expect(validateJalaliDate(j(1404, 12, 30)).ok).toBe(false); // ۱۴۰۴ کبیسه نیست
    expect(validateJalaliDate(j(1403, 12, 30)).ok).toBe(true);
    expect(validateJalaliDate(j(1404, 7, 31)).ok).toBe(false);
    expect(validateJalaliDate(j(1404, 6, 31)).ok).toBe(true);
    expect(validateJalaliDate(j(1404, 0, 1)).ok).toBe(false);
    expect(validateJalaliDate(j(1404, 13, 1)).ok).toBe(false);
    expect(validateJalaliDate(j(1404, 1, 0)).ok).toBe(false);
    expect(validateJalaliDate(j(1404.5, 1, 1)).ok).toBe(false);
    expect(validateJalaliDate(j(Number.NaN, 1, 1)).ok).toBe(false);
  });

  it("خارج از دامنه کد OUT_OF_RANGE می‌دهد", () => {
    const r = validateJalaliDate(j(MAX_JALALI_YEAR + 1, 1, 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("OUT_OF_RANGE");
  });

  it("تاریخ میلادی نامعتبر رد می‌شود", () => {
    expect(gregorianToJalali(g(2025, 2, 29)).ok).toBe(false);
    expect(gregorianToJalali(g(2024, 2, 29)).ok).toBe(true);
    expect(gregorianToJalali(g(2025, 13, 1)).ok).toBe(false);
    expect(gregorianToJalali(g(1700, 1, 1)).ok).toBe(false);
  });
});

describe("jalali-date: حساب تاریخ", () => {
  it("addDays از مرز ماه، سال و سال کبیسه عبور می‌کند", () => {
    expect(unwrap(addDays(j(1404, 1, 31), 1))).toEqual(j(1404, 2, 1));
    expect(unwrap(addDays(j(1404, 6, 31), 1))).toEqual(j(1404, 7, 1));
    expect(unwrap(addDays(j(1404, 12, 29), 1))).toEqual(j(1405, 1, 1));
    expect(unwrap(addDays(j(1403, 12, 29), 1))).toEqual(j(1403, 12, 30));
    expect(unwrap(addDays(j(1403, 12, 30), 1))).toEqual(j(1404, 1, 1));
    expect(unwrap(addDays(j(1404, 1, 1), -1))).toEqual(j(1403, 12, 30));
    expect(unwrap(addDays(j(1404, 1, 1), 0))).toEqual(j(1404, 1, 1));
    expect(unwrap(addDays(j(1404, 1, 1), 365))).toEqual(j(1405, 1, 1));
  });

  it("addDays عدد غیرصحیح و خروج از دامنه را رد می‌کند", () => {
    expect(addDays(j(1404, 1, 1), 1.5).ok).toBe(false);
    expect(addDays(j(MAX_JALALI_YEAR, 12, 29), 400).ok).toBe(false);
  });

  it("addMonths: حفظ روز، clamp و reject", () => {
    expect(unwrap(addMonths(j(1404, 1, 15), 1))).toEqual(j(1404, 2, 15));
    expect(unwrap(addMonths(j(1404, 12, 15), 1))).toEqual(j(1405, 1, 15));
    expect(unwrap(addMonths(j(1404, 1, 15), -1))).toEqual(j(1403, 12, 15));
    expect(unwrap(addMonths(j(1404, 6, 31), 1))).toEqual(j(1404, 7, 30)); // clamp
    expect(unwrap(addMonths(j(1404, 6, 31), 6))).toEqual(j(1404, 12, 29)); // clamp به اسفند ۲۹
    expect(unwrap(addMonths(j(1403, 6, 31), 6))).toEqual(j(1403, 12, 30)); // کبیسه
    expect(addMonths(j(1404, 6, 31), 1, "reject").ok).toBe(false);
    expect(unwrap(addMonths(j(1404, 1, 31), 12))).toEqual(j(1405, 1, 31));
    expect(unwrap(addMonths(j(1404, 1, 15), -13))).toEqual(j(1402, 12, 15));
  });

  it("addYears: روز ۳۰ اسفند کبیسه + ۱ سال → ۲۹ اسفند", () => {
    expect(unwrap(addYears(j(1403, 12, 30), 1))).toEqual(j(1404, 12, 29));
    expect(addYears(j(1403, 12, 30), 1, "reject").ok).toBe(false);
    expect(unwrap(addYears(j(1404, 5, 5), 2))).toEqual(j(1406, 5, 5));
  });

  it("diffInDays و مقایسه", () => {
    expect(unwrap(diffInDays(j(1404, 1, 1), j(1405, 1, 1)))).toBe(365);
    expect(unwrap(diffInDays(j(1403, 1, 1), j(1404, 1, 1)))).toBe(366);
    expect(unwrap(diffInDays(j(1404, 1, 10), j(1404, 1, 1)))).toBe(-9);
    expect(compareJalaliDates(j(1404, 1, 1), j(1404, 1, 2))).toBe(-1);
    expect(compareJalaliDates(j(1405, 1, 1), j(1404, 12, 29))).toBe(1);
    expect(compareJalaliDates(j(1404, 3, 3), j(1404, 3, 3))).toBe(0);
  });

  it("روز هفته: ۱ فروردین ۱۴۰۴ جمعه بود؛ ۲۲ بهمن ۱۳۵۷ یکشنبه", () => {
    expect(unwrap(weekdayIndex(j(1404, 1, 1)))).toBe(6);
    expect(isFriday(j(1404, 1, 1))).toBe(true);
    expect(isFriday(j(1404, 1, 2))).toBe(false);
    expect(unwrap(weekdayIndex(j(1404, 1, 2)))).toBe(0); // شنبه
    expect(unwrap(weekdayIndex(j(1357, 11, 22)))).toBe(1); // یکشنبه (قبل از ۱۹۷۰ هم درست)
    expect(unwrap(weekdayIndex(j(1300, 1, 1)))).toBe(2); // ۲۱ مارس ۱۹۲۱ دوشنبه بود
  });

  it("jalaliFromInstant با منطقهٔ تهران (مرز نیمه‌شب)", () => {
    // ۲۰۲۵-۰۳-۲۰ ساعت ۲۰:۳۰ UTC = ۲۴:۰۰ تهران (UTC+3:30) → روز بعد
    expect(unwrap(jalaliFromInstant(new Date("2025-03-20T20:29:00Z")))).toEqual(j(1403, 12, 30));
    expect(unwrap(jalaliFromInstant(new Date("2025-03-20T20:31:00Z")))).toEqual(j(1404, 1, 1));
    expect(jalaliFromInstant(new Date("invalid")).ok).toBe(false);
    expect(jalaliFromInstant(new Date(), "Not/AZone").ok).toBe(false);
  });
});

describe("jalali-date: قالب‌دهی و تجزیه", () => {
  const d = j(1404, 1, 5);
  it("قالب‌ها", () => {
    expect(unwrap(formatJalaliDate(d))).toBe("۱۴۰۴/۰۱/۰۵");
    expect(unwrap(formatJalaliDate(d, { digits: "latin", separator: "-" }))).toBe("1404-01-05");
    expect(unwrap(formatJalaliDate(d, { style: "long" }))).toBe("۵ فروردین ۱۴۰۴");
    expect(unwrap(formatJalaliDate(j(1404, 1, 1), { style: "full", digits: "latin" }))).toBe("جمعه 1 فروردین 1404");
    expect(formatJalaliDate(j(1404, 13, 1)).ok).toBe(false);
  });

  it("تجزیه ارقام و جداکننده‌های گوناگون", () => {
    for (const s of ["۱۴۰۴/۰۱/۰۵", "1404-1-5", "1404.01.05", "14040105", "١٤٠٤/٠١/٠٥", "  ۱۴۰۴/۱/۵ ", "\u200F۱۴۰۴/۰۱/۰۵\u200E"]) {
      expect(unwrap(parseJalaliDate(s))).toEqual(d);
    }
  });

  it("تجزیهٔ ورودی بد", () => {
    for (const s of ["", "04/01/05", "1404/13/01", "1404/12/30", "abc", "1404/01", "1404/01/05/06", "14040731"]) {
      expect(parseJalaliDate(s).ok).toBe(false);
    }
    expect(parseJalaliDate(123 as unknown as string).ok).toBe(false);
  });

  it("رفت‌وبرگشت format ⇄ parse", () => {
    for (let e = unwrap(jalaliToEpochDay(j(1399, 1, 1))); e < unwrap(jalaliToEpochDay(j(1410, 1, 1))); e += 7) {
      const date = unwrap(epochDayToJalali(e));
      expect(unwrap(parseJalaliDate(unwrap(formatJalaliDate(date))))).toEqual(date);
    }
  });
});

describe("jalali-date: مهلت‌ها (computeDeadline)", () => {
  it("مهلت روزی: روز ابلاغ شمرده نمی‌شود", () => {
    const r = unwrap(computeDeadline({ start: j(1404, 1, 10), amount: 20, unit: "day" }));
    expect(r.due).toEqual(j(1404, 1, 30));
    expect(r.rolledOver).toBe(false);
  });

  it("مهلت روزی با شمردن روز مبدأ", () => {
    const r = unwrap(computeDeadline({ start: j(1404, 1, 10), amount: 20, unit: "day", countStartDay: true }));
    expect(r.due).toEqual(j(1404, 1, 29));
  });

  it("مهلت ماهی و سالی", () => {
    expect(unwrap(computeDeadline({ start: j(1404, 1, 10), amount: 1, unit: "month" })).due).toEqual(j(1404, 2, 10));
    expect(unwrap(computeDeadline({ start: j(1404, 1, 10), amount: 1, unit: "month", countStartDay: true })).due).toEqual(
      j(1404, 2, 9),
    );
    expect(unwrap(computeDeadline({ start: j(1404, 6, 31), amount: 1, unit: "month" })).due).toEqual(j(1404, 7, 30));
    expect(unwrap(computeDeadline({ start: j(1404, 3, 3), amount: 2, unit: "year" })).due).toEqual(j(1406, 3, 3));
  });

  it("انتقال به روز کاری وقتی آخرین روز جمعه است", () => {
    // ۱ فروردین ۱۴۰۴ جمعه است؛ ۱۴۰۳/۱۲/۲۹ + ۲ روز = ۱۴۰۴/۱/۱ (جمعه) — اسفند ۱۴۰۳ سی‌روزه است
    const base = { start: j(1403, 12, 29), amount: 2, unit: "day" as const };
    const noRoll = unwrap(computeDeadline(base));
    expect(noRoll.due).toEqual(j(1404, 1, 1));
    const roll = unwrap(computeDeadline({ ...base, rollOverNonWorkingDay: true }));
    expect(roll.rawDue).toEqual(j(1404, 1, 1));
    expect(roll.due).toEqual(j(1404, 1, 2));
    expect(roll.rolledOver).toBe(true);
    expect(roll.steps.length).toBeGreaterThan(3);
  });

  it("تعطیلات تزریق‌شده (شنبه و یکشنبه هم تعطیل) پشت‌سرهم رد می‌شوند", () => {
    const off = new Set(["1404/1/1", "1404/1/2", "1404/1/3"]);
    const r = unwrap(
      computeDeadline({
        start: j(1403, 12, 29),
        amount: 2,
        unit: "day",
        rollOverNonWorkingDay: true,
        isNonWorkingDay: (d) => off.has(`${d.year}/${d.month}/${d.day}`),
      }),
    );
    expect(r.due).toEqual(j(1404, 1, 4));
  });

  it("ورودی نامعتبر و تابع نامعتبر", () => {
    expect(computeDeadline({ start: j(1404, 1, 1), amount: 0, unit: "day" }).ok).toBe(false);
    expect(computeDeadline({ start: j(1404, 1, 1), amount: 1.5, unit: "day" }).ok).toBe(false);
    expect(computeDeadline({ start: j(1404, 13, 1), amount: 1, unit: "day" }).ok).toBe(false);
    expect(computeDeadline({ start: j(1404, 1, 1), amount: 1, unit: "week" as never }).ok).toBe(false);
    expect(
      computeDeadline({
        start: j(1404, 1, 1),
        amount: 1,
        unit: "day",
        rollOverNonWorkingDay: true,
        isNonWorkingDay: () => true,
      }).ok,
    ).toBe(false);
  });
});
