/**
 * settlement-backlog-watch · پیش‌فرض‌های امن و اعتبارسنجیِ پیکربندی روی مرز (ADR-0042). بی‌پایگاه.
 */
import { describe, expect, it } from "vitest";
import { SETTLEMENT_BACKLOG_WATCH_DEFAULTS, SETTLEMENT_BACKLOG_WATCH_LIMITS, createBacklogWatch } from "./index";
import { FAST, listOutbox, manualClock, okList, virtual } from "./test-kit";

const base = (): Record<string, unknown> => ({ outbox: listOutbox(() => Promise.resolve(okList([]))), clock: manualClock(), timer: virtual().timer });
const issuesOf = (raw: unknown): readonly string[] => {
  const r = createBacklogWatch(raw);
  if (r.ok) throw new Error("انتظار شکست بود");
  expect(r.error.code).toBe("INVALID_CONFIG");
  return r.error.issues;
};
const accepts = (raw: unknown): boolean => createBacklogWatch(raw).ok;

describe("settlement-backlog-watch · پیش‌فرض‌های امن (قفل‌شده؛ تغییرشان تصمیمِ آگاهانه است)", () => {
  it("مقدارها دقیقاً همان‌هایی‌اند که در ADR-0042 اعلام شده", () => {
    expect(SETTLEMENT_BACKLOG_WATCH_DEFAULTS).toEqual({
      intervalMs: 30_000,
      timeoutMs: 5_000,
      degradedCount: 1,
      downCount: 10,
      degradedAfterMs: 3_600_000,
      downAfterMs: 86_400_000,
      sampleLimit: 1000,
      readyPolicy: "report",
    });
    expect(Object.isFrozen(SETTLEMENT_BACKLOG_WATCH_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(SETTLEMENT_BACKLOG_WATCH_LIMITS)).toBe(true);
  });

  it("پیش‌فرض‌ها خودشان معتبرند و پیش‌فرضِ readyPolicy فقط‌گزارش است (هرگز مسدودکننده)", () => {
    expect(accepts(base())).toBe(true);
    expect(SETTLEMENT_BACKLOG_WATCH_DEFAULTS.readyPolicy).toBe("report");
    const d = SETTLEMENT_BACKLOG_WATCH_DEFAULTS;
    expect(d.degradedCount).toBeLessThanOrEqual(d.downCount);
    expect(d.downCount).toBeLessThanOrEqual(d.sampleLimit);
    expect(d.degradedAfterMs).toBeLessThanOrEqual(d.downAfterMs);
  });

  it("با پیکربندیِ حداقلی (فقط outbox/clock/timer) همه‌چیز از پیش‌فرض می‌آید", () => {
    const r = createBacklogWatch(base());
    expect(r.ok).toBe(true);
    const b = base();
    expect(accepts({ ...b, ...FAST })).toBe(true);
  });
});

describe("settlement-backlog-watch · الزامی‌ها و شکلِ ورودی", () => {
  it.each([null, undefined, 5, "x", [], () => 1, true])("ورودیِ غیرِ شیء (%s) ⇒ INVALID_CONFIG", (raw) => {
    expect(issuesOf(raw).length).toBeGreaterThan(0);
  });

  it.each(["outbox", "clock", "timer"])("نبودنِ %s ⇒ خطا با نامِ همان فیلد", (key) => {
    const b = base();
    delete b[key];
    expect(issuesOf(b).join(" ")).toContain(key);
  });

  it("outbox بدونِ listUnacknowledgedDead، clock بدونِ nowMs و timer ناقص رد می‌شوند", () => {
    expect(issuesOf({ ...base(), outbox: { counts: () => 1 } }).join(" ")).toContain("outbox");
    expect(issuesOf({ ...base(), clock: {} }).join(" ")).toContain("clock");
    expect(issuesOf({ ...base(), timer: { after: () => 1 } }).join(" ")).toContain("timer الزامی است");
  });

  it("کلیدِ ناشناخته (غلط‌یابِ نام) رد می‌شود و نامِ کلید کوتاه می‌شود", () => {
    const i = issuesOf({ ...base(), intervalMS: 5, ["k".repeat(100)]: 1 });
    expect(i.join(" ")).toContain("intervalMS");
    expect(i.join(" ")).not.toContain("k".repeat(41));
  });

  it("هر کلید یک بار خوانده می‌شود و getterِ پرتاب‌کننده خطای بسته است نه استثنا", () => {
    const reads: Record<string, number> = {};
    const raw: Record<string, unknown> = {};
    const b = base();
    for (const k of ["outbox", "clock", "timer", "intervalMs", "timeoutMs", "degradedCount", "downCount", "degradedAfterMs", "downAfterMs", "sampleMaxAgeMs", "sampleLimit", "readyPolicy"]) {
      Object.defineProperty(raw, k, {
        enumerable: true,
        get() {
          reads[k] = (reads[k] ?? 0) + 1;
          return b[k] ?? undefined;
        },
      });
    }
    createBacklogWatch(raw);
    for (const [k, n] of Object.entries(reads)) expect(n, k).toBeLessThanOrEqual(1);
    const evil = { ...base() };
    Object.defineProperty(evil, "intervalMs", {
      enumerable: true,
      get() {
        throw new Error("SECRET-GETTER");
      },
    });
    const r = createBacklogWatch(evil);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });
});

describe("settlement-backlog-watch · مرزهای عددی", () => {
  const L = SETTLEMENT_BACKLOG_WATCH_LIMITS;
  it.each([
    ["intervalMs", L.minIntervalMs, L.maxIntervalMs],
    ["timeoutMs", 1, L.maxTimeoutMs],
  ] as const)("%s: مرزهای بسته پذیرفته و بیرونِ مرز/غیرِ صحیح رد می‌شود", (key, lo, hi) => {
    // مرزها را با کهنگیِ صریحِ بزرگ می‌سنجیم تا قاعدهٔ کف تداخل نکند.
    const wide = { ...base(), sampleMaxAgeMs: 365 * 86_400_000 };
    expect(accepts({ ...wide, [key]: lo })).toBe(true);
    expect(accepts({ ...wide, [key]: hi })).toBe(true);
    for (const bad of [lo - 1, hi + 1, 1.5, "5", Number.NaN, Infinity, null, -1]) expect(accepts({ ...wide, [key]: bad }), `${key}=${String(bad)}`).toBe(false);
    expect(issuesOf({ ...wide, [key]: hi + 1 }).join(" ")).toContain(key);
  });

  it("مرزهای عددیِ صریح (نه مشتق از ثابت‌های ماژول): intervalMs ۱…۳٬۶۰۰٬۰۰۰ و timeoutMs ۱…۳٬۶۰۰٬۰۰۰", () => {
    const wide = { ...base(), sampleMaxAgeMs: 365 * 86_400_000 };
    expect(accepts({ ...wide, intervalMs: 1 })).toBe(true);
    expect(accepts({ ...wide, intervalMs: 0 })).toBe(false);
    expect(accepts({ ...wide, intervalMs: 3_600_000 })).toBe(true);
    expect(accepts({ ...wide, intervalMs: 3_600_001 })).toBe(false);
    expect(accepts({ ...wide, timeoutMs: 1 })).toBe(true);
    expect(accepts({ ...wide, timeoutMs: 0 })).toBe(false);
    expect(accepts({ ...wide, timeoutMs: 3_600_000 })).toBe(true);
    expect(accepts({ ...wide, timeoutMs: 3_600_001 })).toBe(false);
  });

  it("timer باید هم after و هم cancel داشته باشد", () => {
    expect(accepts({ ...base(), timer: { after: () => 1, cancel: () => undefined } })).toBe(true);
    expect(accepts({ ...base(), timer: { cancel: () => undefined } })).toBe(false);
    expect(accepts({ ...base(), timer: { after: () => 1 } })).toBe(false);
  });

  it("null مثلِ «نبود» پیش‌فرض نمی‌گیرد؛ رد می‌شود (فقط undefined پیش‌فرض می‌گیرد)", () => {
    for (const key of ["intervalMs", "timeoutMs", "degradedCount", "downCount", "degradedAfterMs", "downAfterMs", "sampleLimit", "readyPolicy", "sampleMaxAgeMs"]) {
      expect(accepts({ ...base(), [key]: null }), key).toBe(false);
      expect(accepts({ ...base(), [key]: undefined }), key).toBe(true);
    }
  });

  it("readyPolicy فقط report یا gate_down", () => {
    expect(accepts({ ...base(), readyPolicy: "report" })).toBe(true);
    expect(accepts({ ...base(), readyPolicy: "gate_down" })).toBe(true);
    for (const bad of ["REPORT", "gate", "", null, 1, true]) expect(accepts({ ...base(), readyPolicy: bad })).toBe(false);
  });

  it("کفِ کهنگی: sampleMaxAgeMs ≥ intervalMs + ۲×timeoutMs (در کف پذیرفته، یک واحد کمتر رد)", () => {
    const f = FAST.intervalMs + 2 * FAST.timeoutMs;
    expect(accepts({ ...base(), ...FAST, sampleMaxAgeMs: f })).toBe(true);
    expect(accepts({ ...base(), ...FAST, sampleMaxAgeMs: f - 1 })).toBe(false);
    expect(issuesOf({ ...base(), ...FAST, sampleMaxAgeMs: f - 1 }).join(" ")).toContain("sampleMaxAgeMs");
  });

  it("کهنگیِ پیش‌فرض همیشه بالاتر از کف است (برای مرزهای فاصله/مهلت)", () => {
    for (const [i, t] of [[1, 1], [30_000, 5_000], [3_600_000, 3_600_000], [1, 3_600_000]] as const) {
      expect(accepts({ ...base(), intervalMs: i, timeoutMs: t }), `${i}/${t}`).toBe(true);
    }
  });

  it("کهنگیِ بیش از یک سال و مقدارِ غیرِ صحیح رد می‌شود", () => {
    for (const bad of [0, -5, 1.5, "1", 365 * 86_400_000 + 1]) expect(accepts({ ...base(), sampleMaxAgeMs: bad })).toBe(false);
    expect(accepts({ ...base(), intervalMs: 0, sampleMaxAgeMs: 0 })).toBe(false);
  });
});

describe("settlement-backlog-watch · آستانه‌های قابل‌تنظیم (قاعده‌ها از settlement-backlog)", () => {
  it("بازنویسیِ معتبر پذیرفته می‌شود", () => {
    expect(accepts({ ...base(), degradedCount: 3, downCount: 7, degradedAfterMs: 60_000, downAfterMs: 120_000, sampleLimit: 50 })).toBe(true);
  });

  it("degradedCount > downCount رد می‌شود، حتی وقتی فقط یکی را بازنویسی کنند (در برابرِ پیش‌فرضِ دیگری)", () => {
    expect(issuesOf({ ...base(), degradedCount: 20 }).join(" ")).toContain("degradedCount");
    expect(issuesOf({ ...base(), downCount: 5, degradedCount: 6 }).join(" ")).toContain("degradedCount");
  });

  it("downCount > sampleLimit رد می‌شود (بریدنِ فهرست نباید آستانه را پنهان کند)", () => {
    expect(issuesOf({ ...base(), sampleLimit: 5 }).join(" ")).toContain("downCount");
    expect(accepts({ ...base(), sampleLimit: 10 })).toBe(true);
  });

  it("degradedAfterMs > downAfterMs رد می‌شود", () => {
    expect(issuesOf({ ...base(), degradedAfterMs: 90_000_000 }).join(" ")).toContain("degradedAfterMs");
  });

  it.each(["degradedCount", "downCount", "degradedAfterMs", "downAfterMs", "sampleLimit"])("%s غیرِ صحیح یا صفر رد می‌شود", (key) => {
    for (const bad of [0, -1, 1.5, "3", Number.NaN, null]) expect(accepts({ ...base(), [key]: bad }), `${key}=${String(bad)}`).toBe(false);
  });

  it("مقدارِ اشتباهِ فیلد هرگز در پیام نمی‌آید (حتی اگر رشتهٔ اتصال یا کلید باشد)", () => {
    const text = JSON.stringify(issuesOf({ ...base(), degradedCount: "postgres://u:SECRET@127.0.0.1/db", intervalMs: "sk-ABCDEFGHIJKLMN", readyPolicy: "SECRET-POLICY" }));
    for (const s of ["SECRET", "postgres", "sk-ABC"]) expect(text).not.toContain(s);
  });

  it("خطا منجمد است و کدِ بسته دارد", () => {
    const r = createBacklogWatch(null);
    if (r.ok) throw new Error("انتظار شکست");
    expect(Object.isFrozen(r.error)).toBe(true);
    expect(Object.isFrozen(r.error.issues)).toBe(true);
  });
});
