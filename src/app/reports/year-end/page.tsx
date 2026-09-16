import Link from 'next/link';
import { getDb } from '@/db';
import { reportsData, companyContext, fixedAssetList, deadlineList } from '@/lib/queries';
import { yearEndPack } from '@/domain/reports/yearEnd';
import { Page, Panel, Badge, Help, Figure, Empty, LinkButton } from '@/components/primitives';
import { accountingMoney, money, date, label, rate } from '@/lib/format';
import { asIsoDate } from '@/domain/dates';

export const dynamic = 'force-dynamic';

/**
 * Year-end summary and accountant pack (README §33, §34).
 *
 * The objective from §34 is to give an accountant a clean package of evidence
 * and figures. The corporation tax section is explicitly a worksheet, not a
 * calculation: README §33 says the accounting profit and the tax-adjusted
 * profit must be clearly distinguished, and that the final liability must not
 * be claimed as correct.
 */
export default async function YearEndPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const { currentYear, financialYears, company } = companyContext();
  const year = financialYears.find((y) => y.id === params['year']) ?? currentYear;
  if (!year) {
    return (
      <Page title="Year-end pack">
        <Panel><Empty title="No financial year configured" /></Panel>
      </Page>
    );
  }

  const from = asIsoDate(year.startDate);
  const to = asIsoDate(year.endDate);
  const pack = yearEndPack(getDb(), { companyId: company.id, from, to });
  const currency = company.baseCurrency;

  return (
    <Page
      title={`Year-end pack — ${year.name}`}
      subtitle={`${date(from)} to ${date(to)} · ${company.legalName}`}
      actions={
        <>
          <form method="get" className="flex items-center gap-1.5">
            <select name="year" defaultValue={year.id}
              className="border border-line-strong rounded px-2 py-1 text-[12px]">
              {financialYears.map((y) => <option key={y.id} value={y.id}>{y.name}</option>)}
            </select>
            <button type="submit"
              className="px-2.5 py-1 rounded border border-line-strong bg-surface text-[12px] font-medium">
              Show
            </button>
          </form>
          <a href={`/api/export/year-end?from=${from}&to=${to}`}
            className="inline-block px-2.5 py-1 rounded border border-accent bg-accent
              text-white text-[12px] font-medium">
            Export pack
          </a>
        </>
      }
    >
      <Panel
        title="Outstanding issues"
        description="What an accountant would ask about first."
        tone={pack.issues.length === 0 ? 'positive' : 'warning'}
      >
        {pack.issues.length === 0 ? (
          <div className="px-4 py-3 text-positive">
            Nothing outstanding. This does not mean the figures are correct — only that this
            application has nothing to flag.
          </div>
        ) : (
          <table className="ledger">
            <tbody>
              {pack.issues.map((issue, index) => (
                <tr key={index}>
                  <td className="w-24">
                    <Badge tone={issue.severity === 'blocking' ? 'negative' : 'caution'}>
                      {label(issue.severity)}
                    </Badge>
                  </td>
                  <td>
                    <div className="text-ink font-medium">{issue.title}</div>
                    <div className="text-ink-muted mt-0.5">{issue.detail}</div>
                  </td>
                  <td className="w-24 text-right">
                    {issue.href && (
                      <Link href={issue.href} className="text-accent hover:underline text-[12px]">
                        Open
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <div className="grid grid-cols-2 gap-4 items-start">
        <Panel title="Profit and loss">
          <table className="ledger">
            <tbody>
              <tr><td>Revenue</td><td className="text-right num">{accountingMoney(pack.profitAndLoss.revenue.valueMinor, currency)}</td></tr>
              <tr><td>Cost of sales</td><td className="text-right num">{accountingMoney(-pack.profitAndLoss.costOfSales.valueMinor, currency)}</td></tr>
              <tr className="font-medium"><td className="border-t border-line-strong">Gross profit</td>
                <td className="text-right num border-t border-line-strong">{accountingMoney(pack.profitAndLoss.grossProfit.valueMinor, currency)}</td></tr>
              <tr><td>Operating expenses</td><td className="text-right num">{accountingMoney(-pack.profitAndLoss.operatingExpenses.valueMinor, currency)}</td></tr>
              {pack.profitAndLoss.otherIncome.valueMinor !== 0 && (
                <tr><td>Other income</td><td className="text-right num">{accountingMoney(pack.profitAndLoss.otherIncome.valueMinor, currency)}</td></tr>
              )}
              <tr className="font-semibold"><td className="border-t border-line-strong">Net profit</td>
                <td className="text-right num border-t border-line-strong">{accountingMoney(pack.profitAndLoss.netProfit.valueMinor, currency)}</td></tr>
            </tbody>
          </table>
        </Panel>

        <Panel title="Balance sheet" tone={pack.balanceSheet.balances ? 'default' : 'negative'}>
          <table className="ledger">
            <tbody>
              <tr><td>Fixed assets</td><td className="text-right num">{accountingMoney(pack.balanceSheet.fixedAssets.valueMinor, currency)}</td></tr>
              <tr><td>Current assets</td><td className="text-right num">{accountingMoney(pack.balanceSheet.currentAssets.valueMinor, currency)}</td></tr>
              <tr><td>Current liabilities</td><td className="text-right num">{accountingMoney(-pack.balanceSheet.currentLiabilities.valueMinor, currency)}</td></tr>
              <tr className="font-semibold"><td className="border-t border-line-strong">Net assets</td>
                <td className="text-right num border-t border-line-strong">{accountingMoney(pack.balanceSheet.netAssets.valueMinor, currency)}</td></tr>
              <tr><td className="pt-2">Share capital</td><td className="text-right num pt-2">{accountingMoney(pack.balanceSheet.shareCapital.valueMinor, currency)}</td></tr>
              <tr><td>Retained earnings</td><td className="text-right num">{accountingMoney(pack.balanceSheet.retainedEarnings.valueMinor, currency)}</td></tr>
              <tr><td>Profit for the year</td><td className="text-right num">{accountingMoney(pack.balanceSheet.profitForPeriod.valueMinor, currency)}</td></tr>
              <tr className="font-semibold"><td className="border-t border-line-strong">Total equity</td>
                <td className="text-right num border-t border-line-strong">{accountingMoney(pack.balanceSheet.totalEquity.valueMinor, currency)}</td></tr>
            </tbody>
          </table>
        </Panel>
      </div>

      <Panel
        title="Corporation tax worksheet"
        description="The bridge from accounting profit to tax-adjusted profit. This is a
          worksheet for you and your accountant, not a calculation of what you owe."
        tone="warning"
      >
        <table className="ledger">
          <tbody>
            <tr className="font-medium">
              <td>Accounting profit per the profit and loss account</td>
              <td className="text-right num w-40">
                {accountingMoney(pack.taxComputation.accountingProfitMinor, currency)}
              </td>
            </tr>
            {pack.taxComputation.adjustments.map((adjustment, index) => (
              <tr key={index}>
                <td className="pl-5">
                  {adjustment.label}
                  {adjustment.explanation && <Help>{adjustment.explanation}</Help>}
                </td>
                <td className="text-right num">{accountingMoney(adjustment.amountMinor, currency)}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className="border-t border-line-strong">Tax-adjusted profit</td>
              <td className="text-right num border-t border-line-strong">
                {accountingMoney(pack.taxComputation.taxAdjustedProfitMinor, currency)}
              </td>
            </tr>
          </tbody>
        </table>
        <div className="px-4 py-2.5 border-t border-caution/30 bg-caution-soft text-caution text-[12px] leading-snug">
          {pack.taxComputation.disclaimer}
        </div>
      </Panel>

      <div className="grid grid-cols-2 gap-4 items-start">
        <Panel title="Fixed asset schedule">
          {pack.fixedAssets.length === 0 ? <Empty title="No fixed assets" /> : (
            <table className="ledger">
              <thead>
                <tr>
                  <th>Asset</th><th className="w-24">Purchased</th>
                  <th className="w-28 text-right">Cost</th>
                  <th className="w-28 text-right">Depreciation</th>
                  <th className="w-28 text-right">Net book value</th>
                </tr>
              </thead>
              <tbody>
                {pack.fixedAssets.map((asset) => (
                  <tr key={asset.id}>
                    <td>
                      {asset.name}
                      <div className="text-[11px] text-ink-faint">
                        Capital allowances at {rate(asset.capitalAllowanceRateBasisPoints)} over{' '}
                        {asset.capitalAllowanceYears} years
                      </div>
                    </td>
                    <td className="num !text-left">{date(asset.purchaseDate)}</td>
                    <td className="text-right num">{money(asset.costMinor, currency)}</td>
                    <td className="text-right num">{money(asset.accumulatedDepreciationMinor, currency)}</td>
                    <td className="text-right num">{money(asset.netBookValueMinor, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Director's current account">
          <table className="ledger">
            <tbody>
              <tr>
                <td>Balance at {date(to)}</td>
                <td className="text-right num">
                  {accountingMoney(pack.directorsAccount.balanceMinor, currency)}
                </td>
              </tr>
              <tr>
                <td colSpan={2} className="text-ink-muted leading-snug">
                  {pack.directorsAccount.note}
                </td>
              </tr>
            </tbody>
          </table>
        </Panel>
      </div>

      <Panel title="VAT summary by period">
        <table className="ledger">
          <thead>
            <tr>
              <th>Period</th>
              <th className="w-28 text-right">T1 sales VAT</th>
              <th className="w-28 text-right">T2 purchases VAT</th>
              <th className="w-28 text-right">Net</th>
              <th className="w-28">Status</th>
            </tr>
          </thead>
          <tbody>
            {pack.vatPeriods.map((period) => (
              <tr key={period.periodId}>
                <td>
                  <Link href={`/vat/${period.periodId}`} className="text-accent hover:underline">
                    {period.name}
                  </Link>
                </td>
                <td className="text-right num">{money(period.t1Minor, currency)}</td>
                <td className="text-right num">{money(period.t2Minor, currency)}</td>
                <td className="text-right num">{money(period.netMinor, currency)}</td>
                <td><Badge tone={period.status === 'submitted' ? 'positive' : 'neutral'}>
                  {label(period.status)}
                </Badge></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel
        title="Supporting document index"
        description="Every document behind the figures above, with its hash, so an accountant
          can verify that the evidence is the evidence that was classified."
      >
        <table className="ledger">
          <thead>
            <tr>
              <th>File</th><th className="w-40">Supplier</th>
              <th className="w-24">Date</th><th className="w-28 text-right">Total</th>
              <th className="w-28">Matched</th>
            </tr>
          </thead>
          <tbody>
            {pack.documents.map((doc) => (
              <tr key={doc.id}>
                <td>
                  <Link href={`/documents/${doc.id}`} className="text-accent hover:underline">
                    {doc.filename}
                  </Link>
                  <div className="text-[10.5px] text-ink-faint num !text-left">{doc.sha256.slice(0, 32)}…</div>
                </td>
                <td>{doc.supplierName ?? '—'}</td>
                <td className="num !text-left">{date(doc.documentDate)}</td>
                <td className="text-right num">{money(doc.grossMinor, currency)}</td>
                <td>
                  <Badge tone={doc.matched ? 'positive' : 'caution'}>
                    {doc.matched ? 'Yes' : 'No'}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </Page>
  );
}
