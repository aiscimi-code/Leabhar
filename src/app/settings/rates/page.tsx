import { taxRateList, vatTreatmentList } from '@/lib/queries';
import {
  Page, Panel, Badge, Help, Field, Input, Textarea, Disclosure,
} from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import {
  supersedeTaxRateAction, createTaxRateAction, deactivateTaxRateAction, updateTreatmentAction,
} from '@/app/settings-actions';
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

        {rates.filter((taxRate) => taxRate.active && !taxRate.effectiveTo).map((taxRate) => (
          <Disclosure key={taxRate.id} summary={`Change ${taxRate.code} (${rate(taxRate.rateBasisPoints)})`}>
            <div className="grid grid-cols-2 gap-6 max-w-4xl">
              <div>
                <p className="text-ink-muted mb-3 leading-snug">
                  A new rate does not overwrite this one. The current row is closed off the
                  day before the new rate starts, and anything already posted keeps the rate
                  that applied on its own date.
                </p>
                <ActionForm action={supersedeTaxRateAction} submit="Set new rate"
                  extra={{ taxRateId: taxRate.id }}>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="New rate" hint="23, 23%, or 0.23 — all read the same.">
                      <Input name="newRate" required placeholder="23%" />
                    </Field>
                    <Field label="Takes effect from">
                      <Input name="effectiveFrom" type="date" required />
                    </Field>
                  </div>
                  <Field
                    label="Source"
                    help="Where you read this rate. A rate with no stated source is a rate
                      nobody can check later."
                  >
                    <Input name="sourceNote" placeholder="Revenue VAT rates database, checked …" />
                  </Field>
                </ActionForm>
              </div>

              <div>
                <p className="text-ink-muted mb-3 leading-snug">
                  Deactivating stops this rate being offered for new transactions. Historical
                  entries that used it are untouched and still report under it.
                </p>
                <ActionForm
                  action={deactivateTaxRateAction} submit="Deactivate" variant="danger"
                  extra={{ taxRateId: taxRate.id }}
                  confirm={`Stop offering ${taxRate.code} for new transactions? Existing entries keep it.`}
                />
              </div>
            </div>
          </Disclosure>
        ))}

        <Disclosure summary="Add a rate" tone="accent">
          <ActionForm action={createTaxRateAction} submit="Add rate" resetOnSuccess>
            <div className="grid grid-cols-4 gap-3 max-w-4xl">
              <Field label="Code"><Input name="code" required placeholder="VAT_13_5" /></Field>
              <Field label="Name"><Input name="name" required placeholder="Reduced rate" /></Field>
              <Field label="Rate"><Input name="rate" required placeholder="13.5%" /></Field>
              <Field label="Effective from">
                <Input name="effectiveFrom" type="date" required />
              </Field>
            </div>
            <div className="max-w-2xl">
              <Field label="Source" hint="Recorded with the rate and shown wherever it is used.">
                <Input name="sourceNote" />
              </Field>
            </div>
          </ActionForm>
        </Disclosure>
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

        {treatments.map((treatment) => (
          <Disclosure key={treatment.id} summary={`Edit ${treatment.code}`}>
            <ActionForm action={updateTreatmentAction} submit="Save treatment"
              extra={{ treatmentId: treatment.id }}>
              <div className="max-w-3xl">
                <Field label="Name"><Input name="name" defaultValue={treatment.name} /></Field>
                <Field label="Description">
                  <Textarea name="description" rows={2} defaultValue={treatment.description ?? ''} />
                </Field>
                <Field
                  label="Source"
                  help="The guidance this treatment is based on. Shown beside every figure
                    that reaches a VAT3 box through it."
                >
                  <Input name="sourceNote" defaultValue={treatment.sourceNote ?? ''} />
                </Field>
                <label className="flex items-center gap-2 text-[12px] text-ink mb-3">
                  <input type="checkbox" name="active" defaultChecked={treatment.active} />
                  Offered for new transactions
                </label>
                <p className="text-[11.5px] text-ink-muted leading-snug border-t border-line pt-2">
                  The VAT3 boxes and the recoverable proportion are not editable here. They
                  are what makes a figure land in T1 rather than T2, and changing them on a
                  treatment already used would silently restate a filed return. Add a new
                  treatment instead.
                </p>
              </div>
            </ActionForm>
          </Disclosure>
        ))}
      </Panel>
    </Page>
  );
}
