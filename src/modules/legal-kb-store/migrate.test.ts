import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS, migrationChecksum } from "./migrations";
import { dbDescribe, openTestKb, type TestKb } from "./test-db";
import { createKbStore } from "./store";
import { drizzle } from "drizzle-orm/node-postgres";

dbDescribe("legal-kb-store · مهاجرت (پایگاه واقعی)", () => {
  const opened: TestKb[] = [];
  const open = async (migrate = true) => {
    const kb = await openTestKb({ migrate });
    opened.push(kb);
    return kb;
  };
  afterAll(async () => {
    for (const kb of opened) await kb.drop();
  });

  it("پایگاه تازه: همهٔ مهاجرت‌ها اعمال می‌شود و دفتر checksum درست دارد", async () => {
    const kb = await open(false);
    const before = await kb.store.migrationStatus();
    expect(before).toEqual({ ok: true, value: { applied: [], pending: MIGRATIONS.map((m) => m.name) } });

    const r = await kb.store.migrate();
    expect(r).toEqual({ ok: true, value: { applied: MIGRATIONS.map((m) => m.name), alreadyApplied: [] } });

    const ledger = await kb.raw(`SELECT name, checksum FROM {{schema}}.migration_ledger ORDER BY name`);
    expect(ledger).toEqual(MIGRATIONS.map((m) => ({ name: m.name, checksum: migrationChecksum(m) })));
    const after = await kb.store.migrationStatus();
    expect(after).toEqual({ ok: true, value: { applied: MIGRATIONS.map((m) => m.name), pending: [] } });
  });

  it("ایدمپوتنت: اجرای دوباره چیزی عوض نمی‌کند", async () => {
    const kb = await open();
    const again = await kb.store.migrate();
    expect(again).toEqual({ ok: true, value: { applied: [], alreadyApplied: MIGRATIONS.map((m) => m.name) } });
    const ledger = await kb.raw(`SELECT count(*)::int AS n FROM {{schema}}.migration_ledger`);
    expect(ledger[0]?.["n"]).toBe(MIGRATIONS.length);
  });

  it("اجرای هم‌زمان ۶ فرایند روی پایگاه تازه: همه موفق، یک بار اعمال", async () => {
    const kb = await open(false);
    const results = await Promise.all(Array.from({ length: 6 }, () => kb.store.migrate()));
    for (const r of results) expect(r.ok).toBe(true);
    const appliedCounts = results.map((r) => (r.ok ? r.value.applied.length : -1));
    // دقیقاً یکی اعمال کرده، بقیه «از قبل اعمال‌شده» دیده‌اند
    expect(appliedCounts.filter((n) => n === MIGRATIONS.length)).toHaveLength(1);
    expect(appliedCounts.filter((n) => n === 0)).toHaveLength(5);
    const ledger = await kb.raw(`SELECT count(*)::int AS n FROM {{schema}}.migration_ledger`);
    expect(ledger[0]?.["n"]).toBe(MIGRATIONS.length);
  });

  it("دست‌کاری checksum در دفتر: MIGRATION_TAMPERED در همهٔ عملیات؛ هیچ داده‌ای نوشته نمی‌شود", async () => {
    const kb = await open();
    await kb.raw(`UPDATE {{schema}}.migration_ledger SET checksum = 'deadbeef'`);
    for (const r of [await kb.store.migrate(), await kb.store.migrationStatus(), await kb.store.stats(), await kb.store.readCorpus(), await kb.store.insertCorpus({ documents: [], relations: [], rulings: [] })]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("MIGRATION_TAMPERED");
    }
  });

  it("پایگاه «از آینده» (مهاجرت ناشناخته): MIGRATION_UNKNOWN", async () => {
    const kb = await open();
    await kb.raw(`INSERT INTO {{schema}}.migration_ledger (name, checksum) VALUES ('9999_from_the_future', 'x')`);
    const r = await kb.store.migrate();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("MIGRATION_UNKNOWN");
    const s = await kb.store.stats();
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.error.code).toBe("MIGRATION_UNKNOWN");
  });

  it("حفره در دفتر (مهاجرت اول پاک شده): MIGRATION_TAMPERED یا NOT_MIGRATED، هرگز ادامهٔ بی‌صدا", async () => {
    const kb = await open();
    await kb.raw(`DELETE FROM {{schema}}.migration_ledger`);
    const s = await kb.store.stats();
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.error.code).toBe("NOT_MIGRATED");
  });

  it("شِمای مهاجرت‌نشده: خواندن/نوشتن NOT_MIGRATED (نه خطای خام و نه پایگاه خالی)", async () => {
    const kb = await open(false);
    for (const r of [await kb.store.stats(), await kb.store.readCorpus(), await kb.store.insertCorpus({ documents: [], relations: [], rulings: [] })]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("NOT_MIGRATED");
    }
    const q = await kb.store.resolveCitation({ documentId: "x", article: "1", subpart: null }, "2020-01-01");
    expect(q.ok).toBe(false);
    if (!q.ok) expect(q.error.code).toBe("NOT_MIGRATED");
  });

  it("دو شِمای جدا کاملاً مستقل‌اند", async () => {
    const a = await open();
    const b = await open();
    expect(a.schema).not.toBe(b.schema);
    const ins = await a.store.insertCorpus({
      documents: [
        {
          id: "only-in-a",
          kind: "statute",
          title: "x",
          shortTitle: null,
          enactedOn: null,
          provenance: { sourceName: "s", sourceUrl: null, sourceKind: "secondary", retrievedOn: null },
          articles: [],
        },
      ],
      relations: [],
      rulings: [],
    });
    expect(ins.ok).toBe(true);
    const sa = await a.store.stats();
    const sb = await b.store.stats();
    expect(sa.ok && sa.value.documents).toBe(1);
    expect(sb.ok && sb.value.documents).toBe(0);
  });

  it("مهاجرت به جدول‌ها و شِمای برنامه (public) دست نمی‌زند", async () => {
    const kb = await open(false);
    const snapshot = async () => (await kb.raw(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`)).map((r) => r["table_name"]);
    const before = await snapshot();
    await kb.store.migrate();
    expect(await snapshot()).toEqual(before);
    // و همهٔ جدول‌های ما در شِمای خودشان‌اند
    const tables = (await kb.raw(`SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`, [kb.schema])).map((r) => r["table_name"]);
    expect(tables).toEqual(["article", "article_subpart", "article_version", "document", "migration_ledger", "relation", "ruling", "ruling_cite"]);
  });

  it("نام شِمای مخرب: ساخت store رد می‌شود و هیچ SQL اجرا نمی‌شود", async () => {
    const kb = await open();
    for (const bad of ['x"; DROP SCHEMA public CASCADE; --', "public", "pg_catalog", "Legal", "", "a".repeat(41), "1abc", "a-b", "information_schema"]) {
      const r = createKbStore(kb.db, { schema: bad });
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
    }
    const alive = await kb.raw(`SELECT 1 AS ok FROM information_schema.schemata WHERE schema_name = 'public'`);
    expect(alive).toHaveLength(1);
  });

  describe("نبود دسترسی/اتصال", () => {
    let kb: TestKb;
    beforeAll(async () => {
      kb = await open();
    });
    it("اتصال قطع‌شده: DB_ERROR با پیام عمومی؛ رشتهٔ اتصال یا SQL درز نمی‌کند", async () => {
      const { Pool } = await import("pg");
      const dead = new Pool({ connectionString: "postgresql://nobody:secret-password@127.0.0.1:1/none", connectionTimeoutMillis: 500 });
      const store = createKbStore(drizzle(dead), { schema: kb.schema });
      expect(store.ok).toBe(true);
      if (!store.ok) return;
      const r = await store.value.stats();
      await dead.end();
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("DB_ERROR");
        expect(JSON.stringify(r.error)).not.toMatch(/secret-password|nobody|127\.0\.0\.1/);
      }
    });
  });
});

describe("legal-kb-store · مهاجرت (بدون پایگاه)", () => {
  it("فهرست مهاجرت‌ها مرتب و یکتاست و دستور خالی ندارد", () => {
    const names = MIGRATIONS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(names);
    for (const m of MIGRATIONS) {
      expect(m.name).toMatch(/^\d{4}_[a-z0-9_]+$/);
      expect(m.statements.length).toBeGreaterThan(0);
      for (const s of m.statements) expect(s.trim()).not.toBe("");
    }
  });
});
