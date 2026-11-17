"use client";

import { useMemo, useState } from "react";
import type { JalaliDate } from "@/modules/shared-types";
import { formatJalaliDate, parseJalaliDate } from "@/modules/jalali-date";
import {
  LATE_PAYMENT_INDEX_SERIES,
  LATE_PAYMENT_RULES,
  calculateLatePayment,
  type LatePaymentResult,
  type LatePaymentRules,
} from "@/modules/legal-calc";
import { formatInteger, parseInteger, toLatinDigits, toPersianDigits } from "@/modules/persian-text";
import { Badge, Card, ErrorNote, Field, Stat, inputClass } from "../_components/ui";

const fa = (n: number | string) => toPersianDigits(String(n));
const money = (n: number) => {
  const r = formatInteger(n);
  return r.ok ? r.value : String(n);
};
/** نقطهٔ مبنا → درصد خوانا (۲۳۰۹ → «۲۳٫۰۹٪»؛ منفی هم می‌شود) */
const percent = (bps: number) => `${toPersianDigits(String(bps / 100)).replace(".", "٫")}٪`;
/** شاخص برای نمایش: ارقام فارسی و جداکنندهٔ اعشار فارسی */
const indexText = (v: string) => toPersianDigits(v).replace(".", "٫");

const ROUNDING_LABEL = { ceil: "گرد به بالا", floor: "گرد به پایین", nearest: "گرد به نزدیک‌ترین ریال" } as const;
const DECREASE_LABEL = { "zero-damages": "خسارت صفر (هرگز منفی نمی‌شود)", error: "خطا" } as const;
const GRANULARITY_LABEL = { monthly: "ماهانه", annual: "سالانه" } as const;

/**
 * ورودی شاخص کاربر را برای موتور آماده می‌کند: ارقام فارسی/عربی → لاتین، «٫» → «.»،
 * و ویرگول **فقط** اگر جداکنندهٔ هزارگان باشد (۱٬۴۴۵٫۷۷۷). ویرگولِ مبهم (مثل «۱,۵») دست‌نخورده می‌ماند تا موتور
 * آن را رد کند؛ هرگز بی‌صدا به «۱۵» تبدیل نمی‌شود.
 */
function normalizeIndexInput(text: string): string {
  const s = toLatinDigits(text)
    .replace(/[\u200C\u200E\u200F\s]/g, "")
    .replace(/\u066B/g, ".")
    .replace(/[\u066C\u060C]/g, ",");
  return /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) ? s.replace(/,/g, "") : s;
}

function ReviewBanner({ review }: { review: LatePaymentResult["review"] | LatePaymentRules["review"] }) {
  if (review.status === "legally-verified") {
    return (
      <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs leading-6 text-emerald-900">
        قاعده‌ها و داده توسط «{review.reviewedBy}» در تاریخ {fa(review.reviewedOn ?? "")} تأیید شده است.
      </p>
    );
  }
  return (
    <p role="status" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium leading-7 text-amber-900">
      ⚠️ قاعده‌ها (و سری شاخص، در صورت استفاده) هنوز <b>توسط حقوقدان تأیید نشده‌اند</b>. نتیجه فقط برآورد اولیه است و جایگزین
      نظر وکیل نیست.
    </p>
  );
}

type Mode = "manual" | "series";

export function LatePaymentWorkbench({ today }: { today: JalaliDate }) {
  const hasSeries = LATE_PAYMENT_INDEX_SERIES.length > 0;
  const todayText = (() => {
    const r = formatJalaliDate(today);
    return r.ok ? r.value : "";
  })();

  const [mode, setMode] = useState<Mode>("manual");
  const [amountText, setAmountText] = useState("");
  const [unit, setUnit] = useState<"rial" | "toman">("toman");
  const [baseIndex, setBaseIndex] = useState("");
  const [paymentIndex, setPaymentIndex] = useState("");
  const [baseLabel, setBaseLabel] = useState("");
  const [paymentLabel, setPaymentLabel] = useState("");
  const [seriesId, setSeriesId] = useState(LATE_PAYMENT_INDEX_SERIES[0]?.id ?? "");
  const [dueText, setDueText] = useState("");
  const [paidText, setPaidText] = useState(todayText);

  const outcome = useMemo((): { error: string } | { result: LatePaymentResult } | null => {
    if (amountText.trim() === "") return null;
    const n = parseInteger(amountText);
    if (!n.ok) return { error: "اصل دین را به‌صورت عدد صحیح (بدون اعشار) وارد کنید." };
    const principalRials = unit === "toman" ? n.value * 10 : n.value;
    if (!Number.isSafeInteger(principalRials)) return { error: "مبلغ بیش از حد بزرگ است." };

    if (mode === "manual") {
      if (baseIndex.trim() === "" || paymentIndex.trim() === "") return null;
      const r = calculateLatePayment({
        principalRials,
        index: {
          mode: "manual",
          baseIndex: normalizeIndexInput(baseIndex),
          paymentIndex: normalizeIndexInput(paymentIndex),
          baseLabel,
          paymentLabel,
        },
      });
      return r.ok ? { result: r.value } : { error: r.error.message };
    }

    if (dueText.trim() === "" || paidText.trim() === "") return null;
    const due = parseJalaliDate(dueText);
    if (!due.ok) return { error: `تاریخ سررسید: ${due.error.message}` };
    const paid = parseJalaliDate(paidText);
    if (!paid.ok) return { error: `تاریخ تأدیه: ${paid.error.message}` };
    const r = calculateLatePayment({ principalRials, index: { mode: "series", seriesId, dueDate: due.value, paymentDate: paid.value } });
    return r.ok ? { result: r.value } : { error: r.error.message };
  }, [mode, amountText, unit, baseIndex, paymentIndex, baseLabel, paymentLabel, seriesId, dueText, paidText]);

  return (
    <div className="grid gap-5 lg:grid-cols-[22rem_1fr]">
      <Card title="ورودی" hint="مبلغ را به ریال یا تومان وارد کنید؛ ارقام فارسی و جداکنندهٔ هزارگان پذیرفته می‌شود.">
        <div className="space-y-4">
          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-medium text-ink-700">منبع شاخص</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="mode" checked={mode === "manual"} onChange={() => setMode("manual")} /> ورود دستی از جدول رسمی
            </label>
            <label className={`flex items-center gap-2 text-sm ${hasSeries ? "" : "text-ink-300"}`}>
              <input type="radio" name="mode" disabled={!hasSeries} checked={mode === "series"} onChange={() => setMode("series")} /> سری ثبت‌شده در فایل داده
              {!hasSeries && <Badge>هنوز سریِ تأییدشده‌ای ثبت نشده</Badge>}
            </label>
          </fieldset>

          <Field label="اصل دین">
            <div className="flex gap-2">
              <input dir="ltr" inputMode="numeric" value={amountText} onChange={(e) => setAmountText(e.target.value)} className={`${inputClass} ltr-field font-mono`} placeholder="100,000,000" />
              <select aria-label="واحد" value={unit} onChange={(e) => setUnit(e.target.value as "rial" | "toman")} className={`${inputClass} !w-28`}>
                <option value="toman">تومان</option>
                <option value="rial">ریال</option>
              </select>
            </div>
          </Field>

          {mode === "manual" ? (
            <>
              <Field label="شاخص زمان سررسید (مبنا)" hint="عدد شاخص، نه درصد تورم. مثل 1174.5">
                <input dir="ltr" inputMode="decimal" value={baseIndex} onChange={(e) => setBaseIndex(e.target.value)} className={`${inputClass} ltr-field font-mono`} placeholder="1174.5" />
              </Field>
              <Field label="شاخص زمان تأدیه" hint="از همان جدول و همان سال پایه.">
                <input dir="ltr" inputMode="decimal" value={paymentIndex} onChange={(e) => setPaymentIndex(e.target.value)} className={`${inputClass} ltr-field font-mono`} placeholder="1445.777" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="برچسب سررسید (اختیاری)">
                  <input value={baseLabel} onChange={(e) => setBaseLabel(e.target.value)} className={inputClass} placeholder="فروردین ۱۴۰۲" />
                </Field>
                <Field label="برچسب تأدیه (اختیاری)">
                  <input value={paymentLabel} onChange={(e) => setPaymentLabel(e.target.value)} className={inputClass} placeholder="خرداد ۱۴۰۴" />
                </Field>
              </div>
            </>
          ) : (
            <>
              <Field label="سری شاخص">
                <select value={seriesId} onChange={(e) => setSeriesId(e.target.value)} className={inputClass}>
                  {LATE_PAYMENT_INDEX_SERIES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title} — {GRANULARITY_LABEL[s.granularity]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="تاریخ سررسید (جلالی)" hint="مبدأ حقوقی (سررسید یا مطالبه) را خودتان تعیین می‌کنید.">
                <input dir="ltr" inputMode="numeric" value={dueText} onChange={(e) => setDueText(e.target.value)} className={`${inputClass} ltr-field font-mono`} placeholder="1402/01/15" />
              </Field>
              <Field label="تاریخ تأدیه (جلالی)">
                <input dir="ltr" inputMode="numeric" value={paidText} onChange={(e) => setPaidText(e.target.value)} className={`${inputClass} ltr-field font-mono`} placeholder={todayText} />
              </Field>
            </>
          )}
        </div>
      </Card>

      <div className="space-y-5">
        {outcome === null && (
          <Card>
            <p className="text-sm text-ink-500">اصل دین و شاخص‌ها را وارد کنید تا خسارت تأخیر تأدیه محاسبه شود.</p>
          </Card>
        )}
        {outcome && "error" in outcome && <ErrorNote>{toPersianDigits(outcome.error)}</ErrorNote>}
        {outcome && "result" in outcome && <ResultView r={outcome.result} />}
        <RulesView />
      </div>
    </div>
  );
}

function ResultView({ r }: { r: LatePaymentResult }) {
  return (
    <Card title="نتیجه">
      <div className="space-y-4">
        <ReviewBanner review={r.review} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="خسارت تأخیر تأدیه (ریال)" value={<bdi className="text-lg">{money(r.damagesRials)}</bdi>} />
          <Stat label="دین با احتساب خسارت (ریال)" value={<bdi className="text-lg">{money(r.totalRials)}</bdi>} />
          <Stat label="تغییر شاخص" value={<bdi>{percent(r.changeBps)}</bdi>} />
        </div>
        <p className="text-xs text-ink-500">
          معادل تومان: خسارت <bdi>{money(Math.round(r.damagesRials / 10))}</bdi> · کل <bdi>{money(Math.round(r.totalRials / 10))}</bdi>
          {r.damagesRials % 10 !== 0 || r.totalRials % 10 !== 0 ? " (تقریبی)" : ""}
        </p>

        <div className="rounded-xl border border-ink-100 bg-ink-50/60 p-4 text-sm leading-8">
          <div className="mb-1 text-xs font-medium text-ink-500">گام‌های محاسبه</div>
          <div>
            شاخص {r.baseIndex.label === "شاخص سررسید" ? "سررسید" : `سررسید (${toPersianDigits(r.baseIndex.label)})`}: <bdi>{indexText(r.baseIndex.value)}</bdi>
          </div>
          <div>
            شاخص {r.paymentIndex.label === "شاخص تأدیه" ? "تأدیه" : `تأدیه (${toPersianDigits(r.paymentIndex.label)})`}: <bdi>{indexText(r.paymentIndex.value)}</bdi>
          </div>
          <div>
            دین با احتساب خسارت = <bdi>{money(r.principalRials)}</bdi> × (<bdi>{indexText(r.paymentIndex.value)}</bdi> ÷ <bdi>{indexText(r.baseIndex.value)}</bdi>) = <b><bdi>{money(r.totalRials)}</bdi></b> ریال
          </div>
          <div>
            خسارت = <bdi>{money(r.totalRials)}</bdi> − <bdi>{money(r.principalRials)}</bdi> = <b><bdi>{money(r.damagesRials)}</bdi></b> ریال
          </div>
          <div className="text-xs text-ink-500">
            گردکردن: {ROUNDING_LABEL[r.rounding]}
            {r.roundingApplied ? " (اعمال شد)" : " (کسری نبود)"}
            {r.granularity && ` · سری ${GRANULARITY_LABEL[r.granularity]}`}
          </div>
        </div>

        {r.indexDecreased && (
          <div className="rounded-xl border border-gold-500/40 bg-gold-100/50 p-4 text-sm leading-7">
            <Badge tone="gold">ابهام حقوقی</Badge> شاخص تأدیه از شاخص سررسید کمتر است؛ قاعدهٔ فعلی خسارت را صفر می‌گیرد.
          </div>
        )}

        <ul className="list-disc space-y-1 pr-5 text-xs leading-6 text-ink-700">
          {r.notes.map((n, i) => (
            <li key={i}>{toPersianDigits(n)}</li>
          ))}
        </ul>

        <details className="text-xs text-ink-700">
          <summary className="cursor-pointer font-medium">منابع</summary>
          <ul className="mt-2 list-disc space-y-1 pr-5 leading-6">
            {r.sources.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </details>
      </div>
    </Card>
  );
}

function RulesView() {
  const rules = LATE_PAYMENT_RULES;
  return (
    <Card title="قاعده‌های فعلی" hint="دقیقاً محتوای late-payment-indices.ts؛ هیچ عددی در کد محاسبه نیست.">
      <div className="space-y-3">
        <ReviewBanner review={rules.review} />
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <Stat label="گردکردن کسر ریال" value={ROUNDING_LABEL[rules.rounding]} />
          <Stat label="وقتی شاخص تأدیه کمتر است" value={DECREASE_LABEL[rules.onIndexDecrease]} />
          <Stat label="سری‌های شاخص ثبت‌شده" value={LATE_PAYMENT_INDEX_SERIES.length === 0 ? "هیچ (عمداً)" : fa(LATE_PAYMENT_INDEX_SERIES.length)} />
        </dl>
        {LATE_PAYMENT_INDEX_SERIES.length === 0 && (
          <p className="text-xs leading-6 text-ink-700">
            عدد شاخص از منبع رسمی در دسترس نبود و از سایت‌های ثانویه (که دربارهٔ ماهانه/سالانه بودن با هم متناقض‌اند) هم برداشته نشد.
            به همین دلیل ورود دستی شاخص از جدول رسمی بانک مرکزی تنها مسیر عملیاتی است. جزئیات: یادداشت تحویل ۰۰۰۳.
          </p>
        )}
        <details className="text-xs text-ink-700">
          <summary className="cursor-pointer font-medium">منابع قاعده‌ها</summary>
          <ul className="mt-2 list-disc space-y-1 pr-5 leading-6">
            {rules.sources.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </details>
      </div>
    </Card>
  );
}
