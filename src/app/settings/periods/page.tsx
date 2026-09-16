import { companyContext, vatPeriodRows } from '@/lib/queries';
import {
  Page, Panel, Badge, Field, Input, Select, Disclosure, Empty,
} from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { generatePeriodsAction, updateVatPeriodAction } from '@/app/settings-actions';
import { date, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

const FREQUENCIES = ['monthly', 'bi_monthly', 'four_monthly', 'half_yearly', 'annual'] as const;

/** Accounting periods and VAT periods (README §8, §46). */
export default function PeriodsPage() {
  const { company, financialYears } = companyContext();
  const periods = vatPeriodRows();
  const thisYear = new Date().getFullYear();

  return (
    <Page
      title="Periods"
      subtitle="Which dates fall into which return. Periods are never moved once they hold
        entries — generating a year that overlaps an existing period skips it rather than
        rewriting it."
    >
      <div className="grid grid-cols-2 gap-4 items-start">
        <Panel
          title="Generate VAT periods"
          description={`Currently filing ${label(company.vatPeriodFrequency)}.`}
        >
          <div className="px-4 py-3">
            <ActionForm action={generatePeriodsAction} submit="Generate"
              extra={{ kind: 'vat' }}>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Year">
                  <Input name="year" type="number" defaultValue={thisYear} required />
                </Field>
                <Field
                  label="Frequency"
                  help="Use the frequency Revenue put you on. Changing it here generates
                    differently shaped periods for the year you pick; it does not reshape
                    periods that already exist."
                >
                  <Select name="frequency" defaultValue={company.vatPeriodFrequency}>
                    {FREQUENCIES.map((frequency) => (
                      <option key={frequency} value={frequency}>{label(frequency)}</option>
                    ))}
                  </Select>
                </Field>
              </div>
            </ActionForm>
          </div>
        </Panel>

        <Panel
          title="Generate an accounting period"
          description="One financial year, ending on the company's year end date."
        >
          <div className="px-4 py-3">
            <ActionForm action={generatePeriodsAction} submit="Create year"
              extra={{ kind: 'financial_year' }}>
              <Field
                label="Year ending"
                hint={`Year end is ${String(company.financialYearEndDay).padStart(2, '0')}/`
                  + `${String(company.financialYearEndMonth).padStart(2, '0')}. A first period `
                  + 'shorter than about three months is flagged rather than silently created.'}
              >
                <Input name="year" type="number" defaultValue={thisYear} required />
              </Field>
            </ActionForm>
          </div>
        </Panel>
      </div>

      <Panel title="Accounting periods">
        {financialYears.length === 0 ? <Empty title="No accounting periods yet" /> : (
          <table className="ledger">
            <thead>
              <tr><th>Period</th><th className="w-28">From</th><th className="w-28">To</th>
                <th className="w-24">Status</th></tr>
            </thead>
            <tbody>
              {financialYears.map((year) => (
                <tr key={year.id}>
                  <td>{year.name}</td>
                  <td className="num !text-left">{date(year.startDate)}</td>
                  <td className="num !text-left">{date(year.endDate)}</td>
                  <td>
                    <Badge tone={year.status === 'locked' ? 'accent' : 'neutral'}>
                      {label(year.status)}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel
        title="VAT periods"
        description="A period that has been locked or submitted cannot have its dates changed
          — moving it would move figures out of a return already filed."
      >
        {periods.length === 0 ? <Empty title="No VAT periods yet" /> : (
          <>
            <table className="ledger">
              <thead>
                <tr>
                  <th>Period</th><th className="w-28">From</th><th className="w-28">To</th>
                  <th className="w-32">Filing deadline</th><th className="w-28">Status</th>
                </tr>
              </thead>
              <tbody>
                {periods.map((period) => (
                  <tr key={period.id}>
                    <td>
                      <a href={`/vat/${period.id}`} className="text-accent hover:underline">
                        {period.name}
                      </a>
                    </td>
                    <td className="num !text-left">{date(period.startDate)}</td>
                    <td className="num !text-left">{date(period.endDate)}</td>
                    <td className="num !text-left text-ink-muted">
                      {period.filingDeadline ? date(period.filingDeadline) : '—'}
                    </td>
                    <td><Badge tone={period.status === 'submitted' ? 'positive' : 'neutral'}>
                      {label(period.status)}
                    </Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>

            {periods
              .filter((period) => period.status === 'open' || period.status === 'review')
              .map((period) => (
                <Disclosure key={period.id} summary={`Edit ${period.name}`}>
                  <ActionForm action={updateVatPeriodAction} submit="Save period"
                    extra={{ vatPeriodId: period.id }}>
                    <div className="grid grid-cols-4 gap-3 max-w-4xl">
                      <Field label="Name"><Input name="name" defaultValue={period.name} /></Field>
                      <Field label="From">
                        <Input name="startDate" type="date" defaultValue={period.startDate} />
                      </Field>
                      <Field label="To">
                        <Input name="endDate" type="date" defaultValue={period.endDate} />
                      </Field>
                      <Field
                        label="Filing deadline"
                        help="Shown on the tax calendar and in the countdown on the dashboard.
                          Check it against Revenue's own dates — a deadline stored here is a
                          reminder, not an authority."
                      >
                        <Input name="filingDeadline" type="date"
                          defaultValue={period.filingDeadline ?? ''} />
                      </Field>
                    </div>
                  </ActionForm>
                </Disclosure>
              ))}
          </>
        )}
      </Panel>
    </Page>
  );
}
