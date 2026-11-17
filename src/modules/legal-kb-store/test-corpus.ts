/**
 * سازندهٔ Corpus برای تست‌ها (فقط تست؛ از index صادر نمی‌شود). هیچ‌چیز واقعی نیست: همه ساختگی و تصادفیِ بذردار.
 * خروجی JSON خام است (ورودی `loadCorpus`)، نه Corpus تایپ‌دار.
 */

export type J = Record<string, any>;

/** مولد شبه‌تصادفی قطعی (mulberry32)؛ بذر در پیام خطا چاپ می‌شود تا هر شکست بازتولیدپذیر باشد. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T,
    chance: (p: number) => next() < p,
  };
}

const DAY_MS = 86_400_000;
export const dayToIso = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);
export const isoToDay = (iso: string): number => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);

export const pendingProv = (name = "منبع ساختگی"): J => ({
  sourceName: name,
  sourceUrl: null,
  sourceKind: "secondary",
  retrievedOn: "2025-01-10",
  review: { status: "pending-legal-review", reviewedBy: null, reviewedOn: null },
});
export const verifiedProv = (name = "منبع ساختگی تأییدشده"): J => ({
  sourceName: name,
  sourceUrl: "https://example.org/fictional",
  sourceKind: "official",
  retrievedOn: "2025-01-10",
  review: { status: "legally-verified", reviewedBy: "بازبین فرضی", reviewedOn: "2025-02-01" },
});

export const version = (validFrom: string, validTo: string | null, text = "متن ساختگی", subparts: J[] = [], provenance: J = pendingProv()): J => ({
  validFrom,
  validTo,
  text,
  subparts,
  provenance,
});

export const article = (label: string, versions: J[]): J => ({ label, versions });

export const documentJson = (id: string, articles: J[], extra: J = {}): J => ({
  id,
  kind: "statute",
  title: `قانون ساختگی ${id}`,
  shortTitle: null,
  enactedOn: null,
  provenance: pendingProv(),
  articles,
  ...extra,
});

export const corpusJson = (documents: J[], relations: J[] = [], rulings: J[] = []): J => ({ documents, relations, rulings });

export const rulingJson = (id: string, cites: J[], extra: J = {}): J => ({
  id,
  kind: "judgment",
  number: "1",
  issuer: "مرجع ساختگی",
  issuedOn: "2020-01-01",
  title: null,
  text: "متن رأی ساختگی",
  cites,
  provenance: pendingProv(),
  ...extra,
});

export const relationJson = (type: string, from: J, to: J, extra: J = {}): J => ({
  type,
  from,
  to,
  effectiveFrom: null,
  note: null,
  provenance: pendingProv(),
  ...extra,
});

const LABELS = ["1", "2", "3", "4", "5", "9", "10", "10 مکرر", "10 مکرر 2", "11", "واحده", "99999", "100 مکرر 99"] as const;
const SUB_LABELS = ["1", "2", "3", "الف", "ب", "ج"] as const;

export type RandomCorpusInfo = Readonly<{
  json: J;
  /** همهٔ (سند، ماده) و بازه‌های نسخه برای ساخت تاریخ‌های مرزی */
  articles: ReadonlyArray<Readonly<{ documentId: string; label: string; subparts: ReadonlyArray<Readonly<{ kind: string; label: string }>>; edges: readonly number[] }>>;
}>;

/**
 * Corpus تصادفیِ **معتبر**: زنجیرهٔ نسخه‌ها با مجاورت، شکاف، نسخهٔ بی‌پایان و نسخهٔ بسته؛ تبصره/بند؛ رابطه‌ها و رأی‌ها.
 * `prefix` شناسه‌ها را یکتا می‌کند تا چند Corpus در یک store جا شوند.
 */
export function randomCorpus(seed: number, prefix: string): RandomCorpusInfo {
  const r = rng(seed);
  const documents: J[] = [];
  const meta: Array<{ documentId: string; label: string; subparts: Array<{ kind: string; label: string }>; edges: number[] }> = [];
  const nodes: Array<{ documentId: string; article: string | null }> = [];

  const docCount = r.int(1, 3);
  for (let d = 0; d < docCount; d++) {
    const id = `${prefix}-d${d}`;
    nodes.push({ documentId: id, article: null });
    const labels = [...LABELS].filter(() => r.chance(0.45));
    if (labels.length === 0) labels.push("1");
    // ترتیب ورودی را عمداً بر می‌زنیم تا ترتیب متعارف تست شود
    labels.sort(() => r.next() - 0.5);
    const articles = labels.map((label) => {
      nodes.push({ documentId: id, article: label });
      const versions: J[] = [];
      const edges: number[] = [];
      let day = r.int(isoToDay("2000-01-01"), isoToDay("2020-12-31"));
      const n = r.int(1, 5);
      const subparts: Array<{ kind: string; label: string }> = [];
      for (let k = 0; k < n; k++) {
        const last = k === n - 1;
        const open = last && r.chance(0.5);
        const len = r.chance(0.15) ? 1 : r.int(2, 400);
        const to = open ? null : day + len;
        const subs: J[] = [];
        const seen = new Set<string>();
        for (let s = r.int(0, 3); s > 0; s--) {
          const kind = r.pick(["note", "clause"] as const);
          const lab = r.pick(SUB_LABELS);
          if (seen.has(`${kind}:${lab}`)) continue;
          seen.add(`${kind}:${lab}`);
          subs.push({ kind, label: lab, text: `تبصره/بند ساختگی ${kind} ${lab}` });
          subparts.push({ kind, label: lab });
        }
        versions.push(version(dayToIso(day), to === null ? null : dayToIso(to), `متن ساختگی ${label} نسخهٔ ${k}`, subs, r.chance(0.4) ? verifiedProv() : pendingProv()));
        edges.push(day);
        if (to !== null) edges.push(to);
        if (to === null) break;
        day = to + (r.chance(0.5) ? 0 : r.int(1, 60)); // مجاور یا شکاف
      }
      meta.push({ documentId: id, label, subparts, edges });
      // نسخه‌ها را هم برمی‌زنیم (ترتیب متعارف)
      versions.sort(() => r.next() - 0.5);
      return article(label, versions);
    });
    documents.push(documentJson(id, articles, r.chance(0.5) ? { shortTitle: "کوتاه", enactedOn: "2001-02-03" } : {}));
  }

  const relations: J[] = [];
  const relKeys = new Set<string>();
  for (let i = r.int(0, 5); i > 0; i--) {
    const from = r.pick(nodes);
    const to = r.pick(nodes);
    const type = r.pick(["amends", "refers-to", "implements", "interprets"] as const);
    const eff = r.chance(0.5) ? dayToIso(r.int(isoToDay("2000-01-01"), isoToDay("2025-01-01"))) : null;
    const key = `${type}|${from.documentId}/${from.article ?? ""}|${to.documentId}/${to.article ?? ""}|${eff ?? ""}`;
    if ((from.documentId === to.documentId && from.article === to.article) || relKeys.has(key)) continue;
    relKeys.add(key);
    relations.push(relationJson(type, from, to, { effectiveFrom: eff, note: r.chance(0.3) ? "یادداشت ساختگی\nخط دوم" : null }));
  }
  const rulings: J[] = [];
  for (let i = r.int(0, 3); i > 0; i--) {
    const cites: J[] = [];
    const seen = new Set<string>();
    for (let c = r.int(0, 4); c > 0; c--) {
      const n = r.pick(nodes);
      const k = `${n.documentId}/${n.article ?? ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      cites.push(n);
    }
    rulings.push(rulingJson(`${prefix}-r${i}`, cites, { kind: r.pick(["unity-ruling", "constitutional-opinion", "advisory-opinion", "judgment"] as const), title: r.chance(0.5) ? "عنوان" : null }));
  }
  return { json: corpusJson(documents, relations, rulings), articles: meta };
}
