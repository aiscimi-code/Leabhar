import Link from 'next/link';
import { chartOfAccounts, externalAccountMappings } from '@/lib/queries';
import {
  Page, Panel, Badge, Field, Input, Select, Textarea, Disclosure,
} from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import {
  createAccountAction, updateAccountAction, archiveAccountAction, restoreAccountAction,
  setAccountMappingAction, clearAccountMappingAction,
} from '@/app/settings-actions';
import { label } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** Chart of accounts (README §10). */
export default function AccountsPage() {
  const all = chartOfAccounts();
  const accounts = all.filter((a) => a.active);
  const archived = all.filter((a) => !a.active);
  const mappings = externalAccountMappings();
  const chartNames = [...new Set(mappings.map((m) => m.chartName))];
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
        archived but never deleted — its history stays intact."
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
                      {account.isSystem && (
                        <Badge tone="accent" title="The posting engine addresses this account by name. It cannot be deleted or archived.">
                          System
                        </Badge>
                      )}
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
                    <p className="text-[11.5px] text-ink-muted leading-snug border-t border-line pt-2">
                      There is no delete. An account referenced by a posted entry cannot be
                      removed without destroying that entry&rsquo;s meaning, so archiving it
                      is the only way to retire one — with a reason, recorded.
                    </p>
                  </div>
                </ActionForm>
                {!account.isSystem && (
                  <ActionForm action={archiveAccountAction} submit="Archive this account"
                    extra={{ accountId: account.id }}>
                    <div className="max-w-3xl">
                      <Field
                        label="Why is it being retired?"
                        help="Archiving stops new postings and hides the account from
                          classification, but its history and balance stay exactly as they
                          are. The reason is recorded in the audit trail; an account that
                          still carries a balance is put on the review queue."
                      >
                        <Input name="reason" required />
                      </Field>
                    </div>
                  </ActionForm>
                )}
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

      <Panel
        title="External chart mappings"
        description="How each account is coded in an external chart — the accountant's
          chart, or another package's — so an exported trial balance can be
          restated in those codes. The books themselves never change."
      >
        <Disclosure summary="Map an account" tone="accent">
          <ActionForm action={setAccountMappingAction} submit="Save mapping" resetOnSuccess>
            <div className="grid grid-cols-3 gap-3 max-w-4xl">
              <Field
                label="Chart"
                help="One mapping per account per chart. Name the chart so two
                  correspondences can never be confused with each other."
              >
                <Input name="chartName" required placeholder="Accountant 2025" />
              </Field>
              <Field label="This account">
                <Select name="accountId" defaultValue={accounts[0]?.id}>
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.code} {account.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="External code">
                <Input name="externalCode" required placeholder="400" />
              </Field>
              <Field label="External name (optional)">
                <Input name="externalName" />
              </Field>
            </div>
          </ActionForm>
        </Disclosure>

        {mappings.length === 0 && (
          <p className="px-4 py-2.5 text-[12px] text-ink-muted border-t border-line">
            No mappings yet. An account deliberately left unmapped is simply not mapped —
            that is the correct state: in the mapped trial balance it appears with a blank
            external code rather than disappearing.
          </p>
        )}

        {chartNames.map((chartName) => {
            const forChart = mappings.filter((m) => m.chartName === chartName);
            return (
              <div key={chartName} className="mb-4">
                <div className="flex items-baseline justify-between gap-3 mb-1.5">
                  <h3 className="text-[13px] font-semibold text-ink">{chartName}</h3>
                  <a
                    href={`/api/export/report?which=mapped-trial-balance&chart=${encodeURIComponent(chartName)}&to=${new Date().toISOString().slice(0, 10)}`}
                    className="text-[12px] text-accent hover:underline"
                  >
                    Download mapped trial balance
                  </a>
                </div>
                <table className="ledger">
                  <thead>
                    <tr>
                      <th className="w-24">This chart</th>
                      <th>External code</th>
                      <th>External name</th>
                      <th className="w-24"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {forChart.map((m) => (
                      <tr key={m.id}>
                        <td className="num !text-left">{m.code}</td>
                        <td className="num !text-left">{m.externalCode}</td>
                        <td className="text-ink-muted">{m.externalName ?? m.name}</td>
                        <td>
                          <ActionForm action={clearAccountMappingAction} submit="Remove"
                            extra={{ accountId: m.accountId, chartName }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
      </Panel>

      {archived.length > 0 && (
        <Panel
          title="Archived accounts"
          description="Retired from the chart: no new postings, not offered when
            classifying, history and balance exactly as they were."
        >
          <table className="ledger">
            <thead>
              <tr>
                <th className="w-20">Code</th>
                <th>Name</th>
                <th className="w-36">Archived from</th>
              </tr>
            </thead>
            <tbody>
              {archived.map((account) => (
                <tr key={account.id}>
                  <td className="num !text-left">{account.code}</td>
                  <td className="text-ink-muted">{account.name}</td>
                  <td className="text-ink-muted">{account.effectiveTo ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {archived.map((account) => (
            <Disclosure key={account.id} summary={`Restore ${account.code} ${account.name}`}>
              <ActionForm action={restoreAccountAction} submit="Restore this account"
                extra={{ accountId: account.id }}>
                <div className="max-w-3xl">
                  <Field
                    label="Why is it coming back?"
                    help="Restoring reopens the account: it can take new postings and is
                      offered when classifying again. The reason is recorded in the audit
                      trail."
                  >
                    <Input name="reason" required />
                  </Field>
                </div>
              </ActionForm>
            </Disclosure>
          ))}
        </Panel>
      )}
    </Page>
  );
}
