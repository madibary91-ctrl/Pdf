/**
 * ابزارهای کانونی‌سازی و مقایسه (ADR-0069): عکسِ امنِ ورودیِ خصمانه، شکلِ کانونیِ بازنویسی‌ها، مقایسهٔ بی‌وابسته به ترتیبِ کلید
 * (jsonb ترتیب را حفظ نمی‌کند) و تفاوتِ مقدارِ مؤثر. هرگز نمی‌پرتابد؛ متنِ استثنا گرفته نمی‌شود.
 */
import type { PolicyChange } from "./types";

type Leaf = string | number;
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

export function isPlain(v: unknown): v is Record<string, unknown> {
  try {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
    const p: unknown = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null;
  } catch {
    return false;
  }
}

const leaf = (v: unknown): string | number | boolean | null => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null);

/**
 * عکسِ یک‌باره از بازنویسی‌های ادمین: هر کلید دقیقاً یک بار خوانده می‌شود (getter/Proxy نمی‌تواند بین اعتبارسنجی و ذخیره مقدار را عوض کند)،
 * فقط شیءِ ساده تا دو سطح؛ برگِ غیرِ اولیه `null` می‌شود (و بعداً با `resolveToolPolicy` رد می‌شود). خروجیِ بی‌پروتوتایپ است تا کلیدِ `__proto__` عادی بماند.
 * `null` = ناخواناییِ ریشه.
 */
export function snapshotOverrides(raw: unknown): Record<string, unknown> | null {
  try {
    if (!isPlain(raw)) return null;
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const s of Object.keys(raw)) {
      const sec = raw[s];
      if (isPlain(sec)) {
        const o: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const k of Object.keys(sec)) o[k] = leaf(sec[k]);
        out[s] = o;
      } else out[s] = leaf(sec);
    }
    return out;
  } catch {
    return null;
  }
}

/** پس از موفقیتِ `resolveToolPolicy(snapshot)`: کلیدها مرتب، بخشِ خالی حذف، یخ‌زده. */
export function canonicalOverrides<T>(snapshot: Record<string, unknown>): T {
  const out: Record<string, Readonly<Record<string, Leaf>>> = {};
  for (const s of Object.keys(snapshot).sort()) {
    const sec = snapshot[s];
    if (!isPlain(sec)) continue;
    const keys = Object.keys(sec).sort();
    if (keys.length === 0) continue;
    const o: Record<string, Leaf> = {};
    for (const k of keys) o[k] = sec[k] as Leaf;
    out[s] = Object.freeze(o);
  }
  return Object.freeze(out) as unknown as T;
}

/** رشتهٔ یکتا و مستقل از ترتیبِ کلید. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const r = v as Record<string, unknown>;
    return `{${Object.keys(r)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(r[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

function flatten(policy: unknown): Map<string, Leaf> {
  const out = new Map<string, Leaf>();
  if (!isPlain(policy)) return out;
  for (const s of Object.keys(policy).sort()) {
    const sec = policy[s];
    if (!isPlain(sec)) continue;
    for (const k of Object.keys(sec).sort()) {
      const v = sec[k];
      if (typeof v === "string" || typeof v === "number") out.set(`${s}.${k}`, v);
    }
  }
  return out;
}

/** تفاوتِ مقدارِ مؤثر بین دو عکسِ سیاست؛ مرتب بر پایهٔ مسیر. */
export function diffPolicies(prev: unknown, next: unknown): readonly PolicyChange[] {
  const a = flatten(prev);
  const b = flatten(next);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  const out: PolicyChange[] = [];
  for (const path of paths) {
    const from = a.has(path) ? (a.get(path) as Leaf) : null;
    const to = b.has(path) ? (b.get(path) as Leaf) : null;
    if (from !== to) out.push(Object.freeze({ path, from, to }));
  }
  return Object.freeze(out);
}

export { has };
