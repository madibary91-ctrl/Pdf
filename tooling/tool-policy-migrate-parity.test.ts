/**
 * همارزیِ CLIِ مهاجرتِ سیاست با برنامه (ADR-0080، بی‌پایگاه): مهاجرت‌دهنده و برنامه هرگز دو شِمای متفاوت را نبینند.
 * `tool-policy-migrate` عمداً به `tool-policy-bootstrap` وابسته نیست (دو ماژولِ هم‌تراز)؛ این آزمونِ tooling تنها پلِ آن‌هاست و هر رانشی را قرمز می‌کند.
 */
import { describe, expect, it } from "vitest";
import { KNOWN_TOOL_POLICY_ENV, parseMigrateArgs } from "@/modules/tool-policy-migrate/args";
import { TOOL_POLICY_BOOTSTRAP_ENV, parseBootstrapEnv } from "@/modules/tool-policy-bootstrap";

const TUNING = {
  TOOL_POLICY_INTERVAL_MS: "1000",
  TOOL_POLICY_RETRY_MS: "1000",
  TOOL_POLICY_ATTEMPT_DEADLINE_MS: "1000",
  TOOL_POLICY_REFRESH_TIMEOUT_MS: "1000",
  TOOL_POLICY_MAX_STALE_MS: "5000",
};
const ON = { TOOL_POLICY_HOST: "on", ...TUNING };

describe("tooling · همارزیِ env: tool-policy-migrate ≡ tool-policy-bootstrap", () => {
  it("مجموعهٔ نام‌های TOOL_POLICY_* یکی است (افزودنِ متغیر به یکی بی‌دیگری قرمز می‌شود)", () => {
    expect([...KNOWN_TOOL_POLICY_ENV].sort()).toEqual(Object.values(TOOL_POLICY_BOOTSTRAP_ENV).sort());
  });

  it("نامِ متغیرِ شِما با bootstrap یکی است و مقدار به همان شکل می‌رسد", () => {
    const r = parseMigrateArgs(["up"], { DATABASE_URL: "x", [TOOL_POLICY_BOOTSTRAP_ENV.schema]: "pol_x" });
    expect(r).toMatchObject({ ok: true, value: { schema: "pol_x" } });
    expect(parseBootstrapEnv({ ...ON, [TOOL_POLICY_BOOTSTRAP_ENV.schema]: "pol_x" })).toMatchObject({ ok: true, value: { schema: "pol_x" } });
  });

  it("خاصیتی: ۲۰۰۰ محیطِ تصادفی با TOOL_POLICY_HOST=on — شِمای دو سو برابر؛ ناشناختهٔ bootstrap ⇒ ناشناختهٔ migrate؛ غیررشته ⇒ خطای هر دو", () => {
    let seed = 20261223;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const vals: unknown[] = [undefined, "", "pol_a", "pol_b", "public", "A-B", 5, null, {}, []];
    const extraKeys = ["TOOL_POLICY_TYPO", "TOOL_POLICY_SCHEMAA", "TOOL_POLICY_", "NODE_ENV", "PATH"];
    let bothOk = 0;
    for (let i = 0; i < 2000; i++) {
      const env: Record<string, unknown> = { DATABASE_URL: "x", ...ON };
      const schemaVal = vals[Math.floor(rnd() * vals.length)];
      if (schemaVal !== undefined) env[TOOL_POLICY_BOOTSTRAP_ENV.schema] = schemaVal;
      if (rnd() < 0.3) env[extraKeys[Math.floor(rnd() * extraKeys.length)] as string] = "1";
      const b = parseBootstrapEnv(env);
      const m = parseMigrateArgs(["up"], env);
      // «معتبر» برای هر دو سو یعنی هیچ ناشناخته و هیچ غیررشته؛ نامِ شِما را (معتبر بودنش) ذخیره‌ساز می‌سنجد، نه این دو تحلیلگر.
      expect(m.ok, JSON.stringify(env)).toBe(b.ok);
      if (b.ok && m.ok && b.value.enabled && "schema" in m.value) {
        bothOk++;
        expect(m.value.schema).toBe(b.value.schema);
      }
    }
    expect(bothOk).toBeGreaterThan(200);
  });
});
