import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * مهلت‌ها (ADR-0007): پیش‌فرض Vitest برای هر تست ۵ ثانیه است. چند تست سنگین (دوره‌ای ۱۲۰۰–۱۶۰۰ جلالی، ۲۵ بذر تصادفی
 * روی پایگاه، ۱۲ دور مسابقه) روی ماشین توسعه ۱٫۵–۲٫۵ ثانیه طول می‌کشند و روی runner مشترک و کندترِ CI به آستانهٔ ۵ ثانیه می‌رسند؛
 * شکست «مهلت» نشانهٔ باگ منطقی نیست ولی دروازهٔ صفر-شکست را قرمز می‌کند.
 * مهلت بالا فقط سقفِ «گیرکردن» است، نه معیار سرعت؛ تست‌هایی که مهلت صریح دارند (مثلاً ۱۲۰٬۰۰۰) دست‌نخورده می‌مانند.
 * عمداً `retry` نداریم: تکرارِ خودکارِ تست شکست‌خورده در نرم‌افزار حقوقی ناپایداری واقعی را پنهان می‌کند.
 */
export const TEST_TIMEOUT_MS = 60_000;
export const HOOK_TIMEOUT_MS = 60_000;

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tooling/**/*.test.ts"],
    testTimeout: TEST_TIMEOUT_MS,
    hookTimeout: HOOK_TIMEOUT_MS,
  },
});
