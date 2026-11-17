/**
 * قفل پیکربندی مهلت‌ها (ADR-0007). اگر کسی مهلت را به پیش‌فرض ۵ ثانیه برگرداند، تست‌های سنگینِ پایگاه/جلالی
 * روی runner کندِ CI دوباره «تصادفی» قرمز می‌شوند؛ این تست مانع بازگشت بی‌صدا است.
 */
import { describe, expect, it } from "vitest";
import config, { HOOK_TIMEOUT_MS, TEST_TIMEOUT_MS } from "../vitest.config";

describe("tooling: مهلت‌های Vitest برای CI", () => {
  it("مهلت تست و هوک در پیکربندی فعال و بسیار بیش از پیش‌فرض ۵ ثانیه‌ای است", () => {
    expect(config.test?.testTimeout).toBe(TEST_TIMEOUT_MS);
    expect(config.test?.hookTimeout).toBe(HOOK_TIMEOUT_MS);
    expect(TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(HOOK_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });

  it("مهلت سقفِ «گیرکردن» است: از مهلت‌های صریحِ تست‌های سنگین (۱۲۰٬۰۰۰) بیشتر نیست", () => {
    expect(TEST_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });

  it("retry تنظیم نشده است (تکرار خودکار ناپایداری واقعی را پنهان می‌کند)", () => {
    expect(config.test?.retry ?? 0).toBe(0);
  });

  it("پوشش include و نام مستعار @ سر جای خود است (تغییر مهلت نباید دامنهٔ تست‌ها را کم کند)", () => {
    expect(config.test?.include).toEqual(["src/**/*.test.ts", "tooling/**/*.test.ts"]);
    expect(config.test?.environment).toBe("node");
  });
});
