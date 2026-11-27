/**
 * مدیرِ پیش‌بازرسی‌شده (ADR-0078): همان `ToolPolicyAdmin` ولی `set`/`rollbackTo` پیش از رسیدن به مدیر، بازنویسیِ **نتیجه** را با
 * `preflightToolPolicy` می‌سنجند؛ رد ⇒ هرگز به مدیر نمی‌رسد (نسخه‌ای ثبت نمی‌شود). قراردادها:
 * ۱) **یک عکس:** کلِ ورودی یک‌بار JSON‑کلون می‌شود (getter/Proxy فقط یک بار اجرا می‌شود)؛ هم پیش‌بازرسی و هم مدیر **همان کلون** را می‌بینند
 *    (بین سنجش و ثبت مقدار عوض نمی‌شود). ناپذیرفتنی (چرخه، BigInt، getterِ پرتابی، بیش از سقف) ⇒ `INPUT_UNREADABLE`.
 * ۲) **rollback:** بازنویسیِ نسخهٔ هدف از `history` (فقط‌افزودنی ⇒ همان رکوردی که مدیر می‌خواند) خوانده و با **کدِ جاری** سنجیده می‌شود؛
 *    خطای `history` همان‌گونه بیرون می‌آید و `rollbackTo` صدا زده نمی‌شود. هدفِ ناموجود/نامعتبر به مدیر می‌رسد تا خطای خودش را بدهد.
 * ۳) هرگز نمی‌پرتابد؛ پرتابِ مدیر `STORE_FAILURE`ِ ثابت می‌شود (متنِ خطا خوانده نمی‌شود).
 * محدودیت: سنجش با کدِ همین فرایند است؛ فرایندِ دیگری با کدِ قدیمی‌تر ممکن است بپذیرد/رد کند (ADR-0078 بند ۶).
 */
import type { AdminError, AdminResult, AppliedVersion, CurrentPolicy, HistoryPage } from "@/modules/tool-policy-admin";
import { preflightToolPolicy, rejection } from "./preflight";
import type { PreflightConfigError, PreflightedAdmin, PreflightedAdminOptions, PreflightedAdminResult } from "./types";

/** سقفِ اندازهٔ ورودیِ سریال‌شده؛ بازنویسیِ سیاست و دلیل (۵۰۰ نویسه) بسیار کوچک‌تر است. */
export const MAX_INPUT_CHARS = 16_384;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function cloneInput(raw: unknown): Record<string, unknown> | null {
  try {
    const text = JSON.stringify(raw);
    if (typeof text !== "string" || text.length > MAX_INPUT_CHARS) return null;
    const copy: unknown = JSON.parse(text);
    return isRecord(copy) ? copy : null;
  } catch {
    return null;
  }
}

const STORE_FAILURE: AdminError = Object.freeze({ code: "STORE_FAILURE", message: "مدیرِ سیاست پاسخِ معتبر نداد.", issues: Object.freeze([]), currentVersion: null });

async function guard<T>(run: () => Promise<AdminResult<T>>): Promise<AdminResult<T>> {
  try {
    return await run();
  } catch {
    return { ok: false, error: STORE_FAILURE };
  }
}

function configError(issues: string[]): { ok: false; error: PreflightConfigError } {
  return { ok: false, error: Object.freeze({ code: "INVALID_CONFIG" as const, message: "پیکربندیِ مدیرِ پیش‌بازرسی‌شده نامعتبر است.", issues: Object.freeze(issues) }) };
}

export function createPreflightedAdmin(options: unknown): PreflightedAdminResult {
  let admin: unknown;
  let build: unknown;
  try {
    const o = options as Record<string, unknown> | null | undefined;
    admin = o?.admin;
    build = o?.build;
  } catch {
    return configError(["خواندن گزینه‌ها ناموفق بود."]);
  }
  const issues: string[] = [];
  const methods = ["set", "rollbackTo", "current", "history"];
  const a = admin as Record<string, unknown> | null | undefined;
  let callable = typeof a === "object" && a !== null;
  try {
    callable = callable && methods.every((m) => typeof (a as Record<string, unknown>)[m] === "function");
  } catch {
    callable = false;
  }
  if (!callable) issues.push("admin باید set/rollbackTo/current/history را داشته باشد.");
  if (typeof build !== "function") issues.push("build باید تابع باشد.");
  if (issues.length > 0) return configError(issues);

  const target = admin as PreflightedAdminOptions["admin"];
  const buildFn = build as PreflightedAdminOptions["build"];

  const preflightedAdmin: PreflightedAdmin = {
    async set(input) {
      const copy = cloneInput(input);
      if (copy === null) return rejection("INPUT_UNREADABLE");
      const pf = preflightToolPolicy({ overrides: copy.overrides, build: buildFn });
      if (!pf.ok) return pf;
      return guard<AppliedVersion>(() => target.set(copy));
    },

    async rollbackTo(input) {
      const copy = cloneInput(input);
      if (copy === null) return rejection("INPUT_UNREADABLE");
      const to = copy.toVersion;
      if (typeof to === "number" && Number.isSafeInteger(to) && to >= 1) {
        const page = await guard(() => target.history({ beforeVersion: to + 1, limit: 1 }));
        if (!page.ok) return page;
        const entry = (page.value as HistoryPage).entries[0];
        if (entry !== undefined && entry.version === to) {
          const pf = preflightToolPolicy({ overrides: entry.overrides, build: buildFn });
          if (!pf.ok) return pf;
        }
      }
      return guard<AppliedVersion>(() => target.rollbackTo(copy));
    },

    current: (): Promise<AdminResult<CurrentPolicy>> => guard(() => target.current()),
    history: (input): Promise<AdminResult<HistoryPage>> => guard(() => target.history(input)),
  };
  return { ok: true, value: Object.freeze(preflightedAdmin) };
}
