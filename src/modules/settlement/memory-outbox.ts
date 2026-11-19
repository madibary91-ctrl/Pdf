/**
 * outbox حافظه‌ای (فقط آزمون/توسعه؛ با ریستارت می‌رود). مرجعِ معنایی پورت: هر پیاده‌سازی ماندگار باید همان `outbox-contract.ts` را بگذراند.
 * ساعت ندارد: همهٔ زمان‌ها را فراخواننده می‌دهد. خروجی‌ها کپیِ منجمدند (جداسازی از حالت درونی).
 */
import type { BeginInput, ChargeIntent, CloseIntent, DeadAck, DeadReason, FailureInput, OutboxCounts, OutboxEntry, OutboxResult, ReservationRef, SettlementOutbox } from "./types";
import { outboxError, parseBegin, parseBurial, parseChargeIntent, parseCloseIntent, parseDeadAck, parseDue, parseFailure, parseListDead, parseRef, isCount } from "./validate";

type Mutable = { -readonly [K in keyof OutboxEntry]: OutboxEntry[K] };

const keyOf = (r: ReservationRef): string => `${r.tenantId}\u0000${r.accountId}\u0000${r.reservationId}`;
const isActive = (e: Mutable): boolean => e.state === "open" || e.state === "settling";
const ok = <T>(value: T): OutboxResult<T> => ({ ok: true, value });
const notFound = () => outboxError("NOT_FOUND", "رکورد تسویه پیدا نشد.");
const notActive = () => outboxError("NOT_ACTIVE", "رکورد تسویه نهایی شده است.");
const conflict = (message: string) => outboxError("CONFLICT", message);

function view(e: Mutable): OutboxEntry {
  return Object.freeze({ ...e, charge: e.charge === null ? null : Object.freeze({ ...e.charge }), close: e.close === null ? null : Object.freeze({ ...e.close }) });
}

const byDue = (a: Mutable, b: Mutable): number => a.dueAtMs - b.dueAtMs || (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);
const byDeath = (a: Mutable, b: Mutable): number => (a.settledAtMs ?? 0) - (b.settledAtMs ?? 0) || (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);

export function createMemoryOutbox(): SettlementOutbox {
  const rows = new Map<string, Mutable>();
  /** تأییدهای رسیدگی (نوشتن‌یک‌بار؛ زمانِ اولین تأیید). */
  const acks = new Map<string, number>();

  /** هر پرتابِ پیش‌بینی‌نشده به `STORE_FAILURE` تبدیل می‌شود (قرارداد: بی‌پرتاب). */
  const guard = async <T>(fn: () => OutboxResult<T>): Promise<OutboxResult<T>> => {
    try {
      return fn();
    } catch {
      return outboxError("STORE_FAILURE", "ذخیرهٔ outbox در دسترس نیست.");
    }
  };

  /** رکورد فعال را برمی‌دارد یا خطای مناسب. */
  const active = (ref: ReservationRef): { ok: true; value: Mutable } | { ok: false; error: ReturnType<typeof notFound>["error"] } => {
    const e = rows.get(keyOf(ref));
    if (e === undefined) return notFound();
    if (!isActive(e)) return notActive();
    return { ok: true, value: e };
  };

  return Object.freeze({
    begin: (raw: BeginInput) =>
      guard(() => {
        const p = parseBegin(raw);
        if (!p.ok) return p;
        const b = p.value;
        const cur = rows.get(keyOf(b));
        if (cur === undefined) {
          rows.set(keyOf(b), { ...b, state: "open", charge: null, close: null, attempts: 0, lastErrorCode: null, deadReason: null, settledAtMs: null });
          return ok({ replayed: false });
        }
        const same = cur.unit === b.unit && cur.reserved === b.reserved && cur.expiresAtMs === b.expiresAtMs && cur.orphanRemainder === b.orphanRemainder;
        return same ? ok({ replayed: true }) : conflict("رکورد تسویه با محتوای دیگری پیش‌تر آغاز شده است.");
      }),

    recordCharge: (ref: ReservationRef, intent: ChargeIntent) =>
      guard(() => {
        const r = parseRef(ref);
        const i = parseChargeIntent(intent);
        if (!r.ok) return r;
        if (!i.ok) return i;
        const a = active(r.value);
        if (!a.ok) return a;
        const e = a.value;
        if (e.close !== null) return conflict("پس از قصدِ بستن، قصدِ مصرف ممنوع است.");
        if (e.charge !== null) return e.charge.attemptId === i.value.attemptId && e.charge.amount === i.value.amount ? ok({ replayed: true }) : conflict("قصدِ مصرفِ دیگری پیش‌تر ثبت شده است.");
        e.charge = i.value;
        e.state = "settling";
        return ok({ replayed: false });
      }),

    recordClose: (ref: ReservationRef, intent: CloseIntent) =>
      guard(() => {
        const r = parseRef(ref);
        const i = parseCloseIntent(intent);
        if (!r.ok) return r;
        if (!i.ok) return i;
        const a = active(r.value);
        if (!a.ok) return a;
        const e = a.value;
        if (e.close !== null) return e.close.remainder === i.value.remainder ? ok({ replayed: true }) : conflict("قصدِ بستنِ دیگری پیش‌تر ثبت شده است.");
        e.close = i.value;
        e.state = "settling";
        return ok({ replayed: false });
      }),

    resolveClose: (ref: ReservationRef) =>
      guard(() => {
        const r = parseRef(ref);
        if (!r.ok) return r;
        const a = active(r.value);
        if (!a.ok) return a;
        const e = a.value;
        if (e.close === null) {
          e.close = Object.freeze({ remainder: e.charge === null ? e.orphanRemainder : "release", origin: "sweeper" } as const);
          e.state = "settling";
        }
        return ok(view(e));
      }),

    finish: (ref: ReservationRef, atMs: number) =>
      guard(() => {
        const r = parseRef(ref);
        if (!r.ok) return r;
        if (!isCount(atMs)) return outboxError("INVALID_INPUT", "ورودی outbox نامعتبر است.");
        const e = rows.get(keyOf(r.value));
        if (e === undefined) return notFound();
        if (e.state === "done") return ok({ replayed: true });
        if (e.state === "dead") return notActive();
        if (e.close === null) return conflict("پایان بدون قصدِ بستن ممکن نیست.");
        e.state = "done";
        e.settledAtMs = atMs;
        return ok({ replayed: false });
      }),

    recordFailure: (ref: ReservationRef, failure: FailureInput) =>
      guard(() => {
        const r = parseRef(ref);
        const f = parseFailure(failure);
        if (!r.ok) return r;
        if (!f.ok) return f;
        const a = active(r.value);
        if (!a.ok) return a;
        const want = f.value;
        const expected = want.expectedAttempts;
        if (expected !== undefined) {
          // compare-and-set (ADR-0028): کسِ دیگری پیش افتاده ⇒ بی‌نوشتن؛ شمارندهٔ «آینده» ⇒ خطای منطقی.
          if (a.value.attempts > expected) return ok({ attempts: a.value.attempts, replayed: true });
          if (a.value.attempts < expected) return conflict("شمارندهٔ تلاشِ مورد انتظار از شمارندهٔ رکورد بیشتر است.");
        }
        a.value.attempts += 1;
        a.value.lastErrorCode = want.errorCode;
        a.value.dueAtMs = want.dueAtMs;
        return ok(expected === undefined ? { attempts: a.value.attempts } : { attempts: a.value.attempts, replayed: false });
      }),

    bury: (ref: ReservationRef, burial: Readonly<{ reason: DeadReason; errorCode: string | null; atMs: number }>) =>
      guard(() => {
        const r = parseRef(ref);
        const b = parseBurial(burial);
        if (!r.ok) return r;
        if (!b.ok) return b;
        const e = rows.get(keyOf(r.value));
        if (e === undefined) return notFound();
        if (e.state === "done") return notActive();
        if (e.state === "dead") return e.deadReason === b.value.reason ? ok({ replayed: true }) : conflict("رکورد با دلیل دیگری پیش‌تر مرده است.");
        e.state = "dead";
        e.deadReason = b.value.reason;
        e.lastErrorCode = b.value.errorCode;
        e.settledAtMs = b.value.atMs;
        return ok({ replayed: false });
      }),

    get: (ref: ReservationRef) =>
      guard(() => {
        const r = parseRef(ref);
        if (!r.ok) return r;
        const e = rows.get(keyOf(r.value));
        return ok(e === undefined ? null : view(e));
      }),

    listDue: (query) =>
      guard(() => {
        const q = parseDue(query);
        if (!q.ok) return q;
        const due = [...rows.values()].filter((e) => isActive(e) && e.dueAtMs <= q.value.nowMs).sort(byDue);
        return ok(Object.freeze(due.slice(0, q.value.limit).map(view)));
      }),

    listDead: (query) =>
      guard(() => {
        const l = parseListDead(query);
        if (!l.ok) return l;
        const dead = [...rows.values()].filter((e) => e.state === "dead").sort(byDeath);
        return ok(Object.freeze(dead.slice(0, l.value).map(view)));
      }),

    listUnacknowledgedDead: (query) =>
      guard(() => {
        const l = parseListDead(query);
        if (!l.ok) return l;
        const dead = [...rows.values()].filter((e) => e.state === "dead" && !acks.has(keyOf(e))).sort(byDeath);
        return ok(Object.freeze(dead.slice(0, l.value).map(view)));
      }),

    acknowledgeDead: (ref: ReservationRef, ack: DeadAck) =>
      guard(() => {
        const r = parseRef(ref);
        const a = parseDeadAck(ack);
        if (!r.ok) return r;
        if (!a.ok) return a;
        const e = rows.get(keyOf(r.value));
        if (e === undefined) return notFound();
        if (e.state !== "dead") return conflict("فقط رکوردِ مرده تأیید رسیدگی می‌شود.");
        if (acks.has(keyOf(e))) return ok({ replayed: true });
        acks.set(keyOf(e), a.value.atMs);
        return ok({ replayed: false });
      }),

    counts: () =>
      guard(() => {
        const c = { open: 0, settling: 0, done: 0, dead: 0 };
        for (const e of rows.values()) c[e.state] += 1;
        return ok(Object.freeze(c) as OutboxCounts);
      }),
  });
}
