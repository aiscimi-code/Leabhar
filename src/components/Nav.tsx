'use client';

import { usePathname } from 'next/navigation';
import { useTransition } from 'react';
import Link from 'next/link';
import { logoutAction } from '@/app/login/actions';

/**
 * Primary navigation.
 *
 * Grouped by the order the work actually happens in — money comes in, evidence
 * is attached, VAT is filed, reports come out — rather than alphabetically.
 * README §42 asks that important data not be hidden behind multiple clicks, so
 * every screen is one click from here.
 */

const SECTIONS: Array<{ heading: string; items: Array<{ href: string; label: string }> }> = [
  {
    heading: 'Daily',
    items: [
      { href: '/', label: 'Dashboard' },
      { href: '/review', label: 'Review queue' },
      { href: '/transactions', label: 'Transactions' },
      { href: '/documents', label: 'Documents' },
      { href: '/import', label: 'Import bank data' },
      { href: '/reconcile', label: 'Reconcile' },
    ],
  },
  {
    heading: 'VAT',
    items: [
      { href: '/vat', label: 'VAT periods' },
      { href: '/settings/rates', label: 'Rates and treatments' },
    ],
  },
  {
    heading: 'Reports',
    items: [
      { href: '/reports', label: 'Financial statements' },
      { href: '/reports/trial-balance', label: 'Trial balance' },
      { href: '/reports/year-end', label: 'Year-end pack' },
      { href: '/adjustments', label: 'Adjustments' },
      { href: '/audit', label: 'Audit trail' },
    ],
  },
  {
    heading: 'Records',
    items: [
      { href: '/invoices', label: 'Invoices' },
      { href: '/suppliers', label: 'Suppliers' },
      { href: '/customers', label: 'Customers' },
      { href: '/assets', label: 'Fixed assets' },
      { href: '/rules', label: 'Rules' },
      { href: '/calendar', label: 'Tax calendar' },
    ],
  },
  {
    heading: 'Setup',
    items: [
      { href: '/settings/company', label: 'Company' },
      { href: '/settings/accounts', label: 'Chart of accounts' },
      { href: '/settings/periods', label: 'Periods' },
      { href: '/settings/backup', label: 'Backup' },
    ],
  },
  {
    heading: 'Help',
    items: [
      { href: '/help', label: 'Help centre' },
      { href: '/glossary', label: 'Glossary' },
    ],
  },
];

export function Nav({ companyName }: { companyName: string | null }) {
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  return (
    <nav className="w-52 shrink-0 bg-surface border-r border-line min-h-screen no-print">
      <div className="px-4 py-3 border-b border-line">
        <Link href="/" className="block">
          <div className="font-semibold text-ink text-[14px] leading-tight">Leabhar</div>
          <div className="text-[11px] text-ink-faint mt-0.5 truncate">
            {companyName ?? 'No company yet'}
          </div>
        </Link>
      </div>

      <form method="get" action="/search" className="px-3 py-2 border-b border-line">
        <input
          type="search"
          name="q"
          placeholder="Search everything"
          aria-label="Search everything"
          className="w-full border border-line-strong rounded px-2 py-1 text-[12px]
            bg-surface text-ink placeholder:text-ink-faint"
        />
      </form>

      <div className="py-2">
        {SECTIONS.map((section) => (
          <div key={section.heading} className="mb-3">
            <div className="px-4 py-1 text-[10px] uppercase tracking-wider font-semibold text-ink-faint">
              {section.heading}
            </div>
            {section.items.map((item) => {
              const active = item.href === '/'
                ? pathname === '/'
                : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`block px-4 py-[5px] text-[12.5px] border-l-2 ${
                    active
                      ? 'border-accent bg-accent-soft text-accent font-medium'
                      : 'border-transparent text-ink-muted hover:bg-surface-sunken hover:text-ink'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </div>

      <div className="px-4 py-3 mt-auto border-t border-line text-[11px] text-ink-faint leading-snug">
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(async () => { await logoutAction(); })}
          className="text-ink-faint hover:text-ink underline"
        >
          {pending ? 'Logging out…' : 'Log out'}
        </button>
        <div className="mt-2">
          A preparation and bookkeeping tool. It does not file returns and does not
          tell you that you are compliant.
        </div>
      </div>
    </nav>
  );
}
