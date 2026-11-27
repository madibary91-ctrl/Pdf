import { describe, expect, it } from "vitest";
import { parseGrantsArgs, DEFAULT_TIMEOUT_MS, KNOWN_TOOL_POLICY_ENV } from "./args";
import { CANARY } from "./test-kit";

const ENV = { DATABASE_URL: "x://a" };
const ok = (argv: unknown, env: unknown = ENV) => {
  const r = parseGrantsArgs(argv, env);
  if (!r.ok) throw new Error(`expected ok: ${JSON.stringify(r.issues)}`);
  return r.value;
};
const bad = (argv: unknown, env: unknown = ENV) => {
  const r = parseGrantsArgs(argv, env);
  if (r.ok) throw new Error("expected failure");
  return r;
};

describe("tool-policy-grants · args", () => {
  it("--help تنها ⇒ help؛ با چیزِ دیگر ⇒ خطا", () => {
    expect(ok(["--help"], undefined)).toEqual({ command: "help" });
    expect(ok(["-h"], 5)).toEqual({ command: "help" });
    expect(bad(["plan", "--role=a", "--help"]).issues).toContain("--help باید تنها بیاید.");
    expect(bad(["--help", "verify"]).issues).toContain("--help باید تنها بیاید.");
    expect(bad(["--help", "--help"]).issues).toContain("--help باید تنها بیاید.");
  });

  it("سه دستور با پیش‌فرض‌ها", () => {
    for (const c of ["plan", "verify", "apply"] as const) expect(ok([c, "--role=policy_runtime"])).toEqual({ command: c, role: "policy_runtime", schema: null, timeoutMs: DEFAULT_TIMEOUT_MS });
  });

  it("--role الزامی، تک‌بار و با فهرست‌سفید؛ مقدارش هرگز پژواک نمی‌شود", () => {
    expect(bad(["verify"]).issues).toContain("--role الزامی است.");
    expect(bad(["verify", "--role"]).issues.join()).toContain("--role نامعتبر");
    expect(bad(["verify", "--role=a", "--role=b"]).issues).toContain("--role تکراری است.");
    const invalid = ["", "A", "Role", "1abc", "_a", "a-b", "a b", 'a";DROP', "postgres", "public", "none", "user", "current_user", "session_user", "current_role", "pg_read_all_data", "pg_x", "a".repeat(64), "ن", "a.b", "a\n"];
    for (const v of invalid) {
      const r = bad(["verify", `--role=${v}`, `--role=${CANARY}`]);
      expect(r.issues.join(" "), JSON.stringify(v)).not.toContain(CANARY);
    }
    for (const v of invalid) expect(bad(["verify", `--role=${v}`]).issues.join(""), JSON.stringify(v)).toContain("--role نامعتبر");
    for (const v of ["a", "policy_runtime", "r1", "a".repeat(63), "x_y_z_0"]) expect(ok(["verify", `--role=${v}`])).toMatchObject({ role: v });
  });

  it("--timeout-ms: فقط رقمِ لاتینِ مثبت در [۱۰۰۰، ۶۰۰۰۰۰]؛ با plan معنا ندارد", () => {
    for (const v of ["1000", "60000", "600000"]) expect(ok(["apply", "--role=a", `--timeout-ms=${v}`])).toMatchObject({ timeoutMs: Number(v) });
    for (const v of ["", "999", "600001", "01", "01000", "0600000", "0001000", "1e3", "-5", "٣٠٠٠", "1000.5", "99999999999", " 1000"]) expect(bad(["apply", "--role=a", `--timeout-ms=${v}`]).issues.join(), JSON.stringify(v)).toContain("--timeout-ms باید");
    expect(bad(["apply", "--role=a", "--timeout-ms"]).issues.join()).toContain("--timeout-ms باید");
    expect(bad(["apply", "--role=a", "--timeout-ms=1000", "--timeout-ms=2000"]).issues).toContain("--timeout-ms تکراری است.");
    expect(bad(["plan", "--role=a", "--timeout-ms=1000"]).issues.join()).toContain("با plan معنا ندارد");
  });

  it("دستور/آرگومان/فلگِ نامعتبر؛ هیچ آرگومانِ موضعی پژواک نمی‌شود", () => {
    expect(bad([]).issues).toContain("دستور لازم است (plan، verify یا apply).");
    expect(bad(["status", "--role=a"]).issues).toContain("دستورِ ناشناخته (plan، verify یا apply).");
    expect(bad(["verify", "apply", "--role=a"]).issues).toContain("آرگومانِ اضافه (فقط یک دستور).");
    expect(bad(["verify", "--role=a", "--create-schema"]).issues).toContain('فلگِ ناشناختهٔ "--create-schema".');
    expect(bad(["verify", "--role=a", "-x"]).issues).toContain("فلگِ ناشناخته (کوتاه).");
    const leak = bad(["verify", "--role=a", `postgres://u:${CANARY}@h/db`, `--${CANARY}=1`]);
    expect(leak.issues.join(" ")).not.toContain(CANARY);
    expect(bad("verify" as unknown).issues).toEqual(["argv باید آرایه‌ای از رشته باشد."]);
    expect(bad(["verify", 1 as unknown as string]).issues).toEqual(["argv باید آرایه‌ای از رشته باشد."]);
  });

  it("DATABASE_URL برای verify/apply الزامی (و هرگز پژواک نمی‌شود)، برای plan نه", () => {
    for (const c of ["verify", "apply"]) {
      expect(bad([c, "--role=a"], {}).issues).toContain("DATABASE_URL الزامی است.");
      expect(bad([c, "--role=a"], { DATABASE_URL: "" }).issues).toContain("DATABASE_URL الزامی است.");
      expect(bad([c, "--role=a"], { DATABASE_URL: 5 }).issues).toContain("DATABASE_URL الزامی است.");
    }
    expect(ok(["plan", "--role=a"], {})).toMatchObject({ command: "plan" });
    expect(bad(["verify", "--role=a"], { DATABASE_URL: "", TOOL_POLICY_SCHEMA: CANARY }).issues.join()).not.toContain(CANARY);
  });

  it("TOOL_POLICY_SCHEMA: نبودن/خالی = پیش‌فرض؛ نامعتبر و نوع‌غلط خطای بی‌مقدار؛ کلیدِ ناشناختهٔ TOOL_POLICY_* همیشه خطا", () => {
    expect(ok(["verify", "--role=a"], { ...ENV, TOOL_POLICY_SCHEMA: "" })).toMatchObject({ schema: null });
    expect(ok(["verify", "--role=a"], { ...ENV, TOOL_POLICY_SCHEMA: "my_schema" })).toMatchObject({ schema: "my_schema" });
    for (const v of ["public", "information_schema", "pg_catalog", "Upper", "1a", "a-b", "a".repeat(41), "tool policy"]) {
      const r = bad(["verify", "--role=a"], { ...ENV, TOOL_POLICY_SCHEMA: v });
      expect(r.issues, v).toEqual(["TOOL_POLICY_SCHEMA نامعتبر است."]);
    }
    expect(bad(["verify", "--role=a"], { ...ENV, TOOL_POLICY_SCHEMA: 5 }).issues).toEqual(["TOOL_POLICY_SCHEMA باید رشته باشد."]);
    expect(bad(["verify", "--role=a"], { ...ENV, TOOL_POLICY_SCHEMAA: "x" }).issues.join()).toContain('متغیرِ ناشناختهٔ "TOOL_POLICY_SCHEMAA"');
    for (const k of KNOWN_TOOL_POLICY_ENV) expect(parseGrantsArgs(["verify", "--role=a"], { ...ENV, [k]: k === "TOOL_POLICY_SCHEMA" ? "" : "anything" }).ok, k).toBe(true);
    expect(KNOWN_TOOL_POLICY_ENV).toHaveLength(11);
    expect(bad(["verify", "--role=a"], null).issues).toContain("env باید یک شیء ساده باشد.");
    expect(bad(["verify", "--role=a"], []).issues).toContain("env باید یک شیء ساده باشد.");
  });

  it("هرگز نمی‌پرتابد: ۱۰۰۰ ورودیِ تصادفی (همه‌چیز unknown)", () => {
    const pool: unknown[] = [undefined, null, 0, "", "verify", "--role=a", "--role=", "--timeout-ms=5000", "--x", "-", "--", {}, [], ["verify"], { get DATABASE_URL(): string { throw new Error("boom"); } }, Symbol("s")];
    let seed = 12345;
    const rnd = (n: number): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let i = 0; i < 1000; i++) {
      const argv = Array.from({ length: rnd(5) }, () => pool[rnd(pool.length)]);
      expect(() => parseGrantsArgs(rnd(3) === 0 ? pool[rnd(pool.length)] : argv, pool[rnd(pool.length)])).not.toThrow();
    }
  });

  it("خروجی یخ‌زده است", () => {
    const v = ok(["verify", "--role=a"]);
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(bad(["verify"]).issues)).toBe(true);
  });
});
