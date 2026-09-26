import { Panel, Badge, Field, Input, Select, Textarea, Disclosure } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { confirmRctPrincipalAction, recordCashBasisAuthorisationAction } from '@/app/company-status-actions';
import { date } from '@/lib/format';
import type { companies } from '@/db/schema';

type Company = typeof companies.$inferSelect;

/**
 * Facts about the company that VAT turns on and no transaction shows (issue
 * #208). Until each is recorded the rules that need it flag the lines instead
 * of deciding.
 */
export function CompanyVatStatus({ company }: { company: Company }) {
  return (
    <Panel
      title="VAT status"
      description="Two facts only you can record: whether the company is a principal for RCT, and Revenue's
        authorisation for the cash receipts basis."
    >
      <table className="ledger">
        <tbody>
          <tr>
            <td className="w-48 text-ink-faint">RCT principal</td>
            <td>
              {company.rctPrincipal === 'principal'
                ? <Badge tone="positive">Principal{company.rctPrincipalFrom ? ` from ${date(company.rctPrincipalFrom)}` : ''}</Badge>
                : company.rctPrincipal === 'not_principal'
                  ? <Badge tone="neutral">Not a principal</Badge>
                  : <Badge tone="caution">Not recorded</Badge>}
              {company.rctPrincipalConfirmedBy && (
                <div className="text-[11px] text-ink-faint">
                  {company.rctPrincipalBasis} — confirmed by {company.rctPrincipalConfirmedBy}
                </div>
              )}
            </td>
          </tr>
          <tr>
            <td className="text-ink-faint">Cash basis authorisation</td>
            <td>
              {company.cashBasisAuthorisedFrom
                ? <>
                    <Badge tone="positive">From {date(company.cashBasisAuthorisedFrom)}</Badge>
                    <div className="text-[11px] text-ink-faint">
                      {company.cashBasisEligibility === 'supplies_to_unregistered'
                        ? '90% of turnover to unregistered customers (s.80(1)(a))'
                        : 'Turnover within the threshold (s.80(1)(b))'}
                      {' '}· {company.cashBasisAuthorisationReference} — recorded by {company.cashBasisConfirmedBy}
                    </div>
                  </>
                : company.vatAccountingBasis === 'cash_receipts'
                  ? <Badge tone="caution">Not recorded</Badge>
                  : <span className="text-ink-faint">Not used (invoice basis)</span>}
            </td>
          </tr>
        </tbody>
      </table>

      <Disclosure summary="Record RCT principal status">
        <p className="text-[12px] text-ink-muted mb-2 max-w-3xl">
          A principal under TCA 1997 s.530A (for example a main contractor or a developer) accounts for the VAT on
          construction services it receives (VATCA s.16(3)).
        </p>
        <ActionForm action={confirmRctPrincipalAction} submit="Record status">
          <div className="grid grid-cols-3 gap-3 max-w-3xl">
            <Field label="Status">
              <Select name="status" defaultValue={company.rctPrincipal ?? ''} required>
                <option value="" disabled>Choose</option>
                <option value="principal">A principal</option>
                <option value="not_principal">Not a principal</option>
              </Select>
            </Field>
            <Field label="From (required for a principal)">
              <Input name="from" type="date" defaultValue={company.rctPrincipalFrom ?? ''} />
            </Field>
            <Field label="What this rests on">
              <Textarea name="basis" rows={2} defaultValue={company.rctPrincipalBasis ?? ''} required />
            </Field>
          </div>
        </ActionForm>
      </Disclosure>

      <Disclosure summary="Record the cash basis authorisation">
        <p className="text-[12px] text-ink-muted mb-2 max-w-3xl">
          VATCA s.80(1): the cash receipts basis needs Revenue&apos;s authorisation, on turnover within €2,000,000 or
          with at least 90% of turnover to customers who are not VAT-registered.
        </p>
        <ActionForm action={recordCashBasisAuthorisationAction} submit="Record authorisation">
          <div className="grid grid-cols-3 gap-3 max-w-3xl">
            <Field label="Test met">
              <Select name="eligibility" defaultValue={company.cashBasisEligibility ?? ''} required>
                <option value="" disabled>Choose</option>
                <option value="turnover_threshold">Turnover within the threshold</option>
                <option value="supplies_to_unregistered">90% to unregistered customers</option>
              </Select>
            </Field>
            <Field label="Authorised from">
              <Input name="authorisedFrom" type="date" defaultValue={company.cashBasisAuthorisedFrom ?? ''} required />
            </Field>
            <Field label="Revenue reference">
              <Input name="reference" defaultValue={company.cashBasisAuthorisationReference ?? ''} required />
            </Field>
          </div>
        </ActionForm>
      </Disclosure>
    </Panel>
  );
}
