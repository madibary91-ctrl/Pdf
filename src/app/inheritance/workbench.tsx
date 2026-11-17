"use client";

import { useMemo, useState } from "react";
import {
  INHERITANCE_RULES,
  calculateInheritance,
  type ExactFraction,
  type GrandchildLine,
  type HeirShare,
  type InheritanceInput,
  type InheritanceResult,
  type ShareBasis,
} from "@/modules/legal-calc";
import { formatInteger, parseInteger, toPersianDigits } from "@/modules/persian-text";
import { Badge, Card, ErrorNote, Field, Stat, inputClass } from "../_components/ui";

const fa = (n: number | string) => toPersianDigits(String(n));
const money = (n: number) => {
  const r = formatInteger(n);
  return r.ok ? r.value : String(n);
};

/** کسر برای نمایش؛ جهت چپ‌به‌راست تا «۱/۴» برعکس نشود. */
function Frac({ f }: { f: ExactFraction }) {
  return <bdi dir="ltr" className="font-mono">{f.denominator === "1" ? fa(f.numerator) : `${fa(f.numerator)}/${fa(f.denominator)}`}</bdi>;
}

/** درصد تقریبی فقط برای خوانایی؛ مرجع، کسر دقیق است. با عدد صحیح BigInt (بدون Float در محاسبه). */
function approxPercent(f: ExactFraction): string {
  const hundredths = Number((BigInt(f.numerator) * BigInt(10000)) / BigInt(f.denominator));
  return `${fa((hundredths / 100).toFixed(2)).replace(".", "٫")}٪`;
}

const BASIS_LABEL: Readonly<Record<ShareBasis, string>> = {
  fard: "فرض",
  qarabat: "قرابت (باقیمانده)",
  "fard-and-radd": "فرض + رد",
  "fard-reduced": "فرض با نقص",
  excluded: "ارث نمی‌برد",
};
const BASIS_TONE: Readonly<Record<ShareBasis, "ok" | "gold" | "warn" | "neutral">> = {
  fard: "ok",
  qarabat: "neutral",
  "fard-and-radd": "gold",
  "fard-reduced": "warn",
  excluded: "neutral",
};

function ReviewBanner({ review }: { review: InheritanceResult["review"] }) {
  if (review.status === "legally-verified") {
    return (
      <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs leading-6 text-emerald-900">
        قاعده‌ها توسط «{review.reviewedBy}» در تاریخ {fa(review.reviewedOn ?? "")} تأیید شده است.
      </p>
    );
  }
  return (
    <p role="status" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium leading-7 text-amber-900">
      ⚠️ کسرها و شرط‌ها هنوز <b>توسط حقوقدان تأیید نشده‌اند</b>. نتیجه فقط برآورد اولیه است و جایگزین نظر وکیل نیست؛ فقط{" "}
      <b>طبقهٔ اول + زوج/زوجه</b> پشتیبانی می‌شود.
    </p>
  );
}

function Counter({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      <input dir="ltr" inputMode="numeric" value={value} onChange={(e) => onChange(e.target.value)} className={`${inputClass} ltr-field font-mono`} placeholder="0" />
    </Field>
  );
}

type Spouse = "none" | "husband" | "wives";
type LineDraft = { rootSex: "male" | "female"; grandsons: string; granddaughters: string };

/** متن خالی = صفر؛ هر چیز دیگر باید عدد صحیح معتبر باشد (ارقام فارسی هم پذیرفته می‌شود). */
function count(text: string, what: string): { ok: true; value: number } | { ok: false; error: string } {
  if (text.trim() === "") return { ok: true, value: 0 };
  const n = parseInteger(text);
  if (!n.ok || n.value < 0) return { ok: false, error: `${what}: عدد صحیح نامنفی وارد کنید.` };
  return { ok: true, value: n.value };
}

export function InheritanceWorkbench() {
  const [spouse, setSpouse] = useState<Spouse>("none");
  const [wives, setWives] = useState("1");
  const [father, setFather] = useState(false);
  const [mother, setMother] = useState(false);
  const [sons, setSons] = useState("");
  const [daughters, setDaughters] = useState("");
  const [brothers, setBrothers] = useState("");
  const [sisters, setSisters] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [estateText, setEstateText] = useState("");
  const [unit, setUnit] = useState<"rial" | "toman">("toman");

  const outcome = useMemo((): { error: string } | { result: InheritanceResult } | null => {
    const w = spouse === "wives" ? count(wives, "تعداد زوجه‌ها") : ({ ok: true, value: 0 } as const);
    if (!w.ok) return { error: w.error };
    const s = count(sons, "تعداد پسران");
    if (!s.ok) return { error: s.error };
    const d = count(daughters, "تعداد دختران");
    if (!d.ok) return { error: d.error };
    const b = count(brothers, "تعداد برادران");
    if (!b.ok) return { error: b.error };
    const si = count(sisters, "تعداد خواهران");
    if (!si.ok) return { error: si.error };

    const parsedLines: GrandchildLine[] = [];
    for (const [i, l] of lines.entries()) {
      const gs = count(l.grandsons, `خط ${i + 1}: نوهٔ پسر`);
      if (!gs.ok) return { error: gs.error };
      const gd = count(l.granddaughters, `خط ${i + 1}: نوهٔ دختر`);
      if (!gd.ok) return { error: gd.error };
      parsedLines.push({ rootSex: l.rootSex, grandsons: gs.value, granddaughters: gd.value });
    }

    // فرم هنوز خالی است: خطا نشان نده
    if (spouse === "none" && !father && !mother && s.value + d.value === 0 && parsedLines.length === 0) return null;

    let estateRials: number | undefined;
    if (estateText.trim() !== "") {
      const n = parseInteger(estateText);
      if (!n.ok || n.value < 0) return { error: "ترکه را به‌صورت عدد صحیح نامنفی (بدون اعشار) وارد کنید." };
      estateRials = unit === "toman" ? n.value * 10 : n.value;
      if (!Number.isSafeInteger(estateRials)) return { error: "مبلغ ترکه بیش از حد بزرگ است." };
    }

    const input: InheritanceInput = {
      husband: spouse === "husband",
      wives: w.value,
      father,
      mother,
      sons: s.value,
      daughters: d.value,
      grandchildLines: parsedLines,
      siblings: { brothers: b.value, sisters: si.value },
      ...(estateRials === undefined ? {} : { estateRials }),
    };
    const r = calculateInheritance(input);
    return r.ok ? { result: r.value } : { error: r.error.message };
  }, [spouse, wives, father, mother, sons, daughters, brothers, sisters, lines, estateText, unit]);

  const updateLine = (i: number, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <div className="grid gap-5 lg:grid-cols-[24rem_1fr]">
      <Card title="وارث‌های زنده" hint="فقط وارث‌های واجد شرایط را وارد کنید؛ موانع ارث (قتل، کفر، لعان، ولدالزنا…) را موتور نمی‌سنجد.">
        <div className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-medium text-ink-700">زوج یا زوجه (زوجیت دائم)</legend>
            {(
              [
                ["none", "ندارد"],
                ["husband", "شوهر (متوفی زن است)"],
                ["wives", "زوجه (متوفی مرد است)"],
              ] as const
            ).map(([v, label]) => (
              <label key={v} className="flex items-center gap-2 text-sm">
                <input type="radio" name="spouse" checked={spouse === v} onChange={() => setSpouse(v)} /> {label}
              </label>
            ))}
            {spouse === "wives" && <Counter label="تعداد زوجه‌ها" value={wives} onChange={setWives} hint="سهم زوجه‌ها بالسویه تقسیم می‌شود." />}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-medium text-ink-700">پدر و مادر</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={father} onChange={(e) => setFather(e.target.checked)} /> پدر زنده است
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={mother} onChange={(e) => setMother(e.target.checked)} /> مادر زنده است
            </label>
          </fieldset>

          <div className="grid grid-cols-2 gap-3">
            <Counter label="پسران (زنده)" value={sons} onChange={setSons} />
            <Counter label="دختران (زنده)" value={daughters} onChange={setDaughters} />
          </div>

          {father && mother && (
            <div className="rounded-xl border border-ink-100 bg-ink-50/60 p-3">
              <p className="mb-2 text-xs leading-6 text-ink-700">
                برادر/خواهرِ <b>ابوینی یا ابی</b> (نه امی): فقط برای تشخیص «حاجب مادر» لازم است؛ خودشان ارث نمی‌برند.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Counter label="برادر" value={brothers} onChange={setBrothers} />
                <Counter label="خواهر" value={sisters} onChange={setSisters} />
              </div>
            </div>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-ink-700">نوه‌ها (قائم‌مقام فرزندِ فوت‌شده)</span>
              <button
                type="button"
                onClick={() => setLines((ls) => [...ls, { rootSex: "male", grandsons: "", granddaughters: "" }])}
                className="rounded-lg border border-ink-200 px-2.5 py-1 text-xs text-ink-800 transition hover:bg-ink-50"
              >
                + افزودن خط
              </button>
            </div>
            {lines.length === 0 && <p className="text-[11px] leading-5 text-ink-500">هر خط = یک فرزندِ فوت‌شدهٔ میت که فرزندان زنده دارد. نوه‌ها فقط وقتی ارث می‌برند که میت هیچ فرزند بی‌واسطهٔ زنده نداشته باشد.</p>}
            {lines.map((l, i) => (
              <div key={i} className="space-y-2 rounded-xl border border-ink-100 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-ink-800">خط {fa(i + 1)}</span>
                  <button type="button" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} className="text-xs text-rose-700 hover:underline">
                    حذف
                  </button>
                </div>
                <Field label="فرزندِ فوت‌شده">
                  <select value={l.rootSex} onChange={(e) => updateLine(i, { rootSex: e.target.value as "male" | "female" })} className={inputClass}>
                    <option value="male">پسر</option>
                    <option value="female">دختر</option>
                  </select>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Counter label="نوهٔ پسر" value={l.grandsons} onChange={(v) => updateLine(i, { grandsons: v })} />
                  <Counter label="نوهٔ دختر" value={l.granddaughters} onChange={(v) => updateLine(i, { granddaughters: v })} />
                </div>
              </div>
            ))}
          </div>

          <Field label="خالص ترکه (اختیاری)" hint="پس از کسر کفن، دیون و وصیت نافذ. خالی = فقط کسرها.">
            <div className="flex gap-2">
              <input dir="ltr" inputMode="numeric" value={estateText} onChange={(e) => setEstateText(e.target.value)} className={`${inputClass} ltr-field font-mono`} placeholder="1,200,000,000" />
              <select aria-label="واحد" value={unit} onChange={(e) => setUnit(e.target.value as "rial" | "toman")} className={`${inputClass} !w-28`}>
                <option value="toman">تومان</option>
                <option value="rial">ریال</option>
              </select>
            </div>
          </Field>
        </div>
      </Card>

      <div className="space-y-5">
        {outcome === null && (
          <Card>
            <p className="text-sm text-ink-500">وارث‌ها را وارد کنید تا سهم‌ها محاسبه شود.</p>
          </Card>
        )}
        {outcome && "error" in outcome && <ErrorNote>{toPersianDigits(outcome.error)}</ErrorNote>}
        {outcome && "result" in outcome && <ResultView r={outcome.result} unit={unit} />}
        <RulesView />
      </div>
    </div>
  );
}

function ResultView({ r, unit }: { r: InheritanceResult; unit: "rial" | "toman" }) {
  const shown = (rials: number | undefined) => {
    if (rials === undefined) return "—";
    return unit === "toman" ? `${money(Math.floor(rials / 10))}${rials % 10 !== 0 ? "٫…" : ""}` : money(rials);
  };
  return (
    <Card title="نتیجه">
      <div className="space-y-4">
        <ReviewBanner review={r.review} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] text-right text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-xs text-ink-500">
                <th className="py-2 pl-3 font-medium">وارث</th>
                <th className="py-2 pl-3 font-medium">تعداد</th>
                <th className="py-2 pl-3 font-medium">مبنا</th>
                <th className="py-2 pl-3 font-medium">سهم گروه</th>
                <th className="py-2 pl-3 font-medium">سهم هر نفر</th>
                {r.estateRials !== undefined && <th className="py-2 font-medium">هر نفر ({unit === "toman" ? "تومان" : "ریال"})</th>}
              </tr>
            </thead>
            <tbody>
              {r.heirs.map((h: HeirShare) => (
                <tr key={h.key} className="border-b border-ink-50 align-top">
                  <td className="py-2.5 pl-3">
                    <div className="font-medium text-ink-900">{toPersianDigits(h.label)}</div>
                    {h.note && <div className="text-[11px] leading-5 text-ink-500">{toPersianDigits(h.note)}</div>}
                  </td>
                  <td className="py-2.5 pl-3">{fa(h.count)}</td>
                  <td className="py-2.5 pl-3">
                    <Badge tone={BASIS_TONE[h.basis]}>{BASIS_LABEL[h.basis]}</Badge>
                  </td>
                  <td className="py-2.5 pl-3">
                    <Frac f={h.groupFraction} />
                    <div className="text-[11px] text-ink-500">≈ {approxPercent(h.groupFraction)}</div>
                  </td>
                  <td className="py-2.5 pl-3">
                    <Frac f={h.perPersonFraction} />
                  </td>
                  {r.estateRials !== undefined && (
                    <td className="py-2.5">
                      <bdi>{shown(h.perPersonRials)}</bdi>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="text-xs text-ink-700">
                <td className="pt-3 font-bold" colSpan={3}>
                  جمع
                </td>
                <td className="pt-3 font-bold">
                  <Frac f={r.total} />
                </td>
                <td />
                {r.estateRials !== undefined && <td />}
              </tr>
            </tfoot>
          </table>
        </div>

        {r.estateRials !== undefined && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Stat label="خالص ترکه (ریال)" value={<bdi>{money(r.estateRials)}</bdi>} />
            <Stat label="ریال ته‌ماندهٔ تقسیم‌ناپذیر (به کسی داده نمی‌شود)" value={<bdi>{money(r.unallocatedRials ?? 0)}</bdi>} />
          </div>
        )}
        {r.estateRials !== undefined && (
          <p className="text-[11px] leading-5 text-ink-500">مبلغ هر نفر «کف» (گرد به پایین به ریال) است؛ سیاست تخصیص ته‌مانده با حقوقدان تعیین می‌شود.</p>
        )}

        <div className="rounded-xl border border-ink-100 bg-ink-50/60 p-4 text-sm leading-8">
          <div className="mb-1 text-xs font-medium text-ink-500">گام‌های محاسبه</div>
          <ol className="list-decimal space-y-1.5 pr-5">
            {r.steps.map((s, i) => (
              <li key={i}>
                {toPersianDigits(s.text)}
                {s.ref && <span className="mr-1 text-[11px] text-ink-500"> ({toPersianDigits(s.ref)})</span>}
              </li>
            ))}
          </ol>
        </div>

        <details className="text-xs text-ink-700">
          <summary className="cursor-pointer font-medium">منابع قاعده‌ها</summary>
          <ul className="mt-2 list-disc space-y-1 pr-5 leading-6">
            {r.rulesSources.map((s, i) => (
              <li key={i}>{toPersianDigits(s)}</li>
            ))}
          </ul>
        </details>
      </div>
    </Card>
  );
}

function RulesView() {
  const rules = INHERITANCE_RULES;
  return (
    <Card title="آنچه این میز مدل نمی‌کند" hint="دقیقاً محتوای inheritance-shares.ts؛ هیچ کسری در کد محاسبه نیست.">
      <div className="space-y-3">
        <ReviewBanner review={rules.review} />
        <ul className="list-disc space-y-1.5 pr-5 text-xs leading-6 text-ink-700">
          {rules.notModeled.map((n, i) => (
            <li key={i}>{toPersianDigits(n)}</li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
