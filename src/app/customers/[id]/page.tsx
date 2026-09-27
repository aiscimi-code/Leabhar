import { notFound } from 'next/navigation';
import Link from 'next/link';
import { customerDetail } from '@/lib/queries';
import { Page, Panel, Badge, Empty, Field, Input, Stat, Disclosure } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { setCustomerTermsAction, addCustomerContactAction, customerContactAction, refundOnAccountAction } from '@/app/actions';
import { PartyVatStatus } from '@/components/PartyVatStatus';
import { money, date } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** A customer profile: its VAT status (issue #207) and its invoices. */
export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = customerDetail(id);
  if (!detail) notFound();
  const { customer, invoices, exposure, contacts, company, credit, banks, reminders } = detail;
  const today = new Date().toISOString().slice(0, 10);
  const base = company.baseCurrency;

  return (
    <Page
      title={customer.name}
      subtitle={customer.legalName && customer.legalName !== customer.name ? customer.legalName : undefined}
      actions={
        <>
          {customer.countryCode && <Badge tone="neutral">{customer.countryCode}</Badge>}
          {customer.vatNumber && <Badge tone="neutral">{customer.vatNumber}</Badge>}
        </>
      }
    >
      <PartyVatStatus party={customer} kind="customer" />

      <Panel title="Account terms" description="Payment terms set the due date of new invoices. Going over the credit limit is flagged, never refused.">
        <div className="grid grid-cols-3 divide-x divide-line">
          <Stat label="Owes" value={money(exposure.outstandingBaseMinor, base)} />
          <Stat label="Credit limit" value={exposure.creditLimitMinor === null ? 'None' : money(exposure.creditLimitMinor, base)} />
          <Stat label="Headroom"
            value={exposure.headroomMinor === null ? '—' : money(exposure.headroomMinor, base)}
            tone={exposure.headroomMinor !== null && exposure.headroomMinor < 0 ? 'negative' : undefined} />
        </div>
        <div className="px-4 py-3 border-t border-line">
          <ActionForm action={setCustomerTermsAction} submit="Save terms" inline>
            <input type="hidden" name="customerId" value={customer.id} />
            <Field label="Payment terms (days)">
              <Input name="paymentTermsDays" type="number" min={0} max={365} defaultValue={customer.defaultPaymentTermsDays} />
            </Field>
            <Field label={`Credit limit (${base}, blank for none)`}>
              <Input name="creditLimit" defaultValue={customer.creditLimitMinor === null ? '' : (customer.creditLimitMinor / 100).toFixed(2)} />
            </Field>
          </ActionForm>
        </div>
      </Panel>

      {credit.totalMinor > 0 && (
        <Panel title={`Credit in hand: ${money(credit.totalMinor, base)}`}
          description="Open credit notes and money received on account. Apply a credit note from its invoice page; refund money on account here.">
          <table className="ledger">
            <thead><tr><th>What</th><th className="w-28">Date</th><th className="w-32 text-right">Amount</th><th className="w-72" /></tr></thead>
            <tbody>
              {credit.creditNotes.map((c) => (
                <tr key={c.invoiceId}>
                  <td><Link href={`/invoices/${c.invoiceId}`} className="hover:underline">Credit note {c.number}</Link></td>
                  <td>{date(c.date)}</td>
                  <td className="num">{money(c.remainingMinor, base)}</td>
                  <td />
                </tr>
              ))}
              {credit.onAccount.map((p) => (
                <tr key={p.paymentId}>
                  <td>On account{p.reference ? ` · ${p.reference}` : ''}</td>
                  <td>{date(p.paymentDate)}</td>
                  <td className="num">{money(p.onAccountMinor, base)}</td>
                  <td>
                    <Disclosure summary="Refund">
                      <ActionForm action={refundOnAccountAction} submit="Refund"
                        extra={{ paymentId: p.paymentId, customerId: customer.id }}>
                        <Field label="Amount"><Input name="amount" required defaultValue={(p.onAccountMinor / 100).toFixed(2)} /></Field>
                        <Field label="Bank line id (optional)" hint="The statement line the refund left by; or give a date and account below.">
                          <Input name="bankTransactionId" />
                        </Field>
                        <Field label="Date"><Input name="date" type="date" defaultValue={today} /></Field>
                        <Field label="From account">
                          <select name="bankAccountId" className="border border-line-strong rounded px-2 py-1 bg-surface text-[12.5px]">
                            {banks.map((b) => <option key={b.id} value={b.id}>{b.bankName} — {b.accountName}</option>)}
                          </select>
                        </Field>
                        <Field label="Why"><Input name="reason" required placeholder="Overpaid" /></Field>
                      </ActionForm>
                    </Disclosure>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      <Panel title="Contacts" description="The billing contact is who invoices are addressed to.">
        {contacts.length === 0 ? <Empty title="No contacts yet" /> : (
          <table className="ledger">
            <thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Phone</th><th className="w-56" /></tr></thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}{c.isBilling && <Badge tone="positive">billing</Badge>}</td>
                  <td className="text-ink-muted">{c.role ?? '—'}</td>
                  <td>{c.email ?? '—'}</td>
                  <td>{c.phone ?? '—'}</td>
                  <td>
                    <div className="flex gap-2">
                      {!c.isBilling && c.email && (
                        <ActionForm action={customerContactAction} submit="Make billing" variant="secondary"
                          extra={{ contactId: c.id, customerId: customer.id, op: 'billing' }} />
                      )}
                      <ActionForm action={customerContactAction} submit="Remove" variant="secondary"
                        extra={{ contactId: c.id, customerId: customer.id, op: 'deactivate' }} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="px-4 py-3 border-t border-line">
          <ActionForm action={addCustomerContactAction} submit="Add contact" inline resetOnSuccess>
            <input type="hidden" name="customerId" value={customer.id} />
            <Field label="Name"><Input name="name" required /></Field>
            <Field label="Role"><Input name="role" placeholder="Accounts payable" /></Field>
            <Field label="Email"><Input name="email" type="email" /></Field>
            <Field label="Phone"><Input name="phone" /></Field>
            <label className="flex items-center gap-1.5 text-[12px] pb-2">
              <input type="checkbox" name="isBilling" /> Billing contact
            </label>
          </ActionForm>
        </div>
      </Panel>

      <Panel title="Statement of account" description="Every invoice, credit, payment and write-off in the period, with a running balance.">
        <form method="get" action={`/api/customers/${customer.id}/statement`} className="px-4 py-3 flex items-end gap-3 flex-wrap">
          <Field label="From"><Input name="from" type="date" defaultValue={`${today.slice(0, 4)}-01-01`} /></Field>
          <Field label="To"><Input name="to" type="date" defaultValue={today} /></Field>
          <Field label="Format">
            <select name="format" defaultValue="pdf" className="border border-line-strong rounded px-2 py-1 bg-surface text-[12.5px]">
              <option value="pdf">PDF</option><option value="csv">CSV</option>
            </select>
          </Field>
          <button type="submit" className="px-3 py-1.5 rounded border border-line-strong text-[12.5px] bg-surface hover:bg-surface-sunken">Download</button>
        </form>
        {reminders.length > 0 && (
          <div className="px-4 py-3 border-t border-line text-[12.5px]">
            <p className="text-ink-muted mb-1">Reminders produced</p>
            <ul className="space-y-0.5">
              {reminders.map((r) => (
                <li key={r.id}>
                  <a className="text-accent hover:underline" href={`/api/reminders/${r.id}/pdf`}>
                    {r.level === 3 ? 'Final notice' : r.level === 2 ? 'Second reminder' : 'Reminder'} as at {date(r.asOf)}
                  </a> <span className="text-ink-muted">· {r.producedBy}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>

      <Panel title="Invoices">
        {invoices.length === 0 ? <Empty title="No invoices yet" /> : (
          <table className="ledger">
            <thead>
              <tr><th className="w-28">Date</th><th>Number</th><th className="w-28">Due</th><th className="w-32 text-right">Total</th><th className="w-32 text-right">Outstanding</th></tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td>{date(invoice.invoiceDate)}</td>
                  <td><Link href={`/invoices/${invoice.id}`} className="hover:underline">{invoice.invoiceNumber}</Link></td>
                  <td className="text-ink-muted">{invoice.dueDate ? date(invoice.dueDate) : '—'}</td>
                  <td className="num">{money(invoice.grossMinor, invoice.currency)}</td>
                  <td className="num">{money(invoice.outstandingMinor, invoice.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </Page>
  );
}
