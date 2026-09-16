import { listBackups, backupRoot } from '@/domain/backup/backup';
import { Page, Panel, Badge, Empty, Help } from '@/components/primitives';
import { BackupButton } from '@/components/BackupButton';
import { RestoreButton } from '@/components/RestoreButton';
import { dateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** Backup and restore (README §45). */
export default function BackupPage() {
  const backups = listBackups();

  return (
    <Page
      title="Backup"
      subtitle="Versioned backups of the database, your documents and your configuration.
        Each one is a new version — never an overwrite."
      actions={<BackupButton />}
    >
      <Panel title="How backups work here">
        <div className="px-4 py-3 text-ink-muted max-w-3xl space-y-2.5 leading-relaxed">
          <p>
            A backup contains the accounting database, every stored document, and a manifest
            recording the SHA-256 of each file. Restoring checks every hash against that
            manifest first, so you can tell a complete backup from a hopeful one
            <em> before</em> you need it.
          </p>
          <p>
            Backups are numbered, never overwritten. A backup that replaces the previous one
            is a single point of failure: a corrupted database backed up once destroys the
            only good copy.
          </p>
          <p>
            Restoring moves your current database and documents aside into a pre-restore copy
            rather than deleting them. Restoring over live data is exactly when people
            discover a backup was incomplete, and at that moment what you most need is the
            state you just replaced.
          </p>
          <p className="text-[11.5px] text-ink-faint">
            Backups are written to <code>{backupRoot()}</code>. They stay on this machine —
            copy them somewhere else as well, because a backup on the same disk as the
            original protects you from mistakes but not from losing the disk.
          </p>
        </div>
      </Panel>

      <Panel title={`Existing backups (${backups.length})`}>
        {backups.length === 0 ? (
          <Empty
            title="No backups yet"
            detail="Create one before you do anything you might want to undo."
          />
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th className="w-20">Version</th>
                <th className="w-32">Database</th>
                <th className="w-40">Documents</th>
                <th>Verification</th>
                <th className="w-28">Status</th>
                <th className="w-24">Action</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((backup) => (
                <tr key={backup.path}>
                  <td className="num !text-left">v{backup.version}</td>
                  <td>
                    <Badge tone={backup.databaseIntact ? 'positive' : 'negative'}>
                      {backup.databasePresent
                        ? backup.databaseIntact ? 'Intact' : 'Altered'
                        : 'Missing'}
                    </Badge>
                  </td>
                  <td className="num !text-left">
                    {backup.documentsIntact} of {backup.documentsChecked} intact
                  </td>
                  <td className="text-ink-muted">{backup.summary}</td>
                  <td>
                    <Badge tone={backup.usable ? 'positive' : 'negative'}>
                      {backup.usable ? 'Verified' : 'Do not restore'}
                    </Badge>
                  </td>
                  <td>
                    <RestoreButton
                      path={backup.path}
                      version={backup.version}
                      usable={backup.usable}
                    />
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
