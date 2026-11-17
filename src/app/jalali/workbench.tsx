"use client";

import { useMemo, useState } from "react";
import type { GregorianDate, JalaliDate } from "@/modules/shared-types";
import {
  JALALI_MONTH_NAMES,
  JALALI_WEEKDAY_NAMES,
  MAX_JALALI_YEAR,
  MIN_JALALI_YEAR,
  addDays,
  addMonths,
  addYears,
  compareJalaliDates,
  computeDeadline,
  diffInDays,
  formatJalaliDate,
  gregorianToJalali,
  isFriday,
  isJalaliLeapYear,
  jalaliMonthLength,
  jalaliToGregorian,
  parseJalaliDate,
  weekdayIndex,
  type DeadlineUnit,
} from "@/modules/jalali-date";
import { toLatinDigits, toPersianDigits } from "@/modules/persian-text";
import { Badge, Card, ErrorNote, Field, Stat, inputClass } from "../_components/ui";

const fa = (n: number | string) => toPersianDigits(String(n));
const full = (d: JalaliDate) => {
  const r = formatJalaliDate(d, { style: "full" });
  return r.ok ? r.value : "—";
};
const numeric = (d: JalaliDate) => {
  const r = formatJalaliDate(d);
  return r.ok ? r.value : "—";
};
const gregText = (g: GregorianDate) =>
  `${g.year}-${String(g.month).padStart(2, "0")}-${String(g.day).padStart(2, "0")}`;

const TABS = [
  { id: "calendar", label: "تقویم" },
  { id: "convert", label: "تبدیل تاریخ" },
  { id: "deadline", label: "مهلت‌ها" },
  { id: "math", label: "حساب تاریخ" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function JalaliWorkbench({ today }: { today: JalaliDate }) {
  const [tab, setTab] = useState<TabId>("calendar");
  return (
    <div className="space-y-5">
      <div role="tablist" aria-label="ابزارهای تاریخ" className="flex flex-wrap gap-1 rounded-xl border border-ink-100 bg-white p-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-lg px-4 py-2 text-sm transition ${
              tab === t.id ? "bg-ink-800 font-bold text-white" : "text-ink-700 hover:bg-ink-50"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "calendar" && <CalendarTool today={today} />}
      {tab === "convert" && <ConvertTool today={today} />}
      {tab === "deadline" && <DeadlineTool today={today} />}
      {tab === "math" && <MathTool today={today} />}
    </div>
  );
}

/* ---------------------------- تقویم ---------------------------- */

function CalendarTool({ today }: { today: JalaliDate }) {
  const [year, setYear] = useState(today.year);
  const [yearText, setYearText] = useState(String(today.year));
  const [month, setMonth] = useState(today.month);
  const [selected, setSelected] = useState<JalaliDate>(today);

  const goTo = (y: number, m: number) => {
    setYear(y);
    setYearText(String(y));
    setMonth(m);
  };

  const len = jalaliMonthLength(year, month);
  const first = weekdayIndex({ year, month, day: 1 });
  const leap = isJalaliLeapYear(year);
  const cells = useMemo(() => {
    if (!len.ok || !first.ok) return [];
    const out: Array<JalaliDate | null> = Array.from({ length: first.value }, () => null);
    for (let d = 1; d <= len.value; d += 1) out.push({ year, month, day: d });
    return out;
  }, [len, first, year, month]);

  const step = (delta: number) => {
    const r = addMonths({ year, month, day: 1 }, delta);
    if (r.ok) goTo(r.value.year, r.value.month);
  };

  const selG = jalaliToGregorian(selected);
  const selW = weekdayIndex(selected);

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button onClick={() => step(-1)} aria-label="ماه قبل" className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50">
              ›
            </button>
            <button onClick={() => step(1)} aria-label="ماه بعد" className="rounded-lg border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50">
              ‹
            </button>
            <button
              onClick={() => {
                goTo(today.year, today.month);
                setSelected(today);
              }}
              className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs hover:bg-ink-50"
            >
              امروز
            </button>
          </div>
          <div className="flex items-center gap-2">
            <select aria-label="ماه" value={month} onChange={(e) => setMonth(Number(e.target.value))} className={`${inputClass} !w-auto`}>
              {JALALI_MONTH_NAMES.map((n, i) => (
                <option key={n} value={i + 1}>
                  {n}
                </option>
              ))}
            </select>
            <input
              aria-label="سال"
              inputMode="numeric"
              value={yearText}
              onChange={(e) => {
                const text = toLatinDigits(e.target.value);
                setYearText(text);
                const y = Number(text);
                if (/^\d{4}$/.test(text) && y >= MIN_JALALI_YEAR && y <= MAX_JALALI_YEAR) setYear(y);
              }}
              onBlur={() => setYearText(String(year))}
              className={`${inputClass} ltr-field !w-24`}
            />
          </div>
        </div>

        <div className="mb-2 text-center">
          <div className="text-lg font-extrabold text-ink-900">
            {JALALI_MONTH_NAMES[month - 1]} {fa(year)}
          </div>
          <div className="mt-1 flex justify-center gap-2">
            {len.ok && <Badge>{fa(len.value)} روز</Badge>}
            {leap.ok && <Badge tone={leap.value ? "gold" : "neutral"}>{leap.value ? "سال کبیسه" : "سال عادی"}</Badge>}
          </div>
        </div>

        <div className="grid grid-cols-7 gap-1.5 text-center">
          {JALALI_WEEKDAY_NAMES.map((w, i) => (
            <div key={w} className={`py-2 text-[11px] font-bold ${i === 6 ? "text-rose-700" : "text-ink-500"}`}>
              {w}
            </div>
          ))}
          {cells.map((d, i) => {
            if (!d) return <div key={`b${i}`} />;
            const g = jalaliToGregorian(d);
            const isToday = compareJalaliDates(d, today) === 0;
            const isSel = compareJalaliDates(d, selected) === 0;
            const fri = isFriday(d);
            return (
              <button
                key={d.day}
                onClick={() => setSelected(d)}
                aria-pressed={isSel}
                aria-label={full(d)}
                className={`relative flex aspect-square flex-col items-center justify-center rounded-xl border text-sm transition ${
                  isSel
                    ? "border-ink-800 bg-ink-800 text-white"
                    : isToday
                      ? "border-gold-500 bg-gold-100 font-bold text-ink-900"
                      : fri
                        ? "border-transparent bg-rose-50/70 text-rose-700 hover:border-rose-200"
                        : "border-transparent bg-ink-50/60 text-ink-900 hover:border-ink-200"
                }`}
              >
                <span className="text-base font-bold leading-none">{fa(d.day)}</span>
                {g.ok && <span className={`mt-1 text-[10px] leading-none ${isSel ? "text-ink-200" : "text-ink-300"}`}>{g.value.day}</span>}
              </button>
            );
          })}
        </div>
      </Card>

      <Card title="روز انتخاب‌شده">
        <div className="space-y-3">
          <Stat label="تاریخ کامل" value={full(selected)} />
          <Stat label="شمسی (عددی)" value={numeric(selected)} />
          {selG.ok && <Stat mono label="میلادی" value={gregText(selG.value)} />}
          {selW.ok && <Stat label="روز هفته" value={`${JALALI_WEEKDAY_NAMES[selW.value]}${selW.value === 6 ? " (تعطیل)" : ""}`} />}
        </div>
      </Card>
    </div>
  );
}

/* ---------------------------- تبدیل ---------------------------- */

function ConvertTool({ today }: { today: JalaliDate }) {
  const [jText, setJText] = useState(numeric(today));
  const [gText, setGText] = useState("2025-03-21");

  const j = parseJalaliDate(jText);
  const jg = j.ok ? jalaliToGregorian(j.value) : null;
  const jw = j.ok ? weekdayIndex(j.value) : null;
  const jl = j.ok ? isJalaliLeapYear(j.value.year) : null;

  const gMatch = /^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*$/.exec(gText);
  const gParsed = gMatch ? gregorianToJalali({ year: Number(gMatch[1]), month: Number(gMatch[2]), day: Number(gMatch[3]) }) : null;

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <Card title="شمسی ← میلادی" hint="ارقام فارسی، عربی و لاتین و جداکنندهٔ / - . پذیرفته می‌شود. سال باید چهاررقمی باشد.">
        <Field label="تاریخ شمسی">
          <input value={jText} onChange={(e) => setJText(e.target.value)} className={`${inputClass} ltr-field`} placeholder="۱۴۰۴/۰۱/۰۱" />
        </Field>
        <div className="mt-4 space-y-3">
          {!j.ok && jText.trim() !== "" && <ErrorNote>{j.error.message}</ErrorNote>}
          {j.ok && jg?.ok && (
            <>
              <Stat mono label="میلادی" value={gregText(jg.value)} />
              <Stat label="تاریخ کامل" value={full(j.value)} />
              <div className="flex flex-wrap gap-2">
                {jw?.ok && <Badge tone={jw.value === 6 ? "risk" : "neutral"}>{JALALI_WEEKDAY_NAMES[jw.value]}</Badge>}
                {jl?.ok && <Badge tone={jl.value ? "gold" : "neutral"}>{jl.value ? "سال کبیسه" : "سال عادی"}</Badge>}
              </div>
            </>
          )}
        </div>
      </Card>

      <Card title="میلادی ← شمسی" hint="قالب سال-ماه-روز، مثل 2025-03-21">
        <Field label="تاریخ میلادی">
          <input value={gText} onChange={(e) => setGText(e.target.value)} className={`${inputClass} ltr-field`} placeholder="2025-03-21" />
        </Field>
        <div className="mt-4 space-y-3">
          {gText.trim() !== "" && !gMatch && <ErrorNote>قالب نامعتبر است؛ نمونه: 2025-03-21</ErrorNote>}
          {gParsed && !gParsed.ok && <ErrorNote>{gParsed.error.message}</ErrorNote>}
          {gParsed?.ok && (
            <>
              <Stat label="شمسی" value={numeric(gParsed.value)} />
              <Stat label="تاریخ کامل" value={full(gParsed.value)} />
            </>
          )}
        </div>
      </Card>
    </div>
  );
}

/* ---------------------------- مهلت ---------------------------- */

function DeadlineTool({ today }: { today: JalaliDate }) {
  const [start, setStart] = useState(numeric(today));
  const [amount, setAmount] = useState("20");
  const [unit, setUnit] = useState<DeadlineUnit>("day");
  const [countStart, setCountStart] = useState(false);
  const [roll, setRoll] = useState(true);
  const [holidays, setHolidays] = useState("");

  const s = parseJalaliDate(start);

  const holidaySet = useMemo(() => {
    const set = new Set<string>();
    const bad: string[] = [];
    for (const line of holidays.split(/[\n,؛;]+/).map((x) => x.trim()).filter(Boolean)) {
      const p = parseJalaliDate(line);
      if (p.ok) set.add(`${p.value.year}/${p.value.month}/${p.value.day}`);
      else bad.push(line);
    }
    return { set, bad };
  }, [holidays]);

  const n = Number(toLatinDigits(amount));
  const result = s.ok
    ? computeDeadline({
        start: s.value,
        amount: n,
        unit,
        countStartDay: countStart,
        rollOverNonWorkingDay: roll,
        isNonWorkingDay: (d) => isFriday(d) || holidaySet.set.has(`${d.year}/${d.month}/${d.day}`),
      })
    : null;

  const remaining = result?.ok ? diffInDays(today, result.value.due) : null;

  return (
    <div className="grid gap-5 lg:grid-cols-[22rem_1fr]">
      <Card title="ورودی‌ها">
        <div className="space-y-4">
          <Field label="تاریخ مبدأ (مثلاً روز ابلاغ)">
            <input value={start} onChange={(e) => setStart(e.target.value)} className={`${inputClass} ltr-field`} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="مدت">
              <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" className={`${inputClass} ltr-field`} />
            </Field>
            <Field label="واحد">
              <select value={unit} onChange={(e) => setUnit(e.target.value as DeadlineUnit)} className={inputClass}>
                <option value="day">روز</option>
                <option value="month">ماه</option>
                <option value="year">سال</option>
              </select>
            </Field>
          </div>
          <label className="flex items-start gap-2 text-sm leading-6">
            <input type="checkbox" checked={countStart} onChange={(e) => setCountStart(e.target.checked)} className="mt-1.5" />
            <span>روز مبدأ جزو مهلت شمرده شود</span>
          </label>
          <label className="flex items-start gap-2 text-sm leading-6">
            <input type="checkbox" checked={roll} onChange={(e) => setRoll(e.target.checked)} className="mt-1.5" />
            <span>اگر آخرین روز غیرکاری بود، به روز کاری بعد منتقل شود</span>
          </label>
          <Field label="تعطیلات رسمی (اختیاری)" hint="هر خط یک تاریخ شمسی. جمعه همیشه غیرکاری است. این ماژول جدول تعطیلات ندارد؛ شما وارد می‌کنید.">
            <textarea
              value={holidays}
              onChange={(e) => setHolidays(e.target.value)}
              rows={3}
              className={`${inputClass} ltr-field`}
              placeholder={"1405/01/02\n1405/01/03"}
            />
          </Field>
          {holidaySet.bad.length > 0 && <ErrorNote>تاریخ‌های نامعتبر نادیده گرفته شد: {holidaySet.bad.join("، ")}</ErrorNote>}
        </div>
      </Card>

      <Card title="نتیجه">
        {!s.ok && start.trim() !== "" && <ErrorNote>{s.error.message}</ErrorNote>}
        {result && !result.ok && <ErrorNote>{result.error.message}</ErrorNote>}
        {result?.ok && (
          <div className="space-y-5">
            <div className="rounded-2xl bg-ink-800 p-5 text-white">
              <div className="text-xs text-ink-200">پایان مهلت</div>
              <div className="mt-1 text-2xl font-extrabold leading-9">{full(result.value.due)}</div>
              <div className="ltr-field mt-1 font-mono text-xs text-ink-300">
                {(() => {
                  const g = jalaliToGregorian(result.value.due);
                  return g.ok ? gregText(g.value) : "";
                })()}
              </div>
              {remaining?.ok && (
                <div className="mt-3 text-sm text-gold-100">
                  {remaining.value > 0
                    ? `${fa(remaining.value)} روز از امروز مانده است`
                    : remaining.value === 0
                      ? "مهلت امروز تمام می‌شود"
                      : `${fa(-remaining.value)} روز از پایان مهلت گذشته است`}
                </div>
              )}
              {result.value.rolledOver && <div className="mt-2 text-xs text-gold-100">پیش از انتقال: {full(result.value.rawDue)}</div>}
            </div>
            <div>
              <h3 className="mb-2 text-sm font-bold text-ink-900">گام‌های محاسبه</h3>
              <ol className="space-y-1.5 text-sm leading-7 text-ink-800">
                {result.value.steps.map((line, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="mt-1 grid size-5 shrink-0 place-items-center rounded-full bg-ink-100 text-[10px] font-bold text-ink-700">{fa(i + 1)}</span>
                    <span>{line}</span>
                  </li>
                ))}
              </ol>
            </div>
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-900">
              این محاسبه فقط گزینه‌هایی را اجرا می‌کند که شما انتخاب کرده‌اید. اینکه در مورد قانونی شما روز ابلاغ شمرده شود یا مهلت
              به روز کاری منتقل شود، تصمیم حقوقی است و باید با وکیل تأیید شود.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ---------------------------- حساب تاریخ ---------------------------- */

function MathTool({ today }: { today: JalaliDate }) {
  const [base, setBase] = useState(numeric(today));
  const [amount, setAmount] = useState("30");
  const [other, setOther] = useState("1405/12/29");
  const b = parseJalaliDate(base);
  const o = parseJalaliDate(other);
  const n = amount.trim() === "" ? Number.NaN : Number(toLatinDigits(amount));

  const rows =
    b.ok && Number.isInteger(n)
      ? [
          { label: `${fa(n)} روز بعد`, r: addDays(b.value, n) },
          { label: `${fa(n)} روز قبل`, r: addDays(b.value, -n) },
          { label: `${fa(n)} ماه بعد`, r: addMonths(b.value, n) },
          { label: `${fa(n)} ماه قبل`, r: addMonths(b.value, -n) },
          { label: `${fa(n)} سال بعد`, r: addYears(b.value, n) },
        ]
      : [];
  const diff = b.ok && o.ok ? diffInDays(b.value, o.value) : null;

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <Card title="جمع و تفریق" hint="اگر روز در ماه مقصد وجود نداشته باشد (مثلاً ۳۱ شهریور + ۱ ماه)، آخرین روز ماه می‌آید.">
        <div className="grid grid-cols-2 gap-3">
          <Field label="تاریخ پایه">
            <input value={base} onChange={(e) => setBase(e.target.value)} className={`${inputClass} ltr-field`} />
          </Field>
          <Field label="مقدار">
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" className={`${inputClass} ltr-field`} />
          </Field>
        </div>
        <div className="mt-4 space-y-2">
          {!b.ok && base.trim() !== "" && <ErrorNote>{b.error.message}</ErrorNote>}
          {b.ok && !Number.isInteger(n) && <ErrorNote>مقدار باید عدد صحیح باشد.</ErrorNote>}
          {rows.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-3 rounded-xl border border-ink-100 px-4 py-2.5 text-sm">
              <span className="text-ink-500">{row.label}</span>
              <span className="font-bold text-ink-900">{row.r.ok ? full(row.r.value) : row.r.error.message}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card title="فاصلهٔ دو تاریخ">
        <div className="grid grid-cols-2 gap-3">
          <Field label="از">
            <input value={base} onChange={(e) => setBase(e.target.value)} className={`${inputClass} ltr-field`} />
          </Field>
          <Field label="تا">
            <input value={other} onChange={(e) => setOther(e.target.value)} className={`${inputClass} ltr-field`} />
          </Field>
        </div>
        <div className="mt-4 space-y-3">
          {!o.ok && other.trim() !== "" && <ErrorNote>{o.error.message}</ErrorNote>}
          {diff?.ok && (
            <>
              <Stat label="تعداد روز" value={`${fa(diff.value)} روز${diff.value < 0 ? " (تاریخ دوم قبل از اول است)" : ""}`} />
              <Stat label="تقریبی" value={`${fa(Math.floor(Math.abs(diff.value) / 7))} هفته و ${fa(Math.abs(diff.value) % 7)} روز`} />
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
