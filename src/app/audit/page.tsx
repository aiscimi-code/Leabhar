import { auditTrail } from '@/lib/queries';
import { Page, Panel, Badge, Empty } from '@/components/primitives';
import { dateTime, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** Audit trail (README §31). Append-only, in order. */
export default function AuditPage() {
  const events = auditTrail(300);

  return (
    <Page
      title="Audit trail"
      subtitle="Every significant change, in order. Records are append-only: nothing here can
        be edited or removed."
    >
      <Panel>
        {events.length === 0 ? <Empty title="Nothing recorded yet" /> : (
          <table className="ledger">
            <thead>
              <tr>
                <th className="w-36">When</th>
                <th className="w-36">What</th>
                <th className="w-40">Record</th>
                <th>Detail</th>
                <th className="w-24">By</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td className="num !text-left text-ink-muted">{dateTime(event.occurredAt)}</td>
                  <td><Badge tone="neutral">{label(event.action)}</Badge></td>
                  <td className="text-ink-muted">{label(event.entityType)}</td>
                  <td>
                    {event.field && (
                      <span className="text-ink-faint">{event.field}: </span>
                    )}
                    {event.previousValue && (
                      <span className="text-ink-muted line-through mr-1.5">
                        {truncate(event.previousValue)}
                      </span>
                    )}
                    {event.newValue && <span className="text-ink">{truncate(event.newValue)}</span>}
                    {event.reason && (
                      <div className="text-[11.5px] text-ink-muted mt-0.5">{event.reason}</div>
                    )}
                  </td>
                  <td className="text-ink-muted">
                    {event.actor}
                    <div className="text-[10.5px] text-ink-faint">{label(event.source)}</div>
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

function truncate(value: string, max = 160): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
