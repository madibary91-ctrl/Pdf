import { describe, expect, it } from "vitest";
import { CALC_TOOLS, executeCalcTool, executeCalcToolJson } from "./index";
import { toJsonValue } from "./json";
import { deepFreeze, validateAgainstSchema } from "./schema";

/** مولدِ شبه‌تصادفیِ قطعی (mulberry32): شکستِ فازینگ همیشه با همان seed بازتولید می‌شود. */
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

const CODES = new Set(["INVALID_INPUT", "OUT_OF_RANGE", "INVALID_DATE", "PARSE_ERROR"]);
const D = { year: 1405, month: 1, day: 1 };
const CORPUS: ReadonlyArray<readonly [string, unknown]> = [
  ["court_fee", { date: D, stage: "first-instance", claim: { kind: "known", amountRials: 100_000_000 } }],
  ["court_fee", { date: D, stage: "appeal", claim: { kind: "known", amountRials: 9_000_000_000 }, tierMethod: "progressive" }],
  ["court_fee", { date: { year: 1404, month: 7, day: 3 }, stage: "cassation", claim: { kind: "unknown" } }],
  ["late_payment", { principalRials: 1_000_000, index: { mode: "manual", baseIndex: "100", paymentIndex: "150.5" } }],
  ["late_payment", { principalRials: 77, index: { mode: "manual", baseIndex: "3", paymentIndex: "7", baseLabel: "الف", paymentLabel: "ب" } }],
  ["late_payment", { principalRials: 5, index: { mode: "series", seriesId: "x", dueDate: D, paymentDate: D } }],
];
const JUNK: ReadonlyArray<() => unknown> = ([
  null, undefined, NaN, Infinity, -Infinity, -1, 0, 1, 1.5, 2 ** 53, -(2 ** 53), 1e21, Number.MAX_SAFE_INTEGER, "", "0", "۱۰۰", "x".repeat(300),
  "progressive", "manual", "series", true, false, BigInt(10), Symbol("s"),
] as unknown[]).map((v) => () => v).concat([() => [], () => ({}), () => [1], () => ({ a: 1 }), () => () => 1, () => new Date(0), () => new Map()]);

function paths(v: unknown, prefix: readonly string[] = []): string[][] {
  const out: string[][] = [[...prefix]];
  if (typeof v === "object" && v !== null && !Array.isArray(v)) {
    for (const [k, c] of Object.entries(v)) out.push(...paths(c, [...prefix, k]));
  }
  return out;
}

function mutateRandom(v: unknown, r: () => number): unknown {
  const copy = JSON.parse(JSON.stringify(v)) as unknown;
  const steps = 1 + Math.floor(r() * 3);
  let root: unknown = copy;
  for (let i = 0; i < steps; i++) {
    const all = paths(root).filter((p) => p.length > 0);
    const target = all[Math.floor(r() * all.length)];
    if (!target) break;
    let parent = root as Record<string, unknown>;
    for (const k of target.slice(0, -1)) parent = parent[k] as Record<string, unknown>;
    const key = target[target.length - 1] as string;
    const op = r();
    if (op < 0.35) delete parent[key];
    else if (op < 0.85) parent[key] = (JUNK[Math.floor(r() * JUNK.length)] as () => unknown)();
    else {
      const extra = ["__proto__", "constructor", "zzz", "toString"][Math.floor(r() * 4)] as string;
      Object.defineProperty(parent, extra, { value: (JUNK[Math.floor(r() * JUNK.length)] as () => unknown)(), enumerable: true, configurable: true, writable: true });
    }
  }
  return root;
}

describe("calc-tools: فازینگِ قطعی (seed ثابت) — هرگز نمی‌پرتابد، همیشه Resultِ بسته", () => {
  it("۶۰۰۰ ورودیِ جهش‌یافته: بی‌پرتاب، کدِ بسته، پیامِ ناتهی، ناورداهای پول در موفقیت‌ها", () => {
    const r = rng(0xca1c7001);
    let okCount = 0;
    let failCount = 0;
    const codes = new Set<string>();
    for (let i = 0; i < 6000; i++) {
      const [name, base] = CORPUS[i % CORPUS.length] as readonly [string, unknown];
      const args = i < CORPUS.length ? base : mutateRandom(base, r);
      let out: ReturnType<typeof executeCalcTool>;
      try {
        out = executeCalcTool(name, args);
      } catch (e) {
        throw new Error(`پرتاب شد (i=${i}): ${String(e)} با ${safe(args)}`);
      }
      expect(typeof out.ok).toBe("boolean");
      if (out.ok) {
        okCount++;
        expect(out.value.tool).toBe(name);
        expect(typeof out.value.reviewPending).toBe("boolean");
        expect(out.value.reviewPending).toBe(out.value.review.status !== "legally-verified");
        expect(JSON.parse(JSON.stringify(out.value))).toEqual(out.value);
        const res = out.value.result as Record<string, unknown>;
        if (name === "court_fee") {
          expect(Number.isSafeInteger(res.feeRials) && (res.feeRials as number) >= 0).toBe(true);
        } else {
          const p = res.principalRials as number;
          const d = res.damagesRials as number;
          expect(Number.isSafeInteger(d) && d >= 0).toBe(true);
          expect(res.totalRials).toBe(p + d);
        }
      } else {
        failCount++;
        codes.add(out.error.code);
        expect(CODES.has(out.error.code), out.error.code).toBe(true);
        expect(out.error.message.length).toBeGreaterThan(0);
        expect(out.error.message.length).toBeLessThan(2500);
      }
    }
    // فازینگ پوچ نیست: هم موفقیتِ واقعی دیده شد و هم چند خانوادهٔ خطا.
    expect(okCount).toBeGreaterThan(30);
    expect(failCount).toBeGreaterThan(2000);
    expect(codes.size).toBeGreaterThanOrEqual(2);
  });

  it("همان فازینگ از مسیرِ JSON (رشته‌سازیِ آرگومان‌ها) هم بی‌پرتاب است", () => {
    const r = rng(0xca1c7002);
    for (let i = 0; i < 1500; i++) {
      const [name, base] = CORPUS[i % CORPUS.length] as readonly [string, unknown];
      const args = mutateRandom(base, r);
      let text: string;
      try {
        text = JSON.stringify(args);
      } catch {
        continue; // bigint و … در JSON واقعی وجود ندارند
      }
      const out = executeCalcToolJson(name, text);
      expect(typeof out.ok).toBe("boolean");
    }
  });

  it("رشته‌های JSONِ تصادفی (نه‌لزوماً معتبر) بی‌پرتاب‌اند", () => {
    const r = rng(0xca1c7003);
    const alphabet = '{}[]":,.0123456789-eE truefalsnul\\\u0000';
    for (let i = 0; i < 1500; i++) {
      const len = Math.floor(r() * 60);
      let s = "";
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(r() * alphabet.length)];
      expect(typeof executeCalcToolJson(i % 2 === 0 ? "court_fee" : "late_payment", s).ok).toBe("boolean");
    }
  });
});

function safe(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return "[غیرقابل‌سریال]";
  }
}

describe("calc-tools: ورودیِ بدجنس (Proxy، getter، پروتوتایپ)", () => {
  const good = { date: D, stage: "first-instance", claim: { kind: "unknown" } };

  it("غیرِ شیءِ ساده رد می‌شود: آرایه، Date، Map، نمونهٔ کلاس، شیءِ دارایِ ارثِ پروتوتایپ", () => {
    class K {
      date = D;
    }
    const inherited = Object.create(good) as unknown;
    for (const bad of [null, undefined, [], [good], "s", 5, true, new Date(0), new Map(), new K(), inherited, () => good]) {
      expect(executeCalcTool("court_fee", bad)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    }
  });

  it("شیءِ با پروتوتایپِ null پذیرفته می‌شود (ساده است)", () => {
    const o = Object.assign(Object.create(null) as Record<string, unknown>, good);
    expect(executeCalcTool("court_fee", o).ok).toBe(true);
  });

  it("Proxyِ پرتاب‌کننده در هر تله ⇒ INVALID_INPUT، نه پرتاب", () => {
    for (const trap of ["getPrototypeOf", "ownKeys", "get", "getOwnPropertyDescriptor"] as const) {
      const p = new Proxy(
        { ...good },
        {
          [trap]() {
            throw new Error("boom");
          },
        },
      );
      expect(executeCalcTool("court_fee", p), trap).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    }
  });

  it("getterِ پرتاب‌کننده روی یک ویژگی ⇒ INVALID_INPUT", () => {
    const o = { ...good } as Record<string, unknown>;
    Object.defineProperty(o, "stage", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(executeCalcTool("court_fee", o)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("اعتبارسنج مستقیم هم بی‌پرتاب است و شیءِ تو‌در‌توی بسیار ژرف را رد می‌کند", () => {
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let i = 0; i < 5000; i++) {
      const n: Record<string, unknown> = {};
      deep.date = n;
      deep = n;
    }
    const schema = CALC_TOOLS[0]?.parameters;
    if (!schema) throw new Error("schema");
    expect(validateAgainstSchema(schema, root).ok).toBe(false);
  });

  it("پیامِ خطا کران‌دار است حتی با ده‌ها مشکل (سقفِ ۱۰ مشکل)", () => {
    const bad: Record<string, unknown> = {};
    for (let i = 0; i < 200; i++) bad[`k${i}`] = i;
    const r = executeCalcTool("court_fee", bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message.length).toBeLessThan(2500);
  });
});

describe("calc-tools: toJsonValue — «بی‌صدا» ممنوع", () => {
  it("مقدارهای JSON-سازگار عیناً می‌گذرند؛ کلیدِ undefined حذف می‌شود", () => {
    const r = toJsonValue({ a: 1, b: [1, "x", null, true], c: { d: undefined, e: 0 }, f: -0 });
    expect(r).toEqual({ ok: true, value: { a: 1, b: [1, "x", null, true], c: { e: 0 }, f: -0 } });
  });

  it("NaN، بی‌نهایت، bigint، تابع، symbol، undefined در آرایه، نمونهٔ کلاس و Date ⇒ OUT_OF_RANGE", () => {
    class K {}
    for (const bad of [NaN, Infinity, -Infinity, BigInt(1), () => 1, Symbol("s"), undefined, [undefined], { x: NaN }, [[Infinity]], new K(), new Date(0), new Map()]) {
      expect(toJsonValue(bad), String(bad)).toMatchObject({ ok: false, error: { code: "OUT_OF_RANGE" } });
    }
  });

  it("عمقِ بیش از سقف و ساختارِ چرخه‌ای ⇒ OUT_OF_RANGE (بی‌پرتاب)", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = [deep];
    expect(toJsonValue(deep)).toMatchObject({ ok: false });
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(toJsonValue(cyc)).toMatchObject({ ok: false });
  });

  it("شیءِ با پروتوتایپِ null پذیرفته می‌شود", () => {
    expect(toJsonValue(Object.assign(Object.create(null) as object, { a: 1 }))).toEqual({ ok: true, value: { a: 1 } });
  });
});

describe("calc-tools: deepFreeze", () => {
  it("ژرف می‌بندد و دوباره‌فراخوانی بی‌خطاست (شیء از قبل یخ‌زده)", () => {
    const o = deepFreeze({ a: { b: [1, { c: 2 }] } });
    expect(Object.isFrozen(o.a.b[1])).toBe(true);
    expect(() => deepFreeze(o)).not.toThrow();
    expect(deepFreeze(5)).toBe(5);
    expect(deepFreeze(null)).toBe(null);
  });
});
