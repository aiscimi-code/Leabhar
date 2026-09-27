import { activeCompany, companyContext, chartOfAccounts, expensesPage } from '@/lib/queries';
import {
  Page, Panel, Badge, Empty, Field, Input, Select, Textarea, Disclosure,
} from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import {
  createExpenseClaimAction, approveExpenseClaimAction, rejectExpenseClaimAction,
  reimburseExpenseClaimAction, reverseExpenseClaimAction,
} from '@/app/expenses-actions';
import { money, date } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Expense claims (issue #306): the money a director or a member of staff spent
 * personally on the business's behalf. A claim claims no input VAT — a purchase
 * with an invoice is confirmed, posted and settled instead — and the approval is
 * the accounting event: the journal is posted there, and the company owes the
 * claimant until the reimbursement leaves the bank.
 */
export default async function ExpensesPage() {
  const company = activeCompany();
  if (!company) {
    return <Page title="Expenses"><Panel><Empty title="No company yet" /></Panel></Page>;
  }
  const { currency } = companyContext();
  const { claims, officers, staff, rates, bankLines } = expensesPage();
  const accounts = chartOfAccounts().filter((a) => a.active && a.type === 'expense');
  const today = new Date().toISOString().slice(0, 10);

  const claimantOptions = [
    ...officers.map((o) => (
      <option key={o.id} value={o.id}>{o.name} — {o.role}</option>
    )),
    ...staff.map((u) => (
      <option key={u.id} value={u.id}>{u.displayName}</option>
    )),
  ];

  const rateOptions = rates.map((rate) => (
    <option key={rate.id} value={rate.id}>
      {rate.name} — {(rate.amountMinor / rate.perUnits / 100).toFixed(2)} {currency}/{rate.unit}
    </option>
  ));

  return (
    <Page
      title="Expenses"
      subtitle="Mileage, travel, subsistence and receipted costs a director or a member of staff paid personally.
        A claim claims no input VAT — a purchase with an invoice goes through the document
        review and is posted as an invoice. Approving a claim posts it; reimbursing pays it."
    >
      <Panel title="Submit a claim">
        <Disclosure summary="New claim" tone="accent">
          <ActionForm action={createExpenseClaimAction} submit="Submit for approval" resetOnSuccess>
            <div className="grid grid-cols-2 gap-3 max-w-3xl">
              <Field label="Claimant"
                help="Officers are owed on their own current account; everyone else on
                  Staff expenses payable.">
                <Select name="claimantType" defaultValue="officer" required>
                  <option value="officer">Officer (director, secretary, shareholder)</option>
                  <option value="user">Member of staff</option>
                </Select>
              </Field>
              <Field label="Who">
                <Select name="claimantId" required defaultValue="">
                  <option value="" disabled>Choose who this claim is for</option>
                  {claimantOptions}
                </Select>
              </Field>
            </div>
            <div className="max-w-3xl mt-3">
              <Field label="Title" hint="As it will read on the claim list and the journal narrative.">
                <Input name="title" required placeholder="Site visits, May" />
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3 max-w-3xl mt-3">
              <Field label="Line type"
                help="Mileage and subsistence are priced from the rate in force on the
                  line's date. Travel and receipt lines take the amount spent.">
                <Select name="lineType" defaultValue="mileage">
                  <option value="mileage">Mileage</option>
                  <option value="subsistence">Subsistence</option>
                  <option value="travel">Travel</option>
                  <option value="receipt">Receipt</option>
                </Select>
              </Field>
              <Field label="Date">
                <Input name="date" type="date" defaultValue={today} required />
              </Field>
              <Field label="Expense account">
                <Select name="accountId" required defaultValue={accounts.find((a) => a.code === '6110')?.id ?? ''}>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.code} — {a.name}</option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3 max-w-3xl mt-3">
              <Field label="Rate (mileage and subsistence)">
                <Select name="rateId" defaultValue="">
                  <option value="">Not needed for a travel or receipt line</option>
                  {rateOptions}
                </Select>
              </Field>
              <Field label="Kilometres / absences / nights"
                hint="For a rate-calculated line.">
                <Input name="units" type="number" min="1" step="1" placeholder="e.g. 150" />
              </Field>
              <Field label={`Amount (${currency})`}
                hint="Only for a travel or receipt line.">
                <Input name="amount" placeholder="0.00" />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3 max-w-3xl mt-3">
              <Field label="Description">
                <Input name="description" required placeholder="Cork site visit" />
              </Field>
              <Field label="Business use (percent)"
                help="100 means wholly business. Anything less charges the private
                  share back to the claimant, because a private cost is theirs, not the
                  business's.">
                <Input name="businessUsePct" type="number" min="0" max="100" step="1" defaultValue="100" />
              </Field>
            </div>
          </ActionForm>
        </Disclosure>
      </Panel>

      <Panel
        title="Claims"
        description="Submitted claims await approval; an approved claim is posted and owed; a
          reimbursed claim has been paid. Nothing is edited after submission — a claim is
          rejected with a reason or reversed."
      >
        {claims.length === 0 ? (
          <Empty
            title="No expense claims"
            detail="Mileage, travel, subsistence and personally-paid receipts will appear here
              as claims awaiting approval."
          />
        ) : (
          <div className="space-y-4">
            {claims.map((claim) => (
              <div key={claim.id} className="border border-line-strong rounded p-3">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <div className="font-medium">{claim.title}</div>
                    <div className="text-[11.5px] text-ink-muted">
                      {claim.claimantName} · submitted {date(claim.createdAt.slice(0, 10))}
                      {claim.status === 'rejected' && claim.rejectionReason
                        ? ` · rejected: ${claim.rejectionReason}` : ''}
                      {claim.status === 'reversed' && claim.reversalReason
                        ? ` · reversed: ${claim.reversalReason}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="num">{money(claim.totalMinor, claim.currency)}</div>
                    <Badge tone={
                      claim.status === 'reimbursed' ? 'positive'
                        : claim.status === 'approved' ? 'caution'
                          : claim.status === 'rejected' || claim.status === 'reversed' ? 'negative'
                            : 'neutral'
                    }>
                      {claim.status}
                    </Badge>
                  </div>
                </div>

                <table className="ledger mt-2">
                  <thead>
                    <tr>
                      <th className="w-24">Date</th><th>Type</th><th>Description</th>
                      <th className="w-28 text-right">Amount</th>
                      <th className="w-20 text-right">Business</th><th className="w-64">Rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {claim.lines.map((line) => (
                      <tr key={line.id}>
                        <td>{date(line.date)}</td>
                        <td>{line.lineType}</td>
                        <td>{line.description}</td>
                        <td className="num">{money(line.amountMinor, claim.currency)}</td>
                        <td className="num">{line.businessUseBasisPoints / 100}%</td>
                        <td className="text-[11.5px] text-ink-muted">
                          {line.rateName
                            ? `${line.units} × ${(line.rateAmountMinor! / line.ratePerUnits! / 100).toFixed(2)} ${claim.currency}/${line.lineType === 'mileage' ? 'km' : 'occasion'} (${line.rateName})`
                            : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {claim.status === 'submitted' && (
                  <div className="flex gap-4 mt-3 flex-wrap">
                    <ActionForm action={approveExpenseClaimAction} submit="Approve and post" inline
                      extra={{ claimId: claim.id }} confirm="Approving posts the claim to the ledger." />
                    <ActionForm action={rejectExpenseClaimAction} submit="Reject" variant="danger" inline
                      extra={{ claimId: claim.id }}>
                      <Input name="reason" placeholder="Reason the claimant will see" required
                        className="border border-line-strong rounded px-2 py-1 text-[12px]" />
                    </ActionForm>
                  </div>
                )}

                {claim.status === 'approved' && (
                  <div className="flex gap-4 mt-3 flex-wrap items-end">
                    <ActionForm action={reimburseExpenseClaimAction} submit="Record reimbursement" inline
                      extra={{ claimId: claim.id }}>
                      <div className="flex gap-2 flex-wrap">
                        <div>
                          <div className="text-[10px] uppercase tracking-wide font-semibold text-ink-faint mb-1">Bank line</div>
                          <select name="bankTransactionId" defaultValue=""
                            className="border border-line-strong rounded px-2 py-1 text-[12px]">
                            <option value="">Reimburse from a bank line…</option>
                            {bankLines.map((line) => (
                              <option key={line.id} value={line.id}>
                                {date(line.transactionDate)} {line.description} {money(line.amountMinor, line.currency)}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <div className="text-[10px] uppercase tracking-wide font-semibold text-ink-faint mb-1">or date paid</div>
                          <Input name="date" type="date" className="border border-line-strong rounded px-2 py-1 text-[12px]" />
                        </div>
                      </div>
                    </ActionForm>
                    <ActionForm action={reverseExpenseClaimAction} submit="Reverse" variant="danger" inline
                      extra={{ claimId: claim.id }}>
                      <Input name="reason" placeholder="What was wrong" required
                        className="border border-line-strong rounded px-2 py-1 text-[12px]" />
                    </ActionForm>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </Page>
  );
}
