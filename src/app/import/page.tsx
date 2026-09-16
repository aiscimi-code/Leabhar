import { bankAccountList } from '@/lib/queries';
import { Page, Panel, Help, Empty, LinkButton } from '@/components/primitives';
import { ImportForm } from '@/components/ImportForm';
import { date } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Manual refresh / import (README §13, §14).
 *
 * No live banking API, deliberately. §13 says bank integration in Ireland is
 * fragmented and is not required for the MVP, and §47 says a feed connector is
 * a later addition — the import goes through an interface that a connector
 * could implement without changing anything downstream.
 */
export default function ImportPage() {
  const accounts = bankAccountList();

  return (
    <Page
      title="Import bank data"
      subtitle="Upload a statement export. Importing the same file twice adds nothing, and
        overlapping statements import only the rows you do not already have."
    >
      <Panel title="Import a statement">
        {accounts.length === 0 ? (
          <Empty
            title="No bank accounts yet"
            detail="Add a bank account before importing a statement."
            action={<LinkButton href="/settings/company" variant="primary">Add a bank account</LinkButton>}
          />
        ) : (
          <div className="px-4 py-3">
            <ImportForm
              accounts={accounts.map((a) => ({
                id: a.id,
                name: `${a.bankName} — ${a.accountName}`,
                currency: a.currency,
              }))}
            />
          </div>
        )}
      </Panel>

      <Panel title="How duplicate detection works">
        <div className="px-4 py-3 text-ink-muted max-w-3xl space-y-2.5 leading-relaxed">
          <p>
            There are two independent checks, because they catch different mistakes.
          </p>
          <p>
            <strong className="text-ink">The file itself.</strong> If you import the same
            download twice, the file&rsquo;s hash is recognised and nothing is read at all.
          </p>
          <p>
            <strong className="text-ink">Each transaction.</strong> Every row gets a
            fingerprint built from the account, date, amount, currency, reference and a
            normalised form of the description. Re-importing an overlapping period — January
            to March, then February to April — imports only the rows you do not already have.
          </p>
          <p>
            The awkward case is a supplier billing the same amount twice on the same day with
            the same description. Two identical app-store charges are real, and discarding the
            second would silently lose money from your books. Fingerprints therefore carry an
            occurrence number, so a re-import collides while a genuinely new third identical
            charge is imported. Where your bank supplies its own transaction ID, that is used
            instead and the ambiguity disappears.
          </p>
        </div>
      </Panel>

      <Panel title="Supported formats">
        <table className="ledger">
          <tbody>
            <tr>
              <td className="w-24">CSV</td>
              <td>
                Any column layout. Columns are matched automatically where the names are
                recognisable, and the guess is shown for you to confirm rather than applied
                silently. Both <code>1,234.56</code> and <code>1.234,56</code> conventions are
                handled, and genuinely ambiguous amounts are flagged rather than guessed at.
              </td>
            </tr>
            <tr>
              <td>XLSX</td>
              <td>Read into the same pipeline as CSV. The first worksheet is used.</td>
            </tr>
            <tr>
              <td>PDF</td>
              <td className="text-ink-muted">
                Not yet supported for statements. Export CSV from your bank instead — it is
                more reliable than reading a PDF table, and a misread statement is worse than
                no statement.
              </td>
            </tr>
          </tbody>
        </table>
      </Panel>

      <Panel title="Bank accounts">
        <table className="ledger">
          <thead>
            <tr>
              <th>Bank</th><th>Account</th><th>IBAN</th><th>Currency</th>
              <th className="w-28">Opened</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.id}>
                <td>{account.bankName}</td>
                <td>{account.accountName}</td>
                <td className="num !text-left text-ink-muted">{account.iban ?? '—'}</td>
                <td>{account.currency}</td>
                <td className="num !text-left">{date(account.openingDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </Page>
  );
}
