import { describe, expect, it } from "vitest";
import type { LedgerDatabase } from "@/modules/ledger";
import { runPendingMigrate } from "./cli";
import { APPLY_ATTEMPTS } from "./execute";
import { BASE_ENV, CANARY, MIGRATION, SECRET_URL, flush, okMigrate, okStatus, okVerify, storeErr, world } from "./test-kit";
import type { World } from "./test-kit";
import { PENDING_MIGRATE_EXIT } from "./types";
import type { IndexResult, PendingMigrateReport } from "./types";

const APPLIED = okStatus([MIGRATION], []);
const PENDING = okStatus([], [MIGRATION]);

const report = (w: World): PendingMigrateReport => {
  expect(w.lines).toHaveLength(1);
  expect(w.lines[0]).toMatch(/^\{.*\}\n$/);
  return JSON.parse(w.lines[0] as string) as PendingMigrateReport;
};
const noLeak = (w: World): void => {
  for (const l of w.lines) expect(l).not.toContain(CANARY);
};

describe("settlement-pending-migrate · جدولِ کدهای خروج (قراردادِ استقرار)", () => {
  it("مقدارها و نام‌ها قفل است؛ ۰ تا ۷ هم‌معنا با settlement-migrate", () => {
    expect(PENDING_MIGRATE_EXIT).toEqual({ OK: 0, INTERNAL: 1, USAGE: 2, PENDING: 3, UNAVAILABLE: 4, SCHEMA_MISMATCH: 5, MIGRATION_FAILED: 6, TIMEOUT: 7, PREREQUISITE: 8, INCONSISTENT: 9, LOCK_BUSY: 10 });
    expect(Object.isFrozen(PENDING_MIGRATE_EXIT)).toBe(true);
    expect(new Set(Object.values(PENDING_MIGRATE_EXIT)).size).toBe(11);
  });
});

describe("settlement-pending-migrate · help و خطای آرگومان (بی‌اتصال)", () => {
  it("--help: خروج ۰، یک خطِ JSON، بی‌اتصال", async () => {
    const w = world();
    const out = await w.run(["--help"], {});
    expect(out.exitCode).toBe(0);
    expect(report(w)).toMatchObject({ tool: "settlement-pending-migrate", command: "help", ok: true, code: "OK", exitCode: 0 });
    expect(report(w).usage?.length).toBeGreaterThan(0);
    expect(w.opened.count).toBe(0);
    expect(w.calls).toEqual([]);
  });

  it("آرگومان/env نامعتبر ⇒ ۲، بی‌اتصال، بی‌فراخوانیِ نمایه، بی‌نشت", async () => {
    for (const [argv, env] of [[[], BASE_ENV], [["up", SECRET_URL], BASE_ENV], [["up"], {}], [["verify", "--timeout-ms=5"], BASE_ENV], [["up"], { ...BASE_ENV, SETTLEMENT_TYPO: CANARY }], [["down"], BASE_ENV]] as const) {
      const w = world();
      const out = await w.run(argv, env);
      expect(out.exitCode, JSON.stringify(argv)).toBe(2);
      expect(report(w)).toMatchObject({ ok: false, code: "USAGE", exitCode: 2 });
      expect(report(w).usage?.length).toBeGreaterThan(0);
      expect(w.opened.count).toBe(0);
      expect(w.calls).toEqual([]);
      noLeak(w);
    }
  });

  it("دستورِ معتبر با env بد: command حفظ؛ دستورِ نامعتبر ⇒ unknown", async () => {
    const a = world();
    await a.run(["verify"], {});
    expect(report(a).command).toBe("verify");
    const b = world();
    await b.run(["nope"], {});
    expect(report(b).command).toBe("unknown");
  });

  it("شِمای نامعتبر (نمایهٔ واقعی) ⇒ ۲ بی‌اتصال؛ مقدارِ شِما در گزارش نیست؛ فقط نامِ متغیر", async () => {
    const lines: string[] = [];
    const timer = world().timer;
    let opened = 0;
    const out = await runPendingMigrate({
      argv: ["status"],
      env: { ...BASE_ENV, SETTLEMENT_OUTBOX_SCHEMA: `Bad-${CANARY}` },
      ports: { open: () => ((opened++), { db: {}, close: () => undefined }), timer, write: (l: string) => lines.push(l) },
    });
    expect(out.exitCode).toBe(2);
    expect(opened).toBe(0);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ code: "USAGE", issues: ["SETTLEMENT_OUTBOX_SCHEMA نامعتبر است."] });
    expect(lines.join("")).not.toContain(CANARY);
  });

  it("پورتِ خراب ⇒ ۱ (INTERNAL) بی‌پرتاب", async () => {
    const lines: string[] = [];
    const t = world().timer;
    const base = { open: () => ({ db: {}, close: () => undefined }), timer: t, write: (l: string) => lines.push(l) };
    for (const ports of [undefined, null, {}, { ...base, open: 5 }, { ...base, write: undefined }, { ...base, timer: {} }, { ...base, createIndex: 5 }]) {
      const out = await runPendingMigrate({ argv: ["status"], env: BASE_ENV, ports });
      expect(out.exitCode).toBe(1);
    }
    expect((await runPendingMigrate(null)).exitCode).toBe(1);
    expect((await runPendingMigrate(undefined)).exitCode).toBe(1);
  });
});

describe("settlement-pending-migrate · status", () => {
  it("نصب‌شده ⇒ ۰؛ فقط یک status؛ هرگز migrate/verify نمی‌زند؛ نمایه با شِما و سقفِ زمانِ سمتِ پایگاه ساخته می‌شود", async () => {
    const w = world({ status: [APPLIED] });
    const out = await w.run(["status", "--timeout-ms=45000"], { ...BASE_ENV, SETTLEMENT_OUTBOX_SCHEMA: "out_x" });
    expect(out.exitCode).toBe(0);
    expect(w.calls).toEqual(["status"]);
    expect(w.created).toEqual([{ schema: "out_x", readStatementTimeoutMs: 45_000 }]);
    expect(report(w)).toMatchObject({ command: "status", ok: true, code: "OK", phase: "check", closed: true, migrations: { applied: [MIGRATION], pending: [], appliedNow: [] } });
    expect(w.opened).toEqual({ count: 1, closed: 1 });
  });

  it("معلق ⇒ ۳ و هیچ نوشتنی نیست", async () => {
    const w = world({ status: [PENDING] });
    expect((await w.run(["status"])).exitCode).toBe(3);
    expect(w.calls).toEqual(["status"]);
    expect(report(w)).toMatchObject({ code: "PENDING", ok: false, migrations: { applied: [], pending: [MIGRATION] } });
  });

  it("نگاشتِ خطای خواندن: DB_ERROR⇒۴، 57014⇒۷، دفترِ دست‌کاری⇒۵، NOT_MIGRATED⇒۳، کدِ ناشناخته/INVALID_INPUT⇒۱؛ SQLSTATE حفظ و پیام هرگز", async () => {
    const cases: Array<[ReturnType<typeof storeErr>, number, string | undefined]> = [
      [storeErr("DB_ERROR", "08006"), 4, "08006"],
      [storeErr("DB_ERROR"), 4, undefined],
      [storeErr("DB_ERROR", "57014"), 7, "57014"],
      [storeErr("MIGRATION_TAMPERED"), 5, undefined],
      [storeErr("MIGRATION_UNKNOWN"), 5, undefined],
      [storeErr("CORRUPT_DATA"), 5, undefined],
      [storeErr("NOT_MIGRATED", "42P01"), 3, "42P01"],
      [storeErr("INVALID_INPUT"), 1, undefined],
      [storeErr("WHATEVER"), 1, undefined],
      [storeErr("DB_ERROR", "not-a-state"), 4, undefined],
    ];
    for (const [err, exit, pg] of cases) {
      const w = world({ status: [err] });
      expect((await w.run(["status"])).exitCode, JSON.stringify(err)).toBe(exit);
      expect(report(w).pgCode).toBe(pg);
      expect(w.calls).toEqual(["status"]);
      noLeak(w);
    }
  });

  it("شکلِ ناشناختهٔ پاسخ یا پرتاب ⇒ ۱ (بسته)", async () => {
    for (const bad of [undefined, null, 5, {}, { ok: true }, { ok: true, value: null }, { ok: true, value: { applied: [1], pending: [] } }, { ok: true, value: { applied: [], pending: "x" } }, { ok: "yes" }, () => { throw new Error(CANARY); }, () => Promise.reject(new Error(CANARY))]) {
      const w = world({ status: [bad] });
      expect((await w.run(["status"])).exitCode, String(bad)).toBe(1);
      noLeak(w);
    }
  });
});

describe("settlement-pending-migrate · verify", () => {
  it("سازگار ⇒ ۰ با شمارش‌ها؛ فقط status سپس verify؛ بی‌migrate", async () => {
    const w = world({ status: [APPLIED], verify: [okVerify({ expected: 7, indexed: 7 })] });
    expect((await w.run(["verify"])).exitCode).toBe(0);
    expect(w.calls).toEqual(["status", "verify"]);
    expect(report(w)).toMatchObject({ code: "OK", phase: "verify", verify: { consistent: true, expected: 7, indexed: 7, missing: 0, stale: 0 } });
  });

  it("نصب‌نشده/معلق ⇒ ۳ و verify (سنگین) اصلاً صدا زده نمی‌شود", async () => {
    const w = world({ status: [PENDING] });
    expect((await w.run(["verify"])).exitCode).toBe(3);
    expect(w.calls).toEqual(["status"]);
  });

  it("گم‌شده یا کهنه ⇒ ۹؛ شمارش‌ها در گزارش؛ هر دو سو جدا آزموده", async () => {
    for (const o of [{ missing: 1 }, { stale: 2 }, { missing: 3, stale: 4 }]) {
      const w = world({ status: [APPLIED], verify: [okVerify(o)] });
      expect((await w.run(["verify"])).exitCode, JSON.stringify(o)).toBe(9);
      expect(report(w)).toMatchObject({ code: "INCONSISTENT", ok: false, verify: { consistent: false, ...o } });
    }
  });

  it("ادعای consistent که با شمارش‌ها نمی‌خواند، یا شمارشِ نامعتبر ⇒ ۱ (بازمحاسبه؛ هرگز ok بر پایهٔ ادعا)", async () => {
    const lie = { ok: true, value: { consistent: true, expected: 1, indexed: 1, missing: 1, stale: 0 } };
    const lie2 = { ok: true, value: { consistent: false, expected: 1, indexed: 1, missing: 0, stale: 0 } };
    const bads = [lie, lie2, { ok: true, value: { consistent: true, expected: -1, indexed: 0, missing: 0, stale: 0 } }, { ok: true, value: { consistent: true, expected: 1.5, indexed: 0, missing: 0, stale: 0 } }, { ok: true, value: { consistent: true, expected: "1", indexed: 0, missing: 0, stale: 0 } }, { ok: true, value: {} }, { ok: true, value: null }, 7];
    for (const bad of bads) {
      const w = world({ status: [APPLIED], verify: [bad] });
      expect((await w.run(["verify"])).exitCode, JSON.stringify(bad)).toBe(1);
    }
  });

  it("خطای verify: 57014⇒۷، DB_ERROR⇒۴، NOT_MIGRATED⇒۳ (رقابتِ حذف)، ناهمخوانی⇒۵", async () => {
    for (const [err, exit] of [[storeErr("DB_ERROR", "57014"), 7], [storeErr("DB_ERROR", "08006"), 4], [storeErr("NOT_MIGRATED"), 3], [storeErr("CORRUPT_DATA"), 5], [storeErr("X"), 1]] as const) {
      const w = world({ status: [APPLIED], verify: [err] });
      expect((await w.run(["verify"])).exitCode).toBe(exit);
      noLeak(w);
    }
  });
});

describe("settlement-pending-migrate · up", () => {
  it("نصب‌شده ⇒ ۰ بی‌نوشتن و بی‌verify (بی‌کاری سبک است)", async () => {
    const w = world({ status: [APPLIED] });
    expect((await w.run(["up"])).exitCode).toBe(0);
    expect(w.calls).toEqual(["status"]);
    expect(report(w)).toMatchObject({ code: "OK", phase: "check" });
  });

  it("معلق ⇒ status ← migrate ← status ← verify؛ ۰ با appliedNow و شمارش‌ها", async () => {
    const w = world({ status: [PENDING, APPLIED], migrate: [okMigrate([MIGRATION])], verify: [okVerify({ expected: 0, indexed: 0 })] });
    expect((await w.run(["up"])).exitCode).toBe(0);
    expect(w.calls).toEqual(["status", "migrate", "status", "verify"]);
    expect(report(w)).toMatchObject({ code: "OK", phase: "verify", migrations: { applied: [MIGRATION], pending: [], appliedNow: [MIGRATION] }, verify: { consistent: true } });
    expect(report(w).retries).toBeUndefined();
    expect(w.opened).toEqual({ count: 1, closed: 1 });
  });

  it("پس از اعمال، نمایه ناهمخوان ⇒ ۹ (نصب پذیرفته نیست) و appliedNow حفظ می‌شود تا اپراتور بداند چه اعمال شده", async () => {
    const w = world({ status: [PENDING, APPLIED], migrate: [okMigrate([MIGRATION])], verify: [okVerify({ missing: 2 })] });
    expect((await w.run(["up"])).exitCode).toBe(9);
    expect(report(w)).toMatchObject({ code: "INCONSISTENT", phase: "verify", migrations: { appliedNow: [MIGRATION] }, verify: { missing: 2 } });
  });

  it("migrate «موفق» ولی وضعیتِ دوباره هنوز معلق ⇒ ۶ و verify زده نمی‌شود (ادعا کافی نیست)", async () => {
    const w = world({ status: [PENDING, PENDING], migrate: [okMigrate([MIGRATION])] });
    expect((await w.run(["up"])).exitCode).toBe(6);
    expect(w.calls).toEqual(["status", "migrate", "status"]);
    expect(report(w)).toMatchObject({ code: "MIGRATION_FAILED", phase: "verify" });
  });

  it("check ناهمخوان/ناپیدا ⇒ هیچ migrate نیست (۵ و ۴)", async () => {
    for (const [err, exit] of [[storeErr("MIGRATION_TAMPERED"), 5], [storeErr("DB_ERROR", "08006"), 4]] as const) {
      const w = world({ status: [err] });
      expect((await w.run(["up"])).exitCode).toBe(exit);
      expect(w.calls).toEqual(["status"]);
      expect(report(w).phase).toBe("check");
    }
  });

  it("نگاشتِ خطای apply: NOT_MIGRATED⇒۸ (پیش‌نیاز)، 55P03⇒۱۰، 57014⇒۷، دفتر⇒۵، DB_ERROR/COMMIT_REJECTED⇒۶، INVALID_INPUT/ناشناخته⇒۱", async () => {
    const cases: Array<[ReturnType<typeof storeErr>, number]> = [
      [storeErr("NOT_MIGRATED", "42P01"), 8],
      [storeErr("NOT_MIGRATED", "3F000"), 8],
      [storeErr("DB_ERROR", "55P03"), 10],
      [storeErr("DB_ERROR", "57014"), 7],
      [storeErr("MIGRATION_TAMPERED"), 5],
      [storeErr("CORRUPT_DATA"), 5],
      [storeErr("DB_ERROR", "XX000"), 6],
      [storeErr("COMMIT_REJECTED", "23000"), 6],
      [storeErr("COMMIT_REJECTED", "55P03"), 6],
      [storeErr("INVALID_INPUT"), 1],
      [storeErr("WHAT"), 1],
    ];
    for (const [err, exit] of cases) {
      const w = world({ status: [PENDING], migrate: [err] });
      expect((await w.run(["up"])).exitCode, JSON.stringify(err)).toBe(exit);
      expect(report(w).phase).toBe("apply");
      expect(w.calls.filter((c) => c === "migrate")).toHaveLength(1); // 55P03/خطای دیگر هرگز خودکار تکرار نمی‌شود
      expect(w.calls).not.toContain("verify");
      noLeak(w);
    }
  });

  it("55P03 (قفل‌مشغول) هرگز بازتلاش نمی‌شود: هر تلاش نویسنده‌های پول را دوباره در صف می‌گذارد", async () => {
    const w = world({ status: [PENDING], migrate: [storeErr("DB_ERROR", "55P03")] });
    await w.run(["up"]);
    expect(w.calls).toEqual(["status", "migrate"]);
    expect(report(w)).toMatchObject({ code: "LOCK_BUSY", exitCode: 10, pgCode: "55P03" });
    expect(report(w).retries).toBeUndefined();
  });

  it("بن‌بست/ناسازگاریِ سریال‌سازی (40P01/40001) تا APPLY_ATTEMPTS تکرار می‌شود؛ سپس موفق ⇒ ۰ با retries", async () => {
    expect(APPLY_ATTEMPTS).toBe(3);
    const w = world({ status: [PENDING, APPLIED], migrate: [storeErr("DB_ERROR", "40P01"), storeErr("COMMIT_REJECTED", "40001"), okMigrate([MIGRATION])] });
    expect((await w.run(["up"])).exitCode).toBe(0);
    expect(w.calls.filter((c) => c === "migrate")).toHaveLength(3);
    expect(report(w)).toMatchObject({ code: "OK", retries: 2 });
  });

  it("بن‌بستِ دائمی ⇒ پس از دقیقاً ۳ تلاش ۶ با retries=2", async () => {
    const w = world({ status: [PENDING], migrate: [storeErr("DB_ERROR", "40P01")] });
    expect((await w.run(["up"])).exitCode).toBe(6);
    expect(w.calls.filter((c) => c === "migrate")).toHaveLength(APPLY_ATTEMPTS);
    expect(report(w)).toMatchObject({ code: "MIGRATION_FAILED", pgCode: "40P01", retries: 2 });
  });

  it("23505 و خطاهای دیگر بازتلاش نمی‌شوند (برخلافِ settlement-migrate: اینجا مسابقهٔ CREATE SCHEMA ندارد)", async () => {
    for (const pg of ["23505", "XX000", "08006", "42501"]) {
      const w = world({ status: [PENDING], migrate: [storeErr("DB_ERROR", pg)] });
      await w.run(["up"]);
      expect(w.calls.filter((c) => c === "migrate"), pg).toHaveLength(1);
    }
    const w = world({ status: [PENDING], migrate: [storeErr("COMMIT_REJECTED", "23505")] });
    await w.run(["up"]);
    expect(w.calls.filter((c) => c === "migrate")).toHaveLength(1);
  });

  it("پاسخِ مخدوشِ migrate یا پرتاب ⇒ ۱ و بی‌verify", async () => {
    for (const bad of [undefined, null, {}, { ok: true }, { ok: true, value: {} }, { ok: true, value: { applied: [1] } }, () => { throw new Error(CANARY); }, () => Promise.reject(new Error(CANARY))]) {
      const w = world({ status: [PENDING], migrate: [bad] });
      expect((await w.run(["up"])).exitCode).toBe(1);
      expect(w.calls).not.toContain("verify");
      noLeak(w);
    }
  });

  it("خطای status/verify پس از اعمال: 08006⇒۴، NOT_MIGRATED⇒۶ (ادعا دروغ بود)، 57014⇒۷", async () => {
    for (const [stage, err, exit] of [["status", storeErr("DB_ERROR", "08006"), 4], ["status", storeErr("NOT_MIGRATED"), 6], ["verify", storeErr("NOT_MIGRATED"), 6], ["verify", storeErr("DB_ERROR", "57014"), 7], ["verify", storeErr("DB_ERROR", "08006"), 4]] as const) {
      const w = world({ status: stage === "status" ? [PENDING, err] : [PENDING, APPLIED], migrate: [okMigrate([MIGRATION])], verify: stage === "verify" ? [err] : undefined });
      expect((await w.run(["up"])).exitCode, `${stage} ${JSON.stringify(err)}`).toBe(exit);
      expect(report(w)).toMatchObject({ phase: "verify", migrations: { appliedNow: [MIGRATION] } });
    }
  });
});

describe("settlement-pending-migrate · مهلتِ کل، بستنِ اتصال و پایگاهِ تنبل", () => {
  it("پایگاهِ آویزان در status: پس از مهلت ⇒ ۷ و phase=check؛ زمان‌سنج با همان مهلت؛ لغوِ زمان‌سنج پس از پایان", async () => {
    const w = world({ status: [() => new Promise(() => undefined)] });
    const p = w.run(["status", "--timeout-ms=2000"]);
    await flush();
    expect(w.lines).toHaveLength(0);
    await w.timer.advance(2000);
    const out = await p;
    expect(out.exitCode).toBe(7);
    expect(report(w)).toMatchObject({ code: "TIMEOUT", phase: "check", closed: true });
    expect(w.timer.delays[0]).toBe(2000);
    expect(w.opened).toEqual({ count: 1, closed: 1 });
  });

  it("پس از مهلت هیچ فراخوانیِ تازهٔ نمایه نیست: اجرای رهاشده پس از آزاد‌شدنِ status، migrate نمی‌زند", async () => {
    let release: (v: unknown) => void = () => undefined;
    const w = world({ status: [() => new Promise((r) => (release = r))], migrate: [okMigrate([MIGRATION])] });
    const p = w.run(["up", "--timeout-ms=1000"]);
    await flush();
    await w.timer.advance(1000);
    expect((await p).exitCode).toBe(7);
    release(PENDING);
    await flush();
    expect(w.calls).toEqual(["status"]);
  });

  it("مهلت در میانِ apply ⇒ ۷ با phase=apply؛ پس از آزادی، verify صدا زده نمی‌شود", async () => {
    let release: (v: unknown) => void = () => undefined;
    const w = world({ status: [PENDING, APPLIED], migrate: [() => new Promise((r) => (release = r))] });
    const p = w.run(["up", "--timeout-ms=1000"]);
    await flush();
    await w.timer.advance(1000);
    expect((await p).exitCode).toBe(7);
    expect(report(w)).toMatchObject({ code: "TIMEOUT", phase: "apply" });
    release(okMigrate([MIGRATION]));
    await flush();
    expect(w.calls).toEqual(["status", "migrate"]);
  });

  it("verify: مهلت میانِ status و verify ⇒ ۷ با phase=check و verify (سنگین) هرگز صدا زده نمی‌شود", async () => {
    let release: (v: unknown) => void = () => undefined;
    const w = world({ status: [() => new Promise((r) => (release = r))], verify: [okVerify()] });
    const p = w.run(["verify", "--timeout-ms=1000"]);
    await flush();
    await w.timer.advance(1000);
    expect((await p).exitCode).toBe(7);
    release(APPLIED);
    await flush();
    expect(w.calls).toEqual(["status"]);
  });

  it("مهلت میانِ apply و راستی‌آزمایی: پس از آزادیِ migrate، نه status و نه verify صدا زده می‌شود", async () => {
    let release: (v: unknown) => void = () => undefined;
    const w = world({ status: [PENDING, APPLIED], migrate: [() => new Promise((r) => (release = r))], verify: [okVerify()] });
    const p = w.run(["up", "--timeout-ms=1000"]);
    await flush();
    await w.timer.advance(1000);
    expect((await p).exitCode).toBe(7);
    release(okMigrate([MIGRATION]));
    await flush();
    expect(w.calls).toEqual(["status", "migrate"]);
  });

  it("پایگاهِ نامعتبر حتی اگر نمایه خطایش را ببلعد ⇒ ۱ (invalid() نادیده گرفته نمی‌شود)", async () => {
    const swallow = (db: LedgerDatabase): IndexResult => ({
      ok: true,
      index: {
        status: async () => {
          await Promise.resolve(db.execute({} as never)).catch(() => undefined);
          return APPLIED as never;
        },
        migrate: () => Promise.reject(new Error("unused")),
        verify: () => Promise.reject(new Error("unused")),
      },
    });
    const w = world({}, { open: () => ({ db: {}, close: () => undefined }), createIndex: swallow });
    const out = await w.run(["status"]);
    expect(out.exitCode).toBe(1);
    expect(report(w)).toMatchObject({ code: "INTERNAL", ok: false });
  });

  it("بستنِ آویزان ⇒ closed:false پس از ۵ ثانیه (گلو فرایند را سخت می‌بُرد)", async () => {
    const w = world({ status: [APPLIED] }, { closeHangs: true });
    const p = w.run(["status"]);
    await flush();
    await w.timer.advance(5000);
    const out = await p;
    expect(out.exitCode).toBe(0);
    expect(report(w).closed).toBe(false);
  });

  it("پایگاه فقط در نخستین استفاده باز می‌شود و پایگاهِ نامعتبر ⇒ ۱ (خطای برنامه‌نویسی، نه «در دسترس نبودن»)", async () => {
    const w = world({ status: [APPLIED], touchDb: true }, { open: () => ({ db: {}, close: () => undefined }) });
    expect((await w.run(["status"])).exitCode).toBe(1);
    noLeak(w);
  });

  it("خطای بازکردنِ اتصال (که ممکن است رشتهٔ اتصال داشته باشد) هرگز در گزارش نمی‌آید", async () => {
    const w = world({ status: [APPLIED], touchDb: true }, { open: () => { throw new Error(SECRET_URL); } });
    const out = await w.run(["status"]);
    expect(out.exitCode).toBeGreaterThan(0);
    noLeak(w);
    expect(w.lines.join("")).not.toContain("postgres");
  });

  it("زمان‌سنجِ خراب ⇒ ۱ و هیچ کاری بی‌مهلت اجرا نمی‌شود", async () => {
    const w = world({ status: [APPLIED] });
    const lines: string[] = [];
    const out = await runPendingMigrate({ argv: ["status"], env: BASE_ENV, ports: { ...w.ports, write: (l: string) => lines.push(l), timer: { after: () => { throw new Error("x"); }, cancel: () => undefined } } });
    expect(out.exitCode).toBe(1);
    expect(w.calls).toEqual([]);
  });

  it("write پرتاب‌کننده کدِ خروج را عوض نمی‌کند", async () => {
    const w = world({ status: [APPLIED] });
    const out = await runPendingMigrate({ argv: ["status"], env: BASE_ENV, ports: { ...w.ports, write: () => { throw new Error("x"); } } });
    expect(out.exitCode).toBe(0);
  });
});

describe("settlement-pending-migrate · خاصیتی (۴۰۰ سناریوی تصادفی)", () => {
  it("ناورداهای گزارش و ترتیبِ فراخوانی در همهٔ ترکیب‌ها برقرارند", async () => {
    let seed = 20261124;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const statuses = [APPLIED, PENDING, storeErr("DB_ERROR", "08006"), storeErr("MIGRATION_TAMPERED"), storeErr("NOT_MIGRATED"), { ok: true }, 5];
    const migrates = [okMigrate([MIGRATION]), storeErr("NOT_MIGRATED"), storeErr("DB_ERROR", "55P03"), storeErr("DB_ERROR", "40P01"), storeErr("COMMIT_REJECTED", "23000"), null];
    const verifies = [okVerify(), okVerify({ missing: 1 }), okVerify({ stale: 1 }), storeErr("DB_ERROR", "57014"), storeErr("NOT_MIGRATED"), { ok: true, value: { consistent: true, expected: 0, indexed: 0, missing: 1, stale: 0 } }];
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const command = pick(["status", "up", "verify"] as const);
      const script = { status: [pick(statuses), pick(statuses)], migrate: [pick(migrates), pick(migrates), pick(migrates)], verify: [pick(verifies)] };
      const w = world(script);
      const out = await w.run([command]);
      const r = report(w);
      seen.add(r.code);
      expect(out.exitCode).toBe(PENDING_MIGRATE_EXIT[r.code]);
      expect(r.exitCode).toBe(out.exitCode);
      expect(r.ok).toBe(r.code === "OK");
      noLeak(w);
      expect(w.opened.count).toBe(w.opened.closed);
      if (command !== "up") expect(w.calls).not.toContain("migrate");
      if (command === "status") expect(w.calls).toEqual(["status"]);
      if (w.calls.includes("migrate")) {
        // migrate فقط پس از یک status که معلق نشان داده بود و فقط در up
        expect(command).toBe("up");
        expect(w.calls[0]).toBe("status");
      }
      if (r.code === "OK" && w.calls.includes("migrate")) {
        expect(w.calls.slice(-2)).toEqual(["status", "verify"]);
        expect(r.verify?.consistent).toBe(true);
        expect(r.migrations?.pending).toEqual([]);
      }
      if (r.code === "INCONSISTENT") expect(r.verify?.consistent).toBe(false);
    }
    expect(seen.size).toBeGreaterThanOrEqual(8);
  });
});
