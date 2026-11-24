/**
 * اجرای فراخوانی‌های یک گام: ترتیبی (به ترتیبِ مدل؛ قطعی و ممیزی‌پذیر)، با فهرستِ مجازِ نام، مهلتِ هر ابزار،
 * سقفِ نتیجه و اعتبارسنجیِ شکلِ نتیجه. هر ناهنجاریِ ابزار ⇒ نتیجهٔ خطا با متنِ ثابت به مدل؛ حلقه نمی‌شکند.
 */
import type { Timers, ToolCall } from "@/modules/ai-gateway";
import type { LoopToolResult } from "@/modules/tool-loop";
import { FAILURE_CONTENT } from "./errors";
import { race } from "./race";
import type { ToolExecution, ToolExecutor, ToolFailureCode, ToolRunRecord } from "./types";

export type ToolRunContext = Readonly<{
  allowed: ReadonlySet<string>;
  executeTool: ToolExecutor;
  toolTimeoutMs: number;
  maxResultChars: number;
  timers: Timers;
  /** لغوِ کلِ اجرا. */
  signal: AbortSignal;
}>;

const FORBIDDEN = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const EXEC_KEYS: ReadonlySet<string> = new Set(["ok", "content", "reviewPending"]);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

type Verdict = Readonly<{ result: Omit<LoopToolResult, "id">; code: ToolFailureCode | null }>;

const failed = (code: Exclude<ToolFailureCode, "TOOL_REPORTED_ERROR" | "TOOL_ABORTED">): Verdict => ({ result: { content: FAILURE_CONTENT[code], isError: true }, code });

/** شکلِ نتیجهٔ ابزار را می‌سنجد؛ هیچ‌چیزِ نامعتبر یا بزرگ به مدل نمی‌رسد. */
export function judgeExecution(raw: unknown, maxChars: number): Verdict {
  try {
    if (!isRecord(raw)) return failed("TOOL_RESULT_INVALID");
    for (const k of Object.keys(raw)) if (!EXEC_KEYS.has(k)) return failed("TOOL_RESULT_INVALID");
    const ok = raw["ok"];
    const content = raw["content"];
    if (ok === false && "reviewPending" in raw) return failed("TOOL_RESULT_INVALID");
    if (typeof ok !== "boolean" || typeof content !== "string") return failed("TOOL_RESULT_INVALID");
    if (content.length > maxChars) return failed("TOOL_RESULT_TOO_LARGE");
    if (content === "" || FORBIDDEN.test(content)) return failed("TOOL_RESULT_INVALID");
    if (!ok) return { result: { content, isError: true }, code: "TOOL_REPORTED_ERROR" };
    const review = raw["reviewPending"];
    // نتیجهٔ موفق باید صریحاً بگوید تأییدشده است یا نه؛ نگفتن «تأییدشده» حساب نمی‌شود.
    if (typeof review !== "boolean") return failed("TOOL_RESULT_INVALID");
    return { result: { content, reviewPending: review }, code: null };
  } catch {
    return failed("TOOL_RESULT_INVALID");
  }
}

export type ToolsOutcome = Readonly<{ kind: "aborted" }> | Readonly<{ kind: "done"; results: readonly LoopToolResult[] }>;

/** `records` را در جا پر می‌کند تا حتی در لغو، آنچه واقعاً اجرا شد در ممیزی بماند. */
export async function runToolCalls(calls: readonly ToolCall[], ctx: ToolRunContext, records: ToolRunRecord[]): Promise<ToolsOutcome> {
  const results: LoopToolResult[] = [];
  for (const call of calls) {
    if (ctx.signal.aborted) return { kind: "aborted" };
    let verdict: Verdict;
    if (!ctx.allowed.has(call.name)) {
      verdict = failed("UNKNOWN_TOOL");
    } else {
      const own = new AbortController();
      const relay = (): void => own.abort();
      ctx.signal.addEventListener("abort", relay, { once: true });
      try {
        const r = await race(() => ctx.executeTool(call, { signal: own.signal, callId: call.id }), ctx.toolTimeoutMs, ctx.timers, ctx.signal);
        if (r.kind === "aborted") {
          own.abort();
          // ابزار شروع شده بود و ممکن است اثرِ جانبی کرده باشد (ابزارهای آینده)؛ در ممیزی می‌ماند، ولی نتیجه‌اش به مدل نمی‌رسد.
          records.push({ id: call.id, name: call.name, status: "error", code: "TOOL_ABORTED", reviewPending: false });
          return { kind: "aborted" };
        }
        if (r.kind === "timeout") {
          own.abort();
          verdict = failed("TOOL_TIMEOUT");
        } else if (r.kind === "threw") {
          verdict = failed("TOOL_FAILED");
        } else {
          verdict = judgeExecution(r.value as ToolExecution, ctx.maxResultChars);
        }
      } finally {
        ctx.signal.removeEventListener("abort", relay);
      }
    }
    results.push({ id: call.id, ...verdict.result });
    records.push({ id: call.id, name: call.name, status: verdict.code === null ? "ok" : "error", code: verdict.code, reviewPending: verdict.result.isError !== true && verdict.result.reviewPending === true });
  }
  return { kind: "done", results };
}
