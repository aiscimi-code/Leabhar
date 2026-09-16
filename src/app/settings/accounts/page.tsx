import Link from 'next/link';
import { chartOfAccounts } from '@/lib/queries';
import {
  Page, Panel, Badge, Field, Input, Select, Textarea, Disclosure,
} from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { createAccountAction, updateAccountAction } from '@/app/settings-actions';
import { label } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** Chart of accounts (README §10). */
export default function AccountsPage() {
  const accounts = chartOfAccounts();
  const types = ['income', 'expense', 'asset', 'liability', 'equity'] as const;
  const sections = [
    'revenue', 'cost_of_sales', 'operating_expenses', 'other_income', 'finance_costs',
    'fixed_assets', 'current_assets', 'current_liabilities', 'long_term_liabilities',
    'equity', 'tax',
  ] as const;

  return (
    <Page
      title="Chart of accounts"
      subtitle="Predefined but editable. An account referenced by a posted entry can be
        deactivated but never deleted — its history stays intact."
    >
      {types.map((type) => {
        const inType = accounts.filter((a) => a.type === type);
        if (inType.length === 0) return null;
        return (
          <Panel key={type} title={label(type)}>
            <table className="ledger">
              <thead>
                <tr>
                  <th className="w-20">Code</th>
                  <th>Name</th>
                  <th className="w-40">Report section</th>
                  <th className="w-24">VAT</th>
                  <th className="w-28">Status</th>
                </tr>
              </thead>
              <tbody>
                {inType.map((account) => (
                  <tr key={account.id}>
                    <td className="num !text-left">{account.code}</td>
                    <td>
                      <Link href={`/reports/account/${account.id}`}
                        className="text-accent hover:underline">
                        {account.name}
                      </Link>
                      {account.description && (
                        <div className="text-[11px] text-ink-faint max-w-2xl mt-0.5 leading-snug">
                          {account.description}
                        </div>
                      )}
                    </td>
                    <td className="text-ink-muted">{label(account.reportSection)}</td>
                    <td>
                      {account.vatApplicable
                        ? <span className="text-ink-muted">Applicable</span>
                        : <span className="text-ink-faint">Not applicable</span>}
                    </td>
                    <td>
                      <div className="flex gap-1 flex-wrap">
                        {account.isSystem && (
                          <Badge tone="accent" title="The posting engine addresses this account by name. It cannot be deleted.">
                            System
                          </Badge>
                        )}
                        {!account.active && <Badge tone="neutral">Inactive</Badge>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {inType.map((account) => (
              <Disclosure key={account.id} summary={`Edit ${account.code} ${account.name}`}>
                <ActionForm action={updateAccountAction} submit="Save account"
                  extra={{ accountId: account.id }}>
                  <div className="max-w-3xl">
                    <Field
                      label="Name"
                      help="Renaming an account renames it everywhere, including on entries
                        already posted to it. The code and type cannot change — reports and
                        the posting engine address accounts by them."
                    >
                      <Input name="name" defaultValue={account.name} />
                    </Field>
                    <Field label="Description">
                      <Textarea name="description" rows={2}
                        defaultValue={account.description ?? ''} />
                    </Field>
                    <label className="flex items-center gap-2 text-[12px] text-ink mb-3">
                      <input type="checkbox" name="active" defaultChecked={account.active} />
                      Offered when classifying
                    </label>
                    <p className="text-[11.5px] text-ink-muted leading-snug border-t border-line pt-2">
                      There is no delete. An account referenced by a posted entry cannot be
                      removed without destroying that entry&rsquo;s meaning, so deactivating
                      it is the only way to retire one.
                    </p>
                  </div>
                </ActionForm>
              </Disclosure>
            ))}
          </Panel>
        );
      })}

      <Panel title="Add an account">
        <Disclosure summary="New account" tone="accent">
          <ActionForm action={createAccountAction} submit="Add account" resetOnSuccess>
            <div className="grid grid-cols-3 gap-3 max-w-4xl">
              <Field
                label="Code"
                help="Numeric codes group accounts in reports. Follow the ranges already in
                  use so the new account sorts where you expect it."
              >
                <Input name="code" required placeholder="6100" />
              </Field>
              <Field label="Name"><Input name="name" required placeholder="Training" /></Field>
              <Field label="Type">
                <Select name="type" defaultValue="expense">
                  {types.map((type) => (
                    <option key={type} value={type}>{label(type)}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Report section">
                <Select name="reportSection" defaultValue="operating_expenses">
                  {sections.map((section) => (
                    <option key={section} value={section}>{label(section)}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Subtype"><Input name="subtype" placeholder="Optional" /></Field>
            </div>
            <div className="max-w-3xl">
              <Field label="Description" hint="Shown when choosing this account while classifying.">
                <Input name="description" />
              </Field>
              <label className="flex items-center gap-2 text-[12px] text-ink mb-3">
                <input type="checkbox" name="vatApplicable" defaultChecked />
                VAT can arise on this account
              </label>
            </div>
          </ActionForm>
        </Disclosure>
      </Panel>
    </Page>
  );
}
