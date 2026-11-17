/**
 * `createGateway`: واسط یکسان و ایمنِ مدل زبانی (ADR-0014، برش ۱).
 *
 * خط لولهٔ هر درخواست: اعتبارسنجی مرزی ← (لغو؟) ← فراخوانی ارائه‌دهنده در مسابقه با مهلت/لغو ← اعتبارسنجی پاسخ ←
 * مصرف و هزینهٔ صحیح ← **رویداد مصرف (برای هر فراخوانیِ انجام‌شده، حتی ناموفق)** ← نتیجه.
 *
 * ضمانت‌ها: هرگز پرتاب نمی‌کند؛ خطا بی‌نشتِ جزئیات؛ هیچ ناهنجاری‌ای بی‌صدا نمی‌ماند (`warnings`)؛ ثبت مصرف شکست‌خورد ⇒
 * هشدار صریح و پاسخ از دست نمی‌رود.
 */
import { resolveConfig } from "./config";
import type { ResolvedConfig, ResolvedModel } from "./config";
import { raceDeadline } from "./deadline";
import { classifyThrown, fail } from "./errors";
import type { makeError } from "./errors";
import { computeCost } from "./pricing";
import { parseRequest } from "./request";
import { parseReply, salvageUsage } from "./reply";
import type { ParsedReply } from "./reply";
import type {
  Clock,
  Completion,
  Cost,
  Gateway,
  GatewayErrorCode,
  GatewayResult,
  GatewayWarning,
  ModelLimits,
  ModelProvider,
  ProviderCall,
  Usage,
  UsageEvent,
} from "./types";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** ساعتِ خراب (غیرعددی/نامتناهی/پرتاب‌کننده) بلند شکست می‌خورد (`INTERNAL_ERROR`)، نه با زمان جعلی ادامه. */
function readClock(clock: Clock): number {
  const t = clock.nowMs();
  if (typeof t !== "number" || !Number.isFinite(t)) throw new Error("clock returned a non-finite value");
  return t;
}

async function emit(cfg: ResolvedConfig, event: UsageEvent): Promise<GatewayWarning[]> {
  const sink = cfg.usageSink;
  if (sink === null) return [];
  const settled = await raceDeadline(
    Promise.resolve().then(() => sink.record(event)),
    cfg.sinkTimeoutMs,
    cfg.timers,
  );
  if (settled.kind === "value") return [];
  return [settled.kind === "timeout" ? "USAGE_SINK_TIMEOUT" : "USAGE_SINK_FAILED"];
}

type Failure = Readonly<{ code: GatewayErrorCode; extra?: Parameters<typeof makeError>[1] }>;
type Interpreted = Readonly<{ kind: "ok"; reply: ParsedReply }> | Readonly<{ kind: "fail"; failure: Failure }>;

async function run(cfg: ResolvedConfig, input: unknown, options: unknown): Promise<GatewayResult<Completion>> {
  let signal: AbortSignal | undefined;
  if (options !== undefined) {
    const s = isRecord(options) ? options["signal"] : null;
    if (!isRecord(options) || (s !== undefined && !(typeof AbortSignal !== "undefined" && s instanceof AbortSignal))) {
      return fail("INVALID_REQUEST", { issues: ["options.signal باید AbortSignal باشد."] });
    }
    signal = s as AbortSignal | undefined;
  }

  const parsed = parseRequest(input, (name) => cfg.models.get(name));
  if (!parsed.ok) return parsed;
  const req = parsed.value;
  const model = cfg.models.get(req.model) as ResolvedModel;
  const provider = cfg.providers.get(model.provider) as ModelProvider;
  if (signal?.aborted) return fail("ABORTED");

  const controller = new AbortController();
  const call: ProviderCall = Object.freeze({
    model: model.providerModel,
    messages: req.messages,
    maxOutputTokens: req.maxOutputTokens,
    temperature: req.temperature,
    stopSequences: req.stopSequences,
    signal: controller.signal,
  });
  const startedAtMs = readClock(cfg.clock);
  const settled = await raceDeadline(
    Promise.resolve().then(() => provider.complete(call)),
    req.timeoutMs,
    cfg.timers,
    signal,
  );
  if (settled.kind !== "value") controller.abort();
  const latencyMs = Math.max(0, Math.floor(readClock(cfg.clock) - startedAtMs));

  let usage: Usage | null = null;
  let interpreted: Interpreted;
  if (settled.kind === "value") {
    const r = parseReply(settled.value);
    if (r.ok) {
      usage = r.value.usage;
      interpreted = { kind: "ok", reply: r.value };
    } else {
      usage = salvageUsage(settled.value);
      interpreted = { kind: "fail", failure: { code: "PROVIDER_BAD_RESPONSE", extra: { issues: r.issues } } };
    }
  } else if (settled.kind === "threw") {
    const c = classifyThrown(settled.error);
    interpreted = { kind: "fail", failure: { code: c.code, extra: { retryAfterMs: c.retryAfterMs } } };
  } else {
    interpreted = { kind: "fail", failure: { code: settled.kind === "timeout" ? "TIMEOUT" : "ABORTED" } };
  }
  if (usage !== null) usage = Object.freeze({ ...usage });
  const cost: Cost | null = usage !== null && model.price !== null ? Object.freeze(computeCost(usage, model.price)) : null;

  const warnings: GatewayWarning[] = [];
  if (interpreted.kind === "ok") {
    if (usage === null) warnings.push("USAGE_MISSING");
    if (model.price === null) warnings.push("UNPRICED");
    if (interpreted.reply.finishReason === "length") warnings.push("OUTPUT_TRUNCATED");
    if (interpreted.reply.text.trim() === "") warnings.push("EMPTY_OUTPUT");
  }

  const event: UsageEvent = Object.freeze({
    requestId: req.requestId,
    model: req.model,
    provider: model.provider,
    providerModel: model.providerModel,
    servedModel: interpreted.kind === "ok" ? interpreted.reply.servedModel : null,
    startedAtMs,
    latencyMs,
    outcome: interpreted.kind === "ok" ? "ok" : interpreted.failure.code,
    finishReason: interpreted.kind === "ok" ? interpreted.reply.finishReason : null,
    usage,
    cost,
  });
  const sinkWarnings = await emit(cfg, event);

  if (interpreted.kind === "fail") return fail(interpreted.failure.code, { ...interpreted.failure.extra, warnings: sinkWarnings });
  const reply = interpreted.reply;
  return {
    ok: true,
    value: Object.freeze({
      text: reply.text,
      finishReason: reply.finishReason,
      model: req.model,
      provider: model.provider,
      servedModel: reply.servedModel,
      requestId: req.requestId,
      usage,
      cost,
      latencyMs,
      warnings: Object.freeze([...warnings, ...sinkWarnings]),
    }),
  };
}

/** سازندهٔ دروازه. پیکربندی `unknown` است و روی مرز سنجیده می‌شود؛ هرگز پرتاب نمی‌کند. */
export function createGateway(config: unknown): GatewayResult<Gateway> {
  const resolved = resolveConfig(config);
  if (!resolved.ok) return fail("INVALID_CONFIG", { issues: resolved.issues });
  const cfg = resolved.value;
  const gateway: Gateway = Object.freeze({
    async complete(input: unknown, options?: Readonly<{ signal?: AbortSignal }>): Promise<GatewayResult<Completion>> {
      try {
        return await run(cfg, input, options);
      } catch {
        return fail("INTERNAL_ERROR");
      }
    },
    limits(model: string): ModelLimits | null {
      const m = typeof model === "string" ? cfg.models.get(model) : undefined;
      return m === undefined ? null : { maxInputChars: m.maxInputChars, maxOutputTokens: m.maxOutputTokens, priced: m.price !== null };
    },
  });
  return { ok: true, value: gateway };
}
