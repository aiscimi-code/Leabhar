import Link from 'next/link';
import { notFound } from 'next/navigation';
import { payRunPage } from '@/lib/payrollQueries';
import { requireActor } from '@/lib/session';
import { Page, Panel, Badge, Empty, Field, Input, Select, Disclosure } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import {
  setPayInputsAction, removeFromPayRunAction, recomputePayRunAction, postPayRunAction, reversePayRunAction, payNetWagesAction,
} from '@/app/payroll-actions';
import { money, date } from '@/lib/format';

export const dynamic = 'force-dynamic';

const small = 'border border-line-strong rounded px-2 py-1 text-[12px]';
const eur = (m: number) => money(m, 'EUR');

/** One pay run (issue #527): its payslips, their working, and the lifecycle actions. */
export default async function PayRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await requireActor('payroll.read');
  } catch (e) {
    return <Page title="Pay run"><Panel><Empty title="Payroll is not open to your role" detail={e instanceof Error ? e.message : ''} /></Panel></Page>;
  }
  const detail = payRunPage(id);
  if (!detail) notFound();
  const { run, totals, payslips, bankLines } = detail;
  const draft = run.status === 'draft';

  return (
    <Page
      title={`Pay run ${date(run.payDate)}`}
      subtitle={`${run.payFrequency} period ${run.periodNumber} of ${run.taxYear} (${date(run.periodStart)} to ${date(run.periodEnd)}), `
        + `${run.insurableWeeks} insurable week(s).`}
    >
      <Panel title="Totals" actions={<Badge tone={run.status === 'posted' ? 'positive' : run.status === 'reversed' ? 'negative' : 'caution'}>{run.status}</Badge>}>
        <table className="ledger">
          <tbody>
            <tr><td>Gross pay</td><td className="num">{eur(totals.grossPayMinor)}</td></tr>
            <tr><td>Benefits in kind (taxed, not paid)</td><td className="num">{eur(totals.notionalPayMinor)}</td></tr>
            <tr><td>PAYE</td><td className="num">{eur(totals.taxMinor)}</td></tr>
            <tr><td>USC</td><td className="num">{eur(totals.uscMinor)}</td></tr>
            <tr><td>Employee PRSI</td><td className="num">{eur(totals.prsiEmployeeMinor)}</td></tr>
            <tr><td>Employer PRSI and NTF levy</td><td className="num">{eur(totals.prsiEmployerMinor)}</td></tr>
            <tr><td>Pension (employee / employer)</td><td className="num">{eur(totals.pensionEmployeeMinor)} / {eur(totals.pensionEmployerMinor)}</td></tr>
            <tr><td className="font-medium">Net pay</td><td className="num font-medium">{eur(totals.netPayMinor)}</td></tr>
            <tr><td className="font-medium">Due to Revenue</td><td className="num font-medium">{eur(totals.dueToRevenueMinor)}</td></tr>
          </tbody>
        </table>
        <div className="flex gap-4 mt-3 flex-wrap items-end">
          {draft && (
            <>
              <ActionForm action={recomputePayRunAction} submit="Recompute" inline variant="secondary" extra={{ runId: run.id }} />
              <ActionForm action={postPayRunAction} submit="Post pay run" inline extra={{ runId: run.id }}
                confirm="Posting fixes every payslip and posts the payroll journal. A posted run can only be reversed." />
            </>
          )}
          {run.status === 'posted' && !run.netPaidOn && (
            <>
              <ActionForm action={payNetWagesAction} submit="Record net pay paid" inline extra={{ runId: run.id }}>
                <select name="bankTransactionId" defaultValue="" className={small}>
                  <option value="">From a bank line…</option>
                  {bankLines.map((l) => <option key={l.id} value={l.id}>{date(l.transactionDate)} {l.description} {money(l.amountMinor, l.currency)}</option>)}
                </select>
                <Input name="date" type="date" className={small} />
              </ActionForm>
              <ActionForm action={reversePayRunAction} submit="Reverse run" inline variant="danger" extra={{ runId: run.id }}
                confirm="Reversing posts a reversing journal and takes these payslips out of the year's figures.">
                <Input name="reason" required placeholder="What was wrong" className={small} />
              </ActionForm>
            </>
          )}
          {run.netPaidOn && <span className="text-[12px] text-ink-muted">Net pay paid {date(run.netPaidOn)}.</span>}
          {run.status === 'reversed' && <span className="text-[12px] text-ink-muted">Reversed: {run.reversalReason}</span>}
        </div>
      </Panel>

      {payslips.map((p) => (
        <Panel key={p.id} title={p.employeeName}
          description={`Tax basis ${p.taxBasis.replace(/_/g, ' ')}, USC ${p.uscBasis}, PRSI Class ${p.prsiClass}.`}
          actions={<Link href={`/payroll/payslips/${p.id}`} className="text-[12px]">Payslip</Link>}>
          <table className="ledger">
            <thead><tr><th>Pay</th><th className="text-right">Amount</th></tr></thead>
            <tbody>
              {p.lines.map((l) => <tr key={l.id}><td>{l.description}</td><td className="num">{eur(l.amountMinor)}</td></tr>)}
              <tr><td>Pension (employee)</td><td className="num">−{eur(p.pensionEmployeeMinor)}</td></tr>
              <tr><td>PAYE</td><td className="num">{p.taxMinor < 0 ? `+${eur(-p.taxMinor)} refund` : `−${eur(p.taxMinor)}`}</td></tr>
              <tr><td>USC</td><td className="num">{p.uscMinor < 0 ? `+${eur(-p.uscMinor)} refund` : `−${eur(p.uscMinor)}`}</td></tr>
              <tr><td>PRSI</td><td className="num">−{eur(p.prsiEmployeeMinor)}</td></tr>
              <tr><td className="font-medium">Net pay</td><td className="num font-medium">{eur(p.netPayMinor)}</td></tr>
            </tbody>
          </table>
          <Disclosure summary="Working and the rules used">
            <ul className="text-[12px] list-disc pl-5 space-y-1">{p.working.map((w, i) => <li key={i}>{w}</li>)}</ul>
            <div className="text-[11.5px] text-ink-muted mt-2">Rules: {p.ruleFigures.map((f) => `${f.ruleKey} (${f.status})`).join(', ')}</div>
          </Disclosure>
          {p.findings.length > 0 && (
            <ul className="text-[12px] list-disc pl-5 mt-2 text-caution">{p.findings.map((f, i) => <li key={i}>{f}</li>)}</ul>
          )}
          {draft && (
            <div className="mt-2">
              <Disclosure summary="Hours, overtime, bonuses and benefits for this period">
                <ActionForm action={setPayInputsAction} submit="Recompute payslip" extra={{ runId: run.id, employeeId: p.employeeId }}>
                  <div className="grid grid-cols-3 gap-3 max-w-3xl">
                    <Field label="Hours at the basic rate" hint="Hourly employments"><Input name="hours" type="number" step="0.01" min="0" /></Field>
                    <Field label="Salary for a part period (EUR)" hint="Replaces the period's share"><Input name="salaryOverride" placeholder="0.00" /></Field>
                    <Field label="Overtime hours × multiplier" help="No premium is assumed: 1.5 is time and a half.">
                      <div className="flex gap-2"><Input name="overtimeHours" type="number" step="0.01" min="0" /><Input name="overtimeMultiplier" placeholder="1.5" /></div>
                    </Field>
                    <Field label="Bonus / commission (EUR)">
                      <div className="flex gap-2"><Input name="bonus" placeholder="0.00" /><Input name="commission" placeholder="0.00" /></div>
                    </Field>
                    <Field label="Benefit in kind (EUR)" help="The period's taxable value. It is taxed but never paid in cash.">
                      <div className="flex gap-2">
                        <Select name="benefitCategory" defaultValue="other">
                          <option value="car">Car</option><option value="van">Van</option><option value="preferential_loan">Preferential loan</option>
                          <option value="employer_asset">Employer asset</option><option value="other">Other</option>
                        </Select>
                        <Input name="benefit" placeholder="0.00" />
                      </div>
                    </Field>
                    <Field label="Benefit description"><Input name="benefitDescription" /></Field>
                  </div>
                </ActionForm>
                <div className="mt-2">
                  <ActionForm action={removeFromPayRunAction} submit="Take off this run" inline variant="danger" extra={{ runId: run.id, employeeId: p.employeeId }} />
                </div>
              </Disclosure>
            </div>
          )}
        </Panel>
      ))}
    </Page>
  );
}
