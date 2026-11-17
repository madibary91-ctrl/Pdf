/**
 * محاسبهٔ سهم‌الارث طبقهٔ اول + زوج/زوجه (قانون مدنی، مواد ۸۶۱ تا ۹۴۹) — موتور خالص.
 *
 * دامنه: پدر، مادر، فرزندان (پسر/دختر)، نوه‌ها (یک نسل، به‌عنوان قائم‌مقام)، زوج یا زوجه‌ها.
 * وجود برادر/خواهر فقط برای «حاجب مادر» لحاظ می‌شود. هر چیز خارج از این دامنه **خطای صریح** است، نه حدس.
 *
 * قاعدهٔ طلایی (مثل court-fee.ts و late-payment.ts): **هیچ کسر/عدد حقوقی اینجا نیست.** همهٔ کسرها،
 * وزن پسر و دختر، شرط حجب و ارجاع مواد از `inheritance-shares.ts` می‌آیند. اینجا فقط ثابت‌های فنی (۰، ۱، ۲) است.
 *
 * حساب: کسر دقیق با BigInt (صورت/مخرج، ساده‌شده)؛ هیچ‌جا Float نیست. تبدیل به ریال فقط یک «کف» دارد و
 * ریال‌های ته‌مانده جداگانه گزارش می‌شوند (`unallocatedRials`)؛ موتور آن را بی‌صدا به کسی نمی‌دهد.
 */
import { err, ok, type Result } from "@/modules/shared-types";
import { INHERITANCE_RULES } from "./inheritance-shares";
import type {
  ExactFraction,
  FractionPair,
  GrandchildLine,
  HeirRole,
  HeirShare,
  InheritanceInput,
  InheritanceOutcome,
  InheritanceResult,
  InheritanceRules,
  InheritanceStep,
  ShareBasis,
  Sex,
} from "./inheritance-types";

const ZERO = BigInt(0);
const ONE = BigInt(1);

/* ───────────────────────────── کسر دقیق ───────────────────────────── */

type Fr = Readonly<{ n: bigint; d: bigint }>;

function gcd(a: bigint, b: bigint): bigint {
  let x = a < ZERO ? -a : a;
  let y = b < ZERO ? -b : b;
  while (y !== ZERO) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function fr(n: bigint, d: bigint): Fr {
  // مخرج همیشه مثبت است (قاعده‌ها پیش از محاسبه اعتبارسنجی می‌شوند)
  const g = gcd(n, d) || ONE;
  return { n: n / g, d: d / g };
}

const FR_ZERO: Fr = fr(ZERO, ONE);
const FR_ONE: Fr = fr(ONE, ONE);

const fromPair = (p: FractionPair): Fr => fr(BigInt(p[0]), BigInt(p[1]));
const add = (a: Fr, b: Fr): Fr => fr(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Fr, b: Fr): Fr => fr(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Fr, b: Fr): Fr => fr(a.n * b.n, a.d * b.d);
const div = (a: Fr, b: Fr): Fr => fr(a.n * b.d, a.d * b.n);
const byInt = (a: Fr, k: number): Fr => mul(a, fr(BigInt(k), ONE));
const overInt = (a: Fr, k: number): Fr => div(a, fr(BigInt(k), ONE));
const cmp = (a: Fr, b: Fr): number => {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
};
const isZero = (a: Fr): boolean => a.n === ZERO;
const sum = (xs: readonly Fr[]): Fr => xs.reduce(add, FR_ZERO);
const text = (a: Fr): string => (a.d === ONE ? a.n.toString() : `${a.n}/${a.d}`);
const exact = (a: Fr): ExactFraction => ({ numerator: a.n.toString(), denominator: a.d.toString() });

/* ───────────────────────────── اعتبارسنجی ───────────────────────────── */

/** مشکل‌های قاعده‌ها (فایل داده) را برمی‌گرداند؛ فهرست خالی = سالم. */
export function validateInheritanceRules(r: InheritanceRules): string[] {
  const problems: string[] = [];
  const fractionKeys = Object.keys(r.fractions) as Array<keyof InheritanceRules["fractions"]>;
  for (const k of fractionKeys) {
    const [a, b] = r.fractions[k];
    if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0 || a > b) {
      problems.push(`کسر «${k}» نامعتبر است (صورت و مخرج باید عدد صحیح مثبت و کسر حداکثر یک باشد).`);
    }
  }
  const w = r.maleFemaleWeights;
  if (!Number.isInteger(w.male) || !Number.isInteger(w.female) || w.male <= 0 || w.female <= 0) {
    problems.push("وزن سهم پسر و دختر باید عدد صحیح مثبت باشد.");
  }
  if (!Number.isInteger(r.maxCount) || r.maxCount <= 0) problems.push("حد فنی شمارنده نامعتبر است.");
  if (r.motherHajib.length === 0) problems.push("شرط حجب مادر باید دست‌کم یک ردیف داشته باشد.");
  for (const t of r.motherHajib) {
    if (!Number.isInteger(t.brothers) || !Number.isInteger(t.sisters) || t.brothers < 0 || t.sisters < 0 || t.brothers + t.sisters === 0) {
      problems.push("ردیف نامعتبر در شرط حجب مادر.");
    }
  }
  if (r.review.status === "legally-verified" && (!r.review.reviewedBy || !r.review.reviewedOn)) {
    problems.push("قاعده‌های «تأییدشده» باید نام بازبین و تاریخ بازبینی داشته باشند.");
  }
  if (r.sources.length === 0) problems.push("قاعده‌ها باید دست‌کم یک منبع داشته باشند.");
  return problems;
}

function parseCount(value: unknown, what: string, max: number): Result<number> {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return err("INVALID_INPUT", `${what} باید عدد صحیح نامنفی باشد.`);
  }
  if (value > max) return err("OUT_OF_RANGE", `${what} بیش از حد مجاز فنی (${max}) است.`);
  return ok(value);
}

function parseFlag(value: unknown, what: string): Result<boolean> {
  if (typeof value !== "boolean") return err("INVALID_INPUT", `${what} باید درست/نادرست (boolean) باشد.`);
  return ok(value);
}

type Line = Readonly<{ rootSex: Sex; grandsons: number; granddaughters: number }>;

type Parsed = Readonly<{
  husband: boolean;
  wives: number;
  father: boolean;
  mother: boolean;
  sons: number;
  daughters: number;
  lines: readonly Line[];
  brothers: number;
  sisters: number;
  estate: number | undefined;
}>;

function parseInput(input: InheritanceInput, rules: InheritanceRules): Result<Parsed> {
  if (typeof input !== "object" || input === null) return err("INVALID_INPUT", "ورودی نامعتبر است.");
  const max = rules.maxCount;

  const husband = parseFlag(input.husband, "وضعیت شوهر");
  if (!husband.ok) return husband;
  const father = parseFlag(input.father, "وضعیت پدر");
  if (!father.ok) return father;
  const mother = parseFlag(input.mother, "وضعیت مادر");
  if (!mother.ok) return mother;

  const wives = parseCount(input.wives, "تعداد زوجه‌ها", max);
  if (!wives.ok) return wives;
  const sons = parseCount(input.sons, "تعداد پسران", max);
  if (!sons.ok) return sons;
  const daughters = parseCount(input.daughters, "تعداد دختران", max);
  if (!daughters.ok) return daughters;

  if (husband.value && wives.value > 0) {
    return err("INVALID_INPUT", "شوهر و زوجه هم‌زمان نمی‌توانند وارث باشند (متوفی یا مرد است یا زن).");
  }

  const rawLines = input.grandchildLines ?? [];
  if (!Array.isArray(rawLines)) return err("INVALID_INPUT", "خط‌های نوه باید فهرست باشد.");
  if (rawLines.length > max) return err("OUT_OF_RANGE", `تعداد خط‌های نوه بیش از حد مجاز فنی (${max}) است.`);
  const lines: Line[] = [];
  for (const [i, l] of (rawLines as readonly GrandchildLine[]).entries()) {
    const label = `خط نوهٔ ${i + 1}`;
    if (typeof l !== "object" || l === null) return err("INVALID_INPUT", `${label} نامعتبر است.`);
    if (l.rootSex !== "male" && l.rootSex !== "female") return err("INVALID_INPUT", `${label}: جنس فرزندِ فوت‌شده باید male یا female باشد.`);
    const gs = parseCount(l.grandsons, `${label}: تعداد نوهٔ پسر`, max);
    if (!gs.ok) return gs;
    const gd = parseCount(l.granddaughters, `${label}: تعداد نوهٔ دختر`, max);
    if (!gd.ok) return gd;
    if (gs.value + gd.value === 0) {
      return err("INVALID_INPUT", `${label}: دست‌کم یک نوهٔ زنده لازم است (فرزند فوت‌شدهٔ بدون نوهٔ زنده را وارد نکنید).`);
    }
    lines.push({ rootSex: l.rootSex, grandsons: gs.value, granddaughters: gd.value });
  }

  const rawSib = input.siblings ?? { brothers: 0, sisters: 0 };
  const brothers = parseCount(rawSib.brothers, "تعداد برادران", max);
  if (!brothers.ok) return brothers;
  const sisters = parseCount(rawSib.sisters, "تعداد خواهران", max);
  if (!sisters.ok) return sisters;

  let estate: number | undefined;
  if (input.estateRials !== undefined) {
    if (typeof input.estateRials !== "number" || !Number.isSafeInteger(input.estateRials) || input.estateRials < 0) {
      return err("INVALID_INPUT", "ترکه باید عدد صحیح نامنفی (ریال) و در محدودهٔ عدد امن باشد.");
    }
    estate = input.estateRials;
  }

  return ok({
    husband: husband.value,
    wives: wives.value,
    father: father.value,
    mother: mother.value,
    sons: sons.value,
    daughters: daughters.value,
    lines,
    brothers: brothers.value,
    sisters: sisters.value,
    estate,
  });
}

/* ───────────────────────────── محاسبه ───────────────────────────── */

type Entry = {
  key: string;
  role: HeirRole;
  label: string;
  count: number;
  basis: ShareBasis;
  group: Fr;
  lineIndex?: number;
  note?: string;
};

const ROLE_LABEL: Readonly<Record<HeirRole, string>> = {
  husband: "شوهر",
  wife: "زوجه",
  father: "پدر",
  mother: "مادر",
  son: "پسر",
  daughter: "دختر",
  grandson: "نوهٔ پسر",
  granddaughter: "نوهٔ دختر",
};

const SEX_LABEL: Readonly<Record<Sex, string>> = { male: "فرزند پسرِ فوت‌شده", female: "فرزند دخترِ فوت‌شده" };

export function calculateInheritance(
  input: InheritanceInput,
  rules: InheritanceRules = INHERITANCE_RULES,
): Result<InheritanceResult> {
  const problems = validateInheritanceRules(rules);
  if (problems.length > 0) return err("INVALID_INPUT", `قاعده‌های سهم‌الارث معتبر نیستند: ${problems.join(" | ")}`);
  const parsed = parseInput(input, rules);
  if (!parsed.ok) return parsed;
  const p = parsed.value;

  const refs = rules.refs;
  const fx = rules.fractions;
  const wM = rules.maleFemaleWeights.male;
  const wF = rules.maleFemaleWeights.female;
  const steps: InheritanceStep[] = [];

  const hasDirect = p.sons + p.daughters > 0;
  const hasLines = p.lines.length > 0;
  const byRepresentation = !hasDirect && hasLines;
  const hasDescendants = hasDirect || hasLines;
  const hasSpouse = p.husband || p.wives > 0;
  const hasParent = p.father || p.mother;

  if (!hasDescendants && !hasParent) {
    return err(
      "OUT_OF_RANGE",
      "هیچ وارثی از طبقهٔ اول (پدر، مادر، فرزند، نوه) وجود ندارد؛ محاسبهٔ طبقهٔ دوم و سوم (و حالت‌های فقط-زوج/زوجه) در این نسخه پشتیبانی نمی‌شود و حدس زده نمی‌شود.",
    );
  }

  // حاجب مادر: مادر و پدر هر دو زنده و تعداد برادر/خواهر ابوینی یا ابی به حد کافی
  const siblingsEnough = rules.motherHajib.some((t) => p.brothers >= t.brothers && p.sisters >= t.sisters);
  const motherHajib = p.mother && p.father && siblingsEnough;

  // فرض زوج/زوجه
  let spouseGroup = FR_ZERO;
  if (p.husband) spouseGroup = fromPair(hasDescendants ? fx.husbandWithDescendants : fx.husbandWithoutDescendants);
  else if (p.wives > 0) spouseGroup = fromPair(hasDescendants ? fx.wifeWithDescendants : fx.wifeWithoutDescendants);

  const entries: Entry[] = [];
  let outcome: InheritanceOutcome;

  steps.push({
    text: `وارث‌های طبقهٔ اول موجودند${hasSpouse ? " (به‌همراه زوج/زوجه که همراه همهٔ طبقه‌ها ارث می‌برد)" : ""}؛ طبقهٔ دوم و سوم ارث نمی‌برند.`,
    ref: refs.classOne,
  });

  if (hasSpouse) {
    steps.push({
      text: p.husband
        ? `شوهر ${text(spouseGroup)} از کل ترکه می‌برد (${hasDescendants ? "میت فرزند یا نوه دارد" : "میت فرزند و نوه ندارد"}).`
        : `زوجه${p.wives > 1 ? "‌ها" : ""} روی هم ${text(spouseGroup)} از کل ترکه می‌برند${p.wives > 1 ? ` و بالسویه میان ${p.wives} نفر تقسیم می‌شود` : ""} (${hasDescendants ? "میت فرزند یا نوه دارد" : "میت فرزند و نوه ندارد"}).`,
      ref: p.wives > 1 ? `${refs.spouseShare}؛ ${refs.wivesEqual}` : refs.spouseShare,
    });
    entries.push({
      key: p.husband ? "husband" : "wife",
      role: p.husband ? "husband" : "wife",
      label: p.husband ? ROLE_LABEL.husband : ROLE_LABEL.wife,
      count: p.husband ? 1 : p.wives,
      basis: "fard",
      group: spouseGroup,
    });
  }

  if (p.mother && p.father) {
    steps.push({
      text: motherHajib
        ? "مادر حاجب دارد: پدر زنده است و تعداد برادر/خواهر (ابوینی یا ابی) به حد شرط می‌رسد؛ سهم مادر کاهش می‌یابد و از «رد» بی‌بهره است."
        : "مادر حاجب ندارد (برادر/خواهرِ کافی با زنده‌بودن پدر نیست).",
      ref: refs.hajib,
    });
  }

  if (!hasDescendants) {
    /* ── بدون فرزند و نوه: فقط پدر و/یا مادر (و زوج/زوجه) ── */
    outcome = "no-descendants";
    const rest = sub(FR_ONE, spouseGroup);
    if (hasSpouse) steps.push({ text: `مابقی پس از سهم زوج/زوجه ${text(rest)} است و بین پدر و مادر طبق ماده‌های طبقهٔ اول تقسیم می‌شود.`, ref: refs.spouseShare });
    if (p.father && p.mother) {
      const motherPart = mul(rest, fromPair(motherHajib ? fx.motherWithoutDescendantsWithHajib : fx.motherWithoutDescendantsNoHajib));
      const fatherPart = sub(rest, motherPart);
      steps.push({
        text: `مادر ${text(motherPart)} و پدر باقی (${text(fatherPart)}) را می‌برد.`,
        ref: refs.parentsOnly,
      });
      entries.push({ key: "father", role: "father", label: ROLE_LABEL.father, count: 1, basis: "qarabat", group: fatherPart });
      entries.push({ key: "mother", role: "mother", label: ROLE_LABEL.mother, count: 1, basis: "fard", group: motherPart });
    } else if (p.father) {
      steps.push({ text: `پدر به‌تنهایی تمام مابقی (${text(rest)}) را می‌برد.`, ref: refs.parentsOnly });
      entries.push({ key: "father", role: "father", label: ROLE_LABEL.father, count: 1, basis: "qarabat", group: rest });
    } else {
      steps.push({ text: `مادر به‌تنهایی تمام مابقی (${text(rest)}) را می‌برد.`, ref: refs.parentsOnly });
      entries.push({
        key: "mother",
        role: "mother",
        label: ROLE_LABEL.mother,
        count: 1,
        basis: "fard-and-radd",
        group: rest,
        note: "فرض مادر به‌علاوهٔ رد",
      });
    }
  } else {
    /* ── با فرزند یا نوه ── */
    const slotsMale = hasDirect ? p.sons : p.lines.filter((l) => l.rootSex === "male").length;
    const slotsFemale = hasDirect ? p.daughters : p.lines.filter((l) => l.rootSex === "female").length;
    const parentFard = fromPair(fx.parentWithDescendants);
    const fatherFard = p.father ? parentFard : FR_ZERO;
    const motherFard = p.mother ? parentFard : FR_ZERO;
    const parentsFard = add(fatherFard, motherFard);

    if (byRepresentation) {
      steps.push({
        text: `میت فرزند بی‌واسطهٔ زنده ندارد؛ نوه‌ها قائم‌مقام فرزندِ فوت‌شدهٔ خود هستند: ${slotsMale} خط پسری و ${slotsFemale} خط دختری.`,
        ref: refs.grandchildren,
      });
    } else if (hasLines) {
      steps.push({
        text: "میت فرزند بی‌واسطهٔ زنده دارد؛ نوه‌ها (حتی نوهٔ فرزندِ فوت‌شده) ارث نمی‌برند.",
        ref: refs.grandchildrenExcluded,
      });
    }

    let perMaleSlot = FR_ZERO;
    let perFemaleSlot = FR_ZERO;
    let childBasis: ShareBasis;
    let fatherBasis: ShareBasis = "fard";
    let motherBasis: ShareBasis = "fard";
    const motherNote: string | undefined = motherHajib ? "حاجب دارد؛ از رد چیزی نمی‌برد" : undefined;
    let fatherGroup = fatherFard;
    let motherGroup = motherFard;

    if (slotsMale > 0) {
      /* پسر هست: پدر/مادر فرض می‌برند، باقی به قرابت میان فرزندان با نسبت پسر به دختر */
      outcome = "with-sons";
      childBasis = "qarabat";
      const rest = sub(sub(FR_ONE, spouseGroup), parentsFard);
      const weights = slotsMale * wM + slotsFemale * wF;
      perMaleSlot = div(byInt(rest, wM), fr(BigInt(weights), ONE));
      perFemaleSlot = div(byInt(rest, wF), fr(BigInt(weights), ONE));
      steps.push({
        text: `${p.father || p.mother ? "پدر و مادر هر کدام فرض خود را می‌برند و " : ""}مابقی ترکه (${text(rest)}) بین فرزندان تقسیم می‌شود؛ پسر ${wM} برابر دختر.`,
        ref: refs.childrenOnly,
      });
    } else {
      /* فقط دختر (یا خط دختری): فرض ۱/۲ یا ۲/۳؛ سپس نقص یا رد */
      const daughtersFard = fromPair(slotsFemale === 1 ? fx.onlyDaughter : fx.severalDaughters);
      const total = sum([spouseGroup, parentsFard, daughtersFard]);
      const c = cmp(total, FR_ONE);
      steps.push({
        text: `فقط دختر هست؛ فرض ${slotsFemale === 1 ? "دختر یگانه" : "دخترها روی هم"} ${text(daughtersFard)} است. جمع فرض‌ها (با زوج/زوجه و پدر/مادر) = ${text(total)}.`,
        ref: refs.parentsWithDaughters,
      });
      let daughtersGroup = daughtersFard;
      if (c === 0) {
        outcome = "daughters-only-exact";
        childBasis = "fard";
        steps.push({ text: "جمع فرض‌ها دقیقاً یک است؛ نه نقصی هست و نه رد.", ref: refs.parentsWithDaughters });
      } else if (c > 0) {
        outcome = "daughters-only-deficiency";
        childBasis = "fard-reduced";
        daughtersGroup = sub(sub(FR_ONE, spouseGroup), parentsFard);
        steps.push({
          text: `جمع فرض‌ها از یک بیشتر است (${text(total)}) و نقص فقط بر دختر/دخترها وارد می‌شود: سهم دخترها = ۱ − زوج/زوجه − پدر/مادر = ${text(daughtersGroup)}.`,
          ref: refs.deficiency,
        });
      } else {
        outcome = "daughters-only-radd";
        childBasis = "fard-and-radd";
        const surplus = sub(FR_ONE, total);
        const eligible: Array<{ who: "daughters" | "father" | "mother"; fard: Fr }> = [{ who: "daughters", fard: daughtersFard }];
        if (p.father) eligible.push({ who: "father", fard: fatherFard });
        if (p.mother && !motherHajib) eligible.push({ who: "mother", fard: motherFard });
        const eligibleTotal = sum(eligible.map((e) => e.fard));
        const bonus = (f: Fr): Fr => mul(surplus, div(f, eligibleTotal));
        daughtersGroup = add(daughtersFard, bonus(daughtersFard));
        if (p.father) {
          fatherGroup = add(fatherFard, bonus(fatherFard));
          fatherBasis = "fard-and-radd";
        }
        if (p.mother && !motherHajib) {
          motherGroup = add(motherFard, bonus(motherFard));
          motherBasis = "fard-and-radd";
        }
        steps.push({
          text: `جمع فرض‌ها کمتر از یک است؛ زیادی (${text(surplus)}) به نسبت فرض میان دخترها${p.father ? "، پدر" : ""}${
            p.mother && !motherHajib ? "، مادر" : ""
          } رد می‌شود (مجموع فرض‌های بهره‌مند از رد: ${text(eligibleTotal)}). زوج/زوجه${motherHajib ? " و مادرِ دارای حاجب" : ""} از رد چیزی نمی‌برند.`,
          ref: refs.radd,
        });
      }
      perFemaleSlot = overInt(daughtersGroup, slotsFemale);
      perMaleSlot = FR_ZERO;
    }

    if (p.father) {
      entries.push({ key: "father", role: "father", label: ROLE_LABEL.father, count: 1, basis: fatherBasis, group: fatherGroup });
    }
    if (p.mother) {
      entries.push({ key: "mother", role: "mother", label: ROLE_LABEL.mother, count: 1, basis: motherBasis, group: motherGroup, note: motherNote });
    }

    const slotShare = (sex: Sex): Fr => (sex === "male" ? perMaleSlot : perFemaleSlot);

    if (hasDirect) {
      if (p.sons > 0) entries.push({ key: "son", role: "son", label: ROLE_LABEL.son, count: p.sons, basis: childBasis, group: byInt(perMaleSlot, p.sons) });
      if (p.daughters > 0) {
        entries.push({ key: "daughter", role: "daughter", label: ROLE_LABEL.daughter, count: p.daughters, basis: childBasis, group: byInt(perFemaleSlot, p.daughters) });
      }
      // نوه‌هایی که با وجود فرزند بی‌واسطه ارث نمی‌برند
      p.lines.forEach((l, i) => {
        const idx = i + 1;
        const lineLabel = `خط ${idx}: ${SEX_LABEL[l.rootSex]}`;
        if (l.grandsons > 0) {
          entries.push({ key: `line-${idx}:grandson`, role: "grandson", label: `${ROLE_LABEL.grandson} (${lineLabel})`, count: l.grandsons, basis: "excluded", group: FR_ZERO, lineIndex: idx, note: "با وجود فرزند بی‌واسطه ارث نمی‌برد" });
        }
        if (l.granddaughters > 0) {
          entries.push({ key: `line-${idx}:granddaughter`, role: "granddaughter", label: `${ROLE_LABEL.granddaughter} (${lineLabel})`, count: l.granddaughters, basis: "excluded", group: FR_ZERO, lineIndex: idx, note: "با وجود فرزند بی‌واسطه ارث نمی‌برد" });
        }
      });
    } else {
      p.lines.forEach((l, i) => {
        const idx = i + 1;
        const lineTotal = slotShare(l.rootSex);
        const weights = l.grandsons * wM + l.granddaughters * wF;
        const lineLabel = `خط ${idx}: ${SEX_LABEL[l.rootSex]}`;
        const note = `قائم‌مقام فرزند ${l.rootSex === "male" ? "پسر" : "دختر"} فوت‌شده؛ سهم کل خط ${text(lineTotal)}`;
        steps.push({
          text: `خط ${idx} (${lineLabel}) سهمِ فرزندِ فوت‌شده یعنی ${text(lineTotal)} را می‌برد و درون خط پسر ${wM} برابر دختر تقسیم می‌شود.`,
          ref: refs.grandchildren,
        });
        if (l.grandsons > 0) {
          entries.push({
            key: `line-${idx}:grandson`,
            role: "grandson",
            label: `${ROLE_LABEL.grandson} (${lineLabel})`,
            count: l.grandsons,
            basis: childBasis,
            group: div(byInt(lineTotal, l.grandsons * wM), fr(BigInt(weights), ONE)),
            lineIndex: idx,
            note,
          });
        }
        if (l.granddaughters > 0) {
          entries.push({
            key: `line-${idx}:granddaughter`,
            role: "granddaughter",
            label: `${ROLE_LABEL.granddaughter} (${lineLabel})`,
            count: l.granddaughters,
            basis: childBasis,
            group: div(byInt(lineTotal, l.granddaughters * wF), fr(BigInt(weights), ONE)),
            lineIndex: idx,
            note,
          });
        }
      });
    }
  }

  // بررسی داخلی: مجموع سهم‌ها باید دقیقاً یک باشد
  const totalFr = sum(entries.map((e) => e.group));
  if (cmp(totalFr, FR_ONE) !== 0) {
    return err("INVALID_INPUT", `خطای داخلی: مجموع سهم‌ها یک نشد (${text(totalFr)}). این نتیجه نباید استفاده شود.`);
  }
  if (entries.some((e) => e.group.n < ZERO)) {
    return err("INVALID_INPUT", "خطای داخلی: سهم منفی محاسبه شد. این نتیجه نباید استفاده شود.");
  }

  // ریال: فقط کف؛ ته‌مانده جدا گزارش می‌شود
  const estateBig = p.estate === undefined ? undefined : BigInt(p.estate);
  let allocated = ZERO;
  const heirs: HeirShare[] = entries.map((e) => {
    const perPerson = overInt(e.group, e.count);
    const base: HeirShare = {
      key: e.key,
      role: e.role,
      label: e.label,
      count: e.count,
      basis: isZero(e.group) ? "excluded" : e.basis,
      groupFraction: exact(e.group),
      perPersonFraction: exact(perPerson),
      ...(e.lineIndex === undefined ? {} : { lineIndex: e.lineIndex }),
      ...(e.note === undefined ? {} : { note: e.note }),
    };
    if (estateBig === undefined) return base;
    const per = (estateBig * perPerson.n) / perPerson.d;
    const group = per * BigInt(e.count);
    allocated += group;
    return { ...base, perPersonRials: Number(per), groupRials: Number(group) };
  });

  return ok({
    heirs,
    total: exact(totalFr),
    ...(estateBig === undefined ? {} : { estateRials: p.estate, unallocatedRials: Number(estateBig - allocated) }),
    facts: { hasDescendants, descendantsByRepresentation: byRepresentation, motherHajib, outcome },
    steps,
    review: rules.review,
    rulesSources: rules.sources,
    notModeled: rules.notModeled,
  });
}
