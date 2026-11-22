/**
 * `createToolGateway`: یک گامِ «مدل با ابزار» با همان ضمانت‌های `createGateway` (ADR-0055، برش CT‑3b).
 *
 * خط لوله: اعتبارسنجی مرزی (پایه با `parseRequest` + ابزار/continuation) ← (لغو؟) ← فراخوانیِ ارائه‌دهنده در مسابقه با مهلت/لغو ←
 * `decodeToolReply` بر بدنهٔ خام ← مصرف و هزینهٔ صحیح ← **رویدادِ مصرف برای هر فراخوانیِ انجام‌شده، حتی ناموفق** ← نتیجه.
 *
 * فقط یک گام: حلقه، سقفِ گام، اجرای ابزار و تاب‌آوری (تلاش دوباره/جایگزین) این‌جا **نیست** (CT‑4 و برش‌های بعد).
 * هرگز پرتاب نمی‌کند. خطا بی‌نشتِ محتوا. مصرفِ یک گامِ شکست‌خورده در `error.usage/cost` می‌ماند چون هزینه شده است.
 */
import { resolveConfig } from "./config";
import type { ResolvedConfig, ResolvedModel } from "./config";
import { raceDeadline } from "./deadline";
import { classifyThrown, fail, makeError } from "./errors";
import { emit, readClock } from "./gateway";
import { computeCost, parseUsage } from "./pricing";
import { resolveToolSetup } from "./tool-step-config";
import type { ResolvedToolModel } from "./tool-step-config";
import { parseToolStepRequest } from "./tool-step-request";
import { decodeToolReply } from "./tool-wire-decode";
import type { DecodedToolReply, ToolFinish, ToolWireFormat } from "./tool-wire-types";
import type { ToolGateway, ToolGatewayResult, ToolModelProvider, ToolProviderCall, ToolStepError, ToolStepResult } from "./tool-step-types";
import type { Cost, FinishReason, GatewayError, GatewayErrorCode, GatewayWarning, ModelLimits, Usage, UsageEvent } from "./types";

/** نشانهٔ ثابتِ پاسخِ بریده (در `error.issues[0]`) تا بی‌افزودنِ کدِ تازه به `GatewayErrorCode` قابل‌تشخیص باشد. */
export const TRUNCATED_TOOL_CALL_ISSUE = "TRUNCATED_TOOL_CALL";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function stepError(code: GatewayErrorCode, usage: Usage | null, cost: Cost | null, extra: Parameters<typeof makeError>[1] = {}): ToolStepResult {
  const e: GatewayError = makeError(code, extra);
  return { ok: false, error: Object.freeze({ ...e, usage, cost }) as ToolStepError };
}

/** `ToolFinish` ← `FinishReason`ِ رویدادِ مصرف: پایانِ عادیِ گامِ ابزار `stop` ثبت می‌شود (نوعِ رویداد تغییر نمی‌کند). */
const eventFinish = (f: ToolFinish): FinishReason => (f === "tool_calls" ? "stop" : f);

type Interpreted =
  | Readonly<{ kind: "ok"; reply: DecodedToolReply }>
  | Readonly<{ kind: "fail"; code: GatewayErrorCode; extra?: Parameters<typeof makeError>[1] }>;

async function run(cfg: ResolvedConfig, tools: ReadonlyMap<string, ResolvedToolModel>, input: unknown, options: unknown): Promise<ToolStepResult> {
  let signal: AbortSignal | undefined;
  if (options !== undefined) {
    const s = isRecord(options) ? options["signal"] : null;
    if (!isRecord(options) || (s !== undefined && !(typeof AbortSignal !== "undefined" && s instanceof AbortSignal))) {
      return stepError("INVALID_REQUEST", null, null, { issues: ["options.signal باید AbortSignal باشد."] });
    }
    signal = s as AbortSignal | undefined;
  }
  const parsed = parseToolStepRequest(input, (name) => cfg.models.get(name), (name) => tools.get(name));
  if (!parsed.ok) return stepError(parsed.error.code, null, null, { issues: parsed.error.issues ?? [] });
  const { base: req, format, tools: toolsWire, continuation } = parsed.value;
  const model = cfg.models.get(req.model) as ResolvedModel;
  const toolProvider = (tools.get(req.model) as ResolvedToolModel).provider as ToolModelProvider;
  if (signal?.aborted) return stepError("ABORTED", null, null);

  const controller = new AbortController();
  const call: ToolProviderCall = Object.freeze({
    model: model.providerModel,
    format,
    messages: req.messages,
    tools: toolsWire,
    continuation,
    maxOutputTokens: req.maxOutputTokens,
    temperature: req.temperature,
    stopSequences: req.stopSequences,
    signal: controller.signal,
  });
  const startedAtMs = readClock(cfg.clock);
  const settled = await raceDeadline(Promise.resolve().then(() => toolProvider.completeWithTools(call)), req.timeoutMs, cfg.timers, signal);
  if (settled.kind !== "value") controller.abort();
  const latencyMs = Math.max(0, Math.floor(readClock(cfg.clock) - startedAtMs));

  let usage: Usage | null = null;
  let interpreted: Interpreted;
  if (settled.kind === "value") {
    const d = decodeToolReply(format, settled.value);
    if (d.ok) {
      usage = d.value.usage === null ? null : parseUsage(d.value.usage);
      interpreted = { kind: "ok", reply: d.value };
    } else {
      usage = d.error.usage === null ? null : parseUsage(d.error.usage);
      // رمزگشا فقط BAD_RESPONSE و TRUNCATED_TOOL_CALL می‌دهد (INVALID_* مالِ سمتِ درخواست‌اند)؛ هر دو «پاسخِ نامعتبرِ ارائه‌دهنده»‌اند.
      const issues = d.error.code === "TRUNCATED_TOOL_CALL" ? [TRUNCATED_TOOL_CALL_ISSUE, ...d.error.issues] : d.error.issues;
      interpreted = { kind: "fail", code: "PROVIDER_BAD_RESPONSE", extra: { issues } };
    }
  } else if (settled.kind === "threw") {
    const c = classifyThrown(settled.error);
    interpreted = { kind: "fail", code: c.code, extra: { retryAfterMs: c.retryAfterMs } };
  } else {
    interpreted = { kind: "fail", code: settled.kind === "timeout" ? "TIMEOUT" : "ABORTED" };
  }
  if (usage !== null) usage = Object.freeze({ ...usage });
  const cost: Cost | null = usage !== null && model.price !== null ? Object.freeze(computeCost(usage, model.price)) : null;

  const warnings: GatewayWarning[] = [];
  if (interpreted.kind === "ok") {
    const r = interpreted.reply;
    if (usage === null) warnings.push("USAGE_MISSING");
    if (model.price === null) warnings.push("UNPRICED");
    if (r.finish === "length") warnings.push("OUTPUT_TRUNCATED");
    if (r.text.trim() === "" && r.toolCalls.length === 0) warnings.push("EMPTY_OUTPUT");
  }

  const event: UsageEvent = Object.freeze({
    requestId: req.requestId,
    model: req.model,
    provider: model.provider,
    providerModel: model.providerModel,
    servedModel: interpreted.kind === "ok" ? interpreted.reply.servedModel : null,
    startedAtMs,
    latencyMs,
    outcome: interpreted.kind === "ok" ? "ok" : interpreted.code,
    finishReason: interpreted.kind === "ok" ? eventFinish(interpreted.reply.finish) : null,
    usage,
    cost,
  });
  const sinkWarnings = await emit(cfg, event);

  if (interpreted.kind === "fail") return stepError(interpreted.code, usage, cost, { ...interpreted.extra, warnings: sinkWarnings });
  const r = interpreted.reply;
  return {
    ok: true,
    value: Object.freeze({
      text: r.text,
      toolCalls: r.toolCalls,
      finish: r.finish,
      assistantMessage: r.assistantMessage,
      format: format as ToolWireFormat,
      model: req.model,
      provider: model.provider,
      servedModel: r.servedModel,
      requestId: req.requestId,
      usage,
      cost,
      latencyMs,
      warnings: Object.freeze([...warnings, ...sinkWarnings]),
    }),
  };
}

/**
 * سازندهٔ دروازهٔ ابزار. `config` همان پیکربندیِ `createGateway` است (قیمت، حد، مهلت، ساعت، مقصدِ مصرف)؛ `setup` مدل‌های ابزاری را
 * با قالبِ سیم و ارائه‌دهنده‌شان می‌شناساند. هر دو `unknown` و روی مرز سنجیده می‌شوند؛ هرگز پرتاب نمی‌کند.
 */
export function createToolGateway(config: unknown, setup: unknown): ToolGatewayResult {
  const resolved = resolveConfig(config);
  if (!resolved.ok) return fail("INVALID_CONFIG", { issues: resolved.issues });
  const cfg = resolved.value;
  const t = resolveToolSetup(setup, (n) => cfg.models.has(n));
  if (!t.ok) return fail("INVALID_CONFIG", { issues: t.issues });
  const tools = t.value;
  const gateway: ToolGateway = Object.freeze({
    async completeStep(input: unknown, options?: Readonly<{ signal?: AbortSignal }>): Promise<ToolStepResult> {
      try {
        return await run(cfg, tools, input, options);
      } catch {
        return stepError("INTERNAL_ERROR", null, null);
      }
    },
    toolFormat(model: string): ToolWireFormat | null {
      const m = typeof model === "string" ? tools.get(model) : undefined;
      return m === undefined ? null : m.format;
    },
    limits(model: string): ModelLimits | null {
      const m = typeof model === "string" ? cfg.models.get(model) : undefined;
      return m === undefined ? null : { maxInputChars: m.maxInputChars, maxOutputTokens: m.maxOutputTokens, priced: m.price !== null };
    },
  });
  return { ok: true, value: gateway };
}
