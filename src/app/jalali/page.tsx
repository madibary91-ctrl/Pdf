import { jalaliFromInstant } from "@/modules/jalali-date";
import { JalaliWorkbench } from "./workbench";

// «امروز» باید در هر درخواست محاسبه شود، نه هنگام ساخت.
export const dynamic = "force-dynamic";

export default function JalaliPage() {
  const today = jalaliFromInstant(new Date());
  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-medium text-gold-700">ماژول jalali-date · لایهٔ ۱ · خالص</p>
        <h1 className="mt-1 text-2xl font-extrabold text-ink-900">تاریخ جلالی و مواعد</h1>
        <p className="mt-2 max-w-3xl text-sm leading-7 text-ink-700">
          همهٔ محاسبات این صفحه با همان کد خالصِ ماژول در مرورگر شما اجرا می‌شود؛ هیچ داده‌ای به سرور نمی‌رود.
        </p>
      </header>
      <JalaliWorkbench today={today.ok ? today.value : { year: 1405, month: 1, day: 1 }} />
    </div>
  );
}
