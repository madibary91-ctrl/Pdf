/**
 * دروازهٔ ابزارِ اندازه‌گیرشده (ADR-0062). هر `completeStep`: درخواست را یک‌بار عکس می‌گیرد ← بدترین‌هزینه را روی همهٔ بخش‌های ارسالی رزرو
 * می‌کند ← (فقط اگر رزرو تازه بود) دروازهٔ درونی را صدا می‌زند ← هزینهٔ واقعی را مصرف و باقیمانده را آزاد یا صریحاً سوخت می‌کند.
 * هرگز نمی‌پرتابد. ساعت و تصادف ندارد؛ شناسه‌ها قطعی‌اند.
 */
import { encodeTools, REQUEST_LIMITS, TOOL_STEP_LIMITS } from "@/modules/ai-gateway";
import type { LedgerErrorCode, LedgerResult } from "@/modules/ledger";
import type { MeteringAlarm, MeteringOutcome, MeteringReceipt, RefusalCode } from "@/modules/metering";
import { resolveToolMeteringConfig } from "./config";
import { estimateStep } from "./estimate";
import { observeStep } from "./observe";
import { makeReceipt, settleStep } from "./settle";
import type { MeterSummary, MeteredStepResult, MeteredToolGateway, MeteredToolGatewayResult } from "./types";

/** سقفِ رسیدهای نگه‌داشته‌شده در حافظه (جمع‌ها همیشه کامل‌اند). */
export const MAX_RECEIPTS = 256;

const REFUSAL_MESSAGES: Readonly<Record<RefusalCode, string>> = {
  INVALID_REQUEST: "درخواست برای اندازه‌گیری مصرف نامعتبر است؛ تماسی انجام نشد.",
  UNKNOWN_MODEL: "مدل برای اندازه‌گیری مصرف شناخته‌شده نیست؛ تماسی انجام نشد.",
  UNPRICED_MODEL: "مدلِ بی‌قیمت را نمی‌توان اندازه‌گیری کرد (سقف هزینه‌اش نامعلوم است)؛ تماسی انجام نشد.",
  CURRENCY_MISMATCH: "ارز مدل با واحد حساب هم‌خوان نیست؛ تماسی انجام نشد.",
  ESTIMATE_OVERFLOW: "برآورد بدترین هزینه از حد ایمن گذشت؛ تماسی انجام نشد.",
  INSUFFICIENT_CREDIT: "اعتبار برای بدترین هزینهٔ این گام کافی نیست؛ تماسی انجام نشد.",
  ACCOUNT_NOT_FOUND: "حساب اعتبار یافت نشد؛ تماسی انجام نشد.",
  TOO_MANY_OPEN_RESERVATIONS: "شمار رزروهای باز از حد گذشت؛ تماسی انجام نشد.",
  SCOPE_REUSED: "این شناسهٔ دامنه پیشتر استفاده شده؛ تماسی انجام نشد.",
  RESERVE_FAILED: "رزرو اعتبار ناموفق بود؛ تماسی انجام نشد.",
};
const OUTCOMES: readonly MeteringOutcome[] = ["billed", "released", "forfeited", "refused", "unbilled", "settlement-failed"];
const ATTENTION_OUTCOMES: ReadonlySet<MeteringOutcome> = new Set(["forfeited", "unbilled", "settlement-failed"]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sat = (a: number, b: number): { v: number; over: boolean } => {
  const s = a + b;
  return Number.isSafeInteger(s) ? { v: s, over: false } : { v: Number.MAX_SAFE_INTEGER, over: true };
};

type Snapshot = Readonly<{ request: Record<string, unknown>; model: string; contents: readonly string[]; maxOutputTokens: unknown }>;

/** عکسِ یک‌بارخوانیِ درخواست (JSON رفت‌وبرگشتی): همان چیزی که برآورد می‌شود، عیناً به دروازه می‌رسد (بستنِ TOCTOU با getter/Proxy). */
function snapshot(input: unknown, formatOf: (model: string) => unknown): Snapshot | null {
  try {
    if (!isRecord(input)) return null;
    const text = JSON.stringify(input);
    if (typeof text !== "string") return null;
    const req: unknown = JSON.parse(text);
    if (!isRecord(req) || typeof req["model"] !== "string") return null;
    const messages = req["messages"];
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > REQUEST_LIMITS.maxMessages) return null;
    const contents: string[] = [];
    for (const m of messages as unknown[]) {
      if (!isRecord(m) || typeof m["content"] !== "string" || m["content"].length > REQUEST_LIMITS.maxMessageChars) return null;
      contents.push(m["content"]);
    }
    const format = formatOf(req["model"]);
    if (format === null || format === undefined) return null;
    const opts: Record<string, unknown> = {};
    if (req["toolChoice"] !== undefined) opts["choice"] = req["toolChoice"];
    if (req["allowParallel"] !== undefined) opts["allowParallel"] = req["allowParallel"];
    const enc = encodeTools(format, req["tools"], opts);
    if (!enc.ok) return null;
    contents.push(JSON.stringify(enc.value));
    const cont = req["continuation"];
    if (cont !== undefined) {
      if (!Array.isArray(cont) || cont.length > TOOL_STEP_LIMITS.maxContinuationMessages) return null;
      const total = JSON.stringify(cont);
      if (total.length > TOOL_STEP_LIMITS.maxContinuationChars) return null;
      for (const c of cont as unknown[]) contents.push(JSON.stringify(c));
    }
    return { request: req, model: req["model"], contents, maxOutputTokens: req["maxOutputTokens"] };
  } catch {
    return null;
  }
}

export function createMeteredToolGateway(raw: unknown): MeteredToolGatewayResult {
  const resolved = resolveToolMeteringConfig(raw);
  if (!resolved.ok) return resolved;
  const cfg = resolved.value;
  const specs = new Map([...cfg.models].map(([k, v]) => [k, v] as const));
  let counter = 0;

  const receipts: MeteringReceipt[] = [];
  let calls = 0;
  let reservedTotal = 0;
  let chargedTotal = 0;
  let shortfallTotal = 0;
  let overflowed = false;
  const outcomeCounts: Record<MeteringOutcome, number> = { billed: 0, released: 0, forfeited: 0, refused: 0, unbilled: 0, "settlement-failed": 0 };
  const alarmSet = new Set<MeteringAlarm>();
  let attention = false;

  function record(r: MeteringReceipt): void {
    calls += 1;
    outcomeCounts[r.outcome] += 1;
    for (const a of r.alarms) alarmSet.add(a);
    if (r.alarms.length > 0 || ATTENTION_OUTCOMES.has(r.outcome)) attention = true;
    const a = sat(reservedTotal, r.reserved);
    const b = sat(chargedTotal, r.charged);
    const c = sat(shortfallTotal, r.shortfall);
    reservedTotal = a.v;
    chargedTotal = b.v;
    shortfallTotal = c.v;
    if (a.over || b.over || c.over) overflowed = true;
    if (receipts.length < MAX_RECEIPTS) receipts.push(r);
  }

  const refused = (code: RefusalCode, ledgerCode?: LedgerErrorCode): MeteredStepResult => {
    const metering = makeReceipt(cfg.unit, { outcome: "refused", reservationId: null, reserved: 0, charged: 0, shortfall: 0, refusal: ledgerCode === undefined ? { code } : { code, ledgerCode } });
    record(metering);
    return Object.freeze({ ok: false as const, error: Object.freeze({ code: "INTERNAL_ERROR" as const, message: REFUSAL_MESSAGES[code], retryable: false, warnings: Object.freeze([]), usage: null, cost: null, metering }) });
  };
  const attach = (result: unknown, metering: MeteringReceipt): MeteredStepResult => {
    record(metering);
    if (isRecord(result) && result["ok"] === true && isRecord(result["value"])) return Object.freeze({ ok: true as const, value: Object.freeze({ ...(result["value"] as object), metering }) as never });
    if (isRecord(result) && result["ok"] === false && isRecord(result["error"])) return Object.freeze({ ok: false as const, error: Object.freeze({ ...(result["error"] as object), metering }) as never });
    return Object.freeze({ ok: false as const, error: Object.freeze({ code: "INTERNAL_ERROR" as const, message: "دروازهٔ درونی نتیجهٔ معتبر نداد.", retryable: false, warnings: Object.freeze([]), usage: null, cost: null, metering }) });
  };

  async function run(n: number, input: unknown, options: Readonly<{ signal?: AbortSignal }> | undefined): Promise<MeteredStepResult> {
    const snap = snapshot(input, (m) => cfg.gateway.toolFormat(m));
    if (snap === null) return refused("INVALID_REQUEST");
    const est = estimateStep({ model: snap.model, contents: snap.contents, maxOutputTokens: snap.maxOutputTokens, models: specs, currency: cfg.currency, perMessageOverheadTokens: cfg.perMessageOverheadTokens });
    if (!est.ok) return refused(est.code);

    const reservationId = `${cfg.scopeId}.r${n}`;
    let reserved: LedgerResult<{ amount: number; replayed: boolean }>;
    try {
      reserved = await cfg.ledger.reserve({ ...cfg.account, reservationId, unit: cfg.unit, amount: est.amount, ttlMs: cfg.reservationTtlMs });
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

    let result: unknown = null;
    try {
      result = await cfg.gateway.completeStep(snap.request, options);
    } catch {
      result = null;
    }
    return attach(result, await settleStep(cfg, reservationId, reserved.value.amount, observeStep(result, cfg.currency)));
  }

  const summary = (): MeterSummary =>
    Object.freeze({
      calls,
      reserved: reservedTotal,
      charged: chargedTotal,
      shortfall: shortfallTotal,
      outcomes: Object.freeze(Object.fromEntries(OUTCOMES.map((o) => [o, outcomeCounts[o]])) as Record<MeteringOutcome, number>),
      alarms: Object.freeze([...alarmSet].sort()),
      needsAttention: attention || overflowed,
      receiptsTruncated: calls > receipts.length,
    });

  const gateway: MeteredToolGateway = Object.freeze({
    async completeStep(input: unknown, options?: Readonly<{ signal?: AbortSignal }>): Promise<MeteredStepResult> {
      const n = ++counter; // همگام و پیش از هر await: گام‌های هم‌زمان شناسهٔ جدا می‌گیرند.
      try {
        return await run(n, input, options);
      } catch {
        // خطای برنامه‌نویسی (نه پورت‌ها؛ آن‌ها جدا محافظت شده‌اند). نمی‌دانیم کجا بودیم؛ رزروِ احتمالی با سررسید آزاد می‌شود.
        return refused("RESERVE_FAILED");
      }
    },
    toolFormat(model: string) {
      try {
        return cfg.gateway.toolFormat(model) as ReturnType<MeteredToolGateway["toolFormat"]>;
      } catch {
        return null;
      }
    },
    limits(model: string) {
      try {
        return cfg.gateway.limits(model) as ReturnType<MeteredToolGateway["limits"]>;
      } catch {
        return null;
      }
    },
    receipts: () => Object.freeze([...receipts]),
    summary,
  });
  return { ok: true, value: gateway };
}
