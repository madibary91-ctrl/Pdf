"use client";

import { useMemo, useState } from "react";
import { formatJalaliDate, gregorianToJalali, jalaliToGregorian, parseJalaliDate } from "@/modules/jalali-date";
import {
  FICTIONAL_SAMPLE_CORPUS,
  buildCorpusIndex,
  loadCorpusFromJson,
  relationsFor,
  resolveCitation,
  rulingsCiting,
  versionsInForceAt,
  type ArticleVersion,
  type CorpusIssue,
  type RelationType,
  type SubpartKind,
  type VersionLookup,
} from "@/modules/legal-kb-schema";
import { toPersianDigits } from "@/modules/persian-text";
import { Badge, Card, ErrorNote, Field, Stat, inputClass } from "../_components/ui";

const fa = (n: number | string) => toPersianDigits(String(n));
const SAMPLE_JSON = JSON.stringify(FICTIONAL_SAMPLE_CORPUS, null, 2);

/** تاریخ ISO میلادی → جلالی برای نمایش. */
function jalaliText(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const j = gregorianToJalali({ year: y, month: m, day: d });
  if (!j.ok) return iso;
  const f = formatJalaliDate(j.value);
  return f.ok ? f.value : iso;
}

const RELATION_LABEL: Readonly<Record<RelationType, string>> = {
  amends: "اصلاح می‌کند",
  repeals: "نسخ می‌کند",
  replaces: "جایگزین می‌شود",
  "refers-to": "ارجاع می‌دهد به",
  implements: "اجراکنندهٔ",
  interprets: "تفسیر می‌کند",
};

const KIND_LABEL = { constitution: "قانون اساسی", statute: "قانون", regulation: "آیین‌نامه", directive: "دستورالعمل", approval: "مصوبه" } as const;

function IssueList({ issues }: { issues: readonly CorpusIssue[] }) {
  return (
    <ul className="max-h-72 space-y-2 overflow-auto" aria-label="فهرست مسائل">
      {issues.map((i, k) => (
        <li key={k} className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-6 text-rose-900">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="risk">{i.code}</Badge>
            <bdi dir="ltr" className="font-mono text-[11px]">{i.path}</bdi>
          </div>
          <p className="mt-1">{i.message}</p>
        </li>
      ))}
    </ul>
  );
}

function VersionCard({ version }: { version: ArticleVersion }) {
  return (
    <div className="rounded-xl border border-ink-100 bg-ink-50/60 p-4 text-sm leading-8 text-ink-900">
      <p className="whitespace-pre-wrap">{version.text}</p>
      {version.subparts.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-ink-100 pt-3 text-xs leading-7 text-ink-700">
          {version.subparts.map((s) => (
            <li key={`${s.kind}:${s.label}`}>
              <b>{s.kind === "note" ? "تبصره" : "بند"} {fa(s.label)}:</b> {s.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LookupView({ lookup }: { lookup: VersionLookup }) {
  switch (lookup.status) {
    case "found":
      return (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="ok">در این تاریخ معتبر</Badge>
            {lookup.verified ? <Badge tone="ok">تأییدشده توسط حقوقدان</Badge> : <Badge tone="warn">تأییدنشده — قابل استناد به کاربر نیست</Badge>}
            <Badge>{lookup.version.provenance.sourceKind === "official" ? "منبع رسمی" : "منبع ثانویه"}</Badge>
          </div>
          <p className="text-xs text-ink-700">
            بازهٔ اعتبار این نسخه: از <b>{jalaliText(lookup.version.validFrom)}</b>{" "}
            {lookup.version.validTo === null ? "تا کنون (بی‌پایان)" : <>تا <b>{jalaliText(lookup.version.validTo)}</b> (آن روز دیگر معتبر نیست)</>}
          </p>
          {lookup.subpart && (
            <p className="rounded-lg border border-gold-500/40 bg-gold-100/50 px-3 py-2 text-xs leading-6">
              <b>{lookup.subpart.kind === "note" ? "تبصره" : "بند"} {fa(lookup.subpart.label)}:</b> {lookup.subpart.text}
            </p>
          )}
          <VersionCard version={lookup.version} />
        </div>
      );
    case "unknown-document":
      return <ErrorNote>چنین سندی در پایگاه نیست. (ارجاع نامعتبر؛ هرگز به کاربر نشان داده نمی‌شود.)</ErrorNote>;
    case "unknown-article":
      return <ErrorNote>این ماده در سند انتخاب‌شده نیست. (ارجاع نامعتبر.)</ErrorNote>;
    case "unknown-subpart":
      return (
        <div className="space-y-3">
          <ErrorNote>ماده هست، اما این تبصره/بند در نسخهٔ معتبر آن تاریخ وجود ندارد. (ارجاع نامعتبر.)</ErrorNote>
          <VersionCard version={lookup.version} />
        </div>
      );
    case "not-yet-in-force":
      return <ErrorNote>در این تاریخ این ماده هنوز وضع نشده بود؛ نخستین نسخه از {jalaliText(lookup.firstValidFrom)} معتبر است.</ErrorNote>;
    case "no-longer-in-force":
      return <ErrorNote>در این تاریخ این ماده دیگر معتبر نیست؛ اعتبار آخرین نسخه در {jalaliText(lookup.lastValidTo)} پایان یافته است.</ErrorNote>;
    case "gap":
      return (
        <ErrorNote>
          در این تاریخ هیچ نسخه‌ای معتبر نیست (شکاف): نسخهٔ قبلی از {jalaliText(lookup.previousValidTo)} معتبر نیست و نسخهٔ بعدی از {jalaliText(lookup.nextValidFrom)} آغاز می‌شود.
        </ErrorNote>
      );
  }
}

export function KbSchemaWorkbench() {
  const [json, setJson] = useState(SAMPLE_JSON);
  const [docId, setDocId] = useState("sample-law");
  const [article, setArticle] = useState("1");
  const [subKind, setSubKind] = useState<SubpartKind | "">("");
  const [subLabel, setSubLabel] = useState("");
  const [jalali, setJalali] = useState("1395/04/25");

  const loaded = useMemo(() => loadCorpusFromJson(json), [json]);
  const index = useMemo(() => (loaded.ok ? buildCorpusIndex(loaded.value) : null), [loaded]);

  const date = useMemo(() => {
    const p = parseJalaliDate(jalali);
    if (!p.ok) return { error: p.error.message } as const;
    const g = jalaliToGregorian(p.value);
    if (!g.ok) return { error: g.error.message } as const;
    const pad = (n: number, w: number) => String(n).padStart(w, "0");
    return { iso: `${pad(g.value.year, 4)}-${pad(g.value.month, 2)}-${pad(g.value.day, 2)}` } as const;
  }, [jalali]);

  const lookup = useMemo(() => {
    if (!index || "error" in date) return null;
    return resolveCitation(index, { documentId: docId, article, subpart: subKind === "" ? null : { kind: subKind, label: subLabel } }, date.iso);
  }, [index, date, docId, article, subKind, subLabel]);

  const inForce = useMemo(() => {
    if (!index || "error" in date) return null;
    const r = versionsInForceAt(index, date.iso);
    return r.ok ? r.value : null;
  }, [index, date]);

  const counts = useMemo(() => {
    if (!loaded.ok) return null;
    const c = loaded.value;
    const versions = c.documents.flatMap((d) => d.articles.flatMap((a) => a.versions));
    return {
      documents: c.documents.length,
      articles: c.documents.reduce((n, d) => n + d.articles.length, 0),
      versions: versions.length,
      verified: versions.filter((v) => v.provenance.review.status === "legally-verified").length,
      relations: c.relations.length,
      rulings: c.rulings.length,
    };
  }, [loaded]);

  const node = { documentId: docId, article: article.trim() === "" ? null : article };
  const rels = index ? relationsFor(index, node) : [];
  const rulings = index ? rulingsCiting(index, node) : [];

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="space-y-5">
        <Card title="داده‌ی پایگاه (JSON)" hint="هر ویرایشی بلافاصله اعتبارسنجی می‌شود. نمونهٔ پیش‌فرض ساختگی است.">
          <textarea
            dir="ltr"
            spellCheck={false}
            value={json}
            onChange={(e) => setJson(e.target.value)}
            aria-label="JSON پایگاه دانش"
            className={`${inputClass} h-72 resize-y font-mono text-[11px] leading-5`}
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setJson(SAMPLE_JSON)} className="rounded-lg border border-ink-200 px-3 py-1.5 text-xs text-ink-800 transition hover:bg-ink-50">
              بازگرداندن نمونهٔ ساختگی
            </button>
            {loaded.ok ? <Badge tone="ok">معتبر</Badge> : <Badge tone="risk">{fa(loaded.error.length)} مسئله</Badge>}
          </div>
        </Card>

        <Card title="وضعیت اعتبارسنجی">
          {loaded.ok && counts ? (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <Stat label="سند" value={fa(counts.documents)} />
                <Stat label="ماده" value={fa(counts.articles)} />
                <Stat label="نسخه" value={fa(counts.versions)} />
                <Stat label="تأییدشدهٔ حقوقدان" value={fa(counts.verified)} />
                <Stat label="رابطه" value={fa(counts.relations)} />
                <Stat label="رأی" value={fa(counts.rulings)} />
              </div>
              {counts.verified < counts.versions && (
                <p role="status" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs leading-6 text-amber-900">
                  ⚠️ {fa(counts.versions - counts.verified)} نسخه هنوز <b>تأییدنشده</b> است؛ تا تأیید حقوقدان نباید به کاربر به‌عنوان استناد نشان داده شود.
                </p>
              )}
            </div>
          ) : (
            !loaded.ok && <IssueList issues={loaded.error} />
          )}
        </Card>
      </div>

      <div className="space-y-5">
        <Card title="کدام متن در این تاریخ معتبر بود؟" hint="بازهٔ هر نسخه نیم‌باز است: روز شروع شامل و روز پایان دیگر معتبر نیست.">
          {!index ? (
            <p className="text-xs text-ink-500">ابتدا JSON را اصلاح کنید.</p>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="سند">
                  <select value={docId} onChange={(e) => setDocId(e.target.value)} className={inputClass}>
                    {index.corpus.documents.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.title} ({KIND_LABEL[d.kind]})
                      </option>
                    ))}
                    <option value="unknown-doc">— سند ناموجود (آزمون) —</option>
                  </select>
                </Field>
                <Field label="ماده" hint="مثل ۱، ۲ مکرر، واحده">
                  <input value={article} onChange={(e) => setArticle(e.target.value)} className={inputClass} />
                </Field>
                <Field label="تبصره/بند (اختیاری)">
                  <div className="flex gap-2">
                    <select value={subKind} onChange={(e) => setSubKind(e.target.value as SubpartKind | "")} className={`${inputClass} !w-28`}>
                      <option value="">—</option>
                      <option value="note">تبصره</option>
                      <option value="clause">بند</option>
                    </select>
                    <input value={subLabel} onChange={(e) => setSubLabel(e.target.value)} disabled={subKind === ""} placeholder="۱ یا الف" className={inputClass} />
                  </div>
                </Field>
                <Field label="تاریخ (جلالی)" hint={"error" in date ? undefined : `میلادی: ${date.iso}`}>
                  <input dir="ltr" value={jalali} onChange={(e) => setJalali(e.target.value)} className={`${inputClass} font-mono`} />
                </Field>
              </div>
              {"error" in date && <ErrorNote>{date.error}</ErrorNote>}
              {lookup && !lookup.ok && <ErrorNote>{lookup.error.message}</ErrorNote>}
              {lookup && lookup.ok && <LookupView lookup={lookup.value} />}
            </div>
          )}
        </Card>

        <Card title="مواد معتبر در این تاریخ" hint="همان فیلتر تاریخ اعتبار که بازیابی (گام ۶) از آن استفاده می‌کند.">
          {inForce === null ? (
            <p className="text-xs text-ink-500">تاریخ یا داده معتبر نیست.</p>
          ) : inForce.length === 0 ? (
            <p className="text-xs text-ink-500">در این تاریخ هیچ ماده‌ای معتبر نیست.</p>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {inForce.map((e) => (
                <li key={`${e.documentId}/${e.article}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-100 px-3 py-2">
                  <span>
                    <bdi dir="ltr" className="font-mono">{e.documentId}</bdi> · ماده {fa(e.article)}
                  </span>
                  {e.verified ? <Badge tone="ok">تأییدشده</Badge> : <Badge tone="warn">تأییدنشده</Badge>}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="رابطه‌ها و رأی‌های مرتبط با گرهٔ انتخاب‌شده">
          {rels.length === 0 && rulings.length === 0 ? (
            <p className="text-xs text-ink-500">رابطه یا رأی‌ای ثبت نشده است.</p>
          ) : (
            <ul className="space-y-2 text-xs leading-6">
              {rels.map((r, i) => (
                <li key={`r${i}`} className="rounded-lg border border-ink-100 px-3 py-2">
                  <bdi dir="ltr" className="font-mono">{r.from.documentId}{r.from.article ? `/${r.from.article}` : ""}</bdi> {RELATION_LABEL[r.type]}{" "}
                  <bdi dir="ltr" className="font-mono">{r.to.documentId}{r.to.article ? `/${r.to.article}` : ""}</bdi>
                  {r.effectiveFrom && <span className="text-ink-500"> — از {jalaliText(r.effectiveFrom)}</span>}
                </li>
              ))}
              {rulings.map((g) => (
                <li key={g.id} className="rounded-lg border border-gold-500/40 bg-gold-100/40 px-3 py-2">
                  <b>رأی:</b> {g.title ?? g.id} ({fa(g.number)}) — {jalaliText(g.issuedOn)}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
