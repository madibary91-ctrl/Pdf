/**
 * دستورِ `down` (ADR-0049، م۳‑ه‑۴‑الف‑۲‑۴‑ب‑۲‑۲‑۲): آرگومان (`--yes`)، هستهٔ `executeDown` و نگاشتِ خطا روی نمایهٔ ساختگیِ اسکریپت‌پذیر (بی‌پایگاه).
 * آزمون‌های قفل‌شدهٔ ۰۰۴۷ (که `down` بی‌`--yes` را نامعتبر می‌دانند) دست‌نخورده‌اند؛ اینجا فقط افزوده می‌شود.
 */
import { describe, expect, it } from "vitest";
import type { LedgerDatabase } from "@/modules/ledger";
import { DEFAULT_TIMEOUT_MS, USAGE, parsePendingMigrateArgs } from "./args";
import { APPLY_ATTEMPTS } from "./execute";
import { BASE_ENV, CANARY, MIGRATION, SECRET_URL, fakeIndex, flush, okDown, okStatus, storeErr, world } from "./test-kit";
import type { World } from "./test-kit";
import type { IndexResult, PendingMigrateReport } from "./types";

const APPLIED = okStatus([MIGRATION], []);
const PENDING = okStatus([], [MIGRATION]);
const ENV = { DATABASE_URL: SECRET_URL };
const YES_MSG = "دستورِ down مخرب است و تأییدِ صریح می‌خواهد (--yes).";

const issuesOf = (argv: unknown, env: unknown = ENV): readonly string[] => {
  const r = parsePendingMigrateArgs(argv, env);
  return r.ok ? [] : r.issues;
};
const report = (w: World): PendingMigrateReport => {
  expect(w.lines).toHaveLength(1);
  expect(w.lines[0]).toMatch(/^\{.*\}\n$/);
  return JSON.parse(w.lines[0] as string) as PendingMigrateReport;
};
const noLeak = (w: World): void => {
  for (const l of w.lines) {
    expect(l).not.toContain(CANARY);
    expect(l).not.toContain(SECRET_URL);
  }
};

describe("settlement-pending-migrate down · آرگومان", () => {
  it("down بی‌--yes خطاست (command حفظ می‌شود)؛ با --yes (هر ترتیب، با/بی‌--timeout-ms) پذیرفته", () => {
    expect(parsePendingMigrateArgs(["down"], ENV)).toMatchObject({ ok: false, command: "down", issues: [YES_MSG] });
    expect(parsePendingMigrateArgs(["down", "--timeout-ms=5000"], ENV)).toMatchObject({ ok: false, command: "down", issues: [YES_MSG] });
    const want = { ok: true, value: { command: "down", timeoutMs: DEFAULT_TIMEOUT_MS, schema: null } };
    expect(parsePendingMigrateArgs(["down", "--yes"], ENV)).toMatchObject(want);
    expect(parsePendingMigrateArgs(["--yes", "down"], ENV)).toMatchObject(want);
    expect(parsePendingMigrateArgs(["down", "--yes", "--timeout-ms=7000"], ENV)).toMatchObject({ ok: true, value: { command: "down", timeoutMs: 7000 } });
    expect(parsePendingMigrateArgs(["--timeout-ms=7000", "--yes", "down"], ENV)).toMatchObject({ ok: true, value: { command: "down", timeoutMs: 7000 } });
  });

  it("--yes: بی‌مقدار، تک‌بار و فقط برای down؛ شکل‌های دیگر خطا", () => {
    expect(issuesOf(["down", "--yes=1"])).toContain("--yes مقدار نمی‌گیرد.");
    expect(issuesOf(["down", "--yes=yes"])).toContain("--yes مقدار نمی‌گیرد.");
    expect(issuesOf(["down", "--yes", "--yes"])).toContain("--yes تکراری است.");
    expect(issuesOf(["down", "-y"]).length).toBeGreaterThan(0);
    expect(issuesOf(["down", "--YES"]).length).toBeGreaterThan(0);
    expect(issuesOf(["down", "yes"]).length).toBeGreaterThan(0);
    for (const cmd of ["status", "up", "verify"]) {
      expect(issuesOf([cmd, "--yes"]), cmd).toContain("--yes فقط برای دستورِ down معنا دارد.");
      expect(parsePendingMigrateArgs([cmd, "--yes"], ENV), cmd).toMatchObject({ ok: false, command: cmd });
    }
  });

  it("پذیرفته‌شدنِ down دستورهای دیگر را عوض نمی‌کند؛ دو دستور ⇒ خطا؛ آرگومانِ موضعی هرگز پژواک نمی‌شود", () => {
    for (const cmd of ["status", "up", "verify"]) expect(parsePendingMigrateArgs([cmd], ENV), cmd).toMatchObject({ ok: true, value: { command: cmd } });
    expect(issuesOf(["down", "up", "--yes"])).toContain("آرگومانِ اضافه (فقط یک دستور).");
    expect(issuesOf(["up", "down", "--yes"])).toContain("آرگومانِ اضافه (فقط یک دستور).");
    const sneaky = issuesOf(["down", "--yes", SECRET_URL]).join("|");
    expect(sneaky).not.toContain(CANARY);
    expect(sneaky).not.toContain("postgres");
  });

  it("env همچنان الزامی است؛ شِما فقط از محیط؛ مقدارِ متغیرِ ناشناخته پژواک نمی‌شود", () => {
    expect(issuesOf(["down", "--yes"], {})).toContain("DATABASE_URL الزامی است.");
    expect(parsePendingMigrateArgs(["down", "--yes"], { ...ENV, SETTLEMENT_OUTBOX_SCHEMA: "sx" })).toMatchObject({ ok: true, value: { schema: "sx" } });
    expect(issuesOf(["down", "--yes"], { ...ENV, SETTLEMENT_TYPO: CANARY }).join("|")).not.toContain(CANARY);
  });

  it("USAGE دستورِ down و --yes را می‌گوید و همچنان ثابت و بی‌مقدار است", () => {
    expect(Object.isFrozen(USAGE)).toBe(true);
    const text = USAGE.join("\n");
    expect(text).toContain("down --yes");
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
  });
});

describe("settlement-pending-migrate down · بی‌--yes هرگز اتصال/نمایه نمی‌سازد", () => {
  it("down بی‌--yes ⇒ ۲، بی‌اتصال، بی‌فراخوانی، با usage؛ --yes با دستورِ دیگر هم همین", async () => {
    for (const argv of [["down"], ["down", "--timeout-ms=5000"], ["up", "--yes"], ["status", "--yes"], ["verify", "--yes"], ["down", "--yes=1"]]) {
      const w = world({ status: [APPLIED] });
      const out = await w.run(argv);
      expect(out.exitCode, JSON.stringify(argv)).toBe(2);
      expect(report(w)).toMatchObject({ ok: false, code: "USAGE", exitCode: 2 });
      expect(report(w).usage?.length).toBeGreaterThan(0);
      expect(w.opened.count).toBe(0);
      expect(w.created).toEqual([]);
      expect(w.calls).toEqual([]);
      noLeak(w);
    }
  });
});

describe("settlement-pending-migrate down · جریانِ موفق", () => {
  it("نصب‌شده: status ← down ← status؛ ۰، فاز verify، revertedNow؛ verify (سنگین) هرگز صدا زده نمی‌شود؛ اتصال یک بار باز و بسته", async () => {
    const w = world({ status: [APPLIED, PENDING], down: [okDown([MIGRATION])] });
    const out = await w.run(["down", "--yes"]);
    expect(out.exitCode).toBe(0);
    expect(w.calls).toEqual(["status", "down", "status"]);
    const r = report(w);
    expect(r).toMatchObject({ tool: "settlement-pending-migrate", command: "down", ok: true, code: "OK", exitCode: 0, phase: "verify", closed: true });
    expect(r.migrations).toEqual({ applied: [], pending: [MIGRATION], appliedNow: [], revertedNow: [MIGRATION] });
    expect(r.verify).toBeUndefined();
    expect(r.retries).toBeUndefined();
    expect(w.opened).toEqual({ count: 1, closed: 1 });
    expect(w.created).toEqual([{ schema: null, readStatementTimeoutMs: DEFAULT_TIMEOUT_MS }]);
    noLeak(w);
  });

  it("نصب‌نشده = بی‌کار: ۰، فاز check، down هرگز صدا زده نمی‌شود (بی‌قفل، بی‌نوشتن)؛ revertedNow نیست", async () => {
    const w = world({ status: [PENDING] });
    expect((await w.run(["down", "--yes"])).exitCode).toBe(0);
    expect(w.calls).toEqual(["status"]);
    const r = report(w);
    expect(r).toMatchObject({ ok: true, code: "OK", phase: "check", closed: true });
    expect(r.migrations).toEqual({ applied: [], pending: [MIGRATION], appliedNow: [] });
  });

  it("idempotent: down دوباره پس از موفقیت ⇒ همچنان ۰ بی‌کار", async () => {
    const w1 = world({ status: [APPLIED, PENDING] });
    expect((await w1.run(["down", "--yes"])).exitCode).toBe(0);
    const w2 = world({ status: [PENDING] });
    expect((await w2.run(["down", "--yes"])).exitCode).toBe(0);
    expect(w2.calls).toEqual(["status"]);
  });

  it("چند مهاجرتِ اعمال‌شده: گزارش به ترتیبِ برگشتِ فروشگاه؛ pending همهٔ مهاجرت‌ها", async () => {
    const w = world({ status: [okStatus(["a", "b"], ["c"]), okStatus([], ["a", "b", "c"])], down: [okDown(["b", "a"])] });
    expect((await w.run(["down", "--yes"])).exitCode).toBe(0);
    expect(report(w).migrations).toEqual({ applied: [], pending: ["a", "b", "c"], appliedNow: [], revertedNow: ["b", "a"] });
  });

  it("برگشتِ هم‌زمانِ دیگری (reverted:[] ولی دفترِ واقعی خالی) موفق است", async () => {
    const w = world({ status: [APPLIED, PENDING], down: [okDown([])] });
    expect((await w.run(["down", "--yes"])).exitCode).toBe(0);
    expect(report(w).migrations).toEqual({ applied: [], pending: [MIGRATION], appliedNow: [], revertedNow: [] });
  });

  it("شِمای محیط به نمایه می‌رسد", async () => {
    const w = world({ status: [PENDING] });
    await w.run(["down", "--yes"], { ...BASE_ENV, SETTLEMENT_OUTBOX_SCHEMA: "custom_outbox" });
    expect(w.created).toEqual([{ schema: "custom_outbox", readStatementTimeoutMs: DEFAULT_TIMEOUT_MS }]);
  });
});

describe("settlement-pending-migrate down · راستی‌آزماییِ پس از برگشت (هرگز ok بر پایهٔ ادعای down)", () => {
  it("down «ok» می‌گوید ولی دفتر هنوز اعمال‌شده است ⇒ ۶ با فاز verify", async () => {
    const w = world({ status: [APPLIED, APPLIED], down: [okDown([MIGRATION])] });
    const out = await w.run(["down", "--yes"]);
    expect(out.exitCode).toBe(6);
    expect(report(w)).toMatchObject({ ok: false, code: "MIGRATION_FAILED", phase: "verify" });
    expect(report(w).migrations).toMatchObject({ applied: [MIGRATION], appliedNow: [] });
  });

  it("نصبِ هم‌زمانِ دوباره پس از down (دفتر دوباره پر) ⇒ ۶", async () => {
    const w = world({ status: [APPLIED, APPLIED], down: [okDown([])] });
    expect((await w.run(["down", "--yes"])).exitCode).toBe(6);
  });

  it("برگشتِ جزئی (فقط بخشی از مهاجرت‌ها در دفتر مانده) ⇒ ۶", async () => {
    const w = world({ status: [okStatus(["a", "b"], []), okStatus(["a"], ["b"])], down: [okDown(["b"])] });
    expect((await w.run(["down", "--yes"])).exitCode).toBe(6);
  });

  it("خواندنِ وضعیتِ پس از برگشت: شکلِ نامعتبر ⇒ ۱؛ خطای پایگاه ⇒ ۴؛ ناهمخوانیِ دفتر ⇒ ۵؛ لغوِ زمان ⇒ ۷؛ NOT_MIGRATED ⇒ ۶", async () => {
    for (const [again, code] of [
      [undefined, 1],
      [{ ok: true, value: { applied: "x", pending: [] } }, 1],
      [storeErr("DB_ERROR", "08006"), 4],
      [storeErr("MIGRATION_TAMPERED"), 5],
      [storeErr("DB_ERROR", "57014"), 7],
      [storeErr("NOT_MIGRATED"), 6],
    ] as const) {
      const w = world({ status: [APPLIED, again], down: [okDown([MIGRATION])] });
      expect((await w.run(["down", "--yes"])).exitCode, JSON.stringify(again)).toBe(code);
      expect(report(w).phase).toBe("verify");
      noLeak(w);
    }
  });
});

describe("settlement-pending-migrate down · خطای check (پیش از هر نوشتن)", () => {
  it("DB_ERROR ⇒ ۴؛ دفترِ ناهمخوان ⇒ ۵؛ لغوِ زمان ⇒ ۷؛ شکلِ نامعتبر ⇒ ۱؛ در هر حالت down صدا زده نمی‌شود", async () => {
    for (const [status, code] of [
      [storeErr("DB_ERROR", "08006"), 4],
      [storeErr("MIGRATION_TAMPERED"), 5],
      [storeErr("MIGRATION_UNKNOWN"), 5],
      [storeErr("CORRUPT_DATA"), 5],
      [storeErr("DB_ERROR", "57014"), 7],
      [storeErr("WHATEVER"), 1],
      [undefined, 1],
      [{ ok: true, value: { applied: [1], pending: [] } }, 1],
    ] as const) {
      const w = world({ status: [status] });
      expect((await w.run(["down", "--yes"])).exitCode, JSON.stringify(status)).toBe(code);
      expect(w.calls).toEqual(["status"]);
      expect(report(w).phase).toBe("check");
      noLeak(w);
    }
  });
});

describe("settlement-pending-migrate down · نگاشتِ خطای apply", () => {
  const run = async (down: readonly unknown[]): Promise<{ w: World; code: number }> => {
    const w = world({ status: [APPLIED], down });
    const out = await w.run(["down", "--yes"]);
    noLeak(w);
    return { w, code: out.exitCode };
  };

  it("55P03 ⇒ ۱۰ و هرگز بازتلاش نمی‌شود (هر تلاش نویسنده‌های پول را در صف می‌گذارد)", async () => {
    const { w, code } = await run([storeErr("DB_ERROR", "55P03")]);
    expect(code).toBe(10);
    expect(w.calls).toEqual(["status", "down"]);
    expect(report(w)).toMatchObject({ code: "LOCK_BUSY", phase: "apply", pgCode: "55P03", closed: true });
    expect(report(w).retries).toBeUndefined();
  });

  it("وابستگیِ شیءِ بیرونی (2BP01) ⇒ ۶ با SQLSTATE و بی‌بازتلاش؛ دفترِ ناهمخوان ⇒ ۵؛ نبودنِ جدول‌های settlement ⇒ ۸؛ بقیه بسته", async () => {
    const dep = await run([storeErr("DB_ERROR", "2BP01")]);
    expect(dep.code).toBe(6);
    expect(report(dep.w)).toMatchObject({ code: "MIGRATION_FAILED", pgCode: "2BP01" });
    expect(dep.w.calls).toEqual(["status", "down"]);
    for (const c of ["MIGRATION_TAMPERED", "MIGRATION_UNKNOWN", "CORRUPT_DATA"]) expect((await run([storeErr(c)])).code, c).toBe(5);
    expect((await run([storeErr("NOT_MIGRATED")])).code).toBe(8); // دفتر هنوز اعمال‌شده است ⇒ نبودنِ واقعیِ جدول‌های settlement
    expect((await run([storeErr("COMMIT_REJECTED", "23514")])).code).toBe(6);
    expect((await run([storeErr("DB_ERROR", "57014")])).code).toBe(7);
    expect((await run([storeErr("INVALID_INPUT")])).code).toBe(1);
    expect((await run([storeErr("UNKNOWN_CODE")])).code).toBe(1);
  });

  it("بن‌بست (40P01) و ناسازگاریِ سریال‌سازی (40001): بازتلاشِ کران‌دار؛ موفقیتِ تلاشِ بعد ⇒ ۰ با retries", async () => {
    for (const pg of ["40P01", "40001"]) {
      const w = world({ status: [APPLIED, PENDING], down: [storeErr("DB_ERROR", pg), okDown([MIGRATION])] });
      expect((await w.run(["down", "--yes"])).exitCode, pg).toBe(0);
      expect(w.calls).toEqual(["status", "down", "down", "status"]);
      expect(report(w)).toMatchObject({ code: "OK", retries: 1 });
    }
    const w2 = world({ status: [APPLIED, PENDING], down: [storeErr("COMMIT_REJECTED", "40001"), okDown([MIGRATION])] });
    expect((await w2.run(["down", "--yes"])).exitCode).toBe(0);
    expect(w2.calls.filter((c) => c === "down")).toHaveLength(2);
  });

  it(`بن‌بستِ پیاپی: پس از ${APPLY_ATTEMPTS} تلاش ⇒ ۶ با SQLSTATE و retries=${APPLY_ATTEMPTS - 1}`, async () => {
    const { w, code } = await run([storeErr("DB_ERROR", "40P01")]);
    expect(code).toBe(6);
    expect(w.calls.filter((c) => c === "down")).toHaveLength(APPLY_ATTEMPTS);
    expect(report(w)).toMatchObject({ code: "MIGRATION_FAILED", pgCode: "40P01", retries: APPLY_ATTEMPTS - 1 });
  });

  it("خطاهای غیربن‌بست بازتلاش نمی‌شوند (23505، 57014، 08006، 2BP01)", async () => {
    for (const pg of ["23505", "57014", "08006", "2BP01"]) {
      const { w } = await run([storeErr("DB_ERROR", pg)]);
      expect(w.calls.filter((c) => c === "down"), pg).toHaveLength(1);
    }
  });

  it("پاسخِ نامعتبر یا پرتاب از down ⇒ ۱ (بسته) و بی‌نشت؛ هیچ status ی پس از آن زده نمی‌شود", async () => {
    for (const bad of [undefined, null, 5, {}, { ok: true }, { ok: true, value: null }, { ok: true, value: {} }, { ok: true, value: { reverted: [1] } }, { ok: true, value: { reverted: "x" } }, { ok: "yes" }, () => { throw new Error(CANARY); }, () => Promise.reject(new Error(CANARY))]) {
      const { w, code } = await run([bad]);
      expect(code).toBe(1);
      expect(w.calls).toEqual(["status", "down"]);
      expect(report(w)).toMatchObject({ code: "INTERNAL", ok: false, phase: "apply" });
    }
  });

  it("مسابقهٔ برگشتِ هم‌زمان: NOT_MIGRATED از down ولی دفترِ واقعی خالی ⇒ ۰ (برگشتِ دیگری)؛ دفتر هنوز پر ⇒ ۸ در فازِ apply", async () => {
    const won = world({ status: [APPLIED, PENDING], down: [storeErr("NOT_MIGRATED", "42P01")] });
    expect((await won.run(["down", "--yes"])).exitCode).toBe(0);
    expect(won.calls).toEqual(["status", "down", "status"]);
    expect(report(won)).toMatchObject({ ok: true, code: "OK", phase: "verify" });
    expect(report(won).migrations).toEqual({ applied: [], pending: [MIGRATION], appliedNow: [], revertedNow: [] });
    noLeak(won);

    const real = world({ status: [APPLIED, APPLIED], down: [storeErr("NOT_MIGRATED", "42P01")] });
    expect((await real.run(["down", "--yes"])).exitCode).toBe(8);
    expect(report(real)).toMatchObject({ code: "PREREQUISITE", phase: "apply", pgCode: "42P01" });
    expect(real.calls).toEqual(["status", "down", "status"]);

    const bad = world({ status: [APPLIED, storeErr("DB_ERROR", "08006")], down: [storeErr("NOT_MIGRATED")] });
    expect((await bad.run(["down", "--yes"])).exitCode).toBe(4);
  });

  it("check: NOT_MIGRATED (دفترِ ناپدیدشده در میانِ خواندن) برای down ⇒ ۰ بی‌کار؛ برای status همچنان ۳", async () => {
    const w = world({ status: [storeErr("NOT_MIGRATED", "42P01")] });
    expect((await w.run(["down", "--yes"])).exitCode).toBe(0);
    expect(w.calls).toEqual(["status"]);
    expect(report(w)).toMatchObject({ ok: true, code: "OK", phase: "check" });
    const s = world({ status: [storeErr("NOT_MIGRATED", "42P01")] });
    expect((await s.run(["status"])).exitCode).toBe(3);
  });

  it("نمایه‌ای که down ندارد (نوعِ اختیاری) ⇒ ۱ بی‌حدس؛ migrate هم جایگزینِ آن نمی‌شود", async () => {
    const calls: string[] = [];
    const noDown = (db: LedgerDatabase): IndexResult => {
      const full = fakeIndex(calls, { status: [APPLIED] }, db);
      return { ok: true, index: { status: full.status, migrate: full.migrate, verify: full.verify } };
    };
    const w = world({}, { createIndex: noDown });
    expect((await w.run(["down", "--yes"])).exitCode).toBe(1);
    expect(calls).toEqual(["status"]);
    expect(report(w)).toMatchObject({ code: "INTERNAL" });
  });
});

describe("settlement-pending-migrate down · مهلتِ کل", () => {
  it("مهلت در میانِ down ⇒ ۷ با فاز apply و اتصال بسته؛ پس از آزادی status ی بعدی صدا زده نمی‌شود", async () => {
    let release: (v: unknown) => void = () => undefined;
    const w = world({ status: [APPLIED, PENDING], down: [() => new Promise((r) => (release = r))] });
    const p = w.run(["down", "--yes", "--timeout-ms=1000"]);
    await flush();
    expect(w.lines).toHaveLength(0);
    await w.timer.advance(1000);
    expect((await p).exitCode).toBe(7);
    expect(report(w)).toMatchObject({ code: "TIMEOUT", phase: "apply", closed: true });
    expect(w.opened).toEqual({ count: 1, closed: 1 });
    release(okDown([MIGRATION]));
    await flush();
    expect(w.calls).toEqual(["status", "down"]);
  });

  it("مهلت در میانِ check: پس از آزاد‌شدنِ status، down هرگز زده نمی‌شود (اجرای رهاشده پشتِ سرِ اپراتور DDL نمی‌زند)", async () => {
    let release: (v: unknown) => void = () => undefined;
    const w = world({ status: [() => new Promise((r) => (release = r))], down: [okDown([MIGRATION])] });
    const p = w.run(["down", "--yes", "--timeout-ms=1000"]);
    await flush();
    await w.timer.advance(1000);
    expect((await p).exitCode).toBe(7);
    expect(report(w)).toMatchObject({ code: "TIMEOUT", phase: "check" });
    release(APPLIED);
    await flush();
    expect(w.calls).toEqual(["status"]);
  });

  it("مهلت میانِ down و راستی‌آزمایی: پس از آزادیِ down، status ی پایانی صدا زده نمی‌شود", async () => {
    let release: (v: unknown) => void = () => undefined;
    const w = world({ status: [APPLIED, PENDING], down: [() => new Promise((r) => (release = r))] });
    const p = w.run(["down", "--yes", "--timeout-ms=2000"]);
    await flush();
    await w.timer.advance(2000);
    await p;
    release(okDown([MIGRATION]));
    await flush();
    expect(w.calls).toEqual(["status", "down"]);
  });

  it("مهلت در میانِ راستی‌آزماییِ پایانی (status آویزان): ۷ با فاز verify و گزارشِ وضعیتِ میانیِ برگشتِ تأییدنشده", async () => {
    const w = world({ status: [APPLIED, () => new Promise(() => undefined)], down: [okDown([MIGRATION])] });
    const p = w.run(["down", "--yes", "--timeout-ms=1000"]);
    await flush();
    await w.timer.advance(1000);
    expect((await p).exitCode).toBe(7);
    expect(report(w)).toMatchObject({ code: "TIMEOUT", phase: "verify", closed: true });
    expect(report(w).migrations).toEqual({ applied: [], pending: [MIGRATION], appliedNow: [], revertedNow: [MIGRATION] });
  });

  it("بستنِ آویزان ⇒ closed:false (گلو فرایند را سخت می‌بُرد)", async () => {
    const w = world({ status: [APPLIED, PENDING] }, { closeHangs: true });
    const p = w.run(["down", "--yes"]);
    await flush();
    await w.timer.advance(5000);
    const out = await p;
    expect(out.report.closed).toBe(false);
    expect(out.exitCode).toBe(0);
  });
});

describe("settlement-pending-migrate down · دستورهای دیگر بی‌تغییرند", () => {
  it("status/up/verify هرگز down() را صدا نمی‌زنند", async () => {
    for (const argv of [["status"], ["up"], ["verify"]]) {
      const w = world({ status: [APPLIED, APPLIED] });
      await w.run(argv);
      expect(w.calls, JSON.stringify(argv)).not.toContain("down");
    }
    const w = world({ status: [PENDING, APPLIED] });
    await w.run(["up"]);
    expect(w.calls).toEqual(["status", "migrate", "status", "verify"]);
  });
});
