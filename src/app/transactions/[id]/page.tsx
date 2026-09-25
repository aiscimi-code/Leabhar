import Link from 'next/link';
import { notFound } from 'next/navigation';
import { transactionDetail, unmatchedDocumentOptions } from '@/lib/queries';
import {
  Page, Panel, Badge, ProvenanceBadge, Help, Figure, LinkButton, Empty,
} from '@/components/primitives';
import { StatusBadge } from '@/components/StatusBadge';
import { money, date, dateTime, label, rate, percent } from '@/lib/format';
import { ClassifyForm } from '@/components/ClassifyForm';
import { LinkControls } from '@/components/LinkControls';
import { CandidateActions } from '@/components/CandidateActions';
import { linkDocumentAction, unmatchDocumentAction, acceptMatchAction, rejectMatchAction } from '@/app/actions';
import { chartOfAccounts, treatmentsWithRates, statutoryVatSuggestion } from '@/lib/queries';
import { StatutorySuggestion } from '@/components/StatutorySuggestion';
import { asIsoDate } from '@/domain/dates';

export const dynamic = 'force-dynamic';

/**
 * Transaction detail (README §15).
 *
 * Shows the bank evidence, the accounting classification, the VAT treatment,
 * the supporting document, the matching information, the journal entries, the
 * AI decisions, the user confirmations and the audit history — the full list
 * README §15 asks for, on one screen, because the point of the screen is that
 * the user can see the whole chain without navigating.
 */
export default async function TransactionDetailPage({ params }: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = transactionDetail(id);
  if (!detail) notFound();

  const {
    transaction: t, account, treatment, supplier, customer, entry, lines,
    vatEntries, matchedDocument, candidates, audit, bankAccount, statementImport, company,
  } = detail;

  const accounts = chartOfAccounts().filter((a) => a.active);
  // Rates are resolved server-side, as of this transaction's date, from the
  // rate configuration rather than from anything hard-coded.
  const treatments = treatmentsWithRates(asIsoDate(t.transactionDate));
  const linkableDocuments = unmatchedDocumentOptions();
  const vatSuggestion = statutoryVatSuggestion(t.id);

  return (
    <Page
      title={t.description}
      subtitle={
        <span>
          {date(t.transactionDate)} · {money(t.amountMinor, t.currency)} ·{' '}
          {bankAccount?.bankName} {bankAccount?.accountName}
        </span>
      }
      actions={<LinkButton href="/transactions">Back to ledger</LinkButton>}
    >
      <div className="grid grid-cols-[1.4fr_1fr] gap-4 items-start">
        <div>
          <Panel
            title="Bank transaction"
            description="Imported evidence that money moved. These values are never altered."
          >
            <table className="ledger">
              <tbody>
                <Row label="Date">{date(t.transactionDate)}</Row>
                {t.valueDate && <Row label="Value date">{date(t.valueDate)}</Row>}
                <Row label="Description">{t.description}</Row>
                <Row label="Amount">
                  <span className={`num !text-left ${t.amountMinor < 0 ? 'num-negative' : ''}`}>
                    {money(t.amountMinor, t.currency)}
                  </span>
                  <span className="text-ink-faint ml-2">
                    {t.amountMinor < 0 ? 'money out' : 'money in'}
                  </span>
                </Row>
                <Row label="Currency">{t.currency}</Row>
                {t.baseAmountMinor !== null && t.baseCurrency !== t.currency && (
                  <Row
                    label={`In ${t.baseCurrency}`}
                    help="The original amount is never replaced by its conversion. Both are kept, along with the rate used and where it came from."
                  >
                    <span className="num !text-left">{money(t.baseAmountMinor, t.baseCurrency ?? 'EUR')}</span>
                    {t.fxRateNumerator && t.fxRateDenominator && (
                      <span className="text-ink-faint ml-2">
                        at {(t.fxRateNumerator / t.fxRateDenominator).toFixed(6)}
                        {t.fxRateSource ? ` (${t.fxRateSource})` : ''}
                      </span>
                    )}
                  </Row>
                )}
                {t.balanceAfterMinor !== null && (
                  <Row label="Balance after">
                    <span className="num !text-left">{money(t.balanceAfterMinor, t.currency)}</span>
                  </Row>
                )}
                {t.bankReference && <Row label="Bank reference">{t.bankReference}</Row>}
                {t.bankTransactionId && <Row label="Bank transaction ID">{t.bankTransactionId}</Row>}
                {t.counterpartyName && <Row label="Counterparty">{t.counterpartyName}</Row>}
                <Row
                  label="Fingerprint"
                  help="A deterministic hash of this transaction's identifying details. It is what stops the same statement being imported twice while still allowing two genuinely identical charges on the same day."
                >
                  <span className="num !text-left text-ink-faint">
                    {t.fingerprint}{t.occurrenceIndex > 0 ? ` #${t.occurrenceIndex + 1}` : ''}
                  </span>
                </Row>
                {statementImport && (
                  <Row label="Imported from">
                    {statementImport.filename}
                    <span className="text-ink-faint ml-2">{dateTime(statementImport.createdAt)}</span>
                  </Row>
                )}
              </tbody>
            </table>
          </Panel>

          {vatSuggestion && <StatutorySuggestion suggestion={vatSuggestion} />}

          <Panel
            title="Accounting classification"
            description={t.journalEntryId
              ? 'Posted. Changing it reverses the original entry and posts a new one, so both remain in the audit trail.'
              : 'Not yet posted to the ledger.'}
          >
            <div className="px-4 py-3">
              <ClassifyForm
                transactionId={t.id}
                accounts={accounts.map((a) => ({
                  id: a.id, code: a.code, name: a.name, type: a.type,
                  defaultVatTreatmentId: a.defaultVatTreatmentId,
                }))}
                treatments={treatments}
                currentAccountId={t.accountId}
                currentTreatmentId={t.vatTreatmentId}
                isPosted={Boolean(t.journalEntryId)}
                amountMinor={t.amountMinor}
                currency={t.currency}
                baseCurrency={company.baseCurrency}
                baseAmountMinor={t.baseAmountMinor}
                fxRateSource={t.fxRateSource}
                fxRateNumerator={t.fxRateNumerator}
                fxRateDenominator={t.fxRateDenominator}
                suggestedTreatmentId={vatSuggestion?.status === 'suggested' ? vatSuggestion.treatment?.id : null}
              />
            </div>
          </Panel>

          {entry && (
            <Panel
              title={`Journal entry #${entry.entryNumber}`}
              description={entry.narrative}
            >
              <table className="ledger">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Memo</th>
                    <th className="text-right w-28">Debit</th>
                    <th className="text-right w-28">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map(({ line, accountCode, accountName }) => (
                    <tr key={line.id}>
                      <td>
                        <span className="num !text-left text-ink-faint mr-1.5">{accountCode}</span>
                        {accountName}
                      </td>
                      <td className="text-ink-muted">{line.memo}</td>
                      <td className="text-right num">
                        {line.baseDebitMinor ? money(line.baseDebitMinor, line.baseCurrency) : ''}
                      </td>
                      <td className="text-right num">
                        {line.baseCreditMinor ? money(line.baseCreditMinor, line.baseCurrency) : ''}
                      </td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td colSpan={2}>Total</td>
                    <td className="text-right num">
                      {money(lines.reduce((s, l) => s + l.line.baseDebitMinor, 0), company.baseCurrency)}
                    </td>
                    <td className="text-right num">
                      {money(lines.reduce((s, l) => s + l.line.baseCreditMinor, 0), company.baseCurrency)}
                    </td>
                  </tr>
                </tbody>
              </table>
              {entry.reversedByEntryId && (
                <div className="px-4 py-2 bg-caution-soft border-t border-caution/30 text-caution text-[12px]">
                  This entry was reversed. Reason: {entry.reversalReason}
                </div>
              )}
            </Panel>
          )}

          {vatEntries.length > 0 && (
            <Panel
              title="VAT entries"
              description={vatEntries.length > 1
                ? 'This transaction produced more than one VAT entry, which is what a reverse charge does: you account for the VAT as output and reclaim it as input.'
                : undefined}
            >
              <table className="ledger">
                <thead>
                  <tr>
                    <th>Direction</th><th>Treatment</th><th className="w-16">Box</th>
                    <th className="w-20 text-right">Rate</th>
                    <th className="text-right">Net</th>
                    <th className="text-right">VAT</th>
                    <th className="text-right">Reclaimable</th>
                    <th className="w-24">Tax point</th>
                  </tr>
                </thead>
                <tbody>
                  {vatEntries.map((row) => {
                    const v = row as Record<string, string | number>;
                    return (
                      <tr key={String(v['id'])}>
                        <td>{label(String(v['direction']))}</td>
                        <td>{String(row['treatmentName'])}</td>
                        <td><Badge tone="accent">{String(v['vat_box'] ?? '—')}</Badge></td>
                        <td className="text-right num">{rate(Number(v['rate_basis_points']))}</td>
                        <td className="text-right num">{money(Number(v['base_net_minor']), company.baseCurrency)}</td>
                        <td className="text-right num">{money(Number(v['base_vat_minor']), company.baseCurrency)}</td>
                        <td className="text-right num">{money(Number(v['base_recoverable_vat_minor']), company.baseCurrency)}</td>
                        <td className="num !text-left">{date(String(v['tax_point_date']))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Panel>
          )}
        </div>

        <div>
          <Panel title="Status">
            <table className="ledger">
              <tbody>
                <Row label="Status"><StatusBadge status={t.status} /></Row>
                <Row
                  label="Where this came from"
                  help="Whether this classification was your decision, a rule you wrote, an AI suggestion, or imported. An AI suggestion you have not confirmed is excluded from a VAT return."
                >
                  <ProvenanceBadge
                    status={t.provenanceStatus} confidence={t.confidence} source={t.source}
                  />
                </Row>
                {account && (
                  <Row label="Account">
                    <Link href={`/reports/account/${account.id}`} className="text-accent hover:underline">
                      {account.code} {account.name}
                    </Link>
                  </Row>
                )}
                {treatment && (
                  <Row label="VAT treatment" help={treatment.description ?? undefined}>
                    {treatment.name}
                  </Row>
                )}
                {supplier && (
                  <Row label="Supplier">
                    <Link href={`/suppliers/${supplier.id}`} className="text-accent hover:underline">
                      {supplier.name}
                    </Link>
                    {supplier.countryCode && (
                      <span className="text-ink-faint ml-1.5">{supplier.countryCode}</span>
                    )}
                  </Row>
                )}
                {customer && <Row label="Customer">{customer.name}</Row>}
                {t.appliedRuleId && (
                  <Row label="Applied rule">
                    <Link href="/rules" className="text-accent hover:underline">View rule</Link>
                  </Row>
                )}
              </tbody>
            </table>
          </Panel>

          <Panel
            title="Supporting document"
            description={matchedDocument ? undefined : 'No invoice or receipt attached.'}
          >
            {matchedDocument ? (
              <>
                <table className="ledger">
                  <tbody>
                    <Row label="Document">
                      <Link href={`/documents/${matchedDocument.id}`} className="text-accent hover:underline">
                        {matchedDocument.originalFilename}
                      </Link>
                    </Row>
                    {matchedDocument.invoiceNumber && (
                      <Row label="Invoice number">{matchedDocument.invoiceNumber}</Row>
                    )}
                    {matchedDocument.documentDate && (
                      <Row label="Document date">{date(matchedDocument.documentDate)}</Row>
                    )}
                    {matchedDocument.grossMinor !== null && (
                      <Row label="Total on document">
                        <span className="num !text-left">
                          {money(matchedDocument.grossMinor, matchedDocument.currency ?? 'EUR')}
                        </span>
                      </Row>
                    )}
                  </tbody>
                </table>
                <div className="px-4 py-2.5 border-t border-line">
                  <LinkControls
                    action={unmatchDocumentAction}
                    options={[{ value: matchedDocument.id, label: matchedDocument.originalFilename }]}
                    extra={{ documentId: matchedDocument.id }}
                    selectName="documentId"
                    label="Unlink"
                    submit="Unlink document"
                  />
                </div>
              </>
            ) : (
              <>
                <Empty
                  title="No document"
                  detail="VAT reclaimed without a supporting invoice can be disallowed on audit."
                  action={<LinkButton href="/documents">Upload a document</LinkButton>}
                />
                <div className="px-4 py-2.5 border-t border-line">
                  <LinkControls
                    action={linkDocumentAction}
                    options={linkableDocuments}
                    extra={{ bankTransactionId: t.id }}
                    selectName="documentId"
                    label="Link a document"
                    submit="Link"
                    emptyHint="No unmatched documents available to link."
                  />
                </div>
              </>
            )}
          </Panel>

          {candidates.length > 0 && (
            <Panel
              title="Matching"
              description="Every candidate considered, with the reasoning behind each score."
            >
              {candidates.map(({ match, documentName }) => (
                <div key={match.id} className="px-4 py-2.5 border-b border-line last:border-0">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/documents/${match.documentId}`} className="text-accent hover:underline">
                      {documentName}
                    </Link>
                    <div className="flex items-center gap-1.5">
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
                  <ul className="mt-1.5 space-y-0.5">
                    {match.factors.map((factor, index) => (
                      <li key={index} className="text-[11.5px] text-ink-muted flex gap-2">
                        <span className={`w-10 shrink-0 num !text-left ${
                          factor.score >= 70 ? 'text-positive'
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
                      documentId={match.documentId}
                      bankTransactionId={match.bankTransactionId}
                    />
                  )}
                </div>
              ))}
            </Panel>
          )}

          <Panel
            title="Audit history"
            description="Every change to this transaction, in order."
          >
            {audit.length === 0 ? (
              <Empty title="Nothing recorded yet" />
            ) : (
              <table className="ledger">
                <tbody>
                  {audit.map((event) => (
                    <tr key={event.id}>
                      <td className="w-32 num !text-left text-ink-faint">
                        {dateTime(event.occurredAt)}
                      </td>
                      <td>
                        <div>
                          <Badge tone="neutral">{label(event.action)}</Badge>
                          <span className="text-ink-muted ml-1.5">by {event.actor}</span>
                        </div>
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

function Row({ label: rowLabel, help, children }: {
  label: string; help?: string; children: React.ReactNode;
}) {
  return (
    <tr>
      <td className="w-44 text-ink-faint align-top">
        {rowLabel}
        {help && <Help>{help}</Help>}
      </td>
      <td>{children}</td>
    </tr>
  );
}
