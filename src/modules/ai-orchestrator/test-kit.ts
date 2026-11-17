/**
 * ابزار آزمون ai-orchestrator (از index صادر نمی‌شود): ذخیره‌گاه، دروازه و راستی‌آزمای ساختگی. ماژول به `legal-kb-schema`
 * وابسته نیست؛ پس اینجا نمایهٔ واقعی نداریم — قرارداد با راستی‌آزمای واقعی در `tooling/orchestrator-pipeline.test.ts` آزموده می‌شود.
 * همهٔ متن‌ها و قیمت‌ها **ساختگیِ آزمون**‌اند.
 */
import type { Completion, Gateway, GatewayError, GatewayResult, ModelLimits } from "@/modules/ai-gateway";
import type { Context, Searcher } from "@/modules/retrieval";
import type { CitationChecker, CitationSession, ClaimVerdict, SourceClaim, TextGuardOptions, TextGuardOutcome } from "./types";

export type FakeArticle = Readonly<{ documentId: string; article: string; validFrom: string; validTo: string | null; text: string; verified: boolean }>;
type SearchOutcome = Awaited<ReturnType<Searcher["searchArticles"]>>;
type SearchInputLike = Parameters<Searcher["searchArticles"]>[0];

export type FakeSearcher = Searcher & { calls: SearchInputLike[]; failWith: string | null; throwOnCall: boolean; staleSkipped: number };

/** مستقل از متن پرسش: همهٔ بندهای معتبر در `asOf` (و تأییدشده اگر `verifiedOnly`) را می‌دهد؛ تطبیق واژه کار `retrieval` است. */
export function fakeSearcher(articles: readonly FakeArticle[]): FakeSearcher {
  const self: FakeSearcher = {
    calls: [],
    failWith: null,
    throwOnCall: false,
    staleSkipped: 0,
    async searchArticles(input): Promise<SearchOutcome> {
      self.calls.push(input);
      if (self.throwOnCall) throw new Error("boom: SENSITIVE_MARKER_77aa");
      if (self.failWith !== null) return { ok: false, error: { code: self.failWith as never, message: "SENSITIVE_STORE_MESSAGE" } };
      const verifiedOnly = input.verifiedOnly ?? true;
      const hits = articles
        .filter((a) => a.validFrom <= input.asOf && (a.validTo === null || input.asOf < a.validTo))
        .filter((a) => !verifiedOnly || a.verified)
        .filter((a) => input.documentId === undefined || a.documentId === input.documentId)
        .map((a) => ({
          ref: { documentId: a.documentId, article: a.article, validFrom: a.validFrom },
          documentTitle: `قانون ساختگی ${a.documentId}`,
          validTo: a.validTo,
          text: a.text,
          subparts: [],
          provenance: {} as never,
          verified: a.verified,
          contentHash: `h-${a.documentId}-${a.article}`,
          matches: 1,
        }));
      return { ok: true, value: { tokens: [], asOf: input.asOf, verifiedOnly, hits, hasMore: false, staleSkipped: self.staleSkipped } as never };
    },
  };
  return self;
}

export const LIMITS: ModelLimits = { maxInputChars: 60_000, maxOutputTokens: 4096, priced: true };

export function completion(text: string, over: Partial<Completion> & { report?: unknown } = {}): Completion & { report?: unknown } {
  return {
    text,
    finishReason: "stop",
    model: "legal-chat",
    provider: "main",
    servedModel: "served-x",
    requestId: null,
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    cost: { micros: 1234, currency: "IRR", priceVersion: "test-prices-1" },
    latencyMs: 7,
    warnings: [],
    ...over,
  };
}

export function gatewayError(code: GatewayError["code"], over: Partial<GatewayError> & { report?: unknown } = {}): GatewayError & { report?: unknown } {
  return { code, message: "msg", retryable: false, warnings: [], ...over };
}

export type FakeGateway = Gateway & { calls: unknown[]; signals: unknown[]; limitsCalls: string[]; next: (input: unknown) => GatewayResult<Completion> | Promise<GatewayResult<Completion>> };

/** دروازهٔ ساختگی: `next` پاسخ هر فراخوانی را می‌سازد (می‌تواند پرتاب کند). */
export function fakeGateway(next: FakeGateway["next"], limits: Readonly<Record<string, ModelLimits>> = { "legal-chat": LIMITS }): FakeGateway {
  const self: FakeGateway = {
    calls: [],
    signals: [],
    limitsCalls: [],
    next,
    async complete(input, options) {
      self.calls.push(input);
      self.signals.push(options?.signal);
      return self.next(input);
    },
    limits(model) {
      self.limitsCalls.push(model);
      return Object.prototype.hasOwnProperty.call(limits, model) ? (limits[model] as ModelLimits) : null;
    },
  };
  return self;
}

export const replyJson = (obj: unknown): GatewayResult<Completion> => ({ ok: true, value: completion(JSON.stringify(obj)) });

export type FakeCheckerOptions = {
  /** «سند#ماده» ← متنِ همان ماده (برای سنجش نقل‌قول). نبودن = `unknown-article`. */
  texts: Record<string, string>;
  unverified?: Set<string>;
};

export type FakeChecker = CitationChecker & {
  opened: number;
  failOpen: boolean;
  throwVerify: boolean;
  throwGuard: boolean;
  /** شمار احکام برگشتی را کم می‌کند. */
  dropVerdicts: number;
  verdictOverride: ((claims: readonly SourceClaim[]) => readonly ClaimVerdict[]) | null;
  guardOverride: ((text: string, options: TextGuardOptions) => TextGuardOutcome) | null;
  claimCalls: (readonly SourceClaim[])[];
  guardCalls: { text: string; asOf: string; options: TextGuardOptions }[];
  /** ارجاع‌های آزادِ مجاز (متن دقیق) برای نگهبان؛ بقیهٔ «ماده N …» رد می‌شوند. */
  allowedMentions: Set<string>;
};

/** راستی‌آزمای ساختگیِ قاعده‌محور؛ هیچ نمایهٔ واقعی ندارد. */
export function fakeChecker(options: FakeCheckerOptions): FakeChecker {
  const self: FakeChecker = {
    opened: 0,
    failOpen: false,
    throwVerify: false,
    throwGuard: false,
    dropVerdicts: 0,
    verdictOverride: null,
    guardOverride: null,
    claimCalls: [],
    guardCalls: [],
    allowedMentions: new Set(),
    async open(): Promise<CitationSession> {
      self.opened++;
      if (self.failOpen) throw new Error("SENSITIVE_INDEX_ERROR");
      return {
        verifyClaims(claims) {
          self.claimCalls.push(claims);
          if (self.throwVerify) throw new Error("SENSITIVE_VERIFY_ERROR");
          if (self.verdictOverride !== null) return self.verdictOverride(claims);
          const out = claims.map((c): ClaimVerdict => {
            const key = `${c.citation.documentId}#${c.citation.article}`;
            const text = options.texts[key];
            if (text === undefined) return { accepted: false, code: "unknown-article" };
            if (options.unverified?.has(key) === true) return { accepted: false, code: "unverified-source" };
            if (c.quote !== null && !text.includes(c.quote)) return { accepted: false, code: "quote-mismatch" };
            return { accepted: true, code: "valid" };
          });
          return self.dropVerdicts > 0 ? out.slice(0, Math.max(0, out.length - self.dropVerdicts)) : out;
        },
        guardText(text, asOf, opts) {
          self.guardCalls.push({ text, asOf, options: opts });
          if (self.throwGuard) throw new Error("SENSITIVE_GUARD_ERROR");
          if (self.guardOverride !== null) return self.guardOverride(text, opts);
          const rejected: { code: string }[] = [];
          let found = 0;
          const out = text.replace(/ماده\s*[0-9۰-۹]+(?:\s+قانون\s+\S+)?/g, (m) => {
            found++;
            if (self.allowedMentions.has(m)) return m;
            rejected.push({ code: "no-document" });
            return opts.marker;
          });
          return { text: out, found, rejected };
        },
      };
    },
  };
  return self;
}

/** زمینهٔ دست‌ساز (بدون `retrieval`) برای آزمون‌های لایهٔ مستندسازی. */
export function makeContext(items: readonly Readonly<{ id: string; documentId: string; article: string; body: string }>[]): Context {
  const sources = items.map((i) => ({
    id: i.id,
    citation: { documentId: i.documentId, article: i.article, subpart: null as null },
    verified: true,
    header: `[${i.id}] قانون ساختگی ${i.documentId} — ماده ${i.article} (معتبر از 2001-01-01 تا اکنون)`,
    body: i.body,
    truncated: false,
  }));
  return { text: sources.map((s) => `${s.header}\n${s.body}`).join("\n\n"), sources, omitted: 0, omittedUnverified: 0 };
}
