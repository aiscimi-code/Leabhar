import { notFound } from 'next/navigation';
import { invoiceDetail, unpostedTransactionOptions } from '@/lib/queries';
import {
  Page, Panel, Badge, Stat, Empty, Disclosure, ProvenanceBadge,
} from '@/components/primitives';
import { PaymentForm } from '@/components/PaymentForm';
import { recordPaymentAction } from '@/app/settings-actions';
import { money, date, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** One invoice, its VAT, and every payment allocated against it (README §26, §27). */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = invoiceDetail(id);
  if (!detail) notFound();

  const { invoice, lines, allocations, party, company } = detail;
  const isSales = invoice.direction === 'sales';
  const deferredVat = isSales && company.vatAccountingBasis === 'cash_receipts'
    && invoice.vatMinor !== 0;

  return (
    <Page
      title={invoice.invoiceNumber ?? `Invoice #${invoice.internalNumber ?? ''}`}
      subtitle={`${isSales ? 'Sales' : 'Purchase'} invoice dated ${date(invoice.invoiceDate)}`
        + (party ? ` — ${party.name}` : '')}
      actions={
        <>
          <ProvenanceBadge status={invoice.provenanceStatus} source={invoice.source} />
          <Badge tone={invoice.status === 'paid' ? 'positive'
            : invoice.status === 'overdue' ? 'negative'
            : invoice.status === 'part_paid' ? 'caution' : 'neutral'}>
            {label(invoice.status)}
          </Badge>
        </>
      }
    >
      <Panel>
        <div className="grid grid-cols-5 divide-x divide-line">
          <Stat label="Net" value={money(invoice.netMinor, invoice.currency)} />
          <Stat label="VAT" value={money(invoice.vatMinor, invoice.currency)} />
          <Stat label="Gross" value={money(invoice.grossMinor, invoice.currency)} />
          <Stat label="Paid" value={money(invoice.paidMinor, invoice.currency)} tone="positive" />
          <Stat
            label="Outstanding"
            value={money(invoice.outstandingMinor, invoice.currency)}
            tone={invoice.outstandingMinor === 0 ? 'positive' : 'caution'}
            hint={invoice.dueDate ? `Due ${date(invoice.dueDate)}` : 'No due date recorded'}
          />
        </div>

        {invoice.currency !== invoice.baseCurrency && (
          <div className="px-4 py-2.5 border-t border-line text-ink-muted leading-snug">
            Recorded in {invoice.currency} and carried into the books at{' '}
            {money(invoice.baseGrossMinor, invoice.baseCurrency)}, using the rate of{' '}
            {invoice.fxRateNumerator && invoice.fxRateDenominator
              ? (invoice.fxRateNumerator / invoice.fxRateDenominator).toFixed(6)
              : 'an unrecorded rate'}{' '}
            {invoice.fxRateSource && `from ${invoice.fxRateSource}`}
            {invoice.fxRateDate && ` on ${date(invoice.fxRateDate)}`}. Settling at a different
            rate posts the difference to exchange gains or losses rather than restating this
            invoice.
          </div>
        )}

        {deferredVat && (
          <div className="px-4 py-2.5 border-t border-line bg-caution-soft text-caution leading-snug">
            This company is on the cash receipts basis, so the{' '}
            {money(invoice.vatMinor, invoice.currency)} of VAT on this invoice is not yet due.
            It is held in the deferred VAT account and released into a VAT return in
            proportion to each receipt, as the customer pays.
          </div>
        )}
      </Panel>

      <Panel title="Lines">
        <table className="ledger">
          <thead>
            <tr>
              <th>Description</th>
              <th className="w-56">Account</th>
              <th className="w-56">VAT treatment</th>
              <th className="w-20 text-right">Rate</th>
              <th className="w-28 text-right">Net</th>
              <th className="w-28 text-right">VAT</th>
              <th className="w-28 text-right">Gross</th>
            </tr>
          </thead>
          <tbody>
            {lines.map(({ line, accountCode, accountName, treatmentCode, treatmentName }) => (
              <tr key={line.id}>
                <td>{line.description}</td>
                <td className="text-ink-muted">
                  {accountCode ? `${accountCode} — ${accountName}` : '—'}
                </td>
                <td className="text-ink-muted">
                  {treatmentCode ? `${treatmentCode} — ${treatmentName}` : '—'}
                </td>
                <td className="text-right num">{(line.rateBasisPoints / 100).toFixed(1)}%</td>
                <td className="text-right num">{money(line.netMinor, line.currency)}</td>
                <td className="text-right num">{money(line.vatMinor, line.currency)}</td>
                <td className="text-right num">{money(line.grossMinor, line.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel
        title="Payments"
        description="Recorded separately from the invoice. Nothing here is assumed paid on issue."
      >
        {allocations.length === 0 ? (
          <Empty title="Nothing received against this invoice yet" />
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th className="w-28">Date</th>
                <th>Reference</th>
                <th className="w-32">Method</th>
                <th className="w-32 text-right">Allocated</th>
                <th className="w-32 text-right">Exchange difference</th>
              </tr>
            </thead>
            <tbody>
              {allocations.map(({ allocation, payment }) => (
                <tr key={allocation.id}>
                  <td className="num !text-left">{date(payment.paymentDate)}</td>
                  <td>{payment.reference ?? <span className="text-ink-faint">—</span>}</td>
                  <td className="text-ink-muted">{label(payment.method)}</td>
                  <td className="text-right num">
                    {money(allocation.allocatedMinor, allocation.currency)}
                  </td>
                  <td className="text-right num">
                    {allocation.fxDifferenceMinor === 0
                      ? <span className="text-ink-faint">—</span>
                      : money(allocation.fxDifferenceMinor, invoice.baseCurrency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {invoice.outstandingMinor !== 0 && invoice.status !== 'void' && (
          <Disclosure summary="Record a payment" tone="accent">
            <div className="max-w-3xl">
              {deferredVat && (
                <p className="text-ink-muted mb-3 leading-snug">
                  Recording a receipt releases a proportionate share of the deferred VAT into
                  the period the payment falls in. The release is computed on the total paid to
                  date rather than on each instalment separately, so part payments cannot drift
                  by a cent.
                </p>
              )}
              <PaymentForm
                action={recordPaymentAction}
                invoiceId={invoice.id}
                direction={isSales ? 'received' : 'made'}
                invoiceCurrency={invoice.currency}
                outstandingMinor={invoice.outstandingMinor}
                bankTransactions={unpostedTransactionOptions()}
              />
            </div>
          </Disclosure>
        )}
      </Panel>

      {invoice.journalEntryId && (
        <Panel>
          <div className="px-4 py-2.5 text-ink-muted">
            Posted to the ledger as{' '}
            <a href={`/audit?entry=${invoice.journalEntryId}`}
              className="text-accent hover:underline">
              a journal entry
            </a>. The entry is immutable; a correction is a reversal, not an edit.
          </div>
        </Panel>
      )}
    </Page>
  );
}
