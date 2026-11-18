/**
 * ثبتِ دفترهای دکوراته‌شده (WeakSet: نشتی ندارد). تنها کارش: رفتگر و دکوراتورِ دوباره دفتر دکوراته را رد کنند.
 */
const DECORATED = new WeakSet<object>();

export function markDecoratedLedger(ledger: object): void {
  DECORATED.add(ledger);
}

export function isDecoratedLedger(v: unknown): boolean {
  return typeof v === "object" && v !== null && DECORATED.has(v);
}
