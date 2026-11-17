/**
 * `createOrchestrator(config).ask(input)`: خط لولهٔ پرسش‌وپاسخ مستند (ADR-0016). ترتیب مراحل و دلیلش در §۸ ADR.
 * هرگز پرتاب نمی‌کند؛ هر پورت ممکن است پرتاب کند.
 */
import { buildContext, MIN_CONTEXT_CHARS, retrieve, type Context } from "@/modules/retrieval";
import type { ChatMessage, Completion } from "@/modules/ai-gateway";
import { accountingOfCompletion, accountingOfFailure, mergeAccounting, spendGate, unknownAccounting } from "./accounting";
import { resolveConfig, type ResolvedConfig } from "./config";
import { fail } from "./errors";
import { ground, type Grounded } from "./ground";
import { parseModelOutput } from "./model-output";
import { buildPrompt, buildRepairPrompt, hasRepairableRejection, PROMPT_VERSION, REPAIR_FEEDBACK_MAX_CHARS, REPAIR_PROMPT_VERSION } from "./prompt";
import { parseAskRequest } from "./request";
import type {
  Accounting,
  Answer,
  AnswerStatus,
  AskResult,
  CitationSession,
  GenerationSummary,
  Orchestrator,
  OrchestratorWarning,
  OutputInvalidReason,
  ParsedAsk,
  RepairOutcome,
  RepairSummary,
  RepairTrigger,
  RetrievalSummary,
} from "./types";

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

type Failure = Extract<AskResult, { ok: false }>;
type Port = Readonly<{ cfg: ResolvedConfig; req: ParsedAsk; session: CitationSession; signal: Signal }>;

/** آنچه از یک تلاشِ موفق به کاربر می‌رسد؛ هر تلاش خروجی‌اش را خودش از `ground` گذرانده است (ADR-0017 §۵). */
type Shown = Readonly<{
  status: Grounded["status"] | "model-abstained";
  text: string | null;
  withheldReason: Grounded["withheldReason"];
  citations: Grounded["citations"];
  rejections: Grounded["rejections"];
  unsupportedNumbers: readonly string[];
  warnings: readonly OrchestratorWarning[];
  generation: GenerationSummary;
}>;

type Attempt =
  | Readonly<{ ok: true; shown: Shown; accounting: Accounting }>
  | Readonly<{ ok: false; failure: Failure; accounting: Accounting }>;

/** تلاشی که برای ترمیم نامزد است؛ قالب‌های «بریده/خالی/بیش‌ازحد» نیستند (تلاش دوباره همان است). */
const FORMAT_REASONS: ReadonlySet<OutputInvalidReason> = new Set<OutputInvalidReason>(["not-json", "bad-fence", "not-object", "missing-answer", "bad-field"]);

/** رتبهٔ وضعیت برای «اکیداً بهتر» (ADR-0017 §۵). */
const RANK: Readonly<Record<AnswerStatus, number>> = { answered: 4, "answered-redacted": 3, "model-abstained": 2, withheld: 1, "no-sources": 0 };

/**
 * یک تلاشِ کامل: تولید ← تحلیل ← مستندسازی. `onAccounting` بلافاصله پس از برگشتنِ دروازه صدا زده می‌شود تا پرتابِ بعدی پول را گم نکند.
 * هرگز نتیجهٔ تلاش را با تلاش دیگر نمی‌چسباند؛ خروجی یا خطای همین تلاش است.
 */
async function attempt(port: Port, messages: readonly ChatMessage[], context: Context, onAccounting: (a: Accounting) => void): Promise<Attempt> {
  const { cfg, req, session, signal } = port;
  const res = await cfg.gateway.complete(
    {
      model: req.model,
      messages,
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
    onAccounting(accounting);
    if (e.code === "ABORTED") return { ok: false, failure: fail("ABORTED", { accounting }) as Failure, accounting };
    const failure = fail("GENERATION_FAILED", {
      gatewayCode: e.code,
      retryable: e.retryable === true,
      ...(typeof e.retryAfterMs === "number" ? { retryAfterMs: e.retryAfterMs } : {}),
      ...(Array.isArray(e.issues) ? { issues: e.issues.filter((x): x is string => typeof x === "string") } : {}),
      accounting,
    }) as Failure;
    return { ok: false, failure, accounting };
  }
  const completion: Completion = res.value;
  const accounting = accountingOfCompletion(completion);
  onAccounting(accounting);
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
  const bad = (reason: OutputInvalidReason): Attempt => ({ ok: false, failure: fail("MODEL_OUTPUT_INVALID", { reason, accounting }) as Failure, accounting });

  // تحلیل خروجی: فقط پایان کامل (`stop`) و قالب دقیق
  if (completion.finishReason !== "stop") return bad("finish-reason");
  const out = parseModelOutput(completion.text);
  if (!out.ok) return bad(out.reason);
  const warnings: OrchestratorWarning[] = [];
  if (out.value.fenced) warnings.push("MODEL_OUTPUT_FENCED");
  if (out.value.extraFields) warnings.push("MODEL_OUTPUT_EXTRA_FIELDS");
  if (out.value.insufficient) {
    const shown: Shown = { status: "model-abstained", text: null, withheldReason: null, citations: [], rejections: [], unsupportedNumbers: [], warnings, generation };
    return { ok: true, shown, accounting };
  }

  // مستندسازی و راستی‌آزمایی
  let grounded: Grounded;
  try {
    grounded = ground({ question: req.question, output: out.value, context, session, asOf: req.asOf, policy: cfg.policy, defaultDocumentId: req.documentId });
  } catch {
    return { ok: false, failure: fail("VERIFICATION_FAILED", { accounting }) as Failure, accounting };
  }
  const shown: Shown = {
    status: grounded.status,
    text: grounded.text,
    withheldReason: grounded.withheldReason,
    citations: grounded.citations,
    rejections: grounded.rejections,
    unsupportedNumbers: grounded.unsupportedNumbers,
    warnings: dedupe([...warnings, ...grounded.warnings]),
    generation,
  };
  return { ok: true, shown, accounting };
}

/** آیا و چرا ترمیم؟ (ADR-0017 §۳). `model-abstained` هرگز؛ ردِّ فقط‌پایگاهی ترمیم‌ناپذیر. */
function planRepair(first: Attempt): Readonly<{ trigger: RepairTrigger }> | Readonly<{ skip: "not-needed" | "not-repairable" }> {
  if (!first.ok) {
    const e = first.failure.error;
    return e.code === "MODEL_OUTPUT_INVALID" && e.reason !== undefined && FORMAT_REASONS.has(e.reason) ? { trigger: "output-invalid" } : { skip: "not-repairable" };
  }
  const { status, rejections } = first.shown;
  if (status === "answered" || status === "model-abstained") return { skip: "not-needed" };
  if (hasRepairableRejection(rejections)) return { trigger: "citation-rejected" };
  if (status === "withheld" && rejections.length === 0) return { trigger: "no-valid-citation" };
  return { skip: "not-repairable" };
}

async function run(cfg: ResolvedConfig, input: unknown, options: unknown, held: { accounting: Accounting | null }): Promise<AskResult> {
  const sig = readSignal(options);
  if (!sig.ok) return fail("INVALID_INPUT", { issues: ["options.signal"] });
  const signal = sig.signal;
  const parsed = parseAskRequest(input);
  if (!parsed.ok) return parsed;
  const req = parsed.value;
  if (isAborted(signal)) return fail("ABORTED");
  const repairPolicy = cfg.policy.repair;

  // ۱) حدّ مدل ← بودجهٔ زمینه (پیش از هر هزینه). با ترمیم، جای بلوک بازخورد از پیش کنار گذاشته می‌شود.
  const limits = cfg.gateway.limits(req.model);
  if (limits === null || limits === undefined) return fail("UNKNOWN_MODEL");
  if (typeof limits.maxInputChars !== "number" || typeof limits.maxOutputTokens !== "number") return fail("INTERNAL_ERROR");
  if (req.maxOutputTokens > limits.maxOutputTokens) return fail("INVALID_INPUT", { issues: ["maxOutputTokens"] });
  const fixedChars = buildPrompt(req.question, "").chars;
  const reserve = repairPolicy === undefined ? 0 : REPAIR_FEEDBACK_MAX_CHARS;
  const budget = Math.min(req.contextMaxChars, limits.maxInputChars - fixedChars - reserve);
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
  const repairOf = (outcome: RepairOutcome, trigger: RepairTrigger | null, attempts: 0 | 1 | 2): { repair?: RepairSummary } =>
    repairPolicy === undefined ? {} : { repair: { outcome, trigger, attempts, promptVersion: attempts === 2 ? REPAIR_PROMPT_VERSION : null } };

  // ۳) بدون منبع ⇒ بدون مدل (هزینهٔ صفر؛ پاسخِ بی‌پشتوانه ممنوع)
  if (context.sources.length === 0) {
    const value: Answer = { ...base, text: null, withheldReason: null, citations: [], rejections: [], unsupportedNumbers: [], status: "no-sources", generation: null, accounting: null, warnings, ...repairOf("not-needed", null, 0) };
    return { ok: true, value };
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

  const answerOf = (shown: Shown, accounting: Accounting, extra: readonly OrchestratorWarning[], repair: { repair?: RepairSummary }): AskResult => {
    const { generation, status, text, withheldReason, citations, rejections, unsupportedNumbers } = shown;
    return { ok: true, value: { ...base, generation, status, text, withheldReason, citations, rejections, unsupportedNumbers, accounting, warnings: dedupe([...warnings, ...shown.warnings, ...extra]), ...repair } };
  };

  // ۵) تلاش نخست: تولید ← تحلیل ← مستندسازی
  const port: Port = { cfg, req, session, signal };
  const prompt = buildPrompt(req.question, context.text);
  const first = await attempt(port, prompt.messages, context, (a) => {
    held.accounting = a;
  });
  if (repairPolicy === undefined) return first.ok ? answerOf(first.shown, first.accounting, [], {}) : first.failure;

  // ۶) ترمیم کنترل‌شده (ADR-0017): حداکثر یک تلاش اضافی؛ هر شرطِ ناروشن ⇒ همان نتیجهٔ نخست
  const keepFirst = (outcome: RepairOutcome, trigger: RepairTrigger | null): AskResult => (first.ok ? answerOf(first.shown, first.accounting, [], repairOf(outcome, trigger, 1)) : first.failure);
  const plan = planRepair(first);
  if ("skip" in plan) return keepFirst(plan.skip, null);
  const { trigger } = plan;
  const gate = spendGate(first.accounting, repairPolicy);
  if (gate !== "ok") return keepFirst(gate === "cost-cap" ? "skipped-cost-cap" : "skipped-cost-unknown", trigger);
  if (isAborted(signal)) return keepFirst("skipped-aborted", trigger);
  const rejections = first.ok ? first.shown.rejections : [];
  const repairPrompt = buildRepairPrompt(req.question, context.text, trigger, rejections);

  let second: Attempt | null = null;
  try {
    // `held` پس از این بلوک (در هر دو شاخه) با مجموعِ دو تلاش پر می‌شود و درون `attempt` چیزی خارج از این `try` پرتاب نمی‌شود؛ پس پس‌خوردِ میانی لازم نیست.
    second = await attempt(port, repairPrompt.messages, context, () => undefined);
  } catch {
    // پورت پرتاب کرد؛ پولِ تلاش دوم نامعلوم است (نه صفر) و نتیجهٔ نخست دست‌نخورده می‌ماند.
  }
  const merged = mergeAccounting(first.accounting, second === null ? unknownAccounting() : second.accounting);
  held.accounting = merged;
  const done = (outcome: RepairOutcome): { repair?: RepairSummary } => repairOf(outcome, trigger, 2);

  if (first.ok) {
    if (second !== null && second.ok && RANK[second.shown.status] > RANK[first.shown.status]) return answerOf(second.shown, merged, ["REPAIRED"], done("adopted"));
    return answerOf(first.shown, merged, ["REPAIR_FAILED"], done(second !== null && second.ok ? "not-improved" : "failed"));
  }
  // تلاش نخست پاسخی نداشت: هر پاسخِ موفقِ دوم پذیرفته می‌شود؛ وگرنه همان خطای نخست (جز لغو) با حسابداری تجمیعی.
  if (second !== null && second.ok) return answerOf(second.shown, merged, ["REPAIRED"], done("adopted"));
  const source = second !== null && second.failure.error.code === "ABORTED" ? second.failure : first.failure;
  return { ok: false, error: { ...source.error, accounting: merged } };
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
