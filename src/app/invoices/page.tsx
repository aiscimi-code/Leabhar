import {
  activeCompany, invoiceList, aged, chartOfAccounts, supplierList, customerList,
  vatTreatmentList, companyContext,
} from '@/lib/queries';
import {
  Page, Panel, Badge, Stat, Empty, Field, Input, Select, Disclosure,
} from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { createInvoiceAction } from '@/app/settings-actions';
import { money, date, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Invoices and ageing (README §26, §27).
 *
 * An invoice is not a payment. The two are recorded separately and linked by an
 * allocation, so an invoice raised in one period and paid in another sits in the
 * right period on both sides — which is the whole point on the cash receipts
 * basis, where the payment is what makes the VAT arise.
 */
export default async function InvoicesPage({ searchParams }: {
  searchParams: Promise<{ direction?: string }>;
}) {
  const { direction: raw } = await searchParams;
  const direction = raw === 'purchase' ? 'purchase' : 'sales';
  const company = activeCompany();

  if (!company) {
    return (
      <Page title="Invoices">
        <Panel><Empty title="No company yet" /></Panel>
      </Page>
    );
  }

  const { currency } = companyContext();
  const rows = invoiceList(direction);
  const ageing = aged(direction);
  const accounts = chartOfAccounts().filter((account) => account.active);
  const parties: Array<{ id: string; name: string }> = direction === 'purchase'
    ? supplierList().map((row) => ({ id: row.supplier.id, name: row.supplier.name }))
    : customerList().map((row) => ({ id: row.id, name: row.name }));
  const treatments = vatTreatmentList().filter((treatment) => treatment.active);
  const today = new Date().toISOString().slice(0, 10);

  const cashBasisNote = company.vatAccountingBasis === 'cash_receipts' && direction === 'sales';

  return (
    <Page
      title={direction === 'sales' ? 'Sales invoices' : 'Purchase invoices'}
      subtitle={cashBasisNote
        ? 'On the cash receipts basis the VAT on these invoices does not arise until the '
          + 'customer pays. Until then it is held in a deferred VAT account rather than in '
          + 'the VAT return.'
        : 'Raised and outstanding. Payment is recorded separately, so nothing is assumed '
          + 'paid on issue.'}
      actions={
        <div className="flex gap-1">
          <a href="/invoices?direction=sales"
            className={`px-2.5 py-1 rounded border text-[12px] font-medium ${
              direction === 'sales'
                ? 'bg-accent text-white border-accent'
                : 'bg-surface text-ink border-line-strong'}`}>Sales</a>
          <a href="/invoices?direction=purchase"
            className={`px-2.5 py-1 rounded border text-[12px] font-medium ${
              direction === 'purchase'
                ? 'bg-accent text-white border-accent'
                : 'bg-surface text-ink border-line-strong'}`}>Purchases</a>
        </div>
      }
    >
      <Panel
        title={direction === 'sales' ? 'Aged debtors' : 'Aged creditors'}
        description={`As at ${date(today)}, by reference to each invoice's due date.`}
      >
        <div className="grid grid-cols-6 divide-x divide-line">
          {ageing.buckets.map((bucket) => (
            <Stat
              key={bucket.label}
              label={bucket.label}
              value={money(bucket.amountMinor, currency)}
              tone={bucket.label === 'Over 90 days' && bucket.amountMinor !== 0
                ? 'negative' : 'default'}
              hint={`${bucket.count} ${bucket.count === 1 ? 'invoice' : 'invoices'}`}
            />
          ))}
          <Stat label="Total outstanding" value={money(ageing.totalMinor, currency)} />
        </div>
      </Panel>

      <Panel title="Raise an invoice">
        <Disclosure summary="New invoice" tone="accent">
          <ActionForm action={createInvoiceAction} submit="Post invoice" resetOnSuccess
            extra={{ direction }}>
            <div className="grid grid-cols-4 gap-3 max-w-5xl">
              <Field label={direction === 'purchase' ? 'Supplier' : 'Customer'}>
                <Select name="partyId" defaultValue="">
                  <option value="">Not specified</option>
                  {parties.map((party) => (
                    <option key={party.id} value={party.id}>{party.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Invoice number">
                <Input name="invoiceNumber" placeholder="Optional" />
              </Field>
              <Field label="Invoice date">
                <Input name="invoiceDate" type="date" defaultValue={today} required />
              </Field>
              <Field label="Due date"><Input name="dueDate" type="date" /></Field>
              <Field label="Net amount" hint="Excluding VAT.">
                <Input name="net" required placeholder="0.00" />
              </Field>
              <Field label="Currency">
                <Input name="currency" defaultValue={currency} maxLength={3} />
              </Field>
              <Field label="Account">
                <Select name="accountId" required defaultValue="">
                  <option value="" disabled>Choose an account</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} — {account.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="VAT treatment"
                help="The treatment, not merely a percentage. It decides which VAT3 box the
                  figures reach and whether the VAT is recoverable."
              >
                <Select name="vatTreatmentId" required defaultValue="">
                  <option value="" disabled>Choose a treatment</option>
                  {treatments
                    .filter((treatment) => treatment.direction === 'both'
                      || treatment.direction === (direction === 'sales' ? 'sales' : 'purchases'))
                    .map((treatment) => (
                      <option key={treatment.id} value={treatment.id}>
                        {treatment.code} — {treatment.name}
                      </option>
                    ))}
                </Select>
              </Field>
            </div>
            <div className="max-w-3xl">
              <Field label="Description">
                <Input name="description" required placeholder="Consultancy, March" />
              </Field>
            </div>
          </ActionForm>
        </Disclosure>
      </Panel>

      <Panel title={direction === 'sales' ? 'Sales invoices' : 'Purchase invoices'}>
        {rows.length === 0 ? (
          <Empty title="No invoices" detail="Nothing has been raised on this side yet." />
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th className="w-28">Date</th>
                <th className="w-32">Number</th>
                <th>{direction === 'purchase' ? 'Supplier' : 'Customer'}</th>
                <th className="w-28 text-right">Net</th>
                <th className="w-28 text-right">VAT</th>
                <th className="w-28 text-right">Gross</th>
                <th className="w-28 text-right">Outstanding</th>
                <th className="w-28">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ invoice, supplierName, customerName }) => (
                <tr key={invoice.id}>
                  <td className="num !text-left">{date(invoice.invoiceDate)}</td>
                  <td>
                    <a href={`/invoices/${invoice.id}`}
                      className="text-accent hover:underline num !text-left">
                      {invoice.invoiceNumber ?? `#${invoice.internalNumber ?? '—'}`}
                    </a>
                  </td>
                  <td>{supplierName ?? customerName ?? <span className="text-ink-faint">—</span>}</td>
                  <td className="text-right num">{money(invoice.netMinor, invoice.currency)}</td>
                  <td className="text-right num">{money(invoice.vatMinor, invoice.currency)}</td>
                  <td className="text-right num font-medium">
                    {money(invoice.grossMinor, invoice.currency)}
                  </td>
                  <td className="text-right num">
                    {money(invoice.outstandingMinor, invoice.currency)}
                  </td>
                  <td>
                    <Badge tone={invoice.status === 'paid' ? 'positive'
                      : invoice.status === 'overdue' ? 'negative'
                      : invoice.status === 'part_paid' ? 'caution' : 'neutral'}>
                      {label(invoice.status)}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </Page>
  );
}
