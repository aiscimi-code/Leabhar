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

export function SettleForm({
  bankTransactionId, amountMinor, currency, invoices, preselectInvoiceId, writeOffAccounts = [], baseCurrency,
}: {
  /** The company's base currency, so a foreign-currency sale's VAT rate at receipt can be asked for (issue #661). */
  baseCurrency?: string;
  bankTransactionId: string;
  amountMinor: number;
  currency: string;
  invoices: OpenInvoice[];
  preselectInvoiceId: string | null;
  /** Income and expense accounts a shortfall can be written off to (issue #386). */
  writeOffAccounts?: Array<{ id: string; code: string; name: string }>;
}) {
  const router = useRouter();
  const cash = Math.abs(amountMinor);
  const [amounts, setAmounts] = useState<Record<string, string>>(() => {
    const pre = invoices.find((i) => i.invoiceId === preselectInvoiceId);
    return pre ? { [pre.invoiceId]: fmt(pre.currency !== currency ? cash : Math.min(Math.abs(pre.outstandingMinor), cash)) } : {};
  });
  const [lateDate, setLateDate] = useState('');
  const [writeOffOn, setWriteOffOn] = useState(false);
  const [writeOffAccount, setWriteOffAccount] = useState('');
  const [writeOffReason, setWriteOffReason] = useState<'' | 'bank_charges' | 'discount' | 'bad_debt'>('');
  const [fxText, setFxText] = useState('');
  const [vatFxText, setVatFxText] = useState('');
  const [vatFxSource, setVatFxSource] = useState('');
  const [vatFxDate, setVatFxDate] = useState('');
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

  // A shortfall can be written off when the whole payment goes to one ordinary
  // invoice in its own currency and leaves some of it unpaid (issue #386).
  const single = chosen.length === 1 ? invoices.find((i) => i.invoiceId === chosen[0]!.invoiceId) : undefined;
  const shortfall = single && !single.isCreditNote && single.currency === currency && remainder === 0
    ? Math.abs(single.outstandingMinor) - chosen[0]!.amountMinor : 0;
  const writeOff = writeOffOn && shortfall > 0 && single && writeOffReason !== ''
    ? { invoiceId: single.invoiceId, accountId: writeOffAccount, reason: writeOffReason }
    : null;
  const writeOffKey = JSON.stringify(writeOff && writeOff.accountId ? writeOff : null);

  // A receipt on a foreign-currency sale: the VAT it releases is converted at the rate at the receipt (VATCA s.37(4)).
  const foreignSales = [...new Set(chosen.map((p) => invoices.find((i) => i.invoiceId === p.invoiceId))
    .filter((i): i is OpenInvoice => !!i && !i.isCreditNote && !!baseCurrency && i.currency !== baseCurrency)
    .map((i) => i.currency))];
  const vatFxCurrency = amountMinor > 0 && foreignSales.length === 1 ? foreignSales[0]! : null;

  // Ask the domain what this settlement needs and would post; nothing is written.
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      previewSettlementAction({
        bankTransactionId, allocations: JSON.parse(allocationKey), fxRateText: fxText, writeOff: JSON.parse(writeOffKey),
      })
        .then((r) => { if (live) setCheck(r); })
        .catch(() => { if (live) setCheck(null); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [bankTransactionId, allocationKey, fxText, writeOffKey]);

  const need = check?.need;
  const preview = check?.preview;
  const rateMissing = need?.needed === true && !fxText.trim() && !need.statementRate;
  const invalid = parsed.some((p) => !p.ok) || net > cash || net < 0 || chosen.length === 0
    || need?.needed === 'unsupported' || rateMissing || preview?.ok === false
    || (writeOff !== null && !writeOff.accountId);

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
      {shortfall > 0 && writeOffAccounts.length > 0 && (
        <div className="text-[12px] space-y-1.5">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={writeOffOn} onChange={(e) => setWriteOffOn(e.target.checked)} />
            <span>Write off the {fmt(shortfall)} {currency} this leaves unpaid, and close the invoice</span>
          </label>
          {writeOffOn && (
            <div className="pl-6 space-y-1.5">
              <div className="flex items-center gap-2 flex-wrap">
                <select className="border border-line-strong rounded px-2 py-1 bg-surface" value={writeOffReason}
                  onChange={(e) => setWriteOffReason(e.target.value as 'bank_charges' | 'discount' | 'bad_debt')}
                  aria-label="Why is it short">
                  <option value="">Why is it short?…</option>
                  <option value="bank_charges">Bank or transfer charges deducted from the payment</option>
                  <option value="discount">A discount was taken</option>
                  <option value="bad_debt">It will never be paid</option>
                </select>
                <select className="border border-line-strong rounded px-2 py-1 bg-surface" value={writeOffAccount}
                  onChange={(e) => setWriteOffAccount(e.target.value)} aria-label="Write off to">
                  <option value="">Write off to…</option>
                  {writeOffAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                </select>
              </div>
              <p className="text-caution">
                {writeOffReason === 'bank_charges'
                  ? 'The customer paid the full consideration, so the shortfall is the cost of being paid. On the '
                    + 'cash receipts basis all the invoice’s deferred VAT is released at the receipt date. The '
                    + 'collected sources state no Revenue position on it, so the write-off is flagged for review.'
                  : writeOffReason === 'discount'
                    ? 'A discount is a reduction of the price: it needs a credit note (VATCA s.67(1)(b)), and on '
                      + 'the cash receipts basis s.80(5) makes the VAT due anyway if none is issued. Settling with '
                      + 'this reason will be refused - issue the credit note first.'
                    : writeOffReason === 'bad_debt'
                      ? 'Money that was never received is a bad debt, not a shortfall of this payment: settle '
                        + 'without the write-off and write the invoice off as a bad debt instead.'
                      : 'Say why the payment is short: each reason has a different treatment.'}
              </p>
            </div>
          )}
        </div>
      )}
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
      {vatFxCurrency && (
        <details className="text-[12px]">
          <summary className="cursor-pointer text-ink-muted">VAT rate at receipt for the {vatFxCurrency} sale (optional)</summary>
          <div className="mt-1.5 flex items-center gap-2 flex-wrap">
            <span className="text-ink-faint">{baseCurrency} per 1 {vatFxCurrency}</span>
            <Input className="!w-28" aria-label="VAT rate at receipt" value={vatFxText} placeholder="e.g. 0.9123"
              onChange={(e) => setVatFxText(e.target.value)} />
            <Input className="!w-44" aria-label="Rate source" value={vatFxSource} placeholder="e.g. ECB reference rate"
              onChange={(e) => setVatFxSource(e.target.value)} />
            <Input type="date" className="!w-40" aria-label="Rate date" value={vatFxDate} onChange={(e) => setVatFxDate(e.target.value)} />
          </div>
          <p className="text-ink-faint mt-1">On the cash receipts basis the VAT is due at the receipt, at the CBI or ECB selling rate
            then (VATCA s.37(4)). Left blank, the invoice&apos;s own rate is used and the VAT period is flagged.</p>
        </details>
      )}
      <Button variant="primary" disabled={pending || invalid} onClick={() => startTransition(async () => {
        const r = await settleTransactionAction({
          bankTransactionId, allocations, fxRateText: fxText || undefined,
          vatDeclarationDate: lateDate || undefined,
          vatFx: vatFxCurrency && vatFxText.trim()
            ? { rate: vatFxText, currency: vatFxCurrency, source: vatFxSource || undefined, date: vatFxDate || undefined }
            : undefined,
          writeOff,
        });
        setResult(r);
        if (r.ok) router.refresh();
      })}>{pending ? 'Settling…' : 'Settle'}</Button>
      {result && <p className={`text-[12px] ${result.ok ? 'text-positive' : 'text-negative'}`}>{result.ok ? result.message : result.error}</p>}
    </div>
  );
}
