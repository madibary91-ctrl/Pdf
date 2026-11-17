import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/vazirmatn";
import "./globals.css";
import { SiteNav } from "./_components/site-nav";

export const metadata: Metadata = {
  title: "پلتفرم حقوقی · ساخت ماژولار",
  description: "پایهٔ ماژولار پلتفرم هوش مصنوعی حقوقی فارسی: متن فارسی، تقویم جلالی و مواعد.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fa" dir="rtl">
      <body className="min-h-screen font-sans text-ink-900 antialiased">
        <SiteNav />
        <main className="mx-auto w-full max-w-6xl px-4 pb-24 pt-8 sm:px-6">{children}</main>
        <footer className="mx-auto max-w-6xl px-6 pb-10 text-xs leading-6 text-ink-500">
          خروجی این ابزارها «راهنمای اولیه» است و جایگزین نظر وکیل نیست. محاسبات مواعد و هزینه‌ها باید پیش از اتکا با حقوقدان تأیید شوند.
        </footer>
      </body>
    </html>
  );
}
