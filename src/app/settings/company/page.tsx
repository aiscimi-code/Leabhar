import { activeCompany, companyContext, bankAccountList, officerList } from '@/lib/queries';
import {
  Page, Panel, Badge, Help, Empty, Field, Input, Select, Textarea, Disclosure,
} from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { DemoLoader } from '@/components/DemoLoader';
import {
  updateCompanyAction, createCompanyAction,
  addBankAccountAction, updateBankAccountAction,
} from '@/app/settings-actions';
import { money, date, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

const FREQUENCIES = ['monthly', 'bi_monthly', 'four_monthly', 'half_yearly', 'annual'] as const;
const STATUSES = ['not_registered', 'registered', 'deregistered', 'pending'] as const;

/** Company setup (README §5), editable in place (README §46). */
export default function CompanySettingsPage() {
  const company = activeCompany();

  if (!company) {
    return (
      <Page title="Company" subtitle="No company has been created yet.">
        <div className="grid grid-cols-2 gap-4 items-start">
          <Panel title="Create your company" id="create">
            <div className="px-4 py-3">
              <p className="text-ink-muted mb-3 leading-relaxed">
                Only the legal name is required. Everything else can be filled in later,
                and nothing here is sent anywhere — it stays in the local database file.
              </p>
              <ActionForm action={createCompanyAction} submit="Create company">
                <Field label="Legal name">
                  <Input name="legalName" required placeholder="Example Trading Limited" />
                </Field>
                <Field label="Trading name">
                  <Input name="tradingName" />
                </Field>
                <Field label="CRO number">
                  <Input name="croNumber" />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field
                    label="VAT basis"
                    help="On the cash receipts basis, VAT on your sales arises when you are
                      paid rather than when you invoice. Choose the basis Revenue registered
                      you on — changing it later does not restate anything already posted."
                  >
                    <Select name="vatAccountingBasis" defaultValue="cash_receipts">
                      <option value="cash_receipts">Cash receipts</option>
                      <option value="invoice">Invoice (sales)</option>
                    </Select>
                  </Field>
                  <Field label="VAT registered">
                    <Select name="vatRegistrationStatus" defaultValue="registered">
                      {STATUSES.map((status) => (
                        <option key={status} value={status}>{label(status)}</option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Field
                  label="First year to set up"
                  hint="Creates the accounting period and VAT periods for that year. More
                    years can be generated at any time."
                >
                  <Input name="seedYear" type="number" defaultValue={new Date().getFullYear()} />
                </Field>
              </ActionForm>
            </div>
          </Panel>

          <Panel title="Or load demo data" id="demo">
            <div className="px-4 py-3">
              <p className="text-ink-muted mb-3 leading-relaxed">
                The demo company is a fictional Irish LTD with a quarter of real-looking
                transactions: reverse-charge purchases from EU and US suppliers, an exempt
                insurance renewal, a capital purchase, a director-paid expense, an unmatched
                transaction and a duplicate. It is labelled as demo data on every screen.
              </p>
              <DemoLoader />
            </div>
          </Panel>
        </div>
      </Page>
    );
  }

  const { financialYears } = companyContext();
  const banks = bankAccountList();
  const officers = officerList();
  const hasPostings = financialYears.some((year) => year.status === 'locked');

  return (
    <Page
      title="Company"
      subtitle={company.legalName}
      actions={company.isDemo ? <Badge tone="caution">Demo company</Badge> : undefined}
    >
      <div className="grid grid-cols-2 gap-4 items-start">
        <Panel title="Identity">
          <table className="ledger">
            <tbody>
              <Row label="Legal name">{company.legalName}</Row>
              <Row label="Trading name">{company.tradingName ?? '—'}</Row>
              <Row label="CRO number">{company.croNumber ?? '—'}</Row>
              <Row label="Company type">{company.companyType ?? '—'}</Row>
              <Row label="Incorporated">{date(company.dateIncorporated)}</Row>
              <Row label="Registered office">{company.registeredOffice ?? '—'}</Row>
              <Row label="Business address">{company.principalBusinessAddress ?? '—'}</Row>
              <Row label="Records address">{company.recordsAddress ?? '—'}</Row>
            </tbody>
          </table>

          <Disclosure summary="Edit identity">
            <ActionForm action={updateCompanyAction} submit="Save identity">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Legal name">
                  <Input name="legalName" defaultValue={company.legalName} required />
                </Field>
                <Field label="Trading name">
                  <Input name="tradingName" defaultValue={company.tradingName ?? ''} />
                </Field>
                <Field label="CRO number">
                  <Input name="croNumber" defaultValue={company.croNumber ?? ''} />
                </Field>
                <Field label="Company type">
                  <Input name="companyType" defaultValue={company.companyType ?? ''}
                    placeholder="LTD, DAC, CLG…" />
                </Field>
                <Field label="Incorporated">
                  <Input name="dateIncorporated" type="date"
                    defaultValue={company.dateIncorporated ?? ''} />
                </Field>
              </div>
              <Field label="Registered office">
                <Textarea name="registeredOffice" rows={2}
                  defaultValue={company.registeredOffice ?? ''} />
              </Field>
              <Field label="Principal business address">
                <Textarea name="principalBusinessAddress" rows={2}
                  defaultValue={company.principalBusinessAddress ?? ''} />
              </Field>
              <Field
                label="Records address"
                help="Where the company's books are kept. Companies Act 2014 requires this to
                  be recorded, and it is not always the registered office."
              >
                <Textarea name="recordsAddress" rows={2}
                  defaultValue={company.recordsAddress ?? ''} />
              </Field>
              <Field label="Reason for this change" hint="Recorded in the audit trail.">
                <Input name="reason" placeholder="Optional" />
              </Field>
            </ActionForm>
          </Disclosure>
        </Panel>

        <Panel title="Tax registration">
          <table className="ledger">
            <tbody>
              <Row label="Tax reference">{company.taxReferenceNumber ?? '—'}</Row>
              <Row label="VAT number">{company.vatNumber ?? '—'}</Row>
              <Row label="VAT registered">
                <Badge tone={company.vatRegistrationStatus === 'registered' ? 'positive' : 'neutral'}>
                  {label(company.vatRegistrationStatus)}
                </Badge>
                {company.vatRegistrationDate && (
                  <span className="text-ink-muted ml-2">since {date(company.vatRegistrationDate)}</span>
                )}
              </Row>
              <Row
                label="VAT basis"
                help="On the cash receipts basis, VAT on your sales arises when you are paid rather
                  than when you invoice. This changes which period a sale falls into, so it is not
                  a cosmetic setting. It applies to sales only — VAT on purchases is reclaimed by
                  reference to the supplier's invoice date under either basis."
              >
                <strong>{label(company.vatAccountingBasis)}</strong>
              </Row>
              <Row label="VAT period frequency">{label(company.vatPeriodFrequency)}</Row>
              <Row label="EORI number">{company.eoriNumber ?? '—'}</Row>
              <Row label="Corporation tax registered">
                {company.corporationTaxRegistered ? 'Yes' : 'No'}
              </Row>
              <Row label="Financial year end">
                {String(company.financialYearEndDay).padStart(2, '0')}/
                {String(company.financialYearEndMonth).padStart(2, '0')}
              </Row>
              <Row label="Base currency">{company.baseCurrency}</Row>
            </tbody>
          </table>

          <Disclosure summary="Edit tax registration">
            <ActionForm action={updateCompanyAction} submit="Save tax settings"
              extra={{ taxSection: '1' }}>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Tax reference number">
                  <Input name="taxReferenceNumber"
                    defaultValue={company.taxReferenceNumber ?? ''} />
                </Field>
                <Field label="VAT number">
                  <Input name="vatNumber" defaultValue={company.vatNumber ?? ''} />
                </Field>
                <Field label="VAT registration status">
                  <Select name="vatRegistrationStatus"
                    defaultValue={company.vatRegistrationStatus}>
                    {STATUSES.map((status) => (
                      <option key={status} value={status}>{label(status)}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="VAT registered from">
                  <Input name="vatRegistrationDate" type="date"
                    defaultValue={company.vatRegistrationDate ?? ''} />
                </Field>
                <Field
                  label="VAT basis"
                  help="Changing this changes the tax point of future sales only. Nothing
                    already posted is restated, and this application will say so when you save."
                >
                  <Select name="vatAccountingBasis" defaultValue={company.vatAccountingBasis}>
                    <option value="cash_receipts">Cash receipts</option>
                    <option value="invoice">Invoice (sales)</option>
                  </Select>
                </Field>
                <Field label="VAT period frequency">
                  <Select name="vatPeriodFrequency" defaultValue={company.vatPeriodFrequency}>
                    {FREQUENCIES.map((frequency) => (
                      <option key={frequency} value={frequency}>{label(frequency)}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="EORI number">
                  <Input name="eoriNumber" defaultValue={company.eoriNumber ?? ''} />
                </Field>
                <Field
                  label="Base currency"
                  help="The currency the books are kept in. It cannot be changed once entries
                    have been posted, because every posted figure is already stated in it."
                >
                  <Input name="baseCurrency" defaultValue={company.baseCurrency}
                    maxLength={3} disabled={hasPostings} />
                </Field>
                <Field label="Financial year end day">
                  <Input name="financialYearEndDay" type="number" min={1} max={31}
                    defaultValue={company.financialYearEndDay} />
                </Field>
                <Field label="Financial year end month">
                  <Input name="financialYearEndMonth" type="number" min={1} max={12}
                    defaultValue={company.financialYearEndMonth} />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-[12px] text-ink mb-3">
                <input type="checkbox" name="corporationTaxRegistered"
                  defaultChecked={company.corporationTaxRegistered} />
                Registered for corporation tax
              </label>
              <Field label="Reason for this change" hint="Recorded in the audit trail.">
                <Input name="reason" placeholder="Optional" />
              </Field>
            </ActionForm>
          </Disclosure>
        </Panel>
      </div>

      <Panel
        title="Bank accounts"
        description="Transactions are fingerprinted per account, so the same line on two
          accounts is correctly treated as two different transactions."
      >
        {banks.length === 0 ? <Empty title="No bank accounts" /> : (
          <table className="ledger">
            <thead>
              <tr>
                <th>Bank</th><th>Account</th><th>IBAN</th><th>BIC</th>
                <th className="w-20">Currency</th><th className="w-24">Type</th>
                <th className="w-28">Opened</th>
                <th className="w-32 text-right">Opening balance</th>
              </tr>
            </thead>
            <tbody>
              {banks.map((account) => (
                <tr key={account.id}>
                  <td>{account.bankName}</td>
                  <td>{account.accountName}</td>
                  <td className="num !text-left text-ink-muted">{account.iban ?? '—'}</td>
                  <td className="num !text-left text-ink-muted">{account.bic ?? '—'}</td>
                  <td>{account.currency}</td>
                  <td className="text-ink-muted">{label(account.accountType)}</td>
                  <td className="num !text-left">{date(account.openingDate)}</td>
                  <td className="text-right num">
                    {money(account.openingBalanceMinor, account.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {banks.map((account) => (
          <Disclosure key={account.id} summary={`Edit ${account.bankName} — ${account.accountName}`}>
            <ActionForm action={updateBankAccountAction} submit="Save account"
              extra={{ bankAccountId: account.id, currency: account.currency }}>
              <div className="grid grid-cols-3 gap-3">
                <Field label="Bank"><Input name="bankName" defaultValue={account.bankName} /></Field>
                <Field label="Account name">
                  <Input name="accountName" defaultValue={account.accountName} />
                </Field>
                <Field label="IBAN"><Input name="iban" defaultValue={account.iban ?? ''} /></Field>
                <Field label="BIC"><Input name="bic" defaultValue={account.bic ?? ''} /></Field>
                <Field
                  label="Opening balance"
                  help="The balance on the day this account opens in the books. Changing it
                    moves every running balance derived from it."
                >
                  <Input name="openingBalance"
                    defaultValue={(account.openingBalanceMinor / 100).toFixed(2)} />
                </Field>
                <Field label="Opening date">
                  <Input name="openingDate" type="date" defaultValue={account.openingDate} />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-[12px] text-ink mb-3">
                <input type="checkbox" name="active" defaultChecked={account.active} />
                Active
              </label>
            </ActionForm>
          </Disclosure>
        ))}

        <Disclosure summary="Add a bank account" tone="accent">
          <ActionForm action={addBankAccountAction} submit="Add account" resetOnSuccess>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Bank"><Input name="bankName" required placeholder="Bank of Ireland" /></Field>
              <Field label="Account name">
                <Input name="accountName" placeholder="Current account" />
              </Field>
              <Field label="Type">
                <Select name="accountType" defaultValue="current">
                  {['current', 'deposit', 'savings', 'credit_card', 'loan', 'merchant', 'other']
                    .map((type) => <option key={type} value={type}>{label(type)}</option>)}
                </Select>
              </Field>
              <Field label="IBAN"><Input name="iban" /></Field>
              <Field label="BIC"><Input name="bic" /></Field>
              <Field label="Currency">
                <Input name="currency" defaultValue={company.baseCurrency} maxLength={3} />
              </Field>
              <Field label="Opening balance">
                <Input name="openingBalance" placeholder="0.00" />
              </Field>
              <Field label="Opening date">
                <Input name="openingDate" type="date" required />
              </Field>
            </div>
          </ActionForm>
        </Disclosure>
      </Panel>

      <div className="grid grid-cols-2 gap-4 items-start">
        <Panel title="Officers">
          {officers.length === 0 ? <Empty title="No officers recorded" /> : (
            <table className="ledger">
              <thead>
                <tr><th>Name</th><th className="w-32">Role</th><th className="w-28">Appointed</th>
                  <th className="w-24 text-right">Shares</th></tr>
              </thead>
              <tbody>
                {officers.map((officer) => (
                  <tr key={officer.id}>
                    <td>{officer.name}</td>
                    <td><Badge tone="neutral">{label(officer.role)}</Badge></td>
                    <td className="num !text-left">{date(officer.appointedOn)}</td>
                    <td className="text-right num">{officer.sharesHeld ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel
          title="Accounting periods"
          actions={<a href="/settings/periods" className="text-accent text-[12px] hover:underline">
            Manage periods
          </a>}
        >
          <table className="ledger">
            <thead>
              <tr><th>Period</th><th className="w-28">From</th><th className="w-28">To</th>
                <th className="w-24">Status</th></tr>
            </thead>
            <tbody>
              {financialYears.map((year) => (
                <tr key={year.id}>
                  <td>{year.name}</td>
                  <td className="num !text-left">{date(year.startDate)}</td>
                  <td className="num !text-left">{date(year.endDate)}</td>
                  <td>
                    <Badge tone={year.status === 'locked' ? 'accent' : 'neutral'}>
                      {label(year.status)}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </Page>
  );
}

function Row({ label: rowLabel, help, children }: {
  label: string; help?: string; children: React.ReactNode;
}) {
  return (
    <tr>
      <td className="w-48 text-ink-faint align-top">
        {rowLabel}
        {help && <Help>{help}</Help>}
      </td>
      <td>{children}</td>
    </tr>
  );
}
