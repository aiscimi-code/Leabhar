import Link from 'next/link';
import { reportsData, companyContext } from '@/lib/queries';
import { Page, Panel, Figure, Badge, Empty } from '@/components/primitives';
import { money, date, label } from '@/lib/format';
import { asIsoDate } from '@/domain/dates';

export const dynamic = 'force-dynamic';

/** Trial balance (README §37). The first thing an accountant looks at. */
export default async function TrialBalancePage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const { currentYear, company } = companyContext();
  const from = asIsoDate(params['from'] ?? currentYear?.startDate ?? '2025-01-01');
  const to = asIsoDate(params['to'] ?? currentYear?.endDate ?? '2025-12-31');
  const { trialBalance: tb } = reportsData(from, to, from);
  const currency = company.baseCurrency;

  return (
    <Page
      title="Trial balance"
      subtitle={`As at ${date(to)} · ${tb.rows.length} accounts with a balance`}
    >
      <Panel tone={tb.balanced ? 'default' : 'negative'}>
        {tb.rows.length === 0 ? (
          <Empty title="Nothing posted yet" />
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th className="w-20">Code</th>
                <th>Account</th>
                <th className="w-28">Type</th>
                <th className="w-20 text-right">Lines</th>
                <th className="w-32 text-right">Debit</th>
                <th className="w-32 text-right">Credit</th>
              </tr>
            </thead>
            <tbody>
              {tb.rows.map((row) => (
                <tr key={row.accountId}>
                  <td className="num !text-left">{row.code}</td>
                  <td>
                    <Link href={`/reports/account/${row.accountId}?to=${to}`}
                      className="text-accent hover:underline">
                      {row.name}
                    </Link>
                  </td>
                  <td className="text-ink-muted">{label(row.type)}</td>
                  <td className="text-right num text-ink-faint">{row.lineCount}</td>
                  <td className="text-right num">
                    {row.netDebitMinor > 0 ? money(row.netDebitMinor, currency) : ''}
                  </td>
                  <td className="text-right num">
                    {row.netDebitMinor < 0 ? money(-row.netDebitMinor, currency) : ''}
                  </td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td colSpan={4}>Totals</td>
                <td className="text-right num">
                  {money(tb.rows.reduce((s, r) => s + Math.max(r.netDebitMinor, 0), 0), currency)}
                </td>
                <td className="text-right num">
                  {money(tb.rows.reduce((s, r) => s + Math.max(-r.netDebitMinor, 0), 0), currency)}
                </td>
              </tr>
            </tbody>
          </table>
        )}

        <div className={`px-4 py-2 border-t text-[12px] ${
          tb.balanced ? 'border-line text-positive'
            : 'bg-negative-soft border-negative/30 text-negative'}`}>
          {tb.balanced
            ? `✓ Total debits equal total credits (${money(tb.totalDebitMinor, currency)} each).`
            : `Debits and credits differ by ${money(tb.differenceMinor, currency)}. `
              + 'There is an error in the underlying entries.'}
        </div>
      </Panel>
    </Page>
  );
}
