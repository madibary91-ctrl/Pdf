import { describe, expect, it } from "vitest";
import { auditNumbers, extractNumbers } from "./numbers";
import { REDACTION_MARK } from "./markers";

describe("ai-orchestrator · extractNumbers", () => {
  it("ارقام فارسی، عربی و لاتین یکسان‌اند؛ یکتا و به ترتیب", () => {
    expect(extractNumbers("۱۰ روز و 10 و ١٠ و ۲۰")).toEqual(["10", "20"]);
    expect(extractNumbers("بدون عدد")).toEqual([]);
    expect(extractNumbers("")).toEqual([]);
  });

  it("ارقام عربی-هندی هم نرمال می‌شوند (مستقل از فارسی/لاتین)", () => {
    expect(extractNumbers("١٢ و ٣")).toEqual(["12", "3"]);
    expect(extractNumbers("٣٬٠٠٠")).toEqual(["3000"]);
  });

  it("اعشار با نقطه و ٫؛ نقطهٔ پایان جمله عدد را عوض نمی‌کند", () => {
    expect(extractNumbers("۱٫۵ برابر؛ 2.25 و 7.")).toEqual(["1.5", "2.25", "7"]);
  });

  it("جداکنندهٔ هزارگان حذف می‌شود، ولی ویرگولِ فهرست نه", () => {
    expect(extractNumbers("۱٬۲۰۰٬۰۰۰ ریال")).toEqual(["1200000"]);
    expect(extractNumbers("1,200,000")).toEqual(["1200000"]);
    expect(extractNumbers("1,5")).toEqual(["1", "5"]);
    expect(extractNumbers("12,34")).toEqual(["12", "34"]);
    expect(extractNumbers("1,2345")).toEqual(["1", "2345"]);
    expect(extractNumbers("۱٬۲۳۴۵")).toEqual(["1", "2345"]);
  });

  it("نشانه‌های ارجاع و علامت حذف شمرده نمی‌شوند", () => {
    expect(extractNumbers("طبق [S1] و [S12, S3] و [S۴] و " + REDACTION_MARK + " مهلت ۳۰ روز")).toEqual(["30"]);
  });

  it("شمارندهٔ سرِ خط حذف می‌شود ولی عدد درون جمله نه", () => {
    expect(extractNumbers("۱) نخست\n2- دوم\n3. سوم\n۴: چهارم\nمهلت ۳ ماه")).toEqual(["3"]);
    expect(extractNumbers("1.5 ماه")).toEqual(["1.5"]);
    expect(extractNumbers("۱۲۳) x")).toEqual(["123"]);
  });
});

describe("ai-orchestrator · auditNumbers", () => {
  it("عدد پشتیبانی‌شده با هر نگارش پذیرفته؛ بی‌پشتوانه گزارش می‌شود", () => {
    expect(auditNumbers("مهلت ۲۰ روز است [S1]", ["فروشنده باید ظرف 20 روز تحویل دهد"])).toEqual([]);
    expect(auditNumbers("مهلت ۳۰ روز است [S1]", ["فروشنده باید ظرف ۲۰ روز تحویل دهد"])).toEqual(["30"]);
    expect(auditNumbers("۱٬۰۰۰ ریال", ["مبلغ 1000 ریال"])).toEqual([]);
  });

  it("عدد پرسش پذیرفته است (بازگویی واقعیتِ کاربر)", () => {
    expect(auditNumbers("برای ۵ سال", ["متن منبع", "پرسش: ۵ سال گذشته است"])).toEqual([]);
  });

  it("چند عدد: ترتیب پاسخ و یکتا", () => {
    expect(auditNumbers("۹ و ۸ و ۹ و ۷", ["۷"])).toEqual(["9", "8"]);
  });

  it("پاسخ بی‌عدد یا منابع تهی", () => {
    expect(auditNumbers("بدون عدد [S1]", [])).toEqual([]);
    expect(auditNumbers("۱۰", [])).toEqual(["10"]);
  });

  it("شمارندهٔ فهرست در پاسخ هشدار کاذب نمی‌دهد", () => {
    expect(auditNumbers("۱) الف [S1]\n۲) ب [S1]", ["متن"])).toEqual([]);
  });
});
