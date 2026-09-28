import { reportsAnalysis, companyContext } from '@/lib/queries';
import { Page, Panel, LinkButton } from '@/components/primitives';
import { accountingMoney, date } from '@/lib/format';
import { asIsoDate } from '@/domain/dates';
import type { ComparativeRow, InvoicesByParty } from '@/domain/reports/analysis';

export const dynamic = 'force-dynamic';

/**
 * Comparatives, and income and expense analysis (issue #553). Every figure is
 * what the domain returned; the page adds nothing up.
 */
export default async function ReportsAnalysisPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const { currentYear, company } = companyContext();
  const from = asIsoDate(params['from'] ?? currentYear?.startDate ?? '2025-01-01');
  const to = asIsoDate(params['to'] ?? currentYear?.endDate ?? '2025-12-31');
  const a = reportsAnalysis(from, to);
  const cur = company.baseCurrency;
  const c = a.comparatives;
  const exportLink = (which: string, format: string, text: string) => (
    <a href={`/api/export/report?which=${which}&format=${format}&from=${from}&to=${to}`}
      className="inline-block px-2.5 py-1 rounded border border-line-strong bg-surface text-[12px] font-medium">{text}</a>
  );

  return (
    <Page
      title="Comparatives and analysis"
      subtitle={`${date(from)} to ${date(to)}`}
      actions={<>
        {exportLink('comparatives', 'xlsx', 'Comparatives XLSX')}
        {exportLink('comparatives', 'pdf', 'Comparatives PDF')}
        {exportLink('income-expense', 'xlsx', 'Analysis XLSX')}
        <LinkButton href={`/reports?from=${from}&to=${to}`}>Financial statements</LinkButton>
      </>}
    >
      <div className="grid grid-cols-2 gap-4 items-start">
        <Panel title="Profit and loss, with comparatives" description={`Against ${date(c.prior.from)} to ${date(c.prior.to)}`}>
          <ComparativeTable rows={c.profitAndLoss} currency={cur} />
        </Panel>
        <Panel title="Balance sheet, with comparatives" description={`At ${date(to)} against ${date(c.prior.to)}`}
          tone={c.balances.current && c.balances.prior ? 'default' : 'negative'}>
          <ComparativeTable rows={c.balanceSheet} currency={cur} />
          {!(c.balances.current && c.balances.prior) && (
            <div className="px-4 py-2.5 bg-negative-soft border-t border-negative/30 text-negative text-[12px]">
              One of the balance sheets does not balance. Open the financial statements for that date to see the difference.
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Income and expense by month" description="Posted journal lines, before the year-end close. The net for the period is the net profit.">
        <div className="overflow-x-auto">
          <table className="ledger">
            <thead><tr><th>Account</th>{a.byMonth.months.map((m) => <th key={m} className="text-right">{m}</th>)}<th className="text-right">Total</th></tr></thead>
            <tbody>
              <tr><td colSpan={a.byMonth.months.length + 2} className="font-medium pt-2">Income</td></tr>
              {a.byMonth.income.map((r) => (
                <tr key={r.accountId}><td className="pl-5 text-ink-muted">{r.code} {r.name}</td>
                  {r.byMonthMinor.map((v, i) => <td key={i} className="text-right num">{accountingMoney(v, cur)}</td>)}
                  <td className="text-right num font-medium">{accountingMoney(r.totalMinor, cur)}</td></tr>
              ))}
              <tr className="font-medium"><td>Total income</td>{a.byMonth.incomeByMonthMinor.map((v, i) => <td key={i} className="text-right num">{accountingMoney(v, cur)}</td>)}
                <td className="text-right num">{accountingMoney(a.byMonth.totalIncomeMinor, cur)}</td></tr>
              <tr><td colSpan={a.byMonth.months.length + 2} className="font-medium pt-2">Expenses</td></tr>
              {a.byMonth.expenses.map((r) => (
                <tr key={r.accountId}><td className="pl-5 text-ink-muted">{r.code} {r.name}</td>
                  {r.byMonthMinor.map((v, i) => <td key={i} className="text-right num">{accountingMoney(v, cur)}</td>)}
                  <td className="text-right num font-medium">{accountingMoney(r.totalMinor, cur)}</td></tr>
              ))}
              <tr className="font-medium"><td>Total expenses</td>{a.byMonth.expensesByMonthMinor.map((v, i) => <td key={i} className="text-right num">{accountingMoney(v, cur)}</td>)}
                <td className="text-right num">{accountingMoney(a.byMonth.totalExpensesMinor, cur)}</td></tr>
              <tr className="font-semibold"><td className="border-t border-line-strong">Net</td>{a.byMonth.netByMonthMinor.map((v, i) => <td key={i} className="text-right num border-t border-line-strong">{accountingMoney(v, cur)}</td>)}
                <td className="text-right num border-t border-line-strong">{accountingMoney(a.byMonth.netMinor, cur)}</td></tr>
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid grid-cols-2 gap-4 items-start">
        <PartyPanel title="Income by customer" data={a.byCustomer} currency={cur} csv={`/api/export/report?which=by-customer&format=csv&from=${from}&to=${to}`} />
        <PartyPanel title="Expense by supplier" data={a.bySupplier} currency={cur} csv={`/api/export/report?which=by-supplier&format=csv&from=${from}&to=${to}`} />
      </div>
    </Page>
  );
}

function ComparativeTable({ rows, currency }: { rows: ComparativeRow[]; currency: string }) {
  return (
    <table className="ledger">
      <thead><tr><th>Line</th><th className="text-right">Current</th><th className="text-right">Prior</th><th className="text-right">Change</th></tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.label}-${i}`} className={r.isTotal ? 'font-semibold' : r.depth === 0 ? 'font-medium' : ''}>
            <td className={r.depth === 1 ? 'pl-5 text-ink-muted' : r.isTotal ? 'border-t border-line-strong' : 'pt-2'}>{r.label}</td>
            {[r.currentMinor, r.priorMinor, r.changeMinor].map((v, j) => (
              <td key={j} className={`text-right num ${r.isTotal ? 'border-t border-line-strong' : ''}`}>{accountingMoney(v, currency)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PartyPanel({ title, data, currency, csv }: { title: string; data: InvoicesByParty; currency: string; csv: string }) {
  return (
    <Panel title={title} actions={<a href={csv} className="text-[12px] text-accent hover:underline">CSV</a>}>
      {data.rows.length === 0 ? <p className="px-4 py-3 text-[12px] text-ink-muted">No invoices posted in the period.</p> : (
        <table className="ledger">
          <thead><tr><th>Name</th><th className="text-right">Invoices</th><th className="text-right">Net</th><th className="text-right">VAT</th></tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.partyId ?? 'none'}>
                <td>{r.name}{r.creditNoteCount > 0 && <span className="text-ink-faint text-[11px]"> ({r.creditNoteCount} credit)</span>}</td>
                <td className="text-right num">{r.invoiceCount}</td>
                <td className="text-right num">{accountingMoney(r.netMinor, currency)}</td>
                <td className="text-right num">{accountingMoney(r.vatMinor, currency)}</td>
              </tr>
            ))}
            <tr className="font-semibold"><td className="border-t border-line-strong">Total</td><td className="text-right num border-t border-line-strong">{data.total.invoiceCount}</td>
              <td className="text-right num border-t border-line-strong">{accountingMoney(data.total.netMinor, currency)}</td>
              <td className="text-right num border-t border-line-strong">{accountingMoney(data.total.vatMinor, currency)}</td></tr>
          </tbody>
        </table>
      )}
      <p className="px-4 py-2.5 text-[11.5px] text-ink-muted border-t border-line leading-snug">{data.method}</p>
    </Panel>
  );
}
