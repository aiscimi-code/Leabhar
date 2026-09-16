import {
  activeCompany, bankAccountList, reconciliation, pastReconciliations,
} from '@/lib/queries';
import {
  Page, Panel, Badge, Stat, Empty, Field, Input, Select, Button, Disclosure,
} from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { reconcileAction } from '@/app/settings-actions';
import { money, date, dateTime, label } from '@/lib/format';
import { asIsoDate } from '@/domain/dates';

export const dynamic = 'force-dynamic';

const SOURCE_NOTE: Record<string, string> = {
  statement_running_balance:
    'Taken from the running balance on the imported statement — the bank’s own figure.',
  supplied: 'The closing balance you typed in from the paper statement.',
  derived_from_movements:
    'No running balance was imported, so this figure was added up from the transactions '
    + 'themselves. That means it cannot detect a line the statement has and the books do not: '
    + 'type the closing balance from your statement to make this check meaningful.',
};

/** Bank reconciliation (README §21). */
export default async function ReconcilePage({ searchParams }: {
  searchParams: Promise<{ account?: string; from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const company = activeCompany();
  const accounts = company ? bankAccountList() : [];

  if (!company || accounts.length === 0) {
    return (
      <Page title="Reconcile" subtitle="Agree the books to the bank.">
        <Panel>
          <Empty
            title="No bank account to reconcile"
            detail="Add a bank account and import a statement first."
            action={<a href="/settings/company" className="text-accent hover:underline">
              Company settings
            </a>}
          />
        </Panel>
      </Page>
    );
  }

  const selected = accounts.find((account) => account.id === params.account) ?? accounts[0]!;
  const year = new Date().getFullYear();
  const from = params.from ?? `${year}-01-01`;
  const to = params.to ?? new Date().toISOString().slice(0, 10);

  const result = reconciliation(selected.id, asIsoDate(from), asIsoDate(to));
  const history = pastReconciliations()
    .filter((record) => record.bankAccountId === selected.id);

  return (
    <Page
      title="Reconcile"
      subtitle="What the bank says, against what the books say, and every item that explains
        the difference between them."
    >
      <Panel>
        <form method="get" action="/reconcile" className="px-4 py-3 flex items-end gap-3 flex-wrap">
          <div className="min-w-64">
            <label className="block text-[11px] uppercase tracking-wide font-semibold
              text-ink-faint mb-1">Account</label>
            <Select name="account" defaultValue={selected.id}>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.bankName} — {account.accountName} ({account.currency})
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wide font-semibold
              text-ink-faint mb-1">From</label>
            <Input name="from" type="date" defaultValue={from} />
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wide font-semibold
              text-ink-faint mb-1">To</label>
            <Input name="to" type="date" defaultValue={to} />
          </div>
          <Button type="submit">Recalculate</Button>
        </form>
      </Panel>

      <Panel tone={result.reconciled ? 'positive' : 'warning'}>
        <div className="grid grid-cols-4 divide-x divide-line">
          <Stat
            label="Bank says"
            value={money(result.statementBalanceMinor, result.currency)}
            hint={label(result.statementBalanceSource)}
          />
          <Stat
            label="Books say"
            value={money(result.ledgerBalanceMinor, result.currency)}
            hint="Balance on the bank control account at the closing date."
          />
          <Stat
            label="Difference"
            value={money(result.differenceMinor, result.currency)}
            tone={result.differenceMinor === 0 ? 'positive' : 'caution'}
          />
          <Stat
            label="Unexplained"
            value={money(result.unexplainedMinor, result.currency)}
            tone={result.unexplainedMinor === 0 ? 'positive' : 'negative'}
            hint="What is left once every item below is accounted for."
          />
        </div>
        <div className="px-4 py-2.5 border-t border-line">
          <p className="text-ink leading-snug">{result.summary}</p>
          <p className="text-ink-muted text-[11.5px] mt-1.5 leading-snug">
            {SOURCE_NOTE[result.statementBalanceSource]}
          </p>
        </div>
      </Panel>

      <Panel
        title="Items to resolve"
        description="Each of these is a reason the two figures differ. Resolve them at source
          rather than by forcing the balance."
      >
        {result.items.length === 0 ? (
          <Empty
            title="Nothing outstanding"
            detail="Every transaction in the period is posted, matched and unique."
          />
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th className="w-52">Kind</th>
                <th className="w-28">Date</th>
                <th>What</th>
                <th className="w-32 text-right">Amount</th>
                <th className="w-24">Open</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((item) => (
                <tr key={`${item.kind}:${item.entityId}`}>
                  <td>
                    <Badge tone={item.kind === 'suspected_duplicate' ? 'caution' : 'neutral'}>
                      {item.label}
                    </Badge>
                  </td>
                  <td className="num !text-left">{date(item.date)}</td>
                  <td>
                    <div className="text-ink">{item.description}</div>
                    <div className="text-ink-muted mt-0.5 leading-snug max-w-2xl">
                      {item.explanation}
                    </div>
                  </td>
                  <td className="text-right num">{money(item.amountMinor, result.currency)}</td>
                  <td>
                    <a
                      href={item.entityType === 'bank_transaction'
                        ? `/transactions/${item.entityId}`
                        : `/audit?entry=${item.entityId}`}
                      className="text-accent hover:underline"
                    >
                      Open
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="px-4 py-2.5 border-t border-line grid grid-cols-5 gap-3 text-[11.5px]">
          <Count label="Transactions in period" value={result.counts.transactionsInPeriod} />
          <Count label="Not yet posted" value={result.counts.unposted} />
          <Count label="In books only" value={result.counts.ledgerOnly} />
          <Count label="Suspected duplicates" value={result.counts.suspectedDuplicates} />
          <Count label="Missing a document" value={result.counts.missingDocuments} />
        </div>
      </Panel>

      <Panel title="Record this reconciliation">
        <Disclosure summary="Sign off the period" tone="accent">
          <div className="max-w-3xl">
            <p className="text-ink-muted mb-3 leading-snug">
              Recording a reconciliation marks these transactions as reconciled and stores
              what the two sides said on the day. It changes no imported figure. If a
              difference remains, it can only be recorded with a reason — this application
              will not write a balancing entry to make the difference disappear.
            </p>
            <ActionForm
              action={reconcileAction} submit="Record reconciliation"
              extra={{
                bankAccountId: selected.id, periodStart: from, periodEnd: to,
                currency: result.currency,
              }}
            >
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="Closing balance per statement"
                  help="Type the figure printed on the paper or PDF statement. Leaving it
                    blank uses the imported running balance, which cannot reveal a line that
                    never reached the import."
                >
                  <Input name="statementClosingBalance"
                    placeholder={(result.statementBalanceMinor / 100).toFixed(2)} />
                </Field>
                <Field
                  label="Reason, if a difference remains"
                  hint="Required only when the unexplained difference is not zero."
                >
                  <Input name="acceptReason"
                    placeholder="Bank fee posted after the statement date" />
                </Field>
              </div>
            </ActionForm>
          </div>
        </Disclosure>
      </Panel>

      <Panel title="Previous reconciliations">
        {history.length === 0 ? <Empty title="None recorded yet" /> : (
          <table className="ledger">
            <thead>
              <tr>
                <th className="w-28">From</th><th className="w-28">To</th>
                <th className="w-32 text-right">Bank</th>
                <th className="w-32 text-right">Books</th>
                <th className="w-32 text-right">Difference</th>
                <th>Notes</th>
                <th className="w-32">Status</th>
                <th className="w-40">Recorded</th>
              </tr>
            </thead>
            <tbody>
              {history.map((record) => (
                <tr key={record.id}>
                  <td className="num !text-left">{date(record.periodStart)}</td>
                  <td className="num !text-left">{date(record.periodEnd)}</td>
                  <td className="text-right num">
                    {money(record.statementClosingBalanceMinor, selected.currency)}
                  </td>
                  <td className="text-right num">
                    {money(record.ledgerBalanceMinor, selected.currency)}
                  </td>
                  <td className="text-right num">
                    {money(record.differenceMinor, selected.currency)}
                  </td>
                  <td className="text-ink-muted">{record.notes ?? '—'}</td>
                  <td>
                    <Badge tone={record.status === 'balanced' ? 'positive'
                      : record.status === 'unbalanced' ? 'caution' : 'neutral'}>
                      {label(record.status)}
                    </Badge>
                  </td>
                  <td className="text-ink-muted text-[11.5px]">
                    {dateTime(record.completedAt ?? record.createdAt)}
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

function Count({ label: countLabel, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-ink-faint uppercase tracking-wide font-semibold text-[10px]">
        {countLabel}
      </div>
      <div className="num !text-left text-ink font-medium">{value}</div>
    </div>
  );
}
