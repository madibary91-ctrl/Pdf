import { describe, expect, it } from "vitest";
import { runSettlementMigrate } from "./cli";
import { APPLY_ATTEMPTS } from "./execute";
import { BASE_ENV, CANARY, SECRET_URL, flush, okMigrate, okStatus, storeErr, world } from "./test-kit";
import type { World } from "./test-kit";
import { MIGRATE_EXIT } from "./types";
import type { MigrateReport } from "./types";

const APPLIED = okStatus(["0001_init"], []);
const PENDING = okStatus([], ["0001_init"]);
const PENDING2 = okStatus(["0001_init"], ["0002_x"]);

const report = (w: World): MigrateReport => {
  expect(w.lines).toHaveLength(1);
  expect(w.lines[0]).toMatch(/^\{.*\}\n$/);
  return JSON.parse(w.lines[0] as string) as MigrateReport;
};
const noLeak = (w: World): void => {
  for (const l of w.lines) expect(l).not.toContain(CANARY);
};

describe("settlement-migrate · جدولِ کدهای خروج (قراردادِ استقرار)", () => {
  it("مقدارها و نام‌ها قفل است", () => {
    expect(MIGRATE_EXIT).toEqual({ OK: 0, INTERNAL: 1, USAGE: 2, PENDING: 3, UNAVAILABLE: 4, SCHEMA_MISMATCH: 5, MIGRATION_FAILED: 6, TIMEOUT: 7 });
    expect(Object.isFrozen(MIGRATE_EXIT)).toBe(true);
    expect(new Set(Object.values(MIGRATE_EXIT)).size).toBe(8);
  });
});

describe("settlement-migrate · help و خطای آرگومان (بی‌اتصال)", () => {
  it("--help: خروج ۰، یک خطِ JSON، بی‌اتصال", async () => {
    const w = world();
    const out = await w.run(["--help"], {});
    expect(out.exitCode).toBe(0);
    expect(report(w)).toMatchObject({ tool: "settlement-migrate", command: "help", ok: true, code: "OK", exitCode: 0 });
    expect(report(w).usage?.length).toBeGreaterThan(0);
    expect(w.opened.count).toBe(0);
    expect(w.calls).toEqual([]);
  });

  it("آرگومان/env نامعتبر ⇒ ۲، بی‌اتصال، بی‌فراخوانیِ فروشگاه، بی‌نشت", async () => {
    for (const [argv, env] of [[[], BASE_ENV], [["up", SECRET_URL], BASE_ENV], [["up"], {}], [["status", "--timeout-ms=5"], BASE_ENV], [["up"], { ...BASE_ENV, SETTLEMENT_TYPO: CANARY }]] as const) {
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

  it("دستورِ معتبر با env بد: command در گزارش حفظ می‌شود؛ دستورِ نامعتبر ⇒ unknown", async () => {
    const a = world();
    await a.run(["up"], {});
    expect(report(a).command).toBe("up");
    const b = world();
    await b.run(["nope"], {});
    expect(report(b).command).toBe("unknown");
  });

  it("شِمای نامعتبر (فروشگاهِ واقعی) ⇒ ۲ فقط با نامِ متغیر، بی‌اتصال و بی‌نشتِ مقدار", async () => {
    const lines: string[] = [];
    let opened = 0;
    const out = await runSettlementMigrate({
      argv: ["up"],
      env: { ...BASE_ENV, SETTLEMENT_LEDGER_SCHEMA: `BAD-${CANARY}`, SETTLEMENT_OUTBOX_SCHEMA: "public" },
      ports: { open: () => { opened++; return { db: {}, close: () => undefined }; }, timer: world().timer, write: (l: string) => lines.push(l) },
    });
    expect(out.exitCode).toBe(2);
    expect(opened).toBe(0);
    const r = JSON.parse(lines[0] as string) as MigrateReport;
    expect(r.issues).toEqual(["SETTLEMENT_LEDGER_SCHEMA نامعتبر است.", "SETTLEMENT_OUTBOX_SCHEMA نامعتبر است."]);
    expect(lines[0]).not.toContain(CANARY);
  });
});

describe("settlement-migrate · status (فقط‌خواندنی)", () => {
  it("همه اعمال‌شده ⇒ ۰؛ هر دو فروشگاه خوانده می‌شوند؛ هرگز migrate", async () => {
    const w = world();
    const out = await w.run(["status"]);
    expect(out.exitCode).toBe(0);
    expect(w.calls).toEqual(["ledger.status", "settlement.status"]);
    expect(report(w)).toMatchObject({
      command: "status", ok: true, code: "OK", phase: "check", closed: true,
      ledger: { applied: ["0001_init"], pending: [], appliedNow: [] },
      settlement: { applied: ["0001_init"], pending: [], appliedNow: [] },
    });
  });

  it("معلق در دفتر، در outbox یا هر دو ⇒ ۳ (با فهرستِ دقیقِ معلق‌ها)", async () => {
    for (const [l, s] of [[PENDING, APPLIED], [APPLIED, PENDING2], [PENDING, PENDING2]] as const) {
      const w = world({ ledger: { status: [l] }, settlement: { status: [s] } });
      expect((await w.run(["status"])).exitCode).toBe(3);
      const r = report(w);
      expect(r).toMatchObject({ ok: false, code: "PENDING", exitCode: 3, phase: "check" });
      expect(r.ledger?.pending).toEqual(l.value.pending);
      expect(r.settlement?.pending).toEqual(s.value.pending);
      expect(w.calls).toEqual(["ledger.status", "settlement.status"]);
    }
  });

  it("نگاشتِ خطای خواندن: DB_ERROR⇒۴ · ناهمخوانی⇒۵ · NOT_MIGRATED⇒۳ · INVALID_INPUT/COMMIT_REJECTED/ناشناخته⇒۱", async () => {
    const table: [string, number][] = [
      ["DB_ERROR", 4], ["MIGRATION_TAMPERED", 5], ["MIGRATION_UNKNOWN", 5], ["CORRUPT_DATA", 5],
      ["NOT_MIGRATED", 3], ["INVALID_INPUT", 1], ["COMMIT_REJECTED", 1], ["BRAND_NEW_CODE", 1],
    ];
    for (const [code, exit] of table) {
      const w = world({ ledger: { status: [storeErr(code)] } });
      expect((await w.run(["status"])).exitCode, code).toBe(exit);
      expect(report(w).stage).toBe("ledger");
      noLeak(w);
    }
  });

  it("SQLSTATE فقط اگر پنج‌نویسهٔ بزرگ/عدد باشد می‌آید؛ وگرنه حذف", async () => {
    const a = world({ ledger: { status: [storeErr("DB_ERROR", "08006")] } });
    await a.run(["status"]);
    expect(report(a).pgCode).toBe("08006");
    for (const bad of [CANARY, "08x06", "0800", "080061", ""]) {
      const w = world({ ledger: { status: [storeErr("DB_ERROR", bad)] } });
      await w.run(["status"]);
      expect(report(w).pgCode, bad).toBeUndefined();
      noLeak(w);
    }
  });

  it("شدتِ خطا: در دسترس‌نبودنِ outbox بر ناهمخوانیِ دفتر می‌چربد و stage درست است؛ هر دو فروشگاه خوانده شدند", async () => {
    const w = world({ ledger: { status: [storeErr("MIGRATION_TAMPERED")] }, settlement: { status: [storeErr("DB_ERROR")] } });
    expect((await w.run(["status"])).exitCode).toBe(4);
    expect(report(w).stage).toBe("settlement");
    expect(w.calls).toEqual(["ledger.status", "settlement.status"]);
    const x = world({ ledger: { status: [storeErr("DB_ERROR")] }, settlement: { status: [storeErr("MIGRATION_TAMPERED")] } });
    expect((await x.run(["status"])).exitCode).toBe(4);
    const y = world({ ledger: { status: [storeErr("NOT_MIGRATED")] }, settlement: { status: [storeErr("MIGRATION_UNKNOWN")] } });
    expect((await y.run(["status"])).exitCode).toBe(5);
  });

  it("شکلِ نامعتبرِ پاسخ، پرتاب و thenableِ بدجنس ⇒ ۱ (بسته)، بی‌پرتاب، بی‌نشت", async () => {
    const shapes: unknown[] = [
      undefined, null, 5, "ok", {}, { ok: true }, { ok: true, value: null }, { ok: true, value: {} }, { ok: true, value: { applied: "x", pending: [] } },
      { ok: true, value: { applied: [], pending: [1] } }, { ok: "true", value: { applied: [], pending: [] } },
      () => { throw new Error(CANARY); },
      () => ({ then() { throw new Error(CANARY); } }),
      () => Promise.reject(new Error(CANARY)),
    ];
    for (const s of shapes) {
      const w = world({ settlement: { status: [s] } });
      expect((await w.run(["status"])).exitCode, String(s)).toBe(1);
      noLeak(w);
    }
  });
});

describe("settlement-migrate · up", () => {
  it("هر دو معلق: ترتیبِ دقیقِ check(دفتر،outbox) ← apply(دفتر،outbox) ← verify(دفتر،outbox) و appliedNow", async () => {
    const w = world({
      ledger: { status: [PENDING, APPLIED], migrate: [okMigrate(["0001_init"])] },
      settlement: { status: [PENDING2, okStatus(["0001_init", "0002_x"], [])], migrate: [okMigrate(["0002_x"])] },
    });
    const out = await w.run(["up"]);
    expect(out.exitCode).toBe(0);
    expect(w.calls).toEqual(["ledger.status", "settlement.status", "ledger.migrate", "settlement.migrate", "ledger.status", "settlement.status"]);
    expect(report(w)).toMatchObject({
      command: "up", ok: true, code: "OK", phase: "verify", closed: true,
      ledger: { applied: ["0001_init"], pending: [], appliedNow: ["0001_init"] },
      settlement: { applied: ["0001_init", "0002_x"], pending: [], appliedNow: ["0002_x"] },
    });
    expect(report(w).stage).toBeUndefined();
  });

  it("فقط outbox معلق: دفتر هرگز migrate نمی‌شود و verify فقط برای outbox است", async () => {
    const w = world({ settlement: { status: [PENDING2, APPLIED], migrate: [okMigrate(["0002_x"])] } });
    expect((await w.run(["up"])).exitCode).toBe(0);
    expect(w.calls).toEqual(["ledger.status", "settlement.status", "settlement.migrate", "settlement.status"]);
    expect(report(w).ledger?.appliedNow).toEqual([]);
  });

  it("هیچ‌چیز معلق نیست: صفر نوشتن (نه migrate، نه verify) و ۰", async () => {
    const w = world();
    expect((await w.run(["up"])).exitCode).toBe(0);
    expect(w.calls).toEqual(["ledger.status", "settlement.status"]);
    expect(report(w).phase).toBe("check");
  });

  it("ناهمخوانی/در دسترس‌نبودن در check ⇒ هیچ مهاجرتی اعمال نمی‌شود (حتی برای فروشگاهِ سالم و معلق)", async () => {
    for (const [code, exit] of [["MIGRATION_TAMPERED", 5], ["MIGRATION_UNKNOWN", 5], ["CORRUPT_DATA", 5], ["DB_ERROR", 4]] as const) {
      for (const bad of ["ledger", "settlement"] as const) {
        const good = bad === "ledger" ? "settlement" : "ledger";
        const w = world({ [bad]: { status: [storeErr(code)] }, [good]: { status: [PENDING] } });
        expect((await w.run(["up"])).exitCode, `${code}/${bad}`).toBe(exit);
        expect(w.calls.filter((c) => c.endsWith(".migrate")), `${code}/${bad}`).toEqual([]);
        expect(report(w).phase).toBe("check");
        noLeak(w);
      }
    }
  });

  it("شکست در apply دفتر ⇒ ۶ با stage=ledger و outbox هرگز migrate نمی‌شود", async () => {
    const w = world({ ledger: { status: [PENDING], migrate: [storeErr("DB_ERROR", "42501")] }, settlement: { status: [PENDING] } });
    expect((await w.run(["up"])).exitCode).toBe(6);
    expect(report(w)).toMatchObject({ code: "MIGRATION_FAILED", phase: "apply", stage: "ledger", pgCode: "42501" });
    expect(w.calls).toEqual(["ledger.status", "settlement.status", "ledger.migrate"]);
    noLeak(w);
  });

  it("شکست در apply outbox پس از موفقیتِ دفتر ⇒ ۶ با stage=settlement؛ دفترِ اعمال‌شده در گزارش می‌ماند (تکرار امن است)", async () => {
    const w = world({
      ledger: { status: [PENDING], migrate: [okMigrate(["0001_init"])] },
      settlement: { status: [PENDING2], migrate: [storeErr("DB_ERROR", "42710")] },
    });
    expect((await w.run(["up"])).exitCode).toBe(6);
    expect(report(w)).toMatchObject({ code: "MIGRATION_FAILED", phase: "apply", stage: "settlement", pgCode: "42710", ledger: { appliedNow: ["0001_init"] } });
    expect(w.calls).toEqual(["ledger.status", "settlement.status", "ledger.migrate", "settlement.migrate"]);
  });

  it("نگاشتِ خطای apply: COMMIT_REJECTED/NOT_MIGRATED/DB_ERROR⇒۶ · ناهمخوانی⇒۵ · INVALID_INPUT/ناشناخته⇒۱", async () => {
    const table: [string, number][] = [["DB_ERROR", 6], ["COMMIT_REJECTED", 6], ["NOT_MIGRATED", 6], ["MIGRATION_TAMPERED", 5], ["MIGRATION_UNKNOWN", 5], ["CORRUPT_DATA", 5], ["INVALID_INPUT", 1], ["WHAT", 1]];
    for (const [code, exit] of table) {
      const w = world({ ledger: { status: [PENDING], migrate: [storeErr(code)] } });
      expect((await w.run(["up"])).exitCode, code).toBe(exit);
      noLeak(w);
    }
  });

  it("migrate پرتاب/شکلِ نامعتبر/thenableِ بدجنس ⇒ ۱ بی‌نشت و بی‌پرتاب", async () => {
    const steps: unknown[] = [() => { throw new Error(CANARY); }, undefined, {}, { ok: true }, { ok: true, value: { applied: "x" } }, { ok: true, value: { applied: [3] } }, () => ({ then() { throw new Error(CANARY); } })];
    for (const s of steps) {
      const w = world({ ledger: { status: [PENDING], migrate: [s] } });
      expect((await w.run(["up"])).exitCode, String(s)).toBe(1);
      noLeak(w);
    }
  });

  it("راستی‌آزمایی: migrate «موفق» ولی معلقِ باقی‌مانده ⇒ ۶ با phase=verify؛ هرگز ok بر پایهٔ ادعا", async () => {
    const w = world({ ledger: { status: [PENDING, PENDING], migrate: [okMigrate(["0001_init"])] } });
    expect((await w.run(["up"])).exitCode).toBe(6);
    expect(report(w)).toMatchObject({ code: "MIGRATION_FAILED", phase: "verify", stage: "ledger", ledger: { pending: ["0001_init"], appliedNow: ["0001_init"] } });
  });

  it("خطای خواندنِ verify: DB_ERROR⇒۶ · ناهمخوانی⇒۵ · شکلِ نامعتبر⇒۱", async () => {
    for (const [step, exit] of [[storeErr("DB_ERROR"), 6], [storeErr("MIGRATION_TAMPERED"), 5], [{ ok: true }, 1]] as const) {
      const w = world({ ledger: { status: [PENDING, step], migrate: [okMigrate(["0001_init"])] } });
      expect((await w.run(["up"])).exitCode).toBe(exit);
      expect(report(w).phase).toBe("verify");
    }
  });

  it("مهاجرتِ هم‌زمانِ فرایندِ دیگر (migrate: applied=[]، verify پاک) ⇒ ۰ با appliedNow خالی", async () => {
    const w = world({ ledger: { status: [PENDING, APPLIED], migrate: [okMigrate([])] } });
    expect((await w.run(["up"])).exitCode).toBe(0);
    expect(report(w).ledger).toEqual({ applied: ["0001_init"], pending: [], appliedNow: [] });
  });
});

describe("settlement-migrate · بازتلاشِ کران‌دارِ مسابقهٔ هم‌زمانی", () => {
  const race = (pg: string) => ({ ok: false as const, error: { code: "COMMIT_REJECTED", message: CANARY, pgCode: pg } });

  it("سقفِ تلاش ۳ است", () => {
    expect(APPLY_ATTEMPTS).toBe(3);
  });

  it("23505 (مسابقهٔ CREATE SCHEMA) یک بار ⇒ تکرار و موفقیت با retries=۱؛ فقط همان فروشگاه تکرار می‌شود", async () => {
    const w = world({ settlement: { status: [PENDING2, APPLIED], migrate: [race("23505"), okMigrate([])] } });
    const out = await w.run(["up"]);
    expect(out.exitCode).toBe(0);
    expect(w.calls).toEqual(["ledger.status", "settlement.status", "settlement.migrate", "settlement.migrate", "settlement.status"]);
    expect(report(w).retries).toBe(1);
  });

  it("40001 و 40P01 هم (با DB_ERROR) بازتلاش می‌شوند", async () => {
    for (const pg of ["40001", "40P01"]) {
      const w = world({ ledger: { status: [PENDING, APPLIED], migrate: [{ ok: false, error: { code: "DB_ERROR", message: CANARY, pgCode: pg } }, okMigrate(["0001_init"])] } });
      expect((await w.run(["up"])).exitCode, pg).toBe(0);
      expect(w.calls.filter((c) => c === "ledger.migrate")).toHaveLength(2);
    }
  });

  it("پس از سه تلاشِ ناموفق ⇒ ۶ با retries=۲ و دقیقاً سه migrate", async () => {
    const w = world({ ledger: { status: [PENDING], migrate: [race("23505")] } });
    expect((await w.run(["up"])).exitCode).toBe(6);
    expect(w.calls.filter((c) => c === "ledger.migrate")).toHaveLength(3);
    expect(report(w)).toMatchObject({ code: "MIGRATION_FAILED", phase: "apply", stage: "ledger", pgCode: "23505", retries: 2 });
    expect(w.calls).not.toContain("settlement.migrate");
  });

  it("خطای غیرهم‌زمانی هرگز تکرار نمی‌شود (42501، 42710، نبودِ pgCode، کدِ ناهمخوانی)", async () => {
    const cases = [race("42501"), race("42710"), { ok: false, error: { code: "DB_ERROR", message: CANARY } }, { ok: false, error: { code: "MIGRATION_TAMPERED", message: CANARY, pgCode: "23505" } }, { ok: false, error: { code: "INVALID_INPUT", message: CANARY, pgCode: "23505" } }];
    for (const c of cases) {
      const w = world({ ledger: { status: [PENDING], migrate: [c] } });
      await w.run(["up"]);
      expect(w.calls.filter((x) => x === "ledger.migrate"), JSON.stringify(c)).toHaveLength(1);
      expect(report(w).retries).toBeUndefined();
    }
  });

  it("کلیدِ retries فقط وقتی > ۰ است در گزارش می‌آید", async () => {
    const w = world();
    await w.run(["up"]);
    expect("retries" in report(w)).toBe(false);
  });
});

describe("settlement-migrate · مهلتِ کل", () => {
  it("status آویزان ⇒ ۷ در مهلتِ پیش‌فرض، بستنِ اتصال، بی‌نشت", async () => {
    const w = world({ ledger: { status: [() => new Promise(() => undefined)], touchDb: true } });
    const p = w.run(["status"]);
    await flush();
    expect(w.timer.delays).toEqual([60_000]);
    await w.timer.advance(60_000);
    const out = await p;
    expect(out.exitCode).toBe(7);
    expect(report(w)).toMatchObject({ code: "TIMEOUT", phase: "check", stage: "ledger", closed: true });
    expect(w.opened).toEqual({ count: 1, closed: 1 });
    expect(w.timer.pending()).toBe(0);
  });

  it("--timeout-ms به زمان‌سنج می‌رسد و بستنِ اتصال مهلتِ ۵۰۰۰ دارد", async () => {
    const w = world({ settlement: { status: [() => new Promise(() => undefined)], touchDb: true } }, { closeHangs: true });
    const p = w.run(["status", "--timeout-ms=2500"]);
    await flush();
    expect(w.timer.delays).toEqual([2500]);
    await w.timer.advance(2500);
    await flush();
    expect(w.timer.delays).toEqual([2500, 5000]);
    await w.timer.advance(5000);
    const out = await p;
    expect(out.exitCode).toBe(7);
    expect(report(w)).toMatchObject({ code: "TIMEOUT", stage: "settlement", closed: false });
    expect(report(w).ledger?.applied).toEqual(["0001_init"]);
  });

  it("up آویزان در apply: ۷ با phase=apply؛ پس از مهلت هیچ فراخوانیِ تازه‌ای (نه migrateِ outbox) شروع نمی‌شود", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<unknown>((res) => { release = () => res(okMigrate(["0001_init"])); });
    const w = world({ ledger: { status: [PENDING], migrate: [() => gate], touchDb: true }, settlement: { status: [PENDING] } });
    const p = w.run(["up"]);
    await flush();
    await w.timer.advance(60_000);
    const out = await p;
    expect(out.exitCode).toBe(7);
    expect(report(w)).toMatchObject({ phase: "apply", stage: "ledger" });
    release();
    await flush();
    expect(w.calls).toEqual(["ledger.status", "settlement.status", "ledger.migrate"]);
  });

  it("آویزان‌شدن در check: پس از مهلت و آزادشدنِ وعده، فروشگاهِ بعدی خوانده نمی‌شود", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<unknown>((res) => { release = () => res(APPLIED); });
    const w = world({ ledger: { status: [() => gate] } });
    const p = w.run(["status"]);
    await flush();
    await w.timer.advance(60_000);
    expect((await p).exitCode).toBe(7);
    release();
    await flush();
    expect(w.calls).toEqual(["ledger.status"]);
  });

  it("آویزان‌شدن در verify: پس از مهلت، verifyِ فروشگاهِ بعدی شروع نمی‌شود", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<unknown>((res) => { release = () => res(APPLIED); });
    const w = world({
      ledger: { status: [PENDING, () => gate], migrate: [okMigrate(["0001_init"])] },
      settlement: { status: [PENDING, APPLIED], migrate: [okMigrate(["0001_init"])] },
    });
    const p = w.run(["up"]);
    await flush();
    await w.timer.advance(60_000);
    const out = await p;
    expect(out.exitCode).toBe(7);
    expect(report(w).phase).toBe("verify");
    release();
    await flush();
    expect(w.calls).toEqual(["ledger.status", "settlement.status", "ledger.migrate", "settlement.migrate", "ledger.status"]);
  });

  it("خطای هم‌زمانی که پس از مهلت برمی‌گردد بازتلاش نمی‌شود", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<unknown>((res) => { release = () => res({ ok: false, error: { code: "COMMIT_REJECTED", message: CANARY, pgCode: "23505" } }); });
    const w = world({ ledger: { status: [PENDING], migrate: [() => gate, okMigrate(["0001_init"])] } });
    const p = w.run(["up"]);
    await flush();
    await w.timer.advance(60_000);
    expect((await p).exitCode).toBe(7);
    release();
    await flush();
    expect(w.calls.filter((c) => c === "ledger.migrate")).toHaveLength(1);
  });

  it("شدتِ برابر: stage نخستین فروشگاهِ خراب است (دفتر)", async () => {
    const w = world({ ledger: { status: [storeErr("DB_ERROR")] }, settlement: { status: [storeErr("DB_ERROR")] } });
    expect((await w.run(["status"])).exitCode).toBe(4);
    expect(report(w).stage).toBe("ledger");
  });

  it("پایان‌پذیری عادی: زمان‌سنجِ مهلت لغو می‌شود (هیچ زمان‌سنجِ معلقی نمی‌ماند)", async () => {
    const w = world();
    await w.run(["status"]);
    expect(w.timer.pending()).toBe(0);
  });
});

describe("settlement-migrate · پایگاهِ تنبل و بستن", () => {
  it("اتصال یک بار باز و یک بار بسته می‌شود (چند فراخوانیِ هم‌زمان)، حتی در موفقیت", async () => {
    const w = world({ ledger: { touchDb: true }, settlement: { touchDb: true } });
    await w.run(["status"]);
    expect(w.opened).toEqual({ count: 1, closed: 1 });
  });

  it("بازشدن ناموفق (خطا قناری دارد) ⇒ ۴، بی‌نشت، بی‌بستن، closed=true", async () => {
    const w = world({ ledger: { touchDb: true } }, { open: () => { throw new Error(CANARY); } });
    const out = await w.run(["status"]);
    // فروشگاهِ ساختگی خطای open را به‌صورت پرتاب می‌بیند ⇒ شکلِ نامعتبر (۱)؛ مسیرِ واقعیِ DB_ERROR ⇒ ۴ در آزمونِ PostgreSQL/فرایند است.
    expect(out.exitCode).toBe(1);
    expect(report(w).closed).toBe(true);
    noLeak(w);
  });

  it("پایگاهِ نامعتبر (بی‌execute/transaction/close) ⇒ ۱ (خطای برنامه‌نویسی، نه «در دسترس نبودن»)", async () => {
    for (const bad of [{ db: {}, close: () => undefined }, { db: { execute() {}, transaction() {} } }, { db: null, close: () => undefined }, null, undefined, 5]) {
      const w = world({ ledger: { touchDb: true, status: [APPLIED] } }, { open: () => bad as never });
      expect((await w.run(["status"])).exitCode, JSON.stringify(bad)).toBe(1);
      noLeak(w);
    }
  });

  it("فروشگاهِ واقعی + پایگاهِ نامعتبرِ دارای close ⇒ ۱ (نه ۴) و همان close صدا زده می‌شود", async () => {
    const lines: string[] = [];
    let closed = 0;
    const out = await runSettlementMigrate({
      argv: ["status"],
      env: BASE_ENV,
      ports: { open: () => ({ db: {}, close: () => { closed++; } }), timer: world().timer, write: (l: string) => lines.push(l) },
    });
    expect(out.exitCode).toBe(1);
    expect(closed).toBe(1);
    expect(lines[0]).not.toContain(CANARY);
  });

  it("اتصالی که پس از مهلت دیر باز شد بی‌درنگ بسته می‌شود؛ گزارش closed=false (در جریان بود)", async () => {
    let resolveOpen: (v: unknown) => void = () => undefined;
    let closed = 0;
    const open = () => new Promise((res) => { resolveOpen = res; }) as never;
    const w = world({ ledger: { touchDb: true } }, { open });
    const p = w.run(["status"]);
    await flush();
    await w.timer.advance(60_000);
    const out = await p;
    expect(out.exitCode).toBe(7);
    expect(report(w).closed).toBe(false);
    resolveOpen({ db: { execute: () => Promise.resolve({ rows: [] }), transaction: () => Promise.resolve(undefined) }, close: () => { closed++; } });
    await flush();
    expect(closed).toBe(1);
  });

  it("close پرتاب‌کننده بی‌اثر است و کدِ خروج را عوض نمی‌کند (کار انجام شده بود)", async () => {
    const w = world({ ledger: { touchDb: true } }, { open: () => ({ db: { execute: () => Promise.resolve({ rows: [] }), transaction: () => Promise.resolve(undefined) }, close: () => { throw new Error(CANARY); } }) });
    const out = await w.run(["status"]);
    expect(out.exitCode).toBe(0);
    expect(report(w).closed).toBe(false);
    noLeak(w);
  });
});

describe("settlement-migrate · ورودی/پورتِ خراب و گزارش", () => {
  it("ورودیِ غیرشیء و پورت‌های ناقص ⇒ ۱ بی‌پرتاب", async () => {
    for (const raw of [undefined, null, 5, "x", { argv: ["up"], env: BASE_ENV }, { argv: ["up"], env: BASE_ENV, ports: {} }, { argv: ["up"], env: BASE_ENV, ports: { open: 1, write: 2, timer: 3 } }]) {
      const out = await runSettlementMigrate(raw);
      expect(out.exitCode, JSON.stringify(raw)).toBe(1);
      expect(out.report).toMatchObject({ code: "INTERNAL", ok: false });
    }
  });

  it("زمان‌سنجِ خراب (after می‌پرتابد) ⇒ ۱ و هیچ کاری بی‌مهلت اجرا نمی‌شود", async () => {
    const w = world();
    const out = await runSettlementMigrate({ argv: ["status"], env: BASE_ENV, ports: { ...w.ports, timer: { after: () => { throw new Error(CANARY); }, cancel: () => undefined } } });
    expect(out.exitCode).toBe(1);
    expect(w.calls).toEqual([]);
  });

  it("write پرتاب‌کننده کدِ خروج را عوض نمی‌کند", async () => {
    const w = world();
    const out = await runSettlementMigrate({ argv: ["status"], env: BASE_ENV, ports: { ...w.ports, write: () => { throw new Error(CANARY); } } });
    expect(out.exitCode).toBe(0);
  });

  it("createStores غیرتابع ⇒ ۱", async () => {
    const w = world();
    const out = await runSettlementMigrate({ argv: ["status"], env: BASE_ENV, ports: { ...w.ports, createStores: 5 } });
    expect(out.exitCode).toBe(1);
  });

  it("گزارش: دقیقاً یک خطِ JSONِ تخت با کلیدهای مجاز و فریز؛ exitCode همیشه با جدول یکی است", async () => {
    const ALLOWED = ["tool", "command", "ok", "code", "exitCode", "phase", "stage", "pgCode", "ledger", "settlement", "issues", "usage", "closed"];
    const cases: Array<[World, string[]]> = [
      [world(), ["status"]],
      [world({ ledger: { status: [PENDING, APPLIED], migrate: [okMigrate(["0001_init"])] } }), ["up"]],
      [world({ ledger: { status: [storeErr("DB_ERROR", "08006")] } }), ["status"]],
      [world(), ["up", "--bad"]],
      [world(), ["--help"]],
    ];
    for (const [w, argv] of cases) {
      const out = await w.run(argv, argv[0] === "--help" ? {} : BASE_ENV);
      const r = report(w);
      for (const k of Object.keys(r)) expect(ALLOWED, k).toContain(k);
      expect(r.exitCode).toBe(MIGRATE_EXIT[r.code]);
      expect(out.exitCode).toBe(r.exitCode);
      expect(r.ok).toBe(r.code === "OK");
      expect(Object.isFrozen(out.report)).toBe(true);
    }
  });
});

describe("settlement-migrate · خاصیتی: ناورداهای ترتیب و بی‌نوشتن", () => {
  it("۶۰۰ سناریوی تصادفیِ status/up: ترتیب، بی‌نوشتن در خطا، بسته‌بودنِ نتیجه و بی‌نشت", async () => {
    let seed = 33_000_033;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
    const boom = (): never => { throw new Error(CANARY); };
    type Init = { kind: string; first: unknown; fin: unknown };
    const inits: Init[] = [
      { kind: "applied", first: APPLIED, fin: APPLIED },
      { kind: "pending", first: PENDING, fin: APPLIED },
      { kind: "pending-stuck", first: PENDING, fin: PENDING },
      { kind: "db", first: storeErr("DB_ERROR"), fin: storeErr("DB_ERROR") },
      { kind: "tamper", first: storeErr("MIGRATION_TAMPERED"), fin: storeErr("MIGRATION_TAMPERED") },
      { kind: "malformed", first: { ok: true }, fin: { ok: true } },
      { kind: "throw", first: boom, fin: boom },
    ];
    const migs = [okMigrate(["0001_init"]), okMigrate([]), storeErr("DB_ERROR", "40001"), storeErr("MIGRATION_TAMPERED"), boom];
    const CODES = new Set(Object.keys(MIGRATE_EXIT));
    for (let i = 0; i < 600; i++) {
      const l = pick(inits);
      const s = pick(inits);
      const ml = pick(migs);
      const ms = pick(migs);
      const command = pick(["status", "up"] as const);
      const w = world({ ledger: { status: [l.first, l.fin], migrate: [ml] }, settlement: { status: [s.first, s.fin], migrate: [ms] } });
      const out = await w.run([command]);
      const r = report(w);
      noLeak(w);
      expect(CODES.has(r.code)).toBe(true);
      expect(r.exitCode).toBe(MIGRATE_EXIT[r.code]);
      const firstMigrate = w.calls.findIndex((c) => c.endsWith(".migrate"));
      const checkBroken = [l, s].some((x) => ["db", "tamper", "malformed", "throw"].includes(x.kind));
      if (command === "status") expect(firstMigrate).toBe(-1);
      if (checkBroken) expect(firstMigrate).toBe(-1);
      if (firstMigrate !== -1) {
        expect(w.calls.slice(0, 2)).toEqual(["ledger.status", "settlement.status"]);
        const li = w.calls.indexOf("ledger.migrate");
        const si = w.calls.indexOf("settlement.migrate");
        if (li !== -1 && si !== -1) expect(li).toBeLessThan(si);
        if (li === -1) expect(l.kind).toBe("applied");
      }
      if (out.exitCode === 0 && command === "up") {
        for (const x of [r.ledger, r.settlement]) expect(x?.pending).toEqual([]);
      }
    }
  });
});
