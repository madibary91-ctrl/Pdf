/**
 * منبعِ سیاست روی ذخیره‌سازِ PostgreSQL **واقعی** و مدیرِ واقعی (ADR-0071): ریستارتِ فرایند، خرابیِ پایگاه (استخرِ بسته)،
 * و «پایگاهِ بازیابی‌شده از پشتیبانِ قدیمی» (نسخه عقب می‌رود ⇒ رد می‌شود). هر آزمون شِمای یک‌بارمصرف دارد.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createToolPolicyAdmin, type ToolPolicyAdmin } from "@/modules/tool-policy-admin";
import { compat, fakeClock, setPolicy, unwrap } from "../src/modules/tool-policy-admin/test-kit";
import { createPolicySource, type PolicySource } from "@/modules/tool-policy-source";
import { dbDescribe, openPgPolicyStore, type TestPolicyStore } from "../src/modules/tool-policy-store-pg/test-db";
import type { PgPolicyVersionStore } from "../src/modules/tool-policy-store-pg";

const mkAdmin = (store: PgPolicyVersionStore, clock = fakeClock()): ToolPolicyAdmin => {
  const a = createToolPolicyAdmin({ store, clock });
  if (!a.ok) throw new Error("admin");
  return a.value;
};
const mkSource = (admin: ToolPolicyAdmin, clock: ReturnType<typeof fakeClock>, maxStaleMs = 30_000): PolicySource => {
  const s = createPolicySource({ reader: admin, clock, maxStaleMs, refreshTimeoutMs: 5_000 });
  if (!s.ok) throw new Error("source");
  return s.value;
};

dbDescribe("tool-policy-source ⇄ PostgreSQL", () => {
  const opened: TestPolicyStore[] = [];
  afterAll(async () => {
    for (const h of opened) await h.dispose();
  });
  const open = async (): Promise<TestPolicyStore> => {
    const h = await openPgPolicyStore({ poolSize: 4 });
    opened.push(h);
    return h;
  };

  it("ذخیرهٔ خالیِ مهاجرت‌شده ⇒ نسخهٔ ۰؛ پس از set روی PG ⇒ نسخهٔ ۱؛ «ریستارتِ فرایند» همان نسخه را از پایگاه می‌خواند", async () => {
    const h = await open();
    const clock = fakeClock(1_900_000_000_000);
    const source = mkSource(mkAdmin(h.store, clock), clock);
    expect(await source.refresh()).toMatchObject({ ok: true, value: { outcome: "loaded", version: 0 } });
    unwrap(await setPolicy(mkAdmin(h.store, clock), 0, compat(90_000, 30_000)));
    clock.advance(1_000);
    expect(await source.refresh()).toMatchObject({ ok: true, value: { outcome: "updated", version: 1 } });
    const live = source.snapshot();
    expect(live.ok && live.value.projection.durable.graceMs).toBe(90_000);

    const again = await h.reopen();
    try {
      const restarted = mkSource(mkAdmin(again.store, clock), clock);
      expect(restarted.snapshot().ok).toBe(false); // پیش از اولین بار: NOT_LOADED، نه پیش‌فرض
      expect(await restarted.refresh()).toMatchObject({ ok: true, value: { outcome: "loaded", version: 1 } });
      const s = restarted.snapshot();
      expect(s.ok && s.value.projection).toEqual(live.ok && live.value.projection);
    } finally {
      await again.close();
    }
  });

  it("خرابیِ پایگاه (استخرِ بسته): آخرین‌خوب تا سقف، سپس STALE؛ بی‌نشتِ متنِ خطای pg", async () => {
    const h = await open();
    const clock = fakeClock(1_900_000_000_000);
    unwrap(await setPolicy(mkAdmin(h.store, clock), 0, compat(60_000, 20_000)));
    const second = await h.reopen();
    const source = mkSource(mkAdmin(second.store, clock), clock, 30_000);
    expect(await source.refresh()).toMatchObject({ ok: true, value: { version: 1 } });
    await second.close(); // پایگاه از دسترس رفت
    clock.advance(10_000);
    const r = await source.refresh();
    expect(r).toMatchObject({ ok: false, error: { code: "READ_FAILED" } });
    expect(JSON.stringify(r) + JSON.stringify(source.health())).not.toMatch(/pool|ECONN|password|postgres/i);
    const mid = source.snapshot();
    expect(mid.ok && mid.value.version).toBe(1);
    clock.advance(20_001);
    const late = source.snapshot();
    expect(late.ok).toBe(false);
    expect(source.health()).toMatchObject({ state: "STALE", version: 1 });
  });

  it("پایگاهِ بازیابی‌شده از پشتیبانِ قدیمی (نسخهٔ ۱ پس از دیدنِ ۲) ⇒ VERSION_REGRESSED؛ نسخهٔ ۲ می‌ماند", async () => {
    const newer = await open();
    const older = await open();
    const clock = fakeClock(1_900_000_000_000);
    const adminNew = mkAdmin(newer.store, clock);
    unwrap(await setPolicy(adminNew, 0, compat(60_000, 20_000)));
    unwrap(await setPolicy(adminNew, 1, compat(120_000, 40_000)));
    unwrap(await setPolicy(mkAdmin(older.store, clock), 0, compat(60_000, 20_000)));

    let useOld = false;
    const adminOld = mkAdmin(older.store, clock);
    const reader = { current: () => (useOld ? adminOld.current() : adminNew.current()) };
    const s = createPolicySource({ reader, clock, maxStaleMs: 30_000, refreshTimeoutMs: 5_000 });
    if (!s.ok) throw new Error("source");
    expect(await s.value.refresh()).toMatchObject({ ok: true, value: { version: 2 } });
    useOld = true;
    clock.advance(1_000);
    expect(await s.value.refresh()).toMatchObject({ ok: false, error: { code: "VERSION_REGRESSED" } });
    const snap = s.value.snapshot();
    expect(snap.ok && snap.value.version).toBe(2);
    expect(snap.ok && snap.value.projection.durable.graceMs).toBe(120_000);
  });
});
