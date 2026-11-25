/** ابزار مشترکِ آزمون‌های tool-policy (از index صادر نمی‌شود). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** عمیق‌یخ‌زده؟ */
export function deepFrozen(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return true;
  if (!Object.isFrozen(v)) return false;
  return Object.values(v).every(deepFrozen);
}
