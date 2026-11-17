import type { ReactNode } from "react";

export function Card({ title, hint, children, className = "" }: { title?: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-ink-100 bg-white p-5 shadow-[0_1px_0_rgba(14,29,40,0.03),0_12px_30px_-18px_rgba(14,29,40,0.25)] ${className}`}>
      {title && (
        <header className="mb-4">
          <h2 className="text-base font-bold text-ink-900">{title}</h2>
          {hint && <p className="mt-1 text-xs leading-6 text-ink-500">{hint}</p>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "ok" | "warn" | "risk" | "gold" }) {
  const tones = {
    neutral: "bg-ink-50 text-ink-700 border-ink-100",
    ok: "bg-emerald-50 text-emerald-800 border-emerald-200",
    warn: "bg-amber-50 text-amber-800 border-amber-200",
    risk: "bg-rose-50 text-rose-800 border-rose-200",
    gold: "bg-gold-100 text-gold-700 border-[#ecd9a8]",
  } as const;
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

export const inputClass =
  "w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 outline-none transition placeholder:text-ink-300 focus:border-ink-500 focus:ring-2 focus:ring-ink-100";

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-medium text-ink-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-ink-500">{hint}</span>}
    </label>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-6 text-rose-800">
      {children}
    </p>
  );
}

export function Stat({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-ink-100 bg-ink-50/60 px-4 py-3">
      <div className="text-[11px] text-ink-500">{label}</div>
      <div className={`mt-1 text-sm font-bold text-ink-900 ${mono ? "ltr-field font-mono" : ""}`}>{value}</div>
    </div>
  );
}
