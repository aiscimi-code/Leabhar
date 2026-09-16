import { customerList } from '@/lib/queries';
import { Page, Panel, Badge, Empty } from '@/components/primitives';

export const dynamic = 'force-dynamic';

/** Customer profiles (README §17). */
export default function CustomersPage() {
  const customers = customerList();

  return (
    <Page title="Customers" subtitle="Who you invoice, and how their sales are treated for VAT.">
      <Panel>
        {customers.length === 0 ? (
          <Empty title="No customers yet" />
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th>Customer</th>
                <th className="w-20">Country</th>
                <th className="w-40">VAT number</th>
                <th className="w-24">Currency</th>
                <th className="w-32 text-right">Payment terms</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((customer) => (
                <tr key={customer.id}>
                  <td>
                    {customer.name}
                    {customer.aliases.length > 0 && (
                      <div className="text-[11px] text-ink-faint">
                        Also seen as {customer.aliases.join(', ')}
                      </div>
                    )}
                  </td>
                  <td>
                    {customer.countryCode
                      ? <Badge tone={customer.countryCode === 'IE' ? 'neutral' : 'accent'}>
                          {customer.countryCode}
                        </Badge>
                      : <span className="text-ink-faint">—</span>}
                  </td>
                  <td className="num !text-left text-ink-muted">{customer.vatNumber ?? '—'}</td>
                  <td>{customer.defaultCurrency}</td>
                  <td className="text-right num">
                    {customer.defaultPaymentTermsDays === 0
                      ? 'On issue'
                      : `${customer.defaultPaymentTermsDays} days`}
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
