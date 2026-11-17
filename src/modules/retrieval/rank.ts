/** ترتیب قطعی نتیجه‌ها و کلید یکتا (خالص). */
import type { Passage } from "./types";

export const passageKey = (r: Passage["ref"]): string => JSON.stringify([r.documentId, r.article, r.validFrom]);

const ARTICLE_RE = /^(\d+)(?: مکرر(?: (\d+))?)?$/;

/** مقایسهٔ طبیعیِ برچسب ماده: عدد، سپس مکرر، سپس متن («9» پیش از «10»؛ «واحده» پس از عددی‌ها). */
export function compareArticleLabels(a: string, b: string): number {
  const ma = ARTICLE_RE.exec(a);
  const mb = ARTICLE_RE.exec(b);
  if (ma && mb) {
    const na = Number(ma[1]);
    const nb = Number(mb[1]);
    if (na !== nb) return na - nb;
    const ra = a.includes("مکرر") ? 1 + Number(ma[2] ?? 0) : 0;
    const rb = b.includes("مکرر") ? 1 + Number(mb[2] ?? 0) : 0;
    return ra - rb;
  }
  if (ma) return -1;
  if (mb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** پوشش بیشتر، سپس امتیاز بیشتر، سپس سند، ماده و آغاز اعتبار. */
export function comparePassages(a: Passage, b: Passage): number {
  return (
    b.matchedTerms.length - a.matchedTerms.length ||
    b.score - a.score ||
    cmpStr(a.ref.documentId, b.ref.documentId) ||
    compareArticleLabels(a.ref.article, b.ref.article) ||
    cmpStr(a.ref.validFrom, b.ref.validFrom)
  );
}
