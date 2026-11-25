/**
 * منبعِ سیاست روی مدیرِ نسخه‌دارِ **واقعی** و اعتبارسنج‌های واقعیِ پایین‌دست (ADR-0071): هر نسخه‌ای که ادمین ثبت کند منبع می‌بیند و
 * projectionِ آن را اعتبارسنج‌های ریشهٔ I/O می‌پذیرند؛ خرابیِ ذخیره‌ساز آخرین‌خوب را تا سقف نگه می‌دارد و بعد می‌بندد.
 */
import { describe, expect, it } from "vitest";
import { checkTimingRelations } from "@/modules/tool-call-deadline";
import { projectToolPolicy } from "@/modules/tool-policy";
import { createToolPolicyAdmin, createMemoryPolicyStore } from "@/modules/tool-policy-admin";
import { compat, fakeClock, rollback, setPolicy, wrapStore } from "../src/modules/tool-policy-admin/test-kit";
import { createPolicySource } from "@/modules/tool-policy-source";

function world(maxStaleMs = 60_000) {
  const clock = fakeClock(1_800_000_000_000);
  const inner = createMemoryPolicyStore();
  let broken = false;
  const store = wrapStore(inner, {
    latest: (() => (broken ? Promise.resolve({ ok: false, error: { code: "UNAVAILABLE" } }) : inner.latest())) as never,
  });
  const a = createToolPolicyAdmin({ store, clock });
  if (!a.ok) throw new Error("admin");
  const s = createPolicySource({ reader: a.value, clock, maxStaleMs, refreshTimeoutMs: 5_000 });
  if (!s.ok) throw new Error("source");
  return { admin: a.value, source: s.value, clock, setBroken: (v: boolean) => void (broken = v) };
}

describe("tool-policy-source ⇄ مدیرِ نسخه‌دارِ واقعی", () => {
  it("ذخیرهٔ خالی ⇒ نسخهٔ ۰ (پیش‌فرض‌های کد) صریحاً از مدیر؛ projection همان projectToolPolicy(undefined)", async () => {
    const w = world();
    expect((await w.source.refresh()).ok).toBe(true);
    const s = w.source.snapshot();
    const expected = projectToolPolicy(undefined);
    expect(s.ok && s.value).toMatchObject({ version: 0, source: "defaults" });
    expect(expected.ok && s.ok && s.value.projection).toEqual(expected.ok && expected.value);
  });

  it("set ← refresh ← snapshot؛ rollbackTo نسخهٔ تازه است (نسخه جلو می‌رود) و منبع آن را می‌پذیرد", async () => {
    const w = world();
    await w.source.refresh();
    expect((await setPolicy(w.admin, 0, compat(60_000, 20_000))).ok).toBe(true);
    w.clock.advance(1_000);
    expect(await w.source.refresh()).toMatchObject({ ok: true, value: { outcome: "updated", version: 1 } });
    await setPolicy(w.admin, 1, compat(120_000, 40_000));
    w.clock.advance(1_000);
    await w.source.refresh();
    const v2 = w.source.snapshot();
    expect(v2.ok && v2.value.projection.durable.graceMs).toBe(120_000);
    await rollback(w.admin, 2, 1);
    w.clock.advance(1_000);
    expect(await w.source.refresh()).toMatchObject({ ok: true, value: { outcome: "updated", version: 3 } });
    const v3 = w.source.snapshot();
    expect(v3.ok && v3.value.projection.durable.graceMs).toBe(60_000);
  });

  it("projectionِ منبع را اعتبارسنجِ واقعیِ رابطه‌های زمانیِ پایین‌دست می‌پذیرد", async () => {
    const w = world();
    await setPolicy(w.admin, 0, compat(90_000, 30_000));
    await w.source.refresh();
    const s = w.source.snapshot();
    if (!s.ok) throw new Error("snapshot");
    const p = s.value.projection;
    expect(checkTimingRelations({ maxCallMs: p.deadline.maxCallMs, graceMs: p.durable.graceMs, reservationTtlMs: p.durable.reservationTtlMs })).toEqual([]);
  });

  it("خرابیِ ذخیره‌ساز: آخرین‌خوب تا سقف می‌ماند، پس از آن snapshot بسته می‌شود؛ بازیابی ⇒ دوباره باز", async () => {
    const w = world(30_000);
    await setPolicy(w.admin, 0, compat(60_000, 20_000));
    await w.source.refresh();
    w.setBroken(true);
    w.clock.advance(10_000);
    expect(await w.source.refresh()).toMatchObject({ ok: false, error: { code: "READ_FAILED" } });
    const mid = w.source.snapshot();
    expect(mid.ok && mid.value.version).toBe(1);
    w.clock.advance(20_001);
    await w.source.refresh();
    const late = w.source.snapshot();
    expect(late.ok).toBe(false);
    expect(w.source.health()).toMatchObject({ state: "STALE", consecutiveFailures: 2, lastFailure: "READ_FAILED" });
    w.setBroken(false);
    await w.source.refresh();
    expect(w.source.snapshot().ok).toBe(true);
    expect(w.source.health()).toMatchObject({ state: "FRESH", consecutiveFailures: 0 });
  });

  it("ادمینِ دیگری که ثبتِ نامعتبر می‌زند نسخه نمی‌سازد؛ منبع تغییری نمی‌بیند", async () => {
    const w = world();
    await setPolicy(w.admin, 0, compat(60_000, 20_000));
    await w.source.refresh();
    expect((await setPolicy(w.admin, 1, { timing: { graceMs: 1 } })).ok).toBe(false);
    expect(await w.source.refresh()).toMatchObject({ ok: true, value: { outcome: "unchanged", version: 1 } });
  });
});
