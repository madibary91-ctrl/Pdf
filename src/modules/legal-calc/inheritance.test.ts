import { describe, expect, it } from "vitest";
import {
  INHERITANCE_RULES,
  calculateInheritance,
  validateInheritanceRules,
  type GrandchildLine,
  type HeirShare,
  type InheritanceInput,
  type InheritanceRules,
} from "./index";
import oracle from "./fixtures/inheritance-oracle.json";

/**
 * ⚠️ مرز اعتبار این تست‌ها (مثل legal-calc.test.ts و late-payment.test.ts):
 * - مقدارهای مورد انتظار یا (الف) با دست و از روی «متن مواد» حساب شده‌اند (بخش «مثال‌های کلاسیک»، با محاسبهٔ گام‌به‌گام
 *   در کامنت) یا (ب) از oracle مستقل Python (`tooling/oracles/inheritance_oracle.py`، حساب کسر دقیق، ساختار و زبان دیگر)
 *   آمده‌اند. هیچ‌کدام را حقوقدان ندیده است؛ فقط ثابت می‌کنند موتور همان قاعده‌های ثبت‌شده را بی‌خطای برنامه‌نویسی اجرا می‌کند،
 *   نه این‌که قاعده‌ها حقوقاً درست‌اند.
 * - نمونه‌های مرجع حقوقدان در بخش «it.todo» پایین اضافه شوند (AGENTS.md قاعدهٔ ۷).
 */

const BASE: InheritanceInput = { husband: false, wives: 0, father: false, mother: false, sons: 0, daughters: 0 };
const run = (over: Partial<InheritanceInput>, rules?: InheritanceRules) => calculateInheritance({ ...BASE, ...over }, rules);

/** سهم‌های گروه به‌صورت «کلید ← صورت/مخرج» */
function groups(heirs: readonly HeirShare[]): Record<string, string> {
  return Object.fromEntries(heirs.map((h) => [h.key, `${h.groupFraction.numerator}/${h.groupFraction.denominator}`]));
}
function shares(over: Partial<InheritanceInput>): Record<string, string> {
  const r = run(over);
  if (!r.ok) throw new Error(`انتظار موفقیت بود: ${r.error.message}`);
  return groups(r.value.heirs);
}
const male = (grandsons: number, granddaughters: number): GrandchildLine => ({ rootSex: "male", grandsons, granddaughters });
const female = (grandsons: number, granddaughters: number): GrandchildLine => ({ rootSex: "female", grandsons, granddaughters });

describe("legal-calc: سهم‌الارث — مثال‌های کلاسیک (محاسبهٔ دستی از روی متن مواد)", () => {
  it("شوهر + یک پسر: شوهر ۱/۴ (فرزند دارد)، پسر ۳/۴", () => {
    expect(shares({ husband: true, sons: 1 })).toEqual({ husband: "1/4", son: "3/4" });
  });

  it("زوجه + پدر + مادر (بی‌فرزند): زوجه ۱/۴؛ مابقی ۳/۴ → مادر ۱/۳ مابقی = ۱/۴ و پدر ۱/۲", () => {
    expect(shares({ wives: 1, father: true, mother: true })).toEqual({ wife: "1/4", father: "1/2", mother: "1/4" });
  });

  it("شوهر + پدر + مادر (بی‌فرزند): شوهر ۱/۲؛ مابقی ۱/۲ → مادر ۱/۶ و پدر ۱/۳", () => {
    expect(shares({ husband: true, father: true, mother: true })).toEqual({ husband: "1/2", father: "1/3", mother: "1/6" });
  });

  it("پدر + مادر (بی‌فرزند و بدون حاجب): مادر ۱/۳ و پدر ۲/۳", () => {
    expect(shares({ father: true, mother: true })).toEqual({ father: "2/3", mother: "1/3" });
  });

  it("پدر + مادر با حاجب (دو برادر): مادر ۱/۶ و پدر ۵/۶", () => {
    expect(shares({ father: true, mother: true, siblings: { brothers: 2, sisters: 0 } })).toEqual({ father: "5/6", mother: "1/6" });
  });

  it("پدر یا مادرِ تنها: تمام ترکه", () => {
    expect(shares({ father: true })).toEqual({ father: "1/1" });
    expect(shares({ mother: true })).toEqual({ mother: "1/1" });
  });

  it("پسر + دختر + پدر + مادر: پدر و مادر ۱/۶؛ مابقی ۲/۳ بین پسر و دختر ۲ به ۱ → پسر ۴/۹، دختر ۲/۹", () => {
    expect(shares({ sons: 1, daughters: 1, father: true, mother: true })).toEqual({ father: "1/6", mother: "1/6", son: "4/9", daughter: "2/9" });
  });

  it("فرزندان تنها: همه‌پسر یا همه‌دختر بالسویه؛ مختلط ۲ به ۱", () => {
    expect(shares({ sons: 3 })).toEqual({ son: "1/1" });
    expect(shares({ daughters: 3 })).toEqual({ daughter: "1/1" });
    expect(shares({ sons: 2, daughters: 1 })).toEqual({ son: "4/5", daughter: "1/5" });
  });

  it("دختر منحصر + پدر + مادر (رد): فرض ۱/۲ و ۱/۶ و ۱/۶؛ زیادی ۱/۶ به نسبت ۳:۱:۱ → دختر ۳/۵، پدر ۱/۵، مادر ۱/۵", () => {
    expect(shares({ daughters: 1, father: true, mother: true })).toEqual({ father: "1/5", mother: "1/5", daughter: "3/5" });
  });

  it("همان با حاجب مادر: مادر ۱/۶ و از رد بی‌بهره؛ دختر ۵/۸، پدر ۵/۲۴", () => {
    expect(shares({ daughters: 1, father: true, mother: true, siblings: { brothers: 2, sisters: 0 } })).toEqual({
      father: "5/24",
      mother: "1/6",
      daughter: "5/8",
    });
  });

  it("دختر منحصر + فقط پدر: دختر ۳/۴ و پدر ۱/۴ (رد به نسبت ۳:۱)", () => {
    expect(shares({ daughters: 1, father: true })).toEqual({ father: "1/4", daughter: "3/4" });
  });

  it("دختر منحصر + فقط مادر: دختر ۳/۴ و مادر ۱/۴ (مادر حاجب ندارد چون پدر نیست)", () => {
    expect(shares({ daughters: 1, mother: true, siblings: { brothers: 5, sisters: 5 } })).toEqual({ mother: "1/4", daughter: "3/4" });
  });

  it("زوجه + دختر منحصر: زوجه ۱/۸؛ زیادی فقط به دختر رد می‌شود → دختر ۷/۸", () => {
    expect(shares({ wives: 1, daughters: 1 })).toEqual({ wife: "1/8", daughter: "7/8" });
  });

  it("شوهر + دختر منحصر: شوهر ۱/۴ و دختر ۳/۴ (شوهر از رد چیزی نمی‌برد)", () => {
    expect(shares({ husband: true, daughters: 1 })).toEqual({ husband: "1/4", daughter: "3/4" });
  });

  it("نقص بر دختر: شوهر + پدر + مادر + دختر یگانه → ۱/۴ + ۱/۶ + ۱/۶ + ۱/۲ = ۱۳/۱۲؛ دختر ۱ − ۷/۱۲ = ۵/۱۲", () => {
    expect(shares({ husband: true, father: true, mother: true, daughters: 1 })).toEqual({
      husband: "1/4",
      father: "1/6",
      mother: "1/6",
      daughter: "5/12",
    });
  });

  it("نقص بر دخترها: زوجه + دو دختر + پدر + مادر → دخترها ۱ − ۱/۸ − ۱/۳ = ۱۳/۲۴ (هرکدام ۱۳/۴۸)", () => {
    const r = run({ wives: 1, daughters: 2, father: true, mother: true });
    expect(r.ok && groups(r.value.heirs)).toEqual({ wife: "1/8", father: "1/6", mother: "1/6", daughter: "13/24" });
    expect(r.ok && r.value.heirs.find((h) => h.key === "daughter")?.perPersonFraction).toEqual({ numerator: "13", denominator: "48" });
  });

  it("دو دختر + پدر + مادر: ۲/۳ + ۱/۶ + ۱/۶ = ۱؛ نه نقص و نه رد", () => {
    const r = run({ daughters: 2, father: true, mother: true });
    expect(r.ok && groups(r.value.heirs)).toEqual({ father: "1/6", mother: "1/6", daughter: "2/3" });
    expect(r.ok && r.value.facts.outcome).toBe("daughters-only-exact");
  });

  it("دو دختر + فقط پدر: ۲/۳ + ۱/۶ = ۵/۶؛ زیادی ۱/۶ به نسبت ۴:۱ → دخترها ۴/۵، پدر ۱/۵", () => {
    expect(shares({ daughters: 2, father: true })).toEqual({ father: "1/5", daughter: "4/5" });
  });

  it("چند زوجه بالسویه: دو زوجه + یک پسر → هر زوجه ۱/۱۶، پسر ۷/۸", () => {
    const r = run({ wives: 2, sons: 1 });
    expect(r.ok && groups(r.value.heirs)).toEqual({ wife: "1/8", son: "7/8" });
    expect(r.ok && r.value.heirs.find((h) => h.key === "wife")?.perPersonFraction).toEqual({ numerator: "1", denominator: "16" });
  });

  it("شوهر + مادر: شوهر ۱/۲، مادر ۱/۲ (مابقی)", () => {
    expect(shares({ husband: true, mother: true })).toEqual({ husband: "1/2", mother: "1/2" });
  });
});

describe("legal-calc: سهم‌الارث — نوه‌ها (قائم‌مقام فرزند)", () => {
  it("نوه بی‌فرزند بی‌واسطه: یک نوهٔ دختری از دختر فوت‌شده، تنها وارث، همهٔ ترکه", () => {
    expect(shares({ grandchildLines: [female(0, 1)] })).toEqual({ "line-1:granddaughter": "1/1" });
  });

  it("درون یک خط، پسر دو برابر دختر: خط پسری با یک نوهٔ پسر و یک نوهٔ دختر → ۲/۳ و ۱/۳", () => {
    expect(shares({ grandchildLines: [male(1, 1)] })).toEqual({ "line-1:grandson": "2/3", "line-1:granddaughter": "1/3" });
  });

  it("خط پسری دو برابر خط دختری: دو خط تکی → ۲/۳ و ۱/۳", () => {
    expect(shares({ grandchildLines: [male(1, 0), female(0, 1)] })).toEqual({ "line-1:grandson": "2/3", "line-2:granddaughter": "1/3" });
  });

  it("خط‌ها با ترکیب: (۱ نوهٔ پسر + ۲ نوهٔ دختر از پسر) و (۱ نوهٔ پسر + ۱ نوهٔ دختر از دختر) → خط‌ها ۲/۳ و ۱/۳", () => {
    // خط ۱: ۲/۳ بین وزن‌های ۲ و ۲ → هر گروه ۱/۳؛ خط ۲: ۱/۳ بین وزن‌های ۲ و ۱ → ۲/۹ و ۱/۹
    expect(shares({ grandchildLines: [male(1, 2), female(1, 1)] })).toEqual({
      "line-1:grandson": "1/3",
      "line-1:granddaughter": "1/3",
      "line-2:grandson": "2/9",
      "line-2:granddaughter": "1/9",
    });
  });

  it("نوه با پدر و مادر: نوهٔ پسری یک خط → پدر و مادر ۱/۶ و نوه ۲/۳ (مثل فرزند)", () => {
    expect(shares({ father: true, mother: true, grandchildLines: [male(1, 0)] })).toEqual({
      father: "1/6",
      mother: "1/6",
      "line-1:grandson": "2/3",
    });
  });

  it("خط دختری یگانه مثل دختر منحصر است: نوهٔ دختری + پدر + مادر → رد ۳:۱:۱", () => {
    expect(shares({ father: true, mother: true, grandchildLines: [female(0, 1)] })).toEqual({
      father: "1/5",
      mother: "1/5",
      "line-1:granddaughter": "3/5",
    });
  });

  it("نوه شرط «فرزند دارد» را برای زوج/زوجه برقرار می‌کند: شوهر ۱/۴", () => {
    expect(shares({ husband: true, grandchildLines: [male(1, 0)] })).toEqual({ husband: "1/4", "line-1:grandson": "3/4" });
  });

  it("با وجود فرزند بی‌واسطه، نوه‌ها ارث نمی‌برند (محروم) و سهم صفر گزارش می‌شوند", () => {
    const r = run({ sons: 1, grandchildLines: [male(2, 0)] });
    expect(r.ok && groups(r.value.heirs)).toEqual({ son: "1/1", "line-1:grandson": "0/1" });
    expect(r.ok && r.value.heirs.find((h) => h.key === "line-1:grandson")?.basis).toBe("excluded");
    expect(r.ok && r.value.facts.descendantsByRepresentation).toBe(false);
  });
});

describe("legal-calc: سهم‌الارث — حاجب مادر (حدود شرط)", () => {
  const motherShare = (siblings: InheritanceInput["siblings"], father = true) => shares({ father, mother: true, siblings })["mother"];

  it("دو برادر: حاجب (۱/۶)", () => expect(motherShare({ brothers: 2, sisters: 0 })).toBe("1/6"));
  it("یک برادر: حاجب نیست (۱/۳)", () => expect(motherShare({ brothers: 1, sisters: 0 })).toBe("1/3"));
  it("یک برادر و یک خواهر: حاجب نیست", () => expect(motherShare({ brothers: 1, sisters: 1 })).toBe("1/3"));
  it("یک برادر و دو خواهر: حاجب (۱/۶)", () => expect(motherShare({ brothers: 1, sisters: 2 })).toBe("1/6"));
  it("سه خواهر: حاجب نیست", () => expect(motherShare({ brothers: 0, sisters: 3 })).toBe("1/3"));
  it("چهار خواهر: حاجب (۱/۶)", () => expect(motherShare({ brothers: 0, sisters: 4 })).toBe("1/6"));
  it("بدون پدر حاجب برقرار نمی‌شود حتی با صد برادر: مادر تنها همه را می‌برد", () => {
    expect(motherShare({ brothers: 100, sisters: 100 }, false)).toBe("1/1");
  });
  it("facts.motherHajib درست گزارش می‌شود", () => {
    const yes = run({ father: true, mother: true, siblings: { brothers: 2, sisters: 0 } });
    const no = run({ father: true, mother: true, siblings: { brothers: 1, sisters: 1 } });
    expect(yes.ok && yes.value.facts.motherHajib).toBe(true);
    expect(no.ok && no.value.facts.motherHajib).toBe(false);
  });
});

describe("legal-calc: سهم‌الارث — مقایسه با oracle مستقل (Python)", () => {
  type Case = { input: InheritanceInput; expected: Record<string, string> | { error: string } };
  const cases = oracle as unknown as Case[];

  it("تعداد نمونه‌ها کافی و شامل خطاهای مورد انتظار است (حفاظت از خالی‌ماندن بی‌صدا)", () => {
    expect(cases.length).toBeGreaterThan(900);
    expect(cases.filter((c) => "error" in c.expected).length).toBeGreaterThan(0);
  });

  it("همهٔ نمونه‌ها: سهم هر گروه و مجموعهٔ کلیدها دقیقاً مطابق oracle است", () => {
    const mismatches: string[] = [];
    for (const c of cases) {
      const r = calculateInheritance(c.input);
      if ("error" in c.expected) {
        if (r.ok || r.error.code !== c.expected.error) mismatches.push(`${JSON.stringify(c.input)} → انتظار خطا ${c.expected.error}`);
        continue;
      }
      if (!r.ok) {
        mismatches.push(`${JSON.stringify(c.input)} → خطای غیرمنتظره: ${r.error.message}`);
        continue;
      }
      const got = groups(r.value.heirs);
      if (JSON.stringify(Object.entries(got).sort()) !== JSON.stringify(Object.entries(c.expected).sort())) {
        mismatches.push(`${JSON.stringify(c.input)}\n  موتور: ${JSON.stringify(got)}\n  oracle: ${JSON.stringify(c.expected)}`);
      }
    }
    expect(mismatches.slice(0, 5), `${mismatches.length} ناهمخوانی`).toEqual([]);
  });

  it("ویژگی‌های همیشگی روی همهٔ نمونه‌ها: مجموع = ۱، سهم منفی ندارد، سهم هر نفر × تعداد = سهم گروه، زوج/زوجه از رد نمی‌برند", () => {
    for (const c of cases) {
      const r = calculateInheritance(c.input);
      if (!r.ok) continue;
      expect(r.value.total).toEqual({ numerator: "1", denominator: "1" });
      for (const h of r.value.heirs) {
        const g = BigInt(h.groupFraction.numerator);
        const gd = BigInt(h.groupFraction.denominator);
        const pn = BigInt(h.perPersonFraction.numerator);
        const pd = BigInt(h.perPersonFraction.denominator);
        expect(g >= BigInt(0)).toBe(true);
        expect(pn * BigInt(h.count) * gd).toBe(g * pd);
        if (h.role === "husband" || h.role === "wife") {
          expect(h.basis).toBe("fard");
          expect(["1/2", "1/4", "1/8"]).toContain(`${h.groupFraction.numerator}/${h.groupFraction.denominator}`);
        }
      }
    }
  });
});

describe("legal-calc: سهم‌الارث — مبلغ ریالی (کف + ته‌مانده)", () => {
  it("شوهر + پسر با ترکهٔ ۱٬۲۰۰٬۰۰۰٬۰۰۰ ریال: ۳۰۰ و ۹۰۰ میلیون، بدون ته‌مانده", () => {
    const r = run({ husband: true, sons: 1, estateRials: 1_200_000_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.heirs.map((h) => [h.key, h.groupRials, h.perPersonRials])).toEqual([
      ["husband", 300_000_000, 300_000_000],
      ["son", 900_000_000, 900_000_000],
    ]);
    expect(r.value.unallocatedRials).toBe(0);
  });

  it("سه پسر و ۱۰۰۰ ریال: هر نفر ۳۳۳ (کف)، ۱ ریال ته‌مانده و به هیچ‌کس داده نمی‌شود", () => {
    const r = run({ sons: 3, estateRials: 1000 });
    expect(r.ok && r.value.heirs[0]).toMatchObject({ perPersonRials: 333, groupRials: 999 });
    expect(r.ok && r.value.unallocatedRials).toBe(1);
  });

  it("بزرگ‌ترین عدد امن (۹۰۰۷۱۹۹۲۵۴۷۴۰۹۹۱) بدون سرریز و بی‌خطای اعشار: سه پسر → هر نفر ۳۰۰۲۳۹۹۷۵۱۵۸۰۳۳۰ و ۱ ریال ته‌مانده", () => {
    const r = run({ sons: 3, estateRials: Number.MAX_SAFE_INTEGER });
    expect(r.ok && r.value.heirs[0]?.perPersonRials).toBe(3_002_399_751_580_330);
    expect(r.ok && r.value.unallocatedRials).toBe(1);
  });

  it("مجموع کف‌ها + ته‌مانده = ترکه، روی همهٔ نمونه‌های oracle با ترکهٔ ناهموار", () => {
    const estate = 1_234_567_891;
    type Case = { input: InheritanceInput };
    for (const c of oracle as unknown as Case[]) {
      const r = calculateInheritance({ ...c.input, estateRials: estate });
      if (!r.ok) continue;
      const total = r.value.heirs.reduce((s, h) => s + (h.groupRials ?? 0), 0);
      expect(total + (r.value.unallocatedRials ?? NaN)).toBe(estate);
      expect(r.value.unallocatedRials).toBeLessThan(r.value.heirs.reduce((s, h) => s + h.count, 0));
    }
  });

  it("بدون ترکه: فیلدهای ریالی ظاهر نمی‌شوند", () => {
    const r = run({ sons: 1 });
    expect(r.ok && "unallocatedRials" in r.value).toBe(false);
    expect(r.ok && r.value.heirs[0] && "groupRials" in r.value.heirs[0]).toBe(false);
  });

  it("ترکهٔ صفر مجاز است (همه صفر)", () => {
    const r = run({ sons: 1, estateRials: 0 });
    expect(r.ok && r.value.heirs[0]?.groupRials).toBe(0);
  });
});

describe("legal-calc: سهم‌الارث — خطا و ورودی نامعتبر (بدون throw)", () => {
  const code = (over: Partial<InheritanceInput>) => {
    const r = run(over);
    return r.ok ? "ok" : r.error.code;
  };

  it("هیچ وارث طبقهٔ اول نیست ← OUT_OF_RANGE (حدس نمی‌زند)", () => {
    expect(code({})).toBe("OUT_OF_RANGE");
    expect(code({ husband: true })).toBe("OUT_OF_RANGE");
    expect(code({ wives: 2 })).toBe("OUT_OF_RANGE");
    expect(code({ siblings: { brothers: 3, sisters: 0 } })).toBe("OUT_OF_RANGE");
  });

  it("پیام خطای خارج از دامنه به طبقهٔ دوم و سوم اشاره می‌کند", () => {
    const r = run({ husband: true });
    expect(!r.ok && r.error.message).toContain("طبقهٔ دوم و سوم");
  });

  it("شوهر و زوجه هم‌زمان ← INVALID_INPUT", () => {
    expect(code({ husband: true, wives: 1, sons: 1 })).toBe("INVALID_INPUT");
  });

  it("شمارندهٔ منفی/اعشاری/غیرعدد/NaN/Infinity ← INVALID_INPUT", () => {
    expect(code({ sons: -1 })).toBe("INVALID_INPUT");
    expect(code({ sons: 1.5 })).toBe("INVALID_INPUT");
    expect(code({ sons: Number.NaN })).toBe("INVALID_INPUT");
    expect(code({ daughters: Number.POSITIVE_INFINITY })).toBe("INVALID_INPUT");
    expect(code({ sons: "2" as unknown as number })).toBe("INVALID_INPUT");
    expect(code({ wives: -1, sons: 1 })).toBe("INVALID_INPUT");
  });

  it("پرچم غیر boolean ← INVALID_INPUT (مثلاً رشتهٔ «false» که truthy است)", () => {
    expect(code({ father: "false" as unknown as boolean, sons: 1 })).toBe("INVALID_INPUT");
    expect(code({ husband: 1 as unknown as boolean, sons: 1 })).toBe("INVALID_INPUT");
    expect(code({ mother: undefined as unknown as boolean, sons: 1 })).toBe("INVALID_INPUT");
  });

  it("بیش از حد فنی ← OUT_OF_RANGE", () => {
    expect(code({ sons: INHERITANCE_RULES.maxCount + 1 })).toBe("OUT_OF_RANGE");
    expect(code({ sons: INHERITANCE_RULES.maxCount })).toBe("ok");
  });

  it("ترکهٔ نامعتبر ← INVALID_INPUT", () => {
    expect(code({ sons: 1, estateRials: -1 })).toBe("INVALID_INPUT");
    expect(code({ sons: 1, estateRials: 1.5 })).toBe("INVALID_INPUT");
    expect(code({ sons: 1, estateRials: Number.MAX_SAFE_INTEGER + 2 })).toBe("INVALID_INPUT");
    expect(code({ sons: 1, estateRials: "100" as unknown as number })).toBe("INVALID_INPUT");
  });

  it("خط نوهٔ نامعتبر: جنس نامعتبر، بدون نوهٔ زنده، شمارندهٔ منفی ← INVALID_INPUT", () => {
    expect(code({ grandchildLines: [{ rootSex: "x" as unknown as "male", grandsons: 1, granddaughters: 0 }] })).toBe("INVALID_INPUT");
    expect(code({ grandchildLines: [male(0, 0)] })).toBe("INVALID_INPUT");
    expect(code({ grandchildLines: [male(-1, 2)] })).toBe("INVALID_INPUT");
    expect(code({ grandchildLines: "x" as unknown as GrandchildLine[] })).toBe("INVALID_INPUT");
  });

  it("ورودی null یا غیرشیء پرتاب نمی‌کند", () => {
    expect(calculateInheritance(null as unknown as InheritanceInput).ok).toBe(false);
    expect(calculateInheritance(undefined as unknown as InheritanceInput).ok).toBe(false);
  });
});

describe("legal-calc: سهم‌الارث — داده‌محور بودن و وضعیت بازبینی", () => {
  it("قاعده‌های ثبت‌شده معتبرند و «در انتظار بازبینی»", () => {
    expect(validateInheritanceRules(INHERITANCE_RULES)).toEqual([]);
    expect(INHERITANCE_RULES.review.status).toBe("pending-legal-review");
    expect(INHERITANCE_RULES.sources.length).toBeGreaterThan(0);
    expect(INHERITANCE_RULES.notModeled.length).toBeGreaterThan(0);
  });

  it("نتیجه وضعیت بازبینی، منبع‌ها و «مدل‌نشده‌ها» را حمل می‌کند", () => {
    const r = run({ sons: 1 });
    expect(r.ok && r.value.review.status).toBe("pending-legal-review");
    expect(r.ok && r.value.rulesSources).toEqual(INHERITANCE_RULES.sources);
    expect(r.ok && r.value.notModeled).toEqual(INHERITANCE_RULES.notModeled);
  });

  it("تغییر فقط فایل داده، نتیجه را عوض می‌کند: اگر فرض شوهر با فرزند ۱/۸ بود، شوهر ۱/۸ و پسر ۷/۸", () => {
    const custom: InheritanceRules = { ...INHERITANCE_RULES, fractions: { ...INHERITANCE_RULES.fractions, husbandWithDescendants: [1, 8] } };
    const r = run({ husband: true, sons: 1 }, custom);
    expect(r.ok && groups(r.value.heirs)).toEqual({ husband: "1/8", son: "7/8" });
  });

  it("وزن پسر و دختر از داده می‌آید: اگر برابر بود، پسر و دختر هر کدام نصف", () => {
    const custom: InheritanceRules = { ...INHERITANCE_RULES, maleFemaleWeights: { male: 1, female: 1 } };
    const r = run({ sons: 1, daughters: 1 }, custom);
    expect(r.ok && groups(r.value.heirs)).toEqual({ son: "1/2", daughter: "1/2" });
  });

  it("شرط حجب از داده می‌آید: با حذف همهٔ ردیف‌ها خطا؛ با ردیف «یک برادر» حاجب برقرار می‌شود", () => {
    const empty: InheritanceRules = { ...INHERITANCE_RULES, motherHajib: [] };
    expect(run({ sons: 1 }, empty).ok).toBe(false);
    const loose: InheritanceRules = { ...INHERITANCE_RULES, motherHajib: [{ brothers: 1, sisters: 0 }] };
    const r = run({ father: true, mother: true, siblings: { brothers: 1, sisters: 0 } }, loose);
    expect(r.ok && groups(r.value.heirs)).toEqual({ father: "5/6", mother: "1/6" });
  });

  it("قاعدهٔ تأییدشده با نام و تاریخ بازبین به نتیجه می‌رسد", () => {
    const verified: InheritanceRules = { ...INHERITANCE_RULES, review: { status: "legally-verified", reviewedBy: "حقوقدان آزمایشی", reviewedOn: "1405/01/01" } };
    const r = run({ sons: 1 }, verified);
    expect(r.ok && r.value.review).toEqual(verified.review);
  });

  it("ادعای تأیید بدون نام یا تاریخ بازبین نامعتبر است", () => {
    const bad: InheritanceRules = { ...INHERITANCE_RULES, review: { status: "legally-verified", reviewedBy: null, reviewedOn: null } };
    expect(validateInheritanceRules(bad).length).toBeGreaterThan(0);
    expect(run({ sons: 1 }, bad).ok).toBe(false);
  });

  it("کسر نامعتبر در داده گرفته می‌شود: صفر، منفی، بیشتر از یک، غیرصحیح", () => {
    const f = INHERITANCE_RULES.fractions;
    for (const pair of [[0, 2], [1, 0], [3, 2], [1.5, 2], [-1, 2]] as const) {
      const bad: InheritanceRules = { ...INHERITANCE_RULES, fractions: { ...f, parentWithDescendants: pair } };
      expect(validateInheritanceRules(bad).length, JSON.stringify(pair)).toBeGreaterThan(0);
      expect(run({ sons: 1, father: true }, bad).ok).toBe(false);
    }
  });

  it("وزن نامعتبر، حد فنی نامعتبر و بدون منبع گرفته می‌شود", () => {
    expect(validateInheritanceRules({ ...INHERITANCE_RULES, maleFemaleWeights: { male: 0, female: 1 } }).length).toBeGreaterThan(0);
    expect(validateInheritanceRules({ ...INHERITANCE_RULES, maxCount: 0 }).length).toBeGreaterThan(0);
    expect(validateInheritanceRules({ ...INHERITANCE_RULES, sources: [] }).length).toBeGreaterThan(0);
    expect(validateInheritanceRules({ ...INHERITANCE_RULES, motherHajib: [{ brothers: 0, sisters: 0 }] }).length).toBeGreaterThan(0);
  });
});

describe("legal-calc: سهم‌الارث — توضیح گام‌ها و برچسب‌ها", () => {
  it("هر گام ارجاع ماده از فایل داده دارد و نتیجهٔ رد/نقص گام مخصوص خود را دارد", () => {
    const radd = run({ daughters: 1, father: true, mother: true });
    expect(radd.ok && radd.value.steps.some((s) => s.ref === INHERITANCE_RULES.refs.radd)).toBe(true);
    const deficiency = run({ husband: true, daughters: 1, father: true, mother: true });
    expect(deficiency.ok && deficiency.value.steps.some((s) => s.ref === INHERITANCE_RULES.refs.deficiency)).toBe(true);
    expect(deficiency.ok && deficiency.value.facts.outcome).toBe("daughters-only-deficiency");
    expect(radd.ok && radd.value.facts.outcome).toBe("daughters-only-radd");
  });

  it("مبنای سهم: فرض / قرابت / فرض‌به‌علاوهٔ رد / فرض با کاهش", () => {
    const basis = (over: Partial<InheritanceInput>, key: string) => {
      const r = run(over);
      return r.ok ? r.value.heirs.find((h) => h.key === key)?.basis : undefined;
    };
    expect(basis({ sons: 1, father: true }, "son")).toBe("qarabat");
    expect(basis({ sons: 1, father: true }, "father")).toBe("fard");
    expect(basis({ daughters: 1, father: true, mother: true }, "daughter")).toBe("fard-and-radd");
    expect(basis({ daughters: 1, father: true, mother: true }, "father")).toBe("fard-and-radd");
    expect(basis({ husband: true, daughters: 1, father: true, mother: true }, "daughter")).toBe("fard-reduced");
    expect(basis({ daughters: 2, father: true, mother: true }, "daughter")).toBe("fard");
    expect(basis({ father: true, mother: true }, "father")).toBe("qarabat");
    expect(basis({ father: true, mother: true }, "mother")).toBe("fard");
  });

  it("مادرِ دارای حاجب در حالت رد، یادداشت «از رد چیزی نمی‌برد» دارد", () => {
    const r = run({ daughters: 1, father: true, mother: true, siblings: { brothers: 2, sisters: 0 } });
    expect(r.ok && r.value.heirs.find((h) => h.key === "mother")?.note).toContain("حاجب");
    expect(r.ok && r.value.heirs.find((h) => h.key === "mother")?.basis).toBe("fard");
  });

  it("ورودی دست‌نخورده می‌ماند (بدون تغییر ورودی)", () => {
    const input = Object.freeze({ ...BASE, sons: 1, grandchildLines: Object.freeze([Object.freeze(male(1, 1))]), siblings: Object.freeze({ brothers: 0, sisters: 0 }) });
    expect(calculateInheritance(input).ok).toBe(true);
  });
});

describe("legal-calc: سهم‌الارث — نمونه‌های مرجع حقوقدان (در انتظار)", () => {
  it.todo("نمونهٔ مرجع حقوقدان: زوجه + پدر + مادر (تأیید این‌که ثلث مادر از «مابقی» است نه از کل ترکه — ماده ۹۱۳)");
  it.todo("نمونهٔ مرجع حقوقدان: شرط دقیق حاجب مادر (ماده ۸۹۲-ب؛ منابع ثانویه «یک برادر یا دو خواهر» در برابر «یک برادر و دو خواهر»)");
  it.todo("نمونهٔ مرجع حقوقدان: نوه‌ها در چند نسل و رابطهٔ «اقرب ابعد را محروم می‌کند» میان خط‌های مختلف (مواد ۹۱۱ و ۹۱۲)");
  it.todo("نمونهٔ مرجع حقوقدان: محدودیت ارث زوجه از ابنیه و اشجار و تأثیر آن بر نسبت‌ها (مواد ۹۴۶ تا ۹۴۸، متن فعلی)");
  it.todo("نمونهٔ مرجع حقوقدان: ارث‌بردن شوهر از «رد» وقتی تنها وارث نیست و طبقهٔ اول وجود ندارد (ماده ۹۰۵؛ طبقهٔ دوم/سوم)");
  it.todo("نمونهٔ مرجع حقوقدان: ریال‌های ته‌ماندهٔ تقسیم‌ناپذیر (سیاست تخصیص یا نگه‌داشتن)");
});
