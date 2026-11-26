/**
 * اعتبارسنجیِ مجددِ خروجیِ `snapshot()` منبع (ADR-0077 بند ۲). منبع «ورودیِ ناقابل‌اعتماد» است: حتی اگر خودش درست باشد، پیوند
 * چیزی را که به پول می‌رسد از یک **منبعِ حقیقتِ واحد** (`projectToolPolicy`) دوباره می‌گذراند و فقط خروجیِ بازساخته را به کار می‌برد.
 * هر کلید فقط یک بار خوانده می‌شود (getter/Proxy نتواند بین سنجش و استفاده مقدار عوض کند)؛ هرگز نمی‌پرتابد و هرگز مقدار/متنِ خطا را بازتاب نمی‌دهد.
 */
import { projectToolPolicy, type PolicyProjection } from "@/modules/tool-policy";
import type { PolicyUnavailableReason } from "./types";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** شکلِ دقیقِ `PolicyProjection` (کلیدِ کم یا اضافه ⇒ رد؛ هیچ‌چیز بی‌صدا با پیش‌فرض پر نمی‌شود). */
const SHAPE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  loop: ["maxSteps", "maxToolCalls", "maxIdenticalCalls", "truncationRetries"],
  service: ["model", "maxOutputTokens", "maxCards", "totalTimeoutMs", "toolTimeoutMs", "maxResultChars"],
  deadline: ["maxCallMs"],
  durable: ["graceMs", "reservationTtlMs", "perMessageOverheadTokens", "onUnknownCost"],
  gatewayModel: ["timeoutMs"],
});

function sameKeys(o: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(o);
  return keys.length === expected.length && expected.every((k) => keys.includes(k));
}

/** `null` ⇒ نامعتبر. وگرنه projectionِ تازه‌ساخته و یخ‌زده (نه شیءِ ورودی). */
export function deriveProjection(raw: unknown): PolicyProjection | null {
  try {
    if (!isRecord(raw) || !sameKeys(raw, Object.keys(SHAPE))) return null;
    const read: Record<string, Record<string, unknown>> = {};
    for (const [section, keys] of Object.entries(SHAPE)) {
      const s = raw[section];
      if (!isRecord(s) || !sameKeys(s, keys)) return null;
      const copy: Record<string, unknown> = {};
      for (const k of keys) copy[k] = s[k];
      read[section] = copy;
    }
    const g = (section: string, key: string): unknown => (read[section] as Record<string, unknown>)[key];
    // نگاشتِ معکوسِ `projectToolPolicy`؛ همه‌چیز (کرانِ هر فیلد و چهار رابطهٔ پول) را خودِ `resolveToolPolicy` می‌سنجد.
    const r = projectToolPolicy({
      loop: { ...read.loop },
      run: { totalTimeoutMs: g("service", "totalTimeoutMs"), toolTimeoutMs: g("service", "toolTimeoutMs"), maxResultChars: g("service", "maxResultChars") },
      answer: { maxCards: g("service", "maxCards"), maxOutputTokens: g("service", "maxOutputTokens") },
      model: { name: g("service", "model"), timeoutMs: g("gatewayModel", "timeoutMs") },
      timing: { graceMs: g("durable", "graceMs"), maxCallMs: g("deadline", "maxCallMs"), reservationTtlMs: g("durable", "reservationTtlMs") },
      metering: { perMessageOverheadTokens: g("durable", "perMessageOverheadTokens"), onUnknownCost: g("durable", "onUnknownCost") },
    });
    return r.ok ? r.value : null;
  } catch {
    return null;
  }
}

export type ParsedSnapshot =
  | Readonly<{ ok: true; version: number; source: "defaults" | "stored"; drift: boolean; ageMs: number; projection: PolicyProjection }>
  | Readonly<{ ok: false; reason: PolicyUnavailableReason }>;

const bad = (reason: PolicyUnavailableReason): ParsedSnapshot => ({ ok: false, reason });
const SOURCE_CLOSED: readonly string[] = ["NOT_LOADED", "STALE", "CLOCK_INVALID"];

/** ورودیِ `unknown` ← نتیجهٔ بسته. فقط `ok === true` (دقیقاً `true`) موفقیت است. */
export function parseSnapshot(raw: unknown): ParsedSnapshot {
  try {
    if (!isRecord(raw)) return bad("SOURCE_INVALID");
    const ok = raw.ok;
    if (ok === false) {
      const e = raw.error;
      const code = isRecord(e) ? e.code : undefined;
      return typeof code === "string" && SOURCE_CLOSED.includes(code) ? bad(code as PolicyUnavailableReason) : bad("SOURCE_INVALID");
    }
    if (ok !== true) return bad("SOURCE_INVALID");
    const v = raw.value;
    if (!isRecord(v)) return bad("SOURCE_INVALID");
    const version = v.version;
    const source = v.source;
    const drift = v.drift;
    const ageMs = v.ageMs;
    const projectionRaw = v.projection;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) return bad("SOURCE_INVALID");
    if (source !== "defaults" && source !== "stored") return bad("SOURCE_INVALID");
    // نسخهٔ ۰ ⇔ پیش‌فرضِ کد (قراردادِ منبع)؛ ناهمخوانی یعنی منبع دروغ می‌گوید.
    if ((version === 0) !== (source === "defaults")) return bad("SOURCE_INVALID");
    if (typeof drift !== "boolean") return bad("SOURCE_INVALID");
    if (typeof ageMs !== "number" || !Number.isFinite(ageMs) || ageMs < 0) return bad("SOURCE_INVALID");
    const projection = deriveProjection(projectionRaw);
    if (projection === null) return bad("PROJECTION_INVALID");
    return { ok: true, version, source, drift, ageMs, projection };
  } catch {
    return bad("SOURCE_INVALID");
  }
}
