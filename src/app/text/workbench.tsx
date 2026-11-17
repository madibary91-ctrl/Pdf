"use client";

import { Fragment, useState } from "react";
import {
  ZWNJ,
  formatInteger,
  normalizeForDisplay,
  normalizeForStorage,
  normalizePersianText,
  parseInteger,
  searchKey,
  tokenize,
  type NormalizeOptions,
} from "@/modules/persian-text";
import { Badge, Card, ErrorNote, Field, Stat, inputClass } from "../_components/ui";

// نمونهٔ عمداً «کثیف»: ي/ك عربی، ارقام عربی، فاصله‌های اضافه، نیم‌فاصلهٔ غلط و نشانه‌گذاری لاتین.
const SAMPLE =
  "مادهٔ  ١٠ قانون مدني :   «هر كس مي تواند   كتاب ها ي خود را بفروشد»  ,  مشروط بر آنكه  مبلغ 1,500,000 ريال  پرداخت شود ?";

type Profile = "storage" | "display" | "search" | "custom";

const PROFILES: Array<{ id: Profile; label: string; hint: string }> = [
  { id: "storage", label: "ذخیره", hint: "محافظه‌کار؛ ارقام و اعراب دست‌نخورده" },
  { id: "display", label: "نمایش", hint: "ارقام فارسی، نیم‌فاصله، نشانه‌گذاری" },
  { id: "search", label: "کلید جست‌وجو", hint: "تهاجمی؛ فقط برای مقایسه" },
  { id: "custom", label: "سفارشی", hint: "گزینه‌ها را خودتان انتخاب کنید" },
];

function Reveal({ text }: { text: string }) {
  // نمایش نویسه‌های نامرئی: نیم‌فاصله با نشانهٔ آبی، فاصله با نقطهٔ کم‌رنگ.
  return (
    <>
      {text.split("").map((ch, i) => {
        if (ch === ZWNJ) {
          return (
            <span key={i} title="نیم‌فاصله (ZWNJ)" className="mx-px rounded-sm bg-sky-100 px-0.5 text-[9px] text-sky-700">
              ‌ZW
            </span>
          );
        }
        if (ch === "\n") return <Fragment key={i}>{"↵\n"}</Fragment>;
        return <Fragment key={i}>{ch}</Fragment>;
      })}
    </>
  );
}

export function TextWorkbench() {
  const [input, setInput] = useState(SAMPLE);
  const [profile, setProfile] = useState<Profile>("display");
  const [reveal, setReveal] = useState(true);
  const [custom, setCustom] = useState<Required<NormalizeOptions>>({
    digits: "persian",
    removeDiacritics: false,
    fixHalfSpace: true,
    localizePunctuation: true,
    fixPunctuationSpacing: true,
    foldHamza: false,
  });

  const output =
    profile === "storage"
      ? normalizeForStorage(input)
      : profile === "display"
        ? normalizeForDisplay(input)
        : profile === "search"
          ? searchKey(input)
          : normalizePersianText(input, custom);

  const tokens = tokenize(input);
  const changed = output !== input;
  const toggle = (k: "removeDiacritics" | "fixHalfSpace" | "localizePunctuation" | "fixPunctuationSpacing" | "foldHamza") =>
    setCustom((c) => ({ ...c, [k]: !c[k] }));

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="متن ورودی">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={9}
            dir="rtl"
            className={`${inputClass} leading-8`}
            aria-label="متن ورودی"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={() => setInput(SAMPLE)} className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs hover:bg-ink-50">
              نمونهٔ نامرتب
            </button>
            <button onClick={() => setInput("")} className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs hover:bg-ink-50">
              پاک کردن
            </button>
            <span className="text-[11px] text-ink-500">{input.length} نویسه</span>
          </div>
        </Card>

        <Card
          title="خروجی"
          hint={PROFILES.find((p) => p.id === profile)?.hint}
        >
          <div role="tablist" aria-label="پروفایل" className="mb-3 flex flex-wrap gap-1 rounded-lg bg-ink-50 p-1">
            {PROFILES.map((p) => (
              <button
                key={p.id}
                role="tab"
                aria-selected={profile === p.id}
                onClick={() => setProfile(p.id)}
                className={`rounded-md px-3 py-1.5 text-xs transition ${
                  profile === p.id ? "bg-white font-bold text-ink-900 shadow-sm" : "text-ink-700 hover:bg-white/60"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {profile === "custom" && (
            <div className="mb-3 grid gap-2 rounded-lg border border-ink-100 p-3 text-xs sm:grid-cols-2">
              <Field label="ارقام">
                <select
                  value={custom.digits}
                  onChange={(e) => setCustom((c) => ({ ...c, digits: e.target.value as "keep" | "persian" | "latin" }))}
                  className={inputClass}
                >
                  <option value="keep">بدون تغییر</option>
                  <option value="persian">فارسی (۱۲۳)</option>
                  <option value="latin">لاتین (123)</option>
                </select>
              </Field>
              <div className="space-y-1.5 pt-1">
                {(
                  [
                    ["removeDiacritics", "حذف اعراب"],
                    ["fixHalfSpace", "اصلاح نیم‌فاصله"],
                    ["localizePunctuation", "علامت‌های فارسی (؟ ، ؛)"],
                    ["fixPunctuationSpacing", "فاصله‌گذاری نشانه‌ها"],
                    ["foldHamza", "یکی‌کردن همزه‌ها"],
                  ] as const
                ).map(([k, label]) => (
                  <label key={k} className="flex items-center gap-2">
                    <input type="checkbox" checked={custom[k]} onChange={() => toggle(k)} />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div
            dir="rtl"
            className="min-h-40 whitespace-pre-wrap rounded-lg border border-ink-100 bg-ink-50/60 p-3 text-sm leading-8 text-ink-900"
            aria-live="polite"
          >
            {output === "" ? <span className="text-ink-300">—</span> : reveal ? <Reveal text={output} /> : output}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-xs text-ink-700">
              <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
              نمایش نیم‌فاصله‌ها
            </label>
            <div className="flex gap-2">
              {changed ? <Badge tone="gold">تغییر کرد</Badge> : <Badge tone="ok">بدون تغییر</Badge>}
              <Badge>{output.length} نویسه</Badge>
            </div>
          </div>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="واژه‌های کلید جست‌وجو" hint="«ماده ۱۰» و «ماده 10» و «مادهٔ ۱۰» همه به یک کلید می‌رسند.">
          <div className="flex min-h-10 flex-wrap gap-1.5" dir="rtl">
            {tokens.length === 0 && <span className="text-xs text-ink-300">واژه‌ای نیست</span>}
            {tokens.map((t, i) => (
              <span key={`${t}-${i}`} className="rounded-md border border-ink-100 bg-white px-2 py-1 text-xs text-ink-800">
                {t}
              </span>
            ))}
          </div>
        </Card>
        <NumberTool />
      </div>
    </div>
  );
}

function NumberTool() {
  const [text, setText] = useState("۱٬۲۳۴٬۵۶۷");
  const parsed = parseInteger(text);
  const [digits, setDigits] = useState<"persian" | "latin">("persian");
  const formatted = parsed.ok ? formatInteger(parsed.value, { digits }) : null;

  return (
    <Card title="عدد صحیح (مبلغ)" hint="پول در این پروژه همیشه عدد صحیح است؛ اعشار عمداً رد می‌شود.">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <Field label="عدد را هر شکلی بنویسید">
          <input value={text} onChange={(e) => setText(e.target.value)} className={`${inputClass} ltr-field`} />
        </Field>
        <Field label="ارقام خروجی">
          <select value={digits} onChange={(e) => setDigits(e.target.value as "persian" | "latin")} className={inputClass}>
            <option value="persian">فارسی</option>
            <option value="latin">لاتین</option>
          </select>
        </Field>
      </div>
      <div className="mt-3 space-y-3">
        {!parsed.ok && text.trim() !== "" && <ErrorNote>{parsed.error.message}</ErrorNote>}
        {parsed.ok && formatted?.ok && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Stat mono label="مقدار" value={String(parsed.value)} />
            <Stat label="قالب‌دهی‌شده" value={formatted.value} />
          </div>
        )}
      </div>
    </Card>
  );
}
