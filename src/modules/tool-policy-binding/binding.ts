/**
 * پیوندِ سیاست به دروازه (ADR-0077، CT‑5c‑2c‑2b‑2a). قراردادها:
 * ۱) **شکست‌بسته:** هر چیزِ مشکوک (منبعِ بدشکل، projectionِ نامعتبر، نسخهٔ عقب‌رفته، همان نسخه با محتوای دیگر، ساختنِ ناموفق) ⇒ `POLICY_UNAVAILABLE`؛
 *    هرگز بازگشت به نسخهٔ قبلی، پیش‌فرضِ کد یا مقدارِ حدسی.
 * ۲) **پین:** اجارهٔ هر درخواست نمونه و projectionِ همان لحظه را نگه می‌دارد؛ فعال‌شدنِ نسخهٔ تازه درخواستِ در جریان را عوض نمی‌کند.
 * ۳) **یک ساخت به‌ازای هر نسخه** (شکستِ ساخت هم برای همان نسخه ماندگار است؛ `build` قطعی و بی‌I/O است).
 * ۴) **ترازوی عقب‌گرد** فقط با projectionِ معتبر بالا می‌رود (نسخهٔ جعلیِ بزرگ با projectionِ نامعتبر ترازو را قفل نمی‌کند).
 * هیچ ساعت، تایمر، I/O، `process` یا متنِ خطا اینجا نیست؛ همه‌چیز تزریقی است.
 */
import type { PolicyProjection } from "@/modules/tool-policy";
import type {
  AcquireResult,
  BindingConfigError,
  BindingCreateResult,
  BindingEvent,
  BindingStatus,
  PolicyBinding,
  PolicyBindingOptions,
  PolicyUnavailable,
  PolicyUnavailableReason,
} from "./types";
import { parseSnapshot } from "./validate";

const MESSAGES: Readonly<Record<PolicyUnavailableReason, string>> = Object.freeze({
  NOT_LOADED: "سیاستِ ابزار هنوز بارگذاری نشده است.",
  STALE: "سیاستِ ابزار از سقفِ سنِ مجاز کهنه‌تر است.",
  CLOCK_INVALID: "ساعتِ منبعِ سیاست نامعتبر است.",
  SOURCE_INVALID: "پاسخِ منبعِ سیاست بدشکل یا ناسازگار است.",
  PROJECTION_INVALID: "سیاستِ دریافتی اعتبارسنجیِ مجدد را نگذراند.",
  VERSION_REGRESSED: "نسخهٔ سیاست عقب رفته است.",
  VERSION_CONTENT_MISMATCH: "یک نسخهٔ سیاست با دو محتوای متفاوت دیده شد.",
  BUILD_FAILED: "ساختنِ دروازه از سیاستِ این نسخه ناموفق بود.",
});

const isFn = (v: unknown): boolean => typeof v === "function";

const fail = (reason: PolicyUnavailableReason): { ok: false; error: PolicyUnavailable } => ({
  ok: false,
  error: Object.freeze({ code: "POLICY_UNAVAILABLE" as const, reason, message: MESSAGES[reason] }),
});

type Entry<T> = { version: number; fingerprint: string; instance: { value: T } | null };

function configError(issues: string[]): { ok: false; error: BindingConfigError } {
  return { ok: false, error: Object.freeze({ code: "INVALID_CONFIG" as const, message: "پیکربندیِ پیوندِ سیاست نامعتبر است.", issues: Object.freeze(issues) }) };
}

export function createPolicyBinding<T = unknown>(options: PolicyBindingOptions): BindingCreateResult<T> {
  let source: unknown;
  let build: unknown;
  let observer: unknown;
  try {
    const o = options as unknown as Record<string, unknown> | null | undefined;
    source = o?.source;
    build = o?.build;
    observer = o?.observer;
  } catch {
    return configError(["خواندن گزینه‌ها ناموفق بود."]);
  }
  const issues: string[] = [];
  let snapshot: unknown;
  try {
    snapshot = typeof source === "object" && source !== null ? (source as Record<string, unknown>).snapshot : undefined;
  } catch {
    snapshot = undefined;
  }
  if (!isFn(snapshot)) issues.push("source.snapshot باید تابع باشد.");
  if (!isFn(build)) issues.push("build باید تابع باشد.");
  if (observer !== undefined && !isFn(observer)) issues.push("observer اگر داده شود باید تابع باشد.");
  if (issues.length > 0) return configError(issues);

  const readSnapshot = snapshot as () => unknown;
  const callBuild = build as (p: PolicyProjection) => unknown;
  const observe = observer as ((e: BindingEvent) => unknown) | undefined;

  let current: Entry<T> | null = null;
  let highest: number | null = null;
  let lastUnavailable: PolicyUnavailableReason | null = null;
  let activations = 0;
  let buildFailures = 0;
  let acquired = 0;
  let rejected = 0;

  const emit = (e: BindingEvent): void => {
    if (observe === undefined) return;
    try {
      const r = observe(e);
      if (typeof r === "object" && r !== null && typeof (r as { then?: unknown }).then === "function") {
        void Promise.resolve(r).then(undefined, () => undefined);
      }
    } catch {
      /* ناظر هرگز مسیرِ پول را نمی‌شکند */
    }
  };

  const reject = (reason: PolicyUnavailableReason) => {
    rejected = rejected + 1;
    if (lastUnavailable !== reason) {
      lastUnavailable = reason;
      emit({ type: "policy.unavailable", reason });
    }
    return fail(reason);
  };

  function acquire(): AcquireResult<T> {
    try {
      // پرتابِ منبع به catchِ بیرونی می‌رسد و `SOURCE_INVALID` می‌شود.
      const snap = parseSnapshot(readSnapshot());
      if (!snap.ok) return reject(snap.reason);

      // projection دوباره ساخته شده؛ شناسهٔ محتوا از همان (ترتیبِ کلیدِ ثابت). `source` لازم نیست: `version===0 ⇔ defaults` در اعتبارسنجی سنجیده شده.
      const fingerprint = JSON.stringify(snap.projection);
      if (highest !== null && snap.version < highest) return reject("VERSION_REGRESSED");

      let entry: Entry<T>;
      if (current !== null && snap.version === current.version) {
        if (current.fingerprint !== fingerprint) return reject("VERSION_CONTENT_MISMATCH");
        entry = current;
      } else {
        const previous = current !== null && current.instance !== null ? current.version : null;
        let built: { value: T } | null = null;
        try {
          const r = callBuild(snap.projection) as { ok?: unknown; value?: unknown } | null;
          if (typeof r === "object" && r !== null && r.ok === true) {
            const v = r.value;
            if ((typeof v === "object" && v !== null) || typeof v === "function") built = { value: v as T };
          }
        } catch {
          built = null;
        }
        entry = { version: snap.version, fingerprint, instance: built };
        current = entry;
        highest = snap.version;
        if (built === null) buildFailures = buildFailures + 1;
        else {
          activations = activations + 1;
          emit({ type: "policy.activated", version: snap.version, previousVersion: previous });
        }
      }
      if (entry.instance === null) return reject("BUILD_FAILED");

      if (lastUnavailable !== null) {
        lastUnavailable = null;
        emit({ type: "policy.recovered", version: entry.version });
      }
      acquired = acquired + 1;
      return {
        ok: true,
        value: Object.freeze({ version: snap.version, source: snap.source, drift: snap.drift, ageMs: snap.ageMs, projection: snap.projection, instance: entry.instance.value }),
      };
    } catch {
      return reject("SOURCE_INVALID");
    }
  }

  function status(): BindingStatus {
    return Object.freeze({
      activeVersion: current !== null && current.instance !== null && lastUnavailable === null ? current.version : null,
      highestVersion: highest,
      lastUnavailable,
      activations,
      buildFailures,
      acquired,
      rejected,
    });
  }

  return { ok: true, value: Object.freeze({ acquire, status }) };
}
