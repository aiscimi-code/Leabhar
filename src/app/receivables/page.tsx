import Link from 'next/link';
import { activeCompany, receivablesPage, aged } from '@/lib/queries';
import { Page, Panel, Stat, Empty, Badge } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { produceReminderAction } from '@/app/actions';
import { money, date } from '@/lib/format';
import { asIsoDate } from '@/domain/dates';

export const dynamic = 'force-dynamic';

/**
 * Receivables (issue #405): what customers owe, what is overdue as at today,
 * and reminders. Overdue is computed on the day, never stored. Every figure is
 * the domain's; this page only lays them out.
 */
export default async function ReceivablesPage({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  if (!activeCompany()) {
    return <Page title="Receivables"><Panel><Empty title="No company yet" /></Panel></Page>;
  }
  const { asOf: raw } = await searchParams;
  const asOf = asIsoDate(raw ?? new Date().toISOString().slice(0, 10));
  const { summary, overdue, currency } = receivablesPage(asOf);
  const ageing = aged('sales', asOf);
  const customersOverdue = [...new Map(overdue.map((o) => [o.customerId, o])).values()];

  return (
    <Page title="Receivables" subtitle={`What customers owe, as at ${date(asOf)}.`}>
      <Panel>
        <div className="grid grid-cols-4 divide-x divide-line">
          <Stat label="Owed" value={money(summary.owedMinor, currency)} />
          <Stat label="Overdue" value={money(summary.overdueMinor, currency)} tone={summary.overdueMinor > 0 ? 'negative' : undefined}
            hint={`${summary.overdueCount} invoice${summary.overdueCount === 1 ? '' : 's'}`} />
          <Stat label="Held on account" value={money(summary.onAccountMinor, currency)} hint="Not yet applied to an invoice" />
          <Stat label="Need a reminder" value={String(summary.needingReminder)} hint="Overdue, no reminder in 14 days" />
        </div>
      </Panel>

      <Panel title="Aged debtors">
        <div className="grid grid-cols-6 divide-x divide-line">
          {ageing.buckets.map((b) => <Stat key={b.label} label={b.label} value={money(b.amountMinor, currency)} />)}
          <Stat label="Total" value={money(ageing.totalMinor, currency)} />
        </div>
      </Panel>

      <Panel title="Overdue invoices" description="Produce a reminder letter for a customer's overdue invoices; it is recorded, and the PDF is yours to send.">
        {overdue.length === 0 ? <Empty title="Nothing is overdue" /> : (
          <table className="ledger">
            <thead><tr><th>Customer</th><th>Invoice</th><th className="w-28">Due</th><th className="w-20 text-right">Days</th><th className="w-32 text-right">Outstanding</th><th className="w-40">Last reminder</th></tr></thead>
            <tbody>
              {overdue.map((o) => (
                <tr key={o.invoiceId}>
                  <td>{o.customerId ? <Link href={`/customers/${o.customerId}`} className="hover:underline">{o.customerName}</Link> : '—'}</td>
                  <td><Link href={`/invoices/${o.invoiceId}`} className="hover:underline">{o.number}</Link></td>
                  <td>{date(o.dueDate)}</td>
                  <td className="num">{o.daysOverdue}</td>
                  <td className="num">{money(o.outstandingMinor, o.currency)}</td>
                  <td className="text-ink-muted">{o.lastReminderLevel ? `Level ${o.lastReminderLevel}, ${date(o.lastReminderOn)}` : 'None'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {customersOverdue.length > 0 && (
          <div className="px-4 py-3 border-t border-line space-y-2">
            {customersOverdue.map((o) => o.customerId && (
              <div key={o.customerId} className="flex items-center gap-3">
                <span className="w-48 text-[12.5px]">{o.customerName}</span>
                <ActionForm action={produceReminderAction} submit="Produce reminder" inline
                  extra={{ customerId: o.customerId, asOf }}>
                  <select name="level" defaultValue={String(Math.min((o.lastReminderLevel ?? 0) + 1, 3))}
                    className="border border-line-strong rounded px-2 py-1 bg-surface text-[12.5px]">
                    <option value="1">Reminder</option>
                    <option value="2">Second reminder</option>
                    <option value="3">Final notice</option>
                  </select>
                </ActionForm>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Largest balances">
        {summary.topDebtors.length === 0 ? <Empty title="No customer owes anything" /> : (
          <table className="ledger">
            <thead><tr><th>Customer</th><th className="w-32 text-right">Owes</th><th className="w-32 text-right">Overdue</th><th className="w-32" /></tr></thead>
            <tbody>
              {summary.topDebtors.map((d) => (
                <tr key={d.customerId}>
                  <td><Link href={`/customers/${d.customerId}`} className="hover:underline">{d.name}</Link>
                    {summary.overLimit.some((c) => c.customerId === d.customerId) && <Badge tone="negative">over limit</Badge>}</td>
                  <td className="num">{money(d.owedMinor, currency)}</td>
                  <td className="num">{money(d.overdueMinor, currency)}</td>
                  <td><a className="text-accent hover:underline text-[12px]" href={`/api/customers/${d.customerId}/statement?to=${asOf}`}>Statement</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </Page>
  );
}
