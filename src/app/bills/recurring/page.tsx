import { activeCompany, recurringBillsPage, supplierList } from '@/lib/queries';
import { Page, Panel, Badge, Empty, Field, Input, Select, Disclosure } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import {
  createRecurringBillAction, runExpectedBillsAction, matchExpectedBillAction, unmatchExpectedBillAction,
  dismissExpectedBillAction, deactivateRecurringBillAction,
} from '@/app/actions';
import { money, date, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Recurring bills (issue #412). Rent, subscriptions and utilities are
 * expected on a schedule, but nothing is posted for them: input VAT comes only
 * from the supplier's confirmed invoice. Each occurrence waits for that bill,
 * is matched to it when it is posted, and is flagged if it does not arrive.
 */
export default async function RecurringBillsPage() {
  const company = activeCompany();
  if (!company) {
    return <Page title="Recurring bills"><Panel><Empty title="No company yet" /></Panel></Page>;
  }
  const { templates, billsBySupplier, currency } = recurringBillsPage();
  const suppliers = supplierList().map((s) => s.supplier).filter((s) => s.active);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page title="Recurring bills"
      subtitle="Bills you expect on a schedule. Nothing is posted until the supplier's invoice is confirmed and posted; each occurrence is then matched to it.">
      <Panel title="Check what is due"
        description="Expects every occurrence up to the date, matches the bills that have arrived, and flags the ones that have not once their window has passed. Running it twice does nothing twice.">
        <div className="px-4 py-3">
          <ActionForm action={runExpectedBillsAction} submit="Check bills" inline>
            <Field label="As of"><Input name="asOf" type="date" defaultValue={today} required /></Field>
          </ActionForm>
        </div>
      </Panel>

      {templates.length === 0 ? <Panel><Empty title="No recurring bills yet" /></Panel> : templates.map((t) => {
        const bills = billsBySupplier.get(t.supplierId) ?? [];
        return (
          <Panel key={t.id}
            title={`${t.name} — ${t.supplierName}`}
            description={`${label(t.frequency)} from ${date(t.startDate)}${t.endDate ? ` to ${date(t.endDate)}` : ''}; `
              + `${money(t.expectedNetMinor, t.currency)} net expected, within ${(t.toleranceBasisPoints / 100).toFixed(2)}%, `
              + `bills dated ${t.windowDays} days either side.${t.nextDate ? ` Next: ${date(t.nextDate)}.` : ''}`}
            actions={t.active ? (
              <ActionForm action={deactivateRecurringBillAction} submit="Stop" variant="secondary"
                confirm="Stop expecting this bill? Occurrences already expected are kept." extra={{ recurringBillId: t.id }} />
            ) : <Badge tone="neutral">stopped</Badge>}>
            {t.occurrences.length === 0 ? <Empty title="Nothing expected yet" detail="Check bills to expect the occurrences due." /> : (
              <table className="ledger">
                <thead>
                  <tr>
                    <th className="w-28">Expected</th><th className="w-28 text-right">Net</th><th className="w-28">Status</th>
                    <th>Bill</th><th className="w-72" />
                  </tr>
                </thead>
                <tbody>
                  {[...t.occurrences].reverse().map((o) => (
                    <tr key={o.id}>
                      <td>{date(o.expectedDate)}</td>
                      <td className="num">{money(o.expectedNetMinor, t.currency)}</td>
                      <td>
                        <Badge tone={o.status === 'matched' ? 'positive' : o.overdue ? 'negative' : 'neutral'}>
                          {o.status === 'expected' && o.overdue ? 'missing' : label(o.status)}
                        </Badge>
                      </td>
                      <td>
                        {o.invoiceId ? (
                          <>
                            <a href={`/invoices/${o.invoiceId}`} className="underline">{o.invoiceNumber ?? 'bill'}</a>
                            {o.differenceMinor ? <span className="text-ink-muted"> ({o.differenceMinor > 0 ? '+' : ''}{money(o.differenceMinor, t.currency)})</span> : null}
                          </>
                        ) : o.dismissReason ?? '—'}
                      </td>
                      <td>
                        {o.status === 'expected' && (
                          <Disclosure summary="Match or dismiss">
                            {bills.length > 0 && (
                              <ActionForm action={matchExpectedBillAction} submit="Match" inline extra={{ expectedBillId: o.id }}>
                                <Field label="Bill">
                                  <Select name="invoiceId" required defaultValue="">
                                    <option value="" disabled>Choose a bill</option>
                                    {bills.map((b) => (
                                      <option key={b.id} value={b.id}>{b.number ?? b.id} — {date(b.invoiceDate)}, {money(b.netMinor, currency)}</option>
                                    ))}
                                  </Select>
                                </Field>
                              </ActionForm>
                            )}
                            <ActionForm action={dismissExpectedBillAction} submit="No bill due" variant="secondary" inline extra={{ expectedBillId: o.id }}>
                              <Field label="Why"><Input name="reason" required placeholder="Rent-free month" /></Field>
                            </ActionForm>
                          </Disclosure>
                        )}
                        {o.status === 'matched' && (
                          <Disclosure summary="Unmatch">
                            <ActionForm action={unmatchExpectedBillAction} submit="Unmatch" variant="secondary" inline extra={{ expectedBillId: o.id }}>
                              <Field label="Why"><Input name="reason" required placeholder="Wrong month" /></Field>
                            </ActionForm>
                          </Disclosure>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        );
      })}

      <Panel title="New recurring bill">
        <Disclosure summary="Set one up" tone="accent">
          <ActionForm action={createRecurringBillAction} submit="Save" resetOnSuccess>
            <div className="grid grid-cols-4 gap-3 max-w-5xl">
              <Field label="Name"><Input name="name" required placeholder="Office rent" /></Field>
              <Field label="Supplier">
                <Select name="supplierId" required defaultValue="">
                  <option value="" disabled>Choose a supplier</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </Field>
              <Field label="Every">
                <Select name="frequency" defaultValue="monthly">
                  <option value="monthly">Month</option>
                  <option value="quarterly">Quarter</option>
                  <option value="yearly">Year</option>
                </Select>
              </Field>
              <Field label={`Expected net (${currency})`} hint="Excluding VAT."><Input name="net" required placeholder="0.00" /></Field>
              <Field label="First bill dated"><Input name="startDate" type="date" required defaultValue={today} /></Field>
              <Field label="Last (optional)"><Input name="endDate" type="date" /></Field>
              <Field label="Tolerance %" hint="Default 5."><Input name="tolerancePercent" placeholder="5" /></Field>
              <Field label="Window (days)" hint="Default 10."><Input name="windowDays" placeholder="10" /></Field>
            </div>
          </ActionForm>
        </Disclosure>
      </Panel>
    </Page>
  );
}
