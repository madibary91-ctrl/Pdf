import { jalaliFromInstant } from "@/modules/jalali-date";
import { CourtFeeWorkbench } from "./workbench";

// «امروز» باید در هر درخواست محاسبه شود، نه هنگام ساخت.
export const dynamic = "force-dynamic";

export default function CourtFeePage() {
  const today = jalaliFromInstant(new Date());
  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-medium text-gold-700">ماژول legal-calc · لایهٔ ۱ · خالص · 🔴 بازبینی حقوقدان</p>
        <h1 className="mt-1 text-2xl font-extrabold text-ink-900">هزینهٔ دادرسی دعاوی مالی</h1>
        <p className="mt-2 max-w-3xl text-sm leading-7 text-ink-700">
          محاسبه بر اساس مبلغ خواسته و مرحلهٔ رسیدگی، با جدول نرخِ نسخه‌دار هر سال. همهٔ نرخ‌ها در یک فایل جداست
          (<span className="ltr-field font-mono text-xs">court-fee-tariffs.ts</span>) و همین فایل با تغییر قانون به‌روز می‌شود.
          محاسبه با کد خالص ماژول در مرورگر شما اجرا می‌شود.
        </p>
      </header>
      <CourtFeeWorkbench today={today.ok ? today.value : { year: 1405, month: 1, day: 1 }} />
    </div>
  );
}
