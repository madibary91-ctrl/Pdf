/**
 * کلیدِ هم‌ارزیِ یک فراخوانیِ ابزار برای تشخیصِ «تکرارِ بی‌پایانِ مدل». دو فراخوانی با همان نام و آرگومانِ هم‌ارز
 * (ترتیبِ کلیدها و فاصله‌ها بی‌اثر) یک کلیدند. خالص؛ هرگز پرتاب نمی‌کند.
 *
 * رشتهٔ ساخته‌شده فقط کلیدِ مقایسه است؛ هرگز اجرا یا نمایش داده نمی‌شود. JSONِ خراب/بزرگ/عمیق به متنِ خام برمی‌گردد
 * (محافظه‌کارانه: فقط دقیقاً مساوی‌ها یکی حساب می‌شوند).
 */
const MAX_CANONICAL_CHARS = 65_536;
const MAX_DEPTH = 32;

function stable(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new RangeError("deep");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stable(v, depth + 1)).join(",")}]`;
  if (typeof value === "object") {
    // رشتهٔ دستی (نه ساختنِ شیء): کلیدِ `__proto__` بی‌اثر می‌ماند.
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k], depth + 1)}`).join(",")}}`;
  }
  throw new TypeError("unsupported");
}

export function canonicalCallKey(name: string, argumentsJson: string): string {
  let args = argumentsJson;
  try {
    if (argumentsJson.length <= MAX_CANONICAL_CHARS) args = stable(JSON.parse(argumentsJson) as unknown, 0);
  } catch {
    args = argumentsJson;
  }
  // جداکنندهٔ NUL: نامِ ابزار (حروف/ارقام/_) هرگز آن را ندارد؛ پس دو جفتِ متفاوت یک کلید نمی‌شوند.
  return `${name}\u0000${args}`;
}
