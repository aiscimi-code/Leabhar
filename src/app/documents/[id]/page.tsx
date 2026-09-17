import Link from 'next/link';
import { notFound } from 'next/navigation';
import { documentDetail, unpostedTransactionOptions } from '@/lib/queries';
import {
  Page, Panel, Badge, ProvenanceBadge, Help, Empty, LinkButton,
} from '@/components/primitives';
import { money, date, dateTime, label, percent } from '@/lib/format';
import { LinkControls } from '@/components/LinkControls';
import { CandidateActions } from '@/components/CandidateActions';
import { linkDocumentAction, unmatchDocumentAction, acceptMatchAction, rejectMatchAction } from '@/app/actions';

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
          audit, duplicateOf, company } = detail;
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

      <div className="grid grid-cols-[1.3fr_1fr] gap-4 items-start">
        <div>
          <Panel title="What was read from this document"
            description={latest
              ? `Read by the ${latest.provider} extractor${latest.model ? ` (${latest.model})` : ''}, `
                + `${percent(latest.overallConfidence)} overall confidence. Every value here is a `
                + 'suggestion until you confirm it.'
              : undefined}>
            {!latest ? (
              <Empty title="Not yet read" />
            ) : (
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
                  {Object.entries(latest.fields)
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
            )}
            {latest?.status === 'failed' && (
              <div className="px-4 py-2.5 bg-caution-soft border-t border-caution/30 text-caution">
                {latest.errorMessage ?? 'Nothing could be read from this file.'}
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
                </div>
              ))
            )}
          </Panel>
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
              <LinkControls
                action={linkDocumentAction}
                options={linkableTransactions}
                extra={{ documentId: doc.id }}
                selectName="bankTransactionId"
                label="Link a transaction"
                submit="Link"
                emptyHint="No unposted transactions available to link."
              />
            </Panel>
          )}

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
