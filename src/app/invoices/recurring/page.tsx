import {
  activeCompany, chartOfAccounts, customerList, vatTreatmentList, companyContext, recurringInvoiceList,
} from '@/lib/queries';
import { Page, Panel, Badge, Empty, Field, Input, Select, Disclosure } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import {
  createRecurringInvoiceAction, postDueRecurringInvoicesAction, deactivateRecurringInvoiceAction,
} from '@/app/actions';
import { money, date, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Recurring sales invoices (issue #394). A template raises an ordinary invoice
 * on each occurrence date, once; nothing is raised until a person asks for the
 * due ones, and an occurrence in a locked period is flagged, not moved.
 */
export default async function RecurringInvoicesPage() {
  const company = activeCompany();
  if (!company) {
    return <Page title="Recurring invoices"><Panel><Empty title="No company yet" /></Panel></Page>;
  }
  const { currency } = companyContext();
  const templates = recurringInvoiceList();
  const customers = customerList().filter((c) => c.active);
  const accounts = chartOfAccounts().filter((a) => a.active && a.type === 'income');
  const treatments = vatTreatmentList().filter((t) => t.active && t.direction !== 'purchases');
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page title="Recurring invoices"
      subtitle="Templates that raise a sales invoice on a schedule. Each occurrence is an ordinary invoice with its own number and VAT.">
      <Panel title="Raise what is due"
        description="Raises every occurrence up to the date given that has not been raised yet. Running it twice raises nothing twice.">
        <div className="px-4 py-3">
          <ActionForm action={postDueRecurringInvoicesAction} submit="Raise due invoices" inline>
            <Field label="Up to"><Input name="upTo" type="date" defaultValue={today} required /></Field>
          </ActionForm>
        </div>
      </Panel>

      <Panel title="Templates">
        {templates.length === 0 ? <Empty title="No recurring invoices yet" /> : (
          <table className="ledger">
            <thead>
              <tr>
                <th>Name</th><th>Customer</th><th className="w-24">Every</th>
                <th className="w-28 text-right">Net</th><th className="w-20 text-right">Raised</th>
                <th className="w-28">Next due</th><th className="w-40" />
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className={t.active ? '' : 'text-ink-faint'}>
                  <td>{t.name}{!t.active && <Badge tone="neutral">stopped</Badge>}</td>
                  <td>{t.customerName}</td>
                  <td>{label(t.frequency)}</td>
                  <td className="num">{money(t.netMinor, currency)}</td>
                  <td className="num">{t.raisedCount}</td>
                  <td>{t.nextDueDate ? date(t.nextDueDate) : '—'}</td>
                  <td>
                    {t.active && (
                      <ActionForm action={deactivateRecurringInvoiceAction} submit="Stop" variant="secondary"
                        confirm="Stop raising this invoice? Invoices already raised are not changed."
                        extra={{ templateId: t.id }} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="New recurring invoice">
        <Disclosure summary="Set one up" tone="accent">
          <ActionForm action={createRecurringInvoiceAction} submit="Save template" resetOnSuccess>
            <div className="grid grid-cols-4 gap-3 max-w-5xl">
              <Field label="Name"><Input name="name" required placeholder="Monthly retainer" /></Field>
              <Field label="Customer">
                <Select name="customerId" required defaultValue="">
                  <option value="" disabled>Choose a customer</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
              <Field label="Every">
                <Select name="frequency" defaultValue="monthly">
                  <option value="monthly">Month</option>
                  <option value="quarterly">Quarter</option>
                  <option value="yearly">Year</option>
                </Select>
              </Field>
              <Field label="First invoice"><Input name="startDate" type="date" required defaultValue={today} /></Field>
              <Field label="Last invoice (optional)"><Input name="endDate" type="date" /></Field>
              <Field label="Description"><Input name="description" required placeholder="Retainer" /></Field>
              <Field label={`Net (${currency})`} hint="Excluding VAT."><Input name="net" required placeholder="0.00" /></Field>
              <Field label="Discount %" hint="Optional."><Input name="discountPercent" placeholder="10" /></Field>
              <Field label="Income account">
                <Select name="accountId" required defaultValue="">
                  <option value="" disabled>Choose an account</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                </Select>
              </Field>
              <Field label="VAT treatment">
                <Select name="vatTreatmentId" required defaultValue="">
                  <option value="" disabled>Choose a treatment</option>
                  {treatments.map((t) => <option key={t.id} value={t.id}>{t.code} — {t.name}</option>)}
                </Select>
              </Field>
            </div>
            <p className="text-[12px] text-ink-muted mt-2">
              One line here; the CLI (<code>create-recurring-invoice --lines</code>) takes several.
            </p>
          </ActionForm>
        </Disclosure>
      </Panel>
    </Page>
  );
}
