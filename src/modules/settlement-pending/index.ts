/**
 * رابط عمومی settlement-pending (م۳‑ه‑۴‑الف‑۲‑۴‑ب‑۱، ADR-0046): نمایهٔ مشتقِ «مرده‌های در انتظارِ تأیید» برای پایشِ پسماند با هزینهٔ O(تأییدنشده‌ها).
 * هر چیز دیگر داخلی است و از بیرون ماژول نباید import شود. **سیم‌کشی به bootstrap/پایش در این برش نیست** (برشِ ب‑۲). `down()` برگشتِ رسمی را می‌دهد (ADR-0048).
 */
export { createPendingDeadIndex } from "./store";
export { PENDING_LIST_LIMIT_MAX } from "./read";
export type { PendingDeadIndex, PendingDeadIndexOptions, PendingDownReport, PendingVerifyReport } from "./types";
