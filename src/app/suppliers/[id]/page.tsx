import { notFound } from 'next/navigation';
import Link from 'next/link';
import { supplierDetail, chartOfAccounts, vatTreatmentList } from '@/lib/queries';
import {
  Page, Panel, Badge, Stat, Empty, Field, Input, Select, Textarea, Disclosure,
} from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { saveSupplierAction } from '@/app/settings-actions';
import { money, date, label } from '@/lib/format';
import { PartyVatStatus } from '@/components/PartyVatStatus';

export const dynamic = 'force-dynamic';

/**
 * A supplier profile (README §17).
 *
 * The defaults here are what makes classification get easier over time: once a
 * supplier's account and VAT treatment are confirmed, the next transaction from
 * them is suggested by a rule rather than a guess.
 */
export default async function SupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = supplierDetail(id);
  if (!detail) notFound();

  const { supplier, transactions, invoices, documents } = detail;
  const accounts = chartOfAccounts().filter((account) => account.active);
  const treatments = vatTreatmentList().filter((treatment) => treatment.active);

  const spend = transactions.reduce((total, tx) => total + Math.abs(tx.amountMinor), 0);
  const outstanding = invoices.reduce((total, invoice) => total + invoice.outstandingMinor, 0);

  return (
    <Page
      title={supplier.name}
      subtitle={supplier.legalName && supplier.legalName !== supplier.name
        ? supplier.legalName : undefined}
      actions={
        <>
          {supplier.countryCode && <Badge tone="neutral">{supplier.countryCode}</Badge>}
          {!supplier.active && <Badge tone="caution">Inactive</Badge>}
        </>
      }
    >
      <Panel>
        <div className="grid grid-cols-4 divide-x divide-line">
          <Stat label="Transactions" value={transactions.length} />
          <Stat label="Total paid" value={money(spend, supplier.defaultCurrency)} />
          <Stat label="Invoices" value={invoices.length} />
          <Stat
            label="Outstanding"
            value={money(outstanding, supplier.defaultCurrency)}
            tone={outstanding === 0 ? 'positive' : 'caution'}
          />
        </div>
      </Panel>

      <PartyVatStatus party={supplier} kind="supplier" />

      <Panel title="Profile">
        <table className="ledger">
          <tbody>
            <tr>
              <td className="w-48 text-ink-faint">VAT number</td>
              <td className="num !text-left">
                {supplier.vatNumber ?? '—'}
                {supplier.vatNumber && (
                  <Badge tone={supplier.vatNumberValidated ? 'positive' : 'neutral'}>
                    {supplier.vatNumberValidated ? 'Checked' : 'Not checked'}
                  </Badge>
                )}
              </td>
            </tr>
            <tr>
              <td className="text-ink-faint">Country</td>
              <td>{supplier.countryCode ?? '—'}</td>
            </tr>
            <tr>
              <td className="text-ink-faint">Names seen on statements</td>
              <td>
                {supplier.aliases.length === 0
                  ? <span className="text-ink-faint">Only the name above</span>
                  : (
                    <div className="flex gap-1 flex-wrap">
                      {supplier.aliases.map((alias) => (
                        <Badge key={alias} tone="neutral">{alias}</Badge>
                      ))}
                    </div>
                  )}
              </td>
            </tr>
            <tr>
              <td className="text-ink-faint">Notes</td>
              <td className="text-ink-muted">{supplier.notes ?? '—'}</td>
            </tr>
          </tbody>
        </table>

        <Disclosure summary="Edit supplier">
          <ActionForm action={saveSupplierAction} submit="Save supplier"
            extra={{ supplierId: supplier.id }}>
            <div className="grid grid-cols-2 gap-3 max-w-4xl">
              <Field label="Name"><Input name="name" defaultValue={supplier.name} required /></Field>
              <Field label="Country code" hint="Two letters. It decides which VAT treatments apply.">
                <Input name="countryCode" defaultValue={supplier.countryCode ?? ''} maxLength={2} />
              </Field>
              <Field label="VAT number">
                <Input name="vatNumber" defaultValue={supplier.vatNumber ?? ''} />
              </Field>
              <Field
                label="Names seen on statements"
                help="Comma separated. A bank description matching any of these identifies this
                  supplier, which is how an abbreviated statement line still finds its profile."
              >
                <Input name="aliases" defaultValue={supplier.aliases.join(', ')} />
              </Field>
              <Field
                label="Default account"
                help="Suggested when a transaction from this supplier is classified. It is a
                  suggestion, not a posting — nothing is posted without confirmation."
              >
                <Select name="defaultAccountId" defaultValue={supplier.defaultAccountId ?? ''}>
                  <option value="">None</option>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} — {account.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Default VAT treatment">
                <Select name="defaultVatTreatmentId"
                  defaultValue={supplier.defaultVatTreatmentId ?? ''}>
                  <option value="">None</option>
                  {treatments.map((treatment) => (
                    <option key={treatment.id} value={treatment.id}>
                      {treatment.code} — {treatment.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="max-w-3xl">
              <Field label="Notes">
                <Textarea name="notes" rows={2} defaultValue={supplier.notes ?? ''} />
              </Field>
            </div>
          </ActionForm>
        </Disclosure>
      </Panel>

      <Panel title="Transactions">
        {transactions.length === 0 ? <Empty title="No transactions from this supplier" /> : (
          <table className="ledger">
            <thead>
              <tr>
                <th className="w-28">Date</th><th>Description</th>
                <th className="w-32 text-right">Amount</th><th className="w-28">Status</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((tx) => (
                <tr key={tx.id}>
                  <td className="num !text-left">{date(tx.transactionDate)}</td>
                  <td>
                    <Link href={`/transactions/${tx.id}`} className="text-accent hover:underline">
                      {tx.description}
                    </Link>
                  </td>
                  <td className="text-right num">{money(tx.amountMinor, tx.currency)}</td>
                  <td><Badge tone="neutral">{label(tx.status)}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <div className="grid grid-cols-2 gap-4 items-start">
        <Panel title="Invoices">
          {invoices.length === 0 ? <Empty title="None recorded" /> : (
            <table className="ledger">
              <thead>
                <tr><th className="w-28">Date</th><th>Number</th>
                  <th className="w-28 text-right">Gross</th>
                  <th className="w-28 text-right">Outstanding</th></tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td className="num !text-left">{date(invoice.invoiceDate)}</td>
                    <td>
                      <Link href={`/invoices/${invoice.id}`} className="text-accent hover:underline">
                        {invoice.invoiceNumber ?? `#${invoice.internalNumber ?? '—'}`}
                      </Link>
                    </td>
                    <td className="text-right num">{money(invoice.grossMinor, invoice.currency)}</td>
                    <td className="text-right num">
                      {money(invoice.outstandingMinor, invoice.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="Documents">
          {documents.length === 0 ? <Empty title="None attached" /> : (
            <table className="ledger">
              <thead>
                <tr><th className="w-28">Date</th><th>File</th>
                  <th className="w-28 text-right">Gross</th></tr>
              </thead>
              <tbody>
                {documents.map((document) => (
                  <tr key={document.id}>
                    <td className="num !text-left">{date(document.documentDate)}</td>
                    <td>
                      <Link href={`/documents/${document.id}`} className="text-accent hover:underline">
                        {document.originalFilename}
                      </Link>
                    </td>
                    <td className="text-right num">
                      {document.grossMinor === null
                        ? <span className="text-ink-faint">—</span>
                        : money(document.grossMinor, document.currency ?? 'EUR')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>
    </Page>
  );
}
