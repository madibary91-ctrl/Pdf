import { describe, expect, it } from "vitest";
import { DEFAULT_TIMEOUT_MS, KNOWN_SETTLEMENT_ENV, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, parseMigrateArgs } from "./args";
import { BASE_ENV, CANARY, SECRET_URL } from "./test-kit";

const ENV = BASE_ENV;
const ok = (argv: unknown, env: unknown = ENV) => {
  const r = parseMigrateArgs(argv, env);
  if (!r.ok) throw new Error(`انتظار موفقیت: ${JSON.stringify(r.issues)}`);
  return r.value;
};
const bad = (argv: unknown, env: unknown = ENV) => {
  const r = parseMigrateArgs(argv, env);
  if (r.ok) throw new Error("انتظار خطا");
  return r;
};

describe("settlement-migrate · آرگومان‌ها", () => {
  it("status و up با پیش‌فرض‌ها: مهلتِ ۶۰ ثانیه و شِمای پیش‌فرض (null)", () => {
    for (const command of ["status", "up"] as const) {
      expect(ok([command])).toEqual({ command, timeoutMs: DEFAULT_TIMEOUT_MS, ledgerSchema: null, settlementSchema: null });
    }
    expect(DEFAULT_TIMEOUT_MS).toBe(60_000);
  });

  it("--help و -h فقط تنها معتبرند و نیازی به env ندارند", () => {
    expect(ok(["--help"], {})).toEqual({ command: "help" });
    expect(ok(["-h"], undefined)).toEqual({ command: "help" });
    expect(bad(["--help", "status"]).issues).toContain("--help باید تنها بیاید.");
    expect(bad(["status", "-h"]).issues).toContain("--help باید تنها بیاید.");
  });

  it("دستور: نبودن، ناشناخته، تکراری و اضافه خطاست و آرگومانِ موضعی هرگز پژواک نمی‌شود", () => {
    expect(bad([]).issues).toEqual(["دستور لازم است (status یا up)."]);
    expect(bad(["down"]).issues).toEqual(["دستورِ ناشناخته (status یا up)."]);
    expect(JSON.stringify(bad([SECRET_URL]))).not.toContain(CANARY);
    expect(JSON.stringify(bad(["up", SECRET_URL]))).not.toContain(CANARY);
    expect(bad(["status", "up"]).issues).toContain("آرگومانِ اضافه (فقط یک دستور).");
    expect(bad(["up", "up"]).issues).toContain("آرگومانِ اضافه (فقط یک دستور).");
    expect(bad(["UP"]).issues[0]).toContain("ناشناخته");
    expect(bad(["Status"]).issues[0]).toContain("ناشناخته");
    expect(bad([" up"]).issues[0]).toContain("ناشناخته");
  });

  it("--timeout-ms: فقط یک‌توکن و رقمِ لاتینِ مثبت در [۱۰۰۰، ۶۰۰۰۰۰]", () => {
    expect((ok(["up", "--timeout-ms=1000"]) as { timeoutMs: number }).timeoutMs).toBe(MIN_TIMEOUT_MS);
    expect((ok(["--timeout-ms=600000", "status"]) as { timeoutMs: number }).timeoutMs).toBe(MAX_TIMEOUT_MS);
    for (const v of ["", "0", "999", "600001", "01000", "+1000", "-1000", "1e3", "1000.5", " 1000", "1000 ", "۱۰۰۰", "0x400", "99999999999", "abc"]) {
      expect(bad(["up", `--timeout-ms=${v}`]).issues.join(), JSON.stringify(v)).toContain("--timeout-ms باید");
    }
    expect(bad(["up", "--timeout-ms"]).issues.join()).toContain("--timeout-ms باید");
    expect(bad(["up", "--timeout-ms", "5000"]).issues.length).toBeGreaterThan(0);
    expect(bad(["up", "--timeout-ms=2000", "--timeout-ms=3000"]).issues).toContain("--timeout-ms تکراری است.");
  });

  it("فلگِ ناشناخته: نامِ آن (نه مقدارش) در پیام می‌آید؛ مقدارِ فلگ هرگز", () => {
    const r = bad(["up", `--schema=${CANARY}`]);
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(r.issues[0]).toContain('"--schema"');
    expect(bad(["up", "-x"]).issues[0]).toContain("ناشناخته");
    expect(bad([`--${SECRET_URL}`, "up"]).issues).toEqual(["فلگِ ناشناختهٔ ?."]);
    expect(bad(["up", "--"]).issues[0]).toContain("ناشناخته");
    expect(bad(["up", "-"]).issues[0]).toContain("ناشناخته");
    expect(bad(["up", "--dry-run"]).issues[0]).toContain("--dry-run");
  });

  it("argv باید آرایهٔ رشته باشد", () => {
    for (const v of [undefined, null, "up", 1, {}, [1], ["up", 2], [null], [["up"]]]) expect(bad(v).issues, JSON.stringify(v)).toEqual(["argv باید آرایه‌ای از رشته باشد."]);
  });

  it("DATABASE_URL الزامی است؛ مقدارش هرگز در نتیجه نیست", () => {
    for (const env of [{}, { DATABASE_URL: "" }, { DATABASE_URL: 5 }, { DATABASE_URL: undefined }, { DATABASE_URL: null }]) {
      expect(bad(["up"], env).issues).toContain("DATABASE_URL الزامی است.");
    }
    const r = ok(["up"], { DATABASE_URL: CANARY });
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(Object.keys(r)).not.toContain("databaseUrl");
  });

  it("env باید شیء ساده باشد", () => {
    for (const env of [undefined, null, "x", 3, [], [["DATABASE_URL", "x"]]]) {
      const r = parseMigrateArgs(["up"], env);
      expect(r.ok, JSON.stringify(env)).toBe(false);
      expect(r.ok ? [] : r.issues).toContain("env باید یک شیء ساده باشد.");
    }
  });

  it("شِماها از env: نبودن/خالی = null؛ رشته = همان؛ غیررشته = خطای نامِ متغیر", () => {
    expect(ok(["up"], { ...ENV, SETTLEMENT_LEDGER_SCHEMA: "", SETTLEMENT_OUTBOX_SCHEMA: undefined })).toMatchObject({ ledgerSchema: null, settlementSchema: null });
    expect(ok(["up"], { ...ENV, SETTLEMENT_LEDGER_SCHEMA: "led_x", SETTLEMENT_OUTBOX_SCHEMA: "out_x" })).toMatchObject({ ledgerSchema: "led_x", settlementSchema: "out_x" });
    expect(bad(["up"], { ...ENV, SETTLEMENT_LEDGER_SCHEMA: 5 }).issues).toEqual(["SETTLEMENT_LEDGER_SCHEMA باید رشته باشد."]);
    expect(bad(["up"], { ...ENV, SETTLEMENT_OUTBOX_SCHEMA: {} }).issues).toEqual(["SETTLEMENT_OUTBOX_SCHEMA باید رشته باشد."]);
  });

  it("غلط‌یابِ نام: هر SETTLEMENT_* ناشناخته همیشه خطاست؛ شناخته‌شده‌ها (حتی با مقدارِ دلخواه) نادیده‌اند", () => {
    for (const k of ["SETTLEMENT_OUTBOX_SCHEMAA", "SETTLEMENT_GRAC_MS", "SETTLEMENT_", "SETTLEMENT_MIGRATE_TIMEOUT_MS"]) {
      const r = bad(["up"], { ...ENV, [k]: "x" });
      expect(r.issues[0]).toContain(JSON.stringify(k));
    }
    const env: Record<string, string> = { ...ENV };
    for (const k of KNOWN_SETTLEMENT_ENV) if (!k.endsWith("_SCHEMA")) env[k] = `مقدارِ-نامعتبر-${CANARY}`;
    const r = ok(["status"], env);
    expect(r).toEqual({ command: "status", timeoutMs: DEFAULT_TIMEOUT_MS, ledgerSchema: null, settlementSchema: null });
    expect(ok(["up"], { ...ENV, settlement_x: "1", NODE_ENV: "production", PATH: "/bin" })).toMatchObject({ command: "up" });
  });

  it("نامِ بلند/غیرقابل‌چاپِ کلید در پیام کوتاه و پاک‌سازی می‌شود", () => {
    const r = bad(["up"], { ...ENV, [`SETTLEMENT_\u0007${"X".repeat(500)}`]: "1" });
    expect(r.issues[0]?.length).toBeLessThan(160);
    expect(r.issues[0]).toContain("?");
  });

  it("چند خطا هم‌زمان گزارش می‌شود (دستور + مهلت + env) و command معتبر حفظ می‌شود", () => {
    const r = bad(["up", "--timeout-ms=1", "--zzz"], {});
    expect(r.command).toBe("up");
    expect(r.issues.length).toBe(3);
    expect(bad(["nope"], {}).command).toBeNull();
  });

  it("خروجی‌ها فریزند", () => {
    expect(Object.isFrozen(ok(["up"]))).toBe(true);
    expect(Object.isFrozen(bad(["up", "--x"]).issues)).toBe(true);
    expect(Object.isFrozen(ok(["--help"]))).toBe(true);
  });

  it("بدجنس: Proxy، getterِ پرتاب‌کننده و کلیدهای پرتاب‌کننده هرگز نمی‌پرتابند", () => {
    const proxy = new Proxy({}, { ownKeys: () => { throw new Error(CANARY); }, get: () => { throw new Error(CANARY); } });
    const r1 = parseMigrateArgs(["up"], proxy);
    expect(r1.ok).toBe(false);
    expect(JSON.stringify(r1)).not.toContain(CANARY);
    const getter = { get DATABASE_URL(): string { throw new Error(CANARY); } };
    const r2 = parseMigrateArgs(["up"], getter);
    expect(r2.ok).toBe(false);
    expect(JSON.stringify(r2)).not.toContain(CANARY);
    const argvProxy = new Proxy([], { get: () => { throw new Error(CANARY); } });
    expect(parseMigrateArgs(argvProxy, ENV).ok).toBe(false);
  });

  it("خاصیتی: ۲۰۰۰ ورودیِ تصادفی هرگز نمی‌پرتابد، همیشه نتیجهٔ بسته و بی‌نشتِ قناری می‌دهد", () => {
    let seed = 20261119;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pool = ["status", "up", "--help", "-h", "--timeout-ms=5000", "--timeout-ms=", "--timeout-ms=1", `--x=${CANARY}`, "", " ", "\u0000", "--", "-", "UP", CANARY];
    const envKeys = ["DATABASE_URL", "SETTLEMENT_LEDGER_SCHEMA", "SETTLEMENT_OUTBOX_SCHEMA", "SETTLEMENT_HOST", "SETTLEMENT_TYPO", "NODE_ENV"];
    const vals: unknown[] = ["", "x", "led_a", 5, null, undefined, CANARY, {}, []];
    for (let i = 0; i < 2000; i++) {
      const argv = Array.from({ length: Math.floor(rnd() * 5) }, () => pool[Math.floor(rnd() * pool.length)] as string);
      const env: Record<string, unknown> = {};
      for (const k of envKeys) if (rnd() < 0.5) env[k] = vals[Math.floor(rnd() * vals.length)];
      const r = parseMigrateArgs(argv, env);
      expect(typeof r.ok).toBe("boolean");
      if (r.ok) {
        expect(["status", "up", "help"]).toContain(r.value.command);
        expect(JSON.stringify(r.value)).not.toContain(CANARY);
      } else {
        expect(r.issues.length).toBeGreaterThan(0);
        expect(JSON.stringify(r)).not.toContain(CANARY);
      }
    }
  });
});
