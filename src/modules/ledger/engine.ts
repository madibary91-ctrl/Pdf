/**
 * ledger — موتور خالص حالت (ADR-0018). `applyCommand(حالت فعلی, فرمان معتبر, زمان)` ← `{ رسید، حالت تازه، ورودی‌های ژورنال }`.
 * بی‌I/O، بی‌ساعت، بی‌تصادف، بی‌پرتاب؛ ورودیِ `current` هرگز دست نمی‌خورد (کپی عمیق). مرز اعتبارسنجی: `parseCommand` (validate.ts).
 */
import type {
  AccountState,
  Balance,
  ChargeCommand,
  CloseCommand,
  Command,
  GrantCommand,
  JournalEntry,
  LedgerError,
  OpenAccountCommand,
  Receipt,
  RefundCommand,
  ReserveCommand,
  Reservation,
} from "./types";
import { LIMITS, fail } from "./validate";

export type EngineOutcome =
  | Readonly<{ ok: true; receipt: Receipt; replayed: boolean; state: AccountState; entries: readonly JournalEntry[]; changed: boolean }>
  | Readonly<{ ok: false; error: LedgerError; state: AccountState | null; entries: readonly JournalEntry[]; changed: boolean }>;

function get<T>(rec: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(rec, key) ? rec[key] : undefined;
}

/** جمعِ ایمن؛ سرریز ⇒ `null`. */
function add(a: number, b: number): number | null {
  const s = a + b;
  return Number.isSafeInteger(s) ? s : null;
}

function idemKey(cmd: Exclude<Command, OpenAccountCommand>): string {
  switch (cmd.kind) {
    case "grant":
      return `grant:${cmd.grantId}`;
    case "reserve":
      return `reserve:${cmd.reservationId}`;
    case "charge":
      return `charge:${cmd.reservationId}/${cmd.attemptId}`;
    case "close":
      return `close:${cmd.reservationId}`;
    case "refund":
      return `refund:${cmd.refundId}`;
  }
}

/** اثر انگشتِ محتوای فرمان (بدون زمان و بدون مستأجر/حساب که بخشی از کلید ذخیره‌اند). */
function fingerprint(cmd: Exclude<Command, OpenAccountCommand>): string {
  switch (cmd.kind) {
    case "grant":
      return JSON.stringify(["grant", cmd.unit, cmd.amount, cmd.source]);
    case "reserve":
      return JSON.stringify(["reserve", cmd.unit, cmd.amount, cmd.ttlMs]);
    case "charge":
      return JSON.stringify(["charge", cmd.unit, cmd.amount]);
    case "close":
      return JSON.stringify(["close", cmd.remainder]);
    case "refund":
      return JSON.stringify(["refund", cmd.reservationId, cmd.attemptId, cmd.unit, cmd.amount]);
  }
}

function reject(state: AccountState | null, entries: readonly JournalEntry[], error: { ok: false; error: LedgerError }): EngineOutcome {
  return { ok: false, error: error.error, state, entries, changed: entries.length > 0 };
}

function push(s: AccountState, entries: JournalEntry[], at: number, e: Pick<JournalEntry, "type" | "amount"> & Partial<Pick<JournalEntry, "shortfall" | "reservationId" | "attemptId" | "refId">>): void {
  s.seq += 1;
  entries.push(
    Object.freeze({
      seq: s.seq,
      atMs: at,
      type: e.type,
      amount: e.amount,
      shortfall: e.shortfall ?? 0,
      reservationId: e.reservationId ?? null,
      attemptId: e.attemptId ?? null,
      refId: e.refId ?? null,
      availableAfter: s.available,
      heldAfter: s.held,
    }),
  );
}

/** رزروهای با سررسید ≤ `at` را (به ترتیب سررسید، سپس شناسه) آزاد می‌کند؛ هرگز مصرف نمی‌کند. */
function expireDue(s: AccountState, at: number, entries: JournalEntry[]): void {
  const due = Object.values(s.reservations)
    .filter((r) => r.status === "open" && r.expiresAtMs <= at)
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const r of due) {
    const amount = r.remaining;
    s.available += amount;
    s.held -= amount;
    r.status = "closed";
    r.closedBy = "expiry";
    r.closedAmount = amount;
    r.remaining = 0;
    r.closedAtMs = at;
    push(s, entries, at, { type: "expire", amount, reservationId: r.id });
  }
}

function openCount(s: AccountState): number {
  let n = 0;
  for (const r of Object.values(s.reservations)) if (r.status === "open") n += 1;
  return n;
}

function emptyState(cmd: OpenAccountCommand, at: number): AccountState {
  return {
    tenantId: cmd.tenantId,
    accountId: cmd.accountId,
    unit: cmd.unit,
    createdAtMs: at,
    lastAtMs: at,
    seq: 0,
    available: 0,
    held: 0,
    totals: { granted: 0, charged: 0, forfeited: 0, refunded: 0, shortfall: 0 },
    reservations: {},
    processed: {},
  };
}

function open(current: AccountState | null, cmd: OpenAccountCommand, at: number): EngineOutcome {
  const receipt: Receipt = Object.freeze({ kind: "open", accountId: cmd.accountId, unit: cmd.unit });
  if (current !== null) {
    if (current.unit !== cmd.unit) return reject(current, [], fail("IDEMPOTENCY_CONFLICT", "حساب پیش‌تر با واحد دیگری باز شده است."));
    return { ok: true, receipt, replayed: true, state: structuredClone(current), entries: [], changed: false };
  }
  return { ok: true, receipt, replayed: false, state: emptyState(cmd, at), entries: [], changed: true };
}

type Step = Readonly<{ ok: true; receipt: Receipt }> | Readonly<{ ok: false; err: { ok: false; error: LedgerError } }>;
const stepErr = (code: LedgerError["code"], message: string): Step => ({ ok: false, err: fail(code, message) });

function grant(s: AccountState, cmd: GrantCommand, at: number, entries: JournalEntry[]): Step {
  const available = add(s.available, cmd.amount);
  const granted = add(s.totals.granted, cmd.amount);
  if (available === null || granted === null) return stepErr("OVERFLOW", "جمع اعتبار از حد عدد صحیح ایمن می‌گذرد.");
  s.available = available;
  s.totals.granted = granted;
  push(s, entries, at, { type: "grant", amount: cmd.amount, refId: cmd.grantId });
  return { ok: true, receipt: Object.freeze({ kind: "grant", grantId: cmd.grantId, amount: cmd.amount, availableAfter: s.available }) };
}

function reserve(s: AccountState, cmd: ReserveCommand, at: number, entries: JournalEntry[]): Step {
  if (get(s.reservations, cmd.reservationId) !== undefined) return stepErr("INTERNAL_ERROR", "حالت حساب ناسازگار است (رزرو بی‌کلید یکتایی).");
  if (openCount(s) >= LIMITS.MAX_OPEN_RESERVATIONS) return stepErr("TOO_MANY_OPEN_RESERVATIONS", "شمار رزروهای باز به سقف رسیده است.");
  if (cmd.amount > s.available) return stepErr("INSUFFICIENT_CREDIT", "اعتبار قابل‌استفاده کافی نیست.");
  const expiresAtMs = add(at, cmd.ttlMs);
  if (expiresAtMs === null) return stepErr("OVERFLOW", "زمان سررسید از حد عدد صحیح ایمن می‌گذرد.");
  s.available -= cmd.amount;
  s.held += cmd.amount;
  s.reservations[cmd.reservationId] = {
    id: cmd.reservationId,
    amount: cmd.amount,
    remaining: cmd.amount,
    charged: 0,
    status: "open",
    closedBy: null,
    closedAmount: 0,
    createdAtMs: at,
    expiresAtMs,
    closedAtMs: null,
    attempts: {},
  };
  push(s, entries, at, { type: "reserve", amount: cmd.amount, reservationId: cmd.reservationId });
  return { ok: true, receipt: Object.freeze({ kind: "reserve", reservationId: cmd.reservationId, amount: cmd.amount, expiresAtMs, availableAfter: s.available, heldAfter: s.held }) };
}

function closedError(r: Reservation): Step {
  return r.closedBy === "expiry" ? stepErr("RESERVATION_EXPIRED", "رزرو منقضی شده است.") : stepErr("RESERVATION_CLOSED", "رزرو بسته شده است.");
}

function charge(s: AccountState, cmd: ChargeCommand, at: number, entries: JournalEntry[]): Step {
  const r = get(s.reservations, cmd.reservationId);
  if (r === undefined) return stepErr("RESERVATION_NOT_FOUND", "رزرو پیدا نشد.");
  if (r.status !== "open") return closedError(r);
  if (get(r.attempts, cmd.attemptId) !== undefined) return stepErr("INTERNAL_ERROR", "حالت حساب ناسازگار است (تلاش بی‌کلید یکتایی).");
  if (Object.keys(r.attempts).length >= LIMITS.MAX_ATTEMPTS_PER_RESERVATION) return stepErr("TOO_MANY_ATTEMPTS", "شمار تلاش‌های این رزرو به سقف رسیده است.");
  const charged = Math.min(cmd.amount, r.remaining);
  const shortfall = cmd.amount - charged;
  const totalCharged = add(s.totals.charged, charged);
  const totalShortfall = add(s.totals.shortfall, shortfall);
  if (totalCharged === null || totalShortfall === null) return stepErr("OVERFLOW", "جمع مصرف از حد عدد صحیح ایمن می‌گذرد.");
  r.remaining -= charged;
  r.charged += charged; // ≤ r.amount (charged ≤ remaining)؛ سرریزِ ناممکن است و نگهبانِ جدا کدِ مرده بود
  s.held -= charged;
  s.totals.charged = totalCharged;
  s.totals.shortfall = totalShortfall;
  r.attempts[cmd.attemptId] = { requested: cmd.amount, charged, shortfall, refunded: 0 };
  push(s, entries, at, { type: "charge", amount: charged, shortfall, reservationId: r.id, attemptId: cmd.attemptId });
  return { ok: true, receipt: Object.freeze({ kind: "charge", reservationId: r.id, attemptId: cmd.attemptId, requested: cmd.amount, charged, shortfall, remainingHold: r.remaining }) };
}

function close(s: AccountState, cmd: CloseCommand, at: number, entries: JournalEntry[]): Step & { replayed?: boolean } {
  const r = get(s.reservations, cmd.reservationId);
  if (r === undefined) return stepErr("RESERVATION_NOT_FOUND", "رزرو پیدا نشد.");
  if (r.status === "closed") {
    // تنها مسیرِ رسیدن به اینجا: رزرو را انقضا بسته است (بستن‌های صریح با کلید یکتایی پیش‌تر بازتکرار/تعارض شده‌اند).
    if (r.closedBy !== "expiry") return stepErr("INTERNAL_ERROR", "حالت حساب ناسازگار است (رزرو بستهٔ بی‌کلید یکتایی).");
    if (cmd.remainder === "forfeit") return stepErr("RESERVATION_EXPIRED", "رزرو منقضی و آزاد شده است؛ مصرفِ باقیمانده ممکن نیست.");
    // `replayed: true` فقط وقتی که این فراخوانی هیچ اثری نداشته باشد؛ اگر انقضا همین‌جا اتفاق افتاده، اثر داشته و بازتکرار نیست.
    const expiredNow = entries.some((e) => e.type === "expire" && e.reservationId === r.id);
    return { ok: true, replayed: !expiredNow, receipt: Object.freeze({ kind: "close", reservationId: r.id, remainder: "release", released: r.closedAmount, forfeited: 0 }) };
  }
  const amount = r.remaining;
  if (cmd.remainder === "release") {
    s.available += amount;
    s.held -= amount;
  } else {
    const forfeited = add(s.totals.forfeited, amount);
    if (forfeited === null) return stepErr("OVERFLOW", "جمع مصرف از حد عدد صحیح ایمن می‌گذرد.");
    s.held -= amount;
    s.totals.forfeited = forfeited;
  }
  r.status = "closed";
  r.closedBy = cmd.remainder;
  r.closedAmount = amount;
  r.remaining = 0;
  r.closedAtMs = at;
  push(s, entries, at, { type: cmd.remainder, amount, reservationId: r.id });
  return {
    ok: true,
    receipt: Object.freeze({ kind: "close", reservationId: r.id, remainder: cmd.remainder, released: cmd.remainder === "release" ? amount : 0, forfeited: cmd.remainder === "forfeit" ? amount : 0 }),
  };
}

function refund(s: AccountState, cmd: RefundCommand, at: number, entries: JournalEntry[]): Step {
  const r = get(s.reservations, cmd.reservationId);
  if (r === undefined) return stepErr("RESERVATION_NOT_FOUND", "رزرو پیدا نشد.");
  const a = get(r.attempts, cmd.attemptId);
  if (a === undefined) return stepErr("CHARGE_NOT_FOUND", "مصرفِ این تلاش پیدا نشد.");
  if (cmd.amount > a.charged - a.refunded) return stepErr("REFUND_EXCEEDS_CHARGE", "مبلغ بازگشت از مصرفِ بازگشت‌نشدهٔ این تلاش بیشتر است.");
  const available = add(s.available, cmd.amount);
  const refunded = add(s.totals.refunded, cmd.amount);
  if (available === null || refunded === null) return stepErr("OVERFLOW", "جمع اعتبار از حد عدد صحیح ایمن می‌گذرد.");
  s.available = available;
  s.totals.refunded = refunded;
  a.refunded += cmd.amount;
  push(s, entries, at, { type: "refund", amount: cmd.amount, reservationId: r.id, attemptId: cmd.attemptId, refId: cmd.refundId });
  return { ok: true, receipt: Object.freeze({ kind: "refund", refundId: cmd.refundId, reservationId: r.id, attemptId: cmd.attemptId, amount: cmd.amount, availableAfter: s.available }) };
}

function run(current: AccountState | null, cmd: Command, atMs: number): EngineOutcome {
  if (!Number.isSafeInteger(atMs) || atMs < 0) return reject(current, [], fail("INTERNAL_ERROR", "زمان نامعتبر است."));
  if (cmd.kind === "open") return open(current, cmd, atMs);
  if (current === null || current.tenantId !== cmd.tenantId || current.accountId !== cmd.accountId) {
    return reject(null, [], fail("ACCOUNT_NOT_FOUND", "حساب پیدا نشد."));
  }

  const key = idemKey(cmd);
  const fp = fingerprint(cmd);
  const prior = get(current.processed, key);
  if (prior !== undefined) {
    if (prior.fingerprint !== fp) return reject(current, [], fail("IDEMPOTENCY_CONFLICT", "این شناسهٔ عملیات پیش‌تر با محتوای دیگری به‌کار رفته است."));
    return { ok: true, receipt: structuredClone(prior.receipt), replayed: true, state: structuredClone(current), entries: [], changed: false };
  }
  if ("unit" in cmd && cmd.unit !== current.unit) return reject(current, [], fail("UNIT_MISMATCH", "واحد با واحد حساب یکی نیست."));

  const s = structuredClone(current);
  const at = Math.max(atMs, s.lastAtMs);
  const entries: JournalEntry[] = [];
  expireDue(s, at, entries);

  let step: Step & { replayed?: boolean };
  switch (cmd.kind) {
    case "grant":
      step = grant(s, cmd, at, entries);
      break;
    case "reserve":
      step = reserve(s, cmd, at, entries);
      break;
    case "charge":
      step = charge(s, cmd, at, entries);
      break;
    case "close":
      step = close(s, cmd, at, entries);
      break;
    case "refund":
      step = refund(s, cmd, at, entries);
      break;
  }

  if (!step.ok) {
    // انقضای تنبل حتی با شکستِ خودِ فرمان ماندگار می‌شود (ولی خطا هرگز کلید یکتایی نمی‌سازد).
    if (entries.length > 0) s.lastAtMs = at;
    return reject(entries.length > 0 ? s : current, entries, step.err);
  }
  s.lastAtMs = at;
  // بازتکرار یک no-op محض است (قرارداد: `replayed ⇒ changed = false`)؛ انقضای تنبلِ تعیین‌پذیر را فرمان بعدی ماندگار می‌کند.
  if (step.replayed === true) return { ok: true, receipt: step.receipt, replayed: true, state: structuredClone(current), entries: [], changed: false };
  s.processed[key] = { fingerprint: fp, receipt: structuredClone(step.receipt) };
  return { ok: true, receipt: step.receipt, replayed: false, state: s, entries, changed: true };
}

export function applyCommand(current: AccountState | null, cmd: Command, atMs: number): EngineOutcome {
  try {
    return run(current, cmd, atMs);
  } catch {
    return reject(current, [], fail("INTERNAL_ERROR", "خطای داخلی در موتور دفتر."));
  }
}

/** نمای موجودی در لحظهٔ `atMs` با انقضای محاسبه‌شده ولی ماندگارنشده. `null` اگر حساب نیست. */
export function viewAt(current: AccountState | null, atMs: number): Balance | null {
  if (current === null) return null;
  const s = structuredClone(current);
  const at = Math.max(atMs, s.lastAtMs);
  expireDue(s, at, []);
  return Object.freeze({
    unit: s.unit,
    available: s.available,
    held: s.held,
    openReservations: openCount(s),
    totals: Object.freeze({ ...s.totals }),
    asOfMs: at,
  });
}
