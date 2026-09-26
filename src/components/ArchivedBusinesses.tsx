import { Panel, Badge } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { archivedCompanies } from '@/lib/queries';
import { unarchiveCompanyAction } from '@/app/business-profile-actions';
import { date } from '@/lib/format';

/**
 * Archived businesses (issue #297): out of the working set, kept complete,
 * able to come back. This shows on the screen that appears when no business
 * is active, which is the only place they can be reached from — an archived
 * book is not the active one.
 */
export function ArchivedBusinesses() {
  const archived = archivedCompanies();
  if (archived.length === 0) return null;

  return (
    <Panel
      title="Archived businesses"
      description="Books a person put away, complete and untouched. Bringing one back makes it
        the working set again."
    >
      <table className="ledger">
        <thead>
          <tr><th>Business</th><th className="w-32">Archived</th><th className="w-64">Why</th><th /></tr>
        </thead>
        <tbody>
          {archived.map((company) => (
            <tr key={company.id}>
              <td>
                {company.legalName}
                {company.tradeCeasedOn && <Badge tone="neutral">Trade ceased {date(company.tradeCeasedOn)}</Badge>}
              </td>
              <td className="num !text-left">{date(company.archivedAt!)}</td>
              <td className="text-ink-muted">{company.archiveBasis ?? '—'}</td>
              <td className="w-40">
                <ActionForm action={unarchiveCompanyAction} submit="Bring back" inline variant="secondary">
                  <input type="hidden" name="companyId" value={company.id} />
                </ActionForm>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
