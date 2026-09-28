import { statutoryPage } from '@/lib/queries';
import { Page, Panel, Badge, Empty, Input, Disclosure, LinkButton } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { recordSizeDecisionAction, mapFormatItemAction } from '@/app/statutory-actions';
import { accountingMoney, date, label } from '@/lib/format';
import { MAPPABLE_BALANCE_SHEET_ITEMS, MAPPABLE_PROFIT_AND_LOSS_ITEMS, type FormatLine } from '@/domain/reports/schedule3A';
import { COMPANY_SIZE_EXCLUSIONS, COMPANY_SIZES, COMPANY_SIZE_ELECTIONS } from '@/db/schema';

export const dynamic = 'force-dynamic';

/**
 * Company size and the Schedule 3A Format 1 statements (EPIC 28, issue #554).
 * Every figure comes from the domain; decisions the books cannot make are
 * recorded here by a person.
 */
export default async function StatutoryPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const data = statutoryPage((await searchParams).year);
  const small = 'border border-line-strong rounded px-2 py-1 text-[12px]';
  if (!data.year || !data.size || !data.balanceSheet || !data.profitAndLoss) {
    return <Page title="Company size and formats"><Empty title="No financial year" detail="Set up a financial year first." /></Page>;
  }
  const cur = data.company.baseCurrency;
  const s = data.size;
  const fyEnd = data.year.endDate;
  const tone = s.status === 'classified' ? 'positive' : s.status === 'needs_decision' || s.status === 'excluded' ? 'warning' : 'default';
  const limbValue = (limb: string, v: number | null) => (v === null ? '—' : limb === 'employees' ? String(v) : accountingMoney(v, cur));

  return (
    <Page
      title="Company size and formats"
      subtitle={`${data.year.name}: ${date(data.year.startDate)} to ${date(fyEnd)}`}
      actions={<>
        <form className="flex gap-2">
          <select name="year" defaultValue={data.year.id} className={small}>
            {data.financialYears.map((y) => <option key={y.id} value={y.id}>{y.name}</option>)}
          </select>
          <button className={small}>Show</button>
        </form>
        <LinkButton href="/reports">Financial statements</LinkButton>
      </>}
    >
      <Panel title="Company size" tone={tone}
        description="Companies Act 2014 ss.280A (small), 280D (micro) and 280F (medium), on the books' figures and the curated thresholds.">
        <div className="px-4 py-3 text-[13px]">
          <strong>{s.size ? label(s.size) : 'Not decided'}</strong> <Badge>{label(s.status)}</Badge>
          {s.consequence && <p className="text-ink-muted mt-1">{s.consequence}</p>}
        </div>
        {s.year.conditions && (
          <table className="ledger">
            <thead><tr><th>Size</th><th>Limb</th><th className="text-right">This year</th><th className="text-right">Limit</th><th>Met</th></tr></thead>
            <tbody>
              {s.year.conditions.flatMap((c) => c.limbs.map((l, i) => (
                <tr key={`${c.size}-${l.limb}`}>
                  <td>{i === 0 && <>{label(c.size)} <span className="text-ink-faint text-[11px]">{c.met === null ? 'not known' : c.met ? '2 of 3 met' : 'not met'}</span></>}</td>
                  <td>{label(l.limb)}</td>
                  <td className="text-right num">{limbValue(l.limb, l.value)}</td>
                  <td className="text-right num" title={l.ruleKey}>{limbValue(l.limb, l.appliedThreshold)}{l.appliedThreshold !== l.threshold && ' (adjusted)'}</td>
                  <td>{l.met === null ? '—' : l.met ? 'Yes' : 'No'}</td>
                </tr>
              )))}
            </tbody>
          </table>
        )}
        <div className="px-4 py-2.5 border-t border-line text-[12px] text-ink-muted space-y-1">
          {s.year.employees.note && <p>Employees ({s.year.employees.source}): {s.year.employees.note}</p>}
          {s.basis.map((b, i) => <p key={i}>{b}</p>)}
        </div>
        {[...s.openPoints, ...s.findings].map((p, i) => (
          <div key={i} className="px-4 py-2 bg-caution-soft border-t border-caution/30 text-caution text-[12px]">{p}</div>
        ))}
        <div className="px-4 py-3 border-t border-line grid gap-2">
          <Disclosure summary="Record an exclusion (or none)">
            <ActionForm action={recordSizeDecisionAction} submit="Record" inline>
              <input type="hidden" name="financialYearEnd" value={fyEnd} /><input type="hidden" name="kind" value="exclusion" />
              <select name="choice" className={small}>{COMPANY_SIZE_EXCLUSIONS.map((e) => <option key={e} value={e}>{label(e)}</option>)}</select>
              <Input name="note" placeholder="Why" className={small} />
            </ActionForm>
          </Disclosure>
          <Disclosure summary="Record the s.280I election (which years the 2024 figures apply to)">
            <ActionForm action={recordSizeDecisionAction} submit="Record" inline>
              <input type="hidden" name="financialYearEnd" value={fyEnd} /><input type="hidden" name="kind" value="size_criteria_election" />
              <select name="choice" className={small}>{COMPANY_SIZE_ELECTIONS.map((e) => <option key={e} value={e}>{e === 'fy_from_2023' ? 'Years beginning on or after 1 January 2023' : 'Years beginning on or after 1 January 2024'}</option>)}</select>
              <Input name="note" placeholder="Where the election is recorded" className={small} />
            </ActionForm>
          </Disclosure>
          <Disclosure summary="Record the average number of employees">
            <ActionForm action={recordSizeDecisionAction} submit="Record" inline>
              <input type="hidden" name="financialYearEnd" value={fyEnd} /><input type="hidden" name="kind" value="average_employees" />
              <Input name="count" required placeholder="Average" className={small} />
              <Input name="note" required placeholder="How it was worked out" className={small} />
            </ActionForm>
          </Disclosure>
          <Disclosure summary="Record the year before (not in these books)">
            <ActionForm action={recordSizeDecisionAction} submit="Record size" inline>
              <input type="hidden" name="financialYearEnd" value={fyEnd} /><input type="hidden" name="kind" value="prior_year_size" />
              <select name="choice" className={small}>{COMPANY_SIZES.map((e) => <option key={e} value={e}>{label(e)}</option>)}</select>
              <Input name="note" placeholder="Source (last year's accounts)" className={small} />
            </ActionForm>
            <ActionForm action={recordSizeDecisionAction} submit="Record conditions met" inline>
              <input type="hidden" name="financialYearEnd" value={fyEnd} /><input type="hidden" name="kind" value="prior_year_conditions" />
              <select name="choice" className={small}>{COMPANY_SIZES.filter((e) => e !== 'first_financial_year').map((e) => <option key={e} value={e}>Smallest met: {label(e)}</option>)}</select>
              <Input name="note" placeholder="Source" className={small} />
            </ActionForm>
          </Disclosure>
        </div>
      </Panel>

      <div className="grid grid-cols-2 gap-4 items-start">
        <Panel title="Balance sheet (Schedule 3A, Format 1)" description={`At ${date(fyEnd)}`} tone={data.balanceSheet.reconciles ? 'default' : 'negative'}>
          <FormatTable lines={data.balanceSheet.lines} currency={cur} />
          <Notes notes={data.balanceSheet.notes} ok={data.balanceSheet.reconciles}
            okText="Capital and reserves equal total assets less liabilities, and net assets equal the ledger." />
        </Panel>
        <Panel title="Profit and loss account (Schedule 3A, Format 1)" description={`${date(data.year.startDate)} to ${date(fyEnd)}`}
          tone={data.profitAndLoss.reconciles ? 'default' : 'negative'}>
          <FormatTable lines={data.profitAndLoss.lines} currency={cur} />
          <Notes notes={data.profitAndLoss.notes} ok={data.profitAndLoss.reconciles} okText="Item 16 equals the net profit on the ledger." />
        </Panel>
      </div>

      <Panel title="Map an account to another item" description="From a date; earlier periods keep the item they had. Leave an account unmapped to use its default.">
        <div className="px-4 py-3">
          <ActionForm action={mapFormatItemAction} submit="Map" inline>
            <select name="accountId" required defaultValue="" className={small}>
              <option value="" disabled>Account</option>
              {data.accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
            </select>
            <select name="itemCode" required defaultValue="" className={small}>
              <option value="" disabled>Item</option>
              <optgroup label="Balance sheet">{MAPPABLE_BALANCE_SHEET_ITEMS.map((c) => <option key={c} value={c}>{c}</option>)}</optgroup>
              <optgroup label="Profit and loss">{MAPPABLE_PROFIT_AND_LOSS_ITEMS.map((c) => <option key={c} value={c}>{c}</option>)}</optgroup>
            </select>
            <Input name="effectiveFrom" type="date" required defaultValue={data.year.startDate} className={small} />
            <Input name="note" placeholder="Why" className={small} />
          </ActionForm>
        </div>
      </Panel>
    </Page>
  );
}

function FormatTable({ lines, currency }: { lines: FormatLine[]; currency: string }) {
  return (
    <table className="ledger">
      <tbody>
        {lines.map((l) => (
          <tr key={l.code} className={l.isTotal ? 'font-medium' : ''}>
            <td style={{ paddingLeft: `${1 + l.depth * 1.1}rem` }}>
              <span className="text-ink-faint text-[11px] mr-1.5">{l.code}</span>{l.heading}
              {l.accounts.length > 0 && (
                <div className="text-[11px] text-ink-muted">
                  {l.accounts.map((a) => `${a.code} ${a.name}${a.source === 'mapped' ? ' (mapped)' : ''}${a.reclassifiedFrom ? ` (from ${a.reclassifiedFrom})` : ''}`).join('; ')}
                </div>
              )}
            </td>
            <td className="text-right num align-top">{accountingMoney(l.amountMinor, currency)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Notes({ notes, ok, okText }: { notes: string[]; ok: boolean; okText: string }) {
  return (
    <>
      <div className={`px-4 py-2 border-t text-[12px] ${ok ? 'border-line text-positive' : 'bg-negative-soft border-negative/30 text-negative'}`}>
        {ok ? `✓ ${okText}` : 'The layout does not agree with the ledger. The difference is shown, not absorbed.'}
      </div>
      {notes.map((n, i) => <p key={i} className="px-4 py-2 border-t border-line text-[11.5px] text-ink-muted">{n}</p>)}
    </>
  );
}
