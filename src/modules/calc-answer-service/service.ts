/** سازندهٔ سرویسِ پاسخِ محاسبه (ADR-0061). همهٔ آستانه‌ها الزامی و بی‌پیش‌فرض‌اند؛ پیکربندیِ نامعتبر همان‌جا رد می‌شود، نه در نخستین پرسش. */
import { createCardCollector } from "@/modules/calc-answer-cards";
import { createCalcToolExecutor } from "@/modules/calc-tool-executor";
import { createToolRunner } from "@/modules/tool-runner";
import { OPTIONS_MESSAGE } from "./messages";
import { defaultCollector, isRecord, runAnswer, type RunContext } from "./run";
import type { CalcAnswerService, CalcAnswerServiceResult } from "./types";

const KEYS = new Set(["gateway", "loop", "model", "maxOutputTokens", "maxCards", "totalTimeoutMs", "toolTimeoutMs", "maxResultChars", "deps", "timers"]);
const GATEWAY_FNS = ["completeStep", "toolFormat", "limits"] as const;
const LOOP_FNS = ["start", "onStep", "onToolResults", "cancel"] as const;
/** سقفِ فنیِ طولِ نامِ مدل. */
export const MODEL_NAME_MAX = 200;

const invalid = (issues: readonly string[]): CalcAnswerServiceResult => ({
  ok: false,
  error: Object.freeze({ code: "INVALID_OPTIONS", message: OPTIONS_MESSAGE, issues: Object.freeze(issues.slice(0, 10)) }),
});
const keyName = (k: string): string => (k.length > 40 ? `${k.slice(0, 40)}…` : k);
const hasFns = (v: unknown, names: readonly string[]): boolean => isRecord(v) && names.every((n) => typeof v[n] === "function");

export function createCalcAnswerService(options: unknown): CalcAnswerServiceResult {
  const issues: string[] = [];
  let o: Record<string, unknown>;
  try {
    if (!isRecord(options)) return invalid(["options: باید شیء باشد"]);
    o = {};
    for (const k of Object.keys(options)) {
      if (!KEYS.has(k)) issues.push(`${keyName(k)}: کلید ناشناخته`);
      else o[k] = options[k];
    }
  } catch {
    return invalid(["options: خوانده نشد"]);
  }

  if (!hasFns(o["gateway"], GATEWAY_FNS)) issues.push("gateway: دروازهٔ ابزار الزامی است");
  if (!hasFns(o["loop"], LOOP_FNS)) issues.push("loop: کنترل‌گرِ حلقه الزامی است");
  const model = o["model"];
  if (typeof model !== "string" || model.trim().length === 0 || model.length > MODEL_NAME_MAX) issues.push(`model: رشتهٔ ناتهی تا ${MODEL_NAME_MAX} نویسه الزامی است`);
  const maxOutputTokens = o["maxOutputTokens"];
  if (typeof maxOutputTokens !== "number" || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) issues.push("maxOutputTokens: عددِ صحیحِ مثبت الزامی است");
  if (o["timers"] !== undefined && !(isRecord(o["timers"]) && typeof o["timers"]["setTimeout"] === "function" && typeof o["timers"]["clearTimeout"] === "function")) issues.push("timers: باید setTimeout و clearTimeout داشته باشد");
  if (issues.length > 0) return invalid(issues);

  // اعتبارسنجیِ بقیه (maxCards، مهلت‌ها، سقفِ نتیجه، deps) را همان سازنده‌های واقعی می‌کنند؛ نتیجهٔ آن‌ها فقط نامِ کلید است.
  const probeCards = createCardCollector({ maxCards: o["maxCards"] as number });
  if (!probeCards.ok) issues.push(...probeCards.error.issues.map((i) => `calc-answer-cards: ${i}`));
  const probeExec = createCalcToolExecutor({ ...(o["deps"] !== undefined ? { deps: o["deps"] as never } : {}), onResult: () => undefined });
  if (!probeExec.ok) issues.push(...probeExec.error.issues.map((i) => `calc-tool-executor: ${i}`));
  else {
    const probeRunner = createToolRunner({
      gateway: o["gateway"] as never,
      loop: o["loop"] as never,
      executeTool: probeExec.value,
      totalTimeoutMs: o["totalTimeoutMs"] as number,
      toolTimeoutMs: o["toolTimeoutMs"] as number,
      maxResultChars: o["maxResultChars"] as number,
      ...(o["timers"] !== undefined ? { timers: o["timers"] as never } : {}),
    });
    if (!probeRunner.ok) issues.push(...probeRunner.error.issues.map((i) => `tool-runner: ${i}`));
  }
  // سازگاریِ مدل با دروازه همان‌جا سنجیده می‌شود تا خطای پیکربندی به‌نامِ «ورودیِ کاربر» گزارش نشود.
  try {
    const gwv = o["gateway"] as RunContext["gateway"];
    if (gwv.toolFormat(model as string) === null) issues.push("model: مدل در دروازه ابزار را پشتیبانی نمی‌کند");
    const lim = gwv.limits(model as string);
    if (lim === null) issues.push("model: مدل در دروازه نیست");
    else if ((maxOutputTokens as number) > lim.maxOutputTokens) issues.push("maxOutputTokens: از سقفِ مدل در دروازه بیشتر است");
  } catch {
    issues.push("gateway: بررسیِ مدل ناموفق بود");
  }
  if (issues.length > 0) return invalid(issues);

  const ctx: RunContext = Object.freeze({
    gateway: o["gateway"] as RunContext["gateway"],
    loop: o["loop"] as RunContext["loop"],
    model: model as string,
    maxOutputTokens: maxOutputTokens as number,
    maxCards: o["maxCards"] as number,
    totalTimeoutMs: o["totalTimeoutMs"] as number,
    toolTimeoutMs: o["toolTimeoutMs"] as number,
    maxResultChars: o["maxResultChars"] as number,
    deps: o["deps"] as RunContext["deps"],
    timers: o["timers"] as RunContext["timers"],
  });
  const service: CalcAnswerService = Object.freeze({ answer: (input, opts) => runAnswer(ctx, input, opts, defaultCollector) });
  return { ok: true, value: service };
}
