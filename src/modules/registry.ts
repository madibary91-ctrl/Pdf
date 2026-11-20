/**
 * نقشهٔ ماژول‌ها — منبع حقیقتِ لایه‌ها و وابستگی‌های مجاز (بر اساس «راهنمای ساخت ماژولار»).
 * هم داشبورد از آن می‌خواند و هم بررسی‌گر مرزها (tooling/boundaries.test.ts).
 * افزودن/تغییر ماژول = ویرایش همین فایل + تأیید مالک معماری.
 */

export type ModuleStatus = "done" | "planned";

export type ModuleInfo = Readonly<{
  name: string;
  /** لایه: فقط جهت ساخت را نشان می‌دهد (۰ پایین‌ترین) */
  layer: number;
  /** گام ساخت طبق جدول «از کجا شروع کنیم» */
  step: number;
  title: string;
  purpose: string;
  dependsOn: readonly string[];
  /** خالص: بدون I/O؛ قطعی و ساده‌ترین قطعه برای تست */
  pure: boolean;
  /** بازبینی انسانیِ اجباری (ناحیهٔ پرریسک) */
  humanReview: boolean;
  status: ModuleStatus;
}>;

export const STEPS: ReadonlyArray<Readonly<{ step: number; title: string; exit: string }>> = [
  { step: 0, title: "قراردادها و تصمیم‌ها", exit: "چند سند کوتاه در مخزن و تأیید مالک معماری" },
  { step: 1, title: "زیرساخت مخزن (tooling)", exit: "مخزن خالی با CI سبز و بررسی مرزها" },
  { step: 2, title: "کتابخانه‌های قطعی و کوچک", exit: "تست‌های سبز و بازبینی انجام‌شده" },
  { step: 3, title: "محاسبات و ابزارهای رابط", exit: "هر محاسبه با ورودی مرجع حقوقدان تأیید شده" },
  { step: 4, title: "پایگاه دانش قانون (یک قانون کوچک)", exit: "قانون بارگذاری‌شده با نمونه‌های تأییدشده" },
  { step: 5, title: "مجموعهٔ ارزیابی (بذر اولیه)", exit: "چند ده پرسش با پاسخ مرجع" },
  { step: 6, title: "واسط مدل، بازیابی، راستی‌آزمایی استناد", exit: "ارجاع نامعتبر هرگز خروجی نمی‌شود" },
  { step: 7, title: "ai-orchestrator — اولین برش عمودی", exit: "فرمان خط: پرسش ← پاسخ با استناد معتبر" },
  { step: 8, title: "دفتر اعتبار، هویت و API", exit: "جداسازی مستأجر و تست‌های امنیت سبز" },
  { step: 9, title: "وب‌اپ و سایت معرفی", exit: "بتای وب با کاربران واقعی" },
  { step: 10, title: "اسکلت دسکتاپ و هسته‌ی پرونده", exit: "ثبت و بازیابی پرونده بدون اینترنت" },
  { step: 11, title: "اسناد، مالی، قانون آفلاین، پشتیبان، لایسنس", exit: "آلفا با دفاتر همکار و بازیابی پشتیبان تمرین‌شده" },
  { step: 12, title: "اتصال دستیار و OCR", exit: "ورود سند با تأیید انسانی مبلغ و تاریخ" },
  { step: 13, title: "ویرایش اسناد با هوش مصنوعی", exit: "نسخهٔ جدید با diff و تأیید کاربر" },
];

const m = (
  name: string,
  layer: number,
  step: number,
  title: string,
  purpose: string,
  dependsOn: readonly string[],
  pure: boolean,
  humanReview: boolean,
  status: ModuleStatus = "planned",
): ModuleInfo => ({ name, layer, step, title, purpose, dependsOn, pure, humanReview, status });

export const MODULES: readonly ModuleInfo[] = [
  m("shared-types", 0, 2, "نوع‌های مشترک", "نوع‌ها و شماهای مشترک بین ماژول‌ها و قرارداد API", [], true, false, "done"),
  m("persian-text", 1, 2, "متن فارسی", "نرمال‌سازی متن فارسی (ی/ک، نیم‌فاصله، ارقام، نشانه‌گذاری) و کلید جست‌وجو", ["shared-types"], true, false, "done"),
  m("jalali-date", 1, 2, "تاریخ جلالی", "تبدیل و محاسبهٔ تاریخ جلالی/میلادی و مواعد", ["shared-types"], true, true, "done"),
  m("legal-calc", 1, 3, "محاسبات حقوقی", "هزینه دادرسی، حق‌الوکاله، دیه، ارث، مهریه، تأخیر تأدیه با جدول نسخه‌دار", ["jalali-date", "shared-types"], true, true),
  m("finance-calc", 2, 3, "محاسبات مالی", "مانده، تقسیط، جمع و گردکردن پول به‌صورت عدد صحیح", ["jalali-date", "shared-types"], true, true),
  m("doc-templates-core", 1, 3, "موتور قالب سند", "پر کردن قالب سند و ساخت ساختار docx", ["persian-text", "jalali-date"], true, true),
  m("ui-rtl", 1, 3, "طراحی سیستم RTL", "کامپوننت‌های راست‌به‌چپ، اعداد و تقویم جلالی در رابط", ["shared-types"], false, false),
  m("legal-kb-schema", 2, 4, "شمای پایگاه دانش", "مدل داده قانون، ماده، نسخه، رابطه و رأی", ["shared-types"], true, true),
  m("legal-kb-ingest", 2, 4, "دریافت قانون", "دریافت، پاک‌سازی، شکستن به ماده و بارگذاری (Python)", ["persian-text", "legal-kb-schema"], false, true),
  m("legal-kb-store", 2, 4, "ذخیره و جست‌وجو", "ذخیره، جست‌وجوی کلمه‌ای و برداری، نسخه‌بندی زمانی", ["legal-kb-schema", "persian-text"], false, false),
  m("eval-set", 2, 5, "مجموعهٔ ارزیابی", "مجموعهٔ ارزیابی حقوقی و ابزار اجرای آن", ["shared-types"], false, true),
  m("ledger", 3, 8, "دفتر اعتبار", "خرید، رزرو، مصرف و بازگشت اعتبار پیام", ["shared-types"], false, true),
  m("identity", 3, 8, "هویت", "ثبت‌نام، ورود با پیامک، نشست‌ها، نقش‌ها و جداسازی مستأجر", ["shared-types"], false, true),
  m("ai-gateway", 3, 6, "واسط مدل", "واسط یکسان مدل زبانی، ثبت مصرف و هزینه", ["shared-types"], false, false),
  m("retrieval", 3, 6, "بازیابی", "بازیابی ترکیبی از پایگاه دانش با فیلتر تاریخ اعتبار", ["legal-kb-store", "persian-text"], false, false, "done"),
  m("citation-verifier", 3, 6, "راستی‌آزمایی استناد", "تطبیق هر ارجاع با رکورد واقعی؛ حذف/علامت‌گذاری ارجاع نامعتبر", ["legal-kb-schema", "shared-types"], true, true, "done"),
  m("calc-tools", 3, 6, "ابزار محاسبه برای مدل", "ابزارهایی که مدل برای محاسبه صدا می‌زند", ["legal-calc"], true, false),
  m("metering", 4, 8, "اندازه‌گیری مصرف", "رزرو بدترین هزینه، مصرف هزینهٔ واقعی و بازگشت/سوخت باقیمانده روی دفتر اعتبار برای هر تماس مدل", ["ai-gateway", "ledger"], false, true),
  m("settlement", 4, 8, "تسویهٔ ماندگار", "outbox و رفتگر: قصدِ تسویه پیش از هر تغییرِ دفتر ثبت می‌شود و رزروهای معلق یا یتیمِ مرگ/شکست با تکرارِ idempotent بسته می‌شوند", ["ledger", "metering"], false, true),
  m("settlement-runtime", 5, 8, "اجرای تسویهٔ ماندگار", "ریشهٔ ترکیبِ رفتگر: زمان‌سنجِ واقعی، پیش‌بازرسیِ مهاجرت، چرخهٔ عمرِ مرتب (start/stop) و سلامتِ همگام برای پروبِ /api/health؛ سیاست‌ها در settlement می‌مانند", ["settlement", "ledger"], false, true),
  m("settlement-host", 6, 8, "میزبان فرایندیِ تسویه", "چرخهٔ عمرِ فرایندیِ رفتگر: singleton روی ظرفِ تزریقی، بوتِ شکست‌بسته با بازتلاشِ فقط‌گذرا، خاموشیِ مرتب و مهلت‌دار روی SIGTERM و سه پروبِ جدای live/startup/ready؛ سیاست‌ها در settlement و ترکیب در settlement-runtime می‌مانند", ["settlement-runtime", "settlement", "ledger"], false, true),
  m("settlement-bootstrap", 7, 8, "مرز برنامهٔ تسویه", "اتصال رفتگرِ تسویه به برنامه: سیاستِ شکست‌بستهٔ env (پیش‌فرض خاموش)، باز کردنِ تنبلِ پایگاه، بوتِ بی‌مسدودی روی singleton، تعیینِ صاحبِ خروجِ فرایند و پاسخ HTTP پروب‌های live/startup/ready؛ چرخهٔ عمر در settlement-host می‌ماند؛ پایشِ زندهٔ پسماندِ زنگ فقط با کلیدِ صریحِ SETTLEMENT_BACKLOG_WATCH=on روی همان پایگاه ساخته و پس از بوتِ موفق شروع می‌شود و در بدنهٔ ready/startup گزارش می‌شود (liveness هرگز)", ["settlement-host", "settlement-runtime", "settlement", "settlement-backlog-watch"], false, true),
  m("settlement-migrate", 5, 8, "مهاجرت‌دهندهٔ تسویه", "CLIِ رسمیِ مهاجرتِ زمانِ استقرار: status فقط‌خواندنی و up (دفتر ← outbox) با کدهای خروجِ بسته، پیش‌بازرسیِ بی‌نوشتن، راستی‌آزماییِ پس از اعمال، بازتلاشِ کران‌دارِ مسابقهٔ هم‌زمانی، مهلتِ کل و گزارشِ JSONِ بی‌نشت؛ سیاستِ مهاجرت در ledger و settlement می‌ماند", ["settlement", "ledger"], false, true),
  m("settlement-backlog", 5, 8, "پایشِ پسماندِ زنگِ تسویه", "پایشِ فقط‌خواندنیِ مرده‌های تأییدنشدهٔ outbox: نمونه‌گیریِ بی‌پرتاب با مهلتِ اختیاری و ارزیابیِ خالصِ ok/degraded/down از شمار و سنِ قدیمی‌ترین با آستانه‌های الزامیِ مالک؛ سیاست‌های حلقه و سلامتِ رفتگر در settlement می‌ماند و ترکیب با /api/health برشِ بعد است", ["settlement"], false, true, "done"),
  m("settlement-backlog-watch", 6, 8, "پایشِ زندهٔ پسماندِ زنگِ تسویه", "نگه‌داشتنِ زندهٔ پایشِ پسماند برای پروب‌های همگام: حلقهٔ پس‌زمینهٔ نمونه‌گیریِ بی‌هم‌پوشان با کش، نمای همگامِ بی‌I/O، پیش‌فرض‌های امنِ قابل‌تنظیم (کد و env) و سیاستِ پروب (liveness هرگز ۵۰۳ نمی‌شود؛ پسماند فقط در ready/startup گزارش می‌شود و ready را فقط با سیاستِ صریحِ gate_down مسدود می‌کند)؛ آستانه‌ها و ارزیابی در settlement-backlog و اتصال به host/bootstrap برشِ بعد است", ["settlement-backlog", "settlement"], false, true, "done"),
  m("ai-orchestrator", 4, 7, "ارکستراتور", "خط لولهٔ کامل هر درخواست: زمینه، بازیابی، تولید، راستی‌آزمایی، ثبت", ["ai-gateway", "retrieval", "citation-verifier", "calc-tools", "doc-templates-core", "ledger"], false, true),
  m("api", 4, 8, "API اصلی", "حساب، اشتراک، میز کار وب، فایل‌ها، لایسنس", ["identity", "ledger", "ai-orchestrator"], false, true),
  m("web-app", 5, 9, "وب‌اپ", "رابط وب مستقل", ["api", "ui-rtl"], false, false),
  m("site", 5, 9, "سایت معرفی", "سایت معرفی و بلاگ", ["ui-rtl"], false, false),
  m("desktop-db", 5, 10, "پایگاه دسکتاپ", "پایگاه رمزنگاری‌شدهٔ محلی، کلید و مهاجرت‌ها", ["shared-types"], false, true),
  m("desktop-shell", 6, 10, "پوستهٔ دسکتاپ", "پوستهٔ Electron یا Tauri و نصاب", [], false, true),
  m("desktop-cases", 6, 10, "پرونده‌ها", "اشخاص، پرونده‌ها، مراحل، مواعد و یادآوری", ["desktop-db", "jalali-date", "ui-rtl"], false, false),
  m("desktop-docs", 6, 11, "اسناد دسکتاپ", "اسناد و قالب‌ها، خروجی Word و PDF", ["desktop-cases", "doc-templates-core"], false, false),
  m("desktop-finance", 6, 11, "مالی دسکتاپ", "قرارداد مالی پرونده، دریافت و پرداخت، چک، گزارش", ["desktop-cases", "desktop-db", "finance-calc"], false, true),
  m("desktop-kb-offline", 6, 11, "قانون آفلاین", "بستهٔ قانون محلی، جست‌وجوی FTS5 و به‌روزرسانی دلتایی", ["legal-kb-schema", "desktop-db"], false, false),
  m("desktop-backup", 6, 11, "پشتیبان‌گیری", "پشتیبان‌گیری خودکار و بازیابی", ["desktop-db"], false, true),
  m("desktop-license", 6, 11, "لایسنس", "بررسی و فعال‌سازی لایسنس", ["desktop-db"], false, true),
  m("desktop-updater", 6, 11, "به‌روزرسانی", "به‌روزرسانی امضاشدهٔ برنامه", [], false, true),
  m("desktop-ai-bridge", 7, 12, "پل دستیار", "اتصال دستیار به دسکتاپ، صف درخواست، آگاهی از پرونده", ["desktop-cases", "api"], false, false),
  m("ocr-pipeline", 7, 12, "OCR", "OCR محلی، تشخیص فیلد، تأیید انسانی", ["desktop-docs"], false, true),
  m("doc-editing-tools", 8, 13, "ویرایش اسناد با هوش مصنوعی", "ویرایش اسناد بایگانی‌شده با diff و نسخهٔ جدید", ["desktop-docs", "desktop-ai-bridge"], false, true),
];

export function getModule(name: string): ModuleInfo | undefined {
  return MODULES.find((x) => x.name === name);
}
