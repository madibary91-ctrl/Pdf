/**
 * تاریخ میلادی ISO — اعتبارسنجی و مقایسه. داخلی (از index صادر نمی‌شود جز `isValidIsoDate`).
 * عمداً مستقل از jalali-date است: registry این ماژول را فقط به shared-types وابسته کرده است.
 */
import { err, ok, type Result } from "@/modules/shared-types";
import type { IsoDate } from "./types";

/** حدود فنی (نه حقوقی): بیرون از این بازه تقریباً قطعاً خطای ورود داده است. */
export const MIN_ISO_YEAR = 1800;
export const MAX_ISO_YEAR = 2200;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

export function isValidIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string") return false;
  const m = ISO_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return y >= MIN_ISO_YEAR && y <= MAX_ISO_YEAR && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

export function parseIsoDate(value: unknown): Result<IsoDate> {
  if (typeof value !== "string") return err("INVALID_DATE", "تاریخ باید متن با قالب YYYY-MM-DD باشد.");
  if (!isValidIsoDate(value)) {
    return err("INVALID_DATE", `تاریخ «${value}» معتبر نیست؛ قالب درست YYYY-MM-DD (میلادی) و سال ${MIN_ISO_YEAR} تا ${MAX_ISO_YEAR} است.`);
  }
  return ok(value);
}

/** فقط برای تاریخ‌های اعتبارسنجی‌شده: رشتهٔ صفرپُرشده، پس ترتیب رشته‌ای = ترتیب زمانی. */
export function compareIsoDates(a: IsoDate, b: IsoDate): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}
