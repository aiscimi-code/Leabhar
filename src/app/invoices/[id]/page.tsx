import { notFound } from 'next/navigation';
import { invoiceDetail, unpostedTransactionOptions, officerList, purchaseOrderOptions } from '@/lib/queries';
import {
  Page, Panel, Badge, Stat, Empty, Disclosure, ProvenanceBadge, Field, Input, Select,
} from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import {
  allocateOnAccountAction, applyCreditNoteAction, unapplyCreditNoteAction, raiseDebitNoteAction,
  writeOffBadDebtAction, reverseBadDebtAction, linkBillToPurchaseOrderAction, unlinkBillFromPurchaseOrderAction,
} from '@/app/actions';
import { PaymentForm } from '@/components/PaymentForm';
import { recordPaymentAction } from '@/app/settings-actions';
import { money, date, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** One invoice, its VAT, and every payment allocated against it (README §26, §27). */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = invoiceDetail(id);
  if (!detail) notFound();

  const {
    invoice, lines, allocations, party, company, onAccount, missingParticulars, counterparts,
    incomeAccounts, treatmentOptions, adjustsNumber, expenseAccounts, vatDeferred,
  } = detail;
  const today = new Date().toISOString().slice(0, 10);
  const isSales = invoice.direction === 'sales';
  const orders = !isSales && invoice.status !== 'void' ? purchaseOrderOptions(invoice) : null;
  const deferredVat = vatDeferred;

  return (
    <Page
      title={invoice.invoiceNumber ?? `Invoice #${invoice.internalNumber ?? ''}`}
      subtitle={`${isSales ? 'Sales' : 'Purchase'} ${invoice.isCreditNote ? 'credit note' : invoice.isDebitNote ? 'debit note' : 'invoice'} dated ${date(invoice.invoiceDate)}`
        + (adjustsNumber ? `, adding to ${adjustsNumber}` : '')
        + (party ? ` — ${party.name}` : '')}
      actions={
        <>
          {isSales && (
            <a href={`/api/invoices/${invoice.id}/pdf`}
              className="px-2.5 py-1 rounded border border-line-strong text-[12px] font-medium bg-surface hover:bg-surface-sunken">
              PDF{missingParticulars.length > 0 ? ' (draft)' : ''}
            </a>
          )}
          <ProvenanceBadge status={invoice.provenanceStatus} source={invoice.source} />
          <Badge tone={invoice.status === 'paid' ? 'positive'
            : invoice.status === 'overdue' ? 'negative'
            : invoice.status === 'part_paid' ? 'caution' : 'neutral'}>
            {label(invoice.status)}
          </Badge>
        </>
      }
    >
      {missingParticulars.length > 0 && (
        <Panel tone="warning" title="Not yet a valid VAT invoice"
          description="The PDF is produced marked as a draft until these are recorded (S.I. 639/2010 reg.20). Nothing is filled in for you.">
          <ul className="px-4 py-3 list-disc pl-8 text-[12.5px] space-y-0.5">
            {missingParticulars.map((m) => <li key={m.code}>{m.what} <span className="text-ink-muted">({m.paragraph})</span></li>)}
          </ul>
        </Panel>
      )}

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

      {orders && (orders.linked || orders.open.length > 0) && (
        <Panel title="Purchase order"
          description="The order this bill was raised against. Linking changes nothing in the books; it tracks what has been billed against the order.">
          <div className="px-4 py-3 flex gap-4 items-end">
            {orders.linked ? (
              <>
                <p className="text-[12.5px]">
                  Raised against <a href="/purchase-orders" className="underline font-medium">{orders.linked.number}</a>:{' '}
                  {money(orders.linked.billedMinor, orders.linked.currency)} billed of{' '}
                  {money(orders.linked.orderedMinor, orders.linked.currency)} ordered.
                </p>
                <ActionForm action={unlinkBillFromPurchaseOrderAction} submit="Unlink" variant="secondary"
                  confirm="Unlink this bill from the order? The bill itself is not changed."
                  extra={{ invoiceId: invoice.id }} />
              </>
            ) : (
              <ActionForm action={linkBillToPurchaseOrderAction} submit="Link" inline extra={{ invoiceId: invoice.id }}>
                <Field label="Open order for this supplier">
                  <Select name="purchaseOrderId" required defaultValue="">
                    <option value="" disabled>Choose an order</option>
                    {orders.open.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.number} — {date(o.orderDate)}, {money(o.remainingMinor, o.currency)} remaining
                      </option>
                    ))}
                  </Select>
                </Field>
              </ActionForm>
            )}
          </div>
        </Panel>
      )}

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
                <td>
                  {line.description}
                  {line.discountMinor !== 0 && (
                    <span className="block text-[11.5px] text-ink-muted">
                      {money(line.undiscountedNetMinor, line.currency)} less{' '}
                      {line.discountBasisPoints !== null ? `${(line.discountBasisPoints / 100).toFixed(2)}% ` : ''}
                      discount of {money(line.discountMinor, line.currency)}
                    </span>
                  )}
                </td>
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
                <tr key={allocation.id} className={payment.reversedAt ? 'text-ink-faint line-through' : ''}>
                  <td className="num !text-left">{date(payment.paymentDate)}</td>
                  <td>
                    {payment.reference ?? <span className="text-ink-faint">—</span>}
                    {payment.reversedAt && (
                      <span className="no-underline ml-1.5 text-caution" style={{ textDecoration: 'none' }}>
                        reversed{payment.reversalReason ? `: ${payment.reversalReason}` : ''}
                      </span>
                    )}
                  </td>
                  <td className="text-ink-muted">
                    {allocation.allocationType === 'write_off'
                      ? `Written off${allocation.notes ? `: ${allocation.notes}` : ''}`
                      : allocation.allocationType === 'on_account'
                        ? 'From money on account'
                        : payment.method === 'offset' ? 'Credit note applied' : label(payment.method)}
                    {payment.method === 'offset' && !payment.reversedAt && (
                      <Disclosure summary="Unapply">
                        <ActionForm action={unapplyCreditNoteAction} submit="Unapply" variant="secondary"
                          extra={{ paymentId: payment.id, invoiceId: invoice.id }}>
                          <Field label="Why"><Input name="reason" required placeholder="Applied to the wrong invoice" /></Field>
                        </ActionForm>
                      </Disclosure>
                    )}
                  </td>
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

        {counterparts.length > 0 && (
          <Disclosure summary={invoice.isCreditNote ? 'Apply this credit note to an invoice' : 'Settle from a credit note'} tone="accent">
            <div className="max-w-3xl">
              <ActionForm action={applyCreditNoteAction} submit="Apply" inline>
                {invoice.isCreditNote
                  ? <input type="hidden" name="creditNoteId" value={invoice.id} />
                  : <input type="hidden" name="invoiceId" value={invoice.id} />}
                <Field label={invoice.isCreditNote ? 'Invoice' : 'Credit note'}>
                  <select name={invoice.isCreditNote ? 'invoiceId' : 'creditNoteId'} required
                    className="border border-line-strong rounded px-2 py-1 bg-surface text-[12.5px]">
                    {counterparts.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.invoiceNumber ?? c.id} · {date(c.invoiceDate)} · {money(Math.abs(c.outstandingMinor), c.currency)} open
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Amount"><Input name="amount" required defaultValue={(Math.abs(invoice.outstandingMinor) / 100).toFixed(2)} /></Field>
                <Field label="Date"><Input name="date" type="date" defaultValue={today} required /></Field>
              </ActionForm>
              <p className="text-ink-muted mt-2 leading-snug">
                No cash moves and nothing is posted: the credit note and the invoice both sit on the same control
                account. It records which invoice the credit settles.
              </p>
            </div>
          </Disclosure>
        )}

        {onAccount.length > 0 && invoice.status !== 'void' && (
          <Disclosure summary={`${party?.name ?? 'This party'} has money on account — apply it`} tone="accent">
            <ul className="max-w-3xl divide-y divide-line">
              {onAccount.map((p) => (
                <li key={p.paymentId} className="py-2.5">
                  <p className="text-[12.5px]">
                    {money(p.onAccountMinor, p.currency)} on account from the payment of {date(p.paymentDate)}
                    {p.reference && <span className="text-ink-muted"> · {p.reference}</span>}
                  </p>
                  <div className="mt-1.5">
                    <ActionForm action={allocateOnAccountAction} submit="Apply" inline>
                      <input type="hidden" name="paymentId" value={p.paymentId} />
                      <input type="hidden" name="invoiceId" value={invoice.id} />
                      <Field label="Amount">
                        <Input name="amount" required
                          defaultValue={(Math.min(p.onAccountMinor, invoice.outstandingMinor) / 100).toFixed(2)} />
                      </Field>
                      <Field label="Note (optional)">
                        <Input name="reason" placeholder="Deposit applied to the final invoice" />
                      </Field>
                      {invoice.direction === 'sales' && invoice.vatMinor !== 0 && (
                        <Field label="Declare the released VAT in (optional)">
                          <Input name="vatDeclarationDate" type="date"
                            placeholder="Only when the receipt's own period is locked or filed" />
                        </Field>
                      )}
                    </ActionForm>
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-ink-muted mt-2 leading-snug max-w-3xl">
              Applying it posts nothing: the money already sits on {isSales ? 'debtors' : 'creditors'} against
              {party ? ` ${party.name}` : ' this party'}. It records which invoice it pays.
              {isSales && invoice.vatMinor !== 0 && ' On the cash receipts basis, its output VAT becomes due dated at the receipt (s.80(1)) - name a period above only if the receipt’s own is locked or filed.'}
            </p>
          </Disclosure>
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
                officers={isSales ? [] : officerList().map((o) => ({ value: o.id, label: o.name }))}
              />
            </div>
          </Disclosure>
        )}
      </Panel>

      {invoice.status === 'written_off' && (
        <Panel tone="warning" title="Written off as a bad debt"
          description={`${money(invoice.writtenOffMinor, invoice.currency)} written off on ${date(invoice.writtenOffAt)}: ${invoice.writeOffReason ?? ''}`}>
          <div className="px-4 py-3">
            <Disclosure summary="The customer paid after all? Reverse the write-off">
              <ActionForm action={reverseBadDebtAction} submit="Reverse write-off" extra={{ invoiceId: invoice.id }}>
                <Field label="Date"><Input name="date" type="date" defaultValue={today} required /></Field>
                <Field label="Why"><Input name="reason" required placeholder="Debt recovered" /></Field>
              </ActionForm>
            </Disclosure>
          </div>
        </Panel>
      )}

      {isSales && !invoice.isCreditNote && invoice.outstandingMinor > 0
        && invoice.status !== 'void' && invoice.status !== 'written_off' && (
        <Panel>
          <Disclosure summary="Write off as a bad debt">
            <div className="max-w-3xl">
              <ActionForm action={writeOffBadDebtAction} submit="Write off" variant="danger"
                confirm="Write this debt off? It can be reversed later if the customer pays." extra={{ invoiceId: invoice.id }}>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Date"><Input name="date" type="date" defaultValue={today} required /></Field>
                  <Field label="Why"><Input name="reason" required placeholder="Customer in liquidation" /></Field>
                  <Field label="Charge to" hint="Blank: Bad debts (6230).">
                    <select name="accountId" defaultValue="" className="border border-line-strong rounded px-2 py-1 bg-surface text-[12.5px]">
                      <option value="">Bad debts</option>
                      {expenseAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                    </select>
                  </Field>
                </div>
              </ActionForm>
              <p className="text-ink-muted mt-2 leading-snug">
                {vatDeferred
                  ? 'On the cash receipts basis the unpaid share of this invoice\'s VAT was never due; it is cancelled from deferred VAT and only the net is a bad debt.'
                  : 'The VAT in it was declared when the invoice was raised. Bad-debt relief may let it be reclaimed; nothing is claimed here, and a review item is raised.'}
              </p>
            </div>
          </Disclosure>
        </Panel>
      )}

      {!invoice.isCreditNote && !invoice.isDebitNote && invoice.status !== 'void' && (
        <Panel>
          <Disclosure summary="Raise a debit note against this invoice">
            <div className="max-w-4xl">
              <ActionForm action={raiseDebitNoteAction} submit="Raise debit note" resetOnSuccess extra={{ invoiceId: invoice.id }}>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Date"><Input name="date" type="date" defaultValue={today} required /></Field>
                  <Field label="Description"><Input name="description" required placeholder="Undercharged hours" /></Field>
                  <Field label={`Net (${invoice.currency})`}><Input name="net" required placeholder="0.00" /></Field>
                  <Field label="Account">
                    <select name="accountId" required className="border border-line-strong rounded px-2 py-1 bg-surface text-[12.5px]">
                      {incomeAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                    </select>
                  </Field>
                  <Field label="VAT treatment">
                    <select name="vatTreatmentId" required defaultValue={lines[0]?.line.vatTreatmentId ?? ''}
                      className="border border-line-strong rounded px-2 py-1 bg-surface text-[12.5px]">
                      {treatmentOptions.map((t) => <option key={t.id} value={t.id}>{t.code} — {t.name}</option>)}
                    </select>
                  </Field>
                </div>
              </ActionForm>
              <p className="text-ink-muted mt-2 leading-snug">
                An additional charge: posted and aged like an invoice, with its own number and VAT, and linked to this one.
              </p>
            </div>
          </Disclosure>
        </Panel>
      )}

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
