import { describe, expect, it } from "vitest";
import { SETTLEMENT_BACKLOG_WATCH_ENV } from "@/modules/settlement-backlog-watch";
import { DEFAULT_TIMEOUT_MS, KNOWN_SETTLEMENT_ENV, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, USAGE, parsePendingMigrateArgs } from "./args";
import { CANARY, SECRET_URL } from "./test-kit";

const ENV = { DATABASE_URL: "x" };
const issuesOf = (argv: unknown, env: unknown): readonly string[] => {
  const r = parsePendingMigrateArgs(argv, env);
  if (r.ok) throw new Error("انتظار خطا بود");
  return r.issues;
};

describe("settlement-pending-migrate · args", () => {
  it("سه دستورِ معتبر؛ پیش‌فرضِ مهلت و شِما", () => {
    for (const command of ["status", "up", "verify"] as const) {
      expect(parsePendingMigrateArgs([command], ENV)).toEqual({ ok: true, value: { command, timeoutMs: DEFAULT_TIMEOUT_MS, schema: null } });
    }
    expect(DEFAULT_TIMEOUT_MS).toBe(60_000);
  });

  it("--help تنها ⇒ help (بی‌نیاز به env)؛ -h هم؛ همراهِ چیزِ دیگر خطا", () => {
    expect(parsePendingMigrateArgs(["--help"], {})).toEqual({ ok: true, value: { command: "help" } });
    expect(parsePendingMigrateArgs(["-h"], undefined)).toEqual({ ok: true, value: { command: "help" } });
    expect(issuesOf(["up", "--help"], ENV)).toContain("--help باید تنها بیاید.");
  });

  it("--timeout-ms: فقط رقمِ لاتینِ مثبت در بازه؛ مرزها پذیرفته؛ شکلِ دو‌توکنی/تکراری/صفرِ پیشین/عربی/اعشار رد", () => {
    const ok = (v: string): unknown => parsePendingMigrateArgs(["up", `--timeout-ms=${v}`], ENV);
    expect(ok(String(MIN_TIMEOUT_MS))).toMatchObject({ ok: true, value: { timeoutMs: 1000 } });
    expect(ok(String(MAX_TIMEOUT_MS))).toMatchObject({ ok: true, value: { timeoutMs: 600_000 } });
    for (const bad of ["999", "600001", "0", "01000", "1e3", "1000.5", "-1000", "۱۰۰۰", "", " 1000", "1000 ", "99999999999"]) expect(ok(bad), bad).toMatchObject({ ok: false });
    expect(issuesOf(["up", "--timeout-ms", "5000"], ENV).length).toBeGreaterThan(0);
    expect(issuesOf(["up", "--timeout-ms=5000", "--timeout-ms=6000"], ENV)).toContain("--timeout-ms تکراری است.");
  });

  it("دستور: نبودن، ناشناخته، تکراری، اضافه ⇒ خطا؛ command در خطا حفظ می‌شود", () => {
    expect(issuesOf([], ENV)).toContain("دستور لازم است (status، up یا verify).");
    expect(issuesOf(["down"], ENV).length).toBeGreaterThan(0);
    expect(issuesOf(["up", "up"], ENV)).toContain("آرگومانِ اضافه (فقط یک دستور).");
    expect(issuesOf(["up", "status"], ENV)).toContain("آرگومانِ اضافه (فقط یک دستور).");
    const r = parsePendingMigrateArgs(["verify", "--nope"], ENV);
    expect(r).toMatchObject({ ok: false, command: "verify" });
  });

  it("آرگومانِ موضعی (مثلاً رشتهٔ اتصالِ اشتباه) و مقدارِ فلگ هرگز پژواک نمی‌شود", () => {
    const all = [issuesOf(["up", SECRET_URL], ENV), issuesOf([SECRET_URL], ENV), issuesOf(["up", `--${CANARY}=1`], ENV), issuesOf(["up", `-${CANARY}`], ENV), issuesOf(["up", `--timeout-ms=${CANARY}`], ENV)];
    for (const i of all) expect(JSON.stringify(i)).not.toContain(CANARY);
  });

  it("env: DATABASE_URL الزامی؛ مقدارش هرگز در خروجی نیست؛ غیرِ‌شیء رد", () => {
    expect(issuesOf(["up"], {})).toContain("DATABASE_URL الزامی است.");
    expect(issuesOf(["up"], { DATABASE_URL: "" })).toContain("DATABASE_URL الزامی است.");
    expect(issuesOf(["up"], { DATABASE_URL: 5 })).toContain("DATABASE_URL الزامی است.");
    for (const bad of [null, undefined, [], "x", 5]) expect(issuesOf(["up"], bad)).toContain("env باید یک شیء ساده باشد.");
    const ok = parsePendingMigrateArgs(["up"], { DATABASE_URL: SECRET_URL });
    expect(JSON.stringify(ok)).not.toContain(CANARY);
  });

  it("شِما فقط از SETTLEMENT_OUTBOX_SCHEMA؛ خالی/نبودن = null؛ غیررشته خطا؛ شِمای ledger نادیده ولی شناخته", () => {
    expect(parsePendingMigrateArgs(["up"], { ...ENV, SETTLEMENT_OUTBOX_SCHEMA: "out_x" })).toMatchObject({ ok: true, value: { schema: "out_x" } });
    expect(parsePendingMigrateArgs(["up"], { ...ENV, SETTLEMENT_OUTBOX_SCHEMA: "" })).toMatchObject({ ok: true, value: { schema: null } });
    expect(parsePendingMigrateArgs(["up"], { ...ENV, SETTLEMENT_LEDGER_SCHEMA: "led_x" })).toMatchObject({ ok: true, value: { schema: null } });
    for (const bad of [5, null, {}, []]) expect(issuesOf(["up"], { ...ENV, SETTLEMENT_OUTBOX_SCHEMA: bad })).toContain("SETTLEMENT_OUTBOX_SCHEMA باید رشته باشد.");
    // نوعِ شِمای ledger هم سنجیده می‌شود (هم‌معنا با bootstrap)، هرچند مقدارش به کار نمی‌رود.
    for (const bad of [5, null, {}, []]) expect(issuesOf(["up"], { ...ENV, SETTLEMENT_LEDGER_SCHEMA: bad })).toContain("SETTLEMENT_LEDGER_SCHEMA باید رشته باشد.");
  });

  it("غلط‌یابِ نام: SETTLEMENT_* ناشناخته همیشه خطاست؛ مقدارش پژواک نمی‌شود؛ متغیرهای غیرِ SETTLEMENT_ بی‌اثر", () => {
    for (const k of ["SETTLEMENT_OUTBOX_SCHEMAA", "SETTLEMENT_TYPO", "SETTLEMENT_", "SETTLEMENT_BACKLOG_SOURCE_X"]) {
      const i = issuesOf(["up"], { ...ENV, [k]: CANARY });
      expect(i.some((m) => m.includes("ناشناخته")), k).toBe(true);
      expect(JSON.stringify(i)).not.toContain(CANARY);
    }
    expect(parsePendingMigrateArgs(["up"], { ...ENV, NODE_ENV: "x", PATH: "y" })).toMatchObject({ ok: true });
  });

  it("متغیرهای پایشِ پسماند (که settlement-migrate رد می‌کرد) شناخته‌اند: همان فایلِ envِ برنامه کار می‌کند", () => {
    const names = ["SETTLEMENT_HOST", "SETTLEMENT_BACKLOG_WATCH", ...Object.values(SETTLEMENT_BACKLOG_WATCH_ENV)];
    const env = Object.fromEntries(names.map((n) => [n, "on"]));
    expect(parsePendingMigrateArgs(["status"], { ...ENV, ...env })).toMatchObject({ ok: true });
    for (const n of names) expect(KNOWN_SETTLEMENT_ENV).toContain(n);
    expect(new Set(KNOWN_SETTLEMENT_ENV).size).toBe(KNOWN_SETTLEMENT_ENV.length);
  });

  it("ورودی‌های بدجنس هرگز نمی‌پرتابند (getter پرتاب‌کننده، Proxy، argv غیرِ‌رشته)", () => {
    const evil = { get DATABASE_URL(): string { throw new Error(CANARY); } };
    const r = parsePendingMigrateArgs(["up"], evil);
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).not.toContain(CANARY);
    for (const argv of [null, undefined, "up", ["up", 5], [{}], new Proxy([], { get() { throw new Error("x"); } })]) expect(() => parsePendingMigrateArgs(argv, ENV)).not.toThrow();
    expect(parsePendingMigrateArgs(["up", 5], ENV)).toMatchObject({ ok: false });
  });

  it("USAGE ثابت و بی‌مقدار است و هر سه دستور و همهٔ کدهای خروج را نام می‌برد", () => {
    expect(Object.isFrozen(USAGE)).toBe(true);
    const text = USAGE.join("\n");
    for (const w of ["status", "up", "verify", "prerequisite", "inconsistent", "lock-busy", "timeout"]) expect(text).toContain(w);
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
  });
});
