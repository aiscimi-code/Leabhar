import Link from 'next/link';
import { notFound } from 'next/navigation';
import { vatPeriodDetail } from '@/lib/queries';
import { Page, Panel, Badge, Figure, Help, Empty, LinkButton } from '@/components/primitives';
import { PeriodActions } from '@/components/PeriodActions';
import { money, date, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

const BOX_HELP: Record<string, string> = {
  T1: 'VAT charged on your sales, plus VAT you self-account for under the reverse charge.',
  T2: 'VAT you can reclaim on your purchases. This is the recoverable amount, not the amount charged — where a treatment restricts recovery, the difference is a real cost and is excluded here.',
  T3: 'The net amount payable to Revenue, when your VAT on sales exceeds your VAT on purchases.',
  T4: 'The net amount repayable to you, when your VAT on purchases exceeds your VAT on sales.',
  E1: 'The net value of goods you dispatched to businesses in other EU member states.',
  E2: 'The net value of goods you acquired from businesses in other EU member states.',
  ES1: 'The net value of services you supplied to businesses in other EU member states.',
  ES2: 'The net value of services you received from businesses in other EU member states.',
  PA1: 'The net value of goods imported under postponed accounting.',
};

/**
 * VAT period detail (README §23, §24, §25).
 *
 * Every figure links to the entries behind it. The validation panel says
 * "Internal checks passed" or "NOT READY" and never claims compliance.
 */
export default async function VatPeriodPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = vatPeriodDetail(id);
  if (!detail) notFound();

  const { period, report, validation, company } = detail;
  const currency = company.baseCurrency;

  const vatBoxes = [report.T1, report.T2, report.T3, report.T4];
  const statBoxes = [report.E1, report.E2, report.ES1, report.ES2, report.PA1]
    .filter((box) => box.entryCount > 0 || box.amountMinor !== 0);

  return (
    <Page
      title={`VAT period ${period.name}`}
      subtitle={
        <span>
          {date(period.startDate)} to {date(period.endDate)}
          {period.filingDeadline && <> · filing deadline {date(period.filingDeadline)}</>}
          {' · '}<Badge tone={period.status === 'submitted' ? 'positive' : 'neutral'}>
            {label(period.status)}
          </Badge>
        </span>
      }
      actions={
        <>
          <LinkButton href={`/vat/${id}/pack`}>Filing pack</LinkButton>
          <LinkButton href="/vat">All periods</LinkButton>
        </>
      }
    >
      <Panel
        tone={validation.ready ? 'positive' : 'negative'}
        title={validation.verdict}
        description={validation.summary}
      >
        {validation.findings.length > 0 && (
          <table className="ledger">
            <tbody>
              {validation.findings.map((finding) => (
                <tr key={finding.code}>
                  <td className="w-28">
                    <Badge tone={finding.severity === 'blocking' ? 'negative'
                      : finding.severity === 'warning' ? 'caution' : 'neutral'}>
                      {label(finding.severity)}
                    </Badge>
                  </td>
                  <td>
                    <div className="font-medium text-ink">{finding.title}</div>
                    <div className="text-ink-muted mt-0.5">{finding.detail}</div>
                  </td>
                  <td className="w-24 text-right">
                    <Link href="/review" className="text-accent hover:underline text-[12px]">
                      Resolve
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="px-4 py-2.5 text-[11.5px] text-ink-muted border-t border-line leading-snug">
          {validation.disclaimer}
        </p>
      </Panel>

      <div className="grid grid-cols-[1.3fr_1fr] gap-4 items-start">
        <Panel
          title="VAT3 figures"
          description="Every figure links to the entries behind it, and each entry links to its transaction and document."
        >
          <table className="ledger">
            <thead>
              <tr>
                <th className="w-16">Box</th>
                <th>Description</th>
                <th className="w-20 text-right">Entries</th>
                <th className="w-36 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {vatBoxes.map((box) => (
                <tr key={box.box}>
                  <td>
                    <Badge tone="accent">{box.box}</Badge>
                  </td>
                  <td>
                    {box.label}
                    {BOX_HELP[box.box] && <Help>{BOX_HELP[box.box]}</Help>}
                  </td>
                  <td className="text-right num text-ink-muted">
                    {box.box === 'T3' || box.box === 'T4' ? '' : box.entryCount}
                  </td>
                  <td className="text-right">
                    <Figure
                      value={money(box.amountMinor, currency)}
                      href={box.entryCount > 0 ? `/vat/${id}/box/${box.box}` : undefined}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {statBoxes.length > 0 && (
            <>
              <div className="px-4 py-1.5 bg-surface-sunken border-y border-line
                text-[11px] uppercase tracking-wide font-semibold text-ink-faint">
                Statistical boxes (net values, not VAT)
              </div>
              <table className="ledger">
                <tbody>
                  {statBoxes.map((box) => (
                    <tr key={box.box}>
                      <td className="w-16"><Badge tone="accent">{box.box}</Badge></td>
                      <td>
                        {box.label}
                        {BOX_HELP[box.box] && <Help>{BOX_HELP[box.box]}</Help>}
                      </td>
                      <td className="w-20 text-right num text-ink-muted">{box.entryCount}</td>
                      <td className="w-36 text-right">
                        <Figure
                          value={money(box.amountMinor, currency)}
                          href={`/vat/${id}/box/${box.box}`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Panel>

        <div>
          <Panel title="Period status">
            <div className="px-4 py-3">
              <PeriodActions
                vatPeriodId={period.id}
                status={period.status}
                ready={validation.ready}
              />
            </div>
          </Panel>

          <Panel title="Supporting analysis" description="Not part of the VAT3 itself.">
            <table className="ledger">
              <tbody>
                <tr>
                  <td>Net sales in this period</td>
                  <td className="text-right num">{money(report.salesNetMinor, currency)}</td>
                </tr>
                <tr>
                  <td>Net purchases in this period</td>
                  <td className="text-right num">{money(report.purchasesNetMinor, currency)}</td>
                </tr>
                <tr>
                  <td>
                    Self-accounted VAT (reverse charge)
                    <Help>
                      VAT you charged yourself on purchases from abroad. It appears in T1
                      and, where recoverable, the same amount appears in T2, so it usually
                      nets to nothing in cash terms.
                    </Help>
                  </td>
                  <td className="text-right num">{money(report.reverseChargeVatMinor, currency)}</td>
                </tr>
                <tr>
                  <td>
                    VAT charged but not reclaimable
                    <Help>
                      VAT a supplier charged you that you cannot reclaim, for example on
                      entertainment. It is a real cost and forms part of the expense.
                    </Help>
                  </td>
                  <td className="text-right num">{money(report.nonRecoverableVatMinor, currency)}</td>
                </tr>
                <tr className="font-semibold">
                  <td>Net position</td>
                  <td className="text-right num">
                    {money(Math.abs(report.netPositionMinor), currency)}
                    <span className="text-ink-muted font-normal ml-1">
                      {report.netPositionMinor >= 0 ? 'payable' : 'repayable'}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </Panel>

          {period.submittedAt && (
            <Panel title="As filed" description="Snapshotted when you marked this period submitted.">
              <table className="ledger">
                <tbody>
                  <tr><td>Submitted</td><td className="text-right">{date(period.submittedAt.slice(0, 10))}</td></tr>
                  {period.submissionReference && (
                    <tr><td>Reference</td><td className="text-right num">{period.submissionReference}</td></tr>
                  )}
                  <tr><td>T1 as filed</td><td className="text-right num">{money(period.filedT1Minor ?? 0, currency)}</td></tr>
                  <tr><td>T2 as filed</td><td className="text-right num">{money(period.filedT2Minor ?? 0, currency)}</td></tr>
                  <tr><td>T3 as filed</td><td className="text-right num">{money(period.filedT3Minor ?? 0, currency)}</td></tr>
                  <tr><td>T4 as filed</td><td className="text-right num">{money(period.filedT4Minor ?? 0, currency)}</td></tr>
                </tbody>
              </table>
              {(period.filedT3Minor !== report.T3.amountMinor
                || period.filedT2Minor !== report.T2.amountMinor) && (
                <div className="px-4 py-2 bg-caution-soft border-t border-caution/30 text-caution text-[12px]">
                  The current figures differ from what was filed. Something changed after
                  submission — check the audit trail before filing a correction.
                </div>
              )}
            </Panel>
          )}
        </div>
      </div>
    </Page>
  );
}
