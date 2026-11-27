/**
 * قراردادهای نامرئیِ استخرِ اختصاصی (ADR-0083) که با آزمونِ واحد دیده نمی‌شوند:
 *  ۱) نامِ متغیر بیرون از پیشوندِ رزروشدهٔ bootstrap است و `parseBootstrapEnv` با `on` آن را رد نمی‌کند (وگرنه روشن‌کردنِ میزبان با رشتهٔ جدا همیشه `INVALID_ENV` می‌شد)؛
 *  ۲) راهنمای استقرار همان نام/ثابت‌ها/رویدادهای کد را می‌گوید و رمز ندارد؛
 *  ۳) `src/instrumentation-policy.ts` فقط از راهِ انتخابگر به `startToolPolicyBootstrap` پایگاه می‌دهد و `@/db` را مستقیم import نمی‌کند (استخرِ مشترک تنبل می‌ماند).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOL_POLICY_BOOTSTRAP_ENV, parseBootstrapEnv } from "@/modules/tool-policy-bootstrap";
import { POLICY_APPLICATION_NAME, POLICY_DATABASE_URL_ENV, POLICY_POOL_MAX } from "../src/instrumentation-policy-db";

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const RUNBOOK = read("docs/runbooks/tool-policy-roles.md");
const ON = { TOOL_POLICY_HOST: "on", TOOL_POLICY_INTERVAL_MS: "1000", TOOL_POLICY_RETRY_MS: "100", TOOL_POLICY_ATTEMPT_DEADLINE_MS: "300", TOOL_POLICY_REFRESH_TIMEOUT_MS: "300", TOOL_POLICY_MAX_STALE_MS: "2000" };

describe("استخرِ اختصاصی · قراردادهای بین‌ماژولی", () => {
  it("نامِ متغیر زیرِ پیشوندِ رزروشدهٔ TOOL_POLICY_ نیست و در مجموعهٔ envهای شناخته‌شدهٔ bootstrap هم نیست", () => {
    expect(POLICY_DATABASE_URL_ENV.startsWith("TOOL_POLICY_")).toBe(false);
    expect(Object.values(TOOL_POLICY_BOOTSTRAP_ENV)).not.toContain(POLICY_DATABASE_URL_ENV);
  });

  it("با TOOL_POLICY_HOST=on کنارِ POLICY_DATABASE_URL، parseBootstrapEnv همچنان معتبر است (غلط‌یابِ پیشوند آن را رد نمی‌کند)", () => {
    const r = parseBootstrapEnv({ ...ON, [POLICY_DATABASE_URL_ENV]: "postgresql://u:p@h/db" });
    expect(r.ok).toBe(true);
    // و غلط‌یاب هنوز کار می‌کند: کلیدِ ناشناختهٔ زیرِ پیشوند رد می‌شود (نه این‌که گشاده شده باشد).
    expect(parseBootstrapEnv({ ...ON, TOOL_POLICY_DATABASE_URL: "x" }).ok).toBe(false);
  });

  it("راهنمای استقرار نام و ثابت‌های کد را می‌گوید", () => {
    expect(RUNBOOK).toContain(`\`${POLICY_DATABASE_URL_ENV}\``);
    expect(RUNBOOK).toContain(POLICY_APPLICATION_NAME);
    expect(RUNBOOK).toContain(`حداکثر ${POLICY_POOL_MAX} اتصال`);
    for (const ev of ["pool.opened", "pool.closed", "pool.close-failed", "pool.error", "pool.config-invalid"]) expect(RUNBOOK, ev).toContain(ev);
  });

  it("راهنما رشتهٔ اتصالِ واقعی/رمز ندارد (فقط جانشین <…>)", () => {
    expect(/postgres(?:ql)?:\/\/[^\s`<>]*:[^\s`<>@]+@/.test(RUNBOOK)).toBe(false);
    expect(RUNBOOK).toContain("POLICY_DATABASE_URL=<runtime-url>");
  });

  it("گلوی میزبان: @/db را مستقیم import نمی‌کند و از انتخابگر استفاده می‌کند (استخرِ مشترک تنبل می‌ماند)", () => {
    const glue = read("src/instrumentation-policy.ts");
    expect(glue).not.toMatch(/from\s+["']@\/db/);
    expect(glue).toContain("selectPolicyDatabaseOpener");
    const db = read("src/instrumentation-policy-db.ts");
    expect(db).not.toMatch(/from\s+["']@\/db/);
    expect(db).not.toMatch(/process\.env/);
    expect(db).not.toMatch(/console\./);
  });
});
