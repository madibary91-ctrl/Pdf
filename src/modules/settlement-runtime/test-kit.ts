/**
 * ابزار مشترک آزمون‌های settlement-runtime (از index صادر نمی‌شود؛ ماژول‌ها کمک‌تستِ یکدیگر را import نمی‌کنند).
 * زمان مجازی است: ساعتِ دفتر = ساعتِ زمان‌سنج ⇒ `timer.advance` هم‌زمان زمانِ دفتر و حلقه را جلو می‌برد.
 */
import { checkInvariants, createLedger, createMemoryStore } from "@/modules/ledger";
import type { Clock, Ledger } from "@/modules/ledger";
import { createDurableLedger, createMemoryOutbox } from "@/modules/settlement";
import type { LoopTimer, SettlementOutbox } from "@/modules/settlement";

export const TENANT = "tenant-r";
export const ACCOUNT = "acct-r";
export const KEY = { tenantId: TENANT, accountId: ACCOUNT };
export const UNIT = "IRR_MICROS";
export const GRACE = 10_000;
export const TTL = 60_000;
export const CANARY = "LEAK-CANARY-runtime-5d2f";
/** رشتهٔ اتصالِ ساختگیِ حاویِ رمز (برای آزمونِ نشت)؛ عمداً تکه‌تکه تا اسکنرِ اسرارِ مخزن آن را رمزِ واقعی نبیند. */
export const FAKE_DSN = ["post", "gres://user:", CANARY, "@host/db"].join("");
export const FUNDS = 200_000;
export const WORST = 314;

export async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((res) => setImmediate(res));
}

export type ManualTimer = LoopTimer &
  Readonly<{
    clock: Clock;
    now(): number;
    pending(): number;
    delays: number[];
    cancelled(): number;
    failAfter(n: number): void;
    setNow(t: number): void;
    advance(ms: number): Promise<void>;
  }>;

export function manualTimer(start = 1_000_000): ManualTimer {
  let t = start;
  let seq = 0;
  let cancelled = 0;
  let throwAfter = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const delays: number[] = [];
  const timer = {
    delays,
    clock: { nowMs: () => t } as Clock,
    now: () => t,
    pending: () => queue.size,
    cancelled: () => cancelled,
    failAfter: (n: number) => void (throwAfter = n),
    setNow: (v: number) => void (t = v),
    after(fn: () => void, ms: number): unknown {
      delays.push(ms);
      if (throwAfter > 0) {
        throwAfter -= 1;
        throw new Error(`boom: ${CANARY}-timer`);
      }
      seq += 1;
      queue.set(seq, { at: t + ms, fn });
      return seq;
    },
    cancel(h: unknown): void {
      cancelled += 1;
      queue.delete(h as number);
    },
    async advance(ms: number): Promise<void> {
      const target = t + ms;
      for (let guard = 0; ; guard++) {
        if (guard > 20_000) throw new Error("advance: حلقهٔ بی‌پایان");
        let pick: number | null = null;
        for (const [id, e] of queue) if (e.at <= target && (pick === null || e.at < (queue.get(pick) as { at: number }).at)) pick = id;
        if (pick === null) break;
        const e = queue.get(pick) as { at: number; fn: () => void };
        queue.delete(pick);
        t = Math.max(t, e.at);
        e.fn();
        await flush();
      }
      t = target;
      await flush();
    },
  };
  return timer as unknown as ManualTimer;
}

export function must<T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!r.ok) throw new Error(`انتظار موفقیت بود: ${r.error.code}`);
  return r.value;
}

export type World = Awaited<ReturnType<typeof world>>;

/** دفتر و outbox حافظه‌ای + دفترِ ماندگار (مسیرِ درخواست) روی همان outbox. */
export async function world(opts: { timer?: ManualTimer; outbox?: SettlementOutbox; policy?: "forfeit" | "release" } = {}) {
  const timer = opts.timer ?? manualTimer();
  const store = createMemoryStore();
  const made = createLedger({ store, clock: timer.clock });
  if (!made.ok) throw new Error("createLedger failed");
  const ledger: Ledger = made.value;
  must(await ledger.openAccount({ ...KEY, unit: UNIT }));
  must(await ledger.grant({ ...KEY, grantId: "g0", unit: UNIT, amount: FUNDS, source: "purchase" }));
  const outbox = createMemoryOutbox();
  const used = opts.outbox ?? outbox;
  const d = createDurableLedger({ ledger, outbox: used, clock: timer.clock, graceMs: GRACE, onUnknownCost: opts.policy ?? "forfeit" });
  if (!d.ok) throw new Error(`createDurableLedger failed: ${d.error.issues.join(";")}`);
  return { timer, store, ledger, outbox: used, durable: d.value };
}

export const reserveInput = (id: string, amount = WORST, ttlMs = TTL) => ({ ...KEY, reservationId: id, unit: UNIT, amount, ttlMs });

export async function balance(ledger: Ledger) {
  const b = await ledger.balance(KEY);
  if (!b.ok) throw new Error(`balance failed: ${b.error.code}`);
  return b.value;
}

/** ناوردای پول: بقا و `checkInvariants` روی حالتِ ماندگار. */
export async function audit(store: ReturnType<typeof createMemoryStore>): Promise<void> {
  const state = await store.read(KEY);
  if (state === null) throw new Error("حساب نیست");
  const v = checkInvariants(state);
  if (v.length > 0) throw new Error(`ناوردا شکست: ${v.join("; ")}`);
  const t = state.totals;
  if (state.available + state.held + t.charged + t.forfeited !== t.granted) throw new Error("بقا شکست");
}

export type OutboxPlan = Partial<Record<"claimDue" | "listUnacknowledgedDead" | "acknowledgeDead" | "recordFailure", { fail: number; mode?: "result" | "throw" }>>;

/** پوششِ outbox که ثبتِ فراخوانی می‌کند و برای متدهای نام‌برده شکستِ تزریقی می‌دهد (`fail` فراخوانیِ نخست). */
export function tracedOutbox(real: SettlementOutbox, plan: OutboxPlan = {}) {
  const count: Record<string, number> = {};
  const claims: { nowMs: number; limit: number; leaseMs: number }[] = [];
  const wrapped: Record<string, unknown> = { ...real };
  for (const name of ["claimDue", "listUnacknowledgedDead", "acknowledgeDead", "recordFailure"] as const) {
    wrapped[name] = async (...args: unknown[]) => {
      count[name] = (count[name] ?? 0) + 1;
      if (name === "claimDue") claims.push(args[0] as { nowMs: number; limit: number; leaseMs: number });
      const p = plan[name];
      if (p !== undefined && (count[name] as number) <= p.fail) {
        if (p.mode === "throw") throw new Error(`boom: ${CANARY}-${name}`);
        return { ok: false, error: { code: "STORE_FAILURE", message: CANARY } };
      }
      return (real as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!(...args);
    };
  }
  return Object.assign(wrapped as unknown as SettlementOutbox & { claimDue: (q: unknown) => Promise<unknown> }, { count, claims, plan });
}

/** رزروِ یتیمِ فرایندِ مرده: فقط رزرو (بی‌ثبتِ هزینه) و بی‌هیچ `sweep` دستی. */
export async function orphan(w: World, id: string): Promise<void> {
  must(await w.durable.reserve(reserveInput(id)));
}

/**
 * `graceMs`ِ دودیِ زمانِ واقعی (ساعتِ سیستم + `setTimeout`) در `runtime.pg.test.ts` (ADR-0041).
 * آستانهٔ `degraded` ⇒ ⌊graceMs/2⌋ و فاصلهٔ گذرها ⌊graceMs/4⌋ است؛ «حاشیهٔ تحملِ توقفِ حلقهٔ رویداد» = اختلافِ این دو.
 * با ۱۲۰ms این حاشیه فقط ۳۰ms بود و یک وقفهٔ ۱۰۰–۲۰۰ms (زیرِ بارِ دروازه) سلامت را `degraded/down` می‌کرد؛ با ۱٬۲۰۰ms حاشیه ۳۰۰ms است.
 * هزینه: حدودِ یک ثانیهٔ بیشتر در همان یک آزمون. پایین‌آوردنش را `health-diagnostics.test.ts` قرمز می‌کند.
 */
export const SMOKE_GRACE_MS = 1_200;

const SAFE_UPPER = /^[A-Z][A-Z0-9_]{0,39}$/;
const SAFE_LOWER = /^[a-z]{1,20}$/;
const asRecord = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null);
/** خواندنِ یک کلید که خرابیِ getter/Proxy فقط همان فیلد را `?` می‌کند، نه کلِ خلاصه را. */
const pick = (o: Record<string, unknown> | null, key: string): unknown => {
  try {
    return o === null ? undefined : o[key];
  } catch {
    return undefined;
  }
};
const fmtNum = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? String(v) : "?");
const fmtBool = (v: unknown): string => (v === true ? "true" : v === false ? "false" : "?");
const fmtUpper = (v: unknown): string => (v === null ? "null" : typeof v === "string" && SAFE_UPPER.test(v) ? v : "?");
const fmtLower = (v: unknown): string => (typeof v === "string" && SAFE_LOWER.test(v) ? v : "?");

/**
 * خلاصهٔ تک‌خطیِ «چرا سلامت ok نیست» برای پیامِ شکستِ آزمون‌ها (ADR-0041)؛ علت را از حدس به داده می‌رساند.
 * ناورداها: هرگز نمی‌پرتابد (getter/Proxy/ورودیِ خراب ⇒ `?`)؛ هر متد دقیقاً یک بار خوانده می‌شود (یک عکسِ هم‌زمان)؛
 * فقط فیلدهای فهرستِ سفید با الگوی بسته (کدهای شمارشی و عدد) می‌آیند، هیچ رشتهٔ آزاد/پیام/شناسه نشت نمی‌کند؛ حداکثر ۸ دلیل.
 */
export function healthDiagnostics(rt: { health(): unknown; status(): unknown }): string {
  try {
    let hr: Record<string, unknown> | null = null;
    let st: Record<string, unknown> | null = null;
    try {
      hr = asRecord(rt.health());
    } catch {
      hr = null;
    }
    try {
      st = asRecord(rt.status());
    } catch {
      st = null;
    }
    const h = asRecord(pick(hr, "health"));
    const loop = asRecord(pick(st, "loop"));
    const rawReasons = pick(h, "reasons");
    const reasons = Array.isArray(rawReasons)
      ? `[${rawReasons
          .slice(0, 8)
          .map((r) => {
            const x = asRecord(r);
            return `${fmtUpper(pick(x, "code"))}:${fmtLower(pick(x, "severity"))}`;
          })
          .join(",")}${rawReasons.length > 8 ? ",…" : ""}]`
      : "?";
    const silence = pick(h, "silenceMs");
    return [
      `health=${fmtLower(pick(h, "status"))}`,
      `http=${fmtNum(pick(hr, "httpStatus"))}`,
      `reasons=${reasons}`,
      `silenceMs=${silence === null ? "null" : fmtNum(silence)}`,
      `degradedAfterMs=${fmtNum(pick(h, "degradedAfterMs"))}`,
      `downAfterMs=${fmtNum(pick(h, "downAfterMs"))}`,
      `lastFault=${fmtUpper(pick(h, "lastFault"))}`,
      `runtimeState=${fmtLower(pick(st, "state"))}`,
      `loopState=${fmtLower(pick(loop, "state"))}`,
      `busy=${fmtBool(pick(loop, "busy"))}`,
      `runs=${fmtNum(pick(loop, "runs"))}`,
      `consecutiveFailures=${fmtNum(pick(loop, "consecutiveFailures"))}`,
    ].join(" ");
  } catch {
    return "healthDiagnostics: unreadable";
  }
}
