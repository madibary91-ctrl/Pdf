/**
 * یک اجرای کاملِ «پرسش ← مدل/ابزار ← کارت ← پاسخِ قابل‌نمایش» (ADR-0061). هر اجرا جمع‌آورنده، مجری و اجراگرِ تازهٔ خودش را می‌سازد،
 * پس هیچ حالتی میانِ اجراهای هم‌زمان یا پی‌درپی مشترک نیست. هرگز پرتاب نمی‌کند و هیچ متنِ مدل/ابزار/استثنا را بازتاب نمی‌دهد.
 */
import type { Timers, ToolGateway } from "@/modules/ai-gateway";
import { createCardCollector, type CardCollectorResult } from "@/modules/calc-answer-cards";
import { createCalcToolExecutor } from "@/modules/calc-tool-executor";
import { CALC_TOOLS, type CalcToolDeps } from "@/modules/calc-tools";
import type { ToolLoop } from "@/modules/tool-loop";
import { createToolRunner, type RunReport } from "@/modules/tool-runner";
import { ANSWER_MESSAGES } from "./messages";
import type { AnswerErrorCode, AnswerResult, RunSpend } from "./types";

export type RunContext = Readonly<{
  gateway: ToolGateway;
  loop: ToolLoop;
  model: string;
  maxOutputTokens: number;
  maxCards: number;
  totalTimeoutMs: number;
  toolTimeoutMs: number;
  maxResultChars: number;
  deps: CalcToolDeps | undefined;
  timers: Timers | undefined;
}>;

/** سازندهٔ جمع‌آورنده؛ فقط آزمون آن را عوض می‌کند (برای اثباتِ مسیرِ دفاعیِ `NOT_DISPLAYABLE`). */
export type CollectorFactory = (maxCards: number) => CardCollectorResult;

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keyName = (k: string): string => (k.length > 40 ? `${k.slice(0, 40)}…` : k);

const fail = (code: AnswerErrorCode, issues: readonly string[], cause: string | null, spend: RunSpend | null): AnswerResult => ({
  ok: false,
  error: Object.freeze({ code, message: ANSWER_MESSAGES[code], issues: Object.freeze(issues.slice(0, 10)), cause, spend }),
});

function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

/** کپیِ JSONِ ژرف‌یخ‌زده: هزینه از گزارشِ اجرا جدا و تغییرناپذیر می‌شود؛ ناموفق ⇒ `null`. */
function cloneSpend(spend: unknown): RunSpend | null {
  try {
    if (!isRecord(spend)) return null;
    return deepFreeze(JSON.parse(JSON.stringify(spend)) as RunSpend);
  } catch {
    return null;
  }
}

/** فقط «شکلِ» پیام‌ها (تا تماسِ هدر نرود)؛ سقفِ طول/تعداد و سایرِ قاعده‌ها را دروازه می‌سنجد. محتوای پیام هرگز بازتاب نمی‌شود. */
function messageIssues(msgs: readonly unknown[]): string[] {
  if (msgs.length === 0) return ["messages: دست‌کم یک پیام لازم است"];
  const out: string[] = [];
  for (let i = 0; i < msgs.length && out.length < 10; i++) {
    const m: unknown = msgs[i];
    if (!isRecord(m)) {
      out.push(`messages[${i}]: باید شیء باشد`);
      continue;
    }
    if (m["role"] !== "system" && m["role"] !== "user" && m["role"] !== "assistant") out.push(`messages[${i}].role: باید system، user یا assistant باشد`);
    if (typeof m["content"] !== "string" || m["content"].length === 0) out.push(`messages[${i}].content: باید رشتهٔ ناتهی باشد`);
  }
  const last: unknown = msgs[msgs.length - 1];
  if (out.length === 0 && isRecord(last) && last["role"] !== "user") out.push("messages: آخرین پیام باید user باشد");
  return out;
}

type ParsedInput = Readonly<{ messages: unknown; requestId: string | undefined }>;

function parseInput(input: unknown): ParsedInput | readonly string[] {
  try {
    if (!isRecord(input)) return ["input: باید شیء باشد"];
    const issues: string[] = [];
    for (const k of Object.keys(input)) if (k !== "messages" && k !== "requestId") issues.push(`${keyName(k)}: کلید ناشناخته (فقط messages و requestId)`);
    const requestId = input["requestId"];
    if (requestId !== undefined && typeof requestId !== "string") issues.push("requestId: باید رشته باشد");
    const msgs = input["messages"];
    if (!Array.isArray(msgs)) issues.push("messages: باید فهرست باشد");
    else issues.push(...messageIssues(msgs));
    if (issues.length > 0) return issues;
    return { messages: input["messages"], requestId: typeof requestId === "string" ? requestId : undefined };
  } catch {
    return ["input: خوانده نشد"];
  }
}

function parseOptions(options: unknown): Readonly<{ signal: AbortSignal | undefined }> | readonly string[] {
  try {
    if (options === undefined) return { signal: undefined };
    if (!isRecord(options)) return ["options: باید شیء باشد"];
    const issues: string[] = [];
    for (const k of Object.keys(options)) if (k !== "signal") issues.push(`${keyName(k)}: کلید ناشناخته`);
    const signal = options["signal"];
    if (signal !== undefined && !(signal instanceof AbortSignal)) issues.push("signal: باید AbortSignal باشد");
    if (issues.length > 0) return issues;
    return { signal: signal instanceof AbortSignal ? signal : undefined };
  } catch {
    return ["options: خوانده نشد"];
  }
}

export async function runAnswer(ctx: RunContext, input: unknown, options: unknown, makeCollector: CollectorFactory): Promise<AnswerResult> {
  const pi = parseInput(input);
  if (Array.isArray(pi)) return fail("INVALID_INPUT", pi as readonly string[], null, null);
  const po = parseOptions(options);
  if (Array.isArray(po)) return fail("INVALID_INPUT", po as readonly string[], null, null);
  const parsed = pi as ParsedInput;
  const { signal } = po as Readonly<{ signal: AbortSignal | undefined }>;

  let report: RunReport;
  let cards: ReturnType<CollectorFactory>;
  try {
    cards = makeCollector(ctx.maxCards);
    if (!cards.ok) return fail("RUN_FAILED", [], "SETUP", null);
    const executor = createCalcToolExecutor({ ...(ctx.deps ? { deps: ctx.deps } : {}), onResult: cards.value.observe });
    if (!executor.ok) return fail("RUN_FAILED", [], "SETUP", null);
    const runner = createToolRunner({
      gateway: ctx.gateway,
      loop: ctx.loop,
      executeTool: executor.value,
      totalTimeoutMs: ctx.totalTimeoutMs,
      toolTimeoutMs: ctx.toolTimeoutMs,
      maxResultChars: ctx.maxResultChars,
      ...(ctx.timers ? { timers: ctx.timers } : {}),
    });
    if (!runner.ok) return fail("RUN_FAILED", [], "SETUP", null);
    // فهرستِ ابزار و مدل را فقط سرویس می‌گذارد: فراخواننده نمی‌تواند فهرستِ مجازِ نام را بازتر کند.
    const runInput = {
      model: ctx.model,
      messages: parsed.messages,
      maxOutputTokens: ctx.maxOutputTokens,
      tools: CALC_TOOLS,
      ...(parsed.requestId !== undefined ? { requestId: parsed.requestId } : {}),
    };
    const run = await runner.value.run(runInput, signal ? { signal } : undefined);
    if (!run.ok) {
      // ورودیِ فراخواننده پیش‌تر سنجیده شده و مدل/ابزار/سقف از پیکربندی است؛ پس INVALID_INPUT از اجراگر = خطای پیکربندی، نه تقصیرِ فراخواننده.
      return fail("RUN_FAILED", run.error.issues, run.error.code, cloneSpend(run.error.partial?.spend));
    }
    report = run.value;
  } catch {
    return fail("RUN_FAILED", [], "THREW", null);
  }

  const spend = cloneSpend(report.outcome.spend);
  const composed = cards.value.compose(report);
  // ناهمخوانیِ کارت و گزارش ⇒ پاسخِ مدل نمایش داده نمی‌شود، ولی هزینه حفظ می‌شود. شناسه‌های فراخوانی (ساختهٔ مدل) بازتاب نمی‌شوند.
  if (!composed.ok) return fail("NOT_DISPLAYABLE", [], composed.error.code, spend);
  if (spend === null) return fail("RUN_FAILED", [], "SPEND_INVALID", null);
  return { ok: true, value: Object.freeze({ answer: composed.value, spend, steps: report.outcome.steps, toolCalls: report.outcome.toolCalls }) };
}

export const defaultCollector: CollectorFactory = (maxCards) => createCardCollector({ maxCards });
