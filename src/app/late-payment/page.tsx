import { jalaliFromInstant } from "@/modules/jalali-date";
import { LatePaymentWorkbench } from "./workbench";

// «امروز» باید در هر درخواست محاسبه شود، نه هنگام ساخت.
export const dynamic = "force-dynamic";

export default function LatePaymentPage() {
  const today = jalaliFromInstant(new Date());
  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-medium text-gold-700">ماژول legal-calc · لایهٔ ۱ · خالص · 🔴 بازبینی حقوقدان</p>
        <h1 className="mt-1 text-2xl font-extrabold text-ink-900">خسارت تأخیر تأدیه (ماده ۵۲۲)</h1>
        <p className="mt-2 max-w-3xl text-sm leading-7 text-ink-700">
          فرمول رأی وحدت رویهٔ ۸۵۰: <b>اصل دین × (شاخص تأدیه ÷ شاخص سررسید)</b>، بدون سود مرکب. شاخص‌ها را از جدول رسمی «شاخص
          تأخیر تأدیه» بانک مرکزی وارد کنید؛ این میز عمداً هیچ عدد شاخصی از خودش ندارد (قاعده‌ها و سری‌ها در{" "}
          <span className="ltr-field font-mono text-xs">late-payment-indices.ts</span> است). محاسبه با کد خالص ماژول و حساب
          عدد صحیح در مرورگر شما اجرا می‌شود.
        </p>
      </header>
      <LatePaymentWorkbench today={today.ok ? today.value : { year: 1405, month: 1, day: 1 }} />
    </div>
  );
}
