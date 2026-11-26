/**
 * tool-policy-host — singletonِ فرایند روی ظرفِ تزریقی (ADR-0075 تصمیم ۳). ماژول `globalThis` را نمی‌شناسد؛
 * مصرف‌کننده آن را به‌عنوان `store` می‌دهد (`instrumentation` و مسیرهای HTTP در Next ممکن است بسته‌های جدا بگیرند؛ `globalThis` نقطهٔ مشترک است).
 * شکست‌بسته: مقدارِ بیگانه زیرِ کلید بازنویسی نمی‌شود؛ شکستِ ساختن ذخیره نمی‌شود؛ هیچ تابعی نمی‌پرتابد.
 */
import { hasFns, hostError } from "./config";
import { evaluateProbe } from "./probes";
import type { AcquireResult, HostResult, ProbeKind, ProbeResult, ToolPolicyHost } from "./types";

export const TOOL_POLICY_HOST_STORE_KEY: unique symbol = Symbol.for("legal-platform.tool-policy-host");

const isStore = (v: unknown): v is Record<symbol, unknown> => (typeof v === "object" || typeof v === "function") && v !== null;
const isHost = (v: unknown): v is ToolPolicyHost => hasFns(v, ["boot", "shutdown", "status"]) && typeof (v as { probes?: unknown }).probes === "object" && hasFns((v as { probes: unknown }).probes, ["live", "startup", "ready"]);

/** میزبانِ موجودِ این ظرف یا `null` (هرگز نمی‌پرتابد؛ مقدارِ بیگانه ⇒ `null`). */
export function getToolPolicyHost(store: unknown): ToolPolicyHost | null {
  try {
    if (!isStore(store)) return null;
    const v = store[TOOL_POLICY_HOST_STORE_KEY];
    return isHost(v) ? v : null;
  } catch {
    return null;
  }
}

/** همان میزبان برای همان ظرف؛ وگرنه `create()` را یک بار صدا می‌زند و ذخیره می‌کند (فقط در موفقیت). */
export function acquireToolPolicyHost(store: unknown, create: () => HostResult<ToolPolicyHost>): AcquireResult {
  try {
    if (!isStore(store)) return hostError("INVALID_STORE", ["store باید شیء باشد."]);
    const existing = store[TOOL_POLICY_HOST_STORE_KEY];
    if (existing !== undefined) {
      return isHost(existing) ? { ok: true, value: existing, created: false } : hostError("INVALID_STORE", ["زیرِ کلیدِ میزبان مقدارِ بیگانه‌ای است (بازنویسی نمی‌شود)."]);
    }
    let made: HostResult<ToolPolicyHost>;
    try {
      made = create(); // غیرتابع یا پرتاب‌کننده ⇒ CREATE_FAILED
    } catch {
      return hostError("CREATE_FAILED", ["create پرتاب کرد."]);
    }
    if (typeof made !== "object" || made === null) return hostError("CREATE_FAILED", ["create نتیجهٔ نامعتبر داد."]);
    if (made.ok !== true) return made.ok === false && typeof made.error === "object" && made.error !== null ? { ok: false, error: made.error } : hostError("CREATE_FAILED", ["create نتیجهٔ نامعتبر داد."]);
    if (!isHost(made.value)) return hostError("CREATE_FAILED", ["create میزبانِ نامعتبر داد."]);
    try {
      store[TOOL_POLICY_HOST_STORE_KEY] = made.value;
    } catch {
      return hostError("INVALID_STORE", ["نوشتن در store ممکن نبود."]);
    }
    if (store[TOOL_POLICY_HOST_STORE_KEY] !== made.value) return hostError("INVALID_STORE", ["نوشتن در store ممکن نبود."]);
    return { ok: true, value: made.value, created: true };
  } catch {
    return hostError("INVALID_STORE", ["store خوانده نشد."]);
  }
}

/**
 * برای مسیرهای HTTP: بدونِ میزبان (instrumentation اجرا نشده) `live`=۲۰۰ و بقیه ۵۰۳ با `state:"absent"`؛ هرگز نمی‌پرتابد.
 */
export function probeToolPolicyHost(store: unknown, kind: ProbeKind): ProbeResult {
  const host = getToolPolicyHost(store);
  try {
    if (host !== null && (kind === "live" || kind === "startup" || kind === "ready")) return host.probes[kind]();
  } catch {
    // میزبانِ خراب مثل نبودنِ میزبان.
  }
  return evaluateProbe(kind, { state: "absent", hasBeenReady: false, readHealth: () => null });
}
