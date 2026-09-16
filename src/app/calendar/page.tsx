import { deadlineList } from '@/lib/queries';
import { Page, Panel, Badge, Empty } from '@/components/primitives';
import { money, date, label } from '@/lib/format';
import { daysBetween, asIsoDate, today } from '@/domain/dates';

export const dynamic = 'force-dynamic';

/** Tax and compliance calendar (README §35). */
export default function CalendarPage() {
  const deadlines = deadlineList();
  const now = today();

  const upcoming = deadlines.filter((d) => d.dueDate >= now && d.status !== 'submitted');
  const past = deadlines.filter((d) => d.dueDate < now || d.status === 'submitted');

  return (
    <Page
      title="Tax calendar"
      subtitle="Dates generated from your own configuration. Nothing here is a date this
        application knows to be correct for you — confirm them with Revenue, the CRO or your
        accountant."
    >
      <Panel title={`Upcoming (${upcoming.length})`}>
        {upcoming.length === 0 ? <Empty title="Nothing upcoming" /> : (
          <table className="ledger">
            <thead>
              <tr>
                <th className="w-28">Due</th>
                <th className="w-24 text-right">In</th>
                <th>Deadline</th>
                <th className="w-40">Covers</th>
                <th className="w-28">Type</th>
              </tr>
            </thead>
            <tbody>
              {upcoming.map((deadline) => {
                const days = daysBetween(now, asIsoDate(deadline.dueDate));
                return (
                  <tr key={deadline.id}>
                    <td className="num !text-left">{date(deadline.dueDate)}</td>
                    <td className="text-right">
                      <Badge tone={days <= 7 ? 'negative' : days <= 21 ? 'caution' : 'neutral'}>
                        {days === 0 ? 'Today' : `${days}d`}
                      </Badge>
                    </td>
                    <td>
                      {deadline.title}
                      {deadline.sourceNote && (
                        <div className="text-[11px] text-ink-faint mt-0.5">{deadline.sourceNote}</div>
                      )}
                    </td>
                    <td className="text-ink-muted num !text-left">
                      {deadline.periodStart
                        ? `${date(deadline.periodStart)} – ${date(deadline.periodEnd)}`
                        : '—'}
                    </td>
                    <td className="text-ink-muted">{label(deadline.kind)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>

      {past.length > 0 && (
        <Panel title={`Past and submitted (${past.length})`}>
          <table className="ledger">
            <tbody>
              {past.map((deadline) => (
                <tr key={deadline.id} className="text-ink-muted">
                  <td className="w-28 num !text-left">{date(deadline.dueDate)}</td>
                  <td>{deadline.title}</td>
                  <td className="w-28">
                    <Badge tone={deadline.status === 'submitted' ? 'positive' : 'caution'}>
                      {label(deadline.status)}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </Page>
  );
}
