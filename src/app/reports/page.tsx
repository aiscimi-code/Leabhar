import Link from 'next/link';
import { reportsData, companyContext } from '@/lib/queries';
import { Page, Panel, Figure, Help, LinkButton, Badge } from '@/components/primitives';
import { accountingMoney, money, date } from '@/lib/format';
import { asIsoDate } from '@/domain/dates';
import type { Explained } from '@/domain/reports/explain';

export const dynamic = 'force-dynamic';

/**
 * Profit and loss, and balance sheet (README §33, §37).
 *
 * Every line is drillable to the account behind it, and from there to the
 * journal lines and their source documents.
 */
export default async function ReportsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const { currentYear, financialYears, company } = companyContext();

  const from = asIsoDate(params['from'] ?? currentYear?.startDate ?? '2025-01-01');
  const to = asIsoDate(params['to'] ?? currentYear?.endDate ?? '2025-12-31');
  const data = reportsData(from, to, from);
  const currency = company.baseCurrency;

  return (
    <Page
      title="Financial statements"
      subtitle={`${date(from)} to ${date(to)}`}
      actions={
        <>
          <a href={`/api/export/report?which=all&format=xlsx&from=${from}&to=${to}`}
            className="inline-block px-2.5 py-1 rounded border border-accent bg-accent
              text-white text-[12px] font-medium">
            Export XLSX
          </a>
          <a href={`/api/export/report?which=profit-and-loss&format=csv&from=${from}&to=${to}`}
            className="inline-block px-2.5 py-1 rounded border border-line-strong
              bg-surface text-[12px] font-medium">
            P&amp;L CSV
          </a>
          <LinkButton href="/reports/trial-balance">Trial balance</LinkButton>
          <LinkButton href="/reports/year-end">Year-end pack</LinkButton>
        </>
      }
    >
      <Panel>
        <form method="get" className="flex items-end gap-2 px-4 py-2.5">
          <div>
            <label className="block text-[10px] uppercase tracking-wide font-semibold text-ink-faint mb-0.5">
              Financial year
            </label>
            <select
              name="year"
              defaultValue={currentYear?.id ?? ''}
              className="border border-line-strong rounded px-2 py-1 text-[12px]"
            >
              {financialYears.map((year) => (
                <option key={year.id} value={year.id}>{year.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide font-semibold text-ink-faint mb-0.5">
              From
            </label>
            <input type="date" name="from" defaultValue={from}
              className="border border-line-strong rounded px-2 py-1 text-[12px]" />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide font-semibold text-ink-faint mb-0.5">
              To
            </label>
            <input type="date" name="to" defaultValue={to}
              className="border border-line-strong rounded px-2 py-1 text-[12px]" />
          </div>
          <button type="submit"
            className="px-2.5 py-1 rounded border border-accent bg-accent text-white text-[12px] font-medium">
            Apply
          </button>
        </form>
      </Panel>

      <div className="grid grid-cols-2 gap-4 items-start">
        <Panel title="Profit and loss" description={`${date(from)} to ${date(to)}`}>
          <table className="ledger">
            <tbody>
              <SectionRow figure={data.profitAndLoss.revenue} currency={currency} to={to} />
              <SectionRow figure={data.profitAndLoss.costOfSales} currency={currency} to={to} negate />
              <TotalRow label="Gross profit" figure={data.profitAndLoss.grossProfit} currency={currency} />
              <SectionRow figure={data.profitAndLoss.operatingExpenses} currency={currency} to={to} negate />
              <TotalRow label="Operating profit" figure={data.profitAndLoss.operatingProfit} currency={currency} />
              {data.profitAndLoss.otherIncome.components.length > 0 && (
                <SectionRow figure={data.profitAndLoss.otherIncome} currency={currency} to={to} />
              )}
              <TotalRow label="Net profit" figure={data.profitAndLoss.netProfit} currency={currency} strong />
            </tbody>
          </table>
          <p className="px-4 py-2.5 text-[11.5px] text-ink-muted border-t border-line leading-snug">
            This is accounting profit. Taxable profit is a different figure: depreciation is
            added back, capital allowances are deducted, and some costs are not allowable.
            The year-end pack shows that bridge line by line.
          </p>
        </Panel>

        <Panel
          title="Balance sheet"
          description={`As at ${date(to)}`}
          tone={data.balanceSheet.balances ? 'default' : 'negative'}
        >
          <table className="ledger">
            <tbody>
              <SectionRow figure={data.balanceSheet.fixedAssets} currency={currency} to={to} />
              <SectionRow figure={data.balanceSheet.currentAssets} currency={currency} to={to} />
              <TotalRow label="Total assets" figure={data.balanceSheet.totalAssets} currency={currency} />
              <SectionRow figure={data.balanceSheet.currentLiabilities} currency={currency} to={to} />
              <TotalRow label="Net assets" figure={data.balanceSheet.netAssets} currency={currency} strong />

              <tr><td colSpan={2} className="pt-3 font-semibold text-ink">Financed by</td></tr>
              <SectionRow figure={data.balanceSheet.shareCapital} currency={currency} to={to} />
              <SectionRow figure={data.balanceSheet.retainedEarnings} currency={currency} to={to} />
              <tr>
                <td className="pl-4">
                  Profit for the period
                  <Help>
                    Profit earned since the start of this financial year. It sits in the income
                    and expense accounts until it is transferred to reserves at year end, which
                    is why it is shown separately here.
                  </Help>
                </td>
                <td className="text-right num">
                  {accountingMoney(data.balanceSheet.profitForPeriod.valueMinor, currency)}
                </td>
              </tr>
              <TotalRow label="Total equity" figure={data.balanceSheet.totalEquity} currency={currency} strong />
            </tbody>
          </table>

          {data.balanceSheet.balances ? (
            <div className="px-4 py-2 border-t border-line text-[12px] text-positive">
              ✓ Net assets equal total equity. The balance sheet balances.
            </div>
          ) : (
            <div className="px-4 py-2.5 bg-negative-soft border-t border-negative/30 text-negative text-[12px]">
              <strong>The balance sheet does not balance.</strong> Net assets and total equity
              differ by {money(data.balanceSheet.differenceMinor, currency)}. This is a defect
              in the underlying entries, not a rounding artefact — do not rely on these figures
              until it is found.
            </div>
          )}

          {data.balanceSheet.retainedEarnings.notes.map((note, index) => (
            <div key={index} className="px-4 py-2 bg-caution-soft border-t border-caution/30 text-caution text-[12px]">
              {note}
            </div>
          ))}
        </Panel>
      </div>
    </Page>
  );
}

function SectionRow({ figure, currency, to, negate }: {
  figure: Explained; currency: string; to: string; negate?: boolean;
}) {
  return (
    <>
      <tr>
        <td className="font-medium text-ink pt-2.5">{figure.label}</td>
        <td className="text-right num font-medium pt-2.5">
          {accountingMoney(negate ? -figure.valueMinor : figure.valueMinor, currency)}
        </td>
      </tr>
      {figure.components.map((component) => {
        const accountId = component.sources[0]?.entityId;
        return (
          <tr key={component.label}>
            <td className="pl-5 text-ink-muted">
              {accountId ? (
                <Link href={`/reports/account/${accountId}?to=${to}`}
                  className="hover:underline text-ink-muted hover:text-accent">
                  {component.label}
                </Link>
              ) : component.label}
            </td>
            <td className="text-right">
              <Figure
                value={accountingMoney(component.valueMinor, currency)}
                href={accountId ? `/reports/account/${accountId}?to=${to}` : undefined}
                title={component.method}
              />
            </td>
          </tr>
        );
      })}
    </>
  );
}

function TotalRow({ label, figure, currency, strong }: {
  label: string; figure: Explained; currency: string; strong?: boolean;
}) {
  return (
    <tr className={strong ? 'font-semibold' : 'font-medium'}>
      <td className="border-t border-line-strong pt-2">
        {label}
        <Help>{figure.method}</Help>
      </td>
      <td className="text-right num border-t border-line-strong pt-2">
        {accountingMoney(figure.valueMinor, currency)}
      </td>
    </tr>
  );
}
