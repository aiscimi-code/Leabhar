import Link from 'next/link';
import { ledgerRows, bankAccountList, chartOfAccounts } from '@/lib/queries';
import { Page, Panel, Badge, ProvenanceBadge, Figure, Empty, LinkButton } from '@/components/primitives';
import { StatusBadge } from '@/components/StatusBadge';
import { money, date, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Transaction ledger (README §15).
 *
 * One transaction per row, scannable at a glance, with every row opening a
 * detail view. The column set is exactly the one README §15 specifies.
 */
export default async function TransactionsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const rows = ledgerRows({
    status: params['status'],
    bankAccountId: params['bankAccountId'],
    accountId: params['accountId'],
    search: params['q'],
    from: params['from'],
    to: params['to'],
  });
  const banks = bankAccountList();

  const totalIn = rows.filter((r) => r.transaction.amountMinor > 0)
    .reduce((s, r) => s + r.transaction.amountMinor, 0);
  const totalOut = rows.filter((r) => r.transaction.amountMinor < 0)
    .reduce((s, r) => s + r.transaction.amountMinor, 0);

  return (
    <Page
      title="Transactions"
      subtitle={`${rows.length} shown. Money in ${money(totalIn)}, money out ${money(totalOut)}.`}
      actions={<LinkButton href="/import" variant="primary">Import bank data</LinkButton>}
    >
      <Panel>
        <form method="get" className="flex flex-wrap items-end gap-2 px-4 py-2.5 border-b border-line">
          <div>
            <label className="block text-[10px] uppercase tracking-wide font-semibold text-ink-faint mb-0.5">
              Search
            </label>
            <input
              type="search" name="q" defaultValue={params['q'] ?? ''}
              placeholder="Description, reference, counterparty"
              className="border border-line-strong rounded px-2 py-1 text-[12px] w-64"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide font-semibold text-ink-faint mb-0.5">
              Status
            </label>
            <select
              name="status" defaultValue={params['status'] ?? 'all'}
              className="border border-line-strong rounded px-2 py-1 text-[12px]"
            >
              {['all', 'unclassified', 'suggested', 'classified', 'matched', 'posted',
                'reconciled', 'ignored', 'duplicate'].map((s) => (
                <option key={s} value={s}>{s === 'all' ? 'All' : label(s)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide font-semibold text-ink-faint mb-0.5">
              Bank account
            </label>
            <select
              name="bankAccountId" defaultValue={params['bankAccountId'] ?? ''}
              className="border border-line-strong rounded px-2 py-1 text-[12px]"
            >
              <option value="">All accounts</option>
              {banks.map((b) => (
                <option key={b.id} value={b.id}>{b.bankName} — {b.accountName}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide font-semibold text-ink-faint mb-0.5">
              From
            </label>
            <input type="date" name="from" defaultValue={params['from'] ?? ''}
              className="border border-line-strong rounded px-2 py-1 text-[12px]" />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wide font-semibold text-ink-faint mb-0.5">
              To
            </label>
            <input type="date" name="to" defaultValue={params['to'] ?? ''}
              className="border border-line-strong rounded px-2 py-1 text-[12px]" />
          </div>
          <button type="submit"
            className="px-2.5 py-1 rounded border border-accent bg-accent text-white text-[12px] font-medium">
            Apply
          </button>
          <Link href="/transactions" className="text-[12px] text-ink-muted hover:underline px-1">
            Clear
          </Link>
        </form>

        {rows.length === 0 ? (
          <Empty
            title="No transactions match"
            detail="Import a bank statement, or clear the filters above."
            action={<LinkButton href="/import" variant="primary">Import bank data</LinkButton>}
          />
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th className="w-[92px]">Date</th>
                <th>Description</th>
                <th className="w-[110px] text-right">Amount</th>
                <th className="w-[52px]">Cur</th>
                <th className="w-[190px]">Account</th>
                <th className="w-[160px]">VAT treatment</th>
                <th className="w-[96px] text-right">VAT</th>
                <th className="w-[70px]">Doc</th>
                <th className="w-[130px]">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const t = row.transaction;
                return (
                  <tr key={t.id} className="clickable">
                    <td className="num !text-left">
                      <Link href={`/transactions/${t.id}`} className="hover:underline">
                        {date(t.transactionDate)}
                      </Link>
                    </td>
                    <td>
                      <Link href={`/transactions/${t.id}`} className="hover:underline text-ink">
                        {t.description}
                      </Link>
                      {(row.supplierName ?? row.customerName) && (
                        <span className="text-ink-faint ml-1.5">
                          {row.supplierName ?? row.customerName}
                        </span>
                      )}
                      {t.bankReference && (
                        <div className="text-[11px] text-ink-faint">Ref {t.bankReference}</div>
                      )}
                    </td>
                    <td className="text-right">
                      <Figure
                        value={money(t.amountMinor, t.currency)}
                        negative={t.amountMinor < 0}
                        href={`/transactions/${t.id}`}
                      />
                    </td>
                    <td className="text-ink-muted">{t.currency}</td>
                    <td>
                      {row.accountCode
                        ? <span className="text-ink">
                            <span className="num !text-left text-ink-faint mr-1">{row.accountCode}</span>
                            {row.accountName}
                          </span>
                        : <span className="text-ink-faint">Not classified</span>}
                    </td>
                    <td>
                      {row.treatmentName
                        ? <span title={row.treatmentCode ?? ''}>{row.treatmentName}</span>
                        : <span className="text-ink-faint">—</span>}
                    </td>
                    <td className="text-right">
                      <span className="num">{row.vatMinor ? money(row.vatMinor, t.currency) : '—'}</span>
                    </td>
                    <td>
                      {row.documentId
                        ? <Link href={`/documents/${row.documentId}`} title={row.documentName ?? ''}>
                            <Badge tone="positive">Yes</Badge>
                          </Link>
                        : <Badge tone="neutral">—</Badge>}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        <StatusBadge status={t.status} />
                        <ProvenanceBadge
                          status={t.provenanceStatus} confidence={t.confidence} source={t.source}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
    </Page>
  );
}
