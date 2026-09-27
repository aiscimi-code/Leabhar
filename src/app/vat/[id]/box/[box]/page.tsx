import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/db';
import { requireCompany, vatPeriodDetail } from '@/lib/queries';
import { drillIntoBox } from '@/domain/vat/report';
import { Page, Panel, Badge, Empty, LinkButton } from '@/components/primitives';
import { money, date, rate, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Drill-down from a VAT3 box to its entries (README §23, §43, §53).
 *
 * This is the middle of the chain the product principle demands: the box
 * figure, the entries behind it, and from each entry a link to the transaction
 * and then to the original document.
 */
export default async function VatBoxPage({ params }: {
  params: Promise<{ id: string; box: string }>;
}) {
  const { id, box } = await params;
  const detail = vatPeriodDetail(id);
  if (!detail) notFound();

  const company = requireCompany();
  const rows = drillIntoBox(getDb(), {
    companyId: company.id, vatPeriodId: id, box,
  });

  const figure = (detail.report as unknown as Record<string, { amountMinor: number; label: string }>)[box];
  const currency = company.baseCurrency;

  const isVatBox = box === 'T1' || box === 'T2' || box === 'T3' || box === 'T4';
  const total = box === 'T2'
    ? rows.reduce((s, r) => s + r.baseRecoverableVatMinor, 0)
    : isVatBox
      ? rows.reduce((s, r) => s + r.baseVatMinor, 0)
      : rows.reduce((s, r) => s + r.baseNetMinor, 0);

  return (
    <Page
      title={`${box} — ${figure?.label ?? box}`}
      subtitle={
        <span>
          {detail.period.name} · {rows.length} {rows.length === 1 ? 'entry' : 'entries'} ·{' '}
          totalling <strong className="num">{money(figure?.amountMinor ?? 0, currency)}</strong>
        </span>
      }
      actions={<LinkButton href={`/vat/${id}`}>Back to period</LinkButton>}
    >
      <Panel
        title="Why this number"
        description={box === 'T2'
          ? 'These are the entries behind the figure. T2 sums what is reclaimable, not what was charged — where a treatment restricts recovery, the difference is a real cost and is excluded. Each row carries the whole chain behind it: the journal entry, the invoice, the bank line, the rule that classified it and the source the treatment rests on.'
          : box === 'T3' || box === 'T4'
            ? 'This box is derived from T1 less T2, so everything behind both is listed here. Each row carries the whole chain behind it: the journal entry, the invoice, the bank line, the rule that classified it and the source the treatment rests on.'
            : 'These are the entries behind the figure. Each row carries the whole chain: the journal entry that posted it, the invoice or bank line it arose from, the rule that classified that line — and the source the VAT treatment rests on.'}
      >
        {rows.length === 0 ? (
          <Empty title="No entries in this box for this period" />
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th className="w-24">Tax point</th>
                <th className="w-16">Journal</th>
                <th>Counterparty</th>
                <th>VAT treatment</th>
                <th className="w-16">Dir</th>
                <th className="w-16 text-right">Rate</th>
                <th className="w-28 text-right">Net</th>
                <th className="w-28 text-right">VAT</th>
                {box === 'T2' && <th className="w-28 text-right">Reclaimable</th>}
                <th>Classified by</th>
                <th className="w-24">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.entryId}>
                  <td className="num !text-left">{date(row.taxPointDate)}</td>
                  <td className="num !text-left" title={row.journalNarrative ?? undefined}>
                    {row.journalEntryId ? `#${row.journalEntryNumber ?? '—'}` : '—'}
                  </td>
                  <td>
                    {row.bankTransactionId ? (
                      <Link href={`/transactions/${row.bankTransactionId}`}
                        className="text-accent hover:underline">
                        {row.counterpartyName ?? 'View transaction'}
                      </Link>
                    ) : (
                      <span>{row.counterpartyName ?? '—'}</span>
                    )}
                    {row.isReverseChargeLeg && (
                      <Badge tone="accent">Reverse charge</Badge>
                    )}
                  </td>
                  <td title={row.treatmentCode}>{row.treatmentName}</td>
                  <td className="text-ink-muted">{row.direction === 'sales' ? 'Out' : 'In'}</td>
                  <td className="text-right num">{rate(row.rateBasisPoints)}</td>
                  <td className="text-right num">{money(row.baseNetMinor, currency)}</td>
                  <td className="text-right num">{money(row.baseVatMinor, currency)}</td>
                  {box === 'T2' && (
                    <td className="text-right num">
                      {money(row.baseRecoverableVatMinor, currency)}
                      {row.baseRecoverableVatMinor !== row.baseVatMinor && (
                        <div className="text-[10.5px] text-caution">restricted</div>
                      )}
                    </td>
                  )}
                  <td>
                    {row.ruleId ? (
                      <Link href="/rules"
                        className="text-accent hover:underline" title={row.treatmentSourceNote ?? undefined}>
                        {row.ruleName}
                      </Link>
                    ) : (
                      <span className="text-ink-faint" title={row.treatmentSourceNote ?? undefined}>
                        No rule
                      </span>
                    )}
                    {row.treatmentSourceNote && (
                      <div className="text-[10.5px] text-ink-faint" title={row.treatmentSourceNote}>
                        {row.treatmentSourceDate ? `Source as at ${date(row.treatmentSourceDate)}` : 'Recorded source'}
                      </div>
                    )}
                  </td>
                  <td>
                    {row.invoiceId && (
                      <Link href={`/invoices/${row.invoiceId}`} className="mr-1.5">
                        <Badge tone="accent">Invoice</Badge>
                      </Link>
                    )}
                    {row.documentId ? (
                      <Link href={`/documents/${row.documentId}`}>
                        <Badge tone="positive">Document</Badge>
                      </Link>
                    ) : (
                      <Badge tone="caution">None</Badge>
                    )}
                  </td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td colSpan={box === 'T2' ? 8 : 7}>Total in this box</td>
                <td className="text-right num">
                  {money(total, currency)}
                </td>
                <td colSpan={2} />
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
    </Page>
  );
}
