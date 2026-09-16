import { activeCompany, companyContext, bankAccountList, officerList } from '@/lib/queries';
import { Page, Panel, Badge, Help, Empty } from '@/components/primitives';
import { DemoLoader } from '@/components/DemoLoader';
import { money, date, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** Company setup (README §5). */
export default function CompanySettingsPage() {
  const company = activeCompany();

  if (!company) {
    return (
      <Page title="Company" subtitle="No company has been created yet.">
        <Panel title="Load demo data" id="demo">
          <div className="px-4 py-4 max-w-2xl">
            <p className="text-ink-muted mb-3 leading-relaxed">
              The demo company is a fictional Irish LTD with a quarter of real-looking
              transactions: reverse-charge purchases from EU and US suppliers, an exempt
              insurance renewal, a capital purchase, a director-paid expense, an unmatched
              transaction and a duplicate. It is labelled as demo data on every screen.
            </p>
            <DemoLoader />
          </div>
        </Panel>
      </Page>
    );
  }

  const { financialYears } = companyContext();
  const banks = bankAccountList();
  const officers = officerList();

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
              <Row label="Records address">{company.recordsAddress ?? '—'}</Row>
            </tbody>
          </table>
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
        </Panel>
      </div>

      <Panel title="Bank accounts">
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

        <Panel title="Accounting periods">
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
