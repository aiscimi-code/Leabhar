import Link from 'next/link';
import { notFound } from 'next/navigation';
import { documentDetail, unpostedTransactionOptions } from '@/lib/queries';
import {
  Page, Panel, Badge, ProvenanceBadge, Help, Empty, LinkButton, Field, Input, Disclosure,
} from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { money, date, dateTime, label, percent } from '@/lib/format';
import { LinkControls } from '@/components/LinkControls';
import { CandidateActions } from '@/components/CandidateActions';
import { DocumentReview } from '@/components/DocumentReview';
import { PostInvoiceForm } from '@/components/PostInvoiceForm';
import { chartOfAccounts, treatmentsWithRates } from '@/lib/queries';
import { asIsoDate } from '@/domain/dates';
import {
  linkDocumentAction, unmatchDocumentAction, acceptMatchAction, rejectMatchAction, withdrawMatchRejectionAction,
  archiveDocumentAction, restoreDocumentAction, deleteDocumentAction,
} from '@/app/actions';

export const dynamic = 'force-dynamic';

const FIELD_LABELS: Record<string, string> = {
  documentType: 'Document type',
  supplierName: 'Supplier',
  customerName: 'Customer',
  invoiceNumber: 'Invoice number',
  documentDate: 'Document date',
  dueDate: 'Due date',
  currency: 'Currency',
  netMinor: 'Net amount',
  vatMinor: 'VAT amount',
  grossMinor: 'Total',
  vatRateBasisPoints: 'VAT rate',
  supplierVatNumber: 'Supplier VAT number',
  customerVatNumber: 'Customer VAT number',
  supplierCountry: 'Supplier country',
  suggestedVatTreatment: 'Suggested VAT treatment',
  suggestedAccountCode: 'Suggested account',
};

/** One extraction run's fields, as the latest or as a superseded reading. */
function ExtractionRunTable({
  run, currency,
}: { run: { fields: Record<string, { value: string | number | null; confidence: number; evidence?: string }>; status: string }; currency: string }) {
  return (
    <table className="ledger">
      <thead>
        <tr>
          <th className="w-44">Field</th>
          <th>Value</th>
          <th className="w-24 text-right">Confidence</th>
          <th>Taken from</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(run.fields)
          .filter(([, field]) => field.value !== null)
          .map(([key, field]) => (
            <tr key={key}>
              <td className="text-ink-faint">{FIELD_LABELS[key] ?? key}</td>
              <td className="text-ink">
                {key.endsWith('Minor')
                  ? <span className="num !text-left">{money(Number(field.value), currency)}</span>
                  : key === 'vatRateBasisPoints'
                    ? `${Number(field.value) / 100}%`
                    : String(field.value)}
              </td>
              <td className="text-right">
                <Badge tone={field.confidence >= 80 ? 'positive'
                  : field.confidence >= 50 ? 'caution' : 'negative'}>
                  {percent(field.confidence)}
                </Badge>
              </td>
              <td className="text-ink-muted text-[11.5px]">{field.evidence ?? '—'}</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}

/**
 * Document detail (README §11, §12, §16).
 *
 * Shows what was extracted, how confident each field was, and the evidence the
 * value came from — so the user can check a figure against the document in one
 * glance rather than opening the PDF and comparing by eye.
 */
export default async function DocumentDetailPage({ params }: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = documentDetail(id);
  if (!detail) notFound();

  const { document: doc, supplier, extractions, matches, matchedTransaction,
          audit, duplicateOf, company, review, supplierOptions, customerOptions, openItems, posting, invoice,
          evidence, dependencies } = detail;
  const latest = extractions[0];
  const currency = doc.currency ?? company.baseCurrency;
  const linkableTransactions = unpostedTransactionOptions();

  return (
    <Page
      title={doc.originalFilename}
      subtitle={
        <span>
          {label(doc.documentType)} · uploaded {dateTime(doc.uploadedAt)} ·{' '}
          {(doc.fileSizeBytes / 1024).toFixed(0)} KB
        </span>
      }
      actions={<LinkButton href="/documents">All documents</LinkButton>}
    >
      {duplicateOf && (
        <Panel tone="warning" title="This file is byte-identical to one already stored">
          <p className="px-4 py-3 text-ink-muted">
            The same content was uploaded before as{' '}
            <Link href={`/documents/${duplicateOf.id}`} className="text-accent hover:underline">
              {duplicateOf.originalFilename}
            </Link>{' '}
            on {dateTime(duplicateOf.uploadedAt)}. That document has not been touched.
            Confirm whether this is a genuine second copy or a re-upload of the same one —
            attaching both to the same cost would reclaim the VAT twice.
          </p>
        </Panel>
      )}

      <div className="mb-4">
        <DocumentReview
          key={latest?.id ?? 'none'}
          documentId={doc.id}
          filename={doc.originalFilename}
          mimeType={doc.mimeType}
          reviewStatus={doc.reviewStatus}
          reviewedBy={doc.reviewedBy}
          reviewNote={doc.reviewNote}
          inUse={Boolean(doc.invoiceId || doc.matchedTransactionId)}
          values={review.values}
          baseCurrency={company.baseCurrency}
          confidence={Object.fromEntries(Object.entries(latest?.fields ?? {}).map(([k, f]) => [k, f.confidence]))}
          observations={openItems}
          supplierId={doc.supplierId}
          customerId={doc.customerId}
          supplierOptions={supplierOptions}
          customerOptions={customerOptions}
        />
      </div>

      {posting && (
        <Panel title="Post as an invoice"
          description="The VAT posted is the VAT on each confirmed line — never a split of the bank payment. Choose the account and treatment for every line; each option says why it is offered.">
          {posting.error ? (
            <p className="px-4 py-3 text-[12px] text-negative">{posting.error}</p>
          ) : posting.choices && (
            <>
            {posting.choices.conflicts.length > 0 && (
              <div className="px-4 py-3 border-b border-line">
                <p className="text-[12px] font-medium text-caution">The invoice conflicts with itself or with the records. Nothing is pre-selected until you have checked:</p>
                {posting.choices.conflicts.map((c) => (
                  <p key={c.code} className="text-[11.5px] text-caution mt-1">{c.message}</p>
                ))}
              </div>
            )}
            <PostInvoiceForm
              documentId={doc.id}
              missingParticulars={posting.choices.missingParticulars.map((m) => `${m.what} (${m.paragraph})`)}
              direction={posting.choices.direction}
              currency={(doc.currency ?? company.baseCurrency).toUpperCase()}
              baseCurrency={company.baseCurrency}
              lines={posting.choices.lines.map((c) => ({
                number: c.line.number, description: c.line.description, netMinor: c.line.netMinor,
                vatMinor: c.line.vatMinor, rateBasisPoints: c.line.rateBasisPoints, options: c.options,
                preselectedTreatmentId: c.preselectedTreatmentId, accountId: c.accountId,
                accountReason: c.accountReason, flags: c.flags, deductionBlocked: c.deductionBlocked,
              }))}
              accounts={chartOfAccounts().filter((a) => a.active).map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type }))}
              treatments={treatmentsWithRates(asIsoDate(doc.documentDate ?? new Date().toISOString().slice(0, 10)))
                .map((t) => ({ id: t.id, code: t.code, name: t.name }))}
            />
            </>
          )}
        </Panel>
      )}
      {invoice && (
        <Panel title="Posted as an invoice">
          <p className="px-4 py-3 text-[12px]">
            <Link href={`/invoices/${invoice.id}`} className="text-accent hover:underline">
              {invoice.invoiceNumber ?? 'Invoice'}
            </Link>{' '}
            · net {money(invoice.netMinor, invoice.currency)} · VAT {money(invoice.vatMinor, invoice.currency)}
            {' '}· {label(invoice.status)}
            {invoice.outstandingMinor !== 0 && ` · ${money(invoice.outstandingMinor, invoice.currency)} outstanding`}
          </p>
        </Panel>
      )}

      <div className="grid grid-cols-[1.3fr_1fr] gap-4 items-start">
        <div>
          <Panel title="How each value was read"
            description={latest
              ? `Read by the ${latest.provider} extractor${latest.model ? ` (${latest.model})` : ''}, `
                + `${percent(latest.overallConfidence)} overall confidence. The evidence behind each `
                + 'value in the latest automatic read — the sheet above is what counts.'
              : undefined}>
            {!latest ? (
              <Empty title="Not yet read" />
            ) : (
              <ExtractionRunTable run={latest} currency={currency} />
            )}
            {latest?.status === 'failed' && (
              <div className="px-4 py-2.5 bg-caution-soft border-t border-caution/30 text-caution">
                {latest.errorMessage ?? 'Nothing could be read from this file.'}
              </div>
            )}
            {extractions.length > 1 && (
              <div className="px-4 py-3 border-t border-line space-y-2">
                <p className="text-[11.5px] text-ink-faint">
                  Every reading is kept (the file itself never changes), so a confirmed
                  value can always be compared with what was read before it.
                </p>
                {extractions.slice(1).map((run) => (
                  <Disclosure
                    key={run.id}
                    summary={`Read by ${run.provider}${run.model ? ` (${run.model})` : ''} `
                      + `on ${dateTime(run.createdAt)} — ${label(run.status)}, `
                      + `${percent(run.overallConfidence)} confidence`}
                  >
                    <ExtractionRunTable run={run} currency={currency} />
                    {run.status === 'failed' && (
                      <p className="text-[11.5px] text-caution mt-1">
                        {run.errorMessage ?? 'Nothing could be read from this file.'}
                      </p>
                    )}
                  </Disclosure>
                ))}
              </div>
            )}
          </Panel>

          <Panel
            title="Matching"
            description="Every candidate considered, with the reasoning behind each score.
              Nothing uncertain is applied without your decision."
          >
            {matches.length === 0 ? (
              <Empty
                title="No candidates"
                detail="Nothing in the bank data plausibly corresponds to this document.
                  It may not have been paid yet, it may have been paid personally, or the
                  statement covering it may not be imported."
              />
            ) : (
              matches.map(({ match, description, amountMinor, transactionDate, currency: txCurrency }) => (
                <div key={match.id} className="px-4 py-3 border-b border-line last:border-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      {match.bankTransactionId ? (
                        <Link href={`/transactions/${match.bankTransactionId}`}
                          className="text-accent hover:underline font-medium">
                          {description}
                        </Link>
                      ) : <span className="font-medium">Invoice match</span>}
                      <div className="text-ink-muted text-[12px] mt-0.5">
                        {date(transactionDate)} ·{' '}
                        <span className="num">{money(amountMinor, txCurrency ?? 'EUR')}</span>
                        {match.amountDifferenceMinor !== null && match.amountDifferenceMinor !== 0 && (
                          <span className="text-caution ml-1.5">
                            differs by {money(Math.abs(match.amountDifferenceMinor), currency)}
                          </span>
                        )}
                        {match.dateDifferenceDays !== null && (
                          <span className="ml-1.5">
                            · {Math.abs(match.dateDifferenceDays)} day
                            {Math.abs(match.dateDifferenceDays) === 1 ? '' : 's'} apart
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Badge tone={match.matchType === 'matched' ? 'positive'
                        : match.matchType === 'conflict' ? 'negative' : 'caution'}>
                        {label(match.matchType)} {percent(match.score)}
                      </Badge>
                      <Badge tone={match.decision === 'accepted' || match.decision === 'auto_accepted'
                        ? 'positive' : match.decision === 'rejected' ? 'negative' : 'neutral'}>
                        {label(match.decision)}
                      </Badge>
                    </div>
                  </div>
                  <ul className="mt-2 space-y-0.5">
                    {match.factors.map((factor, index) => (
                      <li key={index} className="text-[11.5px] text-ink-muted flex gap-2">
                        <span className={`w-9 shrink-0 num !text-left ${
                          factor.weight === 0 ? 'text-ink-faint'
                            : factor.score >= 70 ? 'text-positive'
                            : factor.score === 0 ? 'text-negative' : 'text-caution'}`}>
                          {factor.weight === 0 ? '—' : `${factor.score}%`}
                        </span>
                        <span>{factor.detail}</span>
                      </li>
                    ))}
                  </ul>
                  {match.decision === 'pending' && match.bankTransactionId && (
                    <CandidateActions
                      accept={acceptMatchAction}
                      reject={rejectMatchAction}
                      documentId={doc.id}
                      bankTransactionId={match.bankTransactionId}
                    />
                  )}
                  {match.decision === 'rejected' && match.provenanceStatus === 'user_rejected'
                    && match.bankTransactionId && (
                    <div className="mt-2">
                      <Disclosure summary="Rejected — matching will not suggest this pairing again. Withdraw?">
                        <ActionForm action={withdrawMatchRejectionAction} submit="Withdraw the rejection" variant="secondary">
                          <input type="hidden" name="documentId" value={doc.id} />
                          <input type="hidden" name="bankTransactionId" value={match.bankTransactionId} />
                          <Field label="Why">
                            <Input name="reason" required placeholder="Rejected by mistake" />
                          </Field>
                        </ActionForm>
                      </Disclosure>
                    </div>
                  )}
                </div>
              ))
            )}
          </Panel>

          {evidence && (
            <Panel
              title="Evidence chain"
              description="What rests on this document, assembled from what was posted and never
                recomputed: the invoice it became, its journal entry and VAT entries, the payments
                that settled it, the bank lines behind them, and the matches considered along the way."
            >
              <div className="px-4 py-3 space-y-3 text-[12px]">
                {evidence.duplicateOf && (
                  <p className="text-ink-muted">
                    Byte-identical to{' '}
                    <Link href={`/documents/${evidence.duplicateOf.id}`} className="text-accent hover:underline">
                      {evidence.duplicateOf.filename}
                    </Link>, which is on file.
                  </p>
                )}
                {evidence.duplicates.length > 0 && (
                  <p className="text-ink-muted">
                    {evidence.duplicates.length === 1 ? 'One document is' : `${evidence.duplicates.length} documents are`}{' '}
                    flagged as duplicates of this one
                    {evidence.duplicates.map((d) => (
                      <span key={d.id}>
                        {' '}
                        <Link href={`/documents/${d.id}`} className="text-accent hover:underline">{d.filename}</Link>
                      </span>
                    ))}.
                  </p>
                )}
                {evidence.linkedTransaction && (
                  <p className="text-ink-muted">
                    Linked to bank line{' '}
                    <Link href={`/transactions/${evidence.linkedTransaction.id}`} className="text-accent hover:underline">
                      {evidence.linkedTransaction.description}
                    </Link>{' '}
                    on {date(evidence.linkedTransaction.transactionDate)} for{' '}
                    {money(evidence.linkedTransaction.amountMinor, evidence.linkedTransaction.currency)}.
                  </p>
                )}
                {evidence.invoice ? (
                  <div className="border-t border-line pt-3 space-y-2">
                    <p className="text-ink">
                      Posted as{' '}
                      <Link href={`/invoices/${evidence.invoice.invoiceId}`} className="text-accent hover:underline">
                        {evidence.invoice.invoiceNumber ?? 'invoice'}
                      </Link>{' '}
                      on {date(evidence.invoice.invoiceDate)} ·{' '}
                      {money(evidence.invoice.grossMinor, evidence.invoice.currency)} · {label(evidence.invoice.status)}.
                    </p>
                    {evidence.invoice.journalEntry && (
                      <p className="text-ink-muted">
                        Journal #{evidence.invoice.journalEntry.entryNumber} on{' '}
                        {date(evidence.invoice.journalEntry.entryDate)} — {evidence.invoice.journalEntry.narrative}.
                      </p>
                    )}
                    {evidence.invoice.vatEntries.length > 0 && (
                      <div>
                        <p className="text-ink-faint text-[10px] uppercase tracking-wide font-semibold mb-1">
                          VAT entries
                        </p>
                        <ul className="space-y-1">
                          {evidence.invoice.vatEntries.map((e) => (
                            <li key={e.id} className="flex flex-wrap gap-1.5 items-center">
                              <Badge tone="accent">{e.vatBox ?? '—'}</Badge>
                              {e.netBox && <Badge tone="neutral">{e.netBox}</Badge>}
                              <span className="num">
                                {money(e.direction === 'purchases' ? e.recoverableVatMinor : e.vatMinor, currency)}
                              </span>
                              <span className="text-ink-faint">
                                {e.rateBasisPoints / 100}% · {e.periodName ?? date(e.taxPointDate)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {evidence.invoice.payments.length > 0 && (
                      <div>
                        <p className="text-ink-faint text-[10px] uppercase tracking-wide font-semibold mb-1">
                          Settled by
                        </p>
                        <ul className="space-y-1">
                          {evidence.invoice.payments.map((pay) => (
                            <li key={pay.paymentId} className="text-ink-muted">
                              {date(pay.paymentDate)} · {money(pay.amountMinor, pay.currency)}
                              {pay.bankTransaction ? (
                                <>
                                  {' · from '}
                                  <Link href={`/transactions/${pay.bankTransaction.id}`}
                                    className="text-accent hover:underline">
                                    {pay.bankTransaction.description}
                                  </Link>
                                </>
                              ) : ' · no bank line'}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-ink-faint">
                    No invoice has been posted from this document, and nothing in the books rests on it.
                  </p>
                )}
              </div>
            </Panel>
          )}
        </div>

        <div>
          <Panel title="Document">
            <table className="ledger">
              <tbody>
                <tr>
                  <td className="w-36 text-ink-faint">Type</td>
                  <td>{label(doc.documentType)}</td>
                </tr>
                <tr>
                  <td className="text-ink-faint">Status</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      <Badge tone={doc.matchStatus === 'matched' ? 'positive' : 'caution'}>
                        {label(doc.matchStatus)}
                      </Badge>
                      <ProvenanceBadge status={doc.provenanceStatus} confidence={doc.confidence} />
                    </div>
                  </td>
                </tr>
                {supplier && (
                  <tr>
                    <td className="text-ink-faint">Supplier</td>
                    <td>
                      <Link href={`/suppliers/${supplier.id}`} className="text-accent hover:underline">
                        {supplier.name}
                      </Link>
                    </td>
                  </tr>
                )}
                {doc.invoiceNumber && (
                  <tr><td className="text-ink-faint">Invoice number</td><td className="num !text-left">{doc.invoiceNumber}</td></tr>
                )}
                {doc.documentDate && (
                  <tr><td className="text-ink-faint">Document date</td><td>{date(doc.documentDate)}</td></tr>
                )}
                <tr><td className="text-ink-faint">Net</td><td className="num !text-left">{money(doc.netMinor, currency)}</td></tr>
                <tr><td className="text-ink-faint">VAT</td><td className="num !text-left">{money(doc.vatMinor, currency)}</td></tr>
                <tr><td className="text-ink-faint">Total</td><td className="num !text-left font-semibold">{money(doc.grossMinor, currency)}</td></tr>
                <tr>
                  <td className="text-ink-faint">
                    SHA-256
                    <Help>
                      The hash of the file recorded when it was stored. It is re-checkable, which
                      is how the year-end pack can assert that the evidence behind a figure is the
                      same evidence that was there when it was classified.
                    </Help>
                  </td>
                  <td className="num !text-left text-[10.5px] text-ink-faint break-all">{doc.sha256}</td>
                </tr>
                <tr><td className="text-ink-faint">Stored at</td>
                  <td className="text-[11px] text-ink-faint break-all">{doc.storagePath}</td></tr>
              </tbody>
            </table>
          </Panel>

          {matchedTransaction ? (
            <Panel title="Matched transaction">
              <table className="ledger">
                <tbody>
                  <tr>
                    <td className="w-36 text-ink-faint">Transaction</td>
                    <td>
                      <Link href={`/transactions/${matchedTransaction.id}`}
                        className="text-accent hover:underline">
                        {matchedTransaction.description}
                      </Link>
                    </td>
                  </tr>
                  <tr><td className="text-ink-faint">Date</td><td>{date(matchedTransaction.transactionDate)}</td></tr>
                  <tr>
                    <td className="text-ink-faint">Amount</td>
                    <td className="num !text-left">
                      {money(matchedTransaction.amountMinor, matchedTransaction.currency)}
                    </td>
                  </tr>
                </tbody>
              </table>
              <div className="px-4 py-2.5 border-t border-line">
                <LinkControls
                  action={unmatchDocumentAction}
                  options={[{ value: doc.id, label: matchedTransaction.description }]}
                  extra={{ documentId: doc.id }}
                  selectName="documentId"
                  label="Unlink"
                  submit="Unlink transaction"
                />
              </div>
            </Panel>
          ) : (
            <Panel title="Matched transaction" description="No transaction linked.">
              {doc.reviewStatus !== 'confirmed' ? (
                <p className="px-4 py-3 text-[12px] text-ink-muted">
                  Confirm this document&apos;s details first. Only a confirmed document can be linked to a
                  bank transaction.
                </p>
              ) : (
              <LinkControls
                action={linkDocumentAction}
                options={linkableTransactions}
                extra={{ documentId: doc.id }}
                selectName="bankTransactionId"
                label="Link a transaction"
                submit="Link"
                emptyHint="No unposted transactions available to link."
              />
              )}
            </Panel>
          )}

          <Panel
            title={doc.archived ? 'Archived' : 'Retire this document'}
            description={doc.archived
              ? `Out of the working lists. Restore it, or delete it for good — deletion is the
                 only thing that ever removes a stored file, and only when no other document
                 shares its bytes.`
              : `Archiving takes a document out of the working lists and is reversible. It is
                 refused while anything in the books rests on the document.`}
          >
            <div className="px-4 py-3 space-y-3">
              {doc.archived ? (
                <>
                  <ActionForm action={restoreDocumentAction} submit="Restore" variant="secondary" extra={{ documentId: doc.id }}>
                    <Field label="Why">
                      <Input name="reason" required placeholder="Archived by mistake" />
                    </Field>
                  </ActionForm>
                  <Disclosure summary="Delete for good — permanent, audited">
                    <p className="text-[11.5px] text-ink-muted mb-2">
                      The record, the drafts read from it and — unless another document shares the
                      same bytes — the stored file are removed. This cannot be undone.
                    </p>
                    <ActionForm
                      action={deleteDocumentAction} submit="Delete for good" variant="danger"
                      confirm="Delete this document permanently? This cannot be undone."
                      extra={{ documentId: doc.id }}
                    >
                      <Field label="Why">
                        <Input name="reason" required placeholder="Filed by mistake" />
                      </Field>
                    </ActionForm>
                  </Disclosure>
                </>
              ) : dependencies.length > 0 ? (
                <p className="text-[12px] text-ink-muted">
                  It cannot be archived yet: {dependencies.map((d) => d.detail).join(' ')}
                </p>
              ) : (
                <Disclosure summary="Archive — out of the working lists, reversible">
                  <ActionForm action={archiveDocumentAction} submit="Archive" variant="secondary" extra={{ documentId: doc.id }}>
                    <Field label="Why">
                      <Input name="reason" required placeholder="Filed by mistake" />
                    </Field>
                  </ActionForm>
                </Disclosure>
              )}
            </div>
          </Panel>

          <Panel title="History">
            {audit.length === 0 ? <Empty title="Nothing recorded" /> : (
              <table className="ledger">
                <tbody>
                  {audit.map((event) => (
                    <tr key={event.id}>
                      <td className="w-32 num !text-left text-ink-faint">{dateTime(event.occurredAt)}</td>
                      <td>
                        <Badge tone="neutral">{label(event.action)}</Badge>
                        <span className="text-ink-muted ml-1.5">by {event.actor}</span>
                        {event.reason && (
                          <div className="text-[11.5px] text-ink-muted mt-0.5">{event.reason}</div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
      </div>
    </Page>
  );
}
