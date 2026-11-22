/** اجرای ابزارها در مرزِ مدل ← محاسبه. بی‌پرتاب نسبت به ورودیِ مدل؛ باگِ درونیِ legal-calc پنهان نمی‌شود. */
import { err, ok, type DomainError, type Result } from "@/modules/shared-types";
import { courtFeeTool } from "./court-fee-tool";
import { toJsonValue } from "./json";
import { deepFreeze, validateAgainstSchema } from "./schema";
import type { ToolDef } from "./tool-def";
import type { CalcToolDeps, CalcToolDescriptor, CalcToolName, CalcToolOutput } from "./types";
import { latePaymentTool } from "./late-payment-tool";

/** ترتیب = ترتیبی که به مدل نشان داده می‌شود. */
const DEFS: readonly ToolDef[] = [courtFeeTool, latePaymentTool];
// Map (نه شیء ساده): نامِ `__proto__`/`constructor`/`toString` هرگز یک ابزار را «پیدا» نمی‌کند.
const BY_NAME: ReadonlyMap<string, ToolDef> = new Map(DEFS.map((d) => [d.descriptor.name, d]));

export const CALC_TOOLS: readonly CalcToolDescriptor[] = deepFreeze(DEFS.map((d) => d.descriptor));

/** سقفِ فنیِ طولِ رشتهٔ JSONِ آرگومان‌ها (نویسه)؛ شماهای ما چند صد نویسه‌اند. */
export const MAX_ARGS_JSON_LENGTH = 8192;

export function isCalcToolName(name: unknown): name is CalcToolName {
  return typeof name === "string" && BY_NAME.has(name);
}

function unknownTool(name: unknown): Result<never, DomainError> {
  const shown = typeof name === "string" ? `«${name.slice(0, 60)}»` : "نامعتبر";
  return err("INVALID_INPUT", `ابزار ${shown} وجود ندارد. ابزارهای موجود: ${[...BY_NAME.keys()].join("، ")}.`);
}

export function executeCalcTool(name: unknown, args: unknown, deps: CalcToolDeps = {}): Result<CalcToolOutput, DomainError> {
  if (typeof name !== "string") return unknownTool(name);
  const def = BY_NAME.get(name);
  if (def === undefined) return unknownTool(name);

  const valid = validateAgainstSchema(def.descriptor.parameters, args);
  if (!valid.ok) return valid;

  const ran = def.run(valid.value, deps);
  if (!ran.ok) return ran;

  const json = toJsonValue(ran.value.result);
  if (!json.ok) return json;
  const notes = toJsonValue(ran.value.notes);
  if (!notes.ok || !Array.isArray(notes.value)) return err("OUT_OF_RANGE", "یادداشت‌های محاسبه قابل‌سریال‌شدن نیستند.");

  return ok(
    deepFreeze({
      tool: def.descriptor.name,
      result: json.value,
      review: { ...ran.value.review },
      reviewPending: ran.value.review.status !== "legally-verified",
      notes: [...ran.value.notes],
    }),
  );
}

/** همان اجرا، ولی آرگومان‌ها رشتهٔ JSON‌اند (آنچه مدل واقعاً می‌فرستد). JSONِ خراب/بزرگ = خطا، نه پرتاب. */
export function executeCalcToolJson(name: unknown, argsJson: unknown, deps: CalcToolDeps = {}): Result<CalcToolOutput, DomainError> {
  if (typeof argsJson !== "string") return err("INVALID_INPUT", "آرگومان‌های ابزار باید رشتهٔ JSON باشند.");
  if (argsJson.length > MAX_ARGS_JSON_LENGTH) {
    return err("INVALID_INPUT", `رشتهٔ JSONِ آرگومان‌ها از ${MAX_ARGS_JSON_LENGTH} نویسه بیشتر است.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return err("PARSE_ERROR", "آرگومان‌های ابزار JSON معتبر نیستند.");
  }
  return executeCalcTool(name, parsed, deps);
}
