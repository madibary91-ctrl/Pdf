/**
 * `createResilientGateway`: تلاش دوباره و جایگزین روی هستهٔ برش ۱ (ADR-0015).
 *
 * هر تلاش یک فراخوانیِ کاملِ خط لولهٔ هسته است ⇒ برای هر تلاشِ رسیده به ارائه‌دهنده یک رویداد مصرف می‌رود (هیچ هزینهٔ پنهانی نیست).
 * لایه بی‌حالت و بی‌I/O است: ساعت، تایمر و تصادف همه تزریق می‌شوند. هرگز پرتاب نمی‌کند.
 * سیاست (چه چیزی تلاش/جایگزین شود و کِی بایستیم) در `decision.ts` خالص و جدا آزموده می‌شود؛ اینجا فقط «اجرا»ست.
 */
import { drawUnit } from "./backoff";
import { resolveConfig } from "./config";
import type { ResolvedConfig, ResolvedModel } from "./config";
import { raceDeadline } from "./deadline";
import { decideNext } from "./decision";
import { fail, makeError } from "./errors";
import { completeObserved, readClock } from "./gateway";
import { parseRequest } from "./request";
import { resolvePolicy } from "./resilience-policy";
import type { AttemptRecord, ResilienceReport, ResilientGateway, ResilientResult, ResolvedPolicy, SpendEntry, StopReason } from "./resilience-types";
import type { Completion, GatewayError, GatewayErrorCode, GatewayResult, GatewayWarning, ModelLimits, Timers, UsageEvent } from "./types";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** خطاهایی که یعنی «هنوز به ارائه‌دهنده نرسیدیم» (چیزی مصرف نشده)؛ بقیهٔ خطاها محافظه‌کارانه «رسیده» حساب می‌شوند. */
const BEFORE_PROVIDER: ReadonlySet<GatewayErrorCode> = new Set<GatewayErrorCode>(["INVALID_REQUEST", "UNKNOWN_MODEL", "ABORTED"]);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** وضعیتِ در حال ساختِ یک فراخوانی؛ بیرون از `run` ساخته می‌شود تا حتی هنگام شکستِ غیرمنتظره، گزارشِ تلاش‌های انجام‌شده از دست نرود. */
type Trace = {
  requestedModel: string | null;
  readonly attempts: AttemptRecord[];
  readonly warnings: GatewayWarning[];
};

function addWarnings(trace: Trace, ws: readonly GatewayWarning[]): void {
  for (const w of ws) if (!trace.warnings.includes(w)) trace.warnings.push(w);
}

/** `RETRIED`/`FELL_BACK` فقط از تلاش‌های واقعاً رسیده به ارائه‌دهنده؛ ترتیب ثابت و بی‌تکرار. */
function warningsOf(trace: Trace): GatewayWarning[] {
  const out = [...trace.warnings];
  const reached = trace.attempts.filter((a) => a.reachedProvider);
  if (reached.some((a) => a.modelAttempt > 1) && !out.includes("RETRIED")) out.push("RETRIED");
  if (reached.some((a) => a.model !== trace.requestedModel) && !out.includes("FELL_BACK")) out.push("FELL_BACK");
  return out;
}

function buildReport(trace: Trace, stoppedBecause: StopReason): ResilienceReport {
  const sums = new Map<string, bigint>();
  let costUnknownAttempts = 0;
  for (const a of trace.attempts) {
    if (!a.reachedProvider) continue;
    if (a.cost === null) costUnknownAttempts++;
    else sums.set(a.cost.currency, (sums.get(a.cost.currency) ?? BigInt(0)) + BigInt(a.cost.micros));
  }
  const spend: SpendEntry[] = [...sums].map(([currency, total]) => Object.freeze({ currency, micros: total <= MAX_SAFE ? Number(total) : null }));
  return Object.freeze({
    requestedModel: trace.requestedModel,
    attempts: Object.freeze(trace.attempts.map((a) => Object.freeze({ ...a }))),
    spend: Object.freeze(spend),
    costUnknownAttempts,
    stoppedBecause,
  });
}

function errorResult(trace: Trace, error: GatewayError, reason: StopReason): ResilientResult {
  return { ok: false, error: Object.freeze({ ...error, warnings: Object.freeze(warningsOf(trace)), report: buildReport(trace, reason) }) };
}

/**
 * انتظارِ backoff، یا بیدار شدن زودتر با لغو. تایمر/شنونده همیشه پاک (`raceDeadline`).
 * نتیجه عمداً برنمی‌گردد: لغوِ حین انتظار را بالای حلقه (`signal.aborted`) می‌بینیم، پس یک مسیرِ واحد برای لغو داریم.
 */
async function sleep(ms: number, timers: Timers, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return;
  await raceDeadline(new Promise<never>(() => undefined), ms, timers, signal);
}

async function run(cfg: ResolvedConfig, policy: ResolvedPolicy, input: unknown, options: unknown, trace: Trace): Promise<ResilientResult> {
  let signal: AbortSignal | undefined;
  if (options !== undefined) {
    const s = isRecord(options) ? options["signal"] : null;
    if (!isRecord(options) || (s !== undefined && !(typeof AbortSignal !== "undefined" && s instanceof AbortSignal))) {
      return errorResult(trace, makeError("INVALID_REQUEST", { issues: ["options.signal باید AbortSignal باشد."] }), "non_retryable");
    }
    signal = s as AbortSignal | undefined;
  }

  // درخواست یک‌بار و فقط روی مدل اصلی سنجیده می‌شود؛ مهلتِ صریحِ درخواست را با «مدلِ مهلت‌صفر» از مهلتِ پیش‌فرضِ مدل جدا می‌کنیم
  // تا هر جایگزین مهلتِ خودش را بگیرد. جایگزین‌ها بعداً دوباره از مرزِ هسته می‌گذرند (سقف‌های خودشان).
  const parsed = parseRequest(input, (name) => {
    const m = cfg.models.get(name);
    return m === undefined ? undefined : { ...m, timeoutMs: 0 };
  });
  if (!parsed.ok) return errorResult(trace, parsed.error, "non_retryable");
  const req = parsed.value;
  const explicitTimeoutMs = req.timeoutMs === 0 ? null : req.timeoutMs;
  trace.requestedModel = req.model;
  const chain: readonly string[] = [req.model, ...(policy.fallbacks.get(req.model) ?? [])];

  const deadlineAt = readClock(cfg.clock) + policy.totalTimeoutMs;
  let callsMade = 0;
  let firstFailure: GatewayError | null = null;
  let lastReached: GatewayError | null = null;

  const stopWith = (reason: StopReason): ResilientResult => {
    if (reason === "aborted") return errorResult(trace, makeError("ABORTED"), reason);
    const rep = lastReached ?? firstFailure ?? makeError("TIMEOUT");
    return errorResult(trace, makeError(rep.code, { retryAfterMs: rep.retryAfterMs ?? null, issues: rep.issues }), reason);
  };

  for (let position = 0; position < chain.length; position++) {
    const model = chain[position] as string;
    const spec = cfg.models.get(model) as ResolvedModel;
    let waitedMs = 0;
    for (let modelAttempt = 1; ; modelAttempt++) {
      if (signal?.aborted) return stopWith("aborted");
      const remaining = Math.floor(deadlineAt - readClock(cfg.clock));
      if (remaining < 1) return stopWith("deadline");

      const seen: { event: UsageEvent | null } = { event: null };
      const attemptInput = {
        model,
        messages: req.messages,
        maxOutputTokens: req.maxOutputTokens,
        temperature: req.temperature,
        stopSequences: req.stopSequences,
        ...(req.requestId === null ? {} : { requestId: req.requestId }),
        timeoutMs: Math.min(explicitTimeoutMs ?? spec.timeoutMs, remaining),
      };
      const res: GatewayResult<Completion> = await completeObserved(cfg, attemptInput, signal === undefined ? undefined : { signal }, (e) => {
        seen.event = e;
      });

      const reached = seen.event !== null || (!res.ok && !BEFORE_PROVIDER.has(res.error.code));
      if (reached) callsMade++;
      trace.attempts.push({
        index: trace.attempts.length + 1,
        model,
        modelAttempt,
        waitedMs,
        outcome: res.ok ? "ok" : res.error.code,
        reachedProvider: reached,
        usage: seen.event === null ? null : seen.event.usage,
        cost: seen.event === null ? null : seen.event.cost,
        latencyMs: seen.event === null ? 0 : seen.event.latencyMs,
      });
      addWarnings(trace, res.ok ? res.value.warnings : res.error.warnings);

      if (res.ok) {
        return { ok: true, value: Object.freeze({ ...res.value, warnings: Object.freeze(warningsOf(trace)), report: buildReport(trace, "success") }) };
      }
      const err = res.error;
      if (firstFailure === null) firstFailure = err;
      if (reached) lastReached = err;

      const decision = decideNext({
        code: err.code,
        retryable: err.retryable,
        retryAfterMs: err.retryAfterMs ?? null,
        position,
        chainLength: chain.length,
        modelAttempt,
        callsMade,
        remainingMs: Math.floor(deadlineAt - readClock(cfg.clock)),
        policy,
        jitterUnit: () => drawUnit(policy.random),
      });
      if (decision.kind === "stop") return stopWith(decision.reason);
      if (decision.kind === "next_model") break;
      await sleep(decision.waitMs, cfg.timers, signal);
      waitedMs = decision.waitMs;
    }
  }
  return stopWith("chain_exhausted");
}

/**
 * سازندهٔ دروازهٔ تاب‌آور. هر دو ورودی `unknown`‌اند و روی مرز سنجیده می‌شوند؛ هرگز پرتاب نمی‌کند.
 * نتیجه ساختاراً زیرنوعِ `Gateway` است.
 */
export function createResilientGateway(gatewayConfig: unknown, policy: unknown): GatewayResult<ResilientGateway> {
  try {
    const cfg = resolveConfig(gatewayConfig);
    const pol = resolvePolicy(policy, cfg.ok ? new Set(cfg.value.models.keys()) : null);
    if (!cfg.ok || !pol.ok) return fail("INVALID_CONFIG", { issues: [...(cfg.ok ? [] : cfg.issues), ...(pol.ok ? [] : pol.issues)] });
    const config = cfg.value;
    const resolved = pol.value;
    const gateway: ResilientGateway = Object.freeze({
      async complete(input: unknown, options?: Readonly<{ signal?: AbortSignal }>): Promise<ResilientResult> {
        const trace: Trace = { requestedModel: null, attempts: [], warnings: [] };
        try {
          return await run(config, resolved, input, options, trace);
        } catch {
          return errorResult(trace, makeError("INTERNAL_ERROR"), "non_retryable");
        }
      },
      limits(model: string): ModelLimits | null {
        const m = typeof model === "string" ? config.models.get(model) : undefined;
        return m === undefined ? null : { maxInputChars: m.maxInputChars, maxOutputTokens: m.maxOutputTokens, priced: m.price !== null };
      },
    });
    return { ok: true, value: gateway };
  } catch {
    return fail("INVALID_CONFIG", { issues: ["پیکربندی قابل خواندن نیست."] });
  }
}
