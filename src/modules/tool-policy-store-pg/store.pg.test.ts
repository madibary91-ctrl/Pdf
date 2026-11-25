/**
 * آزمون‌های PostgreSQL واقعیِ آداپتور (قراردادِ مشترکِ پورت در tooling/tool-policy-store-pg-contract.pg.test.ts است).
 * اینجا: ناورداهایی که **خودِ پایگاه** اجرا می‌کند (تریگر/قید)، مهاجرت، نگهبان‌ها، مهلت، دوام و مسابقه.
 */
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import type { PolicyVersionRecord } from "@/modules/tool-policy-admin";
import { migrationChecksum, MIGRATIONS } from "./migrations";
import { dbDescribe, openPgPolicyStore, TEST_DB_URL, type TestPolicyStore } from "./test-db";

const POLICY = { timing: { graceMs: 90_000 }, model: { timeoutMs: 30_000 } };
const rec = (version: number, extra: Partial<PolicyVersionRecord> = {}): PolicyVersionRecord => ({
  version,
  overrides: {},
  policy: POLICY as never,
  changes: [],
  source: { kind: "set" },
  actor: "admin:alice",
  reason: "دلیل آزمون",
  createdAtMs: 1000 + version,
  ...extra,
});
const INSERT = `INSERT INTO {{s}}.tool_policy_versions (version, overrides, policy, changes, source_kind, source_to_version, actor, reason, created_at_ms)
  VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9)`;
const insertArgs = (o: Partial<{ version: number; overrides: unknown; policy: unknown; changes: unknown; kind: string; to: number | null; actor: string; reason: string; at: number }> = {}) => [
  o.version ?? 1,
  JSON.stringify(o.overrides ?? {}),
  JSON.stringify(o.policy ?? POLICY),
  JSON.stringify(o.changes ?? []),
  o.kind ?? "set",
  o.to ?? null,
  o.actor ?? "admin:alice",
  o.reason ?? "دلیل",
  o.at ?? 1000,
];
const sqlstate = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "OK";
  } catch (e) {
    return (e as { code?: string }).code ?? "NOCODE";
  }
};

dbDescribe("tool-policy-store-pg · PostgreSQL واقعی", () => {
  const opened: TestPolicyStore[] = [];
  afterAll(async () => {
    for (const h of opened) await h.dispose();
  });
  const open = async (o: Parameters<typeof openPgPolicyStore>[0] = {}): Promise<TestPolicyStore> => {
    const h = await openPgPolicyStore(o);
    opened.push(h);
    return h;
  };

  describe("مهاجرت و وضعیت", () => {
    it("migrate اولین بار 0001 را اعمال می‌کند؛ بار دوم idempotent است", async () => {
      const h = await open({ migrate: false });
      const first = await h.store.migrate();
      expect(first).toEqual({ ok: true, value: { applied: ["0001_init"], alreadyApplied: [] } });
      expect(await h.store.migrate()).toEqual({ ok: true, value: { applied: [], alreadyApplied: ["0001_init"] } });
    });

    it("شِمای ناموجود ⇒ NOT_MIGRATED و شِما ساخته نمی‌شود", async () => {
      const h = await open({ migrate: false, create: false });
      const m = await h.store.migrate();
      expect(m).toMatchObject({ ok: false, error: { code: "NOT_MIGRATED" } });
      const rows = await h.raw("SELECT 1 FROM pg_namespace WHERE nspname = $1", [h.schema]);
      expect(rows).toHaveLength(0);
      const st = await h.store.status();
      expect(st).toMatchObject({ ok: true, value: { schemaExists: false, ready: false, pending: ["0001_init"] } });
      expect(await h.store.latest()).toEqual({ ok: false, error: { code: "UNAVAILABLE" } });
    });

    it("۶ migrate هم‌زمان روی شِمای تازه: همه ok و دقیقاً یکی اعمال می‌کند", async () => {
      const h = await open({ migrate: false });
      const rs = await Promise.all(Array.from({ length: 6 }, () => h.store.migrate()));
      expect(rs.every((r) => r.ok)).toBe(true);
      const applied = rs.map((r) => (r.ok ? r.value.applied.length : -1));
      expect(applied.filter((n) => n === 1)).toHaveLength(1);
      expect(applied.filter((n) => n === 0)).toHaveLength(5);
      expect(await h.raw("SELECT count(*)::int AS n FROM {{s}}.tool_policy_migration_ledger")).toEqual([{ n: 1 }]);
    });

    it("جدولِ مهاجرت‌نشده: عملیات UNAVAILABLE؛ status جدول‌نبودن را گزارش می‌دهد", async () => {
      const h = await open({ migrate: false });
      for (const r of [await h.store.latest(), await h.store.get(1), await h.store.list({ beforeVersion: null, limit: 1 }), await h.store.append(rec(1))]) {
        expect(r).toEqual({ ok: false, error: { code: "UNAVAILABLE" } });
      }
      expect(await h.store.status()).toMatchObject({ ok: true, value: { schemaExists: true, ready: false, applied: [], pending: ["0001_init"] } });
    });

    it("status: پایگاهِ سالم ready است و شمارش/آخرین/بی‌شکافی را می‌دهد", async () => {
      const h = await open();
      expect(await h.store.status()).toEqual({ ok: true, value: { schemaExists: true, applied: ["0001_init"], pending: [], problems: [], rows: 0, latestVersion: null, contiguous: true, ready: true } });
      for (let v = 1; v <= 4; v++) expect((await h.store.append(rec(v))).ok).toBe(true);
      expect(await h.store.status()).toMatchObject({ ok: true, value: { rows: 4, latestVersion: 4, contiguous: true, ready: true } });
    });

    it("checksum دست‌کاری‌شده ⇒ migrate/status MIGRATION_TAMPERED و همهٔ عملیات UNAVAILABLE", async () => {
      const h = await open();
      await h.raw("UPDATE {{s}}.tool_policy_migration_ledger SET checksum = 'tampered'");
      expect(await h.store.migrate()).toMatchObject({ ok: false, error: { code: "MIGRATION_TAMPERED" } });
      expect(await h.store.status()).toMatchObject({ ok: false, error: { code: "MIGRATION_TAMPERED" } });
      expect(await h.store.latest()).toEqual({ ok: false, error: { code: "UNAVAILABLE" } });
      expect(await h.store.append(rec(1))).toEqual({ ok: false, error: { code: "UNAVAILABLE" } });
      await h.raw("UPDATE {{s}}.tool_policy_migration_ledger SET checksum = $1", [migrationChecksum(MIGRATIONS[0]!)]);
      expect((await h.store.append(rec(1))).ok).toBe(true);
    });

    it("مهاجرتِ ناشناخته (پایگاهِ از آینده) ⇒ MIGRATION_UNKNOWN و عملیات بسته", async () => {
      const h = await open();
      await h.raw("INSERT INTO {{s}}.tool_policy_migration_ledger (name, checksum) VALUES ('0002_future', 'x')");
      expect(await h.store.migrate()).toMatchObject({ ok: false, error: { code: "MIGRATION_UNKNOWN" } });
      expect(await h.store.append(rec(1))).toEqual({ ok: false, error: { code: "UNAVAILABLE" } });
    });
  });

  describe("ناورداهایی که خودِ پایگاه اجرا می‌کند (دفاع در عمق؛ بیرون از آداپتور)", () => {
    it("UPDATE، DELETE و TRUNCATE هرگز (23000) و ردیف دست‌نخورده می‌ماند", async () => {
      const h = await open();
      await h.store.append(rec(1));
      expect(await sqlstate(h.raw("UPDATE {{s}}.tool_policy_versions SET reason = 'x' WHERE version = 1"))).toBe("23000");
      expect(await sqlstate(h.raw("UPDATE {{s}}.tool_policy_versions SET version = 9"))).toBe("23000");
      expect(await sqlstate(h.raw("DELETE FROM {{s}}.tool_policy_versions"))).toBe("23000");
      expect(await sqlstate(h.raw("TRUNCATE {{s}}.tool_policy_versions"))).toBe("23000");
      const g = await h.store.get(1);
      expect(g.ok && g.value?.reason).toBe("دلیل آزمون");
    });

    it("INSERT مستقیم فقط «آخرین+۱»: شکاف، تکرار و آغازِ غیر از ۱ رد می‌شوند", async () => {
      const h = await open();
      expect(await sqlstate(h.raw(INSERT, insertArgs({ version: 2 })))).toBe("23000");
      expect(await sqlstate(h.raw(INSERT, insertArgs({ version: 1 })))).toBe("OK");
      expect(await sqlstate(h.raw(INSERT, insertArgs({ version: 1 })))).toBe("23000");
      expect(await sqlstate(h.raw(INSERT, insertArgs({ version: 3 })))).toBe("23000");
      expect(await sqlstate(h.raw(INSERT, insertArgs({ version: 2 })))).toBe("OK");
      expect(await h.raw("SELECT count(*)::int AS n FROM {{s}}.tool_policy_versions")).toEqual([{ n: 2 }]);
    });

    it.each([
      ["actor با فاصله", { actor: "x y" }],
      ["actor خالی", { actor: "" }],
      ["actor با نویسهٔ آغازِ ممنوع", { actor: "-a" }],
      ["actor بلندتر از ۱۲۸", { actor: "a".repeat(129) }],
      ["reason خالی", { reason: "" }],
      ["reason بلندتر از ۵۰۰", { reason: "ا".repeat(501) }],
      ["reason با کنترلِ جهتِ RLO", { reason: "الف\u202Eب" }],
      ["reason با ایزولهٔ جهتی U+2066", { reason: "الف\u2066ب" }],
      ["reason با جداکنندهٔ خط U+2028", { reason: "الف\u2028ب" }],
      ["reason با newline", { reason: "الف\nب" }],
      ["reason با DEL", { reason: "الف\u007fب" }],
      ["reason با U+0001", { reason: "الف\u0001ب" }],
      ["reason با C1", { reason: "الف\u0085ب" }],
      ["زمانِ منفی", { at: -1 }],
      ["rollback بی‌toVersion", { kind: "rollback" }],
      ["set با toVersion", { to: 1 }],
      ["rollback به آینده", { kind: "rollback", to: 2 }],
      ["منبعِ ناشناخته", { kind: "merge" }],
      ["overrides آرایه", { overrides: [] }],
      ["policy رشته", { policy: "x" }],
      ["changes شیء", { changes: {} }],
      ["changes بیش از ۶۴", { changes: Array.from({ length: 65 }, () => ({})) }],
    ])("قیدِ پایگاه: %s ⇒ 23514", async (_n, o) => {
      const h = await open();
      expect(await sqlstate(h.raw(INSERT, insertArgs({ version: 1, ...(o as object) })))).toBe("23514");
      expect(await h.raw("SELECT count(*)::int AS n FROM {{s}}.tool_policy_versions")).toEqual([{ n: 0 }]);
    });

    it("version صفر: تریگرِ زنجیره پیش از قیدها رد می‌کند (23000)؛ آداپتور پیش از پایگاه INVALID می‌دهد", async () => {
      const h = await open();
      expect(await sqlstate(h.raw(INSERT, insertArgs({ version: 0 })))).toBe("23000");
      expect(await h.store.append(rec(0))).toEqual({ ok: false, error: { code: "INVALID" } });
    });

    it("نیم‌فاصلهٔ فارسی U+200C، علامتِ تکی U+200F و فارسی در reason مجازند", async () => {
      const h = await open();
      expect(await sqlstate(h.raw(INSERT, insertArgs({ reason: "می‌خواهم\u200F تغییر دهم" })))).toBe("OK");
    });

    it("jsonb نمی‌تواند \\u0000 را ذخیره کند ⇒ از آداپتور INVALID (کلاس 22)، نه UNAVAILABLE", async () => {
      const h = await open();
      const r = await h.store.append(rec(1, { overrides: { model: { name: "a\u0000b" } } as never }));
      expect(r).toEqual({ ok: false, error: { code: "INVALID" } });
      expect(await h.store.latest()).toEqual({ ok: true, value: null });
    });
  });

  describe("نگهبانِ نوشتن (تریگر برداشته/خاموش)", () => {
    it("تریگرِ خاموش ⇒ append UNAVAILABLE و چیزی نوشته نمی‌شود؛ status مشکل را نشان می‌دهد؛ بازگرداندن کار می‌کند", async () => {
      const h = await open();
      await h.raw("ALTER TABLE {{s}}.tool_policy_versions DISABLE TRIGGER tool_policy_versions_immutable");
      expect(await h.store.append(rec(1))).toEqual({ ok: false, error: { code: "UNAVAILABLE" } });
      expect(await h.raw("SELECT count(*)::int AS n FROM {{s}}.tool_policy_versions")).toEqual([{ n: 0 }]);
      const st = await h.store.status();
      expect(st).toMatchObject({ ok: true, value: { ready: false, problems: ["trigger_missing_or_disabled:tool_policy_versions_immutable"] } });
      expect((await h.store.latest()).ok).toBe(true); // خواندن همچنان کار می‌کند
      await h.raw("ALTER TABLE {{s}}.tool_policy_versions ENABLE TRIGGER tool_policy_versions_immutable");
      expect((await h.store.append(rec(1))).ok).toBe(true);
    });

    it("تریگرِ حذف‌شده (chain / no_truncate) ⇒ append بسته", async () => {
      for (const name of ["tool_policy_versions_chain", "tool_policy_versions_no_truncate"]) {
        const h = await open();
        await h.raw(`DROP TRIGGER ${name} ON {{s}}.tool_policy_versions`);
        expect(await h.store.append(rec(1))).toEqual({ ok: false, error: { code: "UNAVAILABLE" } });
        expect(await h.store.status()).toMatchObject({ ok: true, value: { ready: false, problems: [`trigger_missing_or_disabled:${name}`] } });
      }
    });

    it("قیدِ حذف‌شده ⇒ status مشکل را می‌گوید", async () => {
      const h = await open();
      await h.raw("ALTER TABLE {{s}}.tool_policy_versions DROP CONSTRAINT tool_policy_versions_reason_ck");
      expect(await h.store.status()).toMatchObject({ ok: true, value: { ready: false, problems: ["constraint_missing:tool_policy_versions_reason_ck"] } });
    });

    it("شکافِ نسخه‌ها (ردیفِ تزریق‌شده بیرون از آداپتور) ⇒ status: contiguous=false و ready=false", async () => {
      const h = await open();
      await h.store.append(rec(1));
      await h.raw("ALTER TABLE {{s}}.tool_policy_versions DISABLE TRIGGER USER");
      await h.raw(INSERT, insertArgs({ version: 3 }));
      await h.raw("ALTER TABLE {{s}}.tool_policy_versions ENABLE TRIGGER USER");
      expect(await h.store.status()).toMatchObject({ ok: true, value: { rows: 2, latestVersion: 3, contiguous: false, ready: false } });
    });

    it("قیدِ NOT VALID (بازافزودنِ بی‌اعتبارسنجیِ ردیف‌های قدیمی) سالم حساب نمی‌شود", async () => {
      const h = await open();
      await h.raw("ALTER TABLE {{s}}.tool_policy_versions DROP CONSTRAINT tool_policy_versions_actor_ck");
      await h.raw("ALTER TABLE {{s}}.tool_policy_versions ADD CONSTRAINT tool_policy_versions_actor_ck CHECK (true) NOT VALID");
      expect(await h.store.status()).toMatchObject({ ok: true, value: { ready: false, problems: ["constraint_missing:tool_policy_versions_actor_ck"] } });
    });

    it("جلسهٔ session_replication_role=replica (تریگرها اجرا نمی‌شوند) ⇒ append بسته؛ در جلسهٔ عادی باز", async () => {
      const h = await open();
      const pool = new Pool({ connectionString: TEST_DB_URL, max: 2, idleTimeoutMillis: 50, options: "-c session_replication_role=replica" });
      try {
        const { drizzle } = await import("drizzle-orm/node-postgres");
        const { createPgPolicyVersionStore } = await import("./store");
        const made = createPgPolicyVersionStore(drizzle(pool), { schema: h.schema });
        if (!made.ok) throw new Error("make");
        expect(await made.value.append(rec(1))).toEqual({ ok: false, error: { code: "UNAVAILABLE" } });
        expect(await h.raw("SELECT count(*)::int AS n FROM {{s}}.tool_policy_versions")).toEqual([{ n: 0 }]);
      } finally {
        await pool.end();
      }
      expect((await h.store.append(rec(1))).ok).toBe(true);
    });
  });

  describe("ردیفِ خراب (دست‌کاری بیرون از آداپتور) بسته می‌شکند", () => {
    const poison = async (h: TestPolicyStore, over: Partial<Parameters<typeof insertArgs>[0]>): Promise<void> => {
      await h.raw(INSERT, insertArgs(over));
    };
    it("policy بدشکل (قیدِ پایگاه فقط object می‌خواهد) ⇒ latest/get/list همه INVALID", async () => {
      const h = await open();
      await poison(h, { policy: { top: 1 } });
      expect(await h.store.latest()).toEqual({ ok: false, error: { code: "INVALID" } });
      expect(await h.store.get(1)).toEqual({ ok: false, error: { code: "INVALID" } });
      expect(await h.store.list({ beforeVersion: null, limit: 5 })).toEqual({ ok: false, error: { code: "INVALID" } });
    });
    it("کلیدِ __proto__ در jsonb ⇒ INVALID و پروتوتایپ آلوده نمی‌شود", async () => {
      const h = await open();
      await h.raw(INSERT, [1, '{"__proto__":{"polluted":1}}', JSON.stringify(POLICY), "[]", "set", null, "admin:alice", "دلیل", 1000]);
      expect(await h.store.get(1)).toEqual({ ok: false, error: { code: "INVALID" } });
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    });
    it("ردیفِ خرابِ میانی کلِ list را می‌شکند (نه رد‌کردنِ بی‌صدا)؛ ردیف‌های سالم با get خوانده می‌شوند", async () => {
      const h = await open();
      await h.store.append(rec(1));
      await poison(h, { version: 2, policy: { top: 1 } });
      await poison(h, { version: 3 });
      expect(await h.store.list({ beforeVersion: null, limit: 10 })).toEqual({ ok: false, error: { code: "INVALID" } });
      const g = await h.store.get(3);
      expect(g.ok && g.value?.version).toBe(3);
    });
  });

  describe("دقتِ رفت‌وبرگشت", () => {
    it("همهٔ فیلدها (rollback، تغییرها، اعداد، فارسی با نیم‌فاصله، اعشار) بدونِ تغییر برمی‌گردند", async () => {
      const h = await open();
      await h.store.append(rec(1));
      const r = rec(2, {
        overrides: { timing: { graceMs: 60_000, ratio: 0.4 }, model: { name: "مدل‌ی-تست" } } as never,
        policy: { timing: { graceMs: 60_000, ratio: 0.4, big: 9_007_199_254_740_991 }, flag: { x: "y" } } as never,
        changes: [{ path: "timing.graceMs", from: 90_000, to: 60_000 }, { path: "model.name", from: null, to: "مدل‌ی-تست" }, { path: "a.b", from: "x", to: 0.1 }],
        source: { kind: "rollback", toVersion: 1 },
        actor: "svc:ops@corp-1",
        reason: "بازگشت به نسخهٔ قبل؛ می‌خواهیم مهلت را کم کنیم",
        createdAtMs: 9_007_199_254_740_991,
      });
      expect((await h.store.append(r)).ok).toBe(true);
      const g = await h.store.get(2);
      expect(g).toEqual({ ok: true, value: r });
      const l = await h.store.latest();
      expect(l).toEqual({ ok: true, value: r });
    });

    it("ریستارتِ فرایند (استخرِ تازه): داده ماندگار است و زنجیره ادامه می‌یابد", async () => {
      const h = await open();
      for (let v = 1; v <= 3; v++) await h.store.append(rec(v));
      const again = await h.reopen();
      try {
        const l = await again.store.list({ beforeVersion: null, limit: 10 });
        expect(l.ok && l.value.map((x) => x.version)).toEqual([3, 2, 1]);
        expect((await again.store.append(rec(4))).ok).toBe(true);
        expect((await h.store.append(rec(4)))).toEqual({ ok: false, error: { code: "CONFLICT" } });
      } finally {
        await again.close();
      }
    });
  });

  describe("هم‌زمانی و مهلت", () => {
    it("۱۲ دور × ۶ رقیب روی نسخهٔ بعدی: در هر دور دقیقاً یک برنده؛ زنجیرهٔ نهایی بی‌شکاف", async () => {
      const h = await open({ poolSize: 8 });
      for (let v = 1; v <= 12; v++) {
        const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => h.store.append(rec(v, { actor: `racer${i}` }))));
        expect(rs.filter((r) => r.ok), `v${v}`).toHaveLength(1);
        expect(rs.filter((r) => !r.ok && r.error.code === "CONFLICT"), `v${v}`).toHaveLength(5);
      }
      expect(await h.store.status()).toMatchObject({ ok: true, value: { rows: 12, latestVersion: 12, contiguous: true, ready: true } });
    });

    it("رقابتِ نسخه‌های مختلف (۲ و ۳ و ۴ هم‌زمان با ۲): فقط ۲ می‌نشیند؛ شکاف هرگز", async () => {
      const h = await open({ poolSize: 8 });
      await h.store.append(rec(1));
      const rs = await Promise.all([2, 3, 4, 2, 3, 5].map((v, i) => h.store.append(rec(v, { actor: `r${i}` }))));
      const okVersions = rs.map((r, i) => (r.ok ? [2, 3, 4, 2, 3, 5][i] : null)).filter((x) => x !== null);
      expect(okVersions).toContain(2);
      const st = await h.store.status();
      expect(st).toMatchObject({ ok: true, value: { contiguous: true, ready: true } });
    });

    it("خواننده‌ها پشتِ نویسندهٔ تأییدنشده منتظر نمی‌مانند (MVCC)", async () => {
      const h = await open();
      const holder = await h.pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(INSERT.split("{{s}}").join(`"${h.schema}"`), insertArgs({ version: 1 }));
        const t0 = Date.now();
        expect(await h.store.latest()).toEqual({ ok: true, value: null });
        expect(Date.now() - t0).toBeLessThan(2000);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
    });

    it("append پشتِ نویسندهٔ تأییدنشدهٔ هم‌نسخه با statementTimeoutMs کوتاه ⇒ UNAVAILABLE (نه معلق ماندن)؛ پس از رهاسازی کار می‌کند", async () => {
      const h = await open({ store: { statementTimeoutMs: 300 } });
      const holder = await h.pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(INSERT.split("{{s}}").join(`"${h.schema}"`), insertArgs({ version: 1 }));
        const t0 = Date.now();
        const r = await h.store.append(rec(1));
        expect(r).toEqual({ ok: false, error: { code: "UNAVAILABLE" } });
        expect(Date.now() - t0).toBeLessThan(5000);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
      expect((await h.store.append(rec(1))).ok).toBe(true);
    });

    it("هم‌نسخه‌ای که بعد از commit نویسندهٔ دیگر می‌رسد CONFLICT می‌گیرد (نه UNAVAILABLE)", async () => {
      const h = await open();
      const holder = await h.pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query(INSERT.split("{{s}}").join(`"${h.schema}"`), insertArgs({ version: 1, actor: "holder" }));
        const pending = h.store.append(rec(1, { actor: "loser" }));
        await new Promise((r) => setTimeout(r, 150));
        await holder.query("COMMIT");
        expect(await pending).toEqual({ ok: false, error: { code: "CONFLICT" } });
      } finally {
        holder.release();
      }
      const g = await h.store.get(1);
      expect(g.ok && g.value?.actor).toBe("holder");
    });
  });

  describe("مهلت‌ها به اتصالِ استخر نشت نمی‌کنند", () => {
    it("پس از هر عملیات، همان اتصال statement_timeout/lock_timeout پیش‌فرض (۰) دارد (set_config فقط تراکنشی)", async () => {
      const h = await open({ poolSize: 1, store: { statementTimeoutMs: 1234 } });
      await h.store.append(rec(1));
      await h.store.latest();
      await h.store.get(1);
      await h.store.list({ beforeVersion: null, limit: 5 });
      expect(await h.raw("SELECT current_setting('statement_timeout') AS st, current_setting('lock_timeout') AS lt")).toEqual([{ st: "0", lt: "0" }]);
    });
  });

  describe("نشتِ اطلاعات", () => {
    it("اتصالِ ناممکن با رمز در رشته: نتیجه فقط کدِ ثابت است", async () => {
      const { drizzle } = await import("drizzle-orm/node-postgres");
      const { createPgPolicyVersionStore } = await import("./store");
      const pool = new Pool({ connectionString: "postgresql://leaky_user:hunter2-secret@127.0.0.1:1/nope", max: 1, idleTimeoutMillis: 50, connectionTimeoutMillis: 1500 });
      pool.on("error", () => undefined);
      try {
        const made = createPgPolicyVersionStore(drizzle(pool));
        if (!made.ok) throw new Error("make");
        const results = [await made.value.latest(), await made.value.append(rec(1)), await made.value.migrate(), await made.value.status()];
        for (const r of results) {
          expect(r.ok).toBe(false);
          expect(JSON.stringify(r)).not.toMatch(/hunter2|leaky_user|127\.0\.0\.1|SELECT|INSERT/);
        }
        expect(results[0]).toEqual({ ok: false, error: { code: "UNAVAILABLE" } });
      } finally {
        await pool.end();
      }
    });
  });
});
