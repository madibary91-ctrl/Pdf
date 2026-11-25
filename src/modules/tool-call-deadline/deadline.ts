/**
 * سقفِ سختِ مهلتِ تماسِ مدل (ADR-0066؛ بستنِ «گامِ زامبی» ADR-0065-الف **بر اساسِ ساخت**).
 * دروازهٔ درونی را می‌پوشاند: اگر `completeStep` در `maxCallMs` برنگشت، سیگنالِ لغو به تماس داده می‌شود و **همان لحظه** نتیجهٔ `TIMEOUT`
 * (هزینه: گزارش‌نشده) برمی‌گردد؛ لایهٔ اندازه‌گیری آن را «هزینهٔ نامعلوم» می‌بیند (هرگز «هیچ»؛ `TIMEOUT` در NEVER_REACHED_CODES نیست) و طبق
 * `onUnknownCost` پیش از `graceMs` می‌بندد ⇒ رفتگر هرگز رزروِ تماسِ **زنده** را نمی‌بندد. جوابِ دیرهنگامِ تماس دورریخته می‌شود
 * (هرگز پول را عوض نمی‌کند) و فقط به‌صورتِ رویدادِ بی‌متن به ناظر می‌رسد. بی‌پرتاب؛ متنِ استثنا هرگز گرفته نمی‌شود؛ تایمر همیشه پاک می‌شود.
 */
import type { Timers, ToolGateway, ToolStepResult } from "@/modules/ai-gateway";
import { resolveDeadlineOptions } from "./config";
import type { CallDeadlineResult, DeadlineEvent } from "./types";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isSignal = (v: unknown): v is AbortSignal =>
  isRecord(v) && typeof v["aborted"] === "boolean" && typeof v["addEventListener"] === "function" && typeof v["removeEventListener"] === "function";

/** پیام‌های ثابت؛ هیچ مقدارِ پیکربندی یا متنِ کاربر/ارائه‌دهنده در آن‌ها نیست. */
export const DEADLINE_MESSAGES = Object.freeze({
  TIMEOUT: "مهلتِ سختِ تماسِ مدل به پایان رسید؛ تماس لغو و هزینه نامعلوم تلقی شد.",
  INTERNAL_ERROR: "تماسِ مدل با خطای پیش‌بینی‌نشده شکست خورد؛ هزینه نامعلوم تلقی شد.",
});

/**
 * `retryable:false`: هزینه نامعلوم است و ارائه‌دهنده ممکن است پول گرفته باشد (پرهیز از دوباره‌خرجی).
 * کدها عمداً `TIMEOUT` و `INTERNAL_ERROR`‌اند: هیچ‌کدام «پیش از رسیدن به ارائه‌دهنده» نیستند ⇒ هزینه «نامعلوم» است نه «هیچ».
 */
const failure = (code: keyof typeof DEADLINE_MESSAGES): ToolStepResult =>
  Object.freeze({ ok: false as const, error: Object.freeze({ code, message: DEADLINE_MESSAGES[code], retryable: false, warnings: Object.freeze([]), usage: null, cost: null }) });

type Raced = Readonly<{ kind: "value"; value: unknown }> | Readonly<{ kind: "threw" }> | Readonly<{ kind: "deadline" }>;

/** خلاصهٔ بی‌متنِ جوابِ دیرهنگام (فقط ok و هزینهٔ معتبر). */
function lateEvent(r: Raced): DeadlineEvent {
  if (r.kind !== "value" || !isRecord(r.value)) return { kind: "late-result", ok: null, cost: null };
  const v = r.value;
  const ok = typeof v["ok"] === "boolean" ? v["ok"] : null;
  const holder = ok === true ? v["value"] : ok === false ? v["error"] : null;
  const c = isRecord(holder) ? holder["cost"] : null;
  const cost = isRecord(c) && typeof c["currency"] === "string" && typeof c["micros"] === "number" && Number.isSafeInteger(c["micros"]) && c["micros"] >= 0 ? { currency: c["currency"].slice(0, 8), micros: c["micros"] } : null;
  return { kind: "late-result", ok, cost };
}

export function createDeadlineToolGateway(raw: unknown): CallDeadlineResult {
  const resolved = resolveDeadlineOptions(raw);
  if (!resolved.ok) return resolved;
  const { gateway, maxCallMs, timers, onEvent } = resolved.value;
  const emit = (event: DeadlineEvent): void => {
    if (onEvent === null) return;
    try {
      (onEvent as (e: DeadlineEvent) => void)(event);
    } catch {
      // ناظر نباید نتیجهٔ گام را عوض کند.
    }
  };
  const complete = gateway["completeStep"] as (input: unknown, options?: unknown) => unknown;
  return { ok: true, value: build(gateway, complete, maxCallMs, timers, emit) };
}

function build(gateway: Record<string, unknown>, complete: (input: unknown, options?: unknown) => unknown, maxCallMs: number, timers: Timers, emit: (e: DeadlineEvent) => void): ToolGateway {
  return Object.freeze({
    async completeStep(input: unknown, options?: Readonly<{ signal?: AbortSignal }>): Promise<ToolStepResult> {
      const ac = new AbortController();
      const caller = isRecord(options) ? options["signal"] : undefined;
      let onCallerAbort: (() => void) | null = null;
      if (isSignal(caller)) {
        if (caller.aborted) ac.abort();
        else {
          onCallerAbort = () => ac.abort();
          caller.addEventListener("abort", onCallerAbort, { once: true });
        }
      }
      let handle: unknown;
      let armed = false;
      let expired = false;
      try {
        let fire: (r: Raced) => void = () => undefined;
        const deadline = new Promise<Raced>((resolve) => void (fire = resolve));
        handle = timers.setTimeout(() => {
          expired = true;
          ac.abort(); // تماسِ بیرونی را لغو کن؛ نتیجه‌اش دیگر مهم نیست.
          emit({ kind: "deadline", maxCallMs });
          fire({ kind: "deadline" });
        }, maxCallMs);
        armed = true;
        // `async` تا پرتابِ همگام هم به رد شدن بدل شود؛ به تماس سیگنالِ **ما** (ترکیبِ لغوِ فراخواننده و مهلت) می‌رسد.
        const work: Promise<Raced> = (async () => complete(input, { ...(isRecord(options) ? options : {}), signal: ac.signal }))().then(
          (value): Raced => ({ kind: "value", value }),
          (): Raced => ({ kind: "threw" }),
        );
        // جوابِ دیرهنگام فقط گزارش می‌شود (همیشه handler دارد؛ rejection کنترل‌نشده نمی‌سازد).
        void work.then((r) => {
          if (expired) emit(lateEvent(r));
        });
        const r = await Promise.race([work, deadline]);
        if (r.kind === "deadline") return failure("TIMEOUT");
        if (r.kind === "threw") return failure("INTERNAL_ERROR");
        return r.value as ToolStepResult;
      } catch {
        // فقط خطای برپاییِ تایمر می‌رسد (تماس شروع نشده)؛ بی‌سقف نمی‌رویم.
        return failure("INTERNAL_ERROR");
      } finally {
        if (armed) {
          try {
            timers.clearTimeout(handle);
          } catch {
            // پاک‌سازیِ تایمر نباید نتیجهٔ گام را عوض کند.
          }
        }
        if (isSignal(caller) && onCallerAbort !== null) caller.removeEventListener("abort", onCallerAbort);
      }
    },
    toolFormat: (model: string) => (gateway["toolFormat"] as (m: string) => ReturnType<ToolGateway["toolFormat"]>)(model),
    limits: (model: string) => (gateway["limits"] as (m: string) => ReturnType<ToolGateway["limits"]>)(model),
  });
}
