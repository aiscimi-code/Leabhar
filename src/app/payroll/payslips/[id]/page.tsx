import { notFound } from 'next/navigation';
import { payslipPage } from '@/lib/payrollQueries';
import { requireActor } from '@/lib/session';
import { Page, Panel, Empty } from '@/components/primitives';
import { money, date } from '@/lib/format';

export const dynamic = 'force-dynamic';

const eur = (m: number) => money(m, 'EUR');

/** A payslip (issue #527), laid out to print: this period and the year to date. */
export default async function PayslipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await requireActor('payroll.read');
  } catch (e) {
    return <Page title="Payslip"><Panel><Empty title="Payroll is not open to your role" detail={e instanceof Error ? e.message : ''} /></Panel></Page>;
  }
  const detail = payslipPage(id);
  if (!detail) notFound();
  const { company, run, slip, employee } = detail;
  return (
    <Page title={`Payslip — ${employee.firstName} ${employee.lastName}`}
      subtitle={`${company.legalName} · paid ${date(run.payDate)} · ${run.payFrequency} period ${run.periodNumber} of ${run.taxYear}`}>
      <Panel title="Employee">
        <div className="text-[12.5px]">
          {employee.firstName} {employee.lastName} · PPSN {employee.ppsn ?? 'not given'} · reference {employee.employerReference}
          {' · '}tax basis {slip.taxBasis.replace(/_/g, ' ')} · PRSI Class {slip.prsiClass}
          {run.status !== 'posted' ? ` · ${run.status.toUpperCase()}` : ''}
        </div>
      </Panel>
      <Panel title="This period">
        <table className="ledger">
          <tbody>
            {slip.lines.map((l) => <tr key={l.id}><td>{l.description}</td><td className="num">{eur(l.amountMinor)}</td></tr>)}
            <tr><td>Gross pay</td><td className="num">{eur(slip.grossPayMinor)}</td></tr>
            {slip.pensionEmployeeMinor > 0 && <tr><td>Pension contribution</td><td className="num">−{eur(slip.pensionEmployeeMinor)}</td></tr>}
            <tr><td>PAYE</td><td className="num">{slip.taxMinor < 0 ? `+${eur(-slip.taxMinor)}` : `−${eur(slip.taxMinor)}`}</td></tr>
            <tr><td>USC</td><td className="num">{slip.uscMinor < 0 ? `+${eur(-slip.uscMinor)}` : `−${eur(slip.uscMinor)}`}</td></tr>
            <tr><td>PRSI</td><td className="num">−{eur(slip.prsiEmployeeMinor)}</td></tr>
            <tr><td className="font-medium">Net pay</td><td className="num font-medium">{eur(slip.netPayMinor)}</td></tr>
          </tbody>
        </table>
      </Panel>
      <Panel title="Year to date">
        <table className="ledger">
          <tbody>
            <tr><td>Pay for income tax</td><td className="num">{eur(slip.cumulativePayForTaxMinor)}</td></tr>
            <tr><td>Income tax</td><td className="num">{eur(slip.cumulativeTaxMinor)}</td></tr>
            <tr><td>Pay for USC</td><td className="num">{eur(slip.cumulativePayForUscMinor)}</td></tr>
            <tr><td>USC</td><td className="num">{eur(slip.cumulativeUscMinor)}</td></tr>
            <tr><td>Standard rate cut-off point / tax credits used</td><td className="num">{eur(slip.cumulativeSrcopMinor)} / {eur(slip.cumulativeCreditsMinor)}</td></tr>
          </tbody>
        </table>
      </Panel>
    </Page>
  );
}
