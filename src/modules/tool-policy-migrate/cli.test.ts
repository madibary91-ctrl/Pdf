import { describe, expect, it } from "vitest";
import { runToolPolicyMigrate } from "./cli";
import { APPLY_ATTEMPTS, execute } from "./execute";
import { createRealStore, sqlstateOf } from "./store";
import { BAD_GUARD, BASE_ENV, CANARY, GAPPY, NO_SCHEMA, NO_TABLES, READY, SECRET_URL, flush, migrateOk, schemaOk, statusOk, storeErr, world } from "./test-kit";
import type { World } from "./test-kit";
import { MIGRATE_EXIT } from "./types";
import type { MigrateReport } from "./types";

const report = (w: World): MigrateReport => {
  expect(w.lines).toHaveLength(1);
  expect(w.lines[0]).toMatch(/^\{.*\}\n$/);
  return JSON.parse(w.lines[0] as string) as MigrateReport;
};
const noLeak = (w: World): void => {
  for (const l of w.lines) {
    expect(l).not.toContain(CANARY);
    expect(l).not.toContain(SECRET_URL);
  }
};
const WRITES = ["migrate", "createSchema"];
const wrote = (w: World): boolean => w.calls.some((c) => WRITES.includes(c));

describe("tool-policy-migrate · جدولِ کدهای خروج (قراردادِ استقرار)", () => {
  it("مقدارها و نام‌ها قفل است", () => {
    expect(MIGRATE_EXIT).toEqual({ OK: 0, INTERNAL: 1, USAGE: 2, PENDING: 3, UNAVAILABLE: 4, SCHEMA_MISMATCH: 5, MIGRATION_FAILED: 6, TIMEOUT: 7, SCHEMA_MISSING: 8 });
    expect(Object.isFrozen(MIGRATE_EXIT)).toBe(true);
    expect(new Set(Object.values(MIGRATE_EXIT)).size).toBe(9);
  });
});

describe("tool-policy-migrate · help، خطای آرگومان و پورت (بی‌اتصال)", () => {
  it("help ⇒ OK با usage؛ هیچ اتصالی/فروشگاهی ساخته نمی‌شود", async () => {
    const w = world();
    const out = await w.run(["--help"], {});
    expect(out.exitCode).toBe(0);
    expect(report(w)).toMatchObject({ tool: "tool-policy-migrate", command: "help", ok: true, code: "OK" });
    expect(report(w).usage?.length).toBeGreaterThan(0);
    expect(w.opened.count).toBe(0);
    expect(w.schemas).toEqual([]);
  });
  it("آرگومان/محیطِ بد ⇒ USAGE(2) بی‌اتصال و بی‌فروشگاه؛ هیچ مقداری پژواک نمی‌شود", async () => {
    const w = world();
    const out = await w.run(["up", "--bogus", `postgres://u:${CANARY}@h/d`], { DATABASE_URL: SECRET_URL, TOOL_POLICY_SCHEMAA: CANARY });
    expect(out.exitCode).toBe(2);
    const r = report(w);
    expect(r).toMatchObject({ code: "USAGE", command: "up", ok: false });
    expect(r.issues?.length).toBeGreaterThanOrEqual(2);
    expect([w.opened.count, w.calls.length, w.schemas.length]).toEqual([0, 0, 0]);
    noLeak(w);
  });
  it("شِمای نامعتبر (رد‌شده توسط ذخیره‌سازِ واقعی) ⇒ USAGE بی‌اتصال و فقط نامِ متغیر", async () => {
    const lines: string[] = [];
    let opened = 0;
    const out = await runToolPolicyMigrate({
      argv: ["status"],
      env: { ...BASE_ENV, TOOL_POLICY_SCHEMA: "public" },
      ports: { open: () => (opened++, { db: {}, close: () => undefined }), createSchema: () => undefined, timer: world().timer, write: (l: string) => lines.push(l) },
    });
    expect(out.exitCode).toBe(2);
    expect(out.report.issues).toEqual(["TOOL_POLICY_SCHEMA نامعتبر است."]);
    expect(opened).toBe(0);
    expect(lines.join("")).not.toContain(CANARY);
  });
  it("شِمای معتبر به فروشگاه می‌رسد؛ نبودن ⇒ null", async () => {
    const w = world();
    await w.run(["status"], { ...BASE_ENV, TOOL_POLICY_SCHEMA: "pol_x" });
    await w.run(["status"]);
    expect(w.schemas).toEqual(["pol_x", null]);
  });
  it("پورتِ خراب ⇒ INTERNAL(1) و هرگز پرتاب نمی‌شود", async () => {
    for (const raw of [null, undefined, 5, {}, { ports: {} }, { argv: [], env: {}, ports: { open: 1, write: 1, timer: 1 } }]) {
      const out = await runToolPolicyMigrate(raw);
      expect(out.report).toMatchObject({ code: "INTERNAL", exitCode: 1 });
    }
    const w = world();
    const out = await runToolPolicyMigrate({ argv: ["status"], env: BASE_ENV, ports: { ...w.ports, createStore: 5 } });
    expect(out.report.issues).toEqual(["ports.createStore باید تابع باشد."]);
  });
  it("write پرتاب‌کننده کدِ خروج را عوض نمی‌کند", async () => {
    const w = world();
    const out = await runToolPolicyMigrate({ argv: ["status"], env: BASE_ENV, ports: { ...w.ports, write: () => { throw new Error(CANARY); } } });
    expect(out.exitCode).toBe(0);
  });
});

describe("tool-policy-migrate · status (فقط‌خواندنی)", () => {
  it("آماده ⇒ OK(0)؛ فقط یک status و هیچ نوشتنی", async () => {
    const w = world({ status: [statusOk({ rows: 4, latestVersion: 4 })] });
    const out = await w.run(["status"]);
    expect(out.exitCode).toBe(0);
    expect(w.calls).toEqual(["status"]);
    const r = report(w);
    expect(r).toMatchObject({ code: "OK", ok: true, command: "status", phase: "check", closed: true });
    expect(r.state).toMatchObject({ ready: true, rows: 4, latestVersion: 4, applied: ["0001_init"], pending: [], appliedNow: [], problemCount: 0, schemaExists: true });
    expect(r.schemaCreated).toBeUndefined();
  });
  it.each([
    ["شِما نیست", NO_SCHEMA, 3, "PENDING"],
    ["جدول نیست", NO_TABLES, 3, "PENDING"],
    ["قید/تریگر خاموش", BAD_GUARD, 5, "SCHEMA_MISMATCH"],
    ["شکافِ نسخه‌ها", GAPPY, 5, "SCHEMA_MISMATCH"],
  ])("%s ⇒ %s", async (_n, st, exit, code) => {
    const w = world({ status: [st] });
    const out = await w.run(["status"]);
    expect([out.exitCode, report(w).code]).toEqual([exit, code]);
    expect(w.calls).toEqual(["status"]);
  });
  it("problemCount فقط شمارش است، متنِ مشکل در گزارش نیست", async () => {
    const w = world({ status: [BAD_GUARD] });
    await w.run(["status"]);
    expect(report(w).state?.problemCount).toBe(1);
    expect(w.lines[0]).not.toContain("trigger_missing");
  });
  it.each([
    ["DB_ERROR", "08006", "UNAVAILABLE", 4, "08006"],
    ["DB_ERROR", undefined, "UNAVAILABLE", 4, undefined],
    ["MIGRATION_TAMPERED", undefined, "SCHEMA_MISMATCH", 5, undefined],
    ["MIGRATION_UNKNOWN", undefined, "SCHEMA_MISMATCH", 5, undefined],
    ["CORRUPT_DATA", undefined, "SCHEMA_MISMATCH", 5, undefined],
    ["UNSAFE_SESSION", undefined, "SCHEMA_MISMATCH", 5, undefined],
    ["NOT_MIGRATED", "3F000", "PENDING", 3, "3F000"],
    ["INVALID_INPUT", undefined, "INTERNAL", 1, undefined],
    ["SOMETHING_NEW", undefined, "INTERNAL", 1, undefined],
  ])("خطای status %s/%s ⇒ %s", async (code, pg, expected, exit, pgOut) => {
    const w = world({ status: [storeErr(code, pg)] });
    const out = await w.run(["status"]);
    expect([out.exitCode, report(w).code, report(w).pgCode]).toEqual([exit, expected, pgOut]);
    expect(wrote(w)).toBe(false);
    noLeak(w);
  });
  it("pgCode نامعتبر (نه ۵نویسه) هرگز عبور نمی‌کند", async () => {
    const w = world({ status: [storeErr("DB_ERROR", `bad ${CANARY}`)] });
    await w.run(["status"]);
    expect(report(w).pgCode).toBeUndefined();
    noLeak(w);
  });
  it("پاسخِ بدشکل یا پرتاب ⇒ INTERNAL", async () => {
    const bad: unknown[] = [undefined, null, 5, { ok: "yes" }, { ok: true }, { ok: true, value: null }, { ok: true, value: { ...READY.value, applied: "x" } }, { ok: true, value: { ...READY.value, rows: -1 } }, { ok: true, value: { ...READY.value, rows: 1.5 } }, { ok: true, value: { ...READY.value, latestVersion: "5" } }, { ok: true, value: { ...READY.value, problems: "x" } }, { ok: true, value: { ...READY.value, ready: "true" } }, { ok: true, value: { ...READY.value, contiguous: 1 } }, { ok: true, value: { ...READY.value, schemaExists: undefined } }, { ok: true, value: { ...READY.value, pending: [1] } }];
    for (const b of bad) {
      const w = world({ status: [b] });
      const out = await w.run(["status"]);
      expect(out.report.code, JSON.stringify(b)).toBe("INTERNAL");
    }
    const w = world({ status: [() => { throw new Error(CANARY); }] });
    expect((await w.run(["status"])).report.code).toBe("INTERNAL");
    noLeak(w);
    const w2 = world({ status: [() => Promise.reject(new Error(CANARY))] });
    expect((await w2.run(["status"])).report.code).toBe("INTERNAL");
    noLeak(w2);
  });
});

describe("tool-policy-migrate · up", () => {
  it("آماده ⇒ OK بی‌نوشتن (نه شِما نه migrate)", async () => {
    const w = world({ status: [READY] });
    const out = await w.run(["up", "--create-schema"]);
    expect(out.exitCode).toBe(0);
    expect(w.calls).toEqual(["status"]);
    expect(report(w).phase).toBe("check");
  });
  it("شِما نیست و فلگ نیست ⇒ SCHEMA_MISSING(8) و هیچ نوشتنی", async () => {
    const w = world({ status: [NO_SCHEMA] });
    const out = await w.run(["up"]);
    expect(out.exitCode).toBe(8);
    expect(report(w)).toMatchObject({ code: "SCHEMA_MISSING", phase: "check", ok: false });
    expect(w.calls).toEqual(["status"]);
  });
  it("شِما نیست + --create-schema ⇒ ساختنِ شِما ← migrate ← راستی‌آزمایی؛ OK با schemaCreated", async () => {
    const w = world({ status: [NO_SCHEMA, READY], migrate: [migrateOk(["0001_init"])] });
    const out = await w.run(["up", "--create-schema"]);
    expect(out.exitCode).toBe(0);
    expect(w.calls).toEqual(["status", "createSchema", "migrate", "status"]);
    const r = report(w);
    expect(r).toMatchObject({ code: "OK", phase: "verify", schemaCreated: true, closed: true });
    expect(r.state).toMatchObject({ appliedNow: ["0001_init"], ready: true });
  });
  it("شِما هست ولی جدول نیست ⇒ بدونِ ساختنِ شِما، فقط migrate (حتی با فلگ)", async () => {
    for (const flag of [[], ["--create-schema"]]) {
      const w = world({ status: [NO_TABLES, READY], migrate: [migrateOk()] });
      const out = await w.run(["up", ...flag]);
      expect(out.exitCode).toBe(0);
      expect(w.calls).toEqual(["status", "migrate", "status"]);
      expect(report(w).schemaCreated).toBeUndefined();
    }
  });
  it("ناهمخوانی در check ⇒ SCHEMA_MISMATCH و هیچ نوشتنی (حتی با فلگ)", async () => {
    for (const st of [BAD_GUARD, GAPPY, storeErr("MIGRATION_TAMPERED"), storeErr("UNSAFE_SESSION")]) {
      const w = world({ status: [st] });
      const out = await w.run(["up", "--create-schema"]);
      expect(out.exitCode).toBe(5);
      expect(w.calls).toEqual(["status"]);
      expect(report(w).phase).toBe("check");
    }
  });
  it("پایگاه در دسترس نیست در check ⇒ UNAVAILABLE(4) بی‌نوشتن", async () => {
    const w = world({ status: [storeErr("DB_ERROR", "57P03")] });
    const out = await w.run(["up"]);
    expect([out.exitCode, report(w).pgCode]).toEqual([4, "57P03"]);
    expect(wrote(w)).toBe(false);
  });
  it("شکستِ ساختنِ شِما (42501) ⇒ MIGRATION_FAILED(6) فاز schema، تکرار نمی‌شود، migrate صدا نمی‌خورد", async () => {
    const w = world({ status: [NO_SCHEMA], createSchema: [storeErr("DB_ERROR", "42501")] });
    const out = await w.run(["up", "--create-schema"]);
    expect(out.exitCode).toBe(6);
    expect(report(w)).toMatchObject({ code: "MIGRATION_FAILED", phase: "schema", pgCode: "42501" });
    expect(report(w).retries).toBeUndefined();
    expect(w.calls).toEqual(["status", "createSchema"]);
    noLeak(w);
  });
  it.each([
    ["DB_ERROR", "MIGRATION_FAILED", 6],
    ["NOT_MIGRATED", "MIGRATION_FAILED", 6],
    ["UNSAFE_SESSION", "MIGRATION_FAILED", 6],
    ["MIGRATION_TAMPERED", "SCHEMA_MISMATCH", 5],
    ["MIGRATION_UNKNOWN", "SCHEMA_MISMATCH", 5],
    ["CORRUPT_DATA", "SCHEMA_MISMATCH", 5],
    ["INVALID_INPUT", "INTERNAL", 1],
    ["NEW_CODE", "INTERNAL", 1],
  ])("خطای migrate %s ⇒ %s", async (code, expected, exit) => {
    const w = world({ status: [NO_TABLES], migrate: [storeErr(code, "42P07")] });
    const out = await w.run(["up"]);
    expect([out.exitCode, report(w).code, report(w).phase]).toEqual([exit, expected, "apply"]);
    expect(w.calls.filter((c) => c === "migrate")).toHaveLength(1);
    noLeak(w);
  });
  it("پاسخِ بدشکلِ migrate/createSchema ⇒ INTERNAL", async () => {
    for (const m of [undefined, { ok: true }, { ok: true, value: { applied: "x", alreadyApplied: [] } }, { ok: true, value: { applied: [] } }, { ok: 1 }]) {
      const w = world({ status: [NO_TABLES], migrate: [m] });
      expect((await w.run(["up"])).report.code).toBe("INTERNAL");
    }
    for (const c of [undefined, { ok: true, value: 5 }, { ok: true, value: undefined }]) {
      const w = world({ status: [NO_SCHEMA], createSchema: [c] });
      expect((await w.run(["up", "--create-schema"])).report.code).toBe("INTERNAL");
    }
  });
  it("پس از اعمال هنوز آماده نیست ⇒ MIGRATION_FAILED (هرگز ok بر پایهٔ ادعای migrate)", async () => {
    for (const again of [NO_TABLES, BAD_GUARD, GAPPY]) {
      const w = world({ status: [NO_TABLES, again], migrate: [migrateOk()] });
      const out = await w.run(["up"]);
      expect([out.exitCode, report(w).code, report(w).phase]).toEqual([6, "MIGRATION_FAILED", "verify"]);
    }
  });
  it("خطای خواندنِ راستی‌آزمایی: NOT_MIGRATED ⇒ MIGRATION_FAILED؛ DB_ERROR ⇒ UNAVAILABLE؛ ناهمخوانی ⇒ SCHEMA_MISMATCH", async () => {
    const run = async (e: unknown) => {
      const w = world({ status: [NO_TABLES, e], migrate: [migrateOk()] });
      return (await w.run(["up"])).report;
    };
    expect(await run(storeErr("NOT_MIGRATED"))).toMatchObject({ code: "MIGRATION_FAILED", phase: "verify" });
    expect(await run(storeErr("DB_ERROR", "08006"))).toMatchObject({ code: "UNAVAILABLE", pgCode: "08006" });
    expect(await run(storeErr("MIGRATION_TAMPERED"))).toMatchObject({ code: "SCHEMA_MISMATCH" });
    expect(await run(undefined)).toMatchObject({ code: "INTERNAL" });
  });
  it("وضعیتِ appliedNow دقیقاً همان چیزی است که migrate گزارش کرد", async () => {
    const w = world({ status: [NO_TABLES, statusOk({ applied: ["0001_init", "0002_x"] })], migrate: [migrateOk(["0002_x"])] });
    await w.run(["up"]);
    expect(report(w).state).toMatchObject({ appliedNow: ["0002_x"], applied: ["0001_init", "0002_x"] });
  });
});

describe("tool-policy-migrate · بازتلاشِ هم‌زمانیِ کران‌دار", () => {
  it.each(["23505", "40001", "40P01"])("SQLSTATE %s در migrate: یک‌بار تکرار و موفق؛ retries در گزارش", async (pg) => {
    const w = world({ status: [NO_TABLES, READY], migrate: [storeErr("DB_ERROR", pg), migrateOk()] });
    const out = await w.run(["up"]);
    expect(out.exitCode).toBe(0);
    expect(report(w).retries).toBe(1);
    expect(w.calls.filter((c) => c === "migrate")).toHaveLength(2);
  });
  it("مسابقهٔ ساختنِ شِما (23505) نیز تکرار می‌شود", async () => {
    const w = world({ status: [NO_SCHEMA, READY], createSchema: [storeErr("DB_ERROR", "23505"), schemaOk], migrate: [migrateOk()] });
    const out = await w.run(["up", "--create-schema"]);
    expect(out.exitCode).toBe(0);
    expect(report(w)).toMatchObject({ retries: 1, schemaCreated: true });
  });
  it("پایانِ بازتلاش: دقیقاً APPLY_ATTEMPTS تلاش ⇒ MIGRATION_FAILED با retries=APPLY_ATTEMPTS−1", async () => {
    const w = world({ status: [NO_TABLES], migrate: [storeErr("DB_ERROR", "40P01")] });
    const out = await w.run(["up"]);
    expect(out.exitCode).toBe(6);
    expect(w.calls.filter((c) => c === "migrate")).toHaveLength(APPLY_ATTEMPTS);
    expect(report(w).retries).toBe(APPLY_ATTEMPTS - 1);
  });
  it.each([["42501"], ["42710"], ["08006"], ["57014"]])("SQLSTATE %s هرگز تکرار نمی‌شود", async (pg) => {
    const w = world({ status: [NO_TABLES], migrate: [storeErr("DB_ERROR", pg)] });
    await w.run(["up"]);
    expect(w.calls.filter((c) => c === "migrate")).toHaveLength(1);
  });
  it("کدِ هم‌زمانی با خطای غیر DB_ERROR (مثلاً ناهمخوانی) تکرار نمی‌شود", async () => {
    const w = world({ status: [NO_TABLES], migrate: [storeErr("MIGRATION_TAMPERED", "23505")] });
    const out = await w.run(["up"]);
    expect(out.exitCode).toBe(5);
    expect(w.calls.filter((c) => c === "migrate")).toHaveLength(1);
  });
});

describe("tool-policy-migrate · مهلتِ کل و بستنِ اتصال", () => {
  it("status آویزان ⇒ TIMEOUT(7) پس از مهلت؛ اتصال بسته می‌شود؛ مهلتِ تنظیم‌شده به زمان‌سنج می‌رسد", async () => {
    const w = world({ touchDb: true, status: [() => new Promise(() => undefined)] });
    const p = w.run(["status", "--timeout-ms=1500"]);
    await flush();
    expect(w.timer.delays).toEqual([1500]);
    await w.timer.advance(1500);
    const out = await p;
    expect([out.exitCode, report(w).code, report(w).phase]).toEqual([7, "TIMEOUT", "check"]);
    expect(w.opened).toEqual({ count: 1, closed: 1 });
    expect(report(w).closed).toBe(true);
  });
  it("migrate آویزان ⇒ TIMEOUT در فاز apply و پس از آن هیچ فراخوانیِ تازه‌ای نیست", async () => {
    let release: (v: unknown) => void = () => undefined;
    const w = world({ touchDb: true, status: [NO_TABLES, READY], migrate: [() => new Promise((r) => (release = r))] });
    const p = w.run(["up"]);
    await flush();
    await w.timer.advance(60_000);
    const out = await p;
    expect([out.exitCode, report(w).phase]).toEqual([7, "apply"]);
    release(migrateOk());
    await flush();
    expect(w.calls).toEqual(["status", "migrate"]); // verify (status دوم) اجرا نشد
  });
  it("مهلت در میانهٔ بازتلاش: تلاشِ تازه شروع نمی‌شود", async () => {
    let release: (v: unknown) => void = () => undefined;
    const w = world({ touchDb: true, status: [NO_TABLES], migrate: [() => new Promise((r) => (release = r))] });
    const p = w.run(["up"]);
    await flush();
    await w.timer.advance(60_000);
    await p;
    release(storeErr("DB_ERROR", "40001"));
    await flush();
    expect(w.calls.filter((c) => c === "migrate")).toHaveLength(1);
  });
  it("بستنِ آویزان ⇒ closed=false در گزارش (گلو فرایند را سخت می‌بُرد) پس از ۵ ثانیه", async () => {
    const w = world({ touchDb: true, status: [READY] }, { closeHangs: true });
    const p = w.run(["status"]);
    await flush();
    await w.timer.advance(5_000);
    const out = await p;
    expect(out.exitCode).toBe(0);
    expect(report(w).closed).toBe(false);
  });
  it("اتصال فقط یک‌بار باز و یک‌بار بسته می‌شود (حتی در up کامل)", async () => {
    const w = world({ touchDb: true, status: [NO_SCHEMA, READY], migrate: [migrateOk()] });
    await w.run(["up", "--create-schema"]);
    expect(w.opened).toEqual({ count: 1, closed: 1 });
  });
  it("باز‌کردنِ ناموفق ⇒ UNAVAILABLE/INTERNAL بی‌نشتِ متنِ خطا؛ بستن لازم نیست", async () => {
    const w = world({ touchDb: true, status: [() => Promise.reject(new Error(CANARY))] }, { open: () => { throw new Error(SECRET_URL); } });
    const out = await w.run(["status"]);
    expect(out.report.code).toBe("INTERNAL");
    noLeak(w);
  });
  it("پایگاهِ نامعتبر (بی‌execute/transaction) ⇒ INTERNAL (خطای برنامه‌نویسی) و بسته می‌شود", async () => {
    let closed = 0;
    const w = world({ touchDb: true, status: [READY] }, { open: () => ({ db: {}, close: () => void closed++ }) });
    const out = await w.run(["status"]);
    expect(out.report.code).toBe("INTERNAL");
    expect(closed).toBe(1);
  });
  it("زمان‌سنجِ خراب ⇒ INTERNAL و هیچ فراخوانیِ فروشگاه (بی‌مهلت اجرا نمی‌کنیم)", async () => {
    const w = world();
    const out = await runToolPolicyMigrate({ argv: ["up"], env: BASE_ENV, ports: { ...w.ports, timer: { after: () => { throw new Error("x"); }, cancel: () => undefined } } });
    expect(out.report.code).toBe("INTERNAL");
    expect(w.calls).toEqual([]);
  });
});

describe("tool-policy-migrate · گزارش", () => {
  it("همیشه یک خطِ JSONِ تخت با کلیدهای ثابت و frozen", async () => {
    const w = world({ status: [NO_SCHEMA, READY], migrate: [migrateOk()] });
    const out = await w.run(["up", "--create-schema"]);
    const r = report(w);
    expect(Object.keys(r).sort()).toEqual(["closed", "code", "command", "exitCode", "ok", "phase", "schemaCreated", "state", "tool"]);
    expect(r.exitCode).toBe(MIGRATE_EXIT[r.code]);
    expect(Object.isFrozen(out.report)).toBe(true);
  });
  it("هیچ‌جا قناریِ محیط/خطا نیست (ماتریسِ خطاها)", async () => {
    for (const status of [storeErr("DB_ERROR", "08006"), storeErr("MIGRATION_TAMPERED"), BAD_GUARD, NO_SCHEMA]) {
      for (const argv of [["status"], ["up"], ["up", "--create-schema"]]) {
        const w = world({ status: [status], createSchema: [storeErr("DB_ERROR", "42501")], migrate: [storeErr("DB_ERROR", "42501")] });
        await w.run(argv, { ...BASE_ENV, TOOL_POLICY_SCHEMA: "pol_ok" });
        noLeak(w);
      }
    }
  });
});

describe("tool-policy-migrate · قفلِ مقدارها و شاخه‌های دفاعی (جهش‌آزمایی)", () => {
  it("APPLY_ATTEMPTS لفظاً ۳ است (قراردادِ بازتلاش)", () => {
    expect(APPLY_ATTEMPTS).toBe(3);
  });
  it("هر pgCode با پسوندِ اضافه (مثلاً SQLSTATE + متن) رد می‌شود و هرگز عبور نمی‌کند", async () => {
    for (const bad of [`42501 ${CANARY}`, `4250`, `425011`, "42501\n"]) {
      const w = world({ status: [storeErr("DB_ERROR", bad)] });
      await w.run(["status"]);
      expect(report(w).pgCode, bad).toBeUndefined();
      noLeak(w);
    }
  });
  it("sqlstateOf: فقط SQLSTATEِ دقیقاً ۵نویسه، از زنجیرهٔ cause (تا عمقِ ۶)", () => {
    expect(sqlstateOf({ code: "42501" })).toBe("42501");
    expect(sqlstateOf({ code: "42501 x" })).toBeNull();
    expect(sqlstateOf({ code: "ECONNRESET" })).toBeNull();
    expect(sqlstateOf({ cause: { cause: { code: "23505" } } })).toBe("23505");
    expect(sqlstateOf({ cause: { cause: { cause: { cause: { cause: { code: "23505" } } } } } })).toBe("23505");
    expect(sqlstateOf({ cause: { cause: { cause: { cause: { cause: { cause: { code: "23505" } } } } } } })).toBeNull();
    for (const v of [null, undefined, 5, "x"]) expect(sqlstateOf(v)).toBeNull();
    const loop: { cause?: unknown } = {};
    loop.cause = loop;
    expect(sqlstateOf(loop)).toBeNull();
  });
  it("ok غیرِ بولی (۱ یا 'true') پذیرفته نمی‌شود حتی با value سالم", async () => {
    for (const okv of [1, "true", {}]) {
      const w = world({ status: [{ ok: okv, value: READY.value }] });
      expect((await w.run(["status"])).report.code, String(okv)).toBe("INTERNAL");
    }
  });
  it("execute با progress ازپیش‌لغوشده: هیچ فراخوانیِ فروشگاه و TIMEOUT", async () => {
    const calls: string[] = [];
    const store = { status: () => (calls.push("status"), Promise.resolve(READY)), migrate: () => (calls.push("migrate"), Promise.resolve(migrateOk())), createSchema: () => (calls.push("createSchema"), Promise.resolve(schemaOk)) };
    const progress = { phase: "check" as const, state: undefined, schemaCreated: false, cancelled: true, retries: 0 };
    const v = await execute("up", true, store as never, progress);
    expect(v).toEqual({ code: "TIMEOUT", phase: "check" });
    expect(calls).toEqual([]);
  });
  it("پایگاهِ نامعتبر حتی وقتی فروشگاه شکستِ باز‌شدن را می‌بلعد ⇒ INTERNAL (نه OK) و بسته می‌شود", async () => {
    const swallow = (db: unknown) => ({
      ok: true as const,
      store: {
        status: async () => {
          try {
            await (db as { execute(q: unknown): Promise<unknown> }).execute({});
          } catch {
            // عمداً می‌بلعد: فقط پرچمِ invalid() باید جلوی «OK»ِ دروغ را بگیرد.
          }
          return READY as never;
        },
        migrate: () => Promise.resolve(migrateOk()) as never,
        createSchema: () => Promise.resolve(schemaOk) as never,
      },
    });
    const shapes: Array<[string, () => unknown]> = [
      ["بی‌execute", () => ({ db: { transaction: () => undefined }, close: () => undefined })],
      ["بی‌transaction", () => ({ db: { execute: () => undefined }, close: () => undefined })],
      ["db غیرشیء", () => ({ db: 5, close: () => undefined })],
    ];
    for (const [label, make] of shapes) {
      const w = world();
      const out = await runToolPolicyMigrate({ argv: ["status"], env: BASE_ENV, ports: { ...w.ports, open: make as never, createStore: swallow } });
      expect(out.report.code, label).toBe("INTERNAL");
      expect(out.report.pgCode, label).toBeUndefined();
    }
  });
  it("بازشدنِ هنوز-در-جریان هنگامِ مهلت: closed=false؛ و اتصالِ دیرهنگام پس از رسیدن بی‌درنگ بسته می‌شود", async () => {
    let release: (v: unknown) => void = () => undefined;
    let closedLate = 0;
    const w = world({ touchDb: true, status: [READY] }, { open: () => new Promise((r) => (release = r)) as never });
    const p = w.run(["status"]);
    await flush();
    await w.timer.advance(60_000);
    const out = await p;
    expect([out.report.code, out.report.closed]).toEqual(["TIMEOUT", false]);
    release({ db: { execute: () => Promise.resolve({ rows: [] }), transaction: () => Promise.resolve(undefined) }, close: () => void closedLate++ });
    await flush();
    expect(closedLate).toBe(1);
  });
  it("هیچ زمان‌سنجی بیکار نمی‌ماند: پس از پایانِ اجرا همه لغو شده‌اند", async () => {
    const w = world({ touchDb: true, status: [NO_SCHEMA, READY], migrate: [migrateOk()] });
    await w.run(["up", "--create-schema"]);
    expect(w.timer.delays.length).toBeGreaterThanOrEqual(2); // مهلتِ کل + مهلتِ بستن
    expect(w.timer.pending()).toBe(0);
  });
});

describe("tool-policy-migrate · ساختنِ شِما فقط از پورتِ گلو (ماژول SQL ندارد)", () => {
  const fakeDb = { execute: () => Promise.resolve({ rows: [] }), transaction: () => Promise.resolve(undefined) };

  it("بدونِ createStore، پورتِ createSchema الزامی است ⇒ INTERNAL بی‌اتصال", async () => {
    const w = world();
    const out = await runToolPolicyMigrate({ argv: ["status"], env: BASE_ENV, ports: { open: w.ports.open, timer: w.ports.timer, write: w.ports.write } });
    expect(out.report).toMatchObject({ code: "INTERNAL", issues: ["ports.createSchema باید تابع باشد."] });
    expect(w.opened.count).toBe(0);
    const w2 = world();
    const out2 = await runToolPolicyMigrate({ argv: ["status"], env: BASE_ENV, ports: { ...w2.ports, createStore: undefined as never, createSchema: 5 as never } });
    expect(out2.report.code).toBe("INTERNAL");
  });
  it("createRealStore: پورت با (db، شِمای اعتبارسنجی‌شده) صدا زده می‌شود؛ شِمای پیش‌فرض tool_policy", async () => {
    const seen: unknown[][] = [];
    const a = createRealStore(fakeDb, "pol_x", (...args) => void seen.push(args));
    const b = createRealStore(fakeDb, null, (...args) => void seen.push(args));
    if (!a.ok || !b.ok) throw new Error("store");
    expect(await a.store.createSchema()).toEqual({ ok: true, value: null });
    expect(await b.store.createSchema()).toEqual({ ok: true, value: null });
    expect(seen).toEqual([[fakeDb, "pol_x"], [fakeDb, "tool_policy"]]);
  });
  it("createRealStore: شِمای نامعتبر ⇒ issues فقط نامِ متغیر و پورت هرگز صدا زده نمی‌شود", async () => {
    let called = 0;
    for (const bad of ["public", "Pol", "pg_x", "a-b", "x".repeat(41), "information_schema"]) {
      const r = createRealStore(fakeDb, bad, () => void called++);
      expect(r).toEqual({ ok: false, issues: ["TOOL_POLICY_SCHEMA نامعتبر است."] });
    }
    expect(called).toBe(0);
  });
  it("createRealStore: رد/پرتابِ پورت ⇒ DB_ERROR با SQLSTATEِ cause و هرگز متنِ خطا؛ بی‌پورت ⇒ DB_ERROR بی‌pgCode", async () => {
    const mk = (port: (db: unknown, s: string) => unknown) => {
      const r = createRealStore(fakeDb, "pol_x", port);
      if (!r.ok) throw new Error("store");
      return r.store;
    };
    const wrapped = Object.assign(new Error(CANARY), { cause: Object.assign(new Error(CANARY), { code: "42501" }) });
    const rejected = await mk(() => Promise.reject(wrapped)).createSchema();
    expect(rejected).toMatchObject({ ok: false, error: { code: "DB_ERROR", pgCode: "42501" } });
    expect(JSON.stringify(rejected)).not.toContain(CANARY);
    const thrown = await mk(() => { throw Object.assign(new Error(CANARY), { code: "23505" }); }).createSchema();
    expect(thrown).toMatchObject({ ok: false, error: { code: "DB_ERROR", pgCode: "23505" } });
    const plain = await mk(() => Promise.reject(new Error(CANARY))).createSchema();
    expect(plain).toMatchObject({ ok: false, error: { code: "DB_ERROR" } });
    expect((plain as { error: { pgCode?: string } }).error.pgCode).toBeUndefined();
    const none = createRealStore(fakeDb, "pol_x", undefined);
    if (!none.ok) throw new Error("store");
    expect(await none.store.createSchema()).toMatchObject({ ok: false, error: { code: "DB_ERROR" } });
  });
  it("فروشگاهِ واقعی روی پایگاهِ خرابِ ساختگی با --create-schema ⇒ UNAVAILABLE(4) در check؛ هیچ DDLای (پورت) نمی‌رود و چیزی نشت نمی‌کند", async () => {
    const seen: string[] = [];
    const lines: string[] = [];
    const db = { execute: () => Promise.reject(new Error(CANARY)), transaction: () => Promise.reject(new Error(CANARY)) };
    const w = world();
    const out = await runToolPolicyMigrate({ argv: ["up", "--create-schema"], env: { ...BASE_ENV, TOOL_POLICY_SCHEMA: "pol_x" }, ports: { open: () => ({ db, close: () => undefined }), timer: w.timer, write: (l: string) => lines.push(l), createSchema: (_d: unknown, s: string) => void seen.push(s) } });
    expect(out.exitCode).toBe(4); // status() روی پایگاهِ خراب ⇒ UNAVAILABLE؛ هیچ DDLای نرفت
    expect(seen).toEqual([]);
    expect(lines.join("")).not.toContain(CANARY);
  });
});
