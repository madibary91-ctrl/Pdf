/**
 * مجریِ حلقهٔ ابزار (ADR-0058، CT‑4b): `tool-loop` تصمیم می‌گیرد، دروازه مدل را صدا می‌زند، پورتِ `executeTool` ابزار را اجرا می‌کند؛
 * این فایل فقط کنش‌ها را به ترتیب اجرا می‌کند و سه تضمین می‌دهد: (۱) هرگز پرتاب نمی‌کند، (۲) هرگز از `totalTimeoutMs` نمی‌ماند،
 * (۳) هزینهٔ خرج‌شده در هیچ مسیری گم نمی‌شود (حتی لغو/خطای قرارداد).
 */
import type { ToolSpec } from "@/modules/ai-gateway";
import type { LoopOutcome, LoopTransition, ToolLoopState } from "@/modules/tool-loop";
import { resolveRunnerOptions, type ResolvedRunner } from "./config";
import { fail } from "./errors";
import { race } from "./race";
import { runToolCalls } from "./tools";
import type { RunnerResult, RunReport, ToolRunInput, ToolRunOptions, ToolRunner, ToolRunnerOptions, ToolRunRecord } from "./types";

/** مهلتِ مجاز به دروازه برای برگرداندنِ نتیجهٔ گامِ در-پروازِ لغوشده (که شاید مصرف دارد) پیش از رهاکردنش. */
export const ABORT_GRACE_MS = 2_000;
/** سقفِ نگهبانِ تعداد کنش‌ها (کنترل‌گر خودش ≤ ۱۶ گام و ۶۴ فراخوانی را تضمین می‌کند). */
const MAX_ACTIONS = 200;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

type ParsedInput = Readonly<{ base: Record<string, unknown>; model: string; maxOutputTokens: number; allowed: ReadonlySet<string> }>;

function parseInput(input: unknown): RunnerResult<ParsedInput> {
  if (!isRecord(input)) return fail("INVALID_INPUT", ["input باید شیء باشد."]);
  const issues: string[] = [];
  if ("continuation" in input) issues.push("continuation را حلقه می‌سازد؛ در ورودی مجاز نیست.");
  const model = input["model"];
  if (typeof model !== "string" || model === "") issues.push("model باید رشتهٔ ناتهی باشد.");
  const max = input["maxOutputTokens"];
  if (typeof max !== "number" || !Number.isInteger(max) || max < 1) issues.push("maxOutputTokens باید عددِ صحیحِ مثبت باشد.");
  const names = new Set<string>();
  const tools = input["tools"];
  if (!Array.isArray(tools) || tools.length === 0) issues.push("tools باید آرایهٔ ناتهی باشد.");
  else (tools as readonly unknown[]).forEach((t, i) => (isRecord(t) && typeof (t as Partial<ToolSpec>).name === "string" ? names.add((t as ToolSpec).name) : issues.push(`tools[${i}].name باید رشته باشد.`)));
  if (issues.length > 0) return fail("INVALID_INPUT", issues);
  return { ok: true, value: { base: input, model: model as string, maxOutputTokens: max as number, allowed: names } };
}

/** شکستِ مصنوعیِ گام؛ `usage/cost` نامعلوم (`null`) ⇒ کنترل‌گر آن را «هزینهٔ نامعلوم» می‌شمارد، نه صفر. */
const syntheticStepFailure = (code: "INTERNAL_ERROR" | "ABORTED"): unknown => ({
  ok: false,
  error: { code, message: code, retryable: false, warnings: [], usage: null, cost: null },
});

export function createToolRunner(options: ToolRunnerOptions): RunnerResult<ToolRunner> {
  const resolved = resolveRunnerOptions(options);
  if (!resolved.ok) return resolved;
  const cfg: ResolvedRunner = resolved.value;

  async function run(input: unknown, runOptions?: ToolRunOptions): Promise<RunnerResult<RunReport>> {
    try {
      return await execute(input, runOptions);
    } catch {
      return fail("INTERNAL_ERROR", ["استثنای پیش‌بینی‌نشده."]);
    }
  }

  async function execute(input: unknown, runOptions: ToolRunOptions | undefined): Promise<RunnerResult<RunReport>> {
    const parsed = parseInput(input);
    if (!parsed.ok) return parsed;
    const { base, model, maxOutputTokens, allowed } = parsed.value;
    let callerSignal: AbortSignal | undefined;
    if (runOptions !== undefined) {
      if (!isRecord(runOptions)) return fail("INVALID_INPUT", ["options باید شیء باشد."]);
      const s = runOptions["signal"];
      if (s !== undefined && !(s instanceof AbortSignal)) return fail("INVALID_INPUT", ["options.signal باید AbortSignal باشد."]);
      callerSignal = s as AbortSignal | undefined;
    }

    const format = cfg.gateway.toolFormat(model);
    const limits = cfg.gateway.limits(model);
    if (format === null || limits === null || !Number.isInteger(limits.maxOutputTokens)) return fail("MODEL_UNSUPPORTED");

    const started = cfg.loop.start({ format, maxOutputTokens, modelMaxOutputTokens: limits.maxOutputTokens });
    if (!started.ok) return fail(started.error.code === "INVALID_INPUT" ? "INVALID_INPUT" : "CONTRACT_VIOLATION", started.error.issues);

    const ac = new AbortController();
    let abortedBy: "caller" | "deadline" | null = null;
    const abort = (by: "caller" | "deadline"): void => {
      if (abortedBy !== null) return;
      abortedBy = by;
      ac.abort();
    };
    const onCaller = (): void => abort("caller");
    if (callerSignal !== undefined) {
      if (callerSignal.aborted) abort("caller");
      else callerSignal.addEventListener("abort", onCaller, { once: true });
    }
    const deadline = cfg.timers.setTimeout(() => abort("deadline"), cfg.totalTimeoutMs);
    const records: ToolRunRecord[] = [];

    /** خطای قرارداد میانِ اجرا: حلقه را می‌بندد تا هزینهٔ تاکنون در `partial` بماند. */
    const bail = (state: ToolLoopState, code: "CONTRACT_VIOLATION" | "INTERNAL_ERROR", issues: readonly string[]): RunnerResult<never> => {
      const c = cfg.loop.cancel(state);
      const partial: LoopOutcome | null = c.ok && c.value.action.kind === "done" ? c.value.action.outcome : null;
      return fail(code, issues, partial);
    };

    try {
      let t: LoopTransition = started.value;
      for (let guard = 0; guard < MAX_ACTIONS; guard++) {
        const a = t.action;
        if (a.kind === "done") return { ok: true, value: Object.freeze({ outcome: a.outcome, abortedBy, toolRuns: Object.freeze([...records]) }) };

        // لغو: پیش از هر کارِ تازه. (هیچ await میانِ این بررسی و آغازِ کار نیست، پس گامی که به ارائه‌دهنده نرسیده شمرده نمی‌شود.)
        if (abortedBy !== null) {
          const c = cfg.loop.cancel(t.state);
          if (!c.ok) return fail("CONTRACT_VIOLATION", c.error.issues);
          t = c.value;
          continue;
        }

        if (a.kind === "call-model") {
          const work = (async (): Promise<unknown> => {
            try {
              return await cfg.gateway.completeStep({ ...base, maxOutputTokens: a.maxOutputTokens, continuation: a.continuation }, { signal: ac.signal });
            } catch {
              return syntheticStepFailure("INTERNAL_ERROR");
            }
          })();
          let step: unknown;
          const first = await race(() => work, Infinity, cfg.timers, ac.signal);
          if (first.kind === "value") step = first.value;
          else {
            // لغو: به دروازه فرصتِ کوتاهی می‌دهیم نتیجه (و مصرفِ احتمالی) را برگرداند؛ وگرنه شکستِ نامعلومِ مصنوعی (هزینه صفر حساب نمی‌شود).
            const grace = await race(() => work, ABORT_GRACE_MS, cfg.timers);
            step = grace.kind === "value" ? grace.value : syntheticStepFailure("ABORTED");
          }
          const n = cfg.loop.onStep(t.state, step);
          if (!n.ok) return bail(t.state, "CONTRACT_VIOLATION", n.error.issues);
          t = n.value;
          continue;
        }

        const r = await runToolCalls(a.calls, { allowed, executeTool: cfg.executeTool, toolTimeoutMs: cfg.toolTimeoutMs, maxResultChars: cfg.maxResultChars, timers: cfg.timers, signal: ac.signal }, records);
        if (r.kind === "aborted") continue; // بالای حلقه با `cancel` بسته می‌شود
        const n = cfg.loop.onToolResults(t.state, r.results);
        if (!n.ok) return bail(t.state, "CONTRACT_VIOLATION", n.error.issues);
        t = n.value;
      }
      return bail(t.state, "INTERNAL_ERROR", ["حلقه از سقفِ نگهبانِ کنش‌ها گذشت."]);
    } finally {
      cfg.timers.clearTimeout(deadline);
      callerSignal?.removeEventListener("abort", onCaller);
    }
  }

  return { ok: true, value: Object.freeze({ run }) };
}
