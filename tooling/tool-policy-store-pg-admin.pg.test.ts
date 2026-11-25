/**
 * ادمینِ نسخه‌دار روی ذخیره‌سازِ PostgreSQL واقعی (انتها‌به‌انتها؛ ADR-0070): CAS بینِ دو نمونهٔ مدیر (دو فرایند)،
 * rollback، current/history، ریستارتِ فرایند و بسته‌شدنِ شکست روی ردیفِ خراب. مدیر هیچ تغییری نکرده است؛ فقط ذخیره‌ساز عوض شده.
 */
import { afterAll, describe, expect, it } from "vitest";
import { createToolPolicyAdmin, type ToolPolicyAdmin } from "../src/modules/tool-policy-admin";
import { ACTOR, compat, fakeClock, REASON, rollback, setPolicy, unwrap } from "../src/modules/tool-policy-admin/test-kit";
import { dbDescribe, openPgPolicyStore, type TestPolicyStore } from "../src/modules/tool-policy-store-pg/test-db";
import type { PgPolicyVersionStore } from "../src/modules/tool-policy-store-pg";

const mkAdmin = (store: PgPolicyVersionStore, clock = fakeClock()): ToolPolicyAdmin => {
  const a = createToolPolicyAdmin({ store, clock });
  if (!a.ok) throw new Error("admin");
  return a.value;
};

dbDescribe("tool-policy-admin ⇄ PostgreSQL", () => {
  const opened: TestPolicyStore[] = [];
  afterAll(async () => {
    for (const h of opened) await h.dispose();
  });
  const open = async (): Promise<TestPolicyStore> => {
    const h = await openPgPolicyStore({ poolSize: 8 });
    opened.push(h);
    return h;
  };

  it("set ← current ← rollbackTo ← history روی PG؛ ممیزی و تفاوت‌ها ماندگارند", async () => {
    const h = await open();
    const clock = fakeClock(1_800_000_000_000);
    const admin = mkAdmin(h.store, clock);
    const v1 = unwrap(await setPolicy(admin, 0, compat(60_000, 20_000)));
    expect(v1.version).toBe(1);
    clock.advance(1000);
    const v2 = unwrap(await setPolicy(admin, 1, compat(120_000, 40_000)));
    expect(v2.version).toBe(2);
    clock.advance(1000);
    const v3 = unwrap(await rollback(admin, 2, 1));
    expect(v3.version).toBe(3);
    expect(v3.overrides).toEqual(v1.overrides);

    const cur = unwrap(await admin.current());
    expect(cur).toMatchObject({ version: 3, source: "stored", drift: false });
    const hist = unwrap(await admin.history({ limit: 10 }));
    expect(hist.entries.map((e) => e.version)).toEqual([3, 2, 1]);
    expect(hist.entries[0]).toMatchObject({ source: { kind: "rollback", toVersion: 1 }, actor: ACTOR, reason: REASON, createdAtMs: 1_800_000_002_000 });
    expect(hist.entries[2]!.createdAtMs).toBe(1_800_000_000_000);

    // «ریستارتِ فرایند»: استخرِ تازه + مدیرِ تازه همان تاریخچه را می‌بینند
    const again = await h.reopen();
    try {
      const admin2 = mkAdmin(again.store);
      expect(unwrap(await admin2.current())).toEqual(cur);
      expect(unwrap(await admin2.history({ limit: 10 }))).toEqual(hist);
    } finally {
      await again.close();
    }
  });

  it("دو مدیر (دو فرایند) با همان expectedVersion: دقیقاً یکی برنده و دیگری VERSION_CONFLICT؛ هیچ نسخهٔ گم‌شده یا تکراری", async () => {
    const h = await open();
    const again = await h.reopen();
    try {
      const a = mkAdmin(h.store);
      const b = mkAdmin(again.store);
      for (let round = 0; round < 8; round++) {
        const rs = await Promise.all([
          setPolicy(a, round, compat(60_000 + round * 10_000, 20_000), { actor: "admin:a" }),
          setPolicy(b, round, compat(61_000 + round * 10_000, 20_000), { actor: "admin:b" }),
          setPolicy(a, round, compat(62_000 + round * 10_000, 20_000), { actor: "admin:c" }),
        ]);
        expect(rs.filter((r) => r.ok), `دور ${round}`).toHaveLength(1);
        for (const r of rs) if (!r.ok) expect(r.error.code).toBe("VERSION_CONFLICT");
      }
      const hist = unwrap(await a.history({ limit: 100 }));
      expect(hist.entries.map((e) => e.version)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
      expect(await h.store.status()).toMatchObject({ ok: true, value: { rows: 8, contiguous: true, ready: true } });
    } finally {
      await again.close();
    }
  });

  it("NO_CHANGE نسخه نمی‌سازد؛ بازنویسیِ نامعتبر هیچ ردیفی نمی‌نویسد", async () => {
    const h = await open();
    const admin = mkAdmin(h.store);
    unwrap(await setPolicy(admin, 0, compat(60_000, 20_000)));
    const same = await setPolicy(admin, 1, compat(60_000, 20_000));
    expect(same).toMatchObject({ ok: false, error: { code: "NO_CHANGE" } });
    const bad = await setPolicy(admin, 1, { timing: { graceMs: 1 } });
    expect(bad).toMatchObject({ ok: false, error: { code: "INVALID_OVERRIDES" } });
    expect(await h.raw("SELECT count(*)::int AS n FROM {{s}}.tool_policy_versions")).toEqual([{ n: 1 }]);
  });

  it("ردیفِ خرابِ آخر ⇒ مدیر STORE_FAILURE می‌دهد (بسته‌شدنِ شکست)، نه پیش‌فرضِ بی‌صدا؛ set هم نمی‌نویسد", async () => {
    const h = await open();
    const admin = mkAdmin(h.store);
    unwrap(await setPolicy(admin, 0, compat(60_000, 20_000)));
    await h.raw("ALTER TABLE {{s}}.tool_policy_versions DISABLE TRIGGER USER");
    await h.raw(`INSERT INTO {{s}}.tool_policy_versions (version, overrides, policy, changes, source_kind, source_to_version, actor, reason, created_at_ms)
      VALUES (2, '{}', '{"top": 1}', '[]', 'set', NULL, 'admin:evil', 'x', 5)`);
    await h.raw("ALTER TABLE {{s}}.tool_policy_versions ENABLE TRIGGER USER");
    expect(await admin.current()).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
    expect(await setPolicy(admin, 2, compat(70_000, 20_000))).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
    expect(await h.raw("SELECT count(*)::int AS n FROM {{s}}.tool_policy_versions")).toEqual([{ n: 2 }]);
  });

  it("ذخیره‌سازِ مهاجرت‌نشده ⇒ مدیر STORE_FAILURE (بی‌نشتِ متن)", async () => {
    const h = await openPgPolicyStore({ migrate: false });
    opened.push(h);
    const admin = mkAdmin(h.store);
    const r = await admin.current();
    expect(r).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
    expect(JSON.stringify(r)).not.toMatch(/postgres|SELECT|tool_policy_versions/);
  });
});
