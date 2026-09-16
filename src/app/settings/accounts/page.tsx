import Link from 'next/link';
import { chartOfAccounts } from '@/lib/queries';
import { Page, Panel, Badge, Help } from '@/components/primitives';
import { label } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** Chart of accounts (README §10). */
export default function AccountsPage() {
  const accounts = chartOfAccounts();
  const types = ['income', 'expense', 'asset', 'liability', 'equity'] as const;

  return (
    <Page
      title="Chart of accounts"
      subtitle="Predefined but editable. An account referenced by a posted entry can be
        deactivated but never deleted — its history stays intact."
    >
      {types.map((type) => {
        const inType = accounts.filter((a) => a.type === type);
        if (inType.length === 0) return null;
        return (
          <Panel key={type} title={label(type)}>
            <table className="ledger">
              <thead>
                <tr>
                  <th className="w-20">Code</th>
                  <th>Name</th>
                  <th className="w-40">Report section</th>
                  <th className="w-24">VAT</th>
                  <th className="w-28">Status</th>
                </tr>
              </thead>
              <tbody>
                {inType.map((account) => (
                  <tr key={account.id}>
                    <td className="num !text-left">{account.code}</td>
                    <td>
                      <Link href={`/reports/account/${account.id}`}
                        className="text-accent hover:underline">
                        {account.name}
                      </Link>
                      {account.description && (
                        <div className="text-[11px] text-ink-faint max-w-2xl mt-0.5 leading-snug">
                          {account.description}
                        </div>
                      )}
                    </td>
                    <td className="text-ink-muted">{label(account.reportSection)}</td>
                    <td>
                      {account.vatApplicable
                        ? <span className="text-ink-muted">Applicable</span>
                        : <span className="text-ink-faint">Not applicable</span>}
                    </td>
                    <td>
                      <div className="flex gap-1 flex-wrap">
                        {account.isSystem && (
                          <Badge tone="accent" title="The posting engine addresses this account by name. It cannot be deleted.">
                            System
                          </Badge>
                        )}
                        {!account.active && <Badge tone="neutral">Inactive</Badge>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        );
      })}
    </Page>
  );
}
