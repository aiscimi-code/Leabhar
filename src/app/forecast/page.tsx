import { forecastPage, type ForecastParams } from '@/lib/forecastQueries';
import { Page, Panel, Badge, Empty, Input, Disclosure, Stat } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import {
  setForecastDefaultsAction, saveForecastAction, createScenarioAction, addScenarioAdjustmentAction, removeScenarioAdjustmentAction,
  detectRecurringAction, confirmRecurringAction, dismissRecurringAction, addRecurringItemAction, changeRecurringItemAction,
} from '@/app/forecast-actions';
import { money, date, label } from '@/lib/format';
import type { ForecastLine } from '@/domain/forecast';

export const dynamic = 'force-dynamic';

const SOURCE: Record<ForecastLine['source'], { text: string; tone: 'neutral' | 'accent' | 'ai' | 'caution' }> = {
  ledger: { text: 'Books', tone: 'neutral' },
  rule: { text: 'Due-date rule', tone: 'accent' },
  assumption: { text: 'Assumption', tone: 'caution' },
  ai_suggestion: { text: 'Detected, confirmed', tone: 'ai' },
};
const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;
const KINDS = ['customer_payment_delay', 'revenue_change', 'cost_change', 'one_off', 'new_hire', 'recurring_item'] as const;

/** The cash forecast (EPIC 29, issues #565–#570). A view beside the ledger: nothing here posts. */
export default async function ForecastPage({ searchParams }: { searchParams: Promise<ForecastParams> }) {
  const params = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const data = forecastPage(params, today);
  const f = data.forecast;
  const o = f.options;
  const cur = f.currency;
  const small = 'border border-line-strong rounded px-2 py-1 text-[12px]';
  const yes = (v: boolean) => (v ? 'yes' : 'no');

  const Line = ({ l }: { l: ForecastLine }) => (
    <tr>
      <td className="w-24">{l.date ? date(l.date) : '—'}</td>
      <td>
        {l.description}{' '}
        <Badge tone={SOURCE[l.source].tone}>{SOURCE[l.source].text}</Badge>{' '}
        {l.isEstimate && <Badge tone="caution">Estimate</Badge>}{' '}
        {l.overdue && <Badge tone="negative" title={`Due ${l.dueDate}`}>Overdue</Badge>}{' '}
        {l.scenarioName && <Badge tone="accent">{l.scenarioName}</Badge>}
        {l.estimateBasis && <div className="text-[12px] text-ink-muted">{l.estimateBasis}</div>}
        {l.ruleKey && <div className="text-[11px] text-ink-faint">Rule {l.ruleKey}</div>}
      </td>
      <td className="w-32 text-right tabular-nums">{money(l.amountMinor, cur)}</td>
    </tr>
  );

  return (
    <Page
      title="Cash forecast"
      subtitle="Bank and cash on the forecast date, then what is expected in and out. Every line says where it comes from and
        whether it is an estimate. A payment with no curated due date is listed apart, never put on a guessed day."
      actions={<a href="/forecast/budget" className={small}>Budget</a>}
    >
      <Panel title="This forecast" description="Each choice overrides the company default for this forecast only.">
        <form className="flex gap-2 flex-wrap items-end text-[12px]">
          <label>From <Input name="asOf" type="date" defaultValue={o.asOf} className={small} /></label>
          <label>Days <Input name="days" type="number" min={1} max={731} defaultValue={String(Math.round((Date.parse(o.horizonEnd) - Date.parse(o.asOf)) / 86_400_000) + 1)} className={small} /></label>
          <label>By <select name="granularity" defaultValue={o.granularity} className={small}>{['daily', 'weekly', 'monthly'].map((g) => <option key={g}>{g}</option>)}</select></label>
          <label>Receipts <select name="receipts" defaultValue={o.receiptBasis} className={small}>
            <option value="due_date">On the due date</option><option value="customer_history">By each customer&apos;s history</option></select></label>
          <label>Tax dates <select name="dueDates" defaultValue={o.dueDateBasis} className={small}>
            <option value="statutory">Statutory</option><option value="ros">ROS, where a source gives one</option></select></label>
          <label>Scenario <select name="scenario" defaultValue={o.scenarioId ?? ''} className={small}>
            <option value="">None</option>{data.scenarios.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label>Purchase orders <select name="orders" defaultValue={yes(o.includePurchaseOrders)} className={small}><option>no</option><option>yes</option></select></label>
          <label>Draft invoices <select name="drafts" defaultValue={yes(o.includeUnconfirmed)} className={small}><option>no</option><option>yes</option></select></label>
          <label>Owner&apos;s tax <select name="ownerTax" defaultValue={yes(o.includeOwnerTax)} className={small}><option>yes</option><option>no</option></select></label>
          <button className={small}>Show</button>
        </form>
      </Panel>

      <div className="grid grid-cols-2 md:grid-cols-5 border border-line rounded bg-surface">
        <Stat label="Opening cash" value={money(f.openingCash.totalMinor, cur)} hint={f.openingCash.accounts.map((a) => a.code).join(', ')} />
        <Stat label="Closing cash" value={money(f.closingBalanceMinor, cur)} hint={date(o.horizonEnd)} />
        <Stat label="Lowest point" value={money(f.lowestPointMinor, cur)} hint={date(f.lowestPointDate)} tone={f.belowMinimum ? 'negative' : 'default'} />
        <Stat label="Minimum cash" value={money(o.minimumCashMinor, cur)} tone={f.belowMinimum ? 'negative' : 'default'} hint={f.belowMinimum ? 'Forecast falls below it' : undefined} />
        <Stat label="Not dated" value={money(f.undatedTotalMinor, cur)} hint={`${f.undated.length} item(s), not in the balance`} tone={f.undated.length ? 'caution' : 'default'} />
      </div>

      {f.findings.length > 0 && (
        <Panel title="Findings" tone="warning">
          <ul className="list-disc pl-5 text-[13px] grid gap-1">{f.findings.map((x) => <li key={x}>{x}</li>)}</ul>
        </Panel>
      )}

      <Panel title={f.scenarioName ? `Forecast: ${f.scenarioName}` : 'Forecast'}>
        <table className="ledger">
          <thead><tr><th>Period</th><th className="w-32 text-right">In</th><th className="w-32 text-right">Out</th><th className="w-32 text-right">Net</th>
            <th className="w-32 text-right">Closing</th>{o.includeUnconfirmed && <th className="w-40 text-right">With draft invoices</th>}</tr></thead>
          <tbody>
            <tr className="text-ink-muted"><td>Opening, {date(o.asOf)}</td><td colSpan={3} /><td className="text-right tabular-nums">{money(f.openingCash.totalMinor, cur)}</td>{o.includeUnconfirmed && <td />}</tr>
            {f.buckets.map((b) => (
              <tr key={b.periodStart} className={b.closingBalanceMinor < o.minimumCashMinor ? 'text-negative' : undefined}>
                <td>{b.label}</td>
                <td className="text-right tabular-nums">{money(b.inflowMinor, cur)}</td>
                <td className="text-right tabular-nums">{money(b.outflowMinor, cur)}</td>
                <td className="text-right tabular-nums">{money(b.netMinor, cur)}</td>
                <td className="text-right tabular-nums font-medium">{money(b.closingBalanceMinor, cur)}</td>
                {o.includeUnconfirmed && <td className="text-right tabular-nums">{money(b.closingBalanceWithUnconfirmedMinor, cur)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="grid gap-2 mt-3">
          {f.buckets.filter((b) => b.inflows.length + b.outflows.length > 0).map((b) => (
            <Disclosure key={b.periodStart} summary={`${b.label}: ${b.inflows.length + b.outflows.length} line(s)`}>
              <table className="ledger"><tbody>{[...b.inflows, ...b.outflows].map((l) => <Line key={l.key} l={l} />)}</tbody></table>
            </Disclosure>
          ))}
        </div>
      </Panel>

      {f.undated.length > 0 && (
        <Panel title="Not dated" description="No curated rule gives these a date. They are owed, and kept out of the running balance so a guessed day cannot move it.">
          <table className="ledger"><tbody>{f.undated.map((l) => <Line key={l.key} l={l} />)}</tbody></table>
        </Panel>
      )}
      {f.unconfirmed.length > 0 && (
        <Panel title="Draft invoices" description="Not yet issued: counted only in the separate balance beside the forecast.">
          <table className="ledger"><tbody>{f.unconfirmed.map((l) => <Line key={l.key} l={l} />)}</tbody></table>
        </Panel>
      )}

      <Panel title="Saved forecasts" description="A saved forecast is kept exactly as computed, to compare with later.">
        <div className="grid gap-3">
          <ActionForm action={saveForecastAction} submit="Save this forecast" inline extra={{ options: JSON.stringify(o) }}>
            <Input name="name" required placeholder="Name, e.g. March board pack" className={small} />
          </ActionForm>
          {data.snapshots.length === 0 ? <Empty title="None saved" detail="Save a forecast to compare with it later." /> : (
            <table className="ledger">
              <thead><tr><th>Name</th><th className="w-28">From</th><th className="w-28">To</th><th className="w-32 text-right">Closing</th><th className="w-32 text-right">Lowest</th><th className="w-40">Saved</th><th className="w-24" /></tr></thead>
              <tbody>{data.snapshots.map((s) => (
                <tr key={s.id}>
                  <td>{s.name}</td><td>{date(s.asOf)}</td><td>{date(s.horizonEnd)}</td>
                  <td className="text-right tabular-nums">{money(s.closingBalanceMinor, cur)}</td>
                  <td className="text-right tabular-nums">{money(s.lowestPointMinor, cur)}</td>
                  <td>{s.savedBy}, {date(s.createdAt.slice(0, 10))}</td>
                  <td><a className="underline" href={`/forecast?asOf=${s.asOf}&compare=${s.id}`}>Compare</a></td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {data.comparison && (
            <div className="text-[13px] grid gap-2">
              <div>Against <strong>{data.comparison.snapshot.name}</strong>: closing {money(data.comparison.closing.savedMinor, cur)} then,
                {' '}{money(data.comparison.closing.currentMinor, cur)} now ({money(data.comparison.closing.differenceMinor, cur)}).</div>
              <table className="ledger"><tbody>
                {data.comparison.added.map((l) => <tr key={`a${l.key}`}><td className="w-20"><Badge tone="positive">New</Badge></td><td>{l.description}</td><td className="w-28">{l.date ? date(l.date) : '—'}</td><td className="w-32 text-right tabular-nums">{money(l.amountMinor, cur)}</td></tr>)}
                {data.comparison.removed.map((l) => <tr key={`r${l.key}`}><td><Badge tone="negative">Gone</Badge></td><td>{l.description}</td><td>{l.date ? date(l.date) : '—'}</td><td className="text-right tabular-nums">{money(l.amountMinor, cur)}</td></tr>)}
                {data.comparison.changed.map((c) => <tr key={`c${c.key}`}><td><Badge tone="caution">Moved</Badge></td><td>{c.description}</td>
                  <td>{c.saved.date ? date(c.saved.date) : '—'} → {c.current.date ? date(c.current.date) : '—'}</td>
                  <td className="text-right tabular-nums">{money(c.saved.amountMinor, cur)} → {money(c.current.amountMinor, cur)}</td></tr>)}
              </tbody></table>
            </div>
          )}
        </div>
      </Panel>

      <Panel title="Scenarios" description="Named assumptions over the base forecast. Choose one above to see its forecast; the base is never changed.">
        <div className="grid gap-3">
          {data.scenarios.map((s) => (
            <Disclosure key={s.id} summary={`${s.name} (${s.adjustments.length} adjustment${s.adjustments.length === 1 ? '' : 's'})`}>
              {s.description && <p className="text-[13px] text-ink-muted mb-2">{s.description}</p>}
              <table className="ledger"><tbody>{s.adjustments.map((a) => (
                <tr key={a.id}>
                  <td>{label(a.kind)}: {a.description}</td>
                  <td className="w-56">{date(a.fromDate)}{a.toDate ? ` to ${date(a.toDate)}` : ' onwards'}</td>
                  <td className="w-40 text-right tabular-nums">
                    {a.delayDays !== null && `${a.delayDays} day(s)`}
                    {a.changeBasisPoints !== null && `${a.changeBasisPoints / 100}%`}
                    {a.amountMinor !== null && money(a.amountMinor, cur)}{a.frequency && ` ${a.frequency}`}
                  </td>
                  <td className="w-24"><ActionForm action={removeScenarioAdjustmentAction} submit="Remove" variant="secondary" extra={{ adjustmentId: a.id }} /></td>
                </tr>
              ))}</tbody></table>
              <div className="mt-2">
                <ActionForm action={addScenarioAdjustmentAction} submit="Add" inline extra={{ scenarioId: s.id }} resetOnSuccess>
                  <select name="kind" defaultValue="one_off" className={small}>{KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</select>
                  <Input name="description" required placeholder="What it is" className={small} />
                  <Input name="value" required placeholder="Days, ±% or ±amount" className={small} />
                  <Input name="fromDate" type="date" required defaultValue={o.asOf} className={small} />
                  <Input name="toDate" type="date" className={small} />
                  <select name="targetId" defaultValue="" className={small}><option value="">All customers or suppliers</option>
                    {data.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                  <select name="frequency" defaultValue="monthly" className={small}>{FREQUENCIES.map((x) => <option key={x}>{x}</option>)}</select>
                </ActionForm>
                <p className="text-[12px] text-ink-muted mt-1">A delay is days (negative is early); a revenue or cost change is a percentage;
                  a one-off or recurring amount is negative for money out; a new hire is the monthly cost. Frequency is for a recurring amount.</p>
              </div>
            </Disclosure>
          ))}
          <Disclosure summary="Add a scenario">
            <ActionForm action={createScenarioAction} submit="Add" inline resetOnSuccess>
              <Input name="name" required placeholder="Name" className={small} />
              <Input name="description" placeholder="Description" className={small} />
            </ActionForm>
          </Disclosure>
        </div>
      </Panel>

      <Panel title="Recurring items" description="Regular payments and receipts not invoiced: entered by hand, or detected in the bank history and confirmed by a person.">
        <div className="grid gap-3">
          {data.items.length > 0 && (
            <table className="ledger">
              <thead><tr><th>Item</th><th className="w-24">Direction</th><th className="w-24">How often</th><th className="w-28">From</th><th className="w-28">To</th><th className="w-28 text-right">Amount</th><th className="w-24">Status</th><th /></tr></thead>
              <tbody>{data.items.map((i) => (
                <tr key={i.id}>
                  <td>{i.description} {i.source === 'detected' && <Badge tone="ai">Detected</Badge>}</td><td>{i.direction}</td><td>{i.frequency}</td>
                  <td>{date(i.startDate)}</td><td>{i.endDate ? date(i.endDate) : '—'}</td>
                  <td className="text-right tabular-nums">{money(i.amountMinor, cur)}</td><td>{i.status}</td>
                  <td>{i.status === 'confirmed' && (
                    <ActionForm action={changeRecurringItemAction} submit="Change" inline extra={{ itemId: i.id }}>
                      <Input name="amount" placeholder="New amount" className={small} />
                      <Input name="endDate" type="date" className={small} />
                      <label className="text-[12px]"><input type="checkbox" name="stop" /> Stop</label>
                    </ActionForm>
                  )}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {data.suggestions.length > 0 && (
            <table className="ledger">
              <thead><tr><th>Suggested payee</th><th className="w-24">How often</th><th className="w-32 text-right">Usual amount</th><th className="w-40">Seen</th><th /></tr></thead>
              <tbody>{data.suggestions.map((p) => (
                <tr key={p.id}>
                  <td>{p.payeePattern} <Badge tone="ai">Suggestion</Badge> <span className="text-ink-muted">{p.direction}</span></td>
                  <td>{p.detectedFrequency}</td>
                  <td className="text-right tabular-nums" title={`${money(p.amountMinMinor, cur)} to ${money(p.amountMaxMinor, cur)}`}>{money(p.medianAmountMinor, cur)}</td>
                  <td>{p.occurrenceCount}×, last {date(p.lastSeenDate)}</td>
                  <td className="flex gap-2">
                    <ActionForm action={confirmRecurringAction} submit="Confirm" inline extra={{ patternId: p.id }}>
                      <Input name="amount" placeholder="Amount (optional)" className={small} />
                    </ActionForm>
                    <ActionForm action={dismissRecurringAction} submit="Dismiss" variant="secondary" extra={{ patternId: p.id }} />
                  </td>
                </tr>
              ))}</tbody>
            </table>
          )}
          <ActionForm action={detectRecurringAction} submit="Look for recurring payments in the bank history" variant="secondary" extra={{ asOf: o.asOf }} />
          <Disclosure summary="Add a recurring item">
            <ActionForm action={addRecurringItemAction} submit="Add" inline resetOnSuccess>
              <Input name="description" required placeholder="Description" className={small} />
              <select name="direction" defaultValue="outflow" className={small}><option value="outflow">Money out</option><option value="inflow">Money in</option></select>
              <Input name="amount" required placeholder="Amount" className={small} />
              <select name="frequency" defaultValue="monthly" className={small}>{FREQUENCIES.map((x) => <option key={x}>{x}</option>)}</select>
              <Input name="startDate" type="date" required defaultValue={o.asOf} className={small} />
              <Input name="endDate" type="date" className={small} />
            </ActionForm>
          </Disclosure>
        </div>
      </Panel>

      <Panel title="Company defaults" description={`Version ${data.defaults.version}${data.defaults.version === 0 ? ' (built in)' : ''}. A change is kept as a new version.`}>
        <ActionForm action={setForecastDefaultsAction} submit="Save defaults" inline>
          <label className="text-[12px]">Receipts <select name="receiptBasis" defaultValue={data.defaults.receiptBasis} className={small}>
            <option value="due_date">On the due date</option><option value="customer_history">By each customer&apos;s history</option></select></label>
          <label className="text-[12px]">Days <Input name="horizonDays" type="number" min={1} max={731} defaultValue={data.defaults.horizonDays} className={small} /></label>
          <label className="text-[12px]">By <select name="granularity" defaultValue={data.defaults.granularity} className={small}>{['daily', 'weekly', 'monthly'].map((g) => <option key={g}>{g}</option>)}</select></label>
          <label className="text-[12px]">Tax dates <select name="dueDateBasis" defaultValue={data.defaults.dueDateBasis} className={small}>
            <option value="statutory">Statutory</option><option value="ros">ROS, where a source gives one</option></select></label>
          <label className="text-[12px]">Minimum cash <Input name="minimumCash" defaultValue={(data.defaults.minimumCashMinor / 100).toFixed(2)} className={small} /></label>
          <label className="text-[12px]">Cash accounts <select name="cashAccountIds" multiple defaultValue={data.defaults.cashAccountIds ?? []} className={small}>
            {data.cashAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}</select></label>
          <label className="text-[12px]"><input type="checkbox" name="includePurchaseOrders" defaultChecked={data.defaults.includePurchaseOrders} /> Purchase orders</label>
          <label className="text-[12px]"><input type="checkbox" name="includeUnconfirmed" defaultChecked={data.defaults.includeUnconfirmed} /> Draft invoices</label>
          <label className="text-[12px]"><input type="checkbox" name="includeOwnerTax" defaultChecked={data.defaults.includeOwnerTax} /> Owner&apos;s tax</label>
        </ActionForm>
        <p className="text-[12px] text-ink-muted mt-1">No cash accounts chosen means the bank accounts and cash on hand.</p>
      </Panel>
    </Page>
  );
}
