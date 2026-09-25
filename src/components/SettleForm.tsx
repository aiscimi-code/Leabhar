'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input } from './primitives';
import { settleTransactionAction, type ActionResult } from '@/app/actions';
import { parseAmount } from '@/domain/money';

/**
 * Settle a bank line against invoices (issue #203): tick the invoices this
 * payment covers and how much of each. A credit note ticked alongside reduces
 * what was paid. Anything left over is held on account and flagged.
 */

export interface OpenInvoice {
  invoiceId: string;
  invoiceNumber: string | null;
  invoiceDate: string;
  party: string;
  isCreditNote: boolean;
  outstandingMinor: number;
  currency: string;
  documentId: string | null;
}

const fmt = (minor: number) => (minor / 100).toFixed(2);

export function SettleForm({ bankTransactionId, amountMinor, currency, invoices, preselectInvoiceId }: {
  bankTransactionId: string;
  amountMinor: number;
  currency: string;
  invoices: OpenInvoice[];
  preselectInvoiceId: string | null;
}) {
  const router = useRouter();
  const cash = Math.abs(amountMinor);
  const [amounts, setAmounts] = useState<Record<string, string>>(() => {
    const pre = invoices.find((i) => i.invoiceId === preselectInvoiceId);
    return pre ? { [pre.invoiceId]: fmt(Math.min(Math.abs(pre.outstandingMinor), cash)) } : {};
  });
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const parsed = Object.entries(amounts).map(([invoiceId, text]) => {
    try { return { invoiceId, amountMinor: text.trim() ? parseAmount(text, currency) : 0, ok: true }; } catch { return { invoiceId, amountMinor: 0, ok: false }; }
  });
  const chosen = parsed.filter((p) => p.amountMinor > 0);
  const net = chosen.reduce((s, p) => s + (invoices.find((i) => i.invoiceId === p.invoiceId)?.isCreditNote ? -p.amountMinor : p.amountMinor), 0);
  const remainder = cash - net;
  const invalid = parsed.some((p) => !p.ok) || net > cash || net < 0 || chosen.length === 0;

  const toggle = (inv: OpenInvoice, on: boolean) => setAmounts((a) => {
    const next = { ...a };
    if (on) next[inv.invoiceId] = fmt(Math.min(Math.abs(inv.outstandingMinor), inv.isCreditNote ? Math.abs(inv.outstandingMinor) : Math.max(0, remainder)));
    else delete next[inv.invoiceId];
    return next;
  });

  if (invoices.length === 0) {
    return (
      <p className="px-4 py-3 text-[12px] text-ink-muted">
        No open {amountMinor < 0 ? 'purchase' : 'sales'} invoices. Upload and confirm the invoice for this payment,
        post it from the document screen, then come back here to settle.
      </p>
    );
  }

  return (
    <div className="px-4 py-3 space-y-2">
      <table className="w-full text-[12px]">
        <thead className="text-ink-faint text-[10.5px] uppercase">
          <tr><th className="w-6" /><th className="text-left">Invoice</th><th className="text-left">Party</th><th className="text-right">Outstanding</th><th className="w-28 text-right">Settle</th></tr>
        </thead>
        <tbody>
          {invoices.map((inv) => {
            const on = inv.invoiceId in amounts;
            return (
              <tr key={inv.invoiceId} className={inv.invoiceId === preselectInvoiceId ? 'bg-accent-soft/40' : ''}>
                <td><input type="checkbox" checked={on} onChange={(e) => toggle(inv, e.target.checked)} aria-label={`Settle ${inv.invoiceNumber ?? inv.invoiceId}`} /></td>
                <td>
                  {inv.documentId ? <a className="text-accent hover:underline" href={`/documents/${inv.documentId}`}>{inv.invoiceNumber ?? '—'}</a> : (inv.invoiceNumber ?? '—')}
                  {inv.isCreditNote && <span className="text-caution ml-1">credit note</span>}
                  <span className="text-ink-faint ml-1.5">{inv.invoiceDate}</span>
                </td>
                <td>{inv.party}</td>
                <td className="text-right num">{fmt(inv.outstandingMinor)} {inv.currency}</td>
                <td>{on && <Input className="text-right" value={amounts[inv.invoiceId]} onChange={(e) => setAmounts((a) => ({ ...a, [inv.invoiceId]: e.target.value }))} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className={`text-[12px] ${remainder === 0 ? 'text-positive' : remainder > 0 ? 'text-caution' : 'text-negative'}`}>
        Payment {fmt(cash)} {currency} · allocated {fmt(net)}
        {remainder > 0 && ` · ${fmt(remainder)} left over will be held on account and flagged`}
        {remainder < 0 && ' · more than the payment — reduce an allocation'}
      </p>
      <Button variant="primary" disabled={pending || invalid} onClick={() => startTransition(async () => {
        const r = await settleTransactionAction({ bankTransactionId, allocations: chosen.map(({ invoiceId, amountMinor: a }) => ({ invoiceId, amountMinor: a })) });
        setResult(r);
        if (r.ok) router.refresh();
      })}>{pending ? 'Settling…' : 'Settle'}</Button>
      {result && <p className={`text-[12px] ${result.ok ? 'text-positive' : 'text-negative'}`}>{result.ok ? result.message : result.error}</p>}
    </div>
  );
}
