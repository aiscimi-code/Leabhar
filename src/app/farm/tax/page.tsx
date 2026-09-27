import { farmTaxPage } from '@/lib/farmQueries';
import { Page, Panel, Badge, Empty, Input, Disclosure } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import {
  recordGrantAction, linkGrantReceiptAction, reconcileGrantsAction, recordFarmProfitAction, farmPartnershipRegisterAction,
  shareFarmingAction,
} from '@/app/farm-tax-actions';
import { money, date, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** Farm tax and grants (EPIC 25): the year's reliefs as the tax computation applied them, and the records behind them. */
export default async function FarmTaxPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const today = new Date().toISOString().slice(0, 10);
  const year = Number((await searchParams).year) || Number(today.slice(0, 4));
  const data = farmTaxPage(year);
  const cur = data.company.baseCurrency;
  const small = 'border border-line-strong rounded px-2 py-1 text-[12px]';
  const s = data.summary;
  const row = (label: string, amount: number | null, note?: string) => (
    <tr><td>{label}{note && <div className="text-[12px] text-ink-muted">{note}</div>}</td><td className="text-right tabular-nums w-40">{amount === null ? '—' : money(amount, cur)}</td></tr>
  );

  return (
    <Page
      title="Farm tax and grants"
      subtitle="Stock relief and income averaging are claims: record them as decisions on the year-end screen, and the
        tax computation applies them. The figures here are the computation's."
      actions={<form className="flex gap-2"><Input name="year" type="number" defaultValue={year} className={small} /><button className={small}>Year</button></form>}
    >
      <Panel title={`Summary, ${year}`}>
        {data.summaryError ? <p className="text-[13px]">{data.summaryError}</p> : s && (
          <>
            <table className="ledger">
              <tbody>
                {row(`Farming profit, ${date(s.from)} to ${date(s.to)}, before capital allowances and farm reliefs`, s.profitBeforeReliefsMinor)}
                {row('Less stock relief', -s.stockReliefMinor, s.stockReliefCategory ? `Claimed at the ${label(s.stockReliefCategory)} rate` : 'Not claimed')}
                {s.averaging && row('Income averaging', s.averaging.applied ? s.averaging.averageMinor : null,
                  s.averaging.applied
                    ? `Charged on the average of ${s.averaging.years.map((y) => y.year).join(', ')}`
                    : 'Stepped out for this year')}
                {row('Capital allowances', s.capitalAllowancesMinor, `Of which farm buildings and slurry storage: ${money(s.farmBuildingAllowancesMinor, cur)}`)}
                {row('Taxable farming profit', s.taxableFarmingProfitMinor)}
                {row('Revenue grants received', s.grants.revenueReceivedMinor)}
                {row('Capital grants received', s.grants.capitalReceivedMinor, 'Taken off the cost of the assets they fund (s.317)')}
                {row('Grants awarded, not yet received', s.grants.awardedOutstandingMinor)}
                {s.grants.unlinkedMinor ? row('Scheme income not linked to a grant', s.grants.unlinkedMinor) : null}
                {s.successionCredit && row(`Succession tax credit (${s.successionCredit.identifier})`, s.successionCredit.creditMinor,
                  'Shared by the partners against their income tax (s.667D)')}
              </tbody>
            </table>
            {s.findings.length > 0 && (
              <Disclosure summary={`Notes from the computation (${s.findings.length})`}>
                <ul className="list-disc pl-5 text-[12px] space-y-1">{s.findings.map((f, i) => <li key={i}>{f}</li>)}</ul>
              </Disclosure>
            )}
          </>
        )}
      </Panel>

      <Panel title="Grants and scheme payments" description="What each grant is for; its receipts are posted lines linked to it.">
        {data.grants.grants.length === 0 ? <Empty title="No grants recorded" detail="Record BISS, ACRES, TAMS and other awards." /> : (
          <table className="ledger">
            <thead><tr><th>Scheme</th><th className="w-24">Kind</th><th className="w-28">Awarded</th><th className="w-28 text-right">Amount</th><th className="w-28 text-right">Received</th><th className="w-28 text-right">Outstanding</th></tr></thead>
            <tbody>
              {data.grants.grants.map((g) => (
                <tr key={g.id}>
                  <td>{g.scheme} <span className="text-ink-muted text-[12px]">{g.payer}{g.reference ? ` · ${g.reference}` : ''}</span></td>
                  <td><Badge>{g.kind}</Badge></td><td>{date(g.awardedOn)}</td>
                  <td className="text-right tabular-nums">{money(g.awardedMinor, cur)}</td>
                  <td className="text-right tabular-nums">{money(g.receivedMinor, cur)}</td>
                  <td className="text-right tabular-nums">{money(g.outstandingMinor, cur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data.grants.unlinked.length > 0 && (
          <p className="mt-2 text-[13px]">{data.grants.unlinked.length} credit(s) to scheme income are not linked to a grant, totalling {money(data.grants.unlinked.reduce((t, u) => t + u.amountMinor, 0), cur)}.</p>
        )}
        <div className="mt-3 grid gap-3">
          <Disclosure summary="Record a grant">
            <ActionForm action={recordGrantAction} submit="Record" inline>
              <Input name="scheme" required placeholder="Scheme (BISS, TAMS…)" className={small} />
              <Input name="payer" required defaultValue="DAFM" className={small} />
              <Input name="reference" placeholder="Reference" className={small} />
              <select name="kind" required defaultValue="revenue" className={small}><option value="revenue">Revenue</option><option value="capital">Capital</option></select>
              <Input name="awarded" required placeholder="Amount awarded" className={small} />
              <Input name="awardedOn" type="date" required defaultValue={today} className={small} />
              <select name="fixedAssetId" defaultValue="" className={small}>
                <option value="">Asset (capital grants)</option>
                {data.assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </ActionForm>
          </Disclosure>
          {data.grants.grants.length > 0 && (
            <Disclosure summary="Link a receipt to a grant">
              <ActionForm action={linkGrantReceiptAction} submit="Link" inline>
                <select name="grantId" required defaultValue="" className={small}>
                  <option value="" disabled>Grant</option>
                  {data.grants.grants.map((g) => <option key={g.id} value={g.id}>{g.scheme} ({date(g.awardedOn)})</option>)}
                </select>
                <select name="journalLineId" required defaultValue="" className={small}>
                  <option value="" disabled>Posted credit line</option>
                  {data.creditLines.map((l) => <option key={l.id} value={l.id}>{date(l.entryDate)} {l.accountCode} {l.narrative}: {money(l.credit - l.debit, cur)}</option>)}
                </select>
              </ActionForm>
            </Disclosure>
          )}
          <ActionForm action={reconcileGrantsAction} submit="Raise unlinked receipts for review" inline variant="secondary">
            <input type="hidden" name="asOf" value={`${year}-12-31`} />
          </ActionForm>
        </div>
      </Panel>

      <Panel title="Records the reliefs rely on">
        <div className="grid gap-3">
          <Disclosure summary="A farming profit for a year before these books (income averaging)">
            <ActionForm action={recordFarmProfitAction} submit="Record" inline>
              <Input name="year" type="number" required defaultValue={year - 1} className={small} />
              <Input name="profit" required placeholder="Profit before capital allowances (loss: -)" className={small} />
              <Input name="source" required placeholder="From the return or accounts for the year" className={small} />
            </ActionForm>
          </Disclosure>
          {data.company.entityType === 'partnership' && (
            <Disclosure summary={`Register of farm partnerships (${data.registrations.length})`}>
              {data.registrations.map((r) => <p key={r.id} className="text-[13px]">{label(r.register)} {r.identifier}, from {date(r.registeredOn)}{r.endedOn ? ` to ${date(r.endedOn)}` : ''}</p>)}
              <ActionForm action={farmPartnershipRegisterAction} submit="Record" inline>
                <select name="register" required defaultValue="registered_farm_partnership" className={small}>
                  <option value="registered_farm_partnership">Registered farm partnership (s.667C)</option>
                  <option value="succession_farm_partnership">Succession farm partnership (s.667D)</option>
                </select>
                <Input name="identifier" required placeholder="Identifier" className={small} />
                <Input name="registeredOn" type="date" required className={small} />
              </ActionForm>
            </Disclosure>
          )}
          <Disclosure summary={`Share farming arrangements (${data.shareFarming.length})`}>
            {data.shareFarming.map((a) => (
              <p key={a.id} className="text-[13px]">With {a.counterparty}, from {date(a.startsOn)}: {a.outputShareBasisPoints / 100}% of output, {a.costShareBasisPoints / 100}% of shared costs ({label(a.landProvidedBy)} land)</p>
            ))}
            <ActionForm action={shareFarmingAction} submit="Record" inline>
              <Input name="counterparty" required placeholder="Other party" className={small} />
              <select name="landProvidedBy" required defaultValue="this_farm" className={small}><option value="this_farm">This farm&apos;s land</option><option value="counterparty">Their land</option></select>
              <select name="parcelIds" multiple className={small}>
                {data.parcels.map((p) => <option key={p.id} value={p.id}>{p.reference} {p.name}</option>)}
              </select>
              <Input name="outputShare" required placeholder="Our output share %" className={small} />
              <Input name="costShare" required placeholder="Our cost share %" className={small} />
              <Input name="startsOn" type="date" required className={small} />
              <Input name="endsOn" type="date" className={small} />
            </ActionForm>
          </Disclosure>
        </div>
      </Panel>
    </Page>
  );
}
