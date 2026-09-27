import Link from 'next/link';
import { activeCompany } from '@/lib/queries';
import { payrollPage } from '@/lib/payrollQueries';
import { requireActor } from '@/lib/session';
import { Page, Panel, Badge, Empty, Field, Input, Select, Disclosure } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import {
  createEmployeeAction, setEmploymentTermsAction, recordRpnAction, recordPpsnAction, recordCessationAction,
  createPayRunAction, payPayrollTaxesAction, reconcilePayrollAction,
} from '@/app/payroll-actions';
import { money, date } from '@/lib/format';

export const dynamic = 'force-dynamic';

const small = 'border border-line-strong rounded px-2 py-1 text-[12px]';

/**
 * Payroll (EPIC 20): employees, their terms and RPNs, pay runs, and what is
 * owed to Revenue each month. Every figure is the payroll domain's; this page
 * renders it.
 */
export default async function PayrollPage() {
  if (!activeCompany()) return <Page title="Payroll"><Panel><Empty title="No company yet" /></Panel></Page>;
  try {
    await requireActor('payroll.read');
  } catch (e) {
    return <Page title="Payroll"><Panel><Empty title="Payroll is not open to your role" detail={e instanceof Error ? e.message : ''} /></Panel></Page>;
  }
  const { employees, runs, months, bankLines } = payrollPage();
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page
      title="Payroll"
      subtitle="PAYE, USC and PRSI deducted on each pay date from the employee's RPN and the statutory rules. RPNs are
        copied from ROS by hand until Leabhar retrieves them itself (#528); payroll submissions are not yet sent to Revenue."
    >
      <Panel title="Employees" description="Who is employed, on what terms, and the RPN each payslip is calculated from.">
        {employees.length === 0 ? (
          <Empty title="No employees" detail="Record an employee, their pay terms, and their RPN from ROS." />
        ) : (
          <div className="space-y-3">
            {employees.map((e) => {
              const terms = e.terms.at(-1);
              const rpn = e.rpns[0];
              return (
                <div key={e.id} className="border border-line-strong rounded p-3">
                  <div className="flex justify-between flex-wrap gap-2">
                    <div>
                      <div className="font-medium">{e.firstName} {e.lastName} <span className="text-ink-muted text-[11.5px]">· {e.employerReference}</span></div>
                      <div className="text-[11.5px] text-ink-muted">
                        {e.ppsn ? `PPSN ${e.ppsn}` : 'No PPSN: emergency tax at the higher rate'} · paid {e.payFrequency} · from {date(e.startDate)}
                        {e.leftOn ? ` · left ${date(e.leftOn)}` : ''}{e.isDirector ? (e.isProprietaryDirector ? ' · proprietary director' : ' · director') : ''}
                      </div>
                      <div className="text-[11.5px] text-ink-muted">
                        {terms ? (terms.payBasis === 'salary'
                          ? `Salary ${money(terms.annualSalaryMinor!, 'EUR')} a year`
                          : `${money(terms.hourlyRateMinor!, 'EUR')} an hour`) + (terms.pensionScheme !== 'none' ? ` · ${terms.pensionScheme} pension` : '')
                          : 'No pay terms recorded'}
                        {' · '}
                        {rpn ? `RPN ${rpn.rpnNumber} (${rpn.taxYear}, ${rpn.taxBasis}) from ${date(rpn.effectiveFrom)}` : 'No RPN: emergency basis'}
                      </div>
                    </div>
                    {e.leftOn ? <Badge tone="neutral">ceased</Badge> : <Badge tone="positive">employed</Badge>}
                  </div>
                  <div className="mt-2 space-y-2">
                    <Disclosure summary="Pay terms from a date">
                      <ActionForm action={setEmploymentTermsAction} submit="Record terms" extra={{ employeeId: e.id }} resetOnSuccess>
                        <div className="grid grid-cols-3 gap-3 max-w-3xl">
                          <Field label="From"><Input name="effectiveFrom" type="date" required defaultValue={today} /></Field>
                          <Field label="Pay basis">
                            <Select name="payBasis" defaultValue="salary"><option value="salary">Annual salary</option><option value="hourly">Hourly rate</option></Select>
                          </Field>
                          <Field label="Salary a year, or rate an hour (EUR)"><Input name="amount" required placeholder="0.00" /></Field>
                          <Field label="Hourly rate for overtime (salaried, EUR)" hint="Optional"><Input name="hourlyRate" placeholder="0.00" /></Field>
                          <Field label="Pension scheme" help="Contributions under an occupational scheme, PRSA or RAC come off pay for income tax only (S.I. 345/2018 reg.31).">
                            <Select name="pensionScheme" defaultValue="none">
                              <option value="none">None</option><option value="occupational">Occupational</option>
                              <option value="prsa">PRSA</option><option value="rac">RAC</option>
                            </Select>
                          </Field>
                          <Field label="Employee / employer contribution (%)">
                            <div className="flex gap-2"><Input name="pensionEmployeePct" placeholder="5" /><Input name="pensionEmployerPct" placeholder="5" /></div>
                          </Field>
                        </div>
                      </ActionForm>
                    </Disclosure>
                    <Disclosure summary="Record an RPN from ROS">
                      <ActionForm action={recordRpnAction} submit="Record RPN" extra={{ employeeId: e.id }} resetOnSuccess>
                        <div className="grid grid-cols-3 gap-3 max-w-3xl">
                          <Field label="RPN number"><Input name="rpnNumber" required /></Field>
                          <Field label="Applies from"><Input name="effectiveFrom" type="date" required defaultValue={today} /></Field>
                          <Field label="Basis">
                            <Select name="taxBasis" defaultValue="cumulative">
                              <option value="cumulative">Cumulative</option><option value="week1">Week 1 / month 1</option><option value="emergency">Emergency</option>
                            </Select>
                          </Field>
                          <Field label="Tax credits a year (EUR)"><Input name="credits" required placeholder="4000.00" /></Field>
                          <Field label="Standard rate cut-off point a year (EUR)"><Input name="srcop" required placeholder="44000.00" /></Field>
                          <Field label="USC rates and bands" help="Rate:band pairs as ROS lists them, the last rate without a band.">
                            <Input name="uscBands" placeholder="0.5:12012,2:16688,3:41344,8" />
                          </Field>
                          <Field label="USC exempt"><input type="checkbox" name="uscExempt" /></Field>
                          <Field label="Previous employments: pay / tax (EUR)">
                            <div className="flex gap-2"><Input name="previousPay" placeholder="0.00" /><Input name="previousTax" placeholder="0.00" /></div>
                          </Field>
                          <Field label="Previous employments: USC pay / USC (EUR)">
                            <div className="flex gap-2"><Input name="previousUscPay" placeholder="0.00" /><Input name="previousUsc" placeholder="0.00" /></div>
                          </Field>
                        </div>
                      </ActionForm>
                    </Disclosure>
                    <div className="flex gap-4 flex-wrap">
                      {!e.ppsn && (
                        <ActionForm action={recordPpsnAction} submit="Record PPSN" inline extra={{ employeeId: e.id }}>
                          <Input name="ppsn" required placeholder="1234567T" className={small} />
                        </ActionForm>
                      )}
                      {!e.leftOn && (
                        <ActionForm action={recordCessationAction} submit="Record leaving date" inline variant="secondary" extra={{ employeeId: e.id }}
                          confirm="The employee will be left off pay runs after this date.">
                          <Input name="leftOn" type="date" required className={small} />
                        </ActionForm>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="mt-3">
          <Disclosure summary="New employee" tone="accent">
            <ActionForm action={createEmployeeAction} submit="Record employee" resetOnSuccess>
              <div className="grid grid-cols-3 gap-3 max-w-3xl">
                <Field label="First name"><Input name="firstName" required /></Field>
                <Field label="Surname"><Input name="lastName" required /></Field>
                <Field label="PPSN" help="Checked against its check character. Without one, tax is deducted at the higher rate (S.I. 345/2018 reg.19(2)).">
                  <Input name="ppsn" placeholder="1234567T" />
                </Field>
                <Field label="Employer reference" help="Your staff identifier, reported with every payment."><Input name="employerReference" required /></Field>
                <Field label="Started"><Input name="startDate" type="date" required defaultValue={today} /></Field>
                <Field label="Paid">
                  <Select name="payFrequency" defaultValue="monthly">
                    <option value="weekly">Weekly</option><option value="fortnightly">Fortnightly</option><option value="monthly">Monthly</option>
                  </Select>
                </Field>
                <Field label="Date of birth" hint="Required without a PPSN"><Input name="dateOfBirth" type="date" /></Field>
                <Field label="Address" hint="Required without a PPSN"><Input name="address" /></Field>
                <Field label="Email"><Input name="email" type="email" /></Field>
                <Field label="Director"><input type="checkbox" name="isDirector" /></Field>
                <Field label="Proprietary director"><input type="checkbox" name="isProprietaryDirector" /></Field>
              </div>
            </ActionForm>
          </Disclosure>
        </div>
      </Panel>

      <Panel title="Pay runs" description="A draft is computed and can be changed; posting fixes it and posts the payroll journal.">
        <Disclosure summary="New pay run" tone="accent">
          <ActionForm action={createPayRunAction} submit="Create draft run" resetOnSuccess>
            <div className="grid grid-cols-3 gap-3 max-w-3xl">
              <Field label="Frequency">
                <Select name="payFrequency" defaultValue="monthly">
                  <option value="weekly">Weekly</option><option value="fortnightly">Fortnightly</option><option value="monthly">Monthly</option>
                </Select>
              </Field>
              <Field label="Pay date"><Input name="payDate" type="date" required defaultValue={today} /></Field>
              <Field label="PRSI insurable weeks" help="Needed for a monthly run (4 or 5). Weekly is 1, fortnightly 2. See issue #529.">
                <Input name="insurableWeeks" type="number" min="1" max="5" />
              </Field>
            </div>
          </ActionForm>
        </Disclosure>
        {runs.length === 0 ? (
          <Empty title="No pay runs yet" />
        ) : (
          <table className="ledger mt-3">
            <thead><tr><th>Pay date</th><th>Run</th><th>Status</th><th className="text-right">Gross</th><th className="text-right">Net pay</th><th className="text-right">Due to Revenue</th></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/payroll/runs/${r.id}`}>{date(r.payDate)}</Link></td>
                  <td>{r.payFrequency} period {r.periodNumber}, {r.taxYear} · {r.totals.payslips} payslip(s)</td>
                  <td><Badge tone={r.status === 'posted' ? 'positive' : r.status === 'reversed' ? 'negative' : 'caution'}>{r.status}</Badge>
                    {r.status === 'posted' && !r.netPaidOn ? <span className="text-[11px] text-ink-muted"> net pay unpaid</span> : null}</td>
                  <td className="num">{money(r.totals.grossPayMinor, 'EUR')}</td>
                  <td className="num">{money(r.totals.netPayMinor, 'EUR')}</td>
                  <td className="num">{money(r.totals.dueToRevenueMinor, 'EUR')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Revenue, month by month" description="What Revenue's monthly statement should show: the posted runs by pay date.">
        {months.length === 0 ? <Empty title="Nothing posted yet" /> : (
          <table className="ledger">
            <thead><tr><th>Month</th><th className="text-right">PAYE</th><th className="text-right">USC</th><th className="text-right">PRSI</th><th className="text-right">Total</th><th>Paid</th></tr></thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month}>
                  <td>{m.month}{m.draftRuns ? <span className="text-[11px] text-ink-muted"> · {m.draftRuns} draft</span> : null}</td>
                  <td className="num">{money(m.totals.taxMinor, 'EUR')}</td>
                  <td className="num">{money(m.totals.uscMinor, 'EUR')}</td>
                  <td className="num">{money(m.totals.prsiEmployeeMinor + m.totals.prsiEmployerMinor, 'EUR')}</td>
                  <td className="num">{money(m.totals.dueToRevenueMinor, 'EUR')}</td>
                  <td>
                    {m.remittance ? `Paid ${date(m.remittance.paidOn)}` : (
                      <ActionForm action={payPayrollTaxesAction} submit="Record payment" inline extra={{ month: m.month }}>
                        <select name="bankTransactionId" defaultValue="" className={small}>
                          <option value="">From a bank line…</option>
                          {bankLines.map((l) => <option key={l.id} value={l.id}>{date(l.transactionDate)} {l.description} {money(l.amountMinor, l.currency)}</option>)}
                        </select>
                        <Input name="date" type="date" className={small} />
                      </ActionForm>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-3">
          <ActionForm action={reconcilePayrollAction} submit="Reconcile payroll accounts" inline variant="secondary">
            <Input name="asOf" type="date" required defaultValue={today} className={small} />
          </ActionForm>
        </div>
      </Panel>
    </Page>
  );
}
