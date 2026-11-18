/**
 * ledger — سرویس (ADR-0018): مرز اعتبارسنجی + ساعت + پورت ذخیره بر موتور خالص. هیچ متدی نمی‌پرتابد؛ همه `Result`.
 */
import { applyCommand, viewAt } from "./engine";
import type {
  AccountKey,
  AccountState,
  AccountStore,
  Balance,
  Clock,
  Command,
  CommandKind,
  JournalEntry,
  Ledger,
  LedgerError,
  LedgerResult,
  Receipt,
  ReceiptOf,
  Replayable,
  TransactOutcome,
} from "./types";
import { fail, parseCommand, parseKey } from "./validate";

type Done = LedgerResult<Replayable<Receipt>>;

function readClock(clock: Clock): LedgerResult<number> {
  try {
    const t = clock.nowMs();
    if (!Number.isSafeInteger(t) || t < 0) return fail("INTERNAL_ERROR", "ساعت زمان نامعتبر داد.");
    return { ok: true, value: t };
  } catch {
    return fail("INTERNAL_ERROR", "ساعت پرتاب کرد.");
  }
}

function isFn(v: unknown): boolean {
  return typeof v === "function";
}

export function createLedger(config: unknown): LedgerResult<Ledger> {
  if (typeof config !== "object" || config === null) return fail("INVALID_INPUT", "پیکربندی باید شیء باشد.");
  const { store, clock } = config as { store?: Partial<AccountStore>; clock?: Partial<Clock> };
  if (typeof store !== "object" || store === null || !isFn(store.transact) || !isFn(store.read) || !isFn(store.journal)) {
    return fail("INVALID_INPUT", "«store» باید پورت AccountStore باشد.");
  }
  if (typeof clock !== "object" || clock === null || !isFn(clock.nowMs)) return fail("INVALID_INPUT", "«clock» الزامی است و باید nowMs داشته باشد.");
  const st = store as AccountStore;
  const ck = clock as Clock;

  async function exec(kind: CommandKind, raw: unknown): Promise<Done> {
    const parsed = parseCommand(kind, raw);
    if (!parsed.ok) return parsed;
    const cmd: Command = parsed.value;
    const now = readClock(ck);
    if (!now.ok) return now;
    const key: AccountKey = { tenantId: cmd.tenantId, accountId: cmd.accountId };
    try {
      return await st.transact<Done>(key, (current: AccountState | null): TransactOutcome<Done> => {
        const out = applyCommand(current, cmd, now.value);
        const commit = out.changed && out.state !== null ? { state: out.state, entries: out.entries } : null;
        if (!out.ok) return { commit, value: { ok: false, error: out.error } };
        return { commit, value: { ok: true, value: Object.freeze({ ...out.receipt, replayed: out.replayed }) } };
      });
    } catch {
      return fail("STORE_FAILURE", "ذخیره‌سازی ناموفق بود؛ با همان شناسهٔ عملیات می‌توان دوباره تلاش کرد.");
    }
  }

  async function withKey<T>(raw: unknown, f: (key: AccountKey, now: number) => Promise<LedgerResult<T>>): Promise<LedgerResult<T>> {
    const key = parseKey(raw);
    if (!key.ok) return key;
    const now = readClock(ck);
    if (!now.ok) return now;
    try {
      return await f(key.value, now.value);
    } catch {
      return fail("STORE_FAILURE", "خواندن از ذخیره‌سازی ناموفق بود.");
    }
  }

  /** موتور برای فرمانِ `kind` همیشه رسیدِ همان `kind` می‌دهد (در engine.test.ts قفل شده)؛ این تنها castِ سرویس است. */
  const call =
    <K extends CommandKind>(kind: K) =>
    async (input: unknown): Promise<LedgerResult<Replayable<ReceiptOf<K>>>> =>
      (await exec(kind, input)) as LedgerResult<Replayable<ReceiptOf<K>>>;

  const ledger: Ledger = {
    openAccount: call("open"),
    grant: call("grant"),
    reserve: call("reserve"),
    charge: call("charge"),
    close: call("close"),
    refund: call("refund"),
    balance: (raw: AccountKey): Promise<LedgerResult<Balance>> =>
      withKey(raw, async (key, now): Promise<LedgerResult<Balance>> => {
        const view = viewAt(await st.read(key), now);
        return view === null ? fail("ACCOUNT_NOT_FOUND", "حساب پیدا نشد.") : { ok: true, value: view };
      }),
    journal: (raw: AccountKey): Promise<LedgerResult<readonly JournalEntry[]>> =>
      withKey(raw, async (key): Promise<LedgerResult<readonly JournalEntry[]>> => {
        if ((await st.read(key)) === null) return fail("ACCOUNT_NOT_FOUND", "حساب پیدا نشد.");
        return { ok: true, value: Object.freeze(await st.journal(key)) };
      }),
  };
  return { ok: true, value: Object.freeze(ledger) };
}

export type { LedgerError };
