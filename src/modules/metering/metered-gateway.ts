/**
 * دروازهٔ اندازه‌گیر (ADR-0020). هر `complete`: ورودی را عکس می‌گیرد ← بدترین‌هزینه را رزرو می‌کند ← (فقط اگر رزرو تازه بود) دروازهٔ درونی را
 * صدا می‌زند ← هزینهٔ واقعی را مصرف و باقیمانده را آزاد یا صریحاً سوخت می‌کند. هرگز نمی‌پرتابد. ساعت و تصادف ندارد؛ شناسه‌ها قطعی‌اند.
 */
import type { Completion, GatewayError } from "@/modules/ai-gateway";
import type { LedgerErrorCode, LedgerResult } from "@/modules/ledger";
import { resolveMeteringConfig } from "./config";
import { observeCost } from "./cost";
import { estimateReservation } from "./estimate";
import type { MeteredGateway, MeteredResult, MeteringAlarm, MeteringOutcome, MeteringReceipt, MeteringResult, RefusalCode } from "./types";

/** تلاش فوریِ تسویه روی شکست‌های گذرای دفتر (بی‌تایمر). `charge`/`close` با شناسهٔ ثابت idempotent‌اند، پس تکرار امن است. */
export const SETTLE_ATTEMPTS = 3;
/** تنها تلاشِ هر رزرو؛ هر تماس دروازه یک رزرو و یک تلاش است (ADR-0020 تصمیم ۳). */
export const ATTEMPT_ID = "a1";

const REFUSAL_MESSAGES: Readonly<Record<RefusalCode, string>> = {
  INVALID_REQUEST: "درخواست برای اندازه‌گیری مصرف نامعتبر است؛ تماسی انجام نشد.",
  UNKNOWN_MODEL: "مدل برای اندازه‌گیری مصرف شناخته‌شده نیست؛ تماسی انجام نشد.",
  UNPRICED_MODEL: "مدلِ بی‌قیمت را نمی‌توان اندازه‌گیری کرد (سقف هزینه‌اش نامعلوم است)؛ تماسی انجام نشد.",
  CURRENCY_MISMATCH: "ارز مدل با واحد حساب هم‌خوان نیست؛ تماسی انجام نشد.",
  ESTIMATE_OVERFLOW: "برآورد بدترین هزینه از حد ایمن گذشت؛ تماسی انجام نشد.",
  INSUFFICIENT_CREDIT: "اعتبار برای بدترین هزینهٔ این تماس کافی نیست؛ تماسی انجام نشد.",
  ACCOUNT_NOT_FOUND: "حساب اعتبار یافت نشد؛ تماسی انجام نشد.",
  TOO_MANY_OPEN_RESERVATIONS: "شمار رزروهای باز از حد گذشت؛ تماسی انجام نشد.",
  SCOPE_REUSED: "این شناسهٔ دامنه پیشتر استفاده شده؛ تماسی انجام نشد.",
  RESERVE_FAILED: "رزرو اعتبار ناموفق بود؛ تماسی انجام نشد.",
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const TRANSIENT: ReadonlySet<LedgerErrorCode> = new Set(["STORE_FAILURE", "INTERNAL_ERROR"]);

type Snapshot = Readonly<{ request: Record<string, unknown>; model: unknown; contents: readonly unknown[]; maxOutputTokens: unknown }>;

/** عکسِ یک‌بارخوانیِ درخواست: همان چیزی که برآورد می‌شود، عیناً به دروازه می‌رسد (بستنِ TOCTOU با getter/Proxy). `null` = ناخوانا. */
function snapshot(input: unknown): Snapshot | null {
  try {
    if (!isRecord(input)) return null;
    const request: Record<string, unknown> = { ...input };
    const raw = request["messages"];
    let contents: unknown[] = [];
    if (Array.isArray(raw)) {
      const msgs = raw.map((m: unknown) => (isRecord(m) ? { ...m } : m));
      request["messages"] = msgs;
      contents = msgs.map((m) => (isRecord(m) ? m["content"] : undefined));
    }
    return { request, model: request["model"], contents, maxOutputTokens: request["maxOutputTokens"] };
  } catch {
    return null;
  }
}

async function settleCall<T>(op: () => Promise<LedgerResult<T>>): Promise<LedgerResult<T>> {
  let last: LedgerResult<T> = { ok: false, error: { code: "INTERNAL_ERROR", message: "تسویه اجرا نشد." } };
  for (let i = 0; i < SETTLE_ATTEMPTS; i++) {
    try {
      last = await op();
    } catch {
      last = { ok: false, error: { code: "INTERNAL_ERROR", message: "تسویه اجرا نشد." } };
    }
    if (last.ok || !TRANSIENT.has(last.error.code)) return last;
  }
  return last;
}

export function createMeteredGateway(raw: unknown): MeteringResult<MeteredGateway> {
  const resolved = resolveMeteringConfig(raw);
  if (!resolved.ok) return resolved;
  const cfg = resolved.value;
  let counter = 0;

  const receipt = (r: Omit<MeteringReceipt, "unit" | "alarms"> & { alarms?: readonly MeteringAlarm[] }): MeteringReceipt => Object.freeze({ ...r, unit: cfg.unit, alarms: Object.freeze([...(r.alarms ?? [])]) });
  const refused = (code: RefusalCode, ledgerCode?: LedgerErrorCode): MeteredResult => {
    const metering = receipt({ outcome: "refused", reservationId: null, reserved: 0, charged: 0, shortfall: 0, refusal: ledgerCode === undefined ? { code } : { code, ledgerCode } });
    const error: GatewayError & { metering: MeteringReceipt } = { code: "INTERNAL_ERROR", message: REFUSAL_MESSAGES[code], retryable: false, warnings: [], metering };
    return Object.freeze({ ok: false as const, error: Object.freeze(error) });
  };
  const attach = (result: unknown, metering: MeteringReceipt): MeteredResult => {
    if (isRecord(result) && result["ok"] === true && isRecord(result["value"])) return Object.freeze({ ok: true as const, value: Object.freeze({ ...(result["value"] as Completion), metering }) });
    if (isRecord(result) && result["ok"] === false && isRecord(result["error"])) return Object.freeze({ ok: false as const, error: Object.freeze({ ...(result["error"] as GatewayError), metering }) });
    const error: GatewayError & { metering: MeteringReceipt } = { code: "INTERNAL_ERROR", message: "دروازهٔ درونی نتیجهٔ معتبر نداد.", retryable: false, warnings: [], metering };
    return Object.freeze({ ok: false as const, error: Object.freeze(error) });
  };

  async function run(n: number, input: unknown, options: Readonly<{ signal?: AbortSignal }> | undefined): Promise<MeteredResult> {
    const snap = snapshot(input);
    if (snap === null || typeof snap.model !== "string") return refused("INVALID_REQUEST");
    const est = estimateReservation({
      model: snap.model,
      contents: snap.contents as readonly string[],
      maxOutputTokens: snap.maxOutputTokens as number,
      models: cfg.models,
      fallbacks: cfg.fallbacks,
      currency: cfg.currency,
      maxProviderCalls: cfg.maxProviderCalls,
      perMessageOverheadTokens: cfg.perMessageOverheadTokens,
    });
    if (!est.ok) return refused(est.code);

    const reservationId = `${cfg.scopeId}.r${n}`;
    const key = cfg.account;
    // بی‌تلاش دوباره: پس از خطای نامعلومِ commit، تکرار «replayed» می‌داد و از SCOPE_REUSED تمایزناپذیر بود؛ رزرو ناموفق خودبه‌خود با سررسید آزاد می‌شود.
    let reserved: LedgerResult<{ amount: number; replayed: boolean }>;
    try {
      reserved = await cfg.ledger.reserve({ ...key, reservationId, unit: cfg.unit, amount: est.value.amount, ttlMs: cfg.reservationTtlMs });
    } catch {
      return refused("RESERVE_FAILED");
    }
    if (!reserved.ok) {
      const c = reserved.error.code;
      if (c === "INSUFFICIENT_CREDIT" || c === "ACCOUNT_NOT_FOUND" || c === "TOO_MANY_OPEN_RESERVATIONS") return refused(c, c);
      if (c === "IDEMPOTENCY_CONFLICT") return refused("SCOPE_REUSED", c);
      return refused("RESERVE_FAILED", c);
    }
    if (reserved.value.replayed) return refused("SCOPE_REUSED");
    const amount = reserved.value.amount;

    let result: unknown = null;
    try {
      result = await cfg.gateway.complete(snap.request, options);
    } catch {
      result = null;
    }
    return attach(result, await settle(reservationId, amount, observeCost(result, cfg.currency)));
  }

  async function settle(reservationId: string, reserved: number, observed: ReturnType<typeof observeCost>): Promise<MeteringReceipt> {
    const key = cfg.account;
    const alarms: MeteringAlarm[] = [];
    const base = { reservationId, reserved };
    const close = (remainder: "release" | "forfeit") => settleCall(() => cfg.ledger.close({ ...key, reservationId, remainder }));

    if (observed.kind === "known") {
      const ch = await settleCall(() => cfg.ledger.charge({ ...key, reservationId, attemptId: ATTEMPT_ID, unit: cfg.unit, amount: observed.micros }));
      if (!ch.ok) {
        // هزینه شده ولی ثبت نشد. انقضا = صورتحساب‌نشده؛ هر چیز دیگر = تسویهٔ معلق. در هر دو، رزرو را «آزاد» نمی‌کنیم تا پنهان نماند.
        if (ch.error.code === "RESERVATION_EXPIRED") return receipt({ ...base, outcome: "unbilled", charged: 0, shortfall: 0, alarms: ["UNBILLED"] });
        return receipt({ ...base, outcome: "settlement-failed", charged: 0, shortfall: 0, alarms: ["SETTLEMENT_PENDING"] });
      }
      if (ch.value.shortfall > 0) alarms.push("SHORTFALL");
      const cl = await close("release");
      if (!cl.ok) alarms.push("CLOSE_PENDING");
      return receipt({ ...base, outcome: "billed", charged: ch.value.charged, shortfall: ch.value.shortfall, alarms });
    }

    const remainder = observed.kind === "none" ? "release" : cfg.onUnknownCost;
    let charged = 0;
    let shortfall = 0;
    if (observed.kind === "unknown") {
      alarms.push("COST_UNKNOWN");
      // کفِ معلوم (مثلاً تلاش موفقِ پس از چند تلاش ناموفق) همیشه مصرف می‌شود؛ فقط بخش نامعلوم تابع سیاست است.
      if (observed.lowerBound > 0) {
        const ch = await settleCall(() => cfg.ledger.charge({ ...key, reservationId, attemptId: ATTEMPT_ID, unit: cfg.unit, amount: observed.lowerBound }));
        if (!ch.ok) {
          if (ch.error.code === "RESERVATION_EXPIRED") return receipt({ ...base, outcome: "unbilled", charged: 0, shortfall: 0, alarms: [...alarms, "UNBILLED"] });
          return receipt({ ...base, outcome: "settlement-failed", charged: 0, shortfall: 0, alarms: [...alarms, "SETTLEMENT_PENDING"] });
        }
        charged = ch.value.charged;
        shortfall = ch.value.shortfall;
        if (shortfall > 0) alarms.push("SHORTFALL");
      }
    }
    const cl = await close(remainder);
    const outcome: MeteringOutcome = remainder === "forfeit" ? "forfeited" : "released";
    if (cl.ok) return receipt({ ...base, outcome, charged, shortfall, alarms });
    // `close(release)` روی رزروِ منقضی در دفتر موفق است (باقیمانده پیشتر آزاد شده)؛ فقط `forfeit` با RESERVATION_EXPIRED رد می‌شود:
    // سوخت‌کردنِ هزینهٔ نامعلوم اجرا نشد ⇒ صورتحساب‌نشده (یافتهٔ جهشی: شاخهٔ «release + منقضی» پیش‌تر کدِ مرده بود).
    if (cl.error.code === "RESERVATION_EXPIRED") return receipt({ ...base, outcome: "unbilled", charged, shortfall, alarms: [...alarms, "UNBILLED"] });
    return receipt({ ...base, outcome: "settlement-failed", charged, shortfall, alarms: [...alarms, "SETTLEMENT_PENDING"] });
  }

  const gateway: MeteredGateway = Object.freeze({
    async complete(input: unknown, options?: Readonly<{ signal?: AbortSignal }>): Promise<MeteredResult> {
      const n = ++counter; // همگام و پیش از هر await: تماس‌های هم‌زمان شناسهٔ جدا می‌گیرند.
      try {
        return await run(n, input, options);
      } catch {
        // خطای برنامه‌نویسی (نه پورت‌ها؛ آن‌ها جدا محافظت شده‌اند). نمی‌دانیم کجا بودیم؛ رزروِ احتمالی با سررسید آزاد می‌شود.
        return refused("RESERVE_FAILED");
      }
    },
    limits(model: string) {
      try {
        return cfg.gateway.limits(model);
      } catch {
        return null;
      }
    },
  });
  return { ok: true, value: gateway };
}

