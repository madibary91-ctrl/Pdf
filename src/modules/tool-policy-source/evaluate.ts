/**
 * داوریِ خالصِ یک پاسخِ `current()` در برابرِ نسخهٔ نگه‌داشته‌شده. پاسخِ مدیر «ورودیِ ناشناخته» است (آداپتور/جعلی می‌تواند هر چیزی بدهد)؛
 * هر فیلد یک بار خوانده می‌شود و فقط پس از اعتبارسنجیِ کامل و نگاشتِ دوباره با `projectToolPolicy` پذیرفته می‌شود.
 * قواعدِ ناورداها: نسخه هرگز عقب نمی‌رود؛ نسخهٔ یکسان باید محتوای یکسان بدهد (ذخیره‌ساز فقط‌افزودنی است)؛ هیچ‌گاه خودکار به پیش‌فرض برنمی‌گردد.
 */
import { projectToolPolicy, resolveToolPolicy, type PolicyProjection } from "@/modules/tool-policy";
import type { RefreshErrorCode } from "./types";

export type Held = Readonly<{
  version: number;
  source: "defaults" | "stored";
  projection: PolicyProjection;
  fingerprint: string;
  drift: boolean;
  loadedAtMs: number;
  confirmedAtMs: number;
}>;

export type Candidate = Readonly<{ version: number; source: "defaults" | "stored"; projection: PolicyProjection; fingerprint: string; drift: boolean }>;

export type EvalRejectCode = Exclude<RefreshErrorCode, "INVALID_CLOCK" | "SUPERSEDED">;

export type Decision = Readonly<{ kind: "accept"; outcome: "loaded" | "updated" | "unchanged"; candidate: Candidate }> | Readonly<{ kind: "reject"; code: EvalRejectCode }>;

const reject = (code: EvalRejectCode): Decision => ({ kind: "reject", code });

/** مقایسهٔ مستقل از ترتیبِ کلید (jsonb ترتیب را عوض می‌کند). فقط برای دادهٔ JSON؛ چرخه/نوعِ دیگر ⇒ پرتاب (گرفته می‌شود). */
export function stable(v: unknown): string {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) return "!";
    return JSON.stringify(v) ?? "!";
  }
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`;
}

type Read = Readonly<{ kind: "ok"; candidate: Candidate }> | Readonly<{ kind: "reject"; code: EvalRejectCode }>;
const bad = (code: EvalRejectCode): Read => ({ kind: "reject", code });

/** بازسازیِ مستقل از پاسخِ مدیر. */
function readCandidate(raw: unknown): Read {
  if (typeof raw !== "object" || raw === null) return bad("INVALID_RESPONSE");
  const r = raw as { ok?: unknown; value?: unknown; error?: unknown };
  const flag = r.ok;
  if (flag === false) {
    const e = r.error;
    const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
    if (typeof code !== "string") return bad("INVALID_RESPONSE");
    return bad(code === "STORED_POLICY_INVALID" ? "STORED_POLICY_INVALID" : "READ_FAILED");
  }
  if (flag !== true) return bad("INVALID_RESPONSE");
  const v = r.value;
  if (typeof v !== "object" || v === null) return bad("INVALID_RESPONSE");
  const f = v as { version?: unknown; source?: unknown; policy?: unknown; drift?: unknown };
  const version = f.version;
  const source = f.source;
  const policy = f.policy;
  const drift = f.drift;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) return bad("INVALID_RESPONSE");
  if (source !== "defaults" && source !== "stored") return bad("INVALID_RESPONSE");
  if ((version === 0) !== (source === "defaults")) return bad("INVALID_RESPONSE");
  if (typeof drift !== "boolean") return bad("INVALID_RESPONSE");
  // `projectToolPolicy(undefined)` و بازنویسیِ ناقص = پیش‌فرض‌های کد؛ سیاستِ «مؤثرِ کامل» باید نقطهٔ ثابتِ resolve باشد، وگرنه یعنی
  // فیلدی افتاده و بی‌صدا با پیش‌فرض پر می‌شد.
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return bad("PROJECTION_INVALID");
  const resolved = resolveToolPolicy(policy);
  if (!resolved.ok || stable(resolved.value) !== stable(policy)) return bad("PROJECTION_INVALID");
  const projected = projectToolPolicy(resolved.value);
  if (!projected.ok) return bad("PROJECTION_INVALID");
  return { kind: "ok", candidate: { version, source, projection: projected.value, fingerprint: stable(projected.value), drift } };
}

export function evaluate(raw: unknown, held: Held | null): Decision {
  let read: Read;
  try {
    read = readCandidate(raw);
  } catch {
    read = bad("INVALID_RESPONSE");
  }
  if (read.kind === "reject") return reject(read.code);
  const cand = read.candidate;
  if (held === null) return { kind: "accept", outcome: "loaded", candidate: cand };
  if (cand.version < held.version) return reject("VERSION_REGRESSED");
  if (cand.version === held.version) {
    // نسخه↔منبع در readCandidate هم‌سنج شده؛ پس نسخهٔ یکسان منبعِ یکسان دارد و فقط محتوا سنجیده می‌شود.
    if (cand.fingerprint !== held.fingerprint) return reject("VERSION_CONTENT_MISMATCH");
    return { kind: "accept", outcome: "unchanged", candidate: cand };
  }
  return { kind: "accept", outcome: "updated", candidate: cand };
}
