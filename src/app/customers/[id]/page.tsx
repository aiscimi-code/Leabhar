import { notFound } from 'next/navigation';
import Link from 'next/link';
import { customerDetail } from '@/lib/queries';
import { Page, Panel, Badge, Empty } from '@/components/primitives';
import { PartyVatStatus } from '@/components/PartyVatStatus';
import { money, date } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** A customer profile: its VAT status (issue #207) and its invoices. */
export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = customerDetail(id);
  if (!detail) notFound();
  const { customer, invoices } = detail;

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

      <Panel title="Invoices">
        {invoices.length === 0 ? <Empty title="No invoices yet" /> : (
          <table className="ledger">
            <thead>
              <tr><th className="w-28">Date</th><th>Number</th><th className="w-32 text-right">Total</th></tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <td>{date(invoice.invoiceDate)}</td>
                  <td><Link href={`/invoices/${invoice.id}`} className="hover:underline">{invoice.invoiceNumber}</Link></td>
                  <td className="num">{money(invoice.grossMinor, invoice.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </Page>
  );
}
