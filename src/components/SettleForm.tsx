'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input } from './primitives';
import { settleTransactionAction, previewSettlementAction, type ActionResult } from '@/app/actions';
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
    return pre ? { [pre.invoiceId]: fmt(pre.currency !== currency ? cash : Math.min(Math.abs(pre.outstandingMinor), cash)) } : {};
  });
  const [lateDate, setLateDate] = useState('');
  const [fxText, setFxText] = useState('');
  const [check, setCheck] = useState<Awaited<ReturnType<typeof previewSettlementAction>> | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const parsed = Object.entries(amounts).map(([invoiceId, text]) => {
    try { return { invoiceId, amountMinor: text.trim() ? parseAmount(text, currency) : 0, ok: true }; } catch { return { invoiceId, amountMinor: 0, ok: false }; }
  });
  const chosen = parsed.filter((p) => p.amountMinor > 0);
  const net = chosen.reduce((s, p) => s + (invoices.find((i) => i.invoiceId === p.invoiceId)?.isCreditNote ? -p.amountMinor : p.amountMinor), 0);
  const remainder = cash - net;
  const allocations = chosen.map(({ invoiceId, amountMinor: a }) => ({ invoiceId, amountMinor: a }));
  const allocationKey = JSON.stringify(allocations);

  // Ask the domain what this settlement needs and would post; nothing is written.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      previewSettlementAction({ bankTransactionId, allocations: JSON.parse(allocationKey), fxRateText: fxText })
        .then((r) => { if (live) setCheck(r); })
        .catch(() => { if (live) setCheck(null); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [bankTransactionId, allocationKey, fxText]);

  const need = check?.need;
  const preview = check?.preview;
  const rateMissing = need?.needed === true && !fxText.trim() && !need.statementRate;
  const invalid = parsed.some((p) => !p.ok) || net > cash || net < 0 || chosen.length === 0
    || need?.needed === 'unsupported' || rateMissing || preview?.ok === false;

  const toggle = (inv: OpenInvoice, on: boolean) => setAmounts((a) => {
    const next = { ...a };
    // Across currencies the outstanding is not in the payment's currency, so the
    // default is what is left of the payment; the preview shows how it applies.
    if (on) next[inv.invoiceId] = fmt(inv.currency !== currency ? Math.max(0, remainder)
      : Math.min(Math.abs(inv.outstandingMinor), inv.isCreditNote ? Math.abs(inv.outstandingMinor) : Math.max(0, remainder)));
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
      {need?.needed === 'unsupported' && <p className="text-[12px] text-negative">{need.reason}</p>}
      {need?.needed === true && (
        <div className="text-[12px] space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-ink-faint">{need.to} per 1 {need.from}</span>
            <Input className="!w-32" aria-label={`${need.to} per 1 ${need.from}`} value={fxText}
              placeholder={need.statementRate ?? 'e.g. 1.0842'} onChange={(e) => setFxText(e.target.value)} />
            {need.statementRate && !fxText.trim() && <span className="text-ink-faint">the statement&apos;s rate is used</span>}
          </div>
          <p className="text-ink-faint">{need.reason} It is recorded exactly as entered.</p>
        </div>
      )}
      {preview?.ok === false && <p className="text-[12px] text-negative">{preview.error}</p>}
      {preview?.ok && (preview.payment.fxDifferenceMinor !== 0 || need?.needed === true) && (
        <p className="text-[12px] text-ink-muted">
          {preview.payment.fxDifferenceMinor === 0
            ? 'No exchange difference: the payment converts at the invoices\' own rates.'
            : `Exchange ${preview.payment.fxDifferenceMinor > 0 === (amountMinor > 0) ? 'gain' : 'loss'} of `
              + `${fmt(Math.abs(preview.payment.fxDifferenceMinor))} will be posted to foreign exchange gains and losses.`}
          {preview.payment.invoiceStatuses.map((st) => {
            const inv = invoices.find((i) => i.invoiceId === st.invoiceId);
            return inv ? ` ${inv.invoiceNumber ?? 'Invoice'}: ${fmt(st.outstandingMinor)} ${inv.currency} left outstanding.` : '';
          }).join('')}
        </p>
      )}
      {amountMinor > 0 && (
        <details className="text-[12px]">
          <summary className="cursor-pointer text-ink-muted">The VAT return for this receipt&apos;s date is locked or filed?</summary>
          <div className="mt-1.5 flex items-center gap-2 flex-wrap">
            <Input type="date" className="!w-44" value={lateDate} onChange={(e) => setLateDate(e.target.value)} />
            <span className="text-ink-faint">On the cash receipts basis this receipt releases output VAT; declare it in
              the open VAT period covering this date. Recorded and flagged for your accountant.</span>
          </div>
        </details>
      )}
      <Button variant="primary" disabled={pending || invalid} onClick={() => startTransition(async () => {
        const r = await settleTransactionAction({
          bankTransactionId, allocations, fxRateText: fxText || undefined,
          vatDeclarationDate: lateDate || undefined,
        });
        setResult(r);
        if (r.ok) router.refresh();
      })}>{pending ? 'Settling…' : 'Settle'}</Button>
      {result && <p className={`text-[12px] ${result.ok ? 'text-positive' : 'text-negative'}`}>{result.ok ? result.message : result.error}</p>}
    </div>
  );
}
