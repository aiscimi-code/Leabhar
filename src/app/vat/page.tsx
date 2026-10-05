import { vatBasisOn } from '@/domain/vat/basis';
import Link from 'next/link';
import { vatPeriodList, companyContext, chartOfAccounts, deemedSupplyTreatments } from '@/lib/queries';
import {
  Page, Panel, Badge, Figure, Help, Empty, Disclosure, Field, Input, Select,
} from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { recordDeemedSupplyAction } from '@/app/actions';
import { money, date, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** VAT periods (README §8, §23). */
export default function VatPeriodsPage() {
  const periods = vatPeriodList();
  const { company } = companyContext();
  // The basis in force today, from the recorded authorisation (issue #608),
  // not the profile's choice alone.
  const today = new Date().toISOString().slice(0, 10);
  const basisToday = vatBasisOn(company, today);
  const accountOptions = chartOfAccounts().filter((account) => account.active).map((account) => (
    <option key={account.id} value={account.id}>{account.code} — {account.name}</option>
  ));
  const treatmentOptions = deemedSupplyTreatments().map((treatment) => (
    <option key={treatment.id} value={treatment.code}>{treatment.code} — {treatment.name}</option>
  ));

  return (
    <Page
      title="VAT periods"
      subtitle={
        <span>
          {company.legalName} files on the{' '}
          <strong>{label(basisToday)}</strong>
          {company.vatAccountingBasis === 'cash_receipts' && basisToday === 'invoice' && (
            <>
              {' '}<Badge tone="caution">Cash receipts chosen, no authorisation in force</Badge>
            </>
          )}
          <Help>
            On the cash receipts basis, VAT on your sales arises when you are paid rather
            than when you invoice, so an invoice issued in one period and paid in the next
            belongs to the later period. VAT on your purchases is reclaimed by reference to
            the supplier&rsquo;s invoice date under either basis.
          </Help>
          {' '}at {label(company.vatPeriodFrequency)} intervals.
        </span>
      }
    >
      <Panel>
        {periods.length === 0 ? (
          <Empty title="No VAT periods configured" detail="Set them up in company settings." />
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th>Period</th>
                <th className="w-28">From</th>
                <th className="w-28">To</th>
                <th className="w-28">Filing deadline</th>
                <th className="w-24 text-right">Entries</th>
                <th className="w-32 text-right">Net position</th>
                <th className="w-28">Status</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((period) => (
                <tr key={period.periodId}>
                  <td>
                    <Link href={`/vat/${period.periodId}`}
                      className="text-accent hover:underline font-medium">
                      {period.name}
                    </Link>
                  </td>
                  <td className="num !text-left">{date(period.startDate)}</td>
                  <td className="num !text-left">{date(period.endDate)}</td>
                  <td className="num !text-left text-ink-muted">
                    {date((period as unknown as { filingDeadline?: string }).filingDeadline ?? null)}
                  </td>
                  <td className="text-right num">{period.entryCount}</td>
                  <td className="text-right">
                    <Figure
                      value={period.netPositionMinor === 0 ? money(0, company.baseCurrency)
                        : money(Math.abs(period.netPositionMinor), company.baseCurrency)}
                      href={`/vat/${period.periodId}`}
                      title={period.netPositionMinor >= 0
                        ? 'Payable to Revenue' : 'Repayable to you'}
                    />
                    <span className="text-[11px] text-ink-faint ml-1">
                      {period.entryCount === 0 ? '' : period.netPositionMinor >= 0 ? 'payable' : 'repayable'}
                    </span>
                  </td>
                  <td>
                    <Badge tone={period.status === 'submitted' ? 'positive'
                      : period.status === 'locked' || period.status === 'ready' ? 'accent'
                      : 'neutral'}>
                      {label(period.status)}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel
        title="Deemed supplies"
        description="Output VAT on goods given away or taken out of the business, and on private use of
          business property, where no sale invoice exists. You state the facts; whether VAT is due,
          the taxable amount and the VAT are worked out from them. Each one posts as a VAT
          adjustment and goes to the review queue."
      >
        <Disclosure summary="Goods given away or taken for private use" tone="accent">
          <ActionForm action={recordDeemedSupplyAction} submit="Record deemed supply"
            extra={{ kind: 'goods' }} resetOnSuccess>
            <div className="grid grid-cols-2 gap-3 max-w-4xl">
              <Field label="What happened" help="A gift is a disposal free of charge. Private use is
                goods appropriated for a non-business purpose (VATCA s.19(1)(g)).">
                <Select name="use" required defaultValue="">
                  <option value="" disabled>Choose</option>
                  <option value="gift">Given away as a gift</option>
                  <option value="private_use">Taken for private or non-business use</option>
                </Select>
              </Field>
              <Field label="Date" hint="The day the goods were given or taken.">
                <Input name="date" type="date" defaultValue={today} required />
              </Field>
              <Field label="Cost excluding VAT" hint={`In ${company.baseCurrency}: what the goods cost the
                business (s.42(1)(a)).`}>
                <Input name="cost" required placeholder="0.00" />
              </Field>
              <Field label="Rate the goods would bear" hint="The rate they would be sold at.">
                <Select name="treatmentCode" required defaultValue="">
                  <option value="" disabled>Choose a rate</option>
                  {treatmentOptions}
                </Select>
              </Field>
              <Field label="Account charged" hint="Drawings, a director's loan, or gifts and entertainment.">
                <Select name="accountId" required defaultValue="">
                  <option value="" disabled>Choose an account</option>
                  {accountOptions}
                </Select>
              </Field>
              <Field label="Description">
                <Input name="description" required placeholder="Christmas hamper for a client" />
              </Field>
              <YesNo name="taxDeductedOrTransferred" label="VAT on the goods was deducted, or they came in a
                transfer of a business" />
              <YesNo name="partOfSeriesToSamePerson" giftOnly label="A gift only: one of a series of gifts to the same
                person" />
              <YesNo name="industrialSamples" giftOnly label="A gift only: industrial samples, in a form not sold to
                the public" />
            </div>
          </ActionForm>
        </Disclosure>
        <Disclosure summary="Private use of business property acquired before 2011">
          <ActionForm action={recordDeemedSupplyAction} submit="Record deemed supply"
            extra={{ kind: 'immovable_private_use' }} resetOnSuccess>
            <div className="grid grid-cols-2 gap-3 max-w-4xl">
              <Field label="Last day of the VAT period used in">
                <Input name="date" type="date" required />
              </Field>
              <Field label="Acquired or developed on">
                <Input name="acquiredOn" type="date" required />
              </Field>
              <Field label="Amount taxed on acquisition (C)" hint={`In ${company.baseCurrency}
                (S.I. 639/2010 reg.7(3)).`}>
                <Input name="acquisitionAmount" required placeholder="0.00" />
              </Field>
              <YesNo name="treatedAsBusinessAsset" label="Treated as a business asset when acquired" />
              <Field label="Private floor area (A)" hint="Whole units, such as square metres.">
                <Input name="privateFloorArea" inputMode="numeric" required />
              </Field>
              <Field label="Total floor area (B)">
                <Input name="totalFloorArea" inputMode="numeric" required />
              </Field>
              <Field label="Account charged">
                <Select name="accountId" required defaultValue="">
                  <option value="" disabled>Choose an account</option>
                  {accountOptions}
                </Select>
              </Field>
              <Field label="Description">
                <Input name="description" required placeholder="Flat over the shop" />
              </Field>
            </div>
          </ActionForm>
        </Disclosure>
      </Panel>
    </Page>
  );
}

/**
 * A fact the person must state: no default, so an unanswered question cannot
 * pass as "no". A gift-only question is left to the action to insist on, since
 * it does not apply to goods taken for private use.
 */
function YesNo({ name, label, giftOnly = false }: { name: string; label: string; giftOnly?: boolean }) {
  return (
    <Field label={label}>
      <Select name={name} required={!giftOnly} defaultValue="">
        <option value="" disabled>Choose</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </Select>
    </Field>
  );
}
