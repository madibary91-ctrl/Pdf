/**
 * settlement-backlog — مونتاژِ پایش (ADR-0039): پیکربندیِ اعتبارسنجی‌شده + نمونه‌گیری + ارزیابیِ خالص.
 * سیاستِ تبدیلِ نتیجه به پاسخِ HTTP و ترکیب با `SweepHealth` در این ماژول نیست (برشِ بعد؛ نیازمندِ تصمیمِ معماری).
 */
import { resolveBacklogSettings } from "./config";
import { evaluateBacklog } from "./evaluate";
import { safeNow, takeSample } from "./sample";
import type { BacklogHealth, BacklogMonitor, BacklogResult } from "./types";

export function createDeadLetterBacklogMonitor(raw: unknown): BacklogResult<BacklogMonitor> {
  const r = resolveBacklogSettings(raw);
  if (!r.ok) return r;
  const s = r.value;
  const ctx = Object.freeze({ thresholds: s.thresholds, sampleLimit: s.sampleLimit });
  const monitor: BacklogMonitor = Object.freeze({
    sample: () => takeSample(s),
    evaluate: (input: unknown): BacklogHealth => evaluateBacklog(ctx, input),
    async check(): Promise<BacklogHealth> {
      const sample = await takeSample(s);
      // ساعتِ ناسالم ⇒ nowMs=null ⇒ INPUT_INVALID (شکستِ بسته)، نه یک سنِ ساختگی.
      return evaluateBacklog(ctx, { sample, nowMs: safeNow(s.clock) });
    },
  });
  return { ok: true, value: monitor };
}
