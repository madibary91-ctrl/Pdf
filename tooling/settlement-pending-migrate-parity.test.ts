/**
 * همارزیِ CLIِ نمایه با برنامه و با settlement-migrate (ADR-0047، بی‌پایگاه). `settlement-pending-migrate` عمداً به `settlement-bootstrap` و `settlement-migrate` وابسته نیست؛
 * این آزمونِ tooling تنها پلِ آن‌هاست و هر رانشی را قرمز می‌کند:
 *  ۱) مجموعهٔ نام‌های `SETTLEMENT_*` ی CLI ≡ مجموعهٔ کاملِ bootstrap (هفت متغیرِ اصلی + کلیدِ پایش + آستانه‌های پایش).
 *  ۲) شِما: همان معنا (outbox) با bootstrap؛ ورودیِ تصادفی.
 *  ۳) سقفِ مهلت و کدهای ۰ تا ۷ هم‌معنا با settlement-migrate.
 *  ۴) `deadline.ts` نسخهٔ عیناً همان settlement-migrate است (کپیِ آگاهانهٔ ADR-0047؛ هر رانش قرمز می‌شود).
 *  ۵) نبودنِ سازگاریِ settlement-migrate با متغیرهای پایش **ثبت** شده است (یافتهٔ ADR-0047) تا اگر روزی رفع شد این آزمون آگاهانه به‌روز شود.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SETTLEMENT_BACKLOG_WATCH_ENV } from "@/modules/settlement-backlog-watch";
import { SETTLEMENT_BOOTSTRAP_ENV, parseBootstrapEnv } from "@/modules/settlement-bootstrap";
import { MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, KNOWN_SETTLEMENT_ENV, parsePendingMigrateArgs } from "@/modules/settlement-pending-migrate/args";
import { MIGRATE_EXIT, parseMigrateArgs } from "@/modules/settlement-migrate";
import { PENDING_MIGRATE_EXIT } from "@/modules/settlement-pending-migrate";

const ROOT = join(__dirname, "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const ON = { SETTLEMENT_HOST: "on", SETTLEMENT_GRACE_MS: "60000" };

describe("tooling · همارزیِ settlement-pending-migrate ≡ settlement-bootstrap", () => {
  it("مجموعهٔ نام‌های SETTLEMENT_* یکی است: هفت متغیرِ اصلی + SETTLEMENT_BACKLOG_WATCH + آستانه‌های پایش", () => {
    const bootstrapAll = [...Object.values(SETTLEMENT_BOOTSTRAP_ENV), "SETTLEMENT_BACKLOG_WATCH", "SETTLEMENT_BACKLOG_SOURCE", ...Object.values(SETTLEMENT_BACKLOG_WATCH_ENV)].sort();
    expect([...KNOWN_SETTLEMENT_ENV].sort()).toEqual(bootstrapAll);
  });

  it("هر نامِ شناخته‌شدهٔ bootstrap را CLI می‌پذیرد و هر نامِ ناشناخته را هر دو رد می‌کنند (با SETTLEMENT_HOST=on)", () => {
    for (const k of KNOWN_SETTLEMENT_ENV) {
      expect(parsePendingMigrateArgs(["status"], { DATABASE_URL: "x", [k]: "1" }), k).toMatchObject({ ok: true });
    }
    for (const k of ["SETTLEMENT_TYPO", "SETTLEMENT_OUTBOX_SCHEMAA", "SETTLEMENT_BACKLOG_SOURCE_TYPO"]) {
      expect(parsePendingMigrateArgs(["status"], { DATABASE_URL: "x", [k]: "1" }), k).toMatchObject({ ok: false });
      expect(parseBootstrapEnv({ ...ON, [k]: "1" }), k).toMatchObject({ ok: false });
    }
  });

  it("خاصیتی: ۲۰۰۰ محیطِ تصادفی با SETTLEMENT_HOST=on — شِمای outbox دو سو برابر؛ ناشناخته/غیررشته ⇒ خطای هر دو؛ پذیرفتهٔ bootstrap هرگز ردِ CLI نیست", () => {
    let seed = 20261124;
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
      const m = parsePendingMigrateArgs(["status"], env);
      if (b.ok && b.value.enabled) {
        if (m.ok && m.value.command !== "help") {
          bothOk++;
          expect(m.value.schema).toBe(b.value.settlementSchema);
        } else {
          expect.unreachable(`CLIِ نمایه رد کرد ولی bootstrap پذیرفت: ${JSON.stringify(env)}`);
        }
      } else if (!b.ok) {
        const unknownKey = b.issues.some((x) => x.includes("ناشناخته"));
        const nonString = b.issues.some((x) => x.includes("باید رشته باشد"));
        if (unknownKey || nonString) expect(m.ok, JSON.stringify(env)).toBe(false);
      }
    }
    expect(bothOk).toBeGreaterThan(100);
  });

  it("همان فایلِ envِ برنامه با پایشِ روشن: CLIِ نمایه می‌پذیرد، settlement-migrate رد می‌کند (یافتهٔ ثبت‌شده؛ رفعش برشِ جدا و Test-Change-Approved می‌خواهد)", () => {
    const env = { DATABASE_URL: "x", SETTLEMENT_HOST: "on", SETTLEMENT_BACKLOG_WATCH: "on" };
    expect(parseBootstrapEnv({ ...env, SETTLEMENT_GRACE_MS: "60000" })).toMatchObject({ ok: true });
    expect(parsePendingMigrateArgs(["status"], env)).toMatchObject({ ok: true });
    expect(parseMigrateArgs(["status"], env)).toMatchObject({ ok: false });
  });
});

describe("tooling · همارزیِ settlement-pending-migrate ≡ settlement-migrate (قراردادِ استقرار)", () => {
  it("بازهٔ مهلت و پیش‌فرض یکی است", () => {
    const base = { DATABASE_URL: "x" };
    for (const v of [MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS - 1, MAX_TIMEOUT_MS + 1, 0, 60000]) {
      const a = parsePendingMigrateArgs(["status", `--timeout-ms=${v}`], base);
      const b = parseMigrateArgs(["status", `--timeout-ms=${v}`], base);
      expect(a.ok, String(v)).toBe(b.ok);
    }
    const a = parsePendingMigrateArgs(["status"], base);
    const b = parseMigrateArgs(["status"], base);
    expect(a.ok && a.value.command !== "help" ? a.value.timeoutMs : -1).toBe(b.ok && b.value.command !== "help" ? b.value.timeoutMs : -2);
    expect(DEFAULT_TIMEOUT_MS).toBe(60_000);
  });

  it("کدهای ۰ تا ۷ نام و مقدارشان یکی است؛ کدهای ۸ تا ۱۰ تازه‌اند", () => {
    for (const [k, v] of Object.entries(MIGRATE_EXIT)) expect((PENDING_MIGRATE_EXIT as Record<string, number>)[k], k).toBe(v);
    expect(Object.keys(PENDING_MIGRATE_EXIT).length).toBe(Object.keys(MIGRATE_EXIT).length + 3);
  });

  it("deadline.ts عیناً همان settlement-migrate است (کپیِ آگاهانه)", () => {
    expect(read("src/modules/settlement-pending-migrate/deadline.ts")).toBe(read("src/modules/settlement-migrate/deadline.ts"));
  });

  it("lazy-database.ts جز نامِ نوعِ ورودی عیناً همان settlement-migrate است (کپیِ آگاهانه)", () => {
    const norm = (s: string): string => s.replace(/OpenedMigrateDatabase|OpenedPendingDatabase/g, "Opened");
    expect(norm(read("src/modules/settlement-pending-migrate/lazy-database.ts"))).toBe(norm(read("src/modules/settlement-migrate/lazy-database.ts")));
  });
});
