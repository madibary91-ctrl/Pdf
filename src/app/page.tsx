import Link from "next/link";
import { MODULES, STEPS, type ModuleInfo } from "@/modules/registry";
import { toPersianDigits } from "@/modules/persian-text";
import { Badge, Card } from "./_components/ui";

const fa = (n: number) => toPersianDigits(String(n));

/** گام ۰ و ۱ (مستندات و tooling) ماژول ندارند؛ در همین تحویل کامل شده‌اند. */
const MANUAL_DONE_STEPS = new Set([0, 1]);

function stepDone(step: number): boolean {
  if (MANUAL_DONE_STEPS.has(step)) return true;
  const mods = MODULES.filter((m) => m.step === step);
  return mods.length > 0 && mods.every((m) => m.status === "done");
}

function ModuleChip({ m }: { m: ModuleInfo }) {
  const done = m.status === "done";
  return (
    <div
      className={`rounded-xl border p-3 text-right transition ${
        done ? "border-emerald-300 bg-emerald-50/70" : "border-dashed border-ink-200 bg-white/60"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="ltr-field font-mono text-[11px] font-semibold text-ink-800">{m.name}</span>
        {done ? <Badge tone="ok">انجام شد</Badge> : <Badge>برنامه‌ریزی‌شده</Badge>}
      </div>
      <p className="mt-1.5 text-xs leading-5 text-ink-700">{m.title}</p>
      <div className="mt-2 flex flex-wrap gap-1">
        {m.pure && <Badge tone="gold">خالص</Badge>}
        {m.humanReview && <Badge tone="risk">بازبینی انسانی</Badge>}
      </div>
    </div>
  );
}

export default function HomePage() {
  const total = MODULES.length;
  const done = MODULES.filter((m) => m.status === "done").length;
  const layers = Array.from(new Set(MODULES.map((m) => m.layer))).sort((a, b) => a - b);
  const nextStep = STEPS.find((s) => !stepDone(s.step));
  const delivered = MODULES.filter((m) => m.status === "done");

  return (
    <div className="space-y-8">
      <section className="overflow-hidden rounded-3xl bg-ink-800 p-8 text-white shadow-[0_30px_60px_-30px_rgba(14,29,40,0.6)] sm:p-10">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-2xl">
            <Badge tone="gold">تحویل ۱ · پایه‌ی ماژولار (گام‌های ۰ تا ۲)</Badge>
            <h1 className="mt-4 text-3xl font-extrabold leading-[1.5] sm:text-4xl">
              ساختن پلتفرم حقوقی، یک قطعهٔ قطعی و آزموده در هر بار
            </h1>
            <p className="mt-4 text-sm leading-8 text-ink-200">
              طبق «راهنمای ساخت ماژولار»، از پایین‌ترین لایه شروع کردیم: سه کتابخانهٔ خالص و بی‌وابستگی
              که تقویم جلالی، مواعد و متن فارسی را برای بقیهٔ پروژه تضمین می‌کنند — همراه با بررسی‌گر خودکار مرزها و
              حافظهٔ مکتوب برای عامل‌ها.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/jalali" className="rounded-xl bg-gold-100 px-5 py-2.5 text-sm font-bold text-ink-900 transition hover:bg-white">
                آزمایش تاریخ جلالی و مواعد
              </Link>
              <Link href="/text" className="rounded-xl border border-white/25 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-white/10">
                آزمایش متن فارسی
              </Link>
              <Link href="/court-fee" className="rounded-xl border border-white/25 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-white/10">
                هزینهٔ دادرسی (پیش‌نمایش legal-calc · در انتظار حقوقدان)
              </Link>
              <Link href="/late-payment" className="rounded-xl border border-white/25 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-white/10">
                تأخیر تأدیه (پیش‌نمایش legal-calc · در انتظار حقوقدان)
              </Link>
              <Link href="/inheritance" className="rounded-xl border border-white/25 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-white/10">
                سهم‌الارث (پیش‌نمایش legal-calc · طبقهٔ اول · در انتظار حقوقدان)
              </Link>
              <Link href="/kb-schema" className="rounded-xl border border-white/25 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-white/10">
                شمای پایگاه دانش (پیش‌نمایش legal-kb-schema · گام ۴ بخش الف · داده‌ی ساختگی)
              </Link>
            </div>
          </div>
          <div className="grid min-w-52 grid-cols-2 gap-3 text-center">
            <div className="rounded-2xl bg-white/10 p-4">
              <div className="text-3xl font-extrabold">{fa(done)}</div>
              <div className="mt-1 text-[11px] text-ink-200">ماژول انجام‌شده</div>
            </div>
            <div className="rounded-2xl bg-white/10 p-4">
              <div className="text-3xl font-extrabold">{fa(total)}</div>
              <div className="mt-1 text-[11px] text-ink-200">ماژول در نقشه</div>
            </div>
            <div className="col-span-2 rounded-2xl bg-white/10 p-4">
              <div className="h-2 overflow-hidden rounded-full bg-white/15">
                <div className="h-full rounded-full bg-gold-500" style={{ width: `${(done / total) * 100}%` }} />
              </div>
              <div className="mt-2 text-[11px] text-ink-200">پیشرفت نقشهٔ ماژول‌ها</div>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-3">
        {delivered.map((m) => (
          <Card key={m.name} title={m.title}>
            <div className="ltr-field mb-2 font-mono text-xs text-ink-500">src/modules/{m.name}</div>
            <p className="text-xs leading-6 text-ink-700">{m.purpose}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Badge tone="ok">تست سبز</Badge>
              <Badge>لایهٔ {fa(m.layer)}</Badge>
              {m.pure && <Badge tone="gold">خالص</Badge>}
              {m.humanReview && <Badge tone="warn">بازبینی انسانی: در انتظار</Badge>}
            </div>
          </Card>
        ))}
      </div>

      <Card
        title="نقشهٔ ماژول‌ها بر اساس لایه"
        hint="وابستگی فقط رو به پایین است. هر ماژول فقط به لایه‌های هم‌تراز یا پایین‌تر که در registry اعلام شده تکیه می‌کند و بررسی‌گر خودکار آن را اجرا می‌کند."
      >
        <div className="space-y-5">
          {layers.map((layer) => (
            <div key={layer} className="grid gap-3 md:grid-cols-[5.5rem_1fr]">
              <div className="flex items-center gap-2 md:flex-col md:items-start md:justify-start">
                <span className="grid size-9 place-items-center rounded-lg bg-ink-100 text-sm font-bold text-ink-800">{fa(layer)}</span>
                <span className="text-[11px] text-ink-500">لایه</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {MODULES.filter((m) => m.layer === layer).map((m) => (
                  <ModuleChip key={m.name} m={m} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-5">
        <Card title="گام‌های ساخت" className="lg:col-span-3" hint="هر گام فقط با گذر از معیار خروجی بسته می‌شود.">
          <ol className="space-y-2">
            {STEPS.map((s) => {
              const isDone = stepDone(s.step);
              const isNext = nextStep?.step === s.step;
              return (
                <li
                  key={s.step}
                  className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 ${
                    isDone ? "border-emerald-200 bg-emerald-50/60" : isNext ? "border-gold-500 bg-gold-100/60" : "border-ink-100"
                  }`}
                >
                  <span
                    className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold ${
                      isDone ? "bg-emerald-600 text-white" : isNext ? "bg-gold-500 text-white" : "bg-ink-100 text-ink-500"
                    }`}
                  >
                    {isDone ? "✓" : fa(s.step)}
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ink-900">{s.title}</div>
                    <div className="text-[11px] leading-5 text-ink-500">خروج: {s.exit}</div>
                  </div>
                  {isNext && <Badge tone="gold">گام بعد</Badge>}
                </li>
              );
            })}
          </ol>
        </Card>

        <Card title="تصمیم‌هایی که از شما لازم است" className="lg:col-span-2" hint="بدون این پاسخ‌ها گام بعد حدسی می‌شود؛ سند هم می‌گوید حدس نزنیم.">
          <ol className="list-decimal space-y-3 pr-5 text-sm leading-7 text-ink-800">
            <li>
              <b>قواعد مهلت:</b> در مواعد مورد نظر شما روز ابلاغ شمرده می‌شود؟ اگر آخرین روز تعطیل بود، منتقل می‌شود؟
              (ماژول هر دو را گزینه کرده و فرض پنهان ندارد.)
            </li>
            <li>
              <b>تأیید جدول هزینهٔ دادرسی:</b> نرخ‌ها در <span className="ltr-field font-mono text-xs">court-fee-tariffs.ts</span> از
              تحقیق وب گرفته شده و <b>در انتظار تأیید حقوقدان</b> است؛ همراه با روش اعمال نرخ پله‌ای برای خواستهٔ بیش از ۲۰۰ میلیون ریال
              (جزئیات: یادداشت تحویل ۰۰۰۲).
            </li>
            <li>
              <b>تأخیر تأدیه:</b> مبنای شاخص (ماهانه یا سالانه)، جدول رسمی «شاخص تأخیر تأدیه» بانک مرکزی برای ثبت در{" "}
              <span className="ltr-field font-mono text-xs">late-payment-indices.ts</span>، گردکردن و رفتار در کاهش شاخص
              (جزئیات: یادداشت تحویل ۰۰۰۳).
            </li>
            <li>
              <b>سهم‌الارث:</b> تأیید ثلث مادر از «مابقی پس از زوج/زوجه»، شرط دقیق حاجب مادر، و نوه‌ها در چند نسل برای ثبت در{" "}
              <span className="ltr-field font-mono text-xs">inheritance-shares.ts</span>؛ طبقهٔ دوم و سوم هنوز ساخته نشده
              (جزئیات: یادداشت تحویل ۰۰۰۴).
            </li>
            <li>
              <b>منبع قوانین (مسدودکنندهٔ بخش ۴ج):</b> کدام منبع رسمی و کدام قانون کوچک برای نخستین بارگذاری؟ شمای داده (بخش ۴الف)
              ساخته شد و منتظر این پاسخ نیست؛ بارگذاری واقعی منتظر آن است. پرسش‌های باز شما: یادداشت تحویل ۰۰۰۵.
            </li>
            <li>
              <b>بازبینی انسانی</b> <span className="ltr-field font-mono text-xs">jalali-date</span> با
              تقویم رسمی برای سال‌های کبیسه.
            </li>
          </ol>
        </Card>
      </div>
    </div>
  );
}
