import {
  Panel, Badge, Field, Input, Select, Textarea, Disclosure, Empty,
} from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { getDb } from '@/db';
import { date, label } from '@/lib/format';
import { complianceProfile } from '@/domain/config/businessProfile';
import type { companies } from '@/db/schema';
import {
  recordTradingNameAction, endTradingNameAction,
  recordTradingActivityAction, ceaseTradingActivityAction,
  recordRegistrationAction, endRegistrationAction,
  recordEuVatNumberAction, recordEoriNumberAction,
  ceaseTradeAction, archiveCompanyAction,
} from '@/app/business-profile-actions';

/**
 * The business behind the books (issue #297): the names it trades under, the
 * activities it trades in, the registrations it holds besides VAT and
 * corporation tax, its cross-border identifiers, and its closure and archive.
 * Everything shown comes from the domain layer, and every change goes back
 * through it, so the rules (effective-dated rows, a person's name on each
 * fact) hold on this screen too.
 */
export function BusinessProfilePanels({ company }: { company: typeof companies.$inferSelect }) {
  const profile = complianceProfile(getDb(), company.id);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <Panel
        title="Trading names"
        description="A business can trade under more than one name. Names are recorded from a date and never
          deleted, so the record of what it traded under survives the change."
      >
        {profile.tradingNames.length === 0 ? (
          <Empty title="No trading names recorded" detail="The legal name is used wherever a trading name is not." />
        ) : (
          <table className="ledger">
            <thead>
              <tr><th>Name</th><th className="w-32">From</th><th className="w-32">Until</th><th /></tr>
            </thead>
            <tbody>
              {profile.tradingNames.map((name) => (
                <tr key={name.id}>
                  <td>
                    {name.name}{' '}
                    {company.tradingName === name.name && !name.effectiveTo
                      && <Badge tone="positive">Current</Badge>}
                    {name.effectiveTo && <Badge tone="neutral">Ended</Badge>}
                  </td>
                  <td className="num !text-left">{date(name.effectiveFrom)}</td>
                  <td className="num !text-left">{name.effectiveTo ? date(name.effectiveTo) : '—'}</td>
                  <td className="w-72">
                    {!name.effectiveTo && (
                      <ActionForm action={endTradingNameAction} submit="Stopped using" inline variant="secondary">
                        <input type="hidden" name="tradingNameId" value={name.id} />
                        <Input name="effectiveTo" type="date" required aria-label={`Date ${name.name} stopped being used`} />
                      </ActionForm>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <Disclosure summary="Record a trading name">
          <ActionForm action={recordTradingNameAction} submit="Record name">
            <div className="grid grid-cols-3 gap-3">
              <Field label="Name">
                <Input name="name" required placeholder="Acme Tools" />
              </Field>
              <Field label="Used from">
                <Input name="effectiveFrom" type="date" required defaultValue={today} />
              </Field>
              <Field label="Notes" hint="Optional, kept with the name.">
                <Input name="notes" />
              </Field>
            </div>
          </ActionForm>
        </Disclosure>
      </Panel>

      <Panel
        title="Trading activities"
        description="What the business trades in, from when to when. A farm is one activity here, with its
          herd number; stock relief and the herd basis are worked per herd."
      >
        {profile.tradingActivities.length === 0 ? (
          <Empty title="No trading activities recorded" />
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th>Activity</th><th className="w-44">Sector</th><th className="w-32">Commenced</th>
                <th className="w-32">Ceased</th><th className="w-32">Herd number</th><th />
              </tr>
            </thead>
            <tbody>
              {profile.tradingActivities.map((activity) => (
                <tr key={activity.id}>
                  <td>{activity.name}</td>
                  <td>{label(activity.sector)} {activity.sector === 'farming' && <Badge tone="accent">Farm</Badge>}</td>
                  <td className="num !text-left">{date(activity.commencedOn)}</td>
                  <td className="num !text-left">{activity.ceasedOn ? date(activity.ceasedOn) : '—'}</td>
                  <td className="num !text-left">{activity.herdNumber ?? '—'}</td>
                  <td className="w-72">
                    {!activity.ceasedOn && (
                      <ActionForm action={ceaseTradingActivityAction} submit="Ceased" inline variant="secondary">
                        <input type="hidden" name="activityId" value={activity.id} />
                        <Input name="ceasedOn" type="date" required aria-label={`Date ${activity.name} ceased`} />
                      </ActionForm>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <Disclosure summary="Record a trading activity">
          <ActionForm action={recordTradingActivityAction} submit="Record activity">
            <div className="grid grid-cols-3 gap-3">
              <Field label="Activity">
                <Input name="name" required placeholder="Dairy herd" />
              </Field>
              <Field label="Sector">
                <Select name="sector" defaultValue="other">
                  <option value="farming">Farming</option>
                  <option value="retail">Retail</option>
                  <option value="construction">Construction</option>
                  <option value="professional_services">Professional services</option>
                  <option value="hospitality">Hospitality</option>
                  <option value="transport">Transport</option>
                  <option value="manufacturing">Manufacturing</option>
                  <option value="other">Other</option>
                </Select>
              </Field>
              <Field label="Commenced">
                <Input name="commencedOn" type="date" required defaultValue={company.tradeCommencedOn ?? today} />
              </Field>
              <Field
                label="Herd number"
                help="The Department of Agriculture herd number. Recorded for farming only."
              >
                <Input name="herdNumber" placeholder="A123456" />
              </Field>
              <Field label="Notes" hint="Optional.">
                <Input name="notes" />
              </Field>
            </div>
          </ActionForm>
        </Disclosure>
      </Panel>

      <Panel
        title="Registrations"
        description="Income tax, PAYE, RCT and anything else the business is registered for, each from a
          date. VAT and corporation tax are recorded with the tax settings, because the books turn on
          them everywhere. PAYE is recorded only: payroll is deliberately out of scope."
      >
        {profile.registrations.length === 0 ? (
          <Empty title="No registrations recorded" />
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th>Registration</th><th className="w-40">Number</th><th className="w-32">From</th>
                <th className="w-32">Ended</th><th />
              </tr>
            </thead>
            <tbody>
              {profile.registrations.map((registration) => (
                <tr key={registration.id}>
                  <td>
                    {registration.registrationType === 'other' ? registration.label : label(registration.registrationType)}
                    {registration.deregisteredOn && <Badge tone="neutral">Ended</Badge>}
                  </td>
                  <td className="num !text-left">{registration.registrationNumber ?? '—'}</td>
                  <td className="num !text-left">{date(registration.registeredFrom)}</td>
                  <td className="num !text-left">{registration.deregisteredOn ? date(registration.deregisteredOn) : '—'}</td>
                  <td className="w-72">
                    {!registration.deregisteredOn && (
                      <ActionForm action={endRegistrationAction} submit="Ended" inline variant="secondary">
                        <input type="hidden" name="registrationId" value={registration.id} />
                        <Input name="deregisteredOn" type="date" required aria-label="Date the registration ended" />
                      </ActionForm>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <Disclosure summary="Record a registration">
          <ActionForm action={recordRegistrationAction} submit="Record registration">
            <div className="grid grid-cols-3 gap-3">
              <Field label="Kind">
                <Select name="registrationType" defaultValue="income_tax">
                  <option value="income_tax">Income tax</option>
                  <option value="paye">PAYE</option>
                  <option value="rct">RCT</option>
                  <option value="other">Other</option>
                </Select>
              </Field>
              <Field
                label="Name"
                help="Required for an “other” registration, so a person can tell later what it is."
              >
                <Input name="label" placeholder="DAC7" />
              </Field>
              <Field label="Registration number">
                <Input name="registrationNumber" />
              </Field>
              <Field label="Registered from">
                <Input name="registeredFrom" type="date" required defaultValue={today} />
              </Field>
              <Field label="Notes" hint="Optional.">
                <Input name="notes" />
              </Field>
            </div>
          </ActionForm>
        </Disclosure>
      </Panel>

      <Panel
        title="Cross-border identifiers"
        description="The VAT identification number for intra-Community transactions (VIES) and the EORI
          number for customs. In Ireland the VIES number is the registration number with the extra
          character Revenue issues, so it can differ from the VAT number. A person records each and
          says what it was checked against."
      >
        <table className="ledger">
          <tbody>
            <tr>
              <td className="w-64 text-ink-faint">EU VAT identification number</td>
              <td>
                {company.euVatNumber ? (
                  <>
                    <Badge tone="positive">{company.euVatNumber}</Badge>
                    <div className="text-[11px] text-ink-faint">
                      from {date(company.euVatRegisteredFrom!)} — {company.euVatBasis}, recorded by {company.euVatConfirmedBy}
                    </div>
                  </>
                ) : <Badge tone="caution">Not recorded</Badge>}
              </td>
            </tr>
            <tr>
              <td className="text-ink-faint">EORI number</td>
              <td>
                {company.eoriNumber ? (
                  <>
                    <Badge tone="positive">{company.eoriNumber}</Badge>
                    <div className="text-[11px] text-ink-faint">
                      {company.eoriBasis}, recorded by {company.eoriConfirmedBy}
                    </div>
                  </>
                ) : <Badge tone="caution">Not recorded</Badge>}
              </td>
            </tr>
          </tbody>
        </table>

        <div className="grid grid-cols-2 gap-4 px-4 py-3 items-start">
          <Disclosure summary="Record the EU VAT identification number">
            <ActionForm action={recordEuVatNumberAction} submit="Record number">
              <Field label="Number">
                <Input name="vatNumber" required placeholder="IE1234567A" />
              </Field>
              <Field label="Applies from">
                <Input name="registeredFrom" type="date" required defaultValue={today} />
              </Field>
              <Field
                label="Checked against"
                help="What you relied on: VIES, or the Revenue correspondence that issued the number."
              >
                <Input name="basis" required />
              </Field>
            </ActionForm>
          </Disclosure>

          <Disclosure summary="Record the EORI number">
            <ActionForm action={recordEoriNumberAction} submit="Record number">
              <Field label="Number">
                <Input name="eoriNumber" required placeholder="IE1234567A" />
              </Field>
              <Field
                label="Checked against"
                help="What you relied on, e.g. the EU EORI validation portal."
              >
                <Input name="basis" required />
              </Field>
            </ActionForm>
          </Disclosure>
        </div>
      </Panel>

      <Panel
        title="Closure and archive"
        description="Two ends a book can have. Recording the date the trade ceased is what the income tax
          basis periods turn on; it does not close the books, and anything it exposes is raised for
          review. Archiving takes these books out of the working set without deleting anything, and
          can be undone."
        tone={company.tradeCeasedOn ? 'warning' : 'default'}
      >
        <table className="ledger">
          <tbody>
            <tr>
              <td className="w-64 text-ink-faint">Trade</td>
              <td>
                {company.tradeCeasedOn
                  ? <Badge tone="caution">Ceased {date(company.tradeCeasedOn)}</Badge>
                  : <Badge tone="positive">Trading</Badge>}
                {company.tradeCommencedOn && (
                  <span className="text-ink-muted ml-2">since {date(company.tradeCommencedOn)}</span>
                )}
              </td>
            </tr>
            <tr>
              <td className="text-ink-faint">Archived</td>
              <td>{company.archivedAt ? <Badge tone="caution">{date(company.archivedAt)}</Badge> : 'No'}</td>
            </tr>
          </tbody>
        </table>

        <Disclosure summary="Record the date the trade ceased">
          <ActionForm action={ceaseTradeAction} submit="Record cessation">
            <div className="grid grid-cols-3 gap-3">
              <Field label="The trade ceased on">
                <Input name="ceasedOn" type="date" required />
              </Field>
              <Field
                label="What is known"
                help="Sold, retired, dissolved — whatever is known about why the trade ended."
              >
                <Input name="basis" required />
              </Field>
              <Field
                label="VAT registration cancelled on"
                help="Optional. When Revenue cancelled the VAT registration; the date decides the final
                  return. Left blank, the open registration is raised for review rather than closed."
              >
                <Input name="vatDeregistrationOn" type="date" />
              </Field>
            </div>
          </ActionForm>
        </Disclosure>

        <Disclosure summary="Archive these books">
          <ActionForm
            action={archiveCompanyAction}
            submit="Archive this business"
            variant="danger"
            confirm="Archive these books? They stop being the working set until brought back. Nothing is deleted."
          >
            <Field
              label="Why"
              help="Sold, dissolved, moved to another system — kept with the archive and in the audit trail."
            >
              <Input name="basis" required />
            </Field>
          </ActionForm>
        </Disclosure>
      </Panel>

      <Panel
        title="Compliance profile"
        description="Every registration the business holds, and what is still missing, on one screen.
          The gaps are named for a person to close; nothing here is filled in for you."
        tone={profile.gaps.length > 0 ? 'warning' : 'positive'}
      >
        <table className="ledger">
          <tbody>
            <tr>
              <td className="w-64 text-ink-faint">Business type</td>
              <td>
                {label(profile.entityType)}
                {profile.tradeCeasedOn && <Badge tone="caution">Trade ceased {date(profile.tradeCeasedOn)}</Badge>}
              </td>
            </tr>
            <tr>
              <td className="text-ink-faint">VAT</td>
              <td>
                <Badge tone={profile.vat.status === 'registered' ? 'positive' : 'neutral'}>
                  {label(profile.vat.status)}
                </Badge>
                {profile.vat.number && <span className="text-ink-muted ml-2">{profile.vat.number}</span>}
                {profile.vat.euVatNumber && (
                  <span className="text-ink-muted ml-2">VIES {profile.vat.euVatNumber}</span>
                )}
              </td>
            </tr>
            <tr>
              <td className="text-ink-faint">Corporation tax</td>
              <td>{profile.corporationTax.registered ? 'Registered' : 'Not recorded'}</td>
            </tr>
            <tr>
              <td className="text-ink-faint">EORI</td>
              <td>{profile.eori ? profile.eori.number : '—'}</td>
            </tr>
            <tr>
              <td className="text-ink-faint">Income tax / PAYE / other</td>
              <td>
                {profile.registrations.length === 0
                  ? 'No registrations recorded'
                  : profile.registrations.map((r) =>
                    `${r.registrationType === 'other' ? r.label : label(r.registrationType)}${r.deregisteredOn ? ' (ended)' : ''}`,
                  ).join(', ')}
              </td>
            </tr>
          </tbody>
        </table>

        {profile.gaps.length === 0
          ? <p className="px-4 py-3 text-ink-muted text-[12px]">Nothing missing that this application can tell.</p>
          : (
            <table className="ledger">
              <thead><tr><th className="w-20">Kind</th><th>What is missing or needs a look</th></tr></thead>
              <tbody>
                {profile.gaps.map((gap) => (
                  <tr key={gap.code}>
                    <td><Badge tone={gap.kind === 'gap' ? 'caution' : 'accent'}>{gap.kind === 'gap' ? 'Gap' : 'Check'}</Badge></td>
                    <td className="leading-relaxed">{gap.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Panel>
    </>
  );
}
