import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/db';
import { requireCompany } from '@/lib/queries';
import { generalLedger } from '@/domain/accounting/ledger';
import { Page, Panel, Badge, Empty, LinkButton } from '@/components/primitives';
import { accountingMoney, money, date, label } from '@/lib/format';
import { asIsoDate } from '@/domain/dates';

export const dynamic = 'force-dynamic';

/**
 * General ledger for one account (README §37, §43).
 *
 * The drill-down target from any report line. Each row links onward to the
 * transaction and its document, completing the chain from a reported figure to
 * the original evidence.
 */
export default async function AccountLedgerPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const company = requireCompany();

  let ledger;
  try {
    ledger = generalLedger(getDb(), {
      companyId: company.id,
      accountId: id,
      from: query['from'] ? asIsoDate(query['from']) : undefined,
      to: query['to'] ? asIsoDate(query['to']) : undefined,
    });
  } catch {
    notFound();
  }

  const { account, lines, closingBalanceMinor } = ledger;
  const currency = company.baseCurrency;

  return (
    <Page
      title={`${account.code} ${account.name}`}
      subtitle={
        <span>
          {label(account.type)}
          {account.subtype && ` · ${label(account.subtype)}`}
          {' · '}{lines.length} {lines.length === 1 ? 'entry' : 'entries'}
          {account.isSystem && <> · <Badge tone="accent">System account</Badge></>}
        </span>
      }
      actions={<LinkButton href="/reports">Back to statements</LinkButton>}
    >
      {account.description && (
        <Panel>
          <p className="px-4 py-3 text-ink-muted max-w-3xl leading-relaxed">{account.description}</p>
        </Panel>
      )}

      <Panel
        title="Why this number"
        description={`Every journal line posted to this account, with a running balance.
          Follow any row to the transaction behind it.`}
      >
        {lines.length === 0 ? (
          <Empty title="Nothing posted to this account yet" />
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th className="w-24">Date</th>
                <th className="w-16 text-right">Entry</th>
                <th>Narrative</th>
                <th className="w-28 text-right">Debit</th>
                <th className="w-28 text-right">Credit</th>
                <th className="w-32 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.lineId} className={line.isReversal ? 'text-ink-muted' : ''}>
                  <td className="num !text-left">{date(line.entryDate)}</td>
                  <td className="text-right num text-ink-faint">#{line.entryNumber}</td>
                  <td>
                    {line.sourceType === 'bank_transaction' && line.sourceId ? (
                      <Link href={`/transactions/${line.sourceId}`} className="text-accent hover:underline">
                        {line.narrative}
                      </Link>
                    ) : line.narrative}
                    {line.isReversal && <Badge tone="caution">Reversal</Badge>}
                    {line.memo && line.memo !== line.narrative && (
                      <div className="text-[11.5px] text-ink-faint">{line.memo}</div>
                    )}
                  </td>
                  <td className="text-right num">
                    {line.debitMinor ? money(line.debitMinor, currency) : ''}
                  </td>
                  <td className="text-right num">
                    {line.creditMinor ? money(line.creditMinor, currency) : ''}
                  </td>
                  <td className="text-right num">
                    {accountingMoney(line.runningBalanceMinor, currency)}
                  </td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td colSpan={3}>Closing balance</td>
                <td className="text-right num">
                  {money(lines.reduce((s, l) => s + l.debitMinor, 0), currency)}
                </td>
                <td className="text-right num">
                  {money(lines.reduce((s, l) => s + l.creditMinor, 0), currency)}
                </td>
                <td className="text-right num">{accountingMoney(closingBalanceMinor, currency)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </Panel>
    </Page>
  );
}
