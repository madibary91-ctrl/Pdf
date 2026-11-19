/**
 * همارزیِ CLIِ مهاجرت با برنامه (ADR-0034، بی‌پایگاه): مهاجرت‌دهنده و برنامه هرگز دو شِمای متفاوت را نبینند.
 * `settlement-migrate` عمداً به `settlement-bootstrap` وابسته نیست (دو ماژولِ هم‌تراز)؛ این آزمونِ tooling تنها پلِ آن‌هاست و هر رانشی را قرمز می‌کند.
 */
import { describe, expect, it } from "vitest";
import { KNOWN_SETTLEMENT_ENV, parseMigrateArgs } from "@/modules/settlement-migrate/args";
import { SETTLEMENT_BOOTSTRAP_ENV, parseBootstrapEnv } from "@/modules/settlement-bootstrap";

const ON = { SETTLEMENT_HOST: "on", SETTLEMENT_GRACE_MS: "60000" };

describe("tooling · همارزیِ env: settlement-migrate ≡ settlement-bootstrap", () => {
  it("مجموعهٔ نام‌های SETTLEMENT_* یکی است (افزودنِ متغیر به یکی بی‌دیگری قرمز می‌شود)", () => {
    expect([...KNOWN_SETTLEMENT_ENV].sort()).toEqual(Object.values(SETTLEMENT_BOOTSTRAP_ENV).sort());
  });

  it("نامِ متغیرهای شِما با bootstrap یکی است", () => {
    const r = parseMigrateArgs(["up"], { DATABASE_URL: "x", [SETTLEMENT_BOOTSTRAP_ENV.ledgerSchema]: "led_x", [SETTLEMENT_BOOTSTRAP_ENV.outboxSchema]: "out_x" });
    expect(r).toMatchObject({ ok: true, value: { ledgerSchema: "led_x", settlementSchema: "out_x" } });
  });

  it("خاصیتی: ۲۰۰۰ محیطِ تصادفی با SETTLEMENT_HOST=on — شِمای دو سو برابر؛ ناشناختهٔ bootstrap ⇒ ناشناختهٔ migrate؛ غیررشته ⇒ خطای هر دو", () => {
    let seed = 20261119;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const vals: unknown[] = [undefined, "", "led_a", "out_b", "public", "A-B", 5, null, {}, []];
    const extraKeys = ["SETTLEMENT_TYPO", "SETTLEMENT_OUTBOX_SCHEMAA", "SETTLEMENT_", "NODE_ENV", "PATH"];
    let bothOk = 0;
    for (let i = 0; i < 2000; i++) {
      const env: Record<string, unknown> = { DATABASE_URL: "x", ...ON };
      for (const k of [SETTLEMENT_BOOTSTRAP_ENV.ledgerSchema, SETTLEMENT_BOOTSTRAP_ENV.outboxSchema]) if (rnd() < 0.7) env[k] = vals[Math.floor(rnd() * vals.length)];
      for (const k of extraKeys) if (rnd() < 0.2) env[k] = "1";
      const b = parseBootstrapEnv(env);
      const m = parseMigrateArgs(["status"], env);
      if (b.ok && b.value.enabled) {
        if (m.ok && m.value.command !== "help") {
          bothOk++;
          expect(m.value.ledgerSchema).toBe(b.value.ledgerSchema);
          expect(m.value.settlementSchema).toBe(b.value.settlementSchema);
        } else {
          // bootstrap پذیرفت ولی migrate نه: تنها دلیلِ مجاز، کلیدِ SETTLEMENT_* ناشناخته نبوده (bootstrap آن را رد می‌کرد) ⇒ نباید رخ دهد.
          expect.unreachable(`migrate رد کرد ولی bootstrap پذیرفت: ${JSON.stringify(env)}`);
        }
      } else if (!b.ok) {
        const unknownKey = b.issues.some((x) => x.includes("ناشناخته"));
        const nonString = b.issues.some((x) => x.includes("باید رشته باشد"));
        if (unknownKey || nonString) expect(m.ok, JSON.stringify(env)).toBe(false);
      }
    }
    expect(bothOk).toBeGreaterThan(100);
  });
});
