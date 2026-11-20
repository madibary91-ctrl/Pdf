/**
 * آزمونِ کمک‌تابعِ خالصِ انتظارِ قفلِ کانونی (ADR-0040) — بی‌پایگاه، همیشه اجرا می‌شود.
 * ساعتِ مجازی: `sleep` فقط ثبت می‌کند؛ هیچ تایمر واقعی نیست.
 */
import { describe, expect, it } from "vitest";
import { type LockWaitOptions, waitForCanonicalWait } from "./lock-wait";

type Obs = readonly boolean[];

/** نمونه‌های پیاپی را از فهرست می‌دهد؛ پس از پایان همیشه «بی‌انتظار» (تهی). */
function scripted(seq: readonly Obs[], overrides: Partial<LockWaitOptions> = {}) {
  const log = { probes: 0, sleeps: [] as number[] };
  const options: LockWaitOptions = {
    probe: async () => {
      const at = log.probes++;
      return seq[at] ?? [];
    },
    sleep: async (ms) => {
      log.sleeps.push(ms);
    },
    pollMs: 10,
    idlePolls: 5,
    transientPolls: 20,
    ...overrides,
  };
  return { options, log };
}

describe("tooling · lock-wait: نتیجه", () => {
  it("انتظارِ کانونی از همان پرسشِ نخست ⇒ همان مشاهده، بی‌خواب", async () => {
    const { options, log } = scripted([[true]]);
    expect(await waitForCanonicalWait(options)).toEqual([true]);
    expect(log).toEqual({ probes: 1, sleeps: [] });
  });

  it("بازتولیدِ ناپایداری: ابتدا کلیدِ سراسریِ فایلِ دیگر ([false]) و سپس کانونی ⇒ [true] (نه [false])", async () => {
    const { options, log } = scripted([[false], [false], [false], [true]]);
    expect(await waitForCanonicalWait(options)).toEqual([true]);
    expect(log.probes).toBe(4);
    expect(log.sleeps).toEqual([10, 10, 10]);
  });

  it("میانِ دو قفلِ پیاپی لحظهٔ تهی هم تحمل می‌شود ([false] ← [] ← [true])", async () => {
    const { options } = scripted([[false], [], [true]]);
    expect(await waitForCanonicalWait(options)).toEqual([true]);
  });

  it("هیچ‌گاه انتظاری دیده نشد ⇒ null دقیقاً پس از idlePolls پرسش و idlePolls−۱ خواب", async () => {
    const { options, log } = scripted([], { idlePolls: 4, transientPolls: 9 });
    expect(await waitForCanonicalWait(options)).toBeNull();
    expect(log.probes).toBe(4);
    expect(log.sleeps).toHaveLength(3);
  });

  it("انتظارِ دیرهنگام در آخرین پرسشِ بیکار هم دیده می‌شود (مرزِ idlePolls−۱)", async () => {
    const { options } = scripted([[], [], [], [true]], { idlePolls: 4, transientPolls: 9 });
    expect(await waitForCanonicalWait(options)).toEqual([true]);
  });

  it("انتظارِ پس از idlePolls دیده نمی‌شود (بودجهٔ بیکاری تمدید نمی‌شود)", async () => {
    const { options, log } = scripted([[], [], [], [], [true]], { idlePolls: 4, transientPolls: 9 });
    expect(await waitForCanonicalWait(options)).toBeNull();
    expect(log.probes).toBe(4);
  });

  it("شکستِ بسته: فقط کلیدِ غیرِ کانونی تا پایانِ بودجه ⇒ آخرین مشاهدهٔ غیرِ تهی ([false]) و دقیقاً transientPolls پرسش از نخستین دیدن", async () => {
    const { options, log } = scripted([[], [], [false], ...Array.from({ length: 50 }, () => [false] as Obs)], { idlePolls: 5, transientPolls: 7 });
    expect(await waitForCanonicalWait(options)).toEqual([false]);
    expect(log.probes).toBe(2 + 7); // دو پرسشِ تهی + هفت پرسش از نخستین دیدن
  });

  it("پس از دیدنِ انتظارِ غیرِ کانونی و ناپدیدشدنش، آخرین مشاهدهٔ غیرِ تهی (نه تهی) برمی‌گردد", async () => {
    const { options } = scripted([[false], [], [], []], { idlePolls: 2, transientPolls: 4 });
    expect(await waitForCanonicalWait(options)).toEqual([false]);
  });

  it("مشاهدهٔ دارای true بی‌دست‌کاری برمی‌گردد (ادعای «دقیقاً [true]» با فراخوان است)", async () => {
    const { options } = scripted([[false, true]]);
    expect(await waitForCanonicalWait(options)).toEqual([false, true]);
  });

  it("کانونی درست در آخرین پرسشِ بودجه پذیرفته می‌شود و یک پرسشِ بعد دیگر نه", async () => {
    const seq = (n: number): Obs[] => [...Array.from({ length: n }, () => [false] as Obs), [true]];
    expect(await waitForCanonicalWait(scripted(seq(6), { idlePolls: 3, transientPolls: 7 }).options)).toEqual([true]);
    expect(await waitForCanonicalWait(scripted(seq(7), { idlePolls: 3, transientPolls: 7 }).options)).toEqual([false]);
  });

  it("pollMs به sleep داده می‌شود", async () => {
    const { options, log } = scripted([[false], [true]], { pollMs: 37 });
    await waitForCanonicalWait(options);
    expect(log.sleeps).toEqual([37]);
  });
});

describe("tooling · lock-wait: خطاها و پیکربندی", () => {
  it("خطای probe بلعیده نمی‌شود", async () => {
    const options: LockWaitOptions = { probe: async () => Promise.reject(new Error("قطع شد")), sleep: async () => undefined, pollMs: 1, idlePolls: 2, transientPolls: 3 };
    await expect(waitForCanonicalWait(options)).rejects.toThrow("قطع شد");
  });

  it("خطای sleep بلعیده نمی‌شود", async () => {
    const options: LockWaitOptions = { probe: async () => [false], sleep: async () => Promise.reject(new Error("تایمر")), pollMs: 1, idlePolls: 2, transientPolls: 3 };
    await expect(waitForCanonicalWait(options)).rejects.toThrow("تایمر");
  });

  it.each([
    ["idlePolls صفر", { idlePolls: 0 }],
    ["idlePolls اعشاری", { idlePolls: 1.5 }],
    ["idlePolls منفی", { idlePolls: -1 }],
    ["idlePolls NaN", { idlePolls: Number.NaN }],
    ["transientPolls صفر", { transientPolls: 0 }],
    ["transientPolls NaN (مقایسهٔ ترتیب آن را رد نمی‌کند)", { idlePolls: 1, transientPolls: Number.NaN }],
    ["transientPolls اعشاری", { idlePolls: 1, transientPolls: 2.5 }],
    ["transientPolls منفی", { idlePolls: 1, transientPolls: -3 }],
    ["transientPolls < idlePolls", { idlePolls: 5, transientPolls: 4 }],
    ["pollMs منفی", { pollMs: -1 }],
    ["pollMs بی‌نهایت", { pollMs: Number.POSITIVE_INFINITY }],
    ["pollMs NaN", { pollMs: Number.NaN }],
  ] as const)("پیکربندیِ نامعتبر پیش از هر پرسش رد می‌شود: %s", async (_name, bad) => {
    const { options, log } = scripted([[true]], bad as Partial<LockWaitOptions>);
    await expect(waitForCanonicalWait(options)).rejects.toBeInstanceOf(RangeError);
    expect(log.probes).toBe(0);
  });

  it("پیکربندیِ مرزی معتبر است (idlePolls = transientPolls = ۱، pollMs = ۰)", async () => {
    const { options, log } = scripted([[false]], { idlePolls: 1, transientPolls: 1, pollMs: 0 });
    expect(await waitForCanonicalWait(options)).toEqual([false]);
    expect(log).toEqual({ probes: 1, sleeps: [] });
  });
});

/** مولدِ شبه‌تصادفیِ قطعی (mulberry32) — بذر ثابت ⇒ بازتولیدپذیر. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** مدلِ مرجعِ مستقل (پنجره‌ای، نه حلقه‌ای): نتیجه و شمارِ پرسش را از روی دنباله حساب می‌کند. */
function model(obs: (i: number) => Obs, idlePolls: number, transientPolls: number): { result: Obs | null; probes: number } {
  let first = -1;
  for (let i = 0; i < idlePolls; i++) {
    if (obs(i).length > 0) {
      first = i;
      break;
    }
  }
  if (first < 0) return { result: null, probes: idlePolls };
  const end = first + transientPolls;
  let lastNonEmpty: Obs | null = null;
  for (let i = first; i < end; i++) {
    const o = obs(i);
    if (o.includes(true)) return { result: o, probes: i + 1 };
    if (o.length > 0) lastNonEmpty = o;
  }
  return { result: lastNonEmpty, probes: end };
}

describe("tooling · lock-wait: خاصیتی (مدلِ مرجع)", () => {
  it("۲۰۰ دنبالهٔ تصادفی با نتیجه و شمارِ پرسشِ برابرِ مدلِ مرجع", async () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const idlePolls = 1 + Math.floor(r() * 6);
      const transientPolls = idlePolls + Math.floor(r() * 8);
      const seq: Obs[] = Array.from({ length: 40 }, () => {
        const x = r();
        if (x < 0.35) return [];
        if (x < 0.8) return [false];
        if (x < 0.95) return [true];
        return [false, true];
      });
      const at = (i: number): Obs => seq[i] ?? [];
      const { options, log } = scripted(seq, { idlePolls, transientPolls });
      const got = await waitForCanonicalWait(options);
      const want = model(at, idlePolls, transientPolls);
      expect({ seed, got, probes: log.probes }).toEqual({ seed, got: want.result, probes: want.probes });
      expect(log.sleeps).toHaveLength(want.probes - 1); // میانِ دو پرسش خواب؛ پس از آخری نه
    }
  });

  it("یکنوایی: هر چه بودجهٔ گذرا بزرگ‌تر شود، نتیجهٔ «کانونی دیده شد» هرگز از دست نمی‌رود", async () => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(1000 + seed);
      const seq: Obs[] = Array.from({ length: 40 }, () => (r() < 0.2 ? [] : r() < 0.8 ? [false] : [true]));
      let sawCanonical = false;
      for (let transientPolls = 5; transientPolls <= 30; transientPolls += 5) {
        const got = await waitForCanonicalWait(scripted(seq, { idlePolls: 5, transientPolls }).options);
        const canonical = got?.includes(true) === true;
        if (sawCanonical) expect(canonical, `seed ${seed} transientPolls ${transientPolls}`).toBe(true);
        sawCanonical ||= canonical;
      }
    }
  });
});
