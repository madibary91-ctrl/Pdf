/**
 * ذخیره‌گاهِ ساختگیِ درون‌حافظه‌ای فقط برای تست‌ها (از index صادر نمی‌شود): همان معنای `searchArticles` — AND روی واژه‌های
 * کامل، اعتبار نیم‌باز در `asOf`، `verifiedOnly`، `documentId`، امتیاز = جمع دفعات، ترتیب امتیاز ← سند ← ماده، `limit`.
 */
import { searchKey } from "@/modules/persian-text";
import type { SearchHit, SearchInput, SearchResult, StoreResult } from "./store-types";
import type { Searcher } from "./types";

export type FakeArticle = Readonly<{
  documentId: string;
  article: string;
  validFrom: string;
  validTo: string | null;
  text: string;
  subparts?: readonly Readonly<{ kind: "note" | "clause"; label: string; text: string }>[];
  verified: boolean;
}>;

export type FakeSearcher = Searcher & { calls: SearchInput[]; staleSkipped: number; failWith: null | { code: string; message: string }; throwOnCall: boolean };

export const words = (text: string): string[] => {
  const k = searchKey(text);
  return k === "" ? [] : k.split(" ");
};

export function fakeSearcher(articles: readonly FakeArticle[]): FakeSearcher {
  const self: FakeSearcher = {
    calls: [],
    staleSkipped: 0,
    failWith: null,
    throwOnCall: false,
    async searchArticles(input: SearchInput): Promise<StoreResult<SearchResult>> {
      self.calls.push(input);
      if (self.throwOnCall) throw new Error("boom: SENSITIVE_MARKER_91c2");
      if (self.failWith !== null) return { ok: false, error: { code: self.failWith.code as never, message: self.failWith.message } };
      const tokens = [...new Set(words(input.text))];
      const verifiedOnly = input.verifiedOnly ?? true;
      const limit = input.limit ?? 20;
      const hits: SearchHit[] = [];
      for (const a of articles) {
        if (!(a.validFrom <= input.asOf && (a.validTo === null || input.asOf < a.validTo))) continue;
        if (verifiedOnly && !a.verified) continue;
        if (input.documentId !== undefined && a.documentId !== input.documentId) continue;
        const w = words([a.text, ...(a.subparts ?? []).map((s) => s.text)].join("\n"));
        const set = new Set(tokens);
        const present = new Set(w.filter((t) => set.has(t)));
        if (tokens.some((t) => !present.has(t))) continue;
        hits.push({
          ref: { documentId: a.documentId, article: a.article, validFrom: a.validFrom },
          documentTitle: `قانون ساختگی ${a.documentId}`,
          validTo: a.validTo,
          text: a.text,
          subparts: a.subparts ?? [],
          provenance: {} as SearchHit["provenance"],
          verified: a.verified,
          contentHash: `h-${a.documentId}-${a.article}-${a.validFrom}`,
          matches: w.filter((t) => set.has(t)).length,
        });
      }
      hits.sort((x, y) => y.matches - x.matches || (x.ref.documentId < y.ref.documentId ? -1 : x.ref.documentId > y.ref.documentId ? 1 : 0) || Number(x.ref.article) - Number(y.ref.article));
      return { ok: true, value: { tokens, asOf: input.asOf, verifiedOnly, hits: hits.slice(0, limit), hasMore: hits.length > limit, staleSkipped: self.staleSkipped } };
    },
  };
  return self;
}
