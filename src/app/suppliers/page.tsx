import Link from 'next/link';
import { supplierList } from '@/lib/queries';
import { Page, Panel, Badge, Empty } from '@/components/primitives';
import { money, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** Supplier profiles (README §17). */
export default function SuppliersPage() {
  const rows = supplierList();

  return (
    <Page
      title="Suppliers"
      subtitle="Confirmed classifications become the default suggested next time, which is how
        the system learns without anything probabilistic being involved."
    >
      <Panel>
        {rows.length === 0 ? (
          <Empty title="No suppliers yet" detail="They are created as you classify transactions." />
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th>Supplier</th>
                <th className="w-20">Country</th>
                <th className="w-40">VAT number</th>
                <th className="w-48">Default account</th>
                <th className="w-48">Default VAT treatment</th>
                <th className="w-20 text-right">Txns</th>
                <th className="w-28 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ supplier, accountName, treatmentName, transactionCount, totalMinor }) => (
                <tr key={supplier.id}>
                  <td>
                    <Link href={`/suppliers/${supplier.id}`} className="text-accent hover:underline">
                      {supplier.name}
                    </Link>
                    {supplier.aliases.length > 0 && (
                      <div className="text-[11px] text-ink-faint">
                        Also seen as {supplier.aliases.join(', ')}
                      </div>
                    )}
                  </td>
                  <td>
                    {supplier.countryCode
                      ? <Badge tone={supplier.countryCode === 'IE' ? 'neutral' : 'accent'}>
                          {supplier.countryCode}
                        </Badge>
                      : <span className="text-ink-faint">—</span>}
                  </td>
                  <td className="num !text-left text-ink-muted">{supplier.vatNumber ?? '—'}</td>
                  <td>{accountName ?? <span className="text-ink-faint">Not set</span>}</td>
                  <td>{treatmentName ?? <span className="text-ink-faint">Not set</span>}</td>
                  <td className="text-right num">{transactionCount}</td>
                  <td className="text-right num">{money(totalMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </Page>
  );
}
