/**
 * `createOrchestrator(config).ask(input)`: خط لولهٔ پرسش‌وپاسخ مستند (ADR-0016). ترتیب مراحل و دلیلش در §۸ ADR.
 * هرگز پرتاب نمی‌کند؛ هر پورت ممکن است پرتاب کند.
 */
import { buildContext, MIN_CONTEXT_CHARS, retrieve, type Context } from "@/modules/retrieval";
import type { Completion } from "@/modules/ai-gateway";
import { accountingOfCompletion, accountingOfFailure, unknownAccounting } from "./accounting";
import { resolveConfig, type ResolvedConfig } from "./config";
import { fail } from "./errors";
import { ground } from "./ground";
import { parseModelOutput } from "./model-output";
import { buildPrompt, PROMPT_VERSION } from "./prompt";
import { parseAskRequest } from "./request";
import type { Accounting, Answer, AskResult, CitationSession, GenerationSummary, Orchestrator, OrchestratorWarning, RetrievalSummary } from "./types";

type Signal = AbortSignal | undefined;

/** تابع جدا تا TypeScript وضعیتِ «لغوشده» را میان گام‌ها ثابت فرض نکند (سیگنال همزمان تغییر می‌کند). */
const isAborted = (s: Signal): boolean => s !== undefined && s.aborted;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readSignal(options: unknown): Readonly<{ ok: true; signal: Signal }> | Readonly<{ ok: false }> {
  if (options === undefined) return { ok: true, signal: undefined };
  if (!isRecord(options)) return { ok: false };
  const s = options["signal"];
  if (s === undefined) return { ok: true, signal: undefined };
  if (typeof s === "object" && s !== null && typeof (s as AbortSignal).aborted === "boolean" && typeof (s as AbortSignal).addEventListener === "function") return { ok: true, signal: s as AbortSignal };
  return { ok: false };
}

function dedupe<T>(xs: readonly T[]): T[] {
  return xs.filter((x, i) => xs.indexOf(x) === i);
}

async function run(cfg: ResolvedConfig, input: unknown, options: unknown, held: { accounting: Accounting | null }): Promise<AskResult> {
  const sig = readSignal(options);
  if (!sig.ok) return fail("INVALID_INPUT", { issues: ["options.signal"] });
  const signal = sig.signal;
  const parsed = parseAskRequest(input);
  if (!parsed.ok) return parsed;
  const req = parsed.value;
  if (isAborted(signal)) return fail("ABORTED");

  // ۱) حدّ مدل ← بودجهٔ زمینه (پیش از هر هزینه)
  const limits = cfg.gateway.limits(req.model);
  if (limits === null || limits === undefined) return fail("UNKNOWN_MODEL");
  if (typeof limits.maxInputChars !== "number" || typeof limits.maxOutputTokens !== "number") return fail("INTERNAL_ERROR");
  if (req.maxOutputTokens > limits.maxOutputTokens) return fail("INVALID_INPUT", { issues: ["maxOutputTokens"] });
  const fixedChars = buildPrompt(req.question, "").chars;
  const budget = Math.min(req.contextMaxChars, limits.maxInputChars - fixedChars);
  if (budget < MIN_CONTEXT_CHARS) return fail("PROMPT_BUDGET");

  // ۲) بازیابی: همیشه فقط‌تأییدشده (گزینه نیست)
  const retrieved = await retrieve(cfg.searcher, {
    question: req.question,
    asOf: req.asOf,
    verifiedOnly: true,
    ...(req.documentId === null ? {} : { documentId: req.documentId }),
    ...req.retrieval,
  });
  if (!retrieved.ok) {
    const e = retrieved.error;
    if (e.code === "STORE_ERROR") return fail("RETRIEVAL_FAILED", { retrievalCode: e.code });
    return fail("INVALID_INPUT", { issues: [e.code === "EMPTY_QUERY" ? "question" : "retrieval"], retrievalCode: e.code });
  }
  const retrieval = retrieved.value;
  const built = buildContext(retrieval.passages, { maxChars: budget });
  if (!built.ok) return fail("INTERNAL_ERROR");
  const context: Context = built.value;

  const summary: RetrievalSummary = {
    passages: retrieval.passages.length,
    sources: context.sources.length,
    omitted: context.omitted,
    omittedUnverified: context.omittedUnverified,
    relaxed: retrieval.relaxed,
    incomplete: retrieval.incomplete,
    hasMore: retrieval.hasMore,
    budgetExhausted: retrieval.budgetExhausted,
    queriesRun: retrieval.queriesRun,
  };
  const warnings: OrchestratorWarning[] = [];
  if (retrieval.incomplete) warnings.push("RETRIEVAL_INCOMPLETE");
  if (retrieval.relaxed) warnings.push("RETRIEVAL_RELAXED");
  if (context.omitted > 0) warnings.push("CONTEXT_OMITTED");
  if (context.sources.some((s) => s.truncated)) warnings.push("CONTEXT_TRUNCATED");

  const base = { retrieval: summary, asOf: req.asOf, promptVersion: PROMPT_VERSION };
  const none = { text: null, withheldReason: null, citations: [], rejections: [], unsupportedNumbers: [] } as const;

  // ۳) بدون منبع ⇒ بدون مدل (هزینهٔ صفر؛ پاسخِ بی‌پشتوانه ممنوع)
  if (context.sources.length === 0) {
    return { ok: true, value: { ...base, ...none, status: "no-sources", generation: null, accounting: null, warnings } };
  }

  // ۴) نشست راستی‌آزمایی پیش از خرجِ پول
  let session: CitationSession;
  try {
    session = await cfg.checker.open();
  } catch {
    return fail("VERIFIER_UNAVAILABLE");
  }
  if (typeof session !== "object" || session === null || typeof session.verifyClaims !== "function" || typeof session.guardText !== "function") return fail("VERIFIER_UNAVAILABLE");
  if (isAborted(signal)) return fail("ABORTED");

  // ۵) تولید
  const prompt = buildPrompt(req.question, context.text);
  const res = await cfg.gateway.complete(
    {
      model: req.model,
      messages: prompt.messages,
      maxOutputTokens: req.maxOutputTokens,
      temperature: 0,
      ...(req.requestId === null ? {} : { requestId: req.requestId }),
      ...(req.timeoutMs === null ? {} : { timeoutMs: req.timeoutMs }),
    },
    signal === undefined ? undefined : { signal },
  );
  if (!res.ok) {
    const e = res.error;
    const accounting = accountingOfFailure(e);
    held.accounting = accounting;
    if (e.code === "ABORTED") return fail("ABORTED", { accounting });
    return fail("GENERATION_FAILED", {
      gatewayCode: e.code,
      retryable: e.retryable === true,
      ...(typeof e.retryAfterMs === "number" ? { retryAfterMs: e.retryAfterMs } : {}),
      ...(Array.isArray(e.issues) ? { issues: e.issues.filter((x): x is string => typeof x === "string") } : {}),
      accounting,
    });
  }
  const completion: Completion = res.value;
  const accounting = accountingOfCompletion(completion);
  held.accounting = accounting;
  const generation: GenerationSummary = {
    model: completion.model,
    provider: completion.provider,
    servedModel: completion.servedModel,
    requestId: completion.requestId,
    finishReason: completion.finishReason,
    usage: completion.usage,
    cost: completion.cost,
    latencyMs: completion.latencyMs,
    warnings: completion.warnings,
  };

  // ۶) تحلیل خروجی: فقط پایان کامل (`stop`) و قالب دقیق
  if (completion.finishReason !== "stop") return fail("MODEL_OUTPUT_INVALID", { reason: "finish-reason", accounting });
  const out = parseModelOutput(completion.text);
  if (!out.ok) return fail("MODEL_OUTPUT_INVALID", { reason: out.reason, accounting });
  if (out.value.fenced) warnings.push("MODEL_OUTPUT_FENCED");
  if (out.value.extraFields) warnings.push("MODEL_OUTPUT_EXTRA_FIELDS");
  const done = { ...base, generation, accounting };

  if (out.value.insufficient) {
    return { ok: true, value: { ...done, ...none, status: "model-abstained", warnings } };
  }

  // ۷) مستندسازی و راستی‌آزمایی
  let grounded: ReturnType<typeof ground>;
  try {
    grounded = ground({ question: req.question, output: out.value, context, session, asOf: req.asOf, policy: cfg.policy, defaultDocumentId: req.documentId });
  } catch {
    return fail("VERIFICATION_FAILED", { accounting });
  }
  const value: Answer = {
    ...done,
    status: grounded.status,
    text: grounded.text,
    withheldReason: grounded.withheldReason,
    citations: grounded.citations,
    rejections: grounded.rejections,
    unsupportedNumbers: grounded.unsupportedNumbers,
    warnings: dedupe([...warnings, ...grounded.warnings]),
  };
  return { ok: true, value };
}

export function createOrchestrator(config: unknown): Readonly<{ ok: true; value: Orchestrator }> | Extract<AskResult, { ok: false }> {
  const resolved = resolveConfig(config);
  if (!resolved.ok) return resolved;
  const cfg = resolved.value;
  const orchestrator: Orchestrator = {
    async ask(input, options) {
      const held: { accounting: Accounting | null } = { accounting: null };
      try {
        return await run(cfg, input, options, held);
      } catch {
        // پورتی پرتاب کرد. اگر مدل فراخوانی شده بود، پولش را گم نمی‌کنیم؛ وگرنه «نامعلوم».
        return fail("INTERNAL_ERROR", { accounting: held.accounting ?? unknownAccounting() });
      }
    },
  };
  return { ok: true, value: orchestrator };
}
