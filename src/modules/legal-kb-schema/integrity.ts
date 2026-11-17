/**
 * یکپارچگی بین‌رکوردی روی Corpus تایپ‌دار (داخلی): یکتایی، ارجاع‌های معلق، بازه‌های نسخه، رابطه‌های متناقض.
 * فقط وقتی اجرا می‌شود که شکل ورودی بی‌خطا باشد (تا مسئله‌های ثانویه نویز نسازند).
 */
import { compareIsoDates } from "./dates";
import { addIssue, type Ctx } from "./issues";
import type { ArticleVersion, Corpus, NodeRef } from "./types";

const refText = (r: NodeRef) => (r.article === null ? r.documentId : `${r.documentId}/${r.article}`);

function checkVersions(ctx: Ctx, versions: readonly ArticleVersion[], path: string): void {
  versions.forEach((v, i) => {
    const vp = `${path}.versions[${i}]`;
    if (v.validTo !== null && compareIsoDates(v.validTo, v.validFrom) <= 0) {
      addIssue(ctx, "INVALID_INTERVAL", `${vp}.validTo`, `validTo (${v.validTo}) باید پس از validFrom (${v.validFrom}) باشد؛ بازه نیم‌باز است و روز validTo دیگر معتبر نیست.`);
    }
    const seen = new Set<string>();
    v.subparts.forEach((s, si) => {
      const key = `${s.kind}:${s.label}`;
      if (seen.has(key)) addIssue(ctx, "DUPLICATE", `${vp}.subparts[${si}]`, `تبصره/بند تکراری (${s.kind} ${s.label}).`);
      seen.add(key);
    });
  });

  // ترتیب پایدار بر اساس شروع؛ اگر هر جفتِ مجاور هم‌پوشانی نداشته باشد، هیچ جفتی ندارد.
  const order = versions.map((_, i) => i).sort((a, b) => compareIsoDates(versions[a]!.validFrom, versions[b]!.validFrom) || a - b);
  for (let k = 1; k < order.length; k++) {
    const ai = order[k - 1] as number;
    const bi = order[k] as number;
    const a = versions[ai] as ArticleVersion;
    const b = versions[bi] as ArticleVersion;
    if (a.validFrom === b.validFrom) {
      addIssue(ctx, "DUPLICATE", `${path}.versions[${bi}].validFrom`, `دو نسخه با validFrom یکسان (${b.validFrom}).`);
    } else if (a.validTo === null || compareIsoDates(a.validTo, b.validFrom) > 0) {
      addIssue(
        ctx,
        "VERSION_OVERLAP",
        `${path}.versions[${ai}].validTo`,
        a.validTo === null
          ? `نسخهٔ بی‌پایان (validFrom ${a.validFrom}) با نسخهٔ بعدی (validFrom ${b.validFrom}) هم‌پوشان است؛ نسخهٔ قبلی باید با validTo بسته شود.`
          : `بازهٔ نسخه‌ها هم‌پوشان است: validTo=${a.validTo} پس از validFrom=${b.validFrom} نسخهٔ بعدی.`,
      );
    }
  }
}

export function checkIntegrity(corpus: Corpus, ctx: Ctx): void {
  const articlesByDoc = new Map<string, Set<string>>();

  corpus.documents.forEach((doc, di) => {
    const dp = `documents[${di}]`;
    if (articlesByDoc.has(doc.id)) addIssue(ctx, "DUPLICATE", `${dp}.id`, `شناسهٔ سند «${doc.id}» تکراری است.`);
    const labels = articlesByDoc.get(doc.id) ?? new Set<string>();
    if (!articlesByDoc.has(doc.id)) articlesByDoc.set(doc.id, labels);
    const localSeen = new Set<string>();
    doc.articles.forEach((a, ai) => {
      const ap = `${dp}.articles[${ai}]`;
      if (localSeen.has(a.label)) addIssue(ctx, "DUPLICATE", `${ap}.label`, `ماده «${a.label}» در سند «${doc.id}» تکراری است (ارقام فارسی/لاتین یکی حساب می‌شوند).`);
      localSeen.add(a.label);
      labels.add(a.label);
      checkVersions(ctx, a.versions, ap);
    });
  });

  const exists = (r: NodeRef, path: string): void => {
    const labels = articlesByDoc.get(r.documentId);
    if (!labels) addIssue(ctx, "DANGLING_REF", path, `سند «${r.documentId}» در پایگاه نیست.`);
    else if (r.article !== null && !labels.has(r.article)) addIssue(ctx, "DANGLING_REF", path, `ماده «${r.article}» در سند «${r.documentId}» نیست.`);
  };

  const relKeys = new Set<string>();
  const directional = new Set<string>(); // فقط repeals/replaces برای تناقض
  corpus.relations.forEach((r, i) => {
    const rp = `relations[${i}]`;
    exists(r.from, `${rp}.from`);
    exists(r.to, `${rp}.to`);
    const from = refText(r.from);
    const to = refText(r.to);
    if (from === to) addIssue(ctx, "INVALID_FIELD", rp, "رابطه نمی‌تواند یک گره را به خودش وصل کند.");
    const key = `${r.type}|${from}|${to}|${r.effectiveFrom ?? ""}`;
    if (relKeys.has(key)) addIssue(ctx, "DUPLICATE", rp, "رابطهٔ تکراری (نوع، مبدأ، مقصد و تاریخ اثر یکسان).");
    relKeys.add(key);
    if (r.type === "repeals" || r.type === "replaces") {
      if (directional.has(`${r.type}|${to}|${from}`)) {
        addIssue(ctx, "CONTRADICTORY_RELATION", rp, `تناقض: «${to}» هم «${from}» را ${r.type === "repeals" ? "نسخ" : "جایگزین"} می‌کند و هم برعکس.`);
      }
      directional.add(`${r.type}|${from}|${to}`);
    }
  });

  const rulingIds = new Set<string>();
  corpus.rulings.forEach((g, i) => {
    const gp = `rulings[${i}]`;
    if (rulingIds.has(g.id)) addIssue(ctx, "DUPLICATE", `${gp}.id`, `شناسهٔ رأی «${g.id}» تکراری است.`);
    rulingIds.add(g.id);
    const cited = new Set<string>();
    g.cites.forEach((c, ci) => {
      exists(c, `${gp}.cites[${ci}]`);
      const t = refText(c);
      if (cited.has(t)) addIssue(ctx, "DUPLICATE", `${gp}.cites[${ci}]`, `ارجاع تکراری «${t}».`);
      cited.add(t);
    });
  });
}
