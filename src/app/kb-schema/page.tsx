import { KbSchemaWorkbench } from "./workbench";

export default function KbSchemaPage() {
  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-medium text-gold-700">ماژول legal-kb-schema · لایهٔ ۲ · خالص · 🔴 بازبینی حقوقدان · گام ۴ (بخش الف)</p>
        <h1 className="mt-1 text-2xl font-extrabold text-ink-900">شمای پایگاه دانش قانون</h1>
        <p className="mt-2 max-w-3xl text-sm leading-7 text-ink-700">
          مدل داده‌ی قانون، ماده، <b>نسخهٔ زمانی</b>، رابطه و رأی؛ با اعتبارسنجی سخت‌گیرانه و جست‌وجوی «کدام متن در این تاریخ معتبر بود؟».
          هر چه اینجا می‌بینید در مرورگر شما اجرا می‌شود. <b>داده‌ی نمایشی کاملاً ساختگی است</b> و هیچ قانون یا ماده‌ی واقعی در پروژه نیست؛
          بارگذاری قانون واقعی بخش‌های بعدی است و منبع رسمی و تأیید حقوقدان می‌خواهد.
        </p>
      </header>
      <KbSchemaWorkbench />
    </div>
  );
}
