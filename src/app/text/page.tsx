import { TextWorkbench } from "./workbench";

export default function TextPage() {
  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-medium text-gold-700">ماژول persian-text · لایهٔ ۱ · خالص</p>
        <h1 className="mt-1 text-2xl font-extrabold text-ink-900">نرمال‌سازی متن فارسی</h1>
        <p className="mt-2 max-w-3xl text-sm leading-7 text-ink-700">
          یکدست‌سازی «ي/ك»، ارقام، فاصله و نیم‌فاصله و ساخت کلید جست‌وجو. متن شما فقط در مرورگر پردازش می‌شود.
        </p>
      </header>
      <TextWorkbench />
    </div>
  );
}
