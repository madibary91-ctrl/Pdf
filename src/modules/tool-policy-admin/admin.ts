/**
 * مدیریتِ نسخه‌دارِ سیاستِ دروازهٔ ابزار (ADR-0069، CT‑5c‑2b‑1). منطقِ «ادمین» روی پورتِ ذخیره‌ساز:
 * هر تغییر = یک نسخهٔ تازهٔ فقط‌افزودنی با CAS (`expectedVersion`)، دلیل و بازیگر؛ سیاست فقط با `resolveToolPolicy` اعتبارسنجی می‌شود
 * و هرگز خودکار اصلاح نمی‌شود. ورودیِ خصمانه یک‌بار عکس گرفته می‌شود (آنچه اعتبارسنجی شد همان است که ذخیره می‌شود). هرگز نمی‌پرتابد و
 * متنِ استثنای ذخیره‌ساز یا مقدارِ ورودی را بازتاب نمی‌دهد. این‌جا هیچ ساعت/تایمر/تصادفی نیست (ساعت تزریق می‌شود).
 */
import { resolveToolPolicy } from "@/modules/tool-policy";
import { canonicalOverrides, diffPolicies, snapshotOverrides, stable } from "./canonical";
import { ADMIN_LIMITS, checkActor, isSafeInt, normalizeReason, parseRecord, readFields } from "./validate";
import type {
  AdminError,
  AdminErrorCode,
  AdminResult,
  AppliedVersion,
  CurrentPolicy,
  HistoryPage,
  PolicyClock,
  PolicyVersionRecord,
  PolicyVersionSource,
  PolicyVersionStore,
  StoreResult,
  ToolPolicyAdmin,
} from "./types";

const MAX_ISSUES = 20;
const MESSAGES: Readonly<Record<AdminErrorCode, string>> = Object.freeze({
  INVALID_ARGUMENT: "ورودیِ مدیریتِ سیاست نامعتبر است.",
  INVALID_OVERRIDES: "بازنویسی‌های سیاست نامعتبر است.",
  INVALID_CLOCK: "ساعتِ تزریق‌شده مقدارِ معتبر نداد.",
  VERSION_CONFLICT: "نسخهٔ مورد انتظار با نسخهٔ فعلی یکی نیست؛ دوباره بخوانید.",
  NO_CHANGE: "تغییری نسبت به نسخهٔ فعلی نیست؛ نسخهٔ تازه ساخته نشد.",
  VERSION_NOT_FOUND: "نسخهٔ خواسته‌شده وجود ندارد.",
  STORED_POLICY_INVALID: "سیاستِ ذخیره‌شده با کدِ جاری معتبر نیست؛ با ثبتِ نسخهٔ تازه اصلاح کنید.",
  STORE_FAILURE: "ذخیره‌ساز پاسخِ معتبر نداد.",
});

const fail = (code: AdminErrorCode, issues: readonly string[] = [], currentVersion: number | null = null): { ok: false; error: AdminError } => ({
  ok: false,
  error: Object.freeze({ code, message: MESSAGES[code], issues: Object.freeze(issues.slice(0, MAX_ISSUES)), currentVersion }),
});
const ok = <T>(value: T): { ok: true; value: T } => ({ ok: true, value });

const conflict: StoreResult<never> = { ok: false, error: Object.freeze({ code: "CONFLICT" }) };
const unavailable: StoreResult<never> = { ok: false, error: Object.freeze({ code: "UNAVAILABLE" }) };

/**
 * پرتاب یا پاسخِ بدشکلِ آداپتور ⇒ `UNAVAILABLE` (متنِ استثنا گرفته نمی‌شود). فقط `CONFLICT` معنای جداگانه دارد (برندهٔ رقابتِ `append`)؛
 * هر کدِ خطای دیگر (`INVALID`/`UNAVAILABLE`/ناشناخته) برای مدیر یکی است: `STORE_FAILURE`.
 */
async function call<T>(fn: () => Promise<StoreResult<T>>): Promise<StoreResult<T>> {
  try {
    const r: unknown = await fn();
    if (typeof r !== "object" || r === null) return unavailable;
    const rec = r as { ok?: unknown; value?: unknown; error?: unknown };
    const flag = rec.ok;
    if (flag === true) return { ok: true, value: rec.value as T };
    if (flag === false) {
      const e = rec.error;
      return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "CONFLICT" ? conflict : unavailable;
    }
    return unavailable;
  } catch {
    return unavailable;
  }
}

async function readLatest(store: PolicyVersionStore): Promise<AdminResult<PolicyVersionRecord | null>> {
  const r = await call(() => store.latest());
  if (!r.ok) return fail("STORE_FAILURE");
  if (r.value === null) return ok(null);
  const rec = parseRecord(r.value);
  return rec === null ? fail("STORE_FAILURE", ["آخرین نسخهٔ ذخیره‌شده خراب است."]) : ok(rec);
}

function readClock(clock: PolicyClock): number | null {
  try {
    const t: unknown = clock.nowMs();
    return isSafeInt(t, 0) ? t : null;
  } catch {
    return null;
  }
}

type CommitInput = Readonly<{
  expectedVersion: number;
  snapshot: Record<string, unknown>;
  source: PolicyVersionSource;
  actor: string;
  reason: string;
}>;

async function commit(store: PolicyVersionStore, clock: PolicyClock, p: CommitInput): Promise<AdminResult<AppliedVersion>> {
  const resolved = resolveToolPolicy(p.snapshot);
  if (!resolved.ok) return fail("INVALID_OVERRIDES", resolved.error.issues);
  const overrides = canonicalOverrides<PolicyVersionRecord["overrides"]>(p.snapshot);
  const nowMs = readClock(clock);
  if (nowMs === null) return fail("INVALID_CLOCK");
  const latest = await readLatest(store);
  if (!latest.ok) return latest;
  const current = latest.value?.version ?? 0;
  if (current !== p.expectedVersion) return fail("VERSION_CONFLICT", [], current);
  const same = latest.value === null ? Object.keys(overrides).length === 0 : stable(latest.value.overrides) === stable(overrides);
  if (same) return fail("NO_CHANGE", [], current);
  const prevPolicy = latest.value === null ? resolveToolPolicy(undefined) : { ok: true as const, value: latest.value.policy };
  const record = parseRecord({
    version: current + 1,
    overrides,
    policy: resolved.value,
    changes: diffPolicies(prevPolicy.ok ? prevPolicy.value : null, resolved.value),
    source: p.source,
    actor: p.actor,
    reason: p.reason,
    createdAtMs: nowMs,
  });
  if (record === null) return fail("STORE_FAILURE", ["رکوردِ تازه شکلِ مجاز را ندارد."], current);
  const appended = await call(() => store.append(record));
  if (!appended.ok) {
    if (appended.error.code !== "CONFLICT") return fail("STORE_FAILURE", [], current);
    const again = await readLatest(store);
    return fail("VERSION_CONFLICT", [], again.ok ? (again.value?.version ?? 0) : null);
  }
  return ok(Object.freeze({ version: record.version, policy: record.policy, overrides: record.overrides, changes: record.changes, createdAtMs: record.createdAtMs }));
}

type Common = Readonly<{ expectedVersion: number; actor: string; reason: string }>;

function readCommon(values: Map<string, unknown>, issues: string[]): Common | null {
  const expectedVersion = values.get("expectedVersion");
  const actor = values.get("actor");
  const reason = normalizeReason(values.get("reason"));
  if (!isSafeInt(expectedVersion, 0)) issues.push("expectedVersion باید عدد صحیحِ ناپایین‌تر از ۰ باشد.");
  if (!checkActor(actor)) issues.push("actor باید شناسهٔ ۱ تا ۱۲۸ نویسه (حروف/ارقام و . _ : @ -) باشد.");
  if (reason === null) issues.push(`reason باید متنِ بی‌کنترلِ ۱ تا ${ADMIN_LIMITS.maxReasonChars} نویسه باشد.`);
  return issues.length === 0 ? { expectedVersion: expectedVersion as number, actor: actor as string, reason: reason as string } : null;
}

export function createToolPolicyAdmin(deps: Readonly<{ store: PolicyVersionStore; clock: PolicyClock }>): AdminResult<ToolPolicyAdmin> {
  const store = deps?.store;
  const clock = deps?.clock;
  const portsOk =
    typeof store === "object" && store !== null && ["latest", "get", "append", "list"].every((m) => typeof (store as unknown as Record<string, unknown>)[m] === "function") && typeof clock === "object" && clock !== null && typeof clock.nowMs === "function";
  if (!portsOk) return fail("INVALID_ARGUMENT", ["store (latest/get/append/list) و clock (nowMs) لازم‌اند."]);

  const admin: ToolPolicyAdmin = {
    async set(input) {
      const { values, issues } = readFields(input, ["expectedVersion", "overrides", "actor", "reason"]);
      if (issues.length === 0 && !values.has("overrides")) issues.push("overrides لازم است.");
      const common = readCommon(values, issues);
      if (common === null) return fail("INVALID_ARGUMENT", issues);
      const snapshot = snapshotOverrides(values.get("overrides"));
      if (snapshot === null) return fail("INVALID_OVERRIDES", ["overrides باید یک شیء سادهٔ خواندنی باشد (`{}` = پیش‌فرض‌های کد)."]);
      return commit(store, clock, { ...common, snapshot, source: Object.freeze({ kind: "set" as const }) });
    },

    async rollbackTo(input) {
      const { values, issues } = readFields(input, ["expectedVersion", "toVersion", "actor", "reason"]);
      const common = readCommon(values, issues);
      const toVersion = values.get("toVersion");
      if (!isSafeInt(toVersion, 1)) issues.push("toVersion باید عدد صحیحِ ناپایین‌تر از ۱ باشد.");
      else if (common !== null && toVersion > common.expectedVersion) issues.push("toVersion نمی‌تواند از expectedVersion بزرگ‌تر باشد.");
      if (common === null || issues.length > 0 || !isSafeInt(toVersion, 1)) return fail("INVALID_ARGUMENT", issues);
      const latest = await readLatest(store);
      if (!latest.ok) return latest;
      const current = latest.value?.version ?? 0;
      if (current !== common.expectedVersion) return fail("VERSION_CONFLICT", [], current);
      const got = await call(() => store.get(toVersion));
      if (!got.ok) return fail("STORE_FAILURE", [], current);
      if (got.value === null) return fail("VERSION_NOT_FOUND", [], current);
      const target = parseRecord(got.value);
      if (target === null || target.version !== toVersion) return fail("STORE_FAILURE", ["نسخهٔ هدف خراب است."], current);
      const snapshot = snapshotOverrides(target.overrides);
      if (snapshot === null) return fail("STORE_FAILURE", ["نسخهٔ هدف خراب است."], current);
      return commit(store, clock, { ...common, snapshot, source: Object.freeze({ kind: "rollback" as const, toVersion }) });
    },

    async current() {
      const latest = await readLatest(store);
      if (!latest.ok) return latest;
      const rec = latest.value;
      const resolved = resolveToolPolicy(rec === null ? undefined : snapshotOverrides(rec.overrides));
      if (!resolved.ok) return fail("STORED_POLICY_INVALID", resolved.error.issues, rec?.version ?? 0);
      const out: CurrentPolicy =
        rec === null
          ? { version: 0, source: "defaults", policy: resolved.value, overrides: Object.freeze({}), drift: false, updatedAtMs: null }
          : { version: rec.version, source: "stored", policy: resolved.value, overrides: rec.overrides, drift: stable(resolved.value) !== stable(rec.policy), updatedAtMs: rec.createdAtMs };
      return ok(Object.freeze(out));
    },

    async history(input) {
      const { values, issues } = readFields(input === undefined ? {} : input, ["beforeVersion", "limit"]);
      const before = values.has("beforeVersion") ? values.get("beforeVersion") : null;
      const limit = values.has("limit") ? values.get("limit") : ADMIN_LIMITS.defaultHistoryLimit;
      if (before !== null && !isSafeInt(before, 1)) issues.push("beforeVersion باید ۱ به بالا یا null باشد.");
      if (!isSafeInt(limit, 1) || limit > ADMIN_LIMITS.maxHistoryLimit) issues.push(`limit باید عدد صحیح ۱ تا ${ADMIN_LIMITS.maxHistoryLimit} باشد.`);
      if (issues.length > 0) return fail("INVALID_ARGUMENT", issues);
      const lim = limit as number;
      const bef = before as number | null;
      const r = await call(() => store.list({ beforeVersion: bef, limit: lim }));
      if (!r.ok || !Array.isArray(r.value) || r.value.length > lim) return fail("STORE_FAILURE");
      const entries: PolicyVersionRecord[] = [];
      let prev = bef ?? Number.MAX_SAFE_INTEGER;
      for (const raw of r.value as readonly unknown[]) {
        const rec = parseRecord(raw);
        if (rec === null || rec.version >= prev) return fail("STORE_FAILURE", ["تاریخچهٔ برگشتی خراب یا نامرتب است."]);
        prev = rec.version;
        entries.push(rec);
      }
      const last = entries[entries.length - 1];
      const page: HistoryPage = { entries: Object.freeze(entries), nextBefore: last !== undefined && entries.length === lim && last.version > 1 ? last.version : null };
      return ok(Object.freeze(page));
    },
  };
  return ok(Object.freeze(admin));
}
