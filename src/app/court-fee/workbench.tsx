"use client";

import { useMemo, useState } from "react";
import type { JalaliDate } from "@/modules/shared-types";
import { formatJalaliDate, parseJalaliDate } from "@/modules/jalali-date";
import {
  COURT_FEE_STAGE_ORDER,
  COURT_FEE_TARIFFS,
  calculateCourtFee,
  findCourtFeeTariff,
  type CourtFeeResult,
  type CourtFeeStage,
  type CourtFeeTariff,
  type RateTier,
  type TierMethod,
} from "@/modules/legal-calc";
import { formatInteger, parseInteger, toPersianDigits } from "@/modules/persian-text";
import { Badge, Card, ErrorNote, Field, Stat, inputClass } from "../_components/ui";

const fa = (n: number | string) => toPersianDigits(String(n));
const money = (n: number) => {
  const r = formatInteger(n);
  return r.ok ? r.value : String(n);
};
/** نقطهٔ مبنا → درصد خوانا (۲۵۰ → «۲٫۵٪») */
const percent = (bps: number) => `${toPersianDigits(String(bps / 100)).replace(".", "٫")}٪`;

const TIER_METHOD_OPTIONS: ReadonlyArray<{ value: TierMethod; label: string }> = [
  { value: "progressive", label: "پلکانی: هر بخش از مبلغ با نرخ پلهٔ خودش (تفکیک مبلغ)" },
  { value: "whole-amount", label: "کل مبلغ: همهٔ مبلغ با نرخ پله‌ای که مبلغ در آن می‌افتد" },
];

function tierLabel(tiers: readonly RateTier[], i: number): string {
  const prev = i > 0 ? (tiers[i - 1]?.upToRials ?? 0) : 0;
  const t = tiers[i]!;
  if (tiers.length === 1) return "همهٔ مبلغ";
  if (t.upToRials === null) return `بیش از ${money(prev)} ریال`;
  return i === 0 ? `تا ${money(t.upToRials)} ریال` : `از ${money(prev)} تا ${money(t.upToRials)} ریال`;
}

function ReviewBanner({ tariff }: { tariff: CourtFeeTariff }) {
  if (tariff.review.status === "legally-verified") {
    return (
      <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs leading-6 text-emerald-900">
        جدول سال {fa(tariff.year)} توسط «{tariff.review.reviewedBy}» در تاریخ {fa(tariff.review.reviewedOn ?? "")} تأیید شده است.
      </p>
    );
  }
  return (
    <p role="status" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium leading-7 text-amber-900">
      ⚠️ نرخ‌های جدول سال {fa(tariff.year)} هنوز <b>توسط حقوقدان تأیید نشده‌اند</b>. نتیجه فقط برآورد اولیه است و جایگزین نظر
      وکیل نیست.
    </p>
  );
}

export function CourtFeeWorkbench({ today }: { today: JalaliDate }) {
  const [dateText, setDateText] = useState(() => {
    const r = formatJalaliDate(today);
    return r.ok ? r.value : "";
  });
  const [stage, setStage] = useState<CourtFeeStage>("first-instance");
  const [claimKind, setClaimKind] = useState<"known" | "unknown">("known");
  const [amountText, setAmountText] = useState("");
  const [unit, setUnit] = useState<"rial" | "toman">("toman");
  const [method, setMethod] = useState<TierMethod | "">("");

  const outcome = useMemo((): { error: string } | { result: CourtFeeResult } | null => {
    const date = parseJalaliDate(dateText);
    if (!date.ok) return { error: date.error.message };

    let claim: Parameters<typeof calculateCourtFee>[0]["claim"] = { kind: "unknown" };
    if (claimKind === "known") {
      if (amountText.trim() === "") return null;
      const n = parseInteger(amountText);
      if (!n.ok) return { error: "مبلغ را به‌صورت عدد صحیح (بدون اعشار) وارد کنید." };
      claim = { kind: "known", amountRials: unit === "toman" ? n.value * 10 : n.value };
    }
    const r = calculateCourtFee({ date: date.value, stage, claim, tierMethod: method === "" ? undefined : method });
    return r.ok ? { result: r.value } : { error: r.error.message };
  }, [dateText, stage, claimKind, amountText, unit, method]);

  // جدول سال تاریخ واردشده برای نمایش جدول نرخ‌ها
  const parsedDate = parseJalaliDate(dateText);
  const shownTariff = (parsedDate.ok ? findCourtFeeTariff(parsedDate.value.year) : undefined) ?? COURT_FEE_TARIFFS[0];

  return (
    <div className="grid gap-5 lg:grid-cols-[22rem_1fr]">
      <Card title="ورودی" hint="مبلغ را به ریال یا تومان وارد کنید؛ ارقام فارسی و جداکنندهٔ هزارگان پذیرفته می‌شود.">
        <div className="space-y-4">
          <Field label="تاریخ مبنا (جلالی)" hint="فقط برای انتخاب جدول نرخِ همان سال (سال بودجه) است.">
            <input dir="ltr" inputMode="numeric" value={dateText} onChange={(e) => setDateText(e.target.value)} className={`${inputClass} ltr-field font-mono`} placeholder="1405/01/01" />
          </Field>

          <Field label="مرحلهٔ رسیدگی">
            <select value={stage} onChange={(e) => setStage(e.target.value as CourtFeeStage)} className={inputClass}>
              {COURT_FEE_STAGE_ORDER.map((s) => (
                <option key={s} value={s}>
                  {shownTariff?.stages[s].label ?? s}
                </option>
              ))}
            </select>
          </Field>

          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-medium text-ink-700">بهای خواسته</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="claim" checked={claimKind === "known"} onChange={() => setClaimKind("known")} /> معلوم است
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="claim" checked={claimKind === "unknown"} onChange={() => setClaimKind("unknown")} /> هنگام تقدیم دادخواست نامعلوم است
            </label>
          </fieldset>

          {claimKind === "known" && (
            <>
              <Field label={stage === "first-instance" ? "مبلغ خواسته" : "مبلغ محکوم‌به / مورد اعتراض"}>
                <div className="flex gap-2">
                  <input dir="ltr" inputMode="numeric" value={amountText} onChange={(e) => setAmountText(e.target.value)} className={`${inputClass} ltr-field font-mono`} placeholder="300,000,000" />
                  <select aria-label="واحد" value={unit} onChange={(e) => setUnit(e.target.value as "rial" | "toman")} className={`${inputClass} !w-28`}>
                    <option value="toman">تومان</option>
                    <option value="rial">ریال</option>
                  </select>
                </div>
              </Field>

              <Field label="روش اعمال نرخ پله‌ای" hint="فقط وقتی لازم است که مبلغ از آستانهٔ پلهٔ اول بگذرد. قانون بودجه این‌جا صریح نیست؛ پیش‌فرض پنهانی وجود ندارد.">
                <select value={method} onChange={(e) => setMethod(e.target.value as TierMethod | "")} className={inputClass}>
                  <option value="">— انتخاب کنید —</option>
                  {TIER_METHOD_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
        </div>
      </Card>

      <div className="space-y-5">
        {outcome === null && (
          <Card>
            <p className="text-sm text-ink-500">مبلغ را وارد کنید تا هزینهٔ دادرسی محاسبه شود.</p>
          </Card>
        )}
        {outcome && "error" in outcome && <ErrorNote>{toPersianDigits(outcome.error)}</ErrorNote>}
        {outcome && "result" in outcome && <ResultView r={outcome.result} />}
        {shownTariff && <TariffView tariff={shownTariff} />}
      </div>
    </div>
  );
}

function ResultView({ r }: { r: CourtFeeResult }) {
  const tariff = findCourtFeeTariff(r.tariffYear)!;
  const tomanExact = r.feeRials % 10 === 0;
  return (
    <Card title={`نتیجه — ${r.stageLabel} · جدول سال ${fa(r.tariffYear)}`}>
      <div className="space-y-4">
        <ReviewBanner tariff={tariff} />
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="هزینهٔ دادرسی (ریال)" value={<bdi className="text-lg">{money(r.feeRials)}</bdi>} />
          <Stat label={tomanExact ? "معادل تومان" : "معادل تومان (تقریبی)"} value={<bdi>{money(Math.round(r.feeRials / 10))}</bdi>} />
          <Stat label="مبنای محاسبه" value={r.baseAmountRials === null ? "بهای نامعلوم" : <bdi>{money(r.baseAmountRials)} ریال</bdi>} />
        </div>
        <p className="text-xs text-ink-500">مبنا: {r.basisLabel}</p>

        {r.tierMethod && r.alternativeFeeRials !== null && (
          <div className="rounded-xl border border-gold-500/40 bg-gold-100/50 p-4 text-sm leading-7">
            <div className="mb-1 flex items-center gap-2">
              <Badge tone="gold">ابهام حقوقی</Badge>
              <b>مقایسهٔ دو روش</b>
            </div>
            <ul className="space-y-1">
              {(["progressive", "whole-amount"] as const).map((m) => {
                const value = m === r.tierMethod ? r.feeRials : r.alternativeFeeRials!;
                return (
                  <li key={m} className={m === r.tierMethod ? "font-bold" : "text-ink-700"}>
                    {m === "progressive" ? "پلکانی" : "کل مبلغ"}: <bdi>{money(value)}</bdi> ریال {m === r.tierMethod && "← انتخاب شما"}
                  </li>
                );
              })}
            </ul>
            <p className="mt-1 text-xs text-ink-700">اختلاف: <bdi>{money(Math.abs(r.feeRials - r.alternativeFeeRials))}</bdi> ریال</p>
          </div>
        )}

        {r.steps.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-right text-sm">
              <thead>
                <tr className="border-b border-ink-100 text-xs text-ink-500">
                  <th className="py-2 font-medium">بخش</th>
                  <th className="py-2 font-medium">مبلغ بخش (ریال)</th>
                  <th className="py-2 font-medium">نرخ</th>
                </tr>
              </thead>
              <tbody>
                {r.steps.map((s, i) => (
                  <tr key={i} className="border-b border-ink-50">
                    <td className="py-2">
                      <bdi>{s.fromRials === 0 && s.toRials === null ? "کل مبلغ" : `${money(s.fromRials)} ← ${s.toRials === null ? "بدون سقف" : money(s.toRials)}`}</bdi>
                    </td>
                    <td className="py-2"><bdi>{money(s.baseRials)}</bdi></td>
                    <td className="py-2"><bdi>{percent(s.rateBps)}</bdi></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <ul className="list-disc space-y-1 pr-5 text-xs leading-6 text-ink-700">
          {r.notes.map((n, i) => (
            <li key={i}>{toPersianDigits(n)}</li>
          ))}
        </ul>

        <details className="text-xs text-ink-700">
          <summary className="cursor-pointer font-medium">منابع جدول</summary>
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

function TariffView({ tariff }: { tariff: CourtFeeTariff }) {
  return (
    <Card title={`جدول نرخ سال ${fa(tariff.year)}`} hint="دقیقاً محتوای فایل court-fee-tariffs.ts؛ هیچ عددی در کد محاسبه نیست.">
      <div className="space-y-3">
        <ReviewBanner tariff={tariff} />
        <div className="overflow-x-auto">
          <table className="w-full text-right text-sm">
            <thead>
              <tr className="border-b border-ink-100 text-xs text-ink-500">
                <th className="py-2 font-medium">مرحله</th>
                <th className="py-2 font-medium">نرخ</th>
                <th className="py-2 font-medium">بهای نامعلوم</th>
              </tr>
            </thead>
            <tbody>
              {COURT_FEE_STAGE_ORDER.map((s) => {
                const shown = tariff.stages[s];
                const own = shown.kind === "same-as" ? tariff.stages[shown.sameAs] : shown;
                if (own.kind !== "own") return null;
                return (
                  <tr key={s} className="border-b border-ink-50 align-top">
                    <td className="py-2">
                      {shown.label}
                      {shown.kind === "same-as" && <span className="mr-1 text-[11px] text-ink-500">(هم‌نرخ {tariff.stages[shown.sameAs].label})</span>}
                    </td>
                    <td className="py-2">
                      {own.tiers.map((t, i) => (
                        <div key={i}>
                          <bdi>{percent(t.rateBps)}</bdi> <span className="text-xs text-ink-500">{tierLabel(own.tiers, i)}</span>
                        </div>
                      ))}
                    </td>
                    <td className="py-2">{own.unknownValueFeeRials === null ? "—" : <bdi>{money(own.unknownValueFeeRials)} ریال</bdi>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}
