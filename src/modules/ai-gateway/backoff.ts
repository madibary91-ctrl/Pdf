/**
 * انتظار backoff: نمایی با سقف، به‌علاوهٔ jitter. خالص و عددصحیح؛ تصادف از بیرون می‌آید (`unit`)، نه از `Math.random`.
 * سرریز ناممکن: `baseDelayMs ≤ 60 000` و نمای ≤ ۳۰ ⇒ `< 2⁵³`.
 */
import type { JitterMode, RandomSource } from "./resilience-types";

const MAX_EXPONENT = 30;

/**
 * خروجی `random.next()` را به `[0, 1]` می‌رساند. نامعتبر (غیرعدد، نامتناهی، خارج بازه) ⇒ `1` یعنی **بی‌کاهشِ jitter**:
 * محافظه‌کارانه‌ترین (طولانی‌ترین) انتظار، هرگز تلاشِ زودتر از موعد.
 */
export function sanitizeUnit(u: unknown): number {
  return typeof u === "number" && Number.isFinite(u) && u >= 0 && u <= 1 ? u : 1;
}

/** `random.next()` بی‌پرتاب؛ منبع نبود یا پرتاب کرد ⇒ `1` (همان منطق `sanitizeUnit`). */
export function drawUnit(random: RandomSource | null): number {
  if (random === null) return 1;
  try {
    return sanitizeUnit(random.next());
  } catch {
    return 1;
  }
}

export type BackoffInput = Readonly<{
  /** این‌ام تلاش دوباره، از ۱ (تلاش دوباره‌ی k-ام پس از k-امین فراخوانی بر همین مدل). */
  retryNumber: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: JitterMode;
  /** عدد `[0, 1]` از `sanitizeUnit`؛ برای `none` نادیده گرفته می‌شود. */
  unit: number;
}>;

/** انتظارِ صحیحِ ۰…`maxDelayMs`. `none`: خودِ مقدار؛ `full`: `⌊raw·u⌋`؛ `equal`: `⌊raw/2 + raw/2·u⌋`. */
export function computeBackoff(input: BackoffInput): number {
  const k = Number.isFinite(input.retryNumber) ? Math.max(1, Math.floor(input.retryNumber)) : 1;
  const raw = Math.min(input.maxDelayMs, input.baseDelayMs * 2 ** Math.min(k - 1, MAX_EXPONENT));
  const u = sanitizeUnit(input.unit);
  switch (input.jitter) {
    case "full":
      return Math.floor(raw * u);
    case "equal":
      return Math.floor(raw / 2 + (raw / 2) * u);
    default:
      return raw;
  }
}
