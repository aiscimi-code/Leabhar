import { activeCompany } from '@/lib/queries';
import { errPage } from '@/lib/payrollQueries';
import { requireActor } from '@/lib/session';
import { Page, Panel, Badge, Empty, Field, Input, Select, Disclosure } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import {
  recordReportableBenefitAction, reportExpenseClaimAction, markBenefitsSubmittedAction, correctReportableBenefitAction, reconcileErrAction,
} from '@/app/payroll-actions';
import { money, date } from '@/lib/format';

export const dynamic = 'force-dynamic';

const small = 'border border-line-strong rounded px-2 py-1 text-[12px]';
const SUBCATEGORIES: Array<[string, string]> = [
  ['travel_vouched', 'Travel, vouched'], ['travel_unvouched', 'Travel, unvouched'],
  ['subsistence_vouched', 'Subsistence, vouched'], ['subsistence_unvouched', 'Subsistence, unvouched'],
  ['site_based', 'Site-based (country money)'], ['emergency_travel', 'Emergency travel'], ['eating_on_site', 'Eating on site'],
  ['advance', 'Advance travel and subsistence'],
];
const label = (category: string, sub: string | null) => sub
  ? SUBCATEGORIES.find(([k]) => k === sub)?.[1] ?? sub
  : category === 'small_benefit' ? 'Small benefit' : 'Remote working daily allowance';

/**
 * Reportable benefits (EPIC 21): what an employer provides without deducting
 * tax and must notify to Revenue on or before providing it (TCA s.897C).
 */
export default async function ErrPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  if (!activeCompany()) return <Page title="Reportable benefits"><Panel><Empty title="No company yet" /></Panel></Page>;
  try {
    await requireActor('payroll.read');
  } catch (e) {
    return <Page title="Reportable benefits"><Panel><Empty title="Payroll is not open to your role" detail={e instanceof Error ? e.message : ''} /></Panel></Page>;
  }
  const year = Number((await searchParams).year) || new Date().getFullYear();
  const { employees, benefits, claims } = errPage(year);
  const today = new Date().toISOString().slice(0, 10);
  const staff = employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName} ({e.employerReference})</option>);

  return (
    <Page title="Reportable benefits"
      subtitle="Small benefits, the remote working daily allowance, and travel and subsistence, provided without tax and notified to
        Revenue on or before they are provided (Enhanced Reporting Requirements). Leabhar prepares the particulars; submit them
        through ROS and record the reference until it can send them itself (#528).">
      <Panel title="Record a benefit">
        <ActionForm action={recordReportableBenefitAction} submit="Record" resetOnSuccess>
          <div className="grid grid-cols-3 gap-3 max-w-3xl">
            <Field label="Employee"><Select name="employeeId" required defaultValue="">{[<option key="" value="" disabled>Choose</option>, ...staff]}</Select></Field>
            <Field label="Kind" help="A small benefit beyond the fifth in a year, or over €1,500 in total, is refused: it is taxable in full through payroll.">
              <Select name="kind" defaultValue="small_benefit">
                <option value="small_benefit">Small benefit (voucher, gift)</option>
                <option value="remote_working_daily_allowance">Remote working daily allowance</option>
                {SUBCATEGORIES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </Field>
            <Field label="Date provided or paid"><Input name="date" type="date" required defaultValue={today} /></Field>
            <Field label="Amount (EUR)"><Input name="amount" required placeholder="0.00" /></Field>
            <Field label="Days worked from home" hint="Remote working allowance only; at most €3.20 a day"><Input name="days" type="number" step="0.5" min="0" /></Field>
            <Field label="Description"><Input name="description" placeholder="Christmas voucher" /></Field>
          </div>
        </ActionForm>
      </Panel>

      <Panel title="Reimbursed expense claims to report" description="Travel and subsistence reimbursed without tax is reportable. Mileage and rate-priced subsistence are unvouched, receipted travel vouched; anything else is yours to classify.">
        {claims.length === 0 ? <Empty title="Every reimbursed claim is reported" /> : claims.map((c) => (
          <div key={c.claimId} className="border border-line-strong rounded p-3 mb-2">
            <div className="font-medium">{c.title} <span className="text-[11.5px] text-ink-muted">reimbursed {date(c.reimbursedOn)} · {money(c.reportableMinor, 'EUR')} reportable, {money(c.preparedMinor, 'EUR')} prepared</span></div>
            {c.preparedMinor === 0 ? (
              <ActionForm action={reportExpenseClaimAction} submit="Prepare its reportable benefits" extra={{ claimId: c.claimId }}>
                <div className="grid grid-cols-2 gap-2 max-w-3xl">
                  <Field label="Employee" hint="Only if the claimant is not linked to an employee">
                    <Select name="employeeId" defaultValue="">{[<option key="" value="">Linked employee</option>, ...staff]}</Select>
                  </Field>
                  {c.lines.filter((l) => l.decided === null).map((l) => (
                    <Field key={l.id} label={`Classify: ${l.description}`}>
                      <Select name={`classify:${l.id}`} required defaultValue="">
                        <option value="" disabled>Choose</option>
                        {SUBCATEGORIES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </Select>
                    </Field>
                  ))}
                </div>
              </ActionForm>
            ) : <div className="text-[12px] text-caution">Prepared benefits differ from the claim: correct them below.</div>}
          </div>
        ))}
      </Panel>

      <Panel title={`Benefits in ${year}`} actions={<span className="text-[12px]"><a href={`?year=${year - 1}`}>{year - 1}</a> · <a href={`?year=${year + 1}`}>{year + 1}</a></span>}>
        {benefits.length === 0 ? <Empty title="Nothing recorded" /> : (
          <ActionForm action={markBenefitsSubmittedAction} submit="Record ROS submission of the ticked benefits">
            <table className="ledger">
              <thead><tr><th></th><th>Date</th><th>Employee</th><th>PPSN / ref.</th><th>Category</th><th className="text-right">Amount</th><th>Days</th><th>Status</th></tr></thead>
              <tbody>
                {benefits.map((b) => (
                  <tr key={b.benefitId}>
                    <td>{b.status === 'prepared' ? <input type="checkbox" name="benefitId" value={b.benefitId} /> : null}</td>
                    <td>{date(b.providedOn)}</td>
                    <td>{b.name}</td>
                    <td>{b.ppsn ?? `no PPSN: ${b.address ?? ''} ${b.dateOfBirth ?? ''}`} / {b.employerReference}</td>
                    <td>{label(b.category, b.subcategory)}</td>
                    <td className="num">{money(b.amountMinor, 'EUR')}</td>
                    <td>{b.days ?? ''}</td>
                    <td><Badge tone={b.status === 'submitted' ? 'positive' : b.providedOn < today ? 'negative' : 'caution'}>{b.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex gap-2 mt-2">
              <Input name="submittedOn" type="date" required defaultValue={today} className={small} />
              <Input name="reference" required placeholder="ROS reference" className={small} />
            </div>
          </ActionForm>
        )}
        {benefits.length > 0 && (
          <div className="mt-3">
            <Disclosure summary="Correct a benefit">
              <ActionForm action={correctReportableBenefitAction} submit="Supersede with a correction" inline>
                <select name="benefitId" required defaultValue="" className={small}>
                  <option value="" disabled>Benefit</option>
                  {benefits.map((b) => <option key={b.benefitId} value={b.benefitId}>{date(b.providedOn)} {b.name} {money(b.amountMinor, 'EUR')}</option>)}
                </select>
                <Input name="amount" placeholder="Corrected amount" className={small} />
                <Input name="reason" required placeholder="Why" className={small} />
              </ActionForm>
            </Disclosure>
          </div>
        )}
        <div className="mt-3">
          <ActionForm action={reconcileErrAction} submit="Reconcile reportable benefits" inline variant="secondary">
            <Input name="asOf" type="date" required defaultValue={today} className={small} />
          </ActionForm>
        </div>
      </Panel>
    </Page>
  );
}
