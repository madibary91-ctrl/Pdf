/**
 * رفتارِ خودِ پایگاه (ADR-0022): قیدها، TRIGGERها و ایندکس‌ها حتی وقتی کسی از کنار آداپتور (psql، اسکریپت) بنویسد؛ و چرخهٔ زندگی مهاجرت‌ها
 * (idempotent، هم‌زمان‌امن، اتمی، سپر checksum، هم‌زیستی با شِمای دفتر اعتبار). دفاع در عمق: آداپتور اولین خط است، پایگاه آخرین.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createLedger, createPgAccountStore } from "@/modules/ledger";
import type { LedgerDatabase } from "@/modules/ledger";
import { dbDescribe, newSchemaName, openPgOutbox, type TestOutbox } from "./test-db";
import { createPgSettlementOutbox } from "./store";
import { MIGRATIONS, migrationChecksum } from "./migrations";

const COLS = ["tenant_id", "account_id", "reservation_id", "unit", "reserved", "created_at_ms", "expires_at_ms", "due_at_ms", "orphan_remainder", "state", "charge_attempt_id", "charge_amount", "close_remainder", "close_origin", "attempts", "last_error_code", "dead_reason", "settled_at_ms"] as const;
const BASE: Record<string, unknown> = {
  tenant_id: "t1",
  account_id: "a1",
  reservation_id: "r1",
  unit: "IRR_MICROS",
  reserved: 500,
  created_at_ms: 1000,
  expires_at_ms: 61000,
  due_at_ms: 11000,
  orphan_remainder: "forfeit",
  state: "open",
  charge_attempt_id: null,
  charge_amount: null,
  close_remainder: null,
  close_origin: null,
  attempts: 0,
  last_error_code: null,
  dead_reason: null,
  settled_at_ms: null,
};
const INSERT = `INSERT INTO {{s}}.settlement_outbox (${COLS.join(", ")}) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(", ")})`;
const SETTLING = { state: "settling", charge_attempt_id: "a1", charge_amount: 10 };
const DONE = { state: "done", close_remainder: "release", close_origin: "caller", settled_at_ms: 20000 };
const DEAD = { state: "dead", dead_reason: "LEDGER_REJECTED", settled_at_ms: 20000 };

dbDescribe("settlement/pg · قیدها و TRIGGERهای پایگاه", () => {
  const opened: TestOutbox[] = [];
  afterEach(async () => {
    while (opened.length > 0) await (opened.pop() as TestOutbox).dispose();
  });
  async function fresh(): Promise<TestOutbox> {
    const t = await openPgOutbox(4);
    opened.push(t);
    return t;
  }
  const ins = (t: TestOutbox, over: Record<string, unknown> = {}) => t.raw(INSERT, COLS.map((c) => ({ ...BASE, ...over })[c]));
  /** پایگاه باید با خطای کلاس ۲۳ (نقض قید) رد کند؛ `needle` در نام قید یا پیام می‌آید. */
  async function rejects(p: Promise<unknown>, needle?: string): Promise<void> {
    let err: unknown = null;
    try {
      await p;
    } catch (e) {
      err = e;
    }
    expect(err, "باید رد می‌شد").not.toBeNull();
    const e = err as { code?: string; constraint?: string; message?: string };
    expect(e.code?.startsWith("23"), `کد ${e.code}: ${e.message}`).toBe(true);
    if (needle !== undefined) expect(`${e.constraint ?? ""} ${e.message ?? ""}`).toContain(needle);
  }
  const states = async (t: TestOutbox) => (await t.raw("SELECT state, count(*)::int AS n FROM {{s}}.settlement_outbox GROUP BY state ORDER BY state")).map((r) => `${r["state"]}:${r["n"]}`);

  it("ردیفِ معتبر پذیرفته می‌شود (پایهٔ همهٔ آزمون‌های رد)", async () => {
    const t = await fresh();
    await ins(t);
    await ins(t, { reservation_id: "r2", ...SETTLING });
    await ins(t, { reservation_id: "r3", ...SETTLING, ...DONE });
    await ins(t, { reservation_id: "r4", ...DEAD });
    await ins(t, { reservation_id: "r5", ...DONE, charge_attempt_id: null });
    await ins(t, { reservation_id: "r6", charge_amount: 0, charge_attempt_id: "a1", state: "settling" });
    expect(await states(t)).toEqual(["dead:1", "done:2", "open:1", "settling:2"]);
  });

  it.each([
    ["tenant_id با فاصله", { tenant_id: "bad id" }, "settlement_id_ck"],
    ["account_id تهی‌رشته", { account_id: "" }, "settlement_id_ck"],
    ["reservation_id با نویسهٔ شروعِ نقطه", { reservation_id: ".x" }, "settlement_id_ck"],
    ["reservation_id ۱۲۹ نویسه", { reservation_id: "x".repeat(129) }, "settlement_id_ck"],
    ["reservation_id با خط جدید پایانی", { reservation_id: "ok\n" }, "settlement_id_ck"],
    ["charge_attempt_id نامعتبر", { ...SETTLING, charge_attempt_id: "a b" }, "settlement_id_ck"],
    ["unit حروف کوچک", { unit: "irr" }, "settlement_unit_ck"],
    ["unit بسیار کوتاه", { unit: "I" }, "settlement_unit_ck"],
    ["reserved منفی", { reserved: -1 }, "settlement_count_ck"],
    ["reserved از سقفِ صحیح ایمن بزرگ‌تر", { reserved: "9007199254740992" }, "settlement_count_ck"],
    ["due_at_ms منفی", { due_at_ms: -5 }, "settlement_count_ck"],
    ["attempts منفی", { attempts: -1 }, "settlement_count_ck"],
    ["reserved صفر", { reserved: 0 }, "settlement_outbox_reserved_ck"],
    ["orphan_remainder نامعتبر", { orphan_remainder: "keep" }, "settlement_outbox_orphan_ck"],
    ["state نامعتبر", { state: "weird" }, "settlement_outbox_state_ck"],
    ["last_error_code حروف کوچک", { last_error_code: "store failure" }, "settlement_error_code_ck"],
    ["dead_reason نامعتبر", { ...DEAD, dead_reason: "NOPE" }, "settlement_outbox_dead_reason_ck"],
    ["شکلِ مصرف: شناسه بی‌مبلغ", { ...SETTLING, charge_amount: null }, "settlement_outbox_charge_shape_ck"],
    ["شکلِ مصرف: مبلغ بی‌شناسه", { ...SETTLING, charge_attempt_id: null }, "settlement_outbox_charge_shape_ck"],
    ["شکلِ بستن: باقیمانده بی‌origin", { ...DONE, close_origin: null }, "settlement_outbox_close_shape_ck"],
    ["شکلِ بستن: origin بی‌باقیمانده", { ...DONE, close_remainder: null }, "settlement_outbox_close_shape_ck"],
    ["مقدارِ بستن: باقیمانده نامعتبر", { ...DONE, close_remainder: "keep" }, "settlement_outbox_close_values_ck"],
    ["مقدارِ بستن: origin نامعتبر", { ...DONE, close_origin: "someone" }, "settlement_outbox_close_values_ck"],
    ["open با قصدِ مصرف", { state: "open", charge_attempt_id: "a1", charge_amount: 1 }, "settlement_outbox_state_shape_ck"],
    ["open با قصدِ بستن", { state: "open", close_remainder: "release", close_origin: "caller" }, "settlement_outbox_state_shape_ck"],
    ["open با زمانِ پایان", { state: "open", settled_at_ms: 5 }, "settlement_outbox_state_shape_ck"],
    ["open با دلیلِ مرگ", { state: "open", dead_reason: "LEDGER_REJECTED" }, "settlement_outbox_state_shape_ck"],
    ["settling بی‌هیچ قصد", { state: "settling" }, "settlement_outbox_state_shape_ck"],
    ["settling با زمانِ پایان", { ...SETTLING, settled_at_ms: 5 }, "settlement_outbox_state_shape_ck"],
    ["settling با دلیلِ مرگ", { ...SETTLING, dead_reason: "LEDGER_REJECTED" }, "settlement_outbox_state_shape_ck"],
    ["done بی‌قصدِ بستن (فقط مصرف)", { state: "done", charge_attempt_id: "a1", charge_amount: 1, settled_at_ms: 5 }, "settlement_outbox_state_shape_ck"],
    ["done بی‌زمانِ پایان", { ...DONE, settled_at_ms: null }, "settlement_outbox_state_shape_ck"],
    ["done با دلیلِ مرگ", { ...DONE, dead_reason: "LEDGER_REJECTED" }, "settlement_outbox_state_shape_ck"],
    ["dead بی‌دلیل", { ...DEAD, dead_reason: null }, "settlement_outbox_state_shape_ck"],
    ["dead بی‌زمان", { ...DEAD, settled_at_ms: null }, "settlement_outbox_state_shape_ck"],
  ])("درج رد می‌شود: %s", async (_label, over, constraint) => {
    const t = await fresh();
    await rejects(ins(t, over), constraint);
    expect(await states(t)).toEqual([]);
  });

  it("کلیدِ تکراری رد می‌شود (UNIQUE)؛ همان reservationId در حسابِ دیگر مجاز است", async () => {
    const t = await fresh();
    await ins(t);
    await rejects(ins(t), "settlement_outbox_pk");
    await ins(t, { account_id: "a2" });
    await ins(t, { tenant_id: "t2" });
    expect(await states(t)).toEqual(["open:3"]);
  });

  it("ستون‌های اجباری NULL نمی‌پذیرند", async () => {
    const t = await fresh();
    for (const c of ["unit", "reserved", "created_at_ms", "expires_at_ms", "due_at_ms", "orphan_remainder", "state", "attempts", "tenant_id"]) await rejects(ins(t, { [c]: null }));
  });

  describe("TRIGGER: به‌روزرسانی", () => {
    const upd = (t: TestOutbox, set: string, id = "r1") => t.raw(`UPDATE {{s}}.settlement_outbox SET ${set} WHERE reservation_id = '${id}'`);

    it("به‌روزرسانی‌های مجاز: open→settling با مصرف، قصدِ بستن، سررسیدِ تازه، افزایش تلاش، settling→done، settling→dead", async () => {
      const t = await fresh();
      await ins(t);
      await upd(t, "charge_attempt_id = 'a1', charge_amount = 5, state = 'settling'");
      await upd(t, "attempts = attempts + 1, due_at_ms = 99000, last_error_code = 'STORE_FAILURE'");
      await upd(t, "close_remainder = 'release', close_origin = 'sweeper'");
      await upd(t, "state = 'done', settled_at_ms = 5");
      await ins(t, { reservation_id: "r2" });
      await upd(t, "state = 'dead', dead_reason = 'EXPIRED_UNBILLED', settled_at_ms = 7", "r2");
      expect(await states(t)).toEqual(["dead:1", "done:1"]);
    });

    it.each([
      ["tenant_id", "tenant_id = 'zz'"],
      ["account_id", "account_id = 'zz'"],
      ["reservation_id", "reservation_id = 'zz'"],
      ["unit", "unit = 'USD_MICROS'"],
      ["reserved", "reserved = reserved + 1"],
      ["created_at_ms", "created_at_ms = created_at_ms + 1"],
      ["expires_at_ms", "expires_at_ms = expires_at_ms + 1"],
      ["orphan_remainder", "orphan_remainder = 'release'"],
    ])("هویت و واقعیت‌های آغاز تغییرناپذیرند: %s", async (_c, set) => {
      const t = await fresh();
      await ins(t);
      await rejects(upd(t, set), "immutable");
    });

    it("قصدِ مصرف نوشتن‌یک‌بار است: تغییر شناسه/مبلغ و حذفِ آن رد می‌شود", async () => {
      const t = await fresh();
      await ins(t, SETTLING);
      await rejects(upd(t, "charge_amount = 11"), "write-once");
      await rejects(upd(t, "charge_attempt_id = 'a2'"), "write-once");
      await rejects(upd(t, "charge_attempt_id = NULL, charge_amount = NULL, state = 'settling'"), "write-once");
      expect((await t.raw("SELECT charge_amount::int AS c FROM {{s}}.settlement_outbox"))[0]?.["c"]).toBe(10);
    });

    it("قصدِ بستن نوشتن‌یک‌بار است و آخرین قصد: تغییر/حذف و مصرفِ پس از آن رد می‌شود", async () => {
      const t = await fresh();
      await ins(t, { state: "settling", close_remainder: "release", close_origin: "caller" });
      await rejects(upd(t, "close_remainder = 'forfeit'"), "write-once");
      await rejects(upd(t, "close_origin = 'sweeper'"), "write-once");
      await rejects(upd(t, "close_remainder = NULL, close_origin = NULL, charge_attempt_id = 'a1', charge_amount = 1"), "write-once");
      await rejects(upd(t, "charge_attempt_id = 'a1', charge_amount = 1"), "no charge intent after the close");
    });

    it("تلاش هرگز کم نمی‌شود؛ settling هرگز به open برنمی‌گردد (TRIGGER پیش از CHECK می‌گیرد)", async () => {
      const t = await fresh();
      await ins(t, { ...SETTLING, attempts: 3 });
      await rejects(upd(t, "attempts = 2"), "never decrease");
      await rejects(upd(t, "state = 'open'"), "never returns to open");
    });

    it("مرحلهٔ نهایی بی‌بازگشت: هر به‌روزرسانیِ done/dead (حتی بی‌اثر) رد می‌شود", async () => {
      const t = await fresh();
      await ins(t, { reservation_id: "d1", ...DONE });
      await ins(t, { reservation_id: "d2", ...DEAD });
      for (const id of ["d1", "d2"]) {
        await rejects(upd(t, "due_at_ms = 5", id), "final");
        await rejects(upd(t, "attempts = attempts + 1", id), "final");
        await rejects(upd(t, "state = 'open'", id), "final");
        await rejects(upd(t, "dead_reason = 'EXPIRED_UNBILLED', state = 'dead'", id), "final");
        await rejects(upd(t, "last_error_code = NULL", id), "final");
      }
      expect(await states(t)).toEqual(["dead:1", "done:1"]);
    });
  });

  describe("TRIGGER: حذف و TRUNCATE", () => {
    it("هیچ رکوردی حذف نمی‌شود، حتی open/done/dead (رکورد مرده هرگز خودکار حذف نمی‌شود)", async () => {
      const t = await fresh();
      await ins(t, { reservation_id: "a" });
      await ins(t, { reservation_id: "b", ...DONE });
      await ins(t, { reservation_id: "c", ...DEAD });
      await rejects(t.raw("DELETE FROM {{s}}.settlement_outbox WHERE reservation_id = 'a'"), "never deleted");
      await rejects(t.raw("DELETE FROM {{s}}.settlement_outbox WHERE reservation_id = 'b'"), "never deleted");
      await rejects(t.raw("DELETE FROM {{s}}.settlement_outbox"), "never deleted");
      expect(await states(t)).toEqual(["dead:1", "done:1", "open:1"]);
    });
    it("TRUNCATE رد می‌شود", async () => {
      const t = await fresh();
      await ins(t);
      await rejects(t.raw("TRUNCATE {{s}}.settlement_outbox"), "never truncated");
      await rejects(t.raw("TRUNCATE {{s}}.settlement_outbox CASCADE"), "never truncated");
      expect(await states(t)).toEqual(["open:1"]);
    });
  });

  describe("ایندکس‌ها و ترتیب", () => {
    it("ایندکس‌های جزئی و حالت وجود دارند؛ فقط رکوردهای فعال در ایندکس سررسید", async () => {
      const t = await fresh();
      const idx = (await t.raw("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'settlement_outbox' ORDER BY indexname", [t.schema])).map((r) => `${r["indexname"]}`);
      expect(idx).toEqual(["settlement_outbox_dead_idx", "settlement_outbox_due_idx", "settlement_outbox_pk", "settlement_outbox_state_idx"]);
      const due = (await t.raw("SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'settlement_outbox_due_idx'", [t.schema]))[0]?.["indexdef"] as string;
      expect(due).toMatch(/WHERE .*state.*(open|settling)/);
    });
    it("برنامهٔ اجرای listDue و listDead از ایندکسِ جزئی استفاده می‌کند (با seqscan خاموش)", async () => {
      const t = await fresh();
      for (let i = 0; i < 5; i++) await ins(t, { reservation_id: `r${i}`, due_at_ms: 1000 * i });
      await t.session(async (q) => {
        await q("SET LOCAL enable_seqscan = off");
        const plan = (await q("EXPLAIN SELECT * FROM {{s}}.settlement_outbox WHERE state IN ('open', 'settling') AND due_at_ms <= 3000 ORDER BY due_at_ms, tenant_id, account_id, reservation_id LIMIT 10")).map((r) => r["QUERY PLAN"]).join("\n");
        expect(plan).toContain("settlement_outbox_due_idx");
        expect(plan).not.toMatch(/\bSort\b/);
        const dead = (await q("EXPLAIN SELECT * FROM {{s}}.settlement_outbox WHERE state = 'dead' ORDER BY settled_at_ms, tenant_id, account_id, reservation_id LIMIT 10")).map((r) => r["QUERY PLAN"]).join("\n");
        expect(dead).toContain("settlement_outbox_dead_idx");
        expect(dead, "ترتیبِ listDead باید از خودِ ایندکس بیاید").not.toMatch(/\bSort\b/);
      });
    });
    it("ستون‌های شناسه صریحاً COLLATE C دارند (مستقل از locale پیش‌فرضِ پایگاه؛ بر محیطی که پیش‌فرضش C است هم ثابت می‌کند)", async () => {
      const t = await fresh();
      await ins(t, SETTLING);
      const row = (await t.raw("SELECT pg_collation_for(tenant_id)::text AS a, pg_collation_for(account_id)::text AS b, pg_collation_for(reservation_id)::text AS c, pg_collation_for(charge_attempt_id)::text AS d FROM {{s}}.settlement_outbox"))[0];
      expect(row).toEqual({ a: '"C"', b: '"C"', c: '"C"', d: '"C"' });
    });
    it("ترتیبِ شناسه نقطه‌کدی است (COLLATE C)، نه وابسته به locale: B < a < a-b < a.b < a_b (برخلافِ en_US)", async () => {
      const t = await fresh();
      const ids = ["a_b", "a.b", "a-b", "a", "B", "A", "a1", "Z", "0"];
      for (const id of ids) await ins(t, { reservation_id: id, due_at_ms: 5 });
      const got = await t.outbox.listDue({ nowMs: 5, limit: 50 });
      expect(got.ok && got.value.map((e) => e.reservationId)).toEqual([...ids].sort());
      expect([...ids].sort()).toEqual(["0", "A", "B", "Z", "a", "a-b", "a.b", "a1", "a_b"]);
    });
  });

  describe("مهاجرت", () => {
    it("migrate: بار اول اعمال، بار دوم alreadyApplied؛ status هماهنگ", async () => {
      const t = await openPgOutbox(4, newSchemaName(), false);
      opened.push(t);
      const before = await t.outbox.status();
      expect(before).toEqual({ ok: true, value: { applied: [], pending: ["0001_init"] } });
      expect(await t.outbox.migrate()).toEqual({ ok: true, value: { applied: ["0001_init"], alreadyApplied: [] } });
      expect(await t.outbox.migrate()).toEqual({ ok: true, value: { applied: [], alreadyApplied: ["0001_init"] } });
      expect(await t.outbox.status()).toEqual({ ok: true, value: { applied: ["0001_init"], pending: [] } });
      const row = (await t.raw("SELECT name, checksum FROM {{s}}.settlement_migration_ledger"))[0];
      expect(row).toEqual({ name: "0001_init", checksum: migrationChecksum(MIGRATIONS[0] as never) });
    });

    it("status روی شِمای ناموجود: همه معلق و چیزی نمی‌سازد (فقط‌خواندنی)", async () => {
      const t = await openPgOutbox(4, newSchemaName(), false);
      opened.push(t);
      expect(await t.outbox.status()).toEqual({ ok: true, value: { applied: [], pending: ["0001_init"] } });
      expect(await t.raw("SELECT 1 FROM pg_namespace WHERE nspname = $1", [t.schema])).toHaveLength(0);
    });

    it("پیش از migrate همهٔ عملیات STORE_FAILURE است (شِما نیست)؛ پس از migrate کار می‌کند", async () => {
      const t = await openPgOutbox(4, newSchemaName(), false);
      opened.push(t);
      const ref = { tenantId: "t1", accountId: "a1", reservationId: "r1" };
      expect(await t.outbox.counts()).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
      expect(await t.outbox.get(ref)).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
      expect(await t.outbox.begin({ ...ref, unit: "IRR_MICROS", reserved: 1, createdAtMs: 1, expiresAtMs: 9, dueAtMs: 5, orphanRemainder: "forfeit" })).toMatchObject({ ok: false });
      await t.outbox.migrate();
      expect(await t.outbox.counts()).toEqual({ ok: true, value: { open: 0, settling: 0, done: 0, dead: 0 } });
    });

    it("۸ migrate هم‌زمان روی شِمای تازه: همه موفق، دقیقاً یکی اعمال می‌کند", async () => {
      const schema = newSchemaName();
      const t = await openPgOutbox(4, schema, false);
      opened.push(t);
      const many = await Promise.all(Array.from({ length: 8 }, async () => (await t.reopen()).outbox.migrate()));
      expect(many.every((r) => r.ok)).toBe(true);
      expect(many.filter((r) => r.ok && r.value.applied.length === 1)).toHaveLength(1);
      expect(many.filter((r) => r.ok && r.value.alreadyApplied.length === 1)).toHaveLength(7);
      expect(await t.raw("SELECT count(*)::int AS n FROM {{s}}.settlement_migration_ledger")).toEqual([{ n: 1 }]);
    });

    it("مهاجرتِ ناقص اتمی است: خطا در دستورِ k ⇒ هیچ شِما/جدولی نمی‌ماند، و migrate بعدی سالم اعمال می‌شود", async () => {
      const schema = newSchemaName();
      const t = await openPgOutbox(4, schema, false);
      opened.push(t);
      const total = (MIGRATIONS[0] as { statements: readonly string[] }).statements.length;
      for (const k of [1, 4, 5, total - 1, total]) {
        let n = 0;
        const flaky: LedgerDatabase = {
          execute: (q) => t.db.execute(q),
          transaction: (run, cfg) =>
            t.db.transaction(
              (tx) =>
                run({
                  execute: async (q) => {
                    n += 1;
                    if (n === k + 4) throw new Error("boom"); // ۴ دستورِ نخست: قفل، شِما، جدولِ دفتر، خواندنِ دفتر
                    return tx.execute(q);
                  },
                }),
              cfg,
            ),
        };
        const broken = createPgSettlementOutbox(flaky, { schema });
        if (!broken.ok) throw new Error("x");
        const r = await broken.value.migrate();
        expect(r, `k=${k}`).toMatchObject({ ok: false, error: { code: "DB_ERROR" } });
        expect(await t.raw("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema]), `k=${k}: شِما نباید بماند`).toHaveLength(0);
      }
      expect(await t.outbox.migrate()).toMatchObject({ ok: true, value: { applied: ["0001_init"] } });
    });

    it("سپر checksum: مهاجرتِ دست‌کاری‌شده ⇒ همهٔ عملیات، status و migrate خطا (MIGRATION_TAMPERED)؛ بازگرداندن آن را درست می‌کند", async () => {
      const t = await fresh();
      const good = (await t.raw("SELECT checksum FROM {{s}}.settlement_migration_ledger"))[0]?.["checksum"];
      await t.raw("UPDATE {{s}}.settlement_migration_ledger SET checksum = $1", ["0".repeat(64)]);
      expect(await t.outbox.counts()).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
      expect(await t.outbox.listDue({ nowMs: 1, limit: 1 })).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
      expect(await t.outbox.status()).toMatchObject({ ok: false, error: { code: "MIGRATION_TAMPERED" } });
      expect(await t.outbox.migrate()).toMatchObject({ ok: false, error: { code: "MIGRATION_TAMPERED" } });
      await t.raw("UPDATE {{s}}.settlement_migration_ledger SET checksum = $1", [good]);
      expect(await t.outbox.counts()).toMatchObject({ ok: true });
    });

    it("پایگاهِ «از آینده»: مهاجرتِ ناشناخته ⇒ MIGRATION_UNKNOWN و عملیات رد می‌شود", async () => {
      const t = await fresh();
      await t.raw("INSERT INTO {{s}}.settlement_migration_ledger (name, checksum) VALUES ('0099_future', 'x')");
      expect(await t.outbox.status()).toMatchObject({ ok: false, error: { code: "MIGRATION_UNKNOWN" } });
      expect(await t.outbox.counts()).toMatchObject({ ok: false, error: { code: "STORE_FAILURE" } });
    });

    it("هم‌زیستی با دفتر اعتبار در یک شِما (هر دو ترتیب): دفترهای مهاجرت جدا، هیچ‌کدام دیگری را «ناشناخته» نمی‌بیند", async () => {
      for (const ledgerFirst of [true, false]) {
        const t = await openPgOutbox(4, newSchemaName(), false);
        opened.push(t);
        const ledgerStore = createPgAccountStore(t.db, { schema: t.schema });
        if (!ledgerStore.ok) throw new Error("x");
        if (ledgerFirst) expect((await ledgerStore.value.migrate()).ok).toBe(true);
        expect((await t.outbox.migrate()).ok).toBe(true);
        if (!ledgerFirst) expect((await ledgerStore.value.migrate()).ok).toBe(true);
        expect(await ledgerStore.value.status()).toMatchObject({ ok: true, value: { pending: [] } });
        expect(await t.outbox.status()).toMatchObject({ ok: true, value: { pending: [] } });
        // هر دو واقعاً کار می‌کنند
        const clock = { nowMs: () => 5_000 };
        const ledger = createLedger({ store: ledgerStore.value, clock });
        if (!ledger.ok) throw new Error("x");
        const key = { tenantId: "t1", accountId: "a1" };
        expect((await ledger.value.openAccount({ ...key, unit: "IRR_MICROS" })).ok).toBe(true);
        expect(await t.outbox.begin({ ...key, reservationId: "r1", unit: "IRR_MICROS", reserved: 5, createdAtMs: 1, expiresAtMs: 9, dueAtMs: 5, orphanRemainder: "forfeit" })).toEqual({ ok: true, value: { replayed: false } });
        const names = (await t.raw("SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name", [t.schema])).map((r) => r["table_name"]);
        expect(names).toContain("migration_ledger");
        expect(names).toContain("settlement_migration_ledger");
        expect(names).toContain("settlement_outbox");
      }
    });

    it("شِماها جدا هستند: رکوردِ یک شِما در شِمای دیگر دیده نمی‌شود", async () => {
      const a = await fresh();
      const b = await fresh();
      const ref = { tenantId: "t1", accountId: "a1", reservationId: "r1" };
      await a.outbox.begin({ ...ref, unit: "IRR_MICROS", reserved: 5, createdAtMs: 1, expiresAtMs: 9, dueAtMs: 5, orphanRemainder: "forfeit" });
      expect(await a.outbox.get(ref)).toMatchObject({ ok: true, value: { state: "open" } });
      expect(await b.outbox.get(ref)).toEqual({ ok: true, value: null });
      expect(await b.outbox.counts()).toEqual({ ok: true, value: { open: 0, settling: 0, done: 0, dead: 0 } });
    });
  });
});
