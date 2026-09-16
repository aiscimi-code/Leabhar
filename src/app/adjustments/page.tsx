import { adjustmentList, chartOfAccounts, companyContext } from '@/lib/queries';
import {
  Page, Panel, Badge, Empty, Field, Input, Select, Textarea, Disclosure,
} from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { createAdjustmentAction, reverseAdjustmentAction } from '@/app/settings-actions';
import { money, date, dateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Manual journal adjustments (README §31).
 *
 * Every adjustment needs a stated reason, because an adjustment is the one
 * figure in the books that no document or bank line explains. Nothing is ever
 * edited or deleted — an adjustment that was wrong is reversed, and both entries
 * stay visible.
 */
export default function AdjustmentsPage() {
  const { currency } = companyContext();
  const adjustments = adjustmentList();
  const accounts = chartOfAccounts().filter((account) => account.active);
  const today = new Date().toISOString().slice(0, 10);

  const options = accounts.map((account) => (
    <option key={account.id} value={account.id}>
      {account.code} — {account.name}
    </option>
  ));

  return (
    <Page
      title="Adjustments"
      subtitle="Journal entries made by hand rather than from a bank line or a document.
        They are the first thing an accountant asks about, so each one carries a reason and
        none of them can be edited after posting."
    >
      <Panel title="Post an adjustment">
        <Disclosure summary="New adjustment" tone="accent">
          <ActionForm action={createAdjustmentAction} submit="Post adjustment" resetOnSuccess>
            <div className="grid grid-cols-2 gap-3 max-w-4xl">
              <Field label="Date">
                <Input name="date" type="date" defaultValue={today} required />
              </Field>
              <Field label="Amount" hint={`In ${currency}.`}>
                <Input name="amount" required placeholder="0.00" />
              </Field>
              <Field
                label="Debit"
                help="The account that increases. For an expense accrual this is the expense
                  account; the credit side is the liability."
              >
                <Select name="debitAccountId" required defaultValue="">
                  <option value="" disabled>Choose an account</option>
                  {options}
                </Select>
              </Field>
              <Field label="Credit">
                <Select name="creditAccountId" required defaultValue="">
                  <option value="" disabled>Choose an account</option>
                  {options}
                </Select>
              </Field>
            </div>
            <div className="max-w-4xl">
              <Field label="Description" hint="What this entry is, as it will read in the ledger.">
                <Input name="description" required placeholder="Accrue December accountancy fee" />
              </Field>
              <Field
                label="Reason"
                help="Why this figure was entered by hand rather than derived from a document.
                  This is the only explanation anyone will have later, and it is required."
              >
                <Textarea name="reason" rows={2} required
                  placeholder="Invoice not yet received; amount agreed with the firm by email on …" />
              </Field>
              <Field
                label="Override a locked period"
                hint="Leave empty unless the date falls in a locked period. A stated reason is
                  required to post into one, and it is recorded on the entry."
              >
                <Input name="overrideReason" placeholder="Optional" />
              </Field>
            </div>
          </ActionForm>
        </Disclosure>
      </Panel>

      <Panel
        title="Posted adjustments"
        description="Both sides of every entry, in full. A reversed adjustment keeps its
          original row — the reversal is a separate entry."
      >
        {adjustments.length === 0 ? (
          <Empty
            title="No adjustments"
            detail="Nothing in these books has been entered by hand. Every figure comes from a
              bank line, a document or a rule."
          />
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th className="w-16 text-right">#</th>
                <th className="w-28">Date</th>
                <th>Description and reason</th>
                <th className="w-64">Postings</th>
                <th className="w-28 text-right">Amount</th>
                <th className="w-40">Who and when</th>
                <th className="w-28">Status</th>
              </tr>
            </thead>
            <tbody>
              {adjustments.map((adjustment) => (
                <tr key={adjustment.entryId}>
                  <td className="text-right num">{adjustment.entryNumber}</td>
                  <td className="num !text-left">{date(adjustment.entryDate)}</td>
                  <td>
                    <div className="font-medium text-ink">{adjustment.description}</div>
                    {adjustment.reason ? (
                      <div className="text-ink-muted mt-0.5 leading-snug max-w-xl">
                        {adjustment.reason}
                      </div>
                    ) : (
                      <div className="text-caution mt-0.5">No reason recorded.</div>
                    )}
                  </td>
                  <td>
                    {adjustment.lines.map((line, index) => (
                      <div key={index} className="flex justify-between gap-2 text-[11.5px]">
                        <span className="text-ink-muted truncate">
                          {line.accountCode} {line.accountName}
                        </span>
                        <span className="num shrink-0">
                          {line.debitMinor !== 0
                            ? `Dr ${money(line.debitMinor, currency)}`
                            : `Cr ${money(line.creditMinor, currency)}`}
                        </span>
                      </div>
                    ))}
                  </td>
                  <td className="text-right num font-medium">
                    {money(adjustment.totalMinor, currency)}
                  </td>
                  <td className="text-ink-muted text-[11.5px] leading-snug">
                    {adjustment.createdBy}
                    <div>{dateTime(adjustment.createdAt)}</div>
                  </td>
                  <td>
                    {adjustment.reversedByEntryId ? (
                      <Badge tone="neutral" title="This entry was reversed. Both entries remain.">
                        Reversed
                      </Badge>
                    ) : adjustment.isReversal ? (
                      <Badge tone="accent">Reversal</Badge>
                    ) : (
                      <Badge tone="positive">Posted</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {adjustments
          .filter((adjustment) => !adjustment.reversedByEntryId && !adjustment.isReversal)
          .map((adjustment) => (
            <Disclosure
              key={adjustment.entryId}
              summary={`Reverse #${adjustment.entryNumber} — ${adjustment.description}`}
            >
              <div className="max-w-3xl">
                <p className="text-ink-muted mb-3 leading-snug">
                  Reversing posts an equal and opposite entry. The original stays in the
                  books and in every report that already included it; nothing is erased.
                </p>
                <ActionForm action={reverseAdjustmentAction} submit="Post reversal"
                  variant="danger" extra={{ journalEntryId: adjustment.entryId }}>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Reversal date">
                      <Input name="reversalDate" type="date" defaultValue={today} />
                    </Field>
                    <Field label="Reason" hint="Required.">
                      <Input name="reason" required placeholder="Invoice arrived at a different amount" />
                    </Field>
                  </div>
                </ActionForm>
              </div>
            </Disclosure>
          ))}
      </Panel>
    </Page>
  );
}
