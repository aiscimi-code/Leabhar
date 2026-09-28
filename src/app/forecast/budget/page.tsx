import { budgetPage } from '@/lib/forecastQueries';
import { Page, Panel, Badge, Empty, Input, Disclosure, Textarea } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { enterBudgetAction, importBudgetAction, copyBudgetAction } from '@/app/forecast-actions';
import { money, date, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** The company budget (issue #569): entered, imported or copied, and compared with the posted actuals. */
export default async function BudgetPage({ searchParams }: { searchParams: Promise<{ yearEnd?: string }> }) {
  const today = new Date().toISOString().slice(0, 10);
  const yearEnd = (await searchParams).yearEnd ?? `${today.slice(0, 4)}-12-31`;
  const data = budgetPage(yearEnd, today);
  const cur = data.company.baseCurrency;
  const small = 'border border-line-strong rounded px-2 py-1 text-[12px]';
  const bva = data.comparison;
  const cell = (accountId: string, month: string) => data.currentLines.find((l) => l.accountId === accountId && l.monthStart === month)?.amountMinor;

  return (
    <Page
      title="Budget"
      subtitle="An amount per income and expense account per month, in the account's own direction. Each change is a new version;
        the earlier one is kept. Actuals are the posted ledger."
      actions={<form className="flex gap-2"><Input name="yearEnd" type="date" defaultValue={yearEnd} className={small} /><button className={small}>Year ending</button></form>}
    >
      <Panel title={`Budget against actual, year ending ${date(yearEnd)}`}
        description={data.current ? `${data.current.name}, version ${data.current.version} (${label(data.current.source)}). Actual to ${bva ? date(bva.actualTo) : '—'}.` : undefined}>
        {!bva ? <Empty title="No budget for this year" detail="Enter one below, import a CSV, or copy last year's actuals." /> : (
          <table className="ledger">
            <thead><tr><th>Account</th><th className="w-32 text-right">Budget, year</th><th className="w-32 text-right">Budget to date</th><th className="w-32 text-right">Actual</th><th className="w-32 text-right">Difference</th></tr></thead>
            <tbody>
              {bva.rows.map((r) => {
                const worse = r.type === 'income' ? r.varianceMinor < 0 : r.varianceMinor > 0;
                return (
                  <tr key={r.accountId}>
                    <td>{r.code} {r.name} <span className="text-ink-muted">{r.type}</span></td>
                    <td className="text-right tabular-nums">{money(r.budgetMinor, cur)}</td>
                    <td className="text-right tabular-nums">{money(r.budgetToDateMinor, cur)}</td>
                    <td className="text-right tabular-nums">{money(r.actualMinor, cur)}</td>
                    <td className={`text-right tabular-nums ${worse ? 'text-negative' : ''}`}>{money(r.varianceMinor, cur)}</td>
                  </tr>
                );
              })}
              <tr className="font-medium"><td>Income</td><td /><td className="text-right tabular-nums">{money(bva.totals.incomeBudgetToDateMinor, cur)}</td>
                <td className="text-right tabular-nums">{money(bva.totals.incomeActualMinor, cur)}</td><td className="text-right tabular-nums">{money(bva.totals.incomeActualMinor - bva.totals.incomeBudgetToDateMinor, cur)}</td></tr>
              <tr className="font-medium"><td>Expenses</td><td /><td className="text-right tabular-nums">{money(bva.totals.expenseBudgetToDateMinor, cur)}</td>
                <td className="text-right tabular-nums">{money(bva.totals.expenseActualMinor, cur)}</td><td className="text-right tabular-nums">{money(bva.totals.expenseActualMinor - bva.totals.expenseBudgetToDateMinor, cur)}</td></tr>
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Set the budget" description="Each of these saves a new version for the year; the current one is marked superseded and kept.">
        <div className="grid gap-3">
          {data.months.length > 0 && (
            <Disclosure summary="Enter or revise the budget">
              <ActionForm action={enterBudgetAction} submit="Save as a new version" extra={{ yearEnd }}>
                <div className="flex gap-2 mb-2">
                  <Input name="name" required defaultValue={data.current?.name ?? `Budget ${yearEnd.slice(0, 4)}`} className={small} />
                  <Input name="reason" placeholder="Why it changed" className={small} />
                </div>
                <div className="overflow-x-auto">
                  <table className="ledger text-[12px]">
                    <thead><tr><th>Account</th>{data.months.map((m) => <th key={m} className="w-20 text-right">{m.slice(0, 7)}</th>)}</tr></thead>
                    <tbody>{data.chart.map((a) => (
                      <tr key={a.id}>
                        <td className="whitespace-nowrap">{a.code} {a.name}</td>
                        {data.months.map((m) => {
                          const v = cell(a.id, m);
                          return <td key={m}><Input name={`cell:${a.id}:${m}`} defaultValue={v === undefined ? '' : (v / 100).toFixed(2)} className="w-20 border border-line-strong rounded px-1 text-right" /></td>;
                        })}
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </ActionForm>
            </Disclosure>
          )}
          <Disclosure summary="Import a CSV">
            <ActionForm action={importBudgetAction} submit="Import" extra={{ yearEnd }}>
              <div className="grid gap-2">
                <div className="flex gap-2">
                  <Input name="name" required placeholder="Name" className={small} />
                  <Input name="reason" placeholder="Why" className={small} />
                  <input type="file" name="file" accept=".csv,text/csv" className="text-[12px]" />
                </div>
                <Textarea name="csv" rows={5} placeholder={'Or paste it here:\naccount,2026-01,2026-02\n4000,1000.00,1200.00'} />
                <p className="text-[12px] text-ink-muted">An &quot;account&quot; column of account codes or names, then one column per month headed YYYY-MM.
                  Amounts use a decimal point. An unknown account or an unclear amount stops the import; nothing is saved.</p>
              </div>
            </ActionForm>
          </Disclosure>
          <Disclosure summary="Copy last year's actuals or an earlier budget">
            <ActionForm action={copyBudgetAction} submit="Copy" inline extra={{ yearEnd }}>
              <Input name="name" required placeholder="Name" className={small} />
              <select name="from" defaultValue="actuals" className={small}>
                <option value="actuals">Last year&apos;s posted actuals</option>
                {data.budgets.map((b) => <option key={b.id} value={b.id}>{b.name}, year ending {b.financialYearEnd}, v{b.version}</option>)}
              </select>
              <Input name="percent" placeholder="Change, e.g. +5 or -10" className={small} />
              <Input name="reason" placeholder="Why" className={small} />
            </ActionForm>
          </Disclosure>
        </div>
      </Panel>

      <Panel title="Versions">
        {data.budgets.length === 0 ? <Empty title="No budgets" detail="Nothing has been budgeted yet." /> : (
          <table className="ledger">
            <thead><tr><th>Name</th><th className="w-32">Year ending</th><th className="w-20">Version</th><th className="w-36">How</th><th className="w-28">Status</th><th>Why</th><th className="w-40">By</th></tr></thead>
            <tbody>{data.budgets.map((b) => (
              <tr key={b.id}>
                <td><a className="underline" href={`/forecast/budget?yearEnd=${b.financialYearEnd}`}>{b.name}</a></td>
                <td>{date(b.financialYearEnd)}</td><td>{b.version}</td><td>{label(b.source)}</td>
                <td>{b.status === 'current' ? <Badge tone="positive">Current</Badge> : <Badge>Superseded</Badge>}</td>
                <td>{b.reason ?? ''}</td><td>{b.recordedBy}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Panel>
    </Page>
  );
}
