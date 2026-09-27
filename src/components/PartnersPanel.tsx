import { Panel, Badge, Field, Input, Select, Disclosure, Empty } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { addPartnerAction, setPartnerShareAction, setPartnerActivityStatusAction, recordPartnerLoanAction } from '@/app/partners-actions';
import { date, money } from '@/lib/format';
import { asIsoDate } from '@/domain/dates';
import { getDb } from '@/db';
import { partners } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { partnerSharesOn, partnershipFindings } from '@/domain/config/partners';
import { partnerLoanBalance } from '@/domain/partnerships/loans';
import type { companies } from '@/db/schema';

/**
 * Who the books are for (issue #212), and for a partnership its partners and
 * profit shares. A share change is recorded from a date; the old share stays
 * on record for the periods it applied to.
 */
export function PartnersPanel({ company }: { company: typeof companies.$inferSelect }) {
  const kind = company.entityType === 'sole_trader' ? 'Sole trader' : company.entityType === 'partnership' ? 'Partnership' : 'Company';
  const today = asIsoDate(new Date().toISOString().slice(0, 10));
  const db = getDb();
  const all = company.entityType === 'partnership'
    ? db.select().from(partners).where(eq(partners.companyId, company.id)).all() : [];
  const shares = new Map(partnerSharesOn(db, company.id, today).map((s) => [s.partner.id, s.shareBasisPoints]));
  const findings = company.entityType === 'partnership' ? partnershipFindings(db, company.id, today, today) : [];
  return (
    <Panel
      title="Business type"
      description={company.entityType === 'company'
        ? 'A company: its profits are charged to corporation tax.'
        : 'Profits are charged to income tax on the owners (Form 11; a partnership also files Form 1 (Firms)).'}
    >
      <table className="ledger">
        <tbody>
          <tr><td className="w-48 text-ink-faint">Type</td><td><Badge tone="neutral">{kind}</Badge></td></tr>
          {company.entityType !== 'company' && (
            <tr><td className="text-ink-faint">Trade commenced</td>
              <td>{company.tradeCommencedOn ? date(company.tradeCommencedOn) : <Badge tone="caution">Not recorded</Badge>}</td></tr>
          )}
        </tbody>
      </table>
      {company.entityType === 'partnership' && (
        <>
          {all.length === 0 ? <Empty title="No partners recorded" /> : (
            <table className="ledger">
              <thead>
                <tr>
                  <th>Partner</th><th>Joined</th><th className="text-right">Share today</th>
                  <th className="text-right">Loan owed to them</th><th className="w-40">Status</th><th />
                </tr>
              </thead>
              <tbody>
                {all.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name} {p.isPrecedentPartner && <Badge tone="positive">Precedent partner</Badge>}</td>
                    <td>{date(p.joinedOn)}</td>
                    <td className="text-right num">{((shares.get(p.id) ?? 0) / 100).toFixed(2)}%</td>
                    <td className="text-right num">
                      {p.loanAccountId
                        ? money(partnerLoanBalance(db, company.id, p.id, today) ?? 0, company.baseCurrency)
                        : '—'}
                    </td>
                    <td>
                      {p.activityStatus === 'sleeping' ? <Badge tone="caution">Sleeping</Badge>
                        : p.activityStatus === 'active' ? <Badge tone="positive">Active</Badge>
                        : <Badge tone="caution">Not recorded</Badge>}
                      <ActionForm action={setPartnerActivityStatusAction} submit="Set" inline variant="secondary">
                        <input type="hidden" name="partnerId" value={p.id} />
                        <Select name="activityStatus" defaultValue={p.activityStatus ?? 'active'} className="!w-28">
                          <option value="active">Active</option>
                          <option value="sleeping">Sleeping</option>
                        </Select>
                      </ActionForm>
                    </td>
                    <td className="w-[26rem]">
                      <ActionForm action={setPartnerShareAction} submit="Change share" inline variant="secondary">
                        <input type="hidden" name="partnerId" value={p.id} />
                        <Input name="share" type="number" step="0.01" min="0" max="100" placeholder="%" required aria-label="New share %" />
                        <Input name="from" type="date" required aria-label="From" />
                      </ActionForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {findings.map((f, i) => <div key={i} className="px-4 py-1 text-[12px] text-caution"><Badge tone="caution">Check</Badge> {f}</div>)}
          {all.length > 0 && (
            <Disclosure summary="Record a partner loan">
              <ActionForm action={recordPartnerLoanAction} submit="Record loan">
                <div className="grid grid-cols-5 gap-3 max-w-4xl">
                  <Field label="Partner">
                    <Select name="partnerId" required defaultValue="">
                      <option value="" disabled>Choose…</option>
                      {all.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </Select>
                  </Field>
                  <Field label="Direction">
                    <Select name="direction" defaultValue="advanced">
                      <option value="advanced">Partner lends the firm</option>
                      <option value="repaid">Firm repays the partner</option>
                    </Select>
                  </Field>
                  <Field label="Amount"><Input name="amount" type="number" step="0.01" min="0.01" required /></Field>
                  <Field label="Date"><Input name="date" type="date" defaultValue={today} required /></Field>
                  <Field label="Narrative (optional)"><Input name="narrative" /></Field>
                </div>
              </ActionForm>
            </Disclosure>
          )}
          <Disclosure summary="Add a partner">
            <ActionForm action={addPartnerAction} submit="Add partner">
              <div className="grid grid-cols-6 gap-3 max-w-5xl">
                <Field label="Name"><Input name="name" required /></Field>
                <Field label="Share of profits (%)"><Input name="share" type="number" step="0.01" min="0" max="100" required /></Field>
                <Field label="Joined"><Input name="joinedOn" type="date" required /></Field>
                <Field label="PPSN (optional)"><Input name="ppsn" /></Field>
                <Field label="Precedent partner">
                  <Select name="precedent" defaultValue=""><option value="">No</option><option value="on">Yes</option></Select>
                </Field>
                <Field label="Active or sleeping"
                  help="A sleeping partner's share is not earned income (TCA s.1008(5)), so no earned income credit is given on it.">
                  <Select name="activityStatus" defaultValue="">
                    <option value="">Not recorded</option>
                    <option value="active">Active</option>
                    <option value="sleeping">Sleeping</option>
                  </Select>
                </Field>
              </div>
            </ActionForm>
          </Disclosure>
        </>
      )}
    </Panel>
  );
}
