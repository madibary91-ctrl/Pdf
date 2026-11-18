/** آزمون‌های واحدِ آداپتور PostgreSQL که پایگاه نمی‌خواهند: مهاجرت‌ها، نام‌گذاری، نگاشت خطا، ردیف‌ها (ADR-0019). */
import { describe, expect, it } from "vitest";
import { LedgerStoreError, mapDbError, toStoreError } from "./errors";
import { reconcile } from "./migrate";
import { MIGRATIONS, migrationChecksum, renderStatement, type Migration } from "./migrations";
import { lockName, parseSchemaName, tableRef } from "./naming";
import { int, processedCanon, reservationCanon, stateFromRows } from "./rows";
import type { Processed, Reservation } from "../types";

describe("ledger/pg · مهاجرت‌ها", () => {
  it("نام‌ها قالب NNNN_slug دارند، یکتا و صعودی‌اند", () => {
    const names = MIGRATIONS.map((m) => m.name);
    for (const n of names) expect(n).toMatch(/^\d{4}_[a-z0-9_]+$/);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(names);
    expect(names[0]).toBe("0001_init");
  });

  it("checksum مهاجرت ۰۰۰۱ قفل است (مهاجرتِ اعمال‌شده هرگز ویرایش نمی‌شود؛ تغییر = مهاجرت تازه)", () => {
    expect(migrationChecksum(MIGRATIONS[0] as Migration)).toBe("b8e206bab04a421237ed900a5174335d9829368f4e72499c7bbc904e2f69e38a");
  });

  it("هر دستور غیرتهی است و هر شیء را در `{{schema}}` می‌سازد (هرگز در public یا بی‌شِما)", () => {
    for (const m of MIGRATIONS) {
      expect(m.statements.length).toBeGreaterThan(0);
      for (const st of m.statements) {
        expect(st.trim()).not.toBe("");
        expect(st).not.toMatch(/\bpublic\b/i);
        expect(st).not.toMatch(/"/); // نقل‌قول فقط هنگام render و با sql.identifier
        const create = /^\s*CREATE\s+(?:UNIQUE\s+)?(DOMAIN|TABLE|FUNCTION|INDEX|TRIGGER)\s+(?:IF NOT EXISTS\s+)?(\S+)/i.exec(st);
        expect(create, st.slice(0, 60)).not.toBeNull();
        const [, kind, first] = create as RegExpExecArray;
        const onTarget = /\sON\s+(\S+)/.exec(st.split("\n")[0] ?? "")?.[1];
        if (kind === "TRIGGER") expect(onTarget ?? "", st.slice(0, 80)).toMatch(/^\{\{schema\}\}\./);
        else if (kind === "INDEX") expect(onTarget ?? "", st.slice(0, 80)).toMatch(/^\{\{schema\}\}\./);
        else expect(first, st.slice(0, 80)).toMatch(/^\{\{schema\}\}\./);
      }
    }
  });

  it("قیدهای بنیادین در مهاجرت هستند (بقا، فقط‌افزودنی، بی‌حفره، یکنوا، بسته نهایی است)", () => {
    const sqlText = (MIGRATIONS[0] as Migration).statements.join("\n");
    for (const needle of [
      "account_conservation_ck",
      "granted + refunded = available + held + charged + forfeited",
      "reservation_arithmetic_ck",
      "journal_append_only",
      "journal_no_truncate",
      "processed_append_only",
      "journal_gapless",
      "account_guard",
      "reservation_guard",
      "a closed reservation is final",
      "attempts_only_refunds_grow",
      "9007199254740991",
      "ON DELETE RESTRICT",
      "coalesce((receipt ->> 'kind')",
    ]) {
      expect(sqlText, needle).toContain(needle);
    }
  });

  it("renderStatement همهٔ `{{schema}}`ها را با نامِ نقل‌قول‌شده جایگزین می‌کند", () => {
    expect(renderStatement("A {{schema}}.x B {{schema}}.y", "ledger_t")).toBe('A "ledger_t".x B "ledger_t".y');
    for (const st of MIGRATIONS.flatMap((m) => m.statements)) expect(renderStatement(st, "ledger_t")).not.toContain("{{");
  });

  it("migrationChecksum به نام و هر دستور حساس است", () => {
    const base: Migration = { name: "0001_x", statements: ["a", "b"] };
    const c = migrationChecksum(base);
    expect(migrationChecksum({ ...base, name: "0002_x" })).not.toBe(c);
    expect(migrationChecksum({ ...base, statements: ["a", "c"] })).not.toBe(c);
    expect(migrationChecksum({ ...base, statements: ["b", "a"] })).not.toBe(c);
    expect(migrationChecksum({ ...base, statements: ["a", "b", ""] })).not.toBe(c);
    expect(migrationChecksum(base)).toBe(c);
  });
});

describe("ledger/pg · reconcile (دفتر مهاجرت ⇄ کد)", () => {
  const two: readonly Migration[] = [
    { name: "0001_a", statements: ["x"] },
    { name: "0002_b", statements: ["y"] },
  ];
  const row = (m: Migration, checksum = migrationChecksum(m)) => ({ name: m.name, checksum });
  const code = (f: () => unknown): string | null => {
    try {
      f();
      return null;
    } catch (e) {
      return e instanceof LedgerStoreError ? e.error.code : "other";
    }
  };

  it("دفتر تهی ⇒ همه معلق؛ همهٔ اعمال‌شده ⇒ هیچ معلق", () => {
    expect(reconcile([], two)).toEqual({ applied: [], pending: ["0001_a", "0002_b"] });
    expect(reconcile([row(two[0] as Migration)], two)).toEqual({ applied: ["0001_a"], pending: ["0002_b"] });
    expect(reconcile(two.map((m) => row(m)), two)).toEqual({ applied: ["0001_a", "0002_b"], pending: [] });
  });
  it("مهاجرت ناشناخته ⇒ MIGRATION_UNKNOWN (پایگاه از آینده)", () => {
    expect(code(() => reconcile([{ name: "0003_c", checksum: "x" }], two))).toBe("MIGRATION_UNKNOWN");
  });
  it("checksum ناهمخوان ⇒ MIGRATION_TAMPERED", () => {
    expect(code(() => reconcile([row(two[0] as Migration, "bad")], two))).toBe("MIGRATION_TAMPERED");
  });
  it("حفره (بعدی اعمال شده، قبلی نه) ⇒ MIGRATION_TAMPERED", () => {
    expect(code(() => reconcile([row(two[1] as Migration)], two))).toBe("MIGRATION_TAMPERED");
  });
  it("پیام‌ها نام مهاجرت را می‌گویند و checksum را نمی‌آورند", () => {
    try {
      reconcile([row(two[0] as Migration, "deadbeef")], two);
    } catch (e) {
      const msg = (e as LedgerStoreError).error.message;
      expect(msg).toContain("0001_a");
      expect(msg).not.toContain("deadbeef");
    }
  });
});

describe("ledger/pg · نام شِما و قفل", () => {
  it.each(["ledger", "ledger_test_ab12", "a", "x".repeat(40), "l1"])("نام معتبر: %s", (n) => {
    expect(parseSchemaName(n)).toEqual({ ok: true, value: n });
  });
  it.each(["", "Ledger", "1ledger", "led ger", "led-ger", "ledger;drop", 'led"ger', "public", "information_schema", "pg_catalog", "pg_x", "x".repeat(41), "لجر", "ledger\n"])("نام نامعتبر: %j", (n) => {
    const r = parseSchemaName(n);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("INVALID_INPUT");
      const constant = parseSchemaName("Bad!");
      expect(constant.ok ? "" : constant.error.message).toBe(r.error.message); // پیام ثابت است، پس بی‌پژواک
    }
  });
  it.each([undefined, null, 1, {}, [], true])("نوع نامعتبر: %j", (v) => {
    expect(parseSchemaName(v).ok).toBe(false);
  });

  it("tableRef شناسه را نقل‌قول می‌کند", () => {
    const q = tableRef("ledger_t", "account");
    expect(JSON.stringify(q.queryChunks)).toContain("ledger_t");
  });

  it("lockName بی‌ابهام است: ('a','bc') ≠ ('ab','c')؛ شِمای دیگر ≠؛ حساب دیگر ≠", () => {
    const names = [
      lockName("s", { tenantId: "a", accountId: "bc" }),
      lockName("s", { tenantId: "ab", accountId: "c" }),
      lockName("s", { tenantId: "a:b", accountId: "c" }),
      lockName("s", { tenantId: "a", accountId: "b:c" }),
      lockName("t", { tenantId: "a", accountId: "bc" }),
      lockName("s", { tenantId: "a", accountId: "bd" }),
    ];
    expect(new Set(names).size).toBe(names.length);
    expect(lockName("s", { tenantId: "a", accountId: "bc" })).toBe(lockName("s", { tenantId: "a", accountId: "bc" }));
  });
});

describe("ledger/pg · نگاشت خطا", () => {
  const pgErr = (code: string, constraint?: string) => Object.assign(new Error("Failed query: SELECT secret FROM x params: hunter2"), { code, ...(constraint ? { constraint } : {}) });
  it("42P01 و 3F000 ⇒ NOT_MIGRATED", () => {
    expect(mapDbError(pgErr("42P01")).code).toBe("NOT_MIGRATED");
    expect(mapDbError(pgErr("3F000")).code).toBe("NOT_MIGRATED");
  });
  it("کلاس ۲۳ (قید) ⇒ COMMIT_REJECTED با نام قید", () => {
    for (const c of ["23000", "23505", "23514", "23503", "23P01"]) {
      const e = mapDbError(pgErr(c, "some_ck"));
      expect(e.code).toBe("COMMIT_REJECTED");
      expect(e.pgCode).toBe(c);
      expect(e.constraint).toBe("some_ck");
    }
  });
  it("خطای drizzle که pg را در cause می‌پیچد هم پیدا می‌شود", () => {
    const wrapped = new Error("Failed query", { cause: new Error("outer", { cause: pgErr("23514", "x_ck") }) });
    expect(mapDbError(wrapped)).toMatchObject({ code: "COMMIT_REJECTED", pgCode: "23514", constraint: "x_ck" });
  });
  it("هر چیز دیگر ⇒ DB_ERROR؛ پیام هرگز متن خطای خام، SQL یا پارامتر را نمی‌آورد", () => {
    for (const e of [pgErr("40001"), pgErr("57P01"), new Error("connect ECONNREFUSED 10.0.0.1:5432 as dbuser"), "text", null, undefined, 42, {}]) {
      const m = mapDbError(e);
      expect(["DB_ERROR"]).toContain(m.code);
      expect(m.message).not.toMatch(/hunter2|10\.0\.0\.1|dbuser|SELECT|ECONNREFUSED/);
    }
    for (const c of ["42P01", "23505", "40001"]) expect(mapDbError(pgErr(c)).message).not.toMatch(/hunter2|SELECT secret/);
  });
  it("کدِ غیر-SQLSTATE (مثل ECONNREFUSED خطای شبکهٔ Node) pgCode حساب نمی‌شود", () => {
    const e = mapDbError(Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }));
    expect(e.code).toBe("DB_ERROR");
    expect(e.pgCode).toBeUndefined();
    expect(mapDbError(Object.assign(new Error("x"), { code: "2305" })).pgCode).toBeUndefined(); // ۴ نویسه
    expect(mapDbError(Object.assign(new Error("x"), { code: "23a05" })).pgCode).toBeUndefined(); // حرف کوچک
  });
  it("LedgerStoreError دست‌نخورده می‌گذرد و toStoreError آن را دوباره نمی‌پیچد", () => {
    const own = new LedgerStoreError({ code: "CORRUPT_DATA", message: "m" });
    expect(mapDbError(own)).toEqual({ code: "CORRUPT_DATA", message: "m" });
    expect(toStoreError(own)).toBe(own);
    const wrapped = toStoreError(pgErr("40001"));
    expect(wrapped).toBeInstanceOf(LedgerStoreError);
    expect(wrapped.error.code).toBe("DB_ERROR");
  });
});

describe("ledger/pg · ردیف‌ها", () => {
  it("int: صحیح ایمنِ نامنفی از number/bigint/رشتهٔ pg؛ بقیه CORRUPT_DATA", () => {
    expect(int("0", "x")).toBe(0);
    expect(int("9007199254740991", "x")).toBe(Number.MAX_SAFE_INTEGER);
    expect(int(5, "x")).toBe(5);
    expect(int(BigInt(5), "x")).toBe(5);
    for (const bad of ["9007199254740992", "-1", "1.5", "1e3", "", " 1", "0x1", "12345678901234567", 9007199254740992, -1, 1.5, Number.NaN, BigInt("1152921504606846976"), null, undefined, {}, [], true]) {
      expect(() => int(bad, "x"), String(bad)).toThrow(LedgerStoreError);
    }
    try {
      int("zzz", "ستون‌من");
    } catch (e) {
      expect((e as LedgerStoreError).error.message).not.toContain("zzz");
    }
  });

  const attempt = { requested: 5, charged: 3, shortfall: 2, refunded: 1 };
  const acc = { unit: "MSG", created_at_ms: "1", last_at_ms: "2", seq: "3", available: "4", held: "5", granted: "6", charged: "7", forfeited: "8", refunded: "9", shortfall: "10" };
  const res = (over: Record<string, unknown> = {}) => ({ reservation_id: "r1", amount: "10", remaining: "7", charged: "3", closed_amount: "0", status: "open", closed_by: null, created_at_ms: "1", expires_at_ms: "9", closed_at_ms: null, attempts: { a1: attempt }, ...over });
  const proc = (over: Record<string, unknown> = {}) => ({ op_key: "grant:g1", fingerprint: "[]", receipt: { kind: "grant", grantId: "g1", amount: 1, availableAfter: 1 }, ...over });
  const key = { tenantId: "t", accountId: "a" };

  it("stateFromRows یک حالت کامل می‌سازد (bigint رشته‌ای → عدد)", () => {
    const s = stateFromRows(key, acc, [res()], [proc()]);
    expect(s).toMatchObject({ tenantId: "t", accountId: "a", unit: "MSG", createdAtMs: 1, lastAtMs: 2, seq: 3, available: 4, held: 5, totals: { granted: 6, charged: 7, forfeited: 8, refunded: 9, shortfall: 10 } });
    expect(s.reservations["r1"]).toEqual({ id: "r1", amount: 10, remaining: 7, charged: 3, status: "open", closedBy: null, closedAmount: 0, createdAtMs: 1, expiresAtMs: 9, closedAtMs: null, attempts: { a1: attempt } });
    expect(s.processed["grant:g1"]?.fingerprint).toBe("[]");
  });
  it("jsonb به‌صورت رشته هم پذیرفته می‌شود", () => {
    const s = stateFromRows(key, acc, [res({ attempts: JSON.stringify({ a1: attempt }) })], [proc({ receipt: JSON.stringify({ kind: "grant", n: 1 }) })]);
    expect(s.reservations["r1"]?.attempts["a1"]).toEqual(attempt);
  });
  it.each<[string, () => void]>([
    ["وضعیت نامعتبر", () => stateFromRows(key, acc, [res({ status: "x" })], [])],
    ["closed_by نامعتبر", () => stateFromRows(key, acc, [res({ closed_by: "x" })], [])],
    ["attempts آرایه", () => stateFromRows(key, acc, [res({ attempts: [] })], [])],
    ["attempts JSON خراب", () => stateFromRows(key, acc, [res({ attempts: "{" })], [])],
    ["کلید اضافه در تلاش", () => stateFromRows(key, acc, [res({ attempts: { a1: { ...attempt, extra: 1 } } })], [])],
    ["کلید کم در تلاش", () => stateFromRows(key, acc, [res({ attempts: { a1: { requested: 1 } } })], [])],
    ["شناسهٔ تلاش نامعتبر", () => stateFromRows(key, acc, [res({ attempts: { "a#1": attempt } })], [])],
    ["مقدار تلاش منفی", () => stateFromRows(key, acc, [res({ attempts: { a1: { ...attempt, charged: -1 } } })], [])],
    ["رزرو تکراری", () => stateFromRows(key, acc, [res(), res()], [])],
    ["کلید یکتای تکراری", () => stateFromRows(key, acc, [], [proc(), proc()])],
    ["رسید بدون kind", () => stateFromRows(key, acc, [], [proc({ receipt: { grantId: "g" } })])],
    ["رسید با kind ناشناخته", () => stateFromRows(key, acc, [], [proc({ receipt: { kind: "evil" } })])],
    ["رسید با مقدار تو در تو", () => stateFromRows(key, acc, [], [proc({ receipt: { kind: "grant", x: { y: 1 } } })])],
    ["رسید آرایه", () => stateFromRows(key, acc, [], [proc({ receipt: [] })])],
    ["unit نامتن", () => stateFromRows(key, { ...acc, unit: 5 }, [], [])],
    ["مبلغ حساب نامعتبر", () => stateFromRows(key, { ...acc, available: "-1" }, [], [])],
    ["مبلغ سرریز", () => stateFromRows(key, { ...acc, held: "9007199254740992" }, [], [])],
  ])("ردیف خراب ⇒ CORRUPT_DATA: %s", (_n, f) => {
    try {
      f();
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(LedgerStoreError);
      expect((e as LedgerStoreError).error.code).toBe("CORRUPT_DATA");
    }
  });

  const base = (): Reservation => ({ id: "r1", amount: 10, remaining: 7, charged: 3, status: "open", closedBy: null, closedAmount: 0, createdAtMs: 1, expiresAtMs: 9, closedAtMs: null, attempts: { b: { ...attempt }, a: { ...attempt } } });
  it("reservationCanon به ترتیب کلیدهای attempts حساس نیست ولی به هر مقدار حساس است", () => {
    const r = base();
    const reordered: Reservation = { ...r, attempts: { a: { ...attempt }, b: { ...attempt } } };
    expect(reservationCanon(reordered)).toBe(reservationCanon(r));
    const muts: Partial<Reservation>[] = [
      { remaining: 6 },
      { charged: 4 },
      { status: "closed" },
      { closedBy: "release" },
      { closedAmount: 1 },
      { closedAtMs: 5 },
      { expiresAtMs: 10 },
      { createdAtMs: 2 },
      { amount: 11 },
      { id: "r2" },
      { attempts: { a: { ...attempt, refunded: 0 }, b: { ...attempt } } },
      { attempts: { a: { ...attempt }, b: { ...attempt }, c: { ...attempt } } },
    ];
    for (const m of muts) expect(reservationCanon({ ...r, ...m }), JSON.stringify(m)).not.toBe(reservationCanon(r));
  });
  it("processedCanon به ترتیب کلیدهای رسید حساس نیست ولی به اثر انگشت و مقدار حساس است", () => {
    const p: Processed = { fingerprint: "f", receipt: { kind: "grant", grantId: "g", amount: 1, availableAfter: 1 } };
    const q: Processed = { fingerprint: "f", receipt: { availableAfter: 1, amount: 1, grantId: "g", kind: "grant" } };
    expect(processedCanon(q)).toBe(processedCanon(p));
    expect(processedCanon({ ...p, fingerprint: "g" })).not.toBe(processedCanon(p));
    expect(processedCanon({ ...p, receipt: { ...p.receipt, amount: 2 } as Processed["receipt"] })).not.toBe(processedCanon(p));
  });
});
