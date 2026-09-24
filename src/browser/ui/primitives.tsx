"use client";

import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes } from "react";
import { CATEGORIES, TREATMENTS, type TreatmentId } from "@/browser/books/types";

export function Page({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="px-4 py-4 md:px-6 md:py-5 max-w-[1100px]">
      <header className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between mb-4 pb-3 border-b border-line">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-ink">{title}</h1>
          {subtitle && <div className="text-ink-muted mt-1 max-w-3xl">{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2 shrink-0 no-print">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

export function Panel({
  title,
  description,
  actions,
  children,
  tone = "default",
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  tone?: "default" | "warning" | "negative" | "positive";
}) {
  const border =
    tone === "warning"
      ? "border-caution/40"
      : tone === "negative"
        ? "border-negative/40"
        : tone === "positive"
          ? "border-positive/40"
          : "border-line";
  return (
    <section className={`bg-surface border ${border} rounded mb-4`}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-4 px-4 py-2.5 border-b border-line">
          <div className="min-w-0">
            {title && <h2 className="font-semibold text-ink">{title}</h2>}
            {description && <p className="text-ink-muted text-sm mt-0.5">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0 no-print">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "positive" | "negative" | "caution";
}) {
  const colour =
    tone === "positive" ? "text-positive" : tone === "negative" ? "text-negative" : tone === "caution" ? "text-caution" : "text-ink";
  return (
    <div className="px-4 py-2.5">
      <div className="text-xs uppercase tracking-wide text-ink-faint font-semibold">{label}</div>
      <div className={`text-md font-semibold mt-0.5 num !text-left ${colour}`}>{value}</div>
      {hint && <div className="text-xs text-ink-muted mt-0.5">{hint}</div>}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "positive" | "negative" | "caution" | "accent";
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-surface-sunken text-ink-muted border-line-strong",
    positive: "bg-positive-soft text-positive border-positive/30",
    negative: "bg-negative-soft text-negative border-negative/30",
    caution: "bg-caution-soft text-caution border-caution/30",
    accent: "bg-accent-soft text-accent border-accent/30",
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center px-1.5 py-px rounded text-xs font-medium border whitespace-nowrap ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function ProvenanceBadge({ status }: { status: string }) {
  if (status === "user_confirmed" || status === "manually_entered") {
    return (
      <Badge tone="positive" title="You confirmed this. It is included in the VAT worksheet.">
        Confirmed
      </Badge>
    );
  }
  if (status === "system_rule") {
    return (
      <Badge tone="accent" title="Suggested by a rule. Not in the VAT worksheet until you confirm it.">
        Rule
      </Badge>
    );
  }
  return (
    <Badge tone="neutral" title="Imported from a statement. No VAT treatment yet.">
      Imported
    </Badge>
  );
}

export function Empty({ title, detail }: { title: string; detail?: ReactNode }) {
  return (
    <div className="px-4 py-8 text-center">
      <p className="text-ink font-medium">{title}</p>
      {detail && <p className="text-ink-muted mt-1 max-w-md mx-auto">{detail}</p>}
    </div>
  );
}

const buttonStyles = {
  primary: "bg-accent text-white border-accent hover:bg-accent/90",
  secondary: "bg-surface text-ink border-line-strong hover:bg-surface-sunken",
  ghost: "bg-transparent text-ink-muted border-transparent hover:bg-surface-sunken",
  danger: "bg-surface text-negative border-negative/40 hover:bg-negative-soft",
};

export function Button({
  children,
  variant = "secondary",
  className = "",
  type = "button",
  ...rest
}: {
  children: ReactNode;
  variant?: keyof typeof buttonStyles;
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center min-h-11 md:min-h-8 px-2.5 py-1 rounded border text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed ${buttonStyles[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function DemoBanner() {
  return (
    <div className="bg-caution-soft border-b border-caution/30 px-4 py-1.5 text-sm text-caution no-print">
      <strong className="font-semibold">Demo data.</strong> These are not your books. Harbour Lane Studio Ltd is
      fictional, so the screens can be tried. Start a new vault when you want your own company.
    </div>
  );
}

const CONTROL =
  "w-full border border-line-strong rounded px-2 py-1 min-h-11 md:min-h-8 text-base bg-surface text-ink disabled:bg-surface-sunken disabled:text-ink-faint";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${CONTROL} ${props.className ?? ""}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${CONTROL} ${props.className ?? ""}`} />;
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="block text-xs uppercase tracking-wide font-semibold text-ink-faint mb-1">{label}</span>
      {children}
      {hint && <span className="block text-xs text-ink-muted mt-1 font-normal normal-case tracking-normal">{hint}</span>}
    </label>
  );
}

export function TreatmentSelect({
  value,
  onChange,
  id,
}: {
  value: TreatmentId | "";
  onChange: (value: TreatmentId | "") => void;
  id?: string;
}) {
  return (
    <Select id={id} value={value} onChange={(event) => onChange(event.target.value as TreatmentId | "")}>
      <option value="">Not set</option>
      {TREATMENTS.map((treatment) => (
        <option key={treatment.id} value={treatment.id}>
          {treatment.label}
        </option>
      ))}
    </Select>
  );
}

export function CategorySelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">Not set</option>
      {CATEGORIES.map((category) => (
        <option key={category} value={category}>
          {category}
        </option>
      ))}
    </Select>
  );
}
