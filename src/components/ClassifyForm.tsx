'use client';

import { useState, useTransition } from 'react';
import { classifyTransactionAction } from '@/app/actions';
import { Button, Help, Badge } from './primitives';
import { money } from '@/lib/format';

interface AccountOption {
  id: string; code: string; name: string; type: string;
  defaultVatTreatmentId: string | null;
}

interface TreatmentOption {
  id: string; code: string; name: string;
  description: string | null; isReverseCharge: boolean;
  /**
   * Resolved on the server from the rate configuration in force on this
   * transaction's date. Never derived here: README §6 requires that rates live
   * in editable configuration and never in application logic, and a rate
   * hard-coded in the browser would silently disagree with the posting the
   * moment the user edited one.
   */
  rateBasisPoints: number;
}

/**
 * Classification form.
 *
 * Shows what the posting will do BEFORE it is made — how the statement amount
 * splits into net, VAT and what actually leaves the bank. Under a reverse
 * charge that split is counter-intuitive: the invoice total is the net, and the
 * VAT is added rather than extracted. Showing it beforehand is how the user
 * catches a wrong treatment instead of discovering it at VAT return time.
 */
export function ClassifyForm({
  transactionId, accounts, treatments, currentAccountId, currentTreatmentId,
  isPosted, amountMinor, currency, baseCurrency, baseAmountMinor, fxRateSource,
  fxRateNumerator, fxRateDenominator,
}: {
  transactionId: string;
  accounts: AccountOption[];
  treatments: TreatmentOption[];
  currentAccountId: string | null;
  currentTreatmentId: string | null;
  isPosted: boolean;
  amountMinor: number;
  currency: string;
  baseCurrency?: string;
  baseAmountMinor?: number | null;
  fxRateSource?: string | null;
  fxRateNumerator?: number | null;
  fxRateDenominator?: number | null;
}) {
  const [accountId, setAccountId] = useState(currentAccountId ?? '');
  const [treatmentId, setTreatmentId] = useState(currentTreatmentId ?? '');
  const [reason, setReason] = useState('');
  const [fxRate, setFxRate] = useState('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const treatment = treatments.find((t) => t.id === treatmentId);
  const preview = buildPreview(amountMinor, treatment);

  const base = baseCurrency ?? 'EUR';
  const isForeign = currency !== base;
  const hasStatementRate = isForeign && fxRateSource === 'bank_statement'
    && baseAmountMinor !== null && baseAmountMinor !== undefined;

  const submit = (formData: FormData): void => {
    startTransition(async () => {
      // Convert the decimal FX rate input to a rational numerator/denominator.
      if (isForeign && !hasStatementRate && fxRate) {
        const parsed = parseDecimalToRational(fxRate);
        if (parsed) {
          formData.set('fxRateNumerator', String(parsed.numerator));
          formData.set('fxRateDenominator', String(parsed.denominator));
        }
      }
      const response = await classifyTransactionAction(formData);
      setResult(response.ok
        ? { ok: true, message: response.message }
        : { ok: false, message: response.error });
      if (response.ok) { setReason(''); setFxRate(''); }
    });
  };

  return (
    <form action={submit}>
      <input type="hidden" name="transactionId" value={transactionId} />

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[11px] uppercase tracking-wide font-semibold text-ink-faint mb-1">
            Accounting account
            <Help>
              Which category this belongs to in your books. It decides where the amount
              appears in the profit and loss account or on the balance sheet.
            </Help>
          </label>
          <select
            name="accountId" value={accountId}
            onChange={(event) => {
              setAccountId(event.target.value);
              const account = accounts.find((a) => a.id === event.target.value);
              if (account?.defaultVatTreatmentId && !currentTreatmentId) {
                setTreatmentId(account.defaultVatTreatmentId);
              }
            }}
            className="w-full border border-line-strong rounded px-2 py-1 text-[12px]"
            required
          >
            <option value="">Choose an account…</option>
            {['expense', 'income', 'asset', 'liability', 'equity'].map((type) => (
              <optgroup key={type} label={type.replace(/^./, (c) => c.toUpperCase())}>
                {accounts.filter((a) => a.type === type).map((a) => (
                  <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-[11px] uppercase tracking-wide font-semibold text-ink-faint mb-1">
            VAT treatment
            <Help>
              How VAT applies to this transaction. This is not the same thing as the VAT
              percentage: a zero-rated sale, an exempt supply and a transaction outside the
              scope of VAT all show €0 of VAT for entirely different reasons, and they are
              reported differently on your VAT return.
            </Help>
          </label>
          <select
            name="vatTreatmentId" value={treatmentId}
            onChange={(event) => setTreatmentId(event.target.value)}
            className="w-full border border-line-strong rounded px-2 py-1 text-[12px]"
            required
          >
            <option value="">Choose a treatment…</option>
            {treatments.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </div>
      </div>

      {treatment?.description && (
        <p className="text-[11.5px] text-ink-muted mt-2 leading-snug">{treatment.description}</p>
      )}

      {isForeign && hasStatementRate && (
        <p className="text-[11.5px] text-ink-muted mt-2 leading-snug">
          The bank charged{' '}
          <span className="num !text-left">{money(baseAmountMinor!, base)}</span>{' '}
          for this {money(Math.abs(amountMinor), currency)} transaction
          {fxRateNumerator && fxRateDenominator
            ? ` (rate ${(fxRateNumerator / fxRateDenominator).toFixed(6)}, from the statement)`
            : ''}.
          No exchange rate is needed — the statement's settled amount is used.
        </p>
      )}

      {isForeign && !hasStatementRate && (
        <div className="mt-3">
          <label className="block text-[11px] uppercase tracking-wide font-semibold text-ink-faint mb-1">
            Exchange rate ({currency} to {base})
            <Help>
              This transaction is in {currency} but the books are kept in {base}. Enter the rate
              the bank applied (or the rate on the invoice) as a decimal, e.g. 0.92 means one
              {currency} costs 0.92 {base}. A missing rate is never assumed.
            </Help>
          </label>
          <input
            type="text" name="fxRate" value={fxRate}
            onChange={(event) => setFxRate(event.target.value)}
            placeholder="e.g. 0.92"
            className="w-full border border-line-strong rounded px-2 py-1 text-[12px]"
            required
          />
        </div>
      )}

      {preview && (
        <div className="mt-3 border border-line rounded bg-surface-sunken">
          <div className="px-3 py-1.5 border-b border-line text-[11px] uppercase tracking-wide
            font-semibold text-ink-faint flex items-center gap-2">
            What this will post
            {treatment?.isReverseCharge && <Badge tone="accent">Reverse charge</Badge>}
          </div>
          <table className="ledger">
            <tbody>
              <tr>
                <td className="w-56 text-ink-muted">Net</td>
                <td className="num !text-left">{money(preview.netMinor, currency)}</td>
              </tr>
              <tr>
                <td className="text-ink-muted">VAT at {preview.ratePercent}</td>
                <td className="num !text-left">{money(preview.vatMinor, currency)}</td>
              </tr>
              <tr>
                <td className="text-ink-muted">
                  {amountMinor < 0 ? 'Leaves the bank' : 'Enters the bank'}
                </td>
                <td className="num !text-left font-semibold">
                  {money(Math.abs(amountMinor), currency)}
                </td>
              </tr>
            </tbody>
          </table>
          {treatment?.isReverseCharge && (
            <p className="px-3 py-2 text-[11.5px] text-ink-muted border-t border-line leading-snug">
              The supplier charged no VAT, so the invoice total is the <em>net</em> amount.
              You account for {money(preview.vatMinor, currency)} of VAT as though you had
              charged it, and reclaim the same amount, so the two usually cancel out in cash
              terms. Both figures still appear on your VAT return.
            </p>
          )}
        </div>
      )}

      {isPosted && (
        <div className="mt-3">
          <label className="block text-[11px] uppercase tracking-wide font-semibold text-ink-faint mb-1">
            Reason for the change
            <Help>
              This transaction is already posted. Changing it reverses the original journal
              entry and posts a new one — the original is never edited — and this reason is
              recorded in the audit trail.
            </Help>
          </label>
          <input
            type="text" name="reason" value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="For example: coded to hosting, should have been software"
            className="w-full border border-line-strong rounded px-2 py-1 text-[12px]"
            required
          />
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Button
          type="submit" variant="primary"
          disabled={pending || !accountId || !treatmentId
            || (isForeign && !hasStatementRate && !fxRate)}
        >
          {pending ? 'Posting…' : isPosted ? 'Reclassify' : 'Confirm and post'}
        </Button>
        {result && (
          <span className={`text-[12px] ${result.ok ? 'text-positive' : 'text-negative'}`}>
            {result.message}
          </span>
        )}
      </div>
    </form>
  );
}

/**
 * Preview arithmetic.
 *
 * Uses the rate the server resolved from configuration, and applies the same
 * rule the VAT engine applies, so the preview and the posting cannot disagree.
 * The figure actually written to the books always comes from the engine.
 */
function buildPreview(amountMinor: number, treatment: TreatmentOption | undefined) {
  if (!treatment) return null;
  const gross = Math.abs(amountMinor);
  const basisPoints = treatment.rateBasisPoints;
  const ratePercent = `${basisPoints / 100}%`;

  if (treatment.isReverseCharge) {
    // The supplier charged no VAT, so the invoice total IS the net amount.
    const vat = Math.round((gross * basisPoints) / 10_000);
    return { netMinor: gross, vatMinor: vat, ratePercent };
  }

  const vat = Math.round((gross * basisPoints) / (10_000 + basisPoints));
  return { netMinor: gross - vat, vatMinor: vat, ratePercent };
}

/**
 * Convert a decimal exchange rate (e.g. "0.92") to an integer numerator and
 * denominator, so the server never sees a float. Up to 6 decimal places, which
 * is more than enough for any real exchange rate.
 */
function parseDecimalToRational(input: string): { numerator: number; denominator: number } | null {
  const text = input.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(text)) return null;
  const [whole = '0', frac = ''] = text.split('.');
  const denominator = Math.pow(10, frac.length || 0);
  const numerator = Number(whole) * denominator + (frac ? Number(frac) : 0);
  return { numerator, denominator };
}
