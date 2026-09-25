'use client';

import { useState, useTransition } from 'react';
import { Button, Field, Input } from './primitives';
import { money } from '@/lib/format';
import type { ActionResult } from '@/app/settings-actions';

interface BankTxOption {
  value: string;
  label: string;
  currency: string;
}

/**
 * The payment form on the invoice page. Lets the user attach a bank
 * transaction and, when the payment currency differs from the invoice
 * currency, supply the exchange rate that converts the payment amount to the
 * invoice's currency for allocation.
 */
export function PaymentForm({
  action, invoiceId, direction, invoiceCurrency, outstandingMinor,
  bankTransactions, officers = [],
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  invoiceId: string;
  direction: 'received' | 'made';
  invoiceCurrency: string;
  outstandingMinor: number;
  bankTransactions: BankTxOption[];
  /** Directors who could have paid a purchase invoice personally (issue #221). */
  officers?: Array<{ value: string; label: string }>;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [amount, setAmount] = useState((outstandingMinor / 100).toFixed(2));
  const [paymentDate, setPaymentDate] = useState(today);
  const [reference, setReference] = useState('');
  const [bankTransactionId, setBankTransactionId] = useState('');
  const [fxRate, setFxRate] = useState('');
  const [officerId, setOfficerId] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const tx = bankTransactions.find((t) => t.value === bankTransactionId);
  const paymentCurrency = tx?.currency ?? invoiceCurrency;
  const needsFxRate = tx !== undefined && tx.currency !== invoiceCurrency;

  const submit = (formData: FormData): void => {
    startTransition(async () => {
      if (needsFxRate && !fxRate) {
        setResult({
          ok: false,
          error: `An exchange rate is required: the bank transaction is in ${paymentCurrency} but the invoice is in ${invoiceCurrency}.`,
        });
        return;
      }
      const outcome = await action(formData);
      setResult(outcome);
      if (outcome.ok) {
        setReference('');
        setFxRate('');
        setBankTransactionId('');
        setOfficerId('');
      }
    });
  };

  return (
    <form action={submit}>
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="direction" value={direction} />
      <input type="hidden" name="currency" value={paymentCurrency} />

      <div className="grid grid-cols-3 gap-3">
        <Field label="Date">
          <Input name="paymentDate" type="date" value={paymentDate}
            onChange={(e) => setPaymentDate(e.target.value)} required />
        </Field>
        <Field
          label="Amount"
          hint={`Outstanding is ${money(outstandingMinor, invoiceCurrency)}.`}
        >
          <Input name="amount" required value={amount}
            onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="Reference">
          <Input name="reference" value={reference}
            onChange={(e) => setReference(e.target.value)} placeholder="Optional" />
        </Field>
      </div>

      {officers.length > 0 && (
        <div className="mt-3">
          <Field label="Paid by" hint="A director who paid this personally is owed it back through their current account.">
            <select
              name="officerId" value={officerId}
              onChange={(e) => { setOfficerId(e.target.value); setBankTransactionId(''); }}
              className="w-full border border-line-strong rounded px-2 py-1 text-[12px]"
            >
              <option value="">The company</option>
              {officers.map((o) => (
                <option key={o.value} value={o.value}>{o.label}, personally</option>
              ))}
            </select>
          </Field>
        </div>
      )}

      {bankTransactions.length > 0 && !officerId && (
        <div className="mt-3">
          <Field label="Bank transaction" hint="Link the statement line that evidences this payment.">
            <select
              name="bankTransactionId" value={bankTransactionId}
              onChange={(e) => setBankTransactionId(e.target.value)}
              className="w-full border border-line-strong rounded px-2 py-1 text-[12px]"
            >
              <option value="">No bank transaction</option>
              {bankTransactions.map((tx) => (
                <option key={tx.value} value={tx.value}>{tx.label}</option>
              ))}
            </select>
          </Field>
        </div>
      )}

      {needsFxRate && (
        <div className="mt-3">
          <Field
            label={`Exchange rate (${paymentCurrency} to ${invoiceCurrency})`}
            hint={`The bank transaction is in ${paymentCurrency} but the invoice is in ${invoiceCurrency}. Enter the rate that converts one unit of ${paymentCurrency} into ${invoiceCurrency}.`}
          >
            <Input name="fxRate" value={fxRate}
              onChange={(e) => setFxRate(e.target.value)}
              placeholder="e.g. 0.92" required />
          </Field>
        </div>
      )}

      <div className="mt-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Working…' : 'Record payment'}
        </Button>
      </div>

      {result && (
        <p className={`mt-2 text-[12px] ${result.ok ? 'text-positive' : 'text-negative'}`}>
          {result.ok ? result.message : result.error}
        </p>
      )}
    </form>
  );
}
