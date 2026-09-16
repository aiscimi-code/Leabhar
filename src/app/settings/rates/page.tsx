import { taxRateList, vatTreatmentList } from '@/lib/queries';
import { Page, Panel, Badge, Help } from '@/components/primitives';
import { rate, date, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** Tax rates and VAT treatments (README §6, §7). */
export default function RatesPage() {
  const rates = taxRateList();
  const treatments = vatTreatmentList();

  return (
    <Page
      title="Tax rates and VAT treatments"
      subtitle="No rate is built into this application's logic. Changing a rate adds a new
        effective-dated row rather than editing the old one, so historical transactions keep
        the rate that applied when they happened."
    >
      <Panel
        title="Tax rates"
        description="Verify these against current Revenue guidance before relying on them.
          They are a starting point, not an authority."
      >
        <table className="ledger">
          <thead>
            <tr>
              <th className="w-32">Code</th>
              <th>Name</th>
              <th className="w-20 text-right">Rate</th>
              <th className="w-28">Type</th>
              <th className="w-28">From</th>
              <th className="w-28">To</th>
              <th className="w-24">Status</th>
              <th className="w-24">Source</th>
            </tr>
          </thead>
          <tbody>
            {rates.map((taxRate) => (
              <tr key={taxRate.id}>
                <td className="num !text-left">{taxRate.code}</td>
                <td>
                  {taxRate.name}
                  {taxRate.notes && (
                    <div className="text-[11px] text-ink-faint mt-0.5 max-w-2xl leading-snug">
                      {taxRate.notes}
                    </div>
                  )}
                </td>
                <td className="text-right num font-medium">{rate(taxRate.rateBasisPoints)}</td>
                <td className="text-ink-muted">{label(taxRate.taxType)}</td>
                <td className="num !text-left">{date(taxRate.effectiveFrom)}</td>
                <td className="num !text-left text-ink-muted">
                  {taxRate.effectiveTo ? date(taxRate.effectiveTo) : 'current'}
                </td>
                <td>
                  <div className="flex gap-1 flex-wrap">
                    {taxRate.isDefault && <Badge tone="accent">Default</Badge>}
                    {!taxRate.active && <Badge tone="neutral">Inactive</Badge>}
                  </div>
                </td>
                <td>
                  {taxRate.sourceNote && (
                    <Help>
                      {taxRate.sourceNote}
                      {taxRate.sourceDate && ` (recorded ${taxRate.sourceDate})`}
                    </Help>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel
        title="VAT treatments"
        description="A transaction carries a treatment, not merely a percentage. The treatment
          decides which VAT3 box the figures land in and whether the VAT is recoverable."
      >
        <table className="ledger">
          <thead>
            <tr>
              <th className="w-44">Code</th>
              <th>Treatment</th>
              <th className="w-20">Where</th>
              <th className="w-24">Direction</th>
              <th className="w-28">VAT3 boxes</th>
              <th className="w-28">Recoverable</th>
            </tr>
          </thead>
          <tbody>
            {treatments.map((treatment) => (
              <tr key={treatment.id}>
                <td className="num !text-left">{treatment.code}</td>
                <td>
                  <div className="font-medium text-ink">{treatment.name}</div>
                  {treatment.description && (
                    <div className="text-ink-muted mt-0.5 max-w-3xl leading-snug">
                      {treatment.description}
                    </div>
                  )}
                  {treatment.sourceNote && (
                    <div className="text-[11px] text-ink-faint mt-1 leading-snug">
                      Source: {treatment.sourceNote}
                    </div>
                  )}
                </td>
                <td>
                  <Badge tone={treatment.jurisdiction === 'IE' ? 'neutral' : 'accent'}>
                    {treatment.jurisdiction}
                  </Badge>
                </td>
                <td className="text-ink-muted">{label(treatment.direction)}</td>
                <td>
                  <div className="flex gap-1 flex-wrap">
                    {treatment.salesVatBox && <Badge tone="accent">{treatment.salesVatBox}</Badge>}
                    {treatment.purchasesVatBox && <Badge tone="accent">{treatment.purchasesVatBox}</Badge>}
                    {treatment.netSalesBox && <Badge tone="neutral">{treatment.netSalesBox}</Badge>}
                    {treatment.netPurchasesBox && <Badge tone="neutral">{treatment.netPurchasesBox}</Badge>}
                    {!treatment.salesVatBox && !treatment.purchasesVatBox
                      && !treatment.netSalesBox && !treatment.netPurchasesBox && (
                      <span className="text-ink-faint">Not reported</span>
                    )}
                  </div>
                </td>
                <td>
                  {treatment.isReverseCharge && <Badge tone="accent">Reverse charge</Badge>}
                  {!treatment.isRecoverable && <Badge tone="caution">Not recoverable</Badge>}
                  {treatment.isRecoverable && treatment.recoverableBasisPoints < 10000 && (
                    <Badge tone="caution">{treatment.recoverableBasisPoints / 100}%</Badge>
                  )}
                  {treatment.isRecoverable && treatment.recoverableBasisPoints >= 10000
                    && !treatment.isReverseCharge && (
                    <span className="text-ink-muted">Fully</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </Page>
  );
}
