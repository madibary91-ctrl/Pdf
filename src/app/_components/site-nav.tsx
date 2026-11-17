"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "نقشهٔ ساخت" },
  { href: "/jalali", label: "تاریخ جلالی" },
  { href: "/text", label: "متن فارسی" },
  { href: "/court-fee", label: "هزینهٔ دادرسی" },
  { href: "/late-payment", label: "تأخیر تأدیه" },
  { href: "/inheritance", label: "سهم‌الارث" },
  { href: "/kb-schema", label: "شمای دانش" },
] as const;

export function SiteNav() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-20 border-b border-ink-100 bg-white/85 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-3">
          <span className="grid size-9 place-items-center rounded-lg bg-ink-800 text-lg font-bold text-gold-100">ح</span>
          <span className="leading-tight">
            <span className="block text-sm font-bold text-ink-900">پلتفرم حقوقی</span>
            <span className="block text-[11px] text-ink-500">ساخت ماژول‌به‌ماژول</span>
          </span>
        </Link>
        <nav className="flex gap-1 text-sm" aria-label="ناوبری اصلی">
          {ITEMS.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`rounded-lg px-3 py-2 transition ${
                  active ? "bg-ink-800 text-white" : "text-ink-700 hover:bg-ink-50"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
