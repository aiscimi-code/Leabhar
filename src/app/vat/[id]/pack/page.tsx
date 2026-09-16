import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { buildFilingPack } from '@/domain/vat/filingPack';
import { Page, Panel, Badge, Empty, LinkButton } from '@/components/primitives';
import { money, date, dateTime, label, rate } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * VAT filing pack (README §25).
 *
 * Designed to be printed or exported and kept. It states the basis it was
 * prepared on, lists every transaction behind every figure, and names what is
 * missing — because a pack that shows only the totals cannot be checked by
 * anyone, including the person who produced it.
 */
export default async function FilingPackPage({ params }: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const company = requireCompany();

  let pack;
  try {
    pack = buildFilingPack(getDb(), { companyId: company.id, vatPeriodId: id });
  } catch {
    notFound();
  }

  const currency = pack.currency;

  return (
    <Page
      title={`VAT filing pack — ${pack.periodName}`}
      subtitle={
        <span>
          {pack.companyName}
          {pack.vatNumber && <> · VAT {pack.vatNumber}</>}
          {' · '}{date(pack.startDate)} to {date(pack.endDate)}
          {pack.filingDeadline && <> · deadline {date(pack.filingDeadline)}</>}
        </span>
      }
      actions={
        <>
          <a href={`/api/export/vat/${id}?format=xlsx`}
            className="inline-block px-2.5 py-1 rounded border border-accent bg-accent
              text-white text-[12px] font-medium">
            Export XLSX
          </a>
          <a href={`/api/export/vat/${id}?format=csv`}
            className="inline-block px-2.5 py-1 rounded border border-line-strong
              bg-surface text-[12px] font-medium">
            Export CSV
          </a>
          <LinkButton href={`/vat/${id}`}>Back to period</LinkButton>
        </>
      }
    >
      <Panel tone={pack.validation.ready ? 'positive' : 'negative'}
        title={pack.validation.verdict}
        description={pack.validation.summary}>
        <p className="px-4 py-2.5 text-[11.5px] text-ink-muted leading-snug border-t border-line">
          {pack.disclaimer}
        </p>
      </Panel>

      <Panel title="Basis of preparation">
        <div className="px-4 py-3 text-ink-muted max-w-4xl leading-relaxed">
          <p className="mb-2">
            <strong className="text-ink">{label(pack.vatBasis)}.</strong> {pack.basisNote}
          </p>
          <p className="text-[11.5px] text-ink-faint">
            Prepared {dateTime(pack.preparedAt)}. Period status: {label(pack.status)}.
          </p>
        </div>
      </Panel>

      <Panel title="VAT3 summary">
        <table className="ledger">
          <thead>
            <tr>
              <th className="w-16">Box</th>
              <th>Description</th>
              <th className="w-20 text-right">Entries</th>
              <th className="w-36 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {[pack.report.T1, pack.report.T2, pack.report.T3, pack.report.T4].map((box) => (
              <tr key={box.box} className={box.box === 'T3' || box.box === 'T4' ? 'font-semibold' : ''}>
                <td><Badge tone="accent">{box.box}</Badge></td>
                <td>{box.label}</td>
                <td className="text-right num text-ink-muted">
                  {box.box === 'T3' || box.box === 'T4' ? '' : box.entryCount}
                </td>
                <td className="text-right num">{money(box.amountMinor, currency)}</td>
              </tr>
            ))}
            {[pack.report.E1, pack.report.E2, pack.report.ES1, pack.report.ES2, pack.report.PA1]
              .filter((box) => box.entryCount > 0)
              .map((box) => (
                <tr key={box.box}>
                  <td><Badge tone="neutral">{box.box}</Badge></td>
                  <td>{box.label}</td>
                  <td className="text-right num text-ink-muted">{box.entryCount}</td>
                  <td className="text-right num">{money(box.amountMinor, currency)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </Panel>

      {pack.sections.map((section) => (
        <Panel key={section.box}
          title={`${section.box} — ${section.label}`}
          description={`${section.rows.length} ${section.rows.length === 1 ? 'entry' : 'entries'} totalling ${money(section.amountMinor, currency)}`}>
          <table className="ledger">
            <thead>
              <tr>
                <th className="w-24">Tax point</th>
                <th>Counterparty</th>
                <th>Treatment</th>
                <th className="w-16 text-right">Rate</th>
                <th className="w-28 text-right">Net</th>
                <th className="w-28 text-right">VAT</th>
                <th className="w-24">Document</th>
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row) => (
                <tr key={`${section.box}-${row.entryId}`}>
                  <td className="num !text-left">{date(row.taxPointDate)}</td>
                  <td>
                    {row.bankTransactionId ? (
                      <Link href={`/transactions/${row.bankTransactionId}`}
                        className="text-accent hover:underline">
                        {row.counterpartyName ?? 'Transaction'}
                      </Link>
                    ) : (row.counterpartyName ?? '—')}
                  </td>
                  <td>
                    {row.treatmentName}
                    {row.isReverseChargeLeg && <Badge tone="accent">RC</Badge>}
                  </td>
                  <td className="text-right num">{rate(row.rateBasisPoints)}</td>
                  <td className="text-right num">{money(row.baseNetMinor, currency)}</td>
                  <td className="text-right num">
                    {money(section.box === 'T2' ? row.baseRecoverableVatMinor : row.baseVatMinor, currency)}
                  </td>
                  <td>
                    {row.documentId ? (
                      <Link href={`/documents/${row.documentId}`}>
                        <Badge tone="positive">Attached</Badge>
                      </Link>
                    ) : <Badge tone="caution">None</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ))}

      <Panel
        title="Exceptions"
        description="What this pack does not cover, stated rather than omitted."
        tone={pack.validation.findings.length > 0 ? 'warning' : 'default'}
      >
        {pack.validation.findings.length === 0 ? (
          <Empty title="No exceptions raised" />
        ) : (
          <table className="ledger">
            <tbody>
              {pack.validation.findings.map((finding) => (
                <tr key={finding.code}>
                  <td className="w-28">
                    <Badge tone={finding.severity === 'blocking' ? 'negative'
                      : finding.severity === 'warning' ? 'caution' : 'neutral'}>
                      {label(finding.severity)}
                    </Badge>
                  </td>
                  <td>
                    <div className="font-medium text-ink">{finding.title}</div>
                    <div className="text-ink-muted mt-0.5">{finding.detail}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <div className="grid grid-cols-2 gap-4 items-start">
        <Panel
          title={`Supporting documents (${pack.documentsSupporting.length})`}
          description="With hashes, so the evidence can be verified as the evidence that was classified."
        >
          {pack.documentsSupporting.length === 0 ? (
            <Empty title="No documents attached to this period" />
          ) : (
            <table className="ledger">
              <thead>
                <tr><th>File</th><th className="w-24">Date</th><th className="w-28 text-right">Total</th></tr>
              </thead>
              <tbody>
                {pack.documentsSupporting.map((document) => (
                  <tr key={document.id}>
                    <td>
                      <Link href={`/documents/${document.id}`} className="text-accent hover:underline">
                        {document.filename}
                      </Link>
                      <div className="text-[10.5px] text-ink-faint num !text-left">
                        {document.sha256.slice(0, 24)}…
                      </div>
                    </td>
                    <td className="num !text-left">{date(document.documentDate)}</td>
                    <td className="text-right num">{money(document.grossMinor, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          title={`Without a document (${pack.transactionsWithoutDocument.length})`}
          tone={pack.transactionsWithoutDocument.length > 0 ? 'warning' : 'default'}
          description="VAT reclaimed without a supporting invoice can be disallowed on audit."
        >
          {pack.transactionsWithoutDocument.length === 0 ? (
            <Empty title="Every transaction has supporting evidence" />
          ) : (
            <table className="ledger">
              <tbody>
                {pack.transactionsWithoutDocument.map((transaction) => (
                  <tr key={transaction.id}>
                    <td className="w-24 num !text-left">{date(transaction.date)}</td>
                    <td>
                      <Link href={`/transactions/${transaction.id}`}
                        className="text-accent hover:underline">
                        {transaction.description}
                      </Link>
                    </td>
                    <td className="w-28 text-right num">
                      {money(transaction.amountMinor, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <Panel
        title="Bank reconciliation at the period end"
        description="Whether the bank and the books agreed when these figures were prepared."
      >
        <table className="ledger">
          <thead>
            <tr>
              <th>Account</th>
              <th className="w-32 text-right">Per statement</th>
              <th className="w-32 text-right">Per books</th>
              <th className="w-28">Status</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {pack.reconciliation.map((row) => (
              <tr key={row.bankAccountName}>
                <td>{row.bankAccountName}</td>
                <td className="text-right num">{money(row.statementBalanceMinor, currency)}</td>
                <td className="text-right num">{money(row.ledgerBalanceMinor, currency)}</td>
                <td>
                  <Badge tone={row.reconciled ? 'positive' : 'negative'}>
                    {row.reconciled ? 'Reconciled' : 'Difference'}
                  </Badge>
                </td>
                <td className="text-ink-muted text-[11.5px]">{row.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </Page>
  );
}
