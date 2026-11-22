import { describe, expect, it } from "vitest";
import {
  COURT_FEE_STAGE_ORDER,
  COURT_FEE_TARIFFS,
  calculateCourtFee,
  calculateLatePayment,
  type CourtFeeInput,
  type IndexSeries,
  type LatePaymentInput,
} from "@/modules/legal-calc";
import { CALC_TOOLS, MAX_ARGS_JSON_LENGTH, executeCalcTool, executeCalcToolJson, isCalcToolName, type CalcToolOutput } from "./index";
import { validateAgainstSchema, type Schema, type SchemaObject } from "./schema";

/**
 * ⚠️ مرز اعتبار: calc-tools «پوششِ مرزی» است، نه منطق حقوقی. اینجا درستیِ جدول‌ها ثابت نمی‌شود؛ ثابت می‌شود که
 * (۱) هرچه مدل می‌فرستد پیش از رسیدن به legal-calc سنجیده می‌شود، (۲) خروجی عیناً خروجیِ legal-calc است (آزمونِ تفاضلی)،
 * (۳) وضعیتِ بازبینی هرگز گم نمی‌شود. مقدارهای «دست‌حساب» فقط حساب‌سرانگشتیِ ریاضی‌اند و ادعای حقوقی ندارند.
 */

const D1405 = { year: 1405, month: 1, day: 1 } as const;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const must = (r: ReturnType<typeof executeCalcTool>): CalcToolOutput => {
  if (!r.ok) throw new Error(`انتظار موفقیت: ${r.error.code} ${r.error.message}`);
  return r.value;
};
const toolSchema = (name: string): SchemaObject => {
  const t = CALC_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(name);
  return t.parameters;
};

describe("calc-tools: توصیف ابزارها (آنچه مدل می‌بیند)", () => {
  it("دقیقاً دو ابزارِ court_fee و late_payment، با ترتیبِ ثابت", () => {
    expect(CALC_TOOLS.map((t) => t.name)).toEqual(["court_fee", "late_payment"]);
  });

  it("نام‌ها یکتا و برای مدل امن‌اند (snake_case لاتین)", () => {
    const names = CALC_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z_]*$/);
  });

  it("توصیف‌ها فارسی و ناتهی‌اند و مدل را از «بازگوییِ عددِ حافظه» نهی می‌کنند", () => {
    for (const t of CALC_TOOLS) {
      expect(t.description).toMatch(/[\u0600-\u06FF]/);
      expect(t.description).toContain("حافظه");
    }
  });

  it("ژرف یخ‌زده است (ارکستراتور نمی‌تواند توصیف را تغییر دهد)", () => {
    const frozen = (v: unknown): boolean =>
      typeof v !== "object" || v === null || (Object.isFrozen(v) && Object.values(v).every(frozen));
    expect(Object.isFrozen(CALC_TOOLS)).toBe(true);
    expect(frozen(CALC_TOOLS)).toBe(true);
    expect(() => {
      (CALC_TOOLS[0] as { name: string }).name = "x";
    }).toThrow(TypeError);
  });

  it("کاملاً JSON-سازگار است (رفت‌وبرگشت بی‌تغییر؛ بی‌تابع/undefined)", () => {
    expect(clone(CALC_TOOLS)).toEqual(CALC_TOOLS);
  });

  it("هر شیء additionalProperties=false دارد و required زیرمجموعهٔ properties است", () => {
    const visit = (s: Schema): void => {
      if (s.type !== "object") return;
      expect(s.additionalProperties).toBe(false);
      for (const k of s.required) expect(Object.keys(s.properties)).toContain(k);
      Object.values(s.properties).forEach(visit);
    };
    for (const t of CALC_TOOLS) {
      expect(t.parameters.type).toBe("object");
      visit(t.parameters);
    }
  });

  it("فهرست مرحله‌ها همان COURT_FEE_STAGE_ORDERِ legal-calc است (نه نسخهٔ جداگانه)", () => {
    const stage = toolSchema("court_fee").properties.stage;
    expect(stage?.type === "string" ? stage.enum : null).toEqual([...COURT_FEE_STAGE_ORDER]);
  });

  it("عددِ حقوقی در توصیف نیست: هیچ مبلغ/نرخی جز حدّهای ساختاری (آزمونِ منبع در robustness)", () => {
    const text = JSON.stringify(CALC_TOOLS);
    expect(text).not.toMatch(/\d{4,}%|بیست|نیم/);
  });

  it("isCalcToolName فقط نام‌های واقعی را می‌پذیرد", () => {
    expect(isCalcToolName("court_fee")).toBe(true);
    expect(isCalcToolName("late_payment")).toBe(true);
    for (const bad of ["", "__proto__", "constructor", "toString", "COURT_FEE", " court_fee", 1, null, undefined, {}]) {
      expect(isCalcToolName(bad)).toBe(false);
    }
  });
});

/* ───────────── توافقِ توصیف و اعتبارسنج (تولیدشده از خودِ شما) ───────────── */

type Node = Readonly<{ path: readonly string[]; schema: Schema }>;
function nodes(s: Schema, path: readonly string[] = []): Node[] {
  const out: Node[] = [{ path, schema: s }];
  if (s.type === "object") for (const [k, c] of Object.entries(s.properties)) out.push(...nodes(c, [...path, k]));
  return out;
}
/** نمونهٔ «همهٔ ویژگی‌ها پر» (فقط برای سنجشِ ساختار؛ قاعده‌های میان‌فیلدی با آزمون‌های جدا سنجیده می‌شوند). */
function full(s: Schema): unknown {
  if (s.type === "integer") return s.minimum;
  if (s.type === "string") return s.enum?.[0] ?? "x";
  return Object.fromEntries(Object.entries(s.properties).map(([k, c]) => [k, full(c)]));
}
function mutate(root: unknown, path: readonly string[], fn: (parent: Record<string, unknown>, key: string) => void): unknown {
  const copy = clone(root) as Record<string, unknown>;
  let cur = copy;
  for (const k of path.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  fn(cur, path[path.length - 1] as string);
  return copy;
}

describe.each(CALC_TOOLS.map((t) => [t.name, t.parameters] as const))("calc-tools: توافقِ شما و اعتبارسنج — %s", (_name, schema) => {
  const base = full(schema);
  const all = nodes(schema);

  it("نمونهٔ کامل از روی شما معتبر است", () => {
    expect(validateAgainstSchema(schema, base).ok).toBe(true);
  });

  it("حذفِ هر کلیدِ required رد می‌شود و نامِ کلید در پیام است", () => {
    for (const n of all) {
      if (n.schema.type !== "object") continue;
      for (const key of n.schema.required) {
        const bad = n.path.length === 0 ? (() => { const c = clone(base) as Record<string, unknown>; delete c[key]; return c; })() : mutate(base, [...n.path, key], (p, k) => { delete p[k]; });
        const r = validateAgainstSchema(schema, bad);
        expect(r.ok, [...n.path, key].join(".")).toBe(false);
        if (!r.ok) expect(r.error.message).toContain(key);
      }
    }
  });

  it("کلیدِ اضافه در هر سطح رد می‌شود (نام در پیام)", () => {
    for (const n of all) {
      if (n.schema.type !== "object") continue;
      const bad = n.path.length === 0 ? { ...(base as object), zzz: 1 } : mutate(base, [...n.path, "zzz"], (p, k) => { p[k] = 1; });
      const r = validateAgainstSchema(schema, bad);
      expect(r.ok, n.path.join(".") || "root").toBe(false);
      if (!r.ok) expect(r.error.message).toContain("zzz");
    }
  });

  it("هر برگِ عددی: خارج از حد، اعشار، رشته، NaN، بی‌نهایت و بیش از ۲^۵۳ رد می‌شود", () => {
    for (const n of all) {
      if (n.schema.type !== "integer") continue;
      const s = n.schema;
      for (const v of [s.minimum - 1, s.maximum + 1, s.minimum + 0.5, String(s.minimum), "۱۰۰", NaN, Infinity, -Infinity, 2 ** 53, null, [], {}, true]) {
        const r = validateAgainstSchema(schema, mutate(base, n.path, (p, k) => { p[k] = v; }));
        expect(r.ok, `${n.path.join(".")} ← ${String(v)}`).toBe(false);
      }
      for (const v of [s.minimum, Math.min(s.maximum, s.minimum + 1)]) {
        expect(validateAgainstSchema(schema, mutate(base, n.path, (p, k) => { p[k] = v; })).ok).toBe(true);
      }
    }
  });

  it("هر برگِ رشته‌ای: نوع نادرست، مقدارِ خارج از enum و رشتهٔ بلند رد می‌شود", () => {
    for (const n of all) {
      if (n.schema.type !== "string") continue;
      const s = n.schema;
      const bads: unknown[] = [0, 12, null, [], {}, true, NaN];
      if (s.enum) bads.push("نامعتبر", s.enum[0] + " ", String(s.enum[0]).toUpperCase());
      else bads.push("", "x".repeat((s.maxLength ?? 200) + 1));
      for (const v of bads) {
        expect(validateAgainstSchema(schema, mutate(base, n.path, (p, k) => { p[k] = v; })).ok, `${n.path.join(".")} ← ${String(v)}`).toBe(false);
      }
    }
  });

  it("هر شیءِ تو‌در‌تو: جایگزینی با نوعِ غیرِ شیء رد می‌شود", () => {
    for (const n of all) {
      if (n.schema.type !== "object" || n.path.length === 0) continue;
      for (const v of [null, [], "s", 1, true]) {
        expect(validateAgainstSchema(schema, mutate(base, n.path, (p, k) => { p[k] = v; })).ok).toBe(false);
      }
    }
  });
});

/* ───────────── court_fee ───────────── */

const courtArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  date: { ...D1405 },
  stage: "first-instance",
  claim: { kind: "known", amountRials: 100_000_000 },
  ...over,
});

describe("calc-tools: court_fee", () => {
  it("آزمونِ تفاضلی: خروجی عیناً خروجیِ calculateCourtFee است (مرحله × مبلغ × روش × تاریخ)", () => {
    const amounts = [1, 99_999_999, 200_000_000, 200_000_001, 5_000_000_000, 1_000_000_000_000];
    const methods = [undefined, "progressive", "whole-amount"] as const;
    const dates = [D1405, { year: 1404, month: 6, day: 15 }, { year: 1403, month: 1, day: 1 }, { year: 1405, month: 12, day: 30 }];
    let compared = 0;
    for (const date of dates) {
      for (const stage of COURT_FEE_STAGE_ORDER) {
        for (const tierMethod of methods) {
          const claims = [...amounts.map((a) => ({ kind: "known" as const, amountRials: a })), { kind: "unknown" as const }];
          for (const claim of claims) {
            const input: CourtFeeInput = { date, stage, claim, ...(tierMethod ? { tierMethod } : {}) };
            const direct = calculateCourtFee(input);
            const tool = executeCalcTool("court_fee", { date, stage, claim, ...(tierMethod ? { tierMethod } : {}) });
            compared++;
            if (direct.ok) {
              expect(tool.ok).toBe(true);
              if (!tool.ok) continue;
              expect(tool.value.result).toEqual(clone(direct.value));
              expect(tool.value.review).toEqual(direct.value.review);
              expect(tool.value.notes).toEqual(direct.value.notes);
              expect(tool.value.tool).toBe("court_fee");
            } else {
              expect(tool).toEqual({ ok: false, error: direct.error });
            }
          }
        }
      }
    }
    expect(compared).toBe(dates.length * COURT_FEE_STAGE_ORDER.length * methods.length * (amounts.length + 1));
  });

  it("ناوردا: هزینه عدد صحیحِ امنِ نامنفی است و گردکردن بی‌سروصدا از کسر نمی‌گذرد", () => {
    for (const a of [1, 1_000, 99_999_999, 200_000_000, 3_000_000_000]) {
      const out = must(executeCalcTool("court_fee", courtArgs({ claim: { kind: "known", amountRials: a }, tierMethod: "progressive" })));
      const fee = (out.result as { feeRials: number }).feeRials;
      expect(Number.isSafeInteger(fee) && fee >= 0).toBe(true);
    }
  });

  it("روشِ پله‌ای را مدل «حدس» نمی‌زند: مبلغِ بالا بدون tierMethod خطای INVALID_INPUT از legal-calc می‌دهد", () => {
    const r = executeCalcTool("court_fee", courtArgs({ claim: { kind: "known", amountRials: 100_000_000_000 } }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_INPUT");
      expect(r.error.message).toContain("روش");
    }
  });

  it("claim.kind=known بدون amountRials رد می‌شود", () => {
    const r = executeCalcTool("court_fee", courtArgs({ claim: { kind: "known" } }));
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    if (!r.ok) expect(r.error.message).toContain("claim.amountRials");
  });

  it("claim.kind=unknown همراه amountRials رد می‌شود (دو معنا هم‌زمان ممنوع)", () => {
    const r = executeCalcTool("court_fee", courtArgs({ claim: { kind: "unknown", amountRials: 5 } }));
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("سالِ بدون جدول OUT_OF_RANGE است و جدولِ سالِ دیگر جایگزین نمی‌شود", () => {
    const r = executeCalcTool("court_fee", courtArgs({ date: { year: 1300, month: 1, day: 1 } }));
    expect(r).toMatchObject({ ok: false, error: { code: "OUT_OF_RANGE" } });
  });

  it("تاریخِ تقویمیِ ناممکن (روز ۳۱ ماه ۷ ... یا ۳۰ اسفندِ سالِ غیرکبیسه) INVALID_DATE است", () => {
    const r = executeCalcTool("court_fee", courtArgs({ date: { year: 1405, month: 12, day: 30 } }));
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_DATE" } });
  });

  it("مبلغِ صفر/منفی را legal-calc رد می‌کند؛ منفی را شما پیش‌تر می‌گیرد", () => {
    expect(executeCalcTool("court_fee", courtArgs({ claim: { kind: "known", amountRials: 0 } }))).toMatchObject({ ok: false });
    expect(executeCalcTool("court_fee", courtArgs({ claim: { kind: "known", amountRials: -1 } }))).toMatchObject({
      ok: false,
      error: { code: "INVALID_INPUT" },
    });
  });

  it("مبلغ به‌صورت رشته (حتی ارقام فارسی) تبدیل/حدس نمی‌شود", () => {
    for (const v of ["100000000", "۱۰۰۰۰۰۰۰۰", "1e8", 1e8 + 0.5]) {
      expect(executeCalcTool("court_fee", courtArgs({ claim: { kind: "known", amountRials: v } }))).toMatchObject({
        ok: false,
        error: { code: "INVALID_INPUT" },
      });
    }
  });
});

/* ───────────── late_payment ───────────── */

const lateArgs = (principal: number, base: string, pay: string, extra: Record<string, unknown> = {}) => ({
  principalRials: principal,
  index: { mode: "manual", baseIndex: base, paymentIndex: pay, ...extra },
});

describe("calc-tools: late_payment", () => {
  it("دست‌حسابِ ریاضی: ۱٬۰۰۰٬۰۰۰ × ۱۵۰٫۵ ÷ ۱۰۰ − ۱٬۰۰۰٬۰۰۰ = ۵۰۵٬۰۰۰", () => {
    const out = must(executeCalcTool("late_payment", lateArgs(1_000_000, "100", "150.5")));
    expect(out.result).toMatchObject({ damagesRials: 505_000, totalRials: 1_505_000, principalRials: 1_000_000 });
  });

  it("شاخصِ برابر یا کاهشی ⇒ خسارتِ صفر (هرگز منفی)", () => {
    for (const [b, p] of [["100", "100"], ["150", "100"]] as const) {
      const out = must(executeCalcTool("late_payment", lateArgs(1_000_000, b, p)));
      expect(out.result).toMatchObject({ damagesRials: 0, totalRials: 1_000_000 });
    }
  });

  it("آزمونِ تفاضلی (دستی): عیناً خروجیِ calculateLatePayment، و ناورداهای پول", () => {
    const principals = [1, 999, 1_000_000, 12_345_678_901];
    const pairs = [["100", "100"], ["100", "150.5"], ["150", "100"], ["1174.5", "1301.25"], ["0", "5"], ["abc", "5"], ["1e3", "5"], ["100,5", "5"]] as const;
    for (const principalRials of principals) {
      for (const [b, p] of pairs) {
        const input: LatePaymentInput = { principalRials, index: { mode: "manual", baseIndex: b, paymentIndex: p } };
        const direct = calculateLatePayment(input);
        const tool = executeCalcTool("late_payment", lateArgs(principalRials, b, p));
        if (direct.ok) {
          expect(tool.ok).toBe(true);
          if (!tool.ok) continue;
          expect(tool.value.result).toEqual(clone(direct.value));
          const r = tool.value.result as { principalRials: number; damagesRials: number; totalRials: number };
          expect(r.totalRials).toBe(r.principalRials + r.damagesRials);
          expect(r.damagesRials).toBeGreaterThanOrEqual(0);
        } else {
          expect(tool).toEqual({ ok: false, error: direct.error });
        }
      }
    }
  });

  it("برچسب‌های اختیاری به legal-calc می‌رسند", () => {
    const out = must(executeCalcTool("late_payment", lateArgs(1000, "100", "250", { baseLabel: "فروردین ۱۴۰۰", paymentLabel: "فروردین ۱۴۰۱" })));
    const r = out.result as { baseIndex: { label: string }; paymentIndex: { label: string } };
    expect(r.baseIndex.label).toBe("فروردین ۱۴۰۰");
    expect(r.paymentIndex.label).toBe("فروردین ۱۴۰۱");
    expect(out.result).toMatchObject({ damagesRials: 1500, totalRials: 2500 });
  });

  it("اصلِ دینِ صفر را legal-calc رد می‌کند (تصمیمِ حقوقیِ مثبت‌بودن با آن است)", () => {
    expect(executeCalcTool("late_payment", lateArgs(0, "100", "150"))).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("با mode=manual کلیدهای series مجاز نیستند و بالعکس (ابهامِ دو منبع)", () => {
    const withSeries = lateArgs(1000, "100", "150", { seriesId: "s" });
    expect(executeCalcTool("late_payment", withSeries)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    const seriesWithManual = {
      principalRials: 1000,
      index: { mode: "series", seriesId: "s", dueDate: D1405, paymentDate: D1405, baseIndex: "1" },
    };
    expect(executeCalcTool("late_payment", seriesWithManual)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("کلیدهای الزامیِ هر حالت جداگانه گزارش می‌شوند", () => {
    const m = executeCalcTool("late_payment", { principalRials: 1, index: { mode: "manual", baseIndex: "1" } });
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.error.message).toContain("index.paymentIndex");
    const s = executeCalcTool("late_payment", { principalRials: 1, index: { mode: "series", seriesId: "s" } });
    expect(s.ok).toBe(false);
    if (!s.ok) {
      expect(s.error.message).toContain("index.dueDate");
      expect(s.error.message).toContain("index.paymentDate");
    }
  });

  it("سریِ ثبت‌نشده خطاست (سریِ دیگری جایگزین نمی‌شود)", () => {
    const r = executeCalcTool("late_payment", {
      principalRials: 1000,
      index: { mode: "series", seriesId: "no-such-series", dueDate: D1405, paymentDate: D1405 },
    });
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  });

  it("حالت series با سریِ تزریقیِ «آزمایشی» (ساختگی؛ نه شاخصِ واقعی) و ریاضیِ دست‌حساب", () => {
    const fixture: IndexSeries = {
      id: "test-synthetic-series",
      title: "سریِ ساختگیِ آزمون — شاخصِ واقعی نیست",
      granularity: "monthly",
      baseNote: "ساختگی",
      review: { status: "pending-legal-review", reviewedBy: null, reviewedOn: null },
      sources: ["ساختگی برای آزمون"],
      values: { "1400-01": "100", "1401-01": "150" },
    };
    const out = must(
      executeCalcTool(
        "late_payment",
        {
          principalRials: 1_000_000,
          index: { mode: "series", seriesId: "test-synthetic-series", dueDate: { year: 1400, month: 1, day: 10 }, paymentDate: { year: 1401, month: 1, day: 20 } },
        },
        { latePaymentSeries: [fixture] },
      ),
    );
    expect(out.result).toMatchObject({ mode: "series", seriesId: "test-synthetic-series", damagesRials: 500_000, totalRials: 1_500_000 });
  });
});

/* ───────────── وضعیتِ بازبینی، یادداشت‌ها، تغییرناپذیری ───────────── */

describe("calc-tools: وضعیتِ بازبینی و یادداشت‌ها هرگز گم نمی‌شوند", () => {
  it("با داده‌های پیش‌فرض reviewPending=true و review از خودِ legal-calc است", () => {
    for (const out of [
      must(executeCalcTool("court_fee", courtArgs())),
      must(executeCalcTool("late_payment", lateArgs(1000, "100", "150"))),
    ]) {
      expect(out.reviewPending).toBe(true);
      expect(out.review.status).toBe("pending-legal-review");
      expect(out.review).toEqual((out.result as { review: unknown }).review);
      expect(out.notes.length).toBeGreaterThan(0);
      expect(out.notes).toEqual((out.result as { notes: unknown }).notes);
    }
  });

  it("فقط وقتی legal-calc بگوید «legally-verified» reviewPending=false می‌شود (جدولِ تزریقیِ آزمون)", () => {
    const base = COURT_FEE_TARIFFS.find((t) => t.year === 1405);
    if (!base) throw new Error("جدول ۱۴۰۵ نیست");
    const verified = { ...base, review: { status: "legally-verified" as const, reviewedBy: "آزمون", reviewedOn: "1405-01-01" } };
    const out = must(executeCalcTool("court_fee", courtArgs(), { courtFeeTariffs: [verified] }));
    expect(out.reviewPending).toBe(false);
    expect(out.review.status).toBe("legally-verified");
  });

  it("خروجی ژرف یخ‌زده و JSON-سازگار است؛ دست‌کاریِ آن به اجرای بعدی نشت نمی‌کند", () => {
    const a = must(executeCalcTool("court_fee", courtArgs()));
    expect(clone(a)).toEqual(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.result)).toBe(true);
    expect(() => {
      (a as { reviewPending: boolean }).reviewPending = false;
    }).toThrow(TypeError);
    expect(() => {
      (a.result as { feeRials: number }).feeRials = 1;
    }).toThrow(TypeError);
    expect(must(executeCalcTool("court_fee", courtArgs()))).toEqual(a);
  });

  it("قطعی است: دو اجرای هم‌ورودی نتیجهٔ برابر می‌دهند و ورودیِ مدل دست‌نخورده می‌ماند", () => {
    const args = courtArgs();
    const snapshot = clone(args);
    const x = executeCalcTool("court_fee", args);
    const y = executeCalcTool("court_fee", args);
    expect(x).toEqual(y);
    expect(args).toEqual(snapshot);
  });

  it("ورودیِ ابزار را نمی‌توان با دست‌کاریِ خروجی آلوده کرد: جدول‌های پیش‌فرض بی‌تغییرند", () => {
    const before = clone(COURT_FEE_TARIFFS);
    must(executeCalcTool("court_fee", courtArgs()));
    expect(clone(COURT_FEE_TARIFFS)).toEqual(before);
  });
});

/* ───────────── نامِ ابزار ───────────── */

describe("calc-tools: نامِ ابزار", () => {
  it("نامِ ناشناخته/خطرناک INVALID_INPUT است و ابزارهای موجود را می‌گوید (بی‌پرتاب)", () => {
    for (const name of ["", "nope", "__proto__", "constructor", "toString", "hasOwnProperty", "COURT_FEE", " court_fee", "court_fee ", 7, null, undefined, {}, []]) {
      const r = executeCalcTool(name, courtArgs());
      expect(r.ok, String(name)).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("INVALID_INPUT");
        expect(r.error.message).toContain("court_fee");
        expect(r.error.message).toContain("late_payment");
      }
    }
  });

  it("نامِ بسیار بلند در پیام بریده می‌شود (پیامِ خطا بی‌کران نیست)", () => {
    const r = executeCalcTool("x".repeat(10_000), {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message.length).toBeLessThan(300);
  });
});

/* ───────────── مرزِ JSON ───────────── */

describe("calc-tools: executeCalcToolJson", () => {
  it("برابرِ executeCalcTool با همان آرگومان‌هاست", () => {
    const args = courtArgs({ claim: { kind: "known", amountRials: 100_000_000_000 }, tierMethod: "whole-amount" });
    expect(executeCalcToolJson("court_fee", JSON.stringify(args))).toEqual(executeCalcTool("court_fee", args));
  });

  it("JSONِ خراب ⇒ PARSE_ERROR (نمی‌پرتابد)", () => {
    for (const bad of ["", "   ", "{", "{'a':1}", "undefined", "NaN", '{"a":1,}', "{\"date\":"]) {
      expect(executeCalcToolJson("court_fee", bad), JSON.stringify(bad)).toMatchObject({ ok: false, error: { code: "PARSE_ERROR" } });
    }
  });

  it("JSONِ معتبر ولی غیرِ شیء ⇒ INVALID_INPUT", () => {
    for (const bad of ["null", "[]", "5", '"s"', "true"]) {
      expect(executeCalcToolJson("court_fee", bad), bad).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    }
  });

  it("غیرِ رشته ⇒ INVALID_INPUT", () => {
    for (const bad of [undefined, null, 5, {}, []]) {
      expect(executeCalcToolJson("court_fee", bad)).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    }
  });

  it("سقفِ طول: دقیقاً سقف پذیرفته می‌شود (به مرحلهٔ بعد می‌رسد)، یکی بیشتر رد", () => {
    const pad = (n: number) => `{"a":"${"x".repeat(n)}"}`;
    const atLimit = pad(MAX_ARGS_JSON_LENGTH - 8);
    expect(atLimit.length).toBe(MAX_ARGS_JSON_LENGTH);
    const ok = executeCalcToolJson("court_fee", atLimit);
    expect(ok.ok).toBe(false);
    if (!ok.ok) expect(ok.error.message).toContain("ناشناخته"); // از سقف گذشت و به اعتبارسنجِ شما رسید
    const over = executeCalcToolJson("court_fee", pad(MAX_ARGS_JSON_LENGTH - 7));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error.message).toContain(String(MAX_ARGS_JSON_LENGTH));
  });

  it("کلیدِ __proto__ در JSON یک کلیدِ ناشناخته است و Object.prototype را آلوده نمی‌کند", () => {
    const json = '{"__proto__":{"polluted":true},"date":{"year":1405,"month":1,"day":1},"stage":"appeal","claim":{"kind":"unknown"}}';
    const r = executeCalcToolJson("court_fee", json);
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
