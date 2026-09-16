import Link from 'next/link';
import { dashboardData, activeCompany } from '@/lib/queries';
import { Page, Panel, Stat, Badge, Help, LinkButton, Figure, Empty } from '@/components/primitives';
import { money, date, plural } from '@/lib/format';
import { daysBetween, asIsoDate, today } from '@/domain/dates';

export const dynamic = 'force-dynamic';

/**
 * Financial dashboard (README §32).
 *
 * Deliberately not a marketing dashboard: figures, an accounting-health panel
 * that shows problems rather than hiding them, and deadlines. Every number
 * links to what it is made of.
 */
export default function DashboardPage() {
  if (!activeCompany()) return <NoCompany />;

  const data = dashboardData();
  const { health } = data;
  const currency = data.company.baseCurrency;

  return (
    <Page
      title="Dashboard"
      subtitle={`${data.company.legalName} — financial year ${date(data.yearStart)} to ${date(data.yearEnd)}`}
      actions={<LinkButton href="/import" variant="primary">Refresh / import bank data</LinkButton>}
    >
      <div className="grid grid-cols-4 gap-px bg-line border border-line rounded overflow-hidden mb-4">
        <div className="bg-surface">
          <Stat
            label="Bank balance" value={money(data.bankBalanceMinor, currency)}
            href="/transactions"
            hint={`${data.bankAccounts.length} ${plural(data.bankAccounts.length, 'account')}`}
          />
        </div>
        <div className="bg-surface">
          <Stat label="Revenue" value={money(data.revenueMinor, currency)} href="/reports" />
        </div>
        <div className="bg-surface">
          <Stat label="Expenses" value={money(data.expensesMinor, currency)} href="/reports" />
        </div>
        <div className="bg-surface">
          <Stat
            label="Profit" value={money(data.profitMinor, currency)}
            tone={data.profitMinor >= 0 ? 'positive' : 'negative'}
            href="/reports"
            hint="Accounting profit, not taxable profit"
          />
        </div>
      </div>

      <div className="grid grid-cols-4 gap-px bg-line border border-line rounded overflow-hidden mb-5">
        <div className="bg-surface">
          <Stat
            label="VAT position"
            value={money(Math.abs(data.vatPositionMinor), currency)}
            tone={data.vatPositionMinor > 0 ? 'caution' : 'positive'}
            href={data.currentVatPeriod ? `/vat/${data.currentVatPeriod.id}` : '/vat'}
            hint={data.currentVatPeriod
              ? `${data.currentVatPeriod.name} — ${data.vatPositionMinor >= 0 ? 'payable' : 'repayable'}`
              : 'No VAT period'}
          />
        </div>
        <div className="bg-surface">
          <Stat
            label="Owed by customers" value={money(data.debtorsMinor, currency)}
            href="/reports" hint="Invoiced but not yet received"
          />
        </div>
        <div className="bg-surface">
          <Stat
            label="Owed to suppliers" value={money(data.creditorsMinor, currency)}
            href="/reports" hint="Invoiced but not yet paid"
          />
        </div>
        <div className="bg-surface">
          <Stat
            label="Director's account"
            value={money(data.directorsAccountMinor, currency)}
            tone={data.directorsAccountMinor < 0 ? 'caution' : 'default'}
            href="/reports"
            hint={data.directorsAccountMinor < 0
              ? 'Director owes the company — worth discussing with your accountant'
              : 'The company owes the director'}
          />
        </div>
      </div>

      <div className="grid grid-cols-[1.1fr_1fr] gap-4 items-start">
        <Panel
          title="Accounting health"
          description="What still needs your attention before this period can be relied on."
          actions={<LinkButton href="/review">Open review queue</LinkButton>}
        >
          <table className="ledger">
            <tbody>
              <HealthRow
                label="Bank reconciliation"
                help="Whether every imported transaction has an accounting treatment. Until they all do, the reported figures are incomplete."
                ok={health.reconciled}
                value={health.reconciled ? 'Complete' : `${health.unclassified} unclassified`}
                href="/transactions?status=unclassified"
              />
              <HealthRow
                label="Documents attached"
                help="The share of uploaded documents matched to a bank transaction. VAT reclaimed without a supporting invoice can be disallowed on audit."
                ok={health.documentCoveragePercent >= 95}
                value={`${health.documentCoveragePercent}% (${health.documentsMatched} of ${health.documentsTotal})`}
                href="/documents"
              />
              <HealthRow
                label="VAT classifications"
                help="The share of transactions carrying a VAT treatment. A transaction without one contributes nothing to your VAT return."
                ok={health.vatClassifiedPercent === 100}
                value={`${health.vatClassifiedPercent}%`}
                href="/transactions"
              />
              <HealthRow
                label="Transactions missing a document"
                help="Classified transactions with no invoice or receipt attached."
                ok={health.missingDocuments === 0}
                value={String(health.missingDocuments)}
                href="/review"
              />
              <HealthRow
                label="Duplicate warnings"
                help="Transactions the system believes may have been imported or paid twice. A duplicated purchase would reclaim the same VAT twice."
                ok={health.duplicateWarnings === 0}
                value={String(health.duplicateWarnings)}
                href="/review"
              />
              <HealthRow
                label="Open review items"
                help="Everything the system has flagged for a decision. The aim is that you spend time only on exceptions."
                ok={health.openReviewItems === 0}
                value={String(health.openReviewItems)}
                href="/review"
              />
            </tbody>
          </table>
        </Panel>

        <Panel
          title="Upcoming deadlines"
          description="Dates you configured. Confirm them against your own obligations."
          actions={<LinkButton href="/calendar">Full calendar</LinkButton>}
        >
          {data.upcomingDeadlines.length === 0 ? (
            <Empty title="No deadlines configured" detail="Add them in the tax calendar." />
          ) : (
            <table className="ledger">
              <tbody>
                {data.upcomingDeadlines.map((deadline) => {
                  const days = daysBetween(today(), asIsoDate(deadline.dueDate));
                  const tone = days < 0 ? 'negative' : days <= 14 ? 'caution' : 'neutral';
                  return (
                    <tr key={deadline.id}>
                      <td className="w-24 num !text-left">{date(deadline.dueDate)}</td>
                      <td>
                        <div className="text-ink">{deadline.title}</div>
                        {deadline.sourceNote && (
                          <div className="text-[11px] text-ink-faint mt-0.5">{deadline.sourceNote}</div>
                        )}
                      </td>
                      <td className="w-28 text-right">
                        <Badge tone={tone}>
                          {days < 0 ? `${Math.abs(days)}d overdue`
                            : days === 0 ? 'Today' : `in ${days}d`}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <Panel title="Bank accounts">
        <table className="ledger">
          <thead>
            <tr>
              <th>Bank</th><th>Account</th><th>IBAN</th><th>Currency</th>
              <th className="text-right">Balance per ledger</th>
            </tr>
          </thead>
          <tbody>
            {data.bankAccounts.map(({ account, balanceMinor }) => (
              <tr key={account.id}>
                <td>{account.bankName}</td>
                <td>{account.accountName}</td>
                <td className="num !text-left text-ink-muted">{account.iban ?? '—'}</td>
                <td>{account.currency}</td>
                <td className="text-right">
                  <Figure
                    value={money(balanceMinor, account.currency)}
                    negative={balanceMinor < 0}
                    href={`/transactions?bankAccountId=${account.id}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </Page>
  );
}

function HealthRow({ label, help, ok, value, href }: {
  label: string; help: string; ok: boolean; value: string; href: string;
}) {
  return (
    <tr>
      <td className="w-64">
        {label}
        <Help>{help}</Help>
      </td>
      <td className="text-right">
        <Link href={href} className="hover:underline">
          <Badge tone={ok ? 'positive' : 'caution'}>{ok ? '✓ ' : '⚠ '}{value}</Badge>
        </Link>
      </td>
    </tr>
  );
}

function NoCompany() {
  return (
    <Page title="Welcome">
      <Panel title="No company set up yet">
        <div className="px-4 py-6 max-w-2xl">
          <p className="text-ink-muted mb-4">
            This application keeps a structured double-entry accounting database for one
            Irish company, on this machine. Nothing is sent anywhere.
          </p>
          <p className="text-ink-muted mb-4">
            To get started, either create your company or load the demo data to see how
            everything fits together first. Demo data is labelled as such everywhere it
            appears, so it can never be mistaken for your own books.
          </p>
          <div className="flex gap-2">
            <LinkButton href="/settings/company" variant="primary">Create your company</LinkButton>
            <LinkButton href="/settings/company#demo">Load demo data</LinkButton>
          </div>
        </div>
      </Panel>
    </Page>
  );
}
