/**
 * settlement-host · یکپارچه با `createSettlementRuntime` واقعی روی دفتر و outbox حافظه‌ایِ واقعی و زمانِ مجازی.
 * هیچ `sweep()` دستی در کار نیست؛ سیگنال‌ها ساختگی‌اند. ناوردای پول در هر سناریو سنجیده می‌شود.
 */
import { describe, expect, it } from "vitest";
import { checkInvariants, createLedger, createMemoryStore } from "@/modules/ledger";
import type { Clock } from "@/modules/ledger";
import { createDurableLedger, createMemoryOutbox } from "@/modules/settlement";
import { createSettlementRuntime } from "@/modules/settlement-runtime";
import type { SettlementRuntime } from "@/modules/settlement-runtime";
import { createSettlementHost } from "./index";
import type { SettlementHost } from "./index";
import { CANARY, deferred, fakeSignals, flush, manualTimer } from "./test-kit";
import type { ManualTimer } from "./test-kit";

const KEY = { tenantId: "tenant-h", accountId: "acct-h" };
const UNIT = "IRR_MICROS";
const GRACE = 10_000;
const INTERVAL = GRACE / 4;
const FUNDS = 200_000;
const WORST = 314;

function must<T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!r.ok) throw new Error(`انتظار موفقیت بود: ${r.error.code}`);
  return r.value;
}

async function world(timer: ManualTimer = manualTimer(), policy: "forfeit" | "release" = "forfeit") {
  const clock: Clock = { nowMs: () => timer.now() };
  const store = createMemoryStore();
  const ledger = must(createLedger({ store, clock }));
  must(await ledger.openAccount({ ...KEY, unit: UNIT }));
  must(await ledger.grant({ ...KEY, grantId: "g0", unit: UNIT, amount: FUNDS, source: "purchase" }));
  const outbox = createMemoryOutbox();
  const durable = must(createDurableLedger({ ledger, outbox, clock, graceMs: GRACE, onUnknownCost: policy }));
  return { timer, clock, store, ledger, outbox, durable };
}
type World = Awaited<ReturnType<typeof world>>;

const orphan = async (w: World, id: string): Promise<void> => {
  must(await w.durable.reserve({ ...KEY, reservationId: id, unit: UNIT, amount: WORST, ttlMs: 60_000 }));
};
const balance = async (w: World) => must(await w.ledger.balance(KEY));
async function audit(w: World): Promise<void> {
  const state = await w.store.read(KEY);
  if (state === null) throw new Error("حساب نیست");
  const v = checkInvariants(state);
  if (v.length > 0) throw new Error(`ناوردا شکست: ${v.join("; ")}`);
  const t = state.totals;
  if (state.available + state.held + t.charged + t.forfeited !== t.granted) throw new Error("بقا شکست");
}

function runtimeOf(w: World, over: Record<string, unknown> = {}): SettlementRuntime {
  return must(createSettlementRuntime({ ledger: w.ledger, outbox: w.outbox, clock: w.clock, timer: w.timer, graceMs: GRACE, deadLetters: false, ...over }));
}

function hostOf(w: World, runtime: SettlementRuntime, over: Record<string, unknown> = {}) {
  const signals = fakeSignals();
  const exits: number[] = [];
  const closes = { n: 0 };
  const host = must(createSettlementHost({ runtime, timer: w.timer, signals, exit: (c: number) => void exits.push(c), closeResources: () => void (closes.n += 1), ...over })) as SettlementHost;
  return { host, signals, exits, closes };
}

describe("settlement-host · یکپارچه با runtime واقعی", () => {
  it("پس از boot، رزروِ یتیم بی‌هیچ sweep دستی بسته می‌شود؛ ready ۲۰۰ و ناوردای پول برقرار", async () => {
    const w = await world();
    const rt = runtimeOf(w);
    const { host } = hostOf(w, rt);
    await orphan(w, "r1");
    expect(host.probes.ready().httpStatus).toBe(503);
    expect(await host.boot()).toMatchObject({ booted: true, attempts: 1 });
    await w.timer.advance(GRACE - 1);
    expect((await balance(w)).held).toBe(WORST);
    await w.timer.advance(1 + 2 * INTERVAL);
    expect(await balance(w)).toMatchObject({ held: 0, available: FUNDS - WORST, totals: { forfeited: WORST, charged: 0 } });
    expect(host.probes.ready()).toMatchObject({ httpStatus: 200, body: { state: "running", sweep: "ok" } });
    await audit(w);
    expect((await host.shutdown()).ok).toBe(true);
  });

  it("ready همیشه با سلامتِ زندهٔ runtime هم‌سازگار است: ok → degraded(۲۰۰) → down(۵۰۳) → بهبود", async () => {
    const w = await world();
    let fail = false;
    const flaky = { ...w.outbox, claimDue: async (q: unknown) => { if (fail) throw new Error(`boom ${CANARY}`); return (w.outbox as unknown as { claimDue(q: unknown): Promise<unknown> }).claimDue(q); } };
    const rt = runtimeOf(w, { outbox: flaky });
    const { host } = hostOf(w, rt);
    await host.boot();
    const seen = new Set<string>();
    const sample = (): void => {
      const r = host.probes.ready();
      const h = rt.health();
      expect(r.httpStatus).toBe(h.httpStatus);
      expect(r.body.sweep).toBe(h.health.status);
      seen.add(`${r.httpStatus}:${r.body.sweep}`);
    };
    for (let i = 0; i < 6; i++) {
      await w.timer.advance(INTERVAL);
      sample();
    }
    expect([...seen]).toEqual(["200:ok"]);
    fail = true;
    for (let i = 0; i < 16; i++) {
      await w.timer.advance(INTERVAL);
      sample();
    }
    expect(seen.has("200:degraded") || seen.has("503:down")).toBe(true);
    expect(seen.has("503:down")).toBe(true);
    fail = false;
    for (let i = 0; i < 40; i++) {
      await w.timer.advance(INTERVAL);
      sample();
    }
    expect(host.probes.ready()).toMatchObject({ httpStatus: 200, body: { sweep: "ok" } });
    expect(JSON.stringify(host.probes.ready())).not.toContain(CANARY);
    await host.shutdown();
  });

  it("runtime که بیرون از میزبان متوقف شود: host هنوز running ولی ready ۵۰۳ (سلامت down) است", async () => {
    const w = await world();
    const rt = runtimeOf(w);
    const { host } = hostOf(w, rt);
    await host.boot();
    await w.timer.advance(2 * INTERVAL);
    expect(host.probes.ready().httpStatus).toBe(200);
    await rt.stop();
    expect(host.status().state).toBe("running");
    expect(host.probes.ready()).toMatchObject({ httpStatus: 503, body: { state: "running", sweep: "down" } });
    expect(host.probes.live().httpStatus).toBe(200);
    await host.shutdown();
  });

  it("SIGTERM: توقفِ تمیز، exit(0)، صفر تایمرِ معلق، و پس از آن هیچ گذری اجرا نمی‌شود؛ نمونهٔ بعدی رزرو را می‌بندد", async () => {
    const w = await world();
    const rt = runtimeOf(w);
    const { host, signals, exits, closes } = hostOf(w, rt);
    await orphan(w, "r1");
    await host.boot();
    await w.timer.advance(INTERVAL); // هنوز پیش از graceMs
    expect((await balance(w)).held).toBe(WORST);
    signals.emit("SIGTERM");
    await flush();
    expect(exits).toEqual([0]);
    expect(closes.n).toBe(1);
    expect(host.status()).toMatchObject({ state: "stopped", shutdownReason: "SIGTERM" });
    expect(w.timer.pending()).toBe(0);
    await w.timer.advance(3 * GRACE); // کمتر از TTL رزرو (۶۰ ثانیه)؛ پس انقضای دفتر دخالت نمی‌کند
    expect((await balance(w)).held).toBe(WORST); // بعد از توقف هیچ‌کس رزرو را نمی‌بندد
    await audit(w);
    // نمونهٔ بعدی (فرایندِ تازه) همان outbox را می‌گیرد و رزروِ رهاشده را می‌بندد.
    const rt2 = runtimeOf(w);
    const second = hostOf(w, rt2);
    await second.host.boot();
    await w.timer.advance(GRACE + 2 * INTERVAL);
    expect(await balance(w)).toMatchObject({ held: 0, totals: { forfeited: WORST } });
    await audit(w);
    await second.host.shutdown();
    expect(w.timer.pending()).toBe(0);
  });

  it("گذرِ آویزان هنگامِ SIGTERM: توقفِ ناتمیز ⇒ closeResources صدا زده نمی‌شود و exit(1)؛ پس از آزادشدنِ گذر ناوردا برقرار است", async () => {
    const w = await world();
    const gate = deferred<unknown>();
    let blocked = false;
    const real = w.outbox as unknown as { claimDue(q: unknown): Promise<unknown> };
    const slow = { ...w.outbox, claimDue: async (q: unknown) => { if (blocked) await gate.promise; return real.claimDue(q); } };
    const rt = runtimeOf(w, { outbox: slow, stopTimeoutMs: 100 });
    const { host, signals, exits, closes } = hostOf(w, rt, { shutdownTimeoutMs: 60_000 });
    await orphan(w, "r1");
    await host.boot();
    blocked = true;
    await w.timer.advance(INTERVAL); // گذر وارد claimDue می‌شود و آویزان می‌ماند
    signals.emit("SIGTERM");
    await flush();
    await w.timer.advance(100); // مهلتِ توقفِ حلقه
    await flush();
    expect(exits).toEqual([1]);
    expect(closes.n).toBe(0);
    expect(host.status().state).toBe("stopped");
    gate.resolve(undefined);
    await flush();
    await audit(w);
  });

  it("بوتِ NOT_MIGRATED: دائمی؛ بی‌حلقه؛ live ۲۰۰/startup ۵۰۳/ready ۵۰۳؛ پس از رفعِ مشکل boot دوباره موفق است", async () => {
    const w = await world();
    let migrated = false;
    const rt = runtimeOf(w, { preflight: () => (migrated ? { ok: true } : { ok: false, code: "NOT_MIGRATED" }) });
    const { host } = hostOf(w, rt, { bootRetry: { maxAttempts: 5 } });
    const res = await host.boot();
    expect(res).toEqual({ booted: false, reason: "PREFLIGHT_FAILED", code: "NOT_MIGRATED", attempts: 1 });
    expect(w.timer.pending()).toBe(0);
    expect([host.probes.live().httpStatus, host.probes.startup().httpStatus, host.probes.ready().httpStatus]).toEqual([200, 503, 503]);
    migrated = true;
    expect(await host.boot()).toMatchObject({ booted: true });
    expect([host.probes.live().httpStatus, host.probes.startup().httpStatus, host.probes.ready().httpStatus]).toEqual([200, 200, 200]);
    await host.shutdown();
  });

  it("پایگاهِ هنوز بالا نیامده (UNAVAILABLE) بازتلاش می‌شود و سپس رفتگر می‌دود", async () => {
    const w = await world();
    let up = 0;
    const rt = runtimeOf(w, { preflight: () => (up++ >= 2 ? { ok: true } : { ok: false, code: "UNAVAILABLE" }) });
    const { host } = hostOf(w, rt, { bootRetry: { maxAttempts: 4, delayMs: 500 } });
    await orphan(w, "r1");
    const p = host.boot();
    await flush();
    expect(host.status().state).toBe("booting");
    await w.timer.advance(500);
    await w.timer.advance(500);
    expect(await p).toMatchObject({ booted: true, attempts: 3 });
    await w.timer.advance(GRACE + 2 * INTERVAL);
    expect((await balance(w)).held).toBe(0);
    await audit(w);
    await host.shutdown();
  });

  it("خاموشی در میانهٔ بازتلاشِ بوت با runtime واقعی: بی‌حلقهٔ یتیم و بی‌تایمرِ معلق", async () => {
    const w = await world();
    const rt = runtimeOf(w, { preflight: () => ({ ok: false, code: "UNAVAILABLE" }) });
    const { host } = hostOf(w, rt, { bootRetry: { maxAttempts: 9, delayMs: 5_000 } });
    const p = host.boot();
    await flush();
    const res = await host.shutdown();
    expect(res.ok).toBe(true);
    expect(await p).toMatchObject({ booted: false, reason: "SHUTTING_DOWN" });
    await w.timer.advance(60_000);
    expect(w.timer.pending()).toBe(0);
    expect(rt.status().state).toBe("idle");
    expect(host.status().state).toBe("stopped");
  });
});
