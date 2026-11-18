/** ابزار مشترک آزمون‌های ledger؛ در محصول import نمی‌شود. */
import { applyCommand } from "./engine";
import type { EngineOutcome } from "./engine";
import { createLedger } from "./ledger";
import { createMemoryStore } from "./memory-store";
import type { AccountState, AccountStore, Clock, Ledger, LedgerResult } from "./types";
import { parseCommand } from "./validate";
import type { CommandKind } from "./types";

export const T = "tenant-a";
export const A = "acct-1";
export const UNIT = "IRR_MICROS";

export type TestClock = Clock & { set(v: number): void; advance(d: number): void };

export function mutableClock(start = 1_000_000): TestClock {
  let t = start;
  return {
    nowMs: () => t,
    set: (v) => {
      t = v;
    },
    advance: (d) => {
      t += d;
    },
  };
}

export function setup(store: AccountStore = createMemoryStore(), clock: TestClock = mutableClock()): { ledger: Ledger; store: AccountStore; clock: TestClock } {
  const r = createLedger({ store, clock });
  if (!r.ok) throw new Error(`createLedger failed: ${r.error.code}`);
  return { ledger: r.value, store, clock };
}

/** نتیجه را باز می‌کند؛ شکست = خطای آزمون با کد. */
export function val<V>(r: LedgerResult<V>): V {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.value;
}

export function code<V>(r: LedgerResult<V>): string {
  return r.ok ? "ok" : r.error.code;
}

export async function openFunded(ledger: Ledger, amount: number, tenantId = T, accountId = A, unit = UNIT): Promise<void> {
  val(await ledger.openAccount({ tenantId, accountId, unit }));
  if (amount > 0) val(await ledger.grant({ tenantId, accountId, grantId: "g-init", unit, amount, source: "purchase" }));
}

/** فرمان خام را مستقیم روی موتور اجرا می‌کند (آزمون‌های خالص). */
export function run(state: AccountState | null, kind: CommandKind, fields: Record<string, unknown>, at: number): EngineOutcome {
  const parsed = parseCommand(kind, { tenantId: T, accountId: A, ...fields });
  if (!parsed.ok) throw new Error(`bad test command: ${parsed.error.message}`);
  return applyCommand(state, parsed.value, at);
}

export function must(out: EngineOutcome): Extract<EngineOutcome, { ok: true }> {
  if (!out.ok) throw new Error(`expected ok, got ${out.error.code}`);
  return out;
}

export function mustState(out: EngineOutcome): AccountState {
  return must(out).state;
}

export function errCode(out: EngineOutcome): string {
  return out.ok ? "ok" : out.error.code;
}

export function deepFreeze<V>(o: V): V {
  if (typeof o === "object" && o !== null && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** حالتِ حسابِ باز با موجودیِ مشخص، ساخته‌شده با خودِ موتور. */
export function fundedState(amount: number, at = 1_000): AccountState {
  let s = mustState(run(null, "open", { unit: UNIT }, at));
  if (amount > 0) s = mustState(run(s, "grant", { grantId: "g0", unit: UNIT, amount, source: "purchase" }, at));
  return s;
}

/** PRNG قطعی (mulberry32) برای تست‌های خاصیتی. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
