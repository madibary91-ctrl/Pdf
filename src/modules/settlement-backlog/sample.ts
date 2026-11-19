/**
 * settlement-backlog — نمونه‌گیریِ فقط‌خواندنیِ پسماند. تنها I/O این ماژول، یک فراخوانیِ `outbox.listUnacknowledgedDead` است (پورتِ تزریقی)؛
 * هیچ‌چیز را تأیید/ثبت نمی‌کند، تایمرِ سراسری نمی‌سازد و هرگز نمی‌پرتابد: هر خرابیِ پورت به یک کدِ بسته (`BacklogSampleFailure`) تبدیل می‌شود.
 */
import type { DeadReason } from "@/modules/settlement";
import type { BacklogSettings } from "./config";
import type { BacklogByReason, BacklogSample, BacklogSampleFailure } from "./types";

const DEAD_REASONS: Readonly<Record<DeadReason, true>> = { EXPIRED_UNBILLED: true, ATTEMPTS_EXHAUSTED: true, LEDGER_REJECTED: true };

const has = (table: object, key: string): boolean => Object.prototype.hasOwnProperty.call(table, key);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isId = (v: unknown): v is string => typeof v === "string" && v.length > 0;

const fail = (code: BacklogSampleFailure, atMs: number | null): BacklogSample => Object.freeze({ ok: false as const, atMs, code });

/** ساعتِ امن: پرتاب یا مقدارِ نامعتبر ⇒ `null`. */
export function safeNow(clock: BacklogSettings["clock"]): number | null {
  try {
    const v: unknown = clock.nowMs();
    return isTime(v) ? v : null;
  } catch {
    return null;
  }
}

type Listed = { kind: "ok"; value: unknown } | { kind: "threw" } | { kind: "timeout" };

/** یک فراخوانی با مهلتِ اختیاری. هر مسیرِ پایانی تایمر را (اگر ساخته شده) لغو می‌کند؛ پایانِ دیرهنگامِ فراخوانی نادیده و بی‌خطاست. */
function listWithTimeout(s: BacklogSettings): Promise<Listed> {
  return new Promise<Listed>((resolve) => {
    let settled = false;
    let handle: unknown;
    let armed = false;
    const done = (r: Listed): void => {
      if (settled) return;
      settled = true;
      // تایمری که خودش شلیک کرده لغو نمی‌شود؛ در هر مسیرِ دیگر، تایمرِ ساخته‌شده لغو می‌شود.
      if (armed && r.kind !== "timeout") {
        try {
          s.timer?.cancel(handle);
        } catch {
          // لغوِ ناموفق چیزی را عوض نمی‌کند؛ نتیجه همین است.
        }
      }
      resolve(r);
    };
    let call: Promise<unknown>;
    try {
      call = Promise.resolve(s.outbox.listUnacknowledgedDead(Object.freeze({ limit: s.sampleLimit })));
    } catch {
      done({ kind: "threw" });
      return;
    }
    call.then(
      (value) => done({ kind: "ok", value }),
      () => done({ kind: "threw" }),
    );
    if (s.timer !== null) {
      try {
        handle = s.timer.after(() => done({ kind: "timeout" }), s.timeoutMs);
        armed = true;
      } catch {
        done({ kind: "threw" });
      }
    }
  });
}

/** فهرستِ خوانده‌شده را می‌سنجد و تجمیع می‌کند؛ هر انحرافِ شکلی ⇒ `null` (BAD_LIST). */
function aggregate(list: readonly unknown[], atMs: number): BacklogSample | null {
  const seen = new Set<string>();
  const byReason: Record<DeadReason, number> = { EXPIRED_UNBILLED: 0, ATTEMPTS_EXHAUSTED: 0, LEDGER_REJECTED: 0 };
  let oldest: number | null = null;
  let undated = 0;
  for (const e of list) {
    if (!isRecord(e)) return null;
    const { state, tenantId, accountId, reservationId, deadReason, settledAtMs } = e;
    if (state !== "dead" || !isId(tenantId) || !isId(accountId) || !isId(reservationId)) return null;
    if (typeof deadReason !== "string" || !has(DEAD_REASONS, deadReason)) return null;
    if (settledAtMs !== null && !isTime(settledAtMs)) return null;
    const key = JSON.stringify([tenantId, accountId, reservationId]);
    if (seen.has(key)) return null;
    seen.add(key);
    byReason[deadReason as DeadReason] += 1;
    if (settledAtMs === null) undated += 1;
    else if (oldest === null || settledAtMs < oldest) oldest = settledAtMs;
  }
  return Object.freeze({
    ok: true as const,
    atMs,
    count: list.length,
    truncated: false,
    oldestDeadAtMs: oldest,
    undated,
    byReason: Object.freeze(byReason) as BacklogByReason,
  });
}

export async function takeSample(s: BacklogSettings): Promise<BacklogSample> {
  let atMs: number | null = null;
  try {
    atMs = safeNow(s.clock);
    if (atMs === null) return fail("CLOCK_INVALID", null);
    const got = await listWithTimeout(s);
    if (got.kind === "timeout") return fail("TIMEOUT", atMs);
    if (got.kind === "threw") return fail("LIST_FAILED", atMs);
    const r = got.value;
    if (!isRecord(r) || typeof r["ok"] !== "boolean") return fail("BAD_LIST", atMs);
    if (r["ok"] === false) return fail("LIST_FAILED", atMs);
    const value = r["value"];
    if (!Array.isArray(value) || value.length > s.sampleLimit) return fail("BAD_LIST", atMs);
    const agg = aggregate(value, atMs);
    if (agg === null || !agg.ok) return fail("BAD_LIST", atMs);
    return Object.freeze({ ...agg, truncated: agg.count === s.sampleLimit });
  } catch {
    // خواندنِ فیلدِ رکورد/پاسخ پرتاب کرد (Proxy/getterِ بدجنس) ⇒ همان BAD_LIST، با ساعتِ لحظهٔ نمونه‌گیری (اگر خوانده شده بود).
    return fail("BAD_LIST", atMs);
  }
}
