/**
 * settlement-bootstrap · سقفِ زمانِ سمتِ پایگاهِ خواندنِ پایش (ADR-0045، م۳‑ه‑۴‑الف‑۲‑۴‑آ) — بی‌پایگاهِ واقعی.
 * (۱) تابعِ خالصِ `backlogReadStatementTimeoutMs`: مهلتِ مؤثرِ پایش + فرجهٔ ثابت؛ مهلتِ نامعتبر ⇒ undefined (و `createBacklogWatch` همان را شکست‌بسته رد می‌کند).
 * (۲) سیم‌کشی: `createPgSettlementOutbox` را اسپای می‌کنیم؛ **دقیقاً یک** نمونه (نمونهٔ پایش) `readStatementTimeoutMs` می‌گیرد؛ نمونهٔ رفتگر (runtime) و حالتِ
 * بی‌پایش هرگز. رفتارِ واقعیِ لغو روی PostgreSQL در `backlog.statement-timeout.pg.test.ts` است. فایلِ تازه؛ هیچ آزمونِ موجودی دست نخورده.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgSettlementOutbox } from "@/modules/settlement";
import { SETTLEMENT_BACKLOG_WATCH_DEFAULTS, SETTLEMENT_BACKLOG_WATCH_ENV as E, SETTLEMENT_BACKLOG_WATCH_LIMITS } from "@/modules/settlement-backlog-watch";
import { getSettlementHost } from "@/modules/settlement-host";
import { BACKLOG_STATEMENT_GRACE_MS, backlogReadStatementTimeoutMs, startSettlementBootstrap } from "./bootstrap";
import { ON_ENV, collector, deadDatabase, fakeSignals, manualTimer } from "./test-kit";

vi.mock("@/modules/settlement", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/modules/settlement")>();
  return { ...real, createPgSettlementOutbox: vi.fn(real.createPgSettlementOutbox) };
});

/** حدِ بالای `readStatementTimeoutMs` در آداپتور (قفل‌شده در `settlement/pg/read-timeout.unit.test.ts`)؛ از مسیرِ داخلی import نمی‌شود (قاعدهٔ ۳). */
const ADAPTER_MAX_MS = 7_200_000;
const spy = vi.mocked(createPgSettlementOutbox);
const stores: Record<symbol, unknown>[] = [];
beforeEach(() => spy.mockClear());
afterEach(async () => {
  for (const s of stores.splice(0)) await getSettlementHost(s)?.shutdown();
});

async function boot(env: Record<string, string>) {
  const store: Record<symbol, unknown> = {};
  stores.push(store);
  const db = deadDatabase();
  const outcome = await startSettlementBootstrap({
    env: { ...ON_ENV, ...env },
    store,
    processOwner: "host" as const,
    openDatabase: () => db.opened,
    log: collector().log,
    timer: manualTimer(),
    signals: fakeSignals(),
    exit: () => undefined,
  });
  return outcome;
}
const optionsOf = (call: unknown[]): Record<string, unknown> => (call[1] ?? {}) as Record<string, unknown>;
const withTimeout = () => spy.mock.calls.filter((c) => "readStatementTimeoutMs" in optionsOf(c));

describe("settlement-bootstrap · backlogReadStatementTimeoutMs", () => {
  it("فرجه یک ثانیه است و پیش‌فرضِ مهلتِ پایش ۵ ثانیه ⇒ سقفِ پیش‌فرض ۶ ثانیه", () => {
    expect(BACKLOG_STATEMENT_GRACE_MS).toBe(1_000);
    expect(SETTLEMENT_BACKLOG_WATCH_DEFAULTS.timeoutMs).toBe(5_000);
    expect(backlogReadStatementTimeoutMs({})).toBe(6_000);
  });
  it("مهلتِ صریح: همان + فرجه؛ مرزها", () => {
    expect(backlogReadStatementTimeoutMs({ timeoutMs: 2_000 })).toBe(3_000);
    expect(backlogReadStatementTimeoutMs({ timeoutMs: 1 })).toBe(1_001);
    expect(backlogReadStatementTimeoutMs({ timeoutMs: SETTLEMENT_BACKLOG_WATCH_LIMITS.maxTimeoutMs })).toBe(SETTLEMENT_BACKLOG_WATCH_LIMITS.maxTimeoutMs + 1_000);
  });
  it("هر مهلتِ معتبرِ پایش، سقفی می‌دهد که آداپتور می‌پذیرد (ناوردا: ≤ حدِ بالای آداپتور) و همیشه اکیداً بزرگ‌تر از مهلتِ پایش است", () => {
    for (const t of [1, 2, 999, 1_000, 5_000, 60_000, 3_599_999, SETTLEMENT_BACKLOG_WATCH_LIMITS.maxTimeoutMs]) {
      const v = backlogReadStatementTimeoutMs({ timeoutMs: t });
      expect(v).toBeGreaterThan(t);
      expect(v).toBeLessThanOrEqual(ADAPTER_MAX_MS);
    }
  });
  it.each([[0], [-1], [1.5], [Number.NaN], [Infinity], [SETTLEMENT_BACKLOG_WATCH_LIMITS.maxTimeoutMs + 1], ["5000"], [null], [true], [{}]])("مهلتِ نامعتبر %j ⇒ undefined (بی‌سقف؛ createBacklogWatch آن را رد می‌کند)", (v) => {
    expect(backlogReadStatementTimeoutMs({ timeoutMs: v })).toBeUndefined();
  });
  it("کلیدهای دیگرِ overrides بر سقف اثر ندارند", () => {
    expect(backlogReadStatementTimeoutMs({ intervalMs: 10, downCount: 3 })).toBe(6_000);
  });
});

describe("settlement-bootstrap · سیم‌کشیِ سقفِ سمتِ پایگاه", () => {
  it("بی‌پایش: هیچ نمونه‌ای readStatementTimeoutMs نمی‌گیرد (رفتارِ امروز)", async () => {
    const o = await boot({});
    expect(o.status).toBe("started");
    expect(spy).toHaveBeenCalled(); // نمونهٔ رفتگرِ runtime ساخته می‌شود
    expect(withTimeout()).toEqual([]);
  });

  it("با پایش و بی‌مهلتِ صریح: دقیقاً یک نمونه (پایش) با ۶۰۰۰ و همان شِمای پیش‌فرض؛ نمونهٔ runtime بی‌سقف", async () => {
    const o = await boot({ SETTLEMENT_BACKLOG_WATCH: "on" });
    expect(o.status).toBe("started");
    const bounded = withTimeout();
    expect(bounded).toHaveLength(1);
    expect(optionsOf(bounded[0] as unknown[])).toEqual({ schema: "settlement", readStatementTimeoutMs: 6_000 });
    const plain = spy.mock.calls.filter((c) => !("readStatementTimeoutMs" in optionsOf(c)));
    expect(plain.length).toBeGreaterThanOrEqual(1);
  });

  it("مهلتِ env و شِمای env به همان نمونه می‌رسند: مهلت + فرجه", async () => {
    const o = await boot({ SETTLEMENT_BACKLOG_WATCH: "on", [E.timeoutMs]: "2000", SETTLEMENT_OUTBOX_SCHEMA: "bw_custom" });
    expect(o.status).toBe("started");
    expect(optionsOf(withTimeout()[0] as unknown[])).toEqual({ schema: "bw_custom", readStatementTimeoutMs: 3_000 });
  });

  it("مهلتِ نامعتبر: نمونه بی‌سقف ساخته می‌شود ولی بوت BACKLOG_INVALID است (بی‌سقف هرگز اجرا نمی‌شود)", async () => {
    const o = await boot({ SETTLEMENT_BACKLOG_WATCH: "on", [E.timeoutMs]: "3600001" });
    expect(o.status).toBe("failed");
    if (o.status === "failed") expect(o.code).toBe("BACKLOG_INVALID");
    expect(withTimeout()).toEqual([]);
  });
});
