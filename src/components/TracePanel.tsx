import Link from 'next/link';
import { Panel, Badge } from './primitives';
import { money, date, rate } from '@/lib/format';
import type { TransactionTrace } from '@/domain/consolidation/trace';

/**
 * Where this bank line's VAT came from (issue #203): payment → invoice →
 * confirmed document → line → rule → VAT entry → VAT3 box and period.
 * Renders the stored trace only; it computes nothing.
 */
export function TracePanel({ trace }: { trace: TransactionTrace }) {
  if (trace.kind === 'unposted') return null;
  return (
    <Panel
      title="Where the VAT comes from"
      description={trace.kind === 'settled'
        ? 'This payment settles the invoices below. Their VAT was posted from the confirmed document lines, not from the bank amount.'
        : 'Posted without an invoice. No input VAT is claimed on a purchase until its invoice is confirmed, posted and settled.'}
    >
      {trace.flags.length > 0 && (
        <ul className="px-4 py-2 bg-caution-soft border-b border-caution/30 text-[12px] text-caution space-y-0.5">
          {trace.flags.map((f) => <li key={f}>{f}</li>)}
        </ul>
      )}
      {trace.invoices.map((inv) => (
        <div key={inv.invoiceId} className="border-b border-line last:border-0">
          <div className="px-4 pt-2.5 pb-1 text-[12.5px] flex flex-wrap gap-x-2">
            <Link href={`/invoices/${inv.invoiceId}`} className="text-accent hover:underline font-medium">
              {inv.isCreditNote ? 'Credit note' : 'Invoice'} {inv.invoiceNumber ?? ''}
            </Link>
            <span className="text-ink-muted">{date(inv.invoiceDate)} · {money(inv.grossMinor, inv.currency)} · this payment {money(inv.allocatedMinor, inv.currency)}</span>
            {inv.document && (
              <span className="text-ink-muted">
                · evidence <Link href={`/documents/${inv.document.id}`} className="text-accent hover:underline">{inv.document.filename}</Link>
                {inv.document.reviewedBy && ` (confirmed by ${inv.document.reviewedBy})`}
              </span>
            )}
          </div>
          <table className="ledger">
            <thead>
              <tr><th>Line</th><th>Treatment and rule</th><th className="text-right">Net</th><th className="text-right">VAT</th><th>VAT entries</th></tr>
            </thead>
            <tbody>
              {inv.lines.map((l) => (
                <tr key={l.lineNumber}>
                  <td>
                    {l.lineNumber}. {l.description}
                    {l.documentLine && <div className="text-[11px] text-ink-faint">printed line {l.documentLine.lineNumber}</div>}
                  </td>
                  <td>
                    {l.treatment ? `${l.treatment.name} (${l.treatment.code})` : '—'}
                    {l.rules.map((r) => (
                      <div key={r.ruleKey} className="text-[11px]">
                        <Link href={`/statutes/provision/${r.provisionId}`} className="text-accent hover:underline">{r.name}</Link>
                      </div>
                    ))}
                  </td>
                  <td className="text-right num">{money(l.netMinor, inv.currency)}</td>
                  <td className="text-right num">{money(l.vatMinor, inv.currency)}</td>
                  <td className="text-[11.5px]">
                    {l.vatEntries.length === 0 && <span className="text-ink-faint">none</span>}
                    {l.vatEntries.map((e) => (
                      <div key={e.id} className="flex flex-wrap gap-1 items-center">
                        <Badge tone="accent">{e.vatBox ?? '—'}</Badge>
                        {e.netBox && <Badge tone="neutral">{e.netBox}</Badge>}
                        <span className="num">{money(e.direction === 'purchases' ? e.recoverableVatMinor : e.vatMinor, e.currency)}</span>
                        <span className="text-ink-faint">{rate(e.rateBasisPoints)} · {e.periodName ?? date(e.taxPointDate)}{e.arose === 'payment' ? ' · due on receipt' : ''}</span>
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {trace.payment && trace.payment.unallocatedMinor > 0 && (
        <p className="px-4 py-2 text-[12px] text-caution">
          {money(trace.payment.unallocatedMinor, trace.payment.currency)} of this payment is on account, not yet allocated to an invoice.
        </p>
      )}
    </Panel>
  );
}
