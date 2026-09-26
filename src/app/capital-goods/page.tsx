import { capitalGoodsPage, chartOfAccounts } from '@/lib/queries';
import { Page, Panel, Badge, Empty, Field, Input, Select, Disclosure } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import {
  registerCapitalGoodAction, recordIntervalAction, recordDisposalAction, postCgsAdjustmentAction,
} from '@/app/capital-goods-actions';
import { money, date } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * The capital goods scheme record (VATCA ss.63-64, issue #208). Each property
 * acquired, developed or refurbished is reviewed over 20 (or 10) intervals;
 * the adjustments are calculated here from the use recorded, never typed.
 */
export default function CapitalGoodsPage() {
  const { company, goods, purchaseInvoices } = capitalGoodsPage();
  const accounts = chartOfAccounts().filter((a) => a.active);
  const cur = company.baseCurrency;
  const pct = (bp: number) => `${bp / 100}%`;
  const AccountSelect = () => (
    <Select name="accountId" required defaultValue="">
      <option value="" disabled>Other side of the entry</option>
      {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
    </Select>
  );

  return (
    <Page
      title="Capital goods"
      subtitle="Property acquired, developed or refurbished: the VAT deducted is reviewed against its use for 20 intervals
        (10 for a refurbishment), VATCA ss.63-64."
    >
      {goods.length === 0 && <Panel><Empty title="No capital goods" detail="Register a property from the purchase invoices its VAT rests on." /></Panel>}

      {goods.map(({ good, intervals, nextDue }) => (
        <Panel
          key={good.id}
          title={good.description}
          description={`${good.kind === 'refurbishment' ? 'Refurbishment' : 'Acquisition or development'} · total tax incurred `
            + `${money(good.totalTaxIncurredMinor, cur)} · deducted ${money(good.deductedMinor, cur)} · registered by ${good.registeredBy}`}
        >
          {nextDue && (
            <p className="px-4 py-2 text-[12px] text-caution">
              Interval {nextDue.number} ended on {date(nextDue.end)}: record its use.
            </p>
          )}
          <table className="ledger">
            <thead>
              <tr>
                <th className="w-12">No.</th><th className="w-44">Interval</th><th className="w-20 text-right">Use</th>
                <th className="w-28 text-right">Adjustment</th><th>Working</th><th className="w-40">Posted</th>
              </tr>
            </thead>
            <tbody>
              {intervals.filter((i) => i.record || i.number === nextDue?.number).map((i) => (
                <tr key={i.number}>
                  <td>{i.number}</td>
                  <td className="num !text-left">{date(i.start)} – {date(i.end)}</td>
                  <td className="text-right num">{i.record ? pct(i.record.proportionBp) : '—'}</td>
                  <td className="text-right num">
                    {i.record ? money(i.record.adjustmentMinor, cur) : '—'}
                    {i.record && i.record.adjustmentMinor !== 0 && (
                      <div className="text-[10.5px] text-ink-faint">{i.record.adjustmentMinor > 0 ? 'payable (T1)' : 'deductible (T2)'}</div>
                    )}
                  </td>
                  <td className="text-[11.5px] text-ink-muted">{i.record ? `${i.record.provision}: ${i.record.working}` : ''}</td>
                  <td>
                    {i.record?.journalEntryId ? <Badge tone="positive">Posted</Badge>
                      : i.record && i.record.adjustmentMinor !== 0 ? (
                        <ActionForm action={postCgsAdjustmentAction} submit={`Post on ${date(i.adjustmentOn)}`} inline
                          extra={{ intervalId: i.record.id }}>
                          <AccountSelect />
                        </ActionForm>
                      ) : i.record ? <span className="text-ink-faint">Nothing to post</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {good.disposedOn && (
            <p className="px-4 py-2 text-[12px]">
              Supplied on {date(good.disposedOn)} ({good.disposalTaxable ? 'taxable' : 'exempt'}): adjustment
              {' '}{money(good.disposalAdjustmentMinor ?? 0, cur)}.{' '}
              {good.disposalJournalEntryId ? <Badge tone="positive">Posted</Badge> : good.disposalAdjustmentMinor ? (
                <ActionForm action={postCgsAdjustmentAction} submit="Post" inline extra={{ capitalGoodId: good.id, disposal: '1' }}>
                  <AccountSelect />
                </ActionForm>
              ) : null}
            </p>
          )}
          {nextDue && (
            <Disclosure summary={`Record the use in interval ${nextDue.number}`}>
              <ActionForm action={recordIntervalAction} submit="Record use" extra={{ capitalGoodId: good.id, intervalNumber: String(nextDue.number) }}>
                <div className="grid grid-cols-2 gap-3 max-w-xl">
                  <Field label="Proportion of deductible use (%)">
                    <Input name="use" inputMode="decimal" placeholder="e.g. 80" />
                  </Field>
                  <label className="flex items-center gap-2 text-[12px] text-ink mt-6">
                    <input type="checkbox" name="notUsed" /> Not used in the interval
                  </label>
                </div>
              </ActionForm>
            </Disclosure>
          )}
          {!good.disposedOn && (
            <Disclosure summary="Record a sale or other supply of the good">
              <ActionForm action={recordDisposalAction} submit="Record supply" extra={{ capitalGoodId: good.id }}>
                <div className="grid grid-cols-2 gap-3 max-w-xl">
                  <Field label="Date of supply"><Input name="date" type="date" required /></Field>
                  <Field label="VAT on the supply">
                    <Select name="taxable" defaultValue="" required>
                      <option value="" disabled>Choose</option>
                      <option value="true">Taxable (including a joint option)</option>
                      <option value="false">Exempt</option>
                    </Select>
                  </Field>
                </div>
              </ActionForm>
            </Disclosure>
          )}
        </Panel>
      ))}

      <Panel title="Register a capital good" description="The total tax incurred is the VAT on the invoices you pick.">
        {purchaseInvoices.length === 0 ? <Empty title="No purchase invoices with VAT" /> : (
          <ActionForm action={registerCapitalGoodAction} submit="Register">
            <div className="grid grid-cols-2 gap-3 max-w-3xl">
              <Field label="Description"><Input name="description" required placeholder="e.g. Office, Unit 4, Sandyford" /></Field>
              <Field label="Kind">
                <Select name="kind" defaultValue="" required>
                  <option value="" disabled>Choose</option>
                  <option value="acquisition_or_development">Acquisition or development (20 intervals)</option>
                  <option value="refurbishment">Refurbishment (10 intervals)</option>
                </Select>
              </Field>
              <Field label="Initial interval starts (completion, or the date it was supplied to you)">
                <Input name="start" type="date" required />
              </Field>
              <Field label="VAT deducted when incurred"><Input name="deducted" inputMode="decimal" required placeholder="0.00" /></Field>
            </div>
            <div className="mt-3 max-h-48 overflow-y-auto border border-line rounded p-2 max-w-3xl">
              {purchaseInvoices.map((inv) => (
                <label key={inv.id} className="flex items-center gap-2 text-[12px] py-0.5">
                  <input type="checkbox" name="invoices" value={inv.id} />
                  {date(inv.invoiceDate)} · {inv.supplierName ?? '—'} · {inv.invoiceNumber ?? inv.id} · VAT {money(inv.baseVatMinor, cur)}
                </label>
              ))}
            </div>
          </ActionForm>
        )}
      </Panel>
    </Page>
  );
}
