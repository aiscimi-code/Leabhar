import Link from 'next/link';
import { vatPeriodList, companyContext } from '@/lib/queries';
import { Page, Panel, Badge, Figure, Help, Empty } from '@/components/primitives';
import { money, date, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** VAT periods (README §8, §23). */
export default function VatPeriodsPage() {
  const periods = vatPeriodList();
  const { company } = companyContext();

  return (
    <Page
      title="VAT periods"
      subtitle={
        <span>
          {company.legalName} files on the{' '}
          <strong>{label(company.vatAccountingBasis)}</strong>
          <Help>
            On the cash receipts basis, VAT on your sales arises when you are paid rather
            than when you invoice, so an invoice issued in one period and paid in the next
            belongs to the later period. VAT on your purchases is reclaimed by reference to
            the supplier&rsquo;s invoice date under either basis.
          </Help>
          {' '}at {label(company.vatPeriodFrequency)} intervals.
        </span>
      }
    >
      <Panel>
        {periods.length === 0 ? (
          <Empty title="No VAT periods configured" detail="Set them up in company settings." />
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th>Period</th>
                <th className="w-28">From</th>
                <th className="w-28">To</th>
                <th className="w-28">Filing deadline</th>
                <th className="w-24 text-right">Entries</th>
                <th className="w-32 text-right">Net position</th>
                <th className="w-28">Status</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((period) => (
                <tr key={period.periodId}>
                  <td>
                    <Link href={`/vat/${period.periodId}`}
                      className="text-accent hover:underline font-medium">
                      {period.name}
                    </Link>
                  </td>
                  <td className="num !text-left">{date(period.startDate)}</td>
                  <td className="num !text-left">{date(period.endDate)}</td>
                  <td className="num !text-left text-ink-muted">
                    {date((period as unknown as { filingDeadline?: string }).filingDeadline ?? null)}
                  </td>
                  <td className="text-right num">{period.entryCount}</td>
                  <td className="text-right">
                    <Figure
                      value={period.netPositionMinor === 0 ? money(0, company.baseCurrency)
                        : money(Math.abs(period.netPositionMinor), company.baseCurrency)}
                      href={`/vat/${period.periodId}`}
                      title={period.netPositionMinor >= 0
                        ? 'Payable to Revenue' : 'Repayable to you'}
                    />
                    <span className="text-[11px] text-ink-faint ml-1">
                      {period.entryCount === 0 ? '' : period.netPositionMinor >= 0 ? 'payable' : 'repayable'}
                    </span>
                  </td>
                  <td>
                    <Badge tone={period.status === 'submitted' ? 'positive'
                      : period.status === 'locked' || period.status === 'ready' ? 'accent'
                      : 'neutral'}>
                      {label(period.status)}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </Page>
  );
}
