/**
 * اعتبارسنجیِ درخواستِ گامِ ابزار روی مرز. بخشِ «پایه» را همان `parseRequest` می‌سنجد (بی‌هیچ سستی)؛ این‌جا فقط چهار کلیدِ ابزار
 * و `continuation` سنجیده می‌شود. مشکل‌ها فقط نامِ فیلد و محدودیت‌اند، هرگز محتوا.
 */
import { fail } from "./errors";
import { encodeTools } from "./tool-wire";
import { checkJson, freezeClone, isPlainRecord, report } from "./tool-wire-json";
import { parseRequest } from "./request";
import type { ResolvedToolModel } from "./tool-step-config";
import type { GatewayResult, ParsedRequest } from "./types";
import type { ToolWireFormat, WireMessage } from "./tool-wire-types";

export const TOOL_STEP_LIMITS = Object.freeze({
  maxContinuationMessages: 128,
  /** سقفِ اندازهٔ JSONِ `continuation` (نویسه). */
  maxContinuationChars: 400_000,
});

const STEP_KEYS: ReadonlySet<string> = new Set(["tools", "toolChoice", "allowParallel", "continuation"]);
const ROLES: Readonly<Record<ToolWireFormat, ReadonlySet<string>>> = {
  "openai-chat": new Set(["assistant", "tool", "user"]),
  "anthropic-messages": new Set(["assistant", "user"]),
};

export type ParsedToolStep = Readonly<{ base: ParsedRequest; format: ToolWireFormat; tools: WireMessage; continuation: readonly WireMessage[] }>;

/** `continuation`: فقط نقش‌های مجازِ قالب (هرگز `system`)، شروع با `assistant`، پایان نه با `assistant`، JSONِ بی‌ابهام و کران‌دار. */
function parseContinuation(raw: unknown, format: ToolWireFormat, issues: string[]): readonly WireMessage[] {
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw) || raw.length > TOOL_STEP_LIMITS.maxContinuationMessages) {
    report(issues, `continuation باید آرایه‌ای تا ${TOOL_STEP_LIMITS.maxContinuationMessages} عضو باشد.`);
    return [];
  }
  const before = issues.length;
  raw.forEach((m: unknown, i: number) => {
    if (!isPlainRecord(m)) return report(issues, `continuation[${i}]: باید شیء باشد.`);
    const role = m["role"];
    if (typeof role !== "string" || !ROLES[format].has(role)) report(issues, `continuation[${i}].role برای این قالب مجاز نیست.`);
    checkJson(m, `continuation[${i}]`, issues, false);
  });
  if (issues.length > before) return [];
  const roles = raw.map((m: Record<string, unknown>) => m["role"]);
  if (roles.length > 0 && roles[0] !== "assistant") report(issues, "continuation باید با پیامِ assistant شروع شود.");
  if (roles.length > 0 && roles[roles.length - 1] === "assistant") report(issues, "continuation نباید با پیامِ assistant تمام شود (نتیجهٔ ابزارها لازم است).");
  if (issues.length > before) return [];
  if (JSON.stringify(raw).length > TOOL_STEP_LIMITS.maxContinuationChars) {
    report(issues, `continuation بزرگ‌تر از ${TOOL_STEP_LIMITS.maxContinuationChars} نویسه است.`);
    return [];
  }
  return freezeClone(raw as readonly WireMessage[]);
}

export function parseToolStepRequest(
  input: unknown,
  getModel: Parameters<typeof parseRequest>[1],
  getTool: (logical: string) => ResolvedToolModel | undefined,
): GatewayResult<ParsedToolStep> {
  try {
    if (!isPlainRecord(input)) return fail("INVALID_REQUEST", { issues: ["درخواست باید شیء باشد."] });
    const base: Record<string, unknown> = {};
    for (const k of Object.keys(input)) if (!STEP_KEYS.has(k)) base[k] = input[k];
    const parsed = parseRequest(base, getModel);
    if (!parsed.ok) return parsed;
    const tool = getTool(parsed.value.model);
    if (tool === undefined) return fail("INVALID_REQUEST", { issues: ["model: این مدل برای ابزار تنظیم نشده است."] });

    const issues: string[] = [];
    const opts: Record<string, unknown> = {};
    if (input["toolChoice"] !== undefined) opts["choice"] = input["toolChoice"];
    if (input["allowParallel"] !== undefined) opts["allowParallel"] = input["allowParallel"];
    const enc = encodeTools(tool.format, input["tools"], opts);
    if (!enc.ok) for (const i of enc.error.issues) report(issues, `tools: ${i}`);
    const continuation = parseContinuation(input["continuation"], tool.format, issues);
    if (issues.length > 0 || !enc.ok) return fail("INVALID_REQUEST", { issues });
    return { ok: true, value: Object.freeze({ base: parsed.value, format: tool.format, tools: enc.value, continuation }) };
  } catch {
    return fail("INVALID_REQUEST", { issues: ["درخواست قابل خواندن نیست."] });
  }
}
