/**
 * settlement-bootstrap · سیم‌کشیِ منبعِ خواندنِ پایش (ADR-0051، م۳‑ه‑۴‑الف‑۲‑۴‑ب‑۲‑۳) — بی‌پایگاهِ واقعی.
 * `createPendingDeadIndex` و `createPgSettlementOutbox` اسپای می‌شوند تا ثابت شود: پیش‌فرض دقیقاً مثلِ پیش است (نمایه هرگز ساخته نمی‌شود)؛
 * `pending` ⇒ **فقط** نمایه، با همان شِما و همان سقفِ سمتِ پایگاهِ پایش؛ رد شدنِ نمایه ⇒ شکستِ بسته (نه بازگشت به outbox)؛ لاگ فقط برای pending نشانهٔ منبع دارد.
 * رفتارِ واقعیِ خواندن روی PostgreSQL در `source.pg.test.ts` است. فایلِ تازه؛ هیچ آزمونِ موجودی دست نخورده.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgSettlementOutbox } from "@/modules/settlement";
import { SETTLEMENT_BACKLOG_WATCH_ENV as E } from "@/modules/settlement-backlog-watch";
import { getSettlementHost } from "@/modules/settlement-host";
import { createPendingDeadIndex } from "@/modules/settlement-pending";
import { startSettlementBootstrap } from "./bootstrap";
import { ON_ENV, collector, deadDatabase, fakeSignals, manualTimer } from "./test-kit";
import type { BootstrapEvent } from "./types";

vi.mock("@/modules/settlement", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/modules/settlement")>();
  return { ...real, createPgSettlementOutbox: vi.fn(real.createPgSettlementOutbox) };
});
vi.mock("@/modules/settlement-pending", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/modules/settlement-pending")>();
  return { ...real, createPendingDeadIndex: vi.fn(real.createPendingDeadIndex) };
});

const realPending = vi.mocked(createPendingDeadIndex).getMockImplementation() as (...a: unknown[]) => unknown;
const outboxSpy = vi.mocked(createPgSettlementOutbox);
const pendingSpy = vi.mocked(createPendingDeadIndex);
const stores: Record<symbol, unknown>[] = [];
beforeEach(() => {
  outboxSpy.mockClear();
  pendingSpy.mockClear();
  pendingSpy.mockReset();
  pendingSpy.mockImplementation(realPending as never);
});
afterEach(async () => {
  for (const s of stores.splice(0)) await getSettlementHost(s)?.shutdown();
});

async function boot(env: Record<string, string>) {
  const store: Record<symbol, unknown> = {};
  stores.push(store);
  const db = deadDatabase();
  const logs = collector();
  const outcome = await startSettlementBootstrap({
    env: { ...ON_ENV, ...env },
    store,
    processOwner: "host" as const,
    openDatabase: () => db.opened,
    log: logs.log,
    timer: manualTimer(),
    signals: fakeSignals(),
    exit: () => undefined,
  });
  return { outcome, db, logs };
}
const optionsOf = (call: unknown[]): Record<string, unknown> => (call[1] ?? {}) as Record<string, unknown>;
const watchEvents = (events: readonly BootstrapEvent[]) => events.filter((e) => e.type === "bootstrap.backlog_watch");

describe("settlement-bootstrap · سیم‌کشیِ منبعِ پایش", () => {
  it("پیش‌فرض (پایشِ روشن، بی‌منبع): نمایه هرگز ساخته نمی‌شود؛ دقیقاً یک نمونهٔ outbox (پایش) سقف می‌گیرد", async () => {
    const { outcome } = await boot({ SETTLEMENT_BACKLOG_WATCH: "on" });
    expect(outcome.status).toBe("started");
    expect(pendingSpy).not.toHaveBeenCalled();
    expect(outboxSpy.mock.calls.filter((c) => "readStatementTimeoutMs" in optionsOf(c))).toHaveLength(1);
  });

  it("منبعِ صریحِ outbox ≡ پیش‌فرض: نمایه ساخته نمی‌شود", async () => {
    const { outcome } = await boot({ SETTLEMENT_BACKLOG_WATCH: "on", SETTLEMENT_BACKLOG_SOURCE: "outbox" });
    expect(outcome.status).toBe("started");
    expect(pendingSpy).not.toHaveBeenCalled();
    expect(outboxSpy.mock.calls.filter((c) => "readStatementTimeoutMs" in optionsOf(c))).toHaveLength(1);
  });

  it("بی‌پایش: نمایه هرگز ساخته نمی‌شود و هیچ outboxی سقف نمی‌گیرد (رفتارِ امروز)", async () => {
    const { outcome } = await boot({});
    expect(outcome.status).toBe("started");
    expect(pendingSpy).not.toHaveBeenCalled();
    expect(outboxSpy.mock.calls.filter((c) => "readStatementTimeoutMs" in optionsOf(c))).toEqual([]);
  });

  it("pending: دقیقاً یک نمایه با همان پایگاه، شِمای پیش‌فرض و سقفِ ۶۰۰۰؛ هیچ outboxی برای پایش ساخته نمی‌شود (فقط نمونهٔ بی‌سقفِ رفتگر)", async () => {
    const { outcome, db } = await boot({ SETTLEMENT_BACKLOG_WATCH: "on", SETTLEMENT_BACKLOG_SOURCE: "pending" });
    expect(outcome.status).toBe("started");
    expect(pendingSpy).toHaveBeenCalledTimes(1);
    const call = pendingSpy.mock.calls[0] as unknown[];
    expect(call[0]).toBe(db.opened.db);
    expect(optionsOf(call)).toEqual({ schema: "settlement", readStatementTimeoutMs: 6_000 });
    expect(outboxSpy.mock.calls.filter((c) => "readStatementTimeoutMs" in optionsOf(c))).toEqual([]);
    expect(outboxSpy.mock.calls.length).toBeGreaterThanOrEqual(1); // نمونهٔ رفتگرِ runtime
  });

  it("pending: شِمای env و مهلتِ env + فرجه به نمایه می‌رسند", async () => {
    const { outcome } = await boot({ SETTLEMENT_BACKLOG_WATCH: "on", SETTLEMENT_BACKLOG_SOURCE: "pending", SETTLEMENT_OUTBOX_SCHEMA: "bw_custom", [E.timeoutMs]: "2000" });
    expect(outcome.status).toBe("started");
    expect(optionsOf(pendingSpy.mock.calls[0] as unknown[])).toEqual({ schema: "bw_custom", readStatementTimeoutMs: 3_000 });
  });

  it("pending و نمایه ساخته نشد ⇒ BACKLOG_INVALID، پایگاه یک‌بار بسته، میزبان ساخته نمی‌شود، و **بازگشت به outbox نیست**", async () => {
    pendingSpy.mockImplementationOnce((() => ({ ok: false, error: { code: "INVALID_INPUT", message: "x" } })) as never);
    const store: Record<symbol, unknown> = {};
    stores.push(store);
    const db = deadDatabase();
    const outcome = await startSettlementBootstrap({
      env: { ...ON_ENV, SETTLEMENT_BACKLOG_WATCH: "on", SETTLEMENT_BACKLOG_SOURCE: "pending" },
      store,
      processOwner: "host",
      openDatabase: () => db.opened,
      timer: manualTimer(),
      signals: fakeSignals(),
      exit: () => undefined,
    });
    expect(outcome).toMatchObject({ status: "failed", code: "BACKLOG_INVALID" });
    expect(db.closed()).toBe(1);
    expect(getSettlementHost(store)).toBeNull();
    expect(outboxSpy.mock.calls.filter((c) => "readStatementTimeoutMs" in optionsOf(c))).toEqual([]);
  });

  it("pending و مهلتِ نامعتبر ⇒ BACKLOG_INVALID (نمایه بی‌سقف ساخته می‌شود ولی هرگز به اجرا نمی‌رسد)", async () => {
    const { outcome, db } = await boot({ SETTLEMENT_BACKLOG_WATCH: "on", SETTLEMENT_BACKLOG_SOURCE: "pending", [E.timeoutMs]: "3600001" });
    expect(outcome).toMatchObject({ status: "failed", code: "BACKLOG_INVALID" });
    expect(db.closed()).toBe(1);
    expect("readStatementTimeoutMs" in optionsOf(pendingSpy.mock.calls[0] as unknown[])).toBe(false);
  });

  it.each([["pending"], ["PENDING"], ["index"]])("منبعِ %j بی‌پایش/نامعتبر ⇒ INVALID_ENV و پایگاه هرگز باز نمی‌شود، نمایه ساخته نمی‌شود", async (v) => {
    const { outcome, db } = await boot(v === "pending" ? { SETTLEMENT_BACKLOG_SOURCE: v } : { SETTLEMENT_BACKLOG_WATCH: "on", SETTLEMENT_BACKLOG_SOURCE: v });
    expect(outcome).toMatchObject({ status: "failed", code: "INVALID_ENV" });
    expect(db.executes()).toBe(0);
    expect(db.closed()).toBe(0);
    expect(pendingSpy).not.toHaveBeenCalled();
  });

  it("لاگ: pending ⇒ armed با source=\"pending\" و readyPolicy؛ پیش‌فرض ⇒ رویدادِ armed دقیقاً مثلِ قبل (بی‌کلیدِ source)", async () => {
    const p = await boot({ SETTLEMENT_BACKLOG_WATCH: "on", SETTLEMENT_BACKLOG_SOURCE: "pending", [E.readyPolicy]: "gate_down" });
    expect(watchEvents(p.logs.events)).toEqual([{ type: "bootstrap.backlog_watch", state: "armed", readyPolicy: "gate_down", source: "pending" }]);
    const d = await boot({ SETTLEMENT_BACKLOG_WATCH: "on" });
    expect(watchEvents(d.logs.events)).toEqual([{ type: "bootstrap.backlog_watch", state: "armed", readyPolicy: "report" }]);
    for (const e of watchEvents(d.logs.events)) expect("source" in e).toBe(false);
  });

  it("لاگ و نتیجه هرگز نامِ شِما یا آستانه را نمی‌آورند (فقط نشانهٔ منبع)", async () => {
    const p = await boot({ SETTLEMENT_BACKLOG_WATCH: "on", SETTLEMENT_BACKLOG_SOURCE: "pending", SETTLEMENT_OUTBOX_SCHEMA: "bw_secretish", [E.downCount]: "7" });
    const text = JSON.stringify(p.logs.events);
    expect(text).not.toContain("bw_secretish");
    expect(text).not.toContain("7");
  });
});
