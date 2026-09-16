import type { ReactNode } from 'react';

/**
 * Shared UI primitives.
 *
 * Deliberately plain. README §42 asks for density and clarity over visual
 * polish, so these are thin wrappers that enforce consistency rather than
 * components with opinions of their own.
 */

export function Page({ title, subtitle, actions, children }: {
  title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode;
}) {
  return (
    <div className="px-6 py-5 max-w-[1600px]">
      <header className="flex items-start justify-between gap-6 mb-5 pb-3 border-b border-line">
        <div className="min-w-0">
          <h1 className="text-[19px] font-semibold text-ink leading-tight">{title}</h1>
          {subtitle && <div className="text-ink-muted mt-1 max-w-3xl">{subtitle}</div>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0 no-print">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

export function Panel({ title, description, actions, children, tone = 'default', id }: {
  title?: ReactNode; description?: ReactNode; actions?: ReactNode;
  children: ReactNode; tone?: 'default' | 'warning' | 'negative' | 'positive';
  /** Anchor target, so a link can deep-link to this panel. */
  id?: string;
}) {
  const border = tone === 'warning' ? 'border-caution/40'
    : tone === 'negative' ? 'border-negative/40'
    : tone === 'positive' ? 'border-positive/40'
    : 'border-line';
  return (
    <section id={id} className={`bg-surface border ${border} rounded mb-4 scroll-mt-4`}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-4 px-4 py-2.5 border-b border-line">
          <div className="min-w-0">
            {title && <h2 className="font-semibold text-ink text-[13px]">{title}</h2>}
            {description && <p className="text-ink-muted text-[12px] mt-0.5">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2 shrink-0 no-print">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, tone = 'default', hint, href }: {
  label: string; value: ReactNode; tone?: 'default' | 'positive' | 'negative' | 'caution';
  hint?: ReactNode; href?: string;
}) {
  const colour = tone === 'positive' ? 'text-positive'
    : tone === 'negative' ? 'text-negative'
    : tone === 'caution' ? 'text-caution'
    : 'text-ink';
  const body = (
    <>
      <div className="text-[11px] uppercase tracking-wide text-ink-faint font-semibold">{label}</div>
      <div className={`text-[17px] font-semibold mt-0.5 num !text-left ${colour}`}>{value}</div>
      {hint && <div className="text-[11.5px] text-ink-muted mt-0.5">{hint}</div>}
    </>
  );
  return href
    ? <a href={href} className="block px-4 py-2.5 hover:bg-surface-sunken">{body}</a>
    : <div className="px-4 py-2.5">{body}</div>;
}

export function Badge({ children, tone = 'neutral', title }: {
  children: ReactNode;
  tone?: 'neutral' | 'positive' | 'negative' | 'caution' | 'accent' | 'ai';
  title?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-surface-sunken text-ink-muted border-line-strong',
    positive: 'bg-positive-soft text-positive border-positive/30',
    negative: 'bg-negative-soft text-negative border-negative/30',
    caution: 'bg-caution-soft text-caution border-caution/30',
    accent: 'bg-accent-soft text-accent border-accent/30',
    ai: 'bg-accent-soft text-accent border-accent/30 border-dashed',
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 px-1.5 py-[1px] rounded text-[11px]
        font-medium border whitespace-nowrap ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Provenance badge (README §19).
 *
 * The distinction between an AI suggestion, a rule, an import and a human
 * decision must be visible — it is what stops the user treating a guess as a
 * fact. Every place a classified value appears, this appears beside it.
 */
export function ProvenanceBadge({ status, confidence, source }: {
  status: string | null; confidence?: number | null; source?: string | null;
}) {
  if (!status) return null;
  const map: Record<string, { tone: Parameters<typeof Badge>[0]['tone']; text: string; title: string }> = {
    user_confirmed: {
      tone: 'positive', text: 'Confirmed',
      title: 'You confirmed this. Nothing will change it automatically.',
    },
    user_rejected: {
      tone: 'negative', text: 'Rejected',
      title: 'You rejected this suggestion.',
    },
    system_rule: {
      tone: 'accent', text: 'Rule',
      title: 'Set by one of your deterministic rules. Open Rules to see or change it.',
    },
    imported: {
      tone: 'neutral', text: 'Imported',
      title: 'Taken directly from the imported bank statement.',
    },
    manually_entered: {
      tone: 'neutral', text: 'Entered',
      title: 'Entered by hand.',
    },
    ai_suggestion: {
      tone: 'ai', text: confidence ? `Suggested ${confidence}%` : 'Suggested',
      title: 'This is a suggestion, not a decision. It has not been confirmed, and it is '
        + 'excluded from a VAT return until you confirm it.',
    },
  };
  const entry = map[status];
  if (!entry) return <Badge>{status}</Badge>;
  return <Badge tone={entry.tone} title={entry.title}>{entry.text}</Badge>;
}

/**
 * Help tooltip (README §39).
 * Answers: what is this, why do I need it, what should I enter.
 */
export function Help({ children }: { children: ReactNode }) {
  return (
    <span className="relative inline-block group align-middle ml-1 no-print">
      <span
        className="inline-flex items-center justify-center w-[14px] h-[14px] rounded-full
          border border-line-strong text-ink-faint text-[9px] font-bold cursor-help
          hover:border-accent hover:text-accent"
        aria-hidden="true"
      >?</span>
      <span
        role="tooltip"
        className="invisible group-hover:visible group-focus-within:visible absolute left-0 top-5
          z-30 w-80 p-2.5 bg-ink text-white text-[12px] leading-snug rounded shadow-lg
          font-normal normal-case tracking-normal"
      >
        {children}
      </span>
    </span>
  );
}

export function Empty({ title, detail, action }: {
  title: string; detail?: ReactNode; action?: ReactNode;
}) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-ink font-medium">{title}</p>
      {detail && <p className="text-ink-muted mt-1 max-w-md mx-auto">{detail}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Button({ children, variant = 'secondary', type = 'button', ...rest }: {
  children: ReactNode; variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const styles: Record<string, string> = {
    primary: 'bg-accent text-white border-accent hover:bg-accent/90',
    secondary: 'bg-surface text-ink border-line-strong hover:bg-surface-sunken',
    ghost: 'bg-transparent text-ink-muted border-transparent hover:bg-surface-sunken',
    danger: 'bg-surface text-negative border-negative/40 hover:bg-negative-soft',
  };
  return (
    <button
      type={type}
      className={`px-2.5 py-1 rounded border text-[12px] font-medium
        disabled:opacity-50 disabled:cursor-not-allowed ${styles[variant]}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export function LinkButton({ children, href, variant = 'secondary' }: {
  children: ReactNode; href: string; variant?: 'primary' | 'secondary' | 'ghost';
}) {
  const styles: Record<string, string> = {
    primary: 'bg-accent text-white border-accent hover:bg-accent/90',
    secondary: 'bg-surface text-ink border-line-strong hover:bg-surface-sunken',
    ghost: 'bg-transparent text-ink-muted border-transparent hover:bg-surface-sunken',
  };
  return (
    <a
      href={href}
      className={`inline-block px-2.5 py-1 rounded border text-[12px] font-medium ${styles[variant]}`}
    >
      {children}
    </a>
  );
}

/** A figure that can be traced. README §43's "Why this number?" affordance. */
export function Figure({ value, href, negative, title }: {
  value: string; href?: string; negative?: boolean; title?: string;
}) {
  const className = `num ${negative ? 'num-negative' : ''}`;
  if (!href) return <span className={className} title={title}>{value}</span>;
  return (
    <a
      href={href}
      title={title ?? 'Show what makes up this figure'}
      className={`${className} text-accent hover:underline decoration-dotted underline-offset-2`}
    >
      {value}
    </a>
  );
}

export function Field({ label, help, children, hint }: {
  label: string; help?: ReactNode; children: ReactNode; hint?: ReactNode;
}) {
  return (
    <div className="mb-3">
      <label className="block text-[11px] uppercase tracking-wide font-semibold text-ink-faint mb-1">
        {label}
        {help && <Help>{help}</Help>}
      </label>
      {children}
      {hint && <p className="text-[11.5px] text-ink-muted mt-1">{hint}</p>}
    </div>
  );
}

export function DemoBanner() {
  return (
    <div className="bg-caution-soft border-b border-caution/30 px-4 py-1.5 text-[12px] text-caution no-print">
      <strong className="font-semibold">Demo data.</strong>{' '}
      These are not your books. Everything here belongs to a fictional company created
      so you can try the application. Create your own company in Settings when you are ready.
    </div>
  );
}
