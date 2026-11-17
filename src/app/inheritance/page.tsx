import { InheritanceWorkbench } from "./workbench";

export default function InheritancePage() {
  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs font-medium text-gold-700">ماژول legal-calc · لایهٔ ۱ · خالص · 🔴 بازبینی حقوقدان</p>
        <h1 className="mt-1 text-2xl font-extrabold text-ink-900">سهم‌الارث (طبقهٔ اول + زوج/زوجه)</h1>
        <p className="mt-2 max-w-3xl text-sm leading-7 text-ink-700">
          پدر، مادر، فرزندان، نوه‌ها (قائم‌مقام) و زوج/زوجه‌ها؛ با فرض، قرابت، رد، نقص و حاجب مادر (قانون مدنی، مواد ۸۶۱ تا ۹۴۹). همهٔ
          حساب‌ها با <b>کسر دقیق</b> (بدون اعشار) در مرورگر شما اجرا می‌شود و کسرها فقط در{" "}
          <span className="ltr-field font-mono text-xs">inheritance-shares.ts</span> هستند. طبقهٔ دوم و سوم هنوز ساخته نشده؛ به‌جای حدس،
          خطای صریح می‌دهد.
        </p>
      </header>
      <InheritanceWorkbench />
    </div>
  );
}
