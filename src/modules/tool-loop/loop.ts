/**
 * کنترل‌گرِ خالصِ حلقهٔ ابزار (ADR-0056، CT‑4a): ماشینِ حالتِ تغییرناپذیر. هیچ I/O ندارد؛ هرگز پرتاب نمی‌کند.
 *
 *   start ─▶ call-model ─onStep─▶ run-tools ─onToolResults─▶ call-model ─…─▶ done
 *
 * ترتیبِ بررسی‌ها پیش از هر «گامِ بعد» ثابت است: سقفِ گام ← هزینه. این بررسی **پیش از اجرای ابزارها** هم انجام می‌شود
 * (ابزاری که نتیجه‌اش هرگز به مدل نمی‌رسد اجرا نمی‌شود) و پس از نتیجه‌ها دوباره (continuation بزرگ‌تر شده است).
 */
import { TOOL_STEP_LIMITS, TRUNCATED_TOOL_CALL_ISSUE, encodeToolResults, sumStepSpend } from "@/modules/ai-gateway";
import type { ToolCall, ToolWireFormat, WireMessage } from "@/modules/ai-gateway";
import { budgetVerdict } from "./budget";
import { canonicalCallKey } from "./canonical";
import { resolveToolLoopConfig } from "./config";
import { fail } from "./errors";
import type { LoopOutcome, LoopResult, LoopToolResult, LoopTransition, StopReason, ToolLoop, ToolLoopConfig, ToolLoopState } from "./types";

const FORMATS: ReadonlySet<string> = new Set(["openai-chat", "anthropic-messages"]);
const FINISHES: ReadonlySet<string> = new Set(["stop", "length", "content_filter", "other", "tool_calls"]);
const ERROR_CODE_RE = /^[A-Z][A-Z_]{0,39}$/;
const TOKEN_CAP = 1_000_000_000;
const RESULT_KEYS: ReadonlySet<string> = new Set(["id", "content", "isError", "reviewPending"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const posInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= TOKEN_CAP;
const snap = (v: unknown): unknown => (isRecord(v) ? Object.freeze({ ...v }) : null);
/** حالت‌های ساخته‌شده توسطِ همین ماژول؛ حالتِ جعلی/سریال‌شده/دست‌کاری‌شده پذیرفته نمی‌شود (حالت داخلِ فرایند و مات است). */
const ISSUED = new WeakSet<object>();
const mint = (s: ToolLoopState): ToolLoopState => {
  const frozen = Object.freeze(s);
  ISSUED.add(frozen);
  return frozen;
};
const isIssued = (s: unknown): s is ToolLoopState => typeof s === "object" && s !== null && ISSUED.has(s);
const freezeAll = <T>(xs: readonly T[]): readonly T[] => Object.freeze([...xs]);

function jsonLength(v: unknown): number {
  try {
    return JSON.stringify(v).length;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function outcomeOf(state: ToolLoopState, kind: { status: "answered"; text: string } | { status: "stopped"; reason: StopReason; errorCode?: string | null }): LoopOutcome {
  const base = { steps: state.steps, toolCalls: state.toolCalls, spend: sumStepSpend(state.entries), reviewPending: state.reviewPending };
  if (kind.status === "answered") return Object.freeze({ ...base, status: "answered" as const, text: kind.text });
  return Object.freeze({ ...base, status: "stopped" as const, reason: kind.reason, errorCode: kind.errorCode ?? null });
}

function finish(state: ToolLoopState, kind: Parameters<typeof outcomeOf>[1]): LoopResult<LoopTransition> {
  const done: ToolLoopState = mint({ ...state, phase: "done" as const, pending: null });
  return { ok: true, value: Object.freeze({ state: done, action: Object.freeze({ kind: "done" as const, outcome: outcomeOf(done, kind) }) }) };
}

/** سقفِ گام و هزینه پیش از «گامِ بعد»؛ `null` = مجاز. */
function nextStepBlocked(cfg: ToolLoopConfig, state: ToolLoopState): StopReason | null {
  if (state.steps >= cfg.maxSteps) return "MAX_STEPS";
  return budgetVerdict(cfg.budget, state.entries, { step: state.steps + 1, maxOutputTokens: state.maxOutputTokens, continuationChars: jsonLength(state.continuation) });
}

function callModel(state: ToolLoopState): LoopResult<LoopTransition> {
  const next: ToolLoopState = mint({ ...state, phase: "awaiting-step" as const, pending: null });
  return { ok: true, value: Object.freeze({ state: next, action: Object.freeze({ kind: "call-model" as const, step: state.steps + 1, continuation: state.continuation, maxOutputTokens: state.maxOutputTokens }) }) };
}

type StepRead =
  | Readonly<{ ok: true; text: string; finish: string; calls: readonly ToolCall[]; assistantMessage: WireMessage; usage: unknown; cost: unknown }>
  | Readonly<{ ok: false; failed: Readonly<{ code: string; truncated: boolean; usage: unknown; cost: unknown }> }>
  | Readonly<{ ok: "invalid"; issues: readonly string[] }>;

/** خواندنِ دفاعیِ نتیجهٔ گام (getterِ پرتابگر یا شکلِ خراب ⇒ نامعتبر؛ هرگز پرتاب). */
function readStep(result: unknown): StepRead {
  const bad = (m: string): StepRead => ({ ok: "invalid", issues: [m] });
  try {
    if (!isRecord(result)) return bad("نتیجه باید شیء باشد.");
    if (result["ok"] === false) {
      const e = result["error"];
      if (!isRecord(e)) return bad("error باید شیء باشد.");
      const issues = e["issues"];
      const code = typeof e["code"] === "string" && ERROR_CODE_RE.test(e["code"]) ? e["code"] : "UNKNOWN";
      const truncated = code === "PROVIDER_BAD_RESPONSE" && Array.isArray(issues) && issues[0] === TRUNCATED_TOOL_CALL_ISSUE;
      return { ok: false, failed: { code, truncated, usage: snap(e["usage"]), cost: snap(e["cost"]) } };
    }
    if (result["ok"] !== true) return bad("ok باید بولی باشد.");
    const v = result["value"];
    if (!isRecord(v)) return bad("value باید شیء باشد.");
    const text = v["text"];
    const fin = v["finish"];
    const rawCalls = v["toolCalls"];
    const am = v["assistantMessage"];
    if (typeof text !== "string") return bad("text باید رشته باشد.");
    if (typeof fin !== "string" || !FINISHES.has(fin)) return bad("finish ناشناخته است.");
    if (!Array.isArray(rawCalls)) return bad("toolCalls باید آرایه باشد.");
    const calls: ToolCall[] = [];
    for (const c of rawCalls as readonly unknown[]) {
      if (!isRecord(c) || typeof c["id"] !== "string" || typeof c["name"] !== "string" || typeof c["argumentsJson"] !== "string") return bad("toolCalls: هر عضو باید {id,name,argumentsJson} رشته‌ای باشد.");
      calls.push(Object.freeze({ id: c["id"], name: c["name"], argumentsJson: c["argumentsJson"] }));
    }
    if ((fin === "tool_calls") !== (calls.length > 0)) return bad("finish و toolCalls ناسازگارند.");
    if (!isRecord(am)) return bad("assistantMessage باید شیء باشد.");
    return { ok: true, text, finish: fin, calls, assistantMessage: am, usage: snap(v["usage"]), cost: snap(v["cost"]) };
  } catch {
    return bad("نتیجه قابل‌خواندن نیست.");
  }
}

/** افزودنِ شمارشِ فراخوانی‌ها؛ `repeated` اگر کلیدی از سقف گذشت. */
function countCalls(prev: ToolLoopState["callCounts"], calls: readonly ToolCall[], max: number): Readonly<{ counts: ToolLoopState["callCounts"]; repeated: boolean }> {
  const map = new Map<string, number>(prev);
  let repeated = false;
  for (const c of calls) {
    const key = canonicalCallKey(c.name, c.argumentsJson);
    const n = (map.get(key) ?? 0) + 1;
    map.set(key, n);
    if (n > max) repeated = true;
  }
  return { counts: Object.freeze([...map.entries()].map(([k, n]) => Object.freeze([k, n] as const))), repeated };
}

export function createToolLoop(rawConfig: unknown): LoopResult<ToolLoop> {
  const resolved = resolveToolLoopConfig(rawConfig);
  if (!resolved.ok) return resolved;
  const cfg = resolved.value;

  function start(input: unknown): LoopResult<LoopTransition> {
    try {
      if (!isRecord(input)) return fail("INVALID_INPUT", ["ورودی باید شیء باشد."]);
      const issues: string[] = [];
      for (const k of Object.keys(input)) if (k !== "format" && k !== "maxOutputTokens" && k !== "modelMaxOutputTokens") issues.push(`کلید ناشناخته (${k.slice(0, 40)}).`);
      const format = input["format"];
      const base = input["maxOutputTokens"];
      const cap = input["modelMaxOutputTokens"];
      if (typeof format !== "string" || !FORMATS.has(format)) issues.push("format ناشناخته است.");
      if (!posInt(base)) issues.push("maxOutputTokens باید صحیحِ مثبت باشد.");
      if (!posInt(cap)) issues.push("modelMaxOutputTokens باید صحیحِ مثبت باشد.");
      if (posInt(base) && posInt(cap) && base > cap) issues.push("maxOutputTokens نباید از modelMaxOutputTokens بیشتر باشد.");
      if (issues.length > 0) return fail("INVALID_INPUT", issues);
      const state: ToolLoopState = mint({
        phase: "awaiting-step" as const,
        format: format as ToolWireFormat,
        baseMaxOutputTokens: base as number,
        modelMaxOutputTokens: cap as number,
        maxOutputTokens: base as number,
        steps: 0,
        toolCalls: 0,
        truncationRetriesUsed: 0,
        continuation: Object.freeze([]) as readonly WireMessage[],
        entries: Object.freeze([]),
        callCounts: Object.freeze([]),
        seenCallIds: Object.freeze([]) as readonly string[],
        pending: null,
        reviewPending: false,
      });
      const blocked = nextStepBlocked(cfg, state);
      return blocked === null ? callModel(state) : finish(state, { status: "stopped", reason: blocked });
    } catch {
      return fail("INVALID_INPUT", ["ورودی قابل‌خواندن نیست."]);
    }
  }

  function onStep(state: ToolLoopState, result: unknown): LoopResult<LoopTransition> {
    try {
      if (!isIssued(state) || state.phase !== "awaiting-step") return fail("INVALID_STATE", ["این رویداد فقط در مرحلهٔ انتظارِ گام مجاز است."]);
      const read = readStep(result);
      if (read.ok === "invalid") return fail("INVALID_EVENT", read.issues);

      // گامی که به ارائه‌دهنده رسید (موفق یا ناموفق) هزینه دارد؛ حتی اگر ایست شود ثبت می‌شود.
      const usage = read.ok ? read.usage : read.failed.usage;
      const cost = read.ok ? read.cost : read.failed.cost;
      const counted: ToolLoopState = mint({ ...state, steps: state.steps + 1, entries: freezeAll([...state.entries, Object.freeze({ usage, cost })]) });

      if (!read.ok) return onFailedStep(counted, read.failed);
      if (read.calls.length === 0) return onPlainReply(counted, read);
      return onToolCalls(counted, read);
    } catch {
      return fail("INVALID_EVENT", ["نتیجه قابل‌خواندن نیست."]);
    }
  }

  function onFailedStep(state: ToolLoopState, failed: Readonly<{ code: string; truncated: boolean }>): LoopResult<LoopTransition> {
    if (!failed.truncated) return finish(state, { status: "stopped", reason: "STEP_FAILED", errorCode: failed.code });
    // فراخوانیِ بریده: پاسخ به مدل برنمی‌گردد (ناقص است)؛ تلاشِ دوباره با همان continuation و سقفِ خروجیِ بزرگ‌تر.
    const grown = Math.min(state.maxOutputTokens * 2, state.modelMaxOutputTokens);
    if (state.truncationRetriesUsed >= cfg.truncationRetries || grown <= state.maxOutputTokens) return finish(state, { status: "stopped", reason: "TRUNCATED_TOOL_CALL" });
    const retry: ToolLoopState = mint({ ...state, maxOutputTokens: grown, truncationRetriesUsed: state.truncationRetriesUsed + 1 });
    const blocked = nextStepBlocked(cfg, retry);
    return blocked === null ? callModel(retry) : finish(retry, { status: "stopped", reason: blocked });
  }

  function onPlainReply(state: ToolLoopState, read: Extract<StepRead, { ok: true }>): LoopResult<LoopTransition> {
    switch (read.finish) {
      case "stop":
        return read.text.trim() === "" ? finish(state, { status: "stopped", reason: "EMPTY_ANSWER" }) : finish(state, { status: "answered", text: read.text });
      case "length":
        return finish(state, { status: "stopped", reason: "OUTPUT_TRUNCATED" });
      case "content_filter":
        return finish(state, { status: "stopped", reason: "MODEL_FILTERED" });
      default:
        return finish(state, { status: "stopped", reason: "UNEXPECTED_FINISH" });
    }
  }

  function onToolCalls(state: ToolLoopState, read: Extract<StepRead, { ok: true }>): LoopResult<LoopTransition> {
    const ids = new Set(state.seenCallIds);
    for (const c of read.calls) {
      if (ids.has(c.id)) return finish(state, { status: "stopped", reason: "DUPLICATE_CALL_ID" });
      ids.add(c.id);
    }
    if (state.toolCalls + read.calls.length > cfg.maxToolCalls) return finish(state, { status: "stopped", reason: "MAX_TOOL_CALLS" });
    const counted = countCalls(state.callCounts, read.calls, cfg.maxIdenticalCalls);
    if (counted.repeated) return finish(state, { status: "stopped", reason: "REPEATED_CALL" });

    // پیش از اجرای ابزارها: اگر گامِ بعد ممکن نیست، اجرایشان بی‌معنا و هدر است (و به مجری سپرده نمی‌شوند).
    const blocked = nextStepBlocked(cfg, state);
    if (blocked !== null) return finish(state, { status: "stopped", reason: blocked });
    const accepted: ToolLoopState = mint({ ...state, toolCalls: state.toolCalls + read.calls.length, callCounts: counted.counts, seenCallIds: freezeAll([...ids]) });
    const waiting: ToolLoopState = mint({ ...accepted, phase: "awaiting-tools" as const, pending: Object.freeze({ calls: freezeAll(read.calls), assistantMessage: read.assistantMessage }) });
    return { ok: true, value: Object.freeze({ state: waiting, action: Object.freeze({ kind: "run-tools" as const, calls: waiting.pending!.calls }) }) };
  }

  function onToolResults(state: ToolLoopState, results: unknown): LoopResult<LoopTransition> {
    try {
      if (!isIssued(state) || state.phase !== "awaiting-tools" || state.pending === null) return fail("INVALID_STATE", ["این رویداد فقط در مرحلهٔ انتظارِ نتیجهٔ ابزارها مجاز است."]);
      if (!Array.isArray(results)) return fail("INVALID_RESULTS", ["results باید آرایه باشد."]);
      const issues: string[] = [];
      const wire: { id: string; content: string; isError: boolean }[] = [];
      let pendingReview = false;
      (results as readonly unknown[]).forEach((r, i) => {
        if (!isRecord(r)) return void issues.push(`نتیجه ${i}: باید شیء باشد.`);
        for (const k of Object.keys(r)) if (!RESULT_KEYS.has(k)) issues.push(`نتیجه ${i}: کلید ناشناخته (${k.slice(0, 40)}).`);
        const isError = r["isError"];
        const review = r["reviewPending"];
        if (isError !== undefined && typeof isError !== "boolean") issues.push(`نتیجه ${i}: isError باید بولی باشد.`);
        if (review !== undefined && typeof review !== "boolean") issues.push(`نتیجه ${i}: reviewPending باید بولی باشد.`);
        // نتیجهٔ موفق باید صریحاً بگوید تأییدشده است یا نه؛ نگفتن «تأییدشده» حساب نمی‌شود.
        if (isError !== true && typeof review !== "boolean") issues.push(`نتیجه ${i}: reviewPending برای نتیجهٔ موفق الزامی است.`);
        if (isError !== true && review === true) pendingReview = true;
        if (typeof r["id"] === "string" && typeof r["content"] === "string") wire.push({ id: r["id"], content: r["content"], isError: isError === true });
        else issues.push(`نتیجه ${i}: id و content باید رشته باشند.`);
      });
      if (issues.length > 0) return fail("INVALID_RESULTS", issues);

      const enc = encodeToolResults(state.format, state.pending.calls, wire);
      if (!enc.ok) return fail("INVALID_RESULTS", enc.error.issues);

      const continuation = freezeAll<WireMessage>([...state.continuation, state.pending.assistantMessage, ...enc.value]);
      const next: ToolLoopState = mint({ ...state, continuation, pending: null, reviewPending: state.reviewPending || pendingReview });
      if (continuation.length > TOOL_STEP_LIMITS.maxContinuationMessages || jsonLength(continuation) > TOOL_STEP_LIMITS.maxContinuationChars) {
        return finish(next, { status: "stopped", reason: "CONTINUATION_LIMIT" });
      }
      const blocked = nextStepBlocked(cfg, next);
      return blocked === null ? callModel(next) : finish(next, { status: "stopped", reason: blocked });
    } catch {
      return fail("INVALID_RESULTS", ["نتیجه‌ها قابل‌خواندن نیستند."]);
    }
  }

  function cancel(state: ToolLoopState): LoopResult<LoopTransition> {
    try {
      if (!isIssued(state) || state.phase === "done") return fail("INVALID_STATE", ["حلقه پیش‌تر بسته شده یا حالت نامعتبر است."]);
      return finish(state, { status: "stopped", reason: "CANCELLED" });
    } catch {
      return fail("INVALID_STATE", ["حالت قابل‌خواندن نیست."]);
    }
  }

  return { ok: true, value: Object.freeze({ start, onStep, onToolResults, cancel }) };
}
