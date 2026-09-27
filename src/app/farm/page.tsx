import { farmPage } from '@/lib/farmQueries';
import { Page, Panel, Badge, Empty, Input, Disclosure } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import {
  saveFarmProfileAction, addLandParcelAction, endLandParcelAction, createEnterpriseAction, allocateLineAction, createAnimalGroupAction,
  registerAnimalAction, livestockEventAction, moveLivestockAction, reverseLivestockEventAction, postLivestockValuationAction,
  createPlantingAction, recordHarvestAction,
} from '@/app/farm-actions';
import { money, date, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

const ha = (sqm: number) => (sqm / 10_000).toLocaleString('en-IE', { maximumFractionDigits: 4 });
const hundredths = (n: number) => (n / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = (milli: number) => (milli / 1000).toLocaleString('en-IE', { maximumFractionDigits: 3 });

/** The farm (EPIC 24): land, enterprises and their margins, livestock, and crops. */
export default async function FarmPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const today = new Date().toISOString().slice(0, 10);
  const year = Number((await searchParams).year) || Number(today.slice(0, 4));
  const data = farmPage({ asOf: today, from: `${year}-01-01`, to: `${year}-12-31`, harvestYear: year });
  const cur = data.company.baseCurrency;
  const small = 'border border-line-strong rounded px-2 py-1 text-[12px]';
  const activeEnterprises = data.enterprises.filter((e) => !e.endedOn);
  const enterpriseSelect = (
    <select name="enterpriseId" required defaultValue="" className={small}>
      <option value="" disabled>Enterprise</option>
      {activeEnterprises.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
    </select>
  );
  const groupSelect = (name = 'groupId', placeholder = 'Group') => (
    <select name={name} required defaultValue="" className={small}>
      <option value="" disabled>{placeholder}</option>
      {data.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
    </select>
  );
  const species = ['cattle', 'sheep', 'pigs', 'poultry', 'goats', 'horses', 'other'];
  const groupName = new Map(data.groups.map((g) => [g.id, g.name]));
  const heldParcels = data.parcels.filter((p) => !p.heldTo || p.heldTo >= today);

  return (
    <Page
      title={data.profile?.farmName ?? 'Farm'}
      subtitle={data.profile
        ? `Herd number ${data.profile.herdNumber ?? 'not recorded'}${data.profile.flockNumber ? ` · flock ${data.profile.flockNumber}` : ''}`
        : 'Land, enterprises, livestock and crops, on top of the books. The ledger stays the only source of money.'}
      actions={<form className="flex gap-2"><Input name="year" type="number" defaultValue={year} className={small} /><button className={small}>Year</button></form>}
    >
      <Panel title="Land" description={`Farmed today: ${ha(data.area.total.areaSqm)} ha (${hundredths(data.area.total.acresHundredths)} acres), `
        + `${ha(data.area.owned.areaSqm)} ha owned and ${ha(data.area.leased.areaSqm)} ha leased.`}>
        {data.parcels.length === 0 ? <Empty title="No land recorded" detail="Add the parcels the farm owns or leases." /> : (
          <table className="ledger">
            <thead><tr><th className="w-24">Parcel</th><th>Name</th><th className="w-24 text-right">Hectares</th><th className="w-24">Tenure</th><th className="w-48">Held</th><th className="w-28 text-right">Rent a year</th><th className="w-56" /></tr></thead>
            <tbody>
              {data.parcels.map((p) => (
                <tr key={p.id}>
                  <td className="font-mono">{p.reference}</td>
                  <td>{p.name}{p.counterparty ? ` (from ${p.counterparty})` : ''}</td>
                  <td className="text-right tabular-nums">{ha(p.areaSqm)}</td>
                  <td>{label(p.tenure)}</td>
                  <td>{date(p.heldFrom)} – {p.heldTo ? date(p.heldTo) : 'now'}</td>
                  <td className="text-right tabular-nums">{p.annualRentMinor === null ? '—' : money(p.annualRentMinor, cur)}</td>
                  <td>{!p.heldTo && (
                    <ActionForm action={endLandParcelAction} submit="End" inline variant="secondary">
                      <input type="hidden" name="parcelId" value={p.id} />
                      <Input name="heldTo" type="date" required className={small} />
                    </ActionForm>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-3 grid gap-3">
          <Disclosure summary="Add a parcel">
            <ActionForm action={addLandParcelAction} submit="Add" inline>
              <Input name="reference" required placeholder="LPIS reference" className={small} />
              <Input name="name" required placeholder="Name" className={small} />
              <Input name="hectares" required placeholder="Hectares" className={small} />
              <select name="tenure" required defaultValue="owned" className={small}><option value="owned">Owned</option><option value="leased">Leased</option></select>
              <Input name="heldFrom" type="date" required className={small} />
              <Input name="heldTo" type="date" className={small} />
              <Input name="counterparty" placeholder="Leased from" className={small} />
              <Input name="rent" placeholder="Rent a year" className={small} />
            </ActionForm>
          </Disclosure>
          <Disclosure summary="Farm profile">
            <ActionForm action={saveFarmProfileAction} submit="Save" inline>
              <Input name="farmName" required placeholder="Farm name" defaultValue={data.profile?.farmName ?? ''} className={small} />
              <Input name="flockNumber" placeholder="Flock number" defaultValue={data.profile?.flockNumber ?? ''} className={small} />
              <Input name="tradingActivityId" placeholder="Farming activity id (herd number)" defaultValue={data.profile?.tradingActivityId ?? ''} className={small} />
            </ActionForm>
          </Disclosure>
        </div>
      </Panel>

      <Panel title={`Enterprise gross margins, ${year}`} description="Output (allocated income and the change in livestock value) less allocated cost of sales. What is not allocated is shown, never spread.">
        {data.enterprises.length === 0 ? <Empty title="No enterprises" detail="Add dairy, beef, sheep, tillage or another enterprise." /> : (
          <table className="ledger">
            <thead><tr><th>Enterprise</th><th className="w-28 text-right">Output</th><th className="w-28 text-right">Livestock change</th><th className="w-28 text-right">Variable costs</th><th className="w-28 text-right">Gross margin</th><th className="w-28 text-right">Overheads allocated</th></tr></thead>
            <tbody>
              {data.margins.enterprises.map((e) => (
                <tr key={e.enterpriseId}>
                  <td>{e.name} <Badge>{label(e.kind)}</Badge></td>
                  <td className="text-right tabular-nums">{money(e.outputMinor, cur)}</td>
                  <td className="text-right tabular-nums">{money(e.livestockValueChangeMinor, cur)}</td>
                  <td className="text-right tabular-nums">{money(e.variableCostsMinor, cur)}</td>
                  <td className="text-right tabular-nums font-medium">{money(e.grossMarginMinor, cur)}</td>
                  <td className="text-right tabular-nums">{money(e.allocatedOverheadsMinor, cur)}</td>
                </tr>
              ))}
              <tr className="text-ink-muted">
                <td>Not allocated</td>
                <td className="text-right tabular-nums">{money(data.margins.unallocated.incomeMinor, cur)}</td>
                <td />
                <td className="text-right tabular-nums">{money(data.margins.unallocated.costOfSalesMinor, cur)}</td>
                <td />
                <td className="text-right tabular-nums">{money(data.margins.unallocated.overheadsMinor, cur)}</td>
              </tr>
            </tbody>
          </table>
        )}
        <div className="mt-3 grid gap-3">
          <Disclosure summary="Add an enterprise">
            <ActionForm action={createEnterpriseAction} submit="Add" inline>
              <Input name="name" required placeholder="Name" className={small} />
              <select name="kind" required defaultValue="dairy" className={small}>
                {['dairy', 'beef', 'sheep', 'tillage', 'horticulture', 'forestry', 'other'].map((k) => <option key={k} value={k}>{label(k)}</option>)}
              </select>
              <Input name="startedOn" type="date" required className={small} />
            </ActionForm>
          </Disclosure>
          {activeEnterprises.length > 0 && data.lines.length > 0 && (
            <Disclosure summary="Allocate a posted line to an enterprise or crop">
              <ActionForm action={allocateLineAction} submit="Allocate" inline>
                <select name="journalLineId" required defaultValue="" className={small}>
                  <option value="" disabled>Posted line</option>
                  {data.lines.map((l) => (
                    <option key={l.id} value={l.id}>
                      {date(l.entryDate)} {l.accountCode} {l.narrative}: {money(l.accountType === 'income' ? l.credit - l.debit : l.debit - l.credit, cur)}
                      {l.allocatedBasisPoints ? ` (${hundredths(l.allocatedBasisPoints)}% allocated)` : ''}
                    </option>
                  ))}
                </select>
                {enterpriseSelect}
                <Input name="percent" required defaultValue="100" placeholder="%" className={small} />
                <select name="plantingId" defaultValue="" className={small}>
                  <option value="">No crop</option>
                  {data.plantings.map((p) => <option key={p.id} value={p.id}>{p.harvestYear} {p.crop}</option>)}
                </select>
                <select name="inputKind" defaultValue="" className={small}>
                  <option value="">—</option>
                  {['seed', 'fertiliser', 'chemicals', 'contractor', 'sales', 'other'].map((k) => <option key={k} value={k}>{label(k)}</option>)}
                </select>
              </ActionForm>
            </Disclosure>
          )}
        </div>
      </Panel>

      <Panel title="Livestock" description="Head counts come from the register of events. A mistake is reversed, never edited.">
        {data.groups.length === 0 ? <Empty title="No animal groups" detail="Add a group for each category you count and value." /> : (
          <table className="ledger">
            <thead><tr><th>Group</th><th className="w-24">Species</th><th className="w-24 text-right">Head today</th></tr></thead>
            <tbody>
              {data.groups.map((g) => (
                <tr key={g.id}><td>{g.name}</td><td>{label(g.species)}</td><td className="text-right tabular-nums">{g.headCount}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-3 grid gap-3">
          {activeEnterprises.length > 0 && (
            <Disclosure summary="Add an animal group">
              <ActionForm action={createAnimalGroupAction} submit="Add" inline>
                {enterpriseSelect}
                <Input name="name" required placeholder="Dairy cows, weanlings…" className={small} />
                <select name="species" required defaultValue="cattle" className={small}>{species.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
              </ActionForm>
            </Disclosure>
          )}
          <Disclosure summary={`Tagged animals (${data.animals.length})`}>
            <ActionForm action={registerAnimalAction} submit="Register" inline>
              <Input name="tagNumber" required placeholder="Tag number" className={small} />
              <select name="species" required defaultValue="cattle" className={small}>{species.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
              <select name="sex" defaultValue="" className={small}><option value="">Sex</option><option value="female">Female</option><option value="male">Male</option><option value="castrated_male">Castrated male</option></select>
              <Input name="breed" placeholder="Breed" className={small} />
              <Input name="dateOfBirth" type="date" className={small} />
              <Input name="damTag" placeholder="Dam's tag" className={small} />
            </ActionForm>
            {data.animals.length > 0 && (
              <table className="ledger mt-2">
                <thead><tr><th className="w-40">Tag</th><th className="w-24">Sex</th><th>Breed</th><th className="w-28">Born</th><th className="w-40">Where</th></tr></thead>
                <tbody>
                  {data.animals.map((a) => (
                    <tr key={a.id}><td className="font-mono">{a.tagNumber}</td><td>{a.sex ? label(a.sex) : '—'}</td><td>{a.breed}</td><td>{date(a.dateOfBirth)}</td>
                      <td>{a.onFarm ? groupName.get(a.groupId!) : <Badge>off the farm</Badge>}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </Disclosure>
          {data.groups.length > 0 && (
            <>
              <Disclosure summary="Record a purchase, sale, birth, death or opening count">
                <ActionForm action={livestockEventAction} submit="Record" inline>
                  <select name="kind" required defaultValue="" className={small}>
                    <option value="" disabled>Event</option>
                    {['opening', 'purchase', 'sale', 'birth', 'death'].map((k) => <option key={k} value={k}>{label(k)}</option>)}
                  </select>
                  {groupSelect()}
                  <Input name="date" type="date" required defaultValue={today} className={small} />
                  <Input name="headCount" type="number" min="1" placeholder="Head" className={small} />
                  <Input name="animal" placeholder="or one tag" className={small} />
                  <Input name="amount" placeholder="Price" className={small} />
                  <Input name="reason" placeholder="Cause of death" className={small} />
                </ActionForm>
              </Disclosure>
              {data.groups.length > 1 && (
                <Disclosure summary="Move animals between groups">
                  <ActionForm action={moveLivestockAction} submit="Move" inline>
                    {groupSelect('fromGroupId', 'From')}{groupSelect('toGroupId', 'To')}
                    <Input name="date" type="date" required defaultValue={today} className={small} />
                    <Input name="headCount" type="number" min="1" placeholder="Head" className={small} />
                    <Input name="animal" placeholder="or one tag" className={small} />
                  </ActionForm>
                </Disclosure>
              )}
              <Disclosure summary="Value the livestock and post the change">
                <ActionForm action={postLivestockValuationAction} submit="Post the valuation">
                  <div className="flex flex-wrap gap-2 mb-2 items-center">
                    <Input name="date" type="date" required defaultValue={today} className={small} />
                    <label className="text-[12px] flex items-center gap-1"><input type="checkbox" name="opening" /> Opening valuation (must agree to the opening balance)</label>
                  </div>
                  <table className="ledger">
                    <thead><tr><th>Group</th><th className="w-40">Value per head</th><th className="w-56">Basis</th></tr></thead>
                    <tbody>
                      {data.groups.map((g) => (
                        <tr key={g.id}>
                          <td>{g.name}<input type="hidden" name="groupId" value={g.id} /></td>
                          <td><Input name="valuePerHead" placeholder="0.00" className={small} /></td>
                          <td><Input name="basis" placeholder="Cost, market value…" className={small} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ActionForm>
              </Disclosure>
            </>
          )}
        </div>
        {data.valuations.length > 0 && (
          <table className="ledger mt-3">
            <thead><tr><th className="w-28">Valued at</th><th className="text-right">Value</th><th className="w-32">Posted by</th></tr></thead>
            <tbody>{data.valuations.map((v) => <tr key={v.id}><td>{date(v.valuationDate)}</td><td className="text-right tabular-nums">{money(v.valueMinor, cur)}</td><td>{v.postedBy}</td></tr>)}</tbody>
          </table>
        )}
        {data.events.length > 0 && (
          <table className="ledger mt-3">
            <thead><tr><th className="w-24">Date</th><th className="w-40">Group</th><th className="w-28">Event</th><th className="w-16 text-right">Head</th><th>Note</th><th className="w-56">Reverse</th></tr></thead>
            <tbody>
              {data.events.map((e) => (
                <tr key={e.id}>
                  <td>{date(e.eventDate)}</td><td>{groupName.get(e.groupId)}</td><td>{label(e.kind)}</td>
                  <td className="text-right tabular-nums">{e.headCount}</td><td className="text-[12px]">{e.reason}</td>
                  <td>{e.kind !== 'reversal' && e.kind !== 'transfer_in' && (
                    <ActionForm action={reverseLivestockEventAction} submit="Reverse" inline variant="secondary">
                      <input type="hidden" name="eventId" value={e.id} />
                      <input type="hidden" name="date" value={today} />
                      <Input name="reason" required placeholder="Why" className={small} />
                    </ActionForm>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title={`Crops, ${year} harvest`} description="Inputs and sales are shares of posted lines, so every figure is in the books. Yield is per hectare sown.">
        {data.crops.length === 0 ? <Empty title="No crops for this harvest" detail="Add a planting on one of the farm's parcels." /> : (
          <table className="ledger">
            <thead><tr><th>Crop</th><th className="w-20 text-right">Hectares</th><th className="w-24 text-right">Inputs</th><th className="w-24 text-right">Sales</th><th className="w-24 text-right">Margin</th><th className="w-24 text-right">Per ha</th><th className="w-40">Yield</th></tr></thead>
            <tbody>
              {data.crops.map((c) => (
                <tr key={c.planting.id}>
                  <td>{c.planting.crop}{c.planting.variety ? ` (${c.planting.variety})` : ''}</td>
                  <td className="text-right tabular-nums">{ha(c.planting.areaSqm)}</td>
                  <td className="text-right tabular-nums" title={`Seed ${money(c.inputs.seed, cur)}, fertiliser ${money(c.inputs.fertiliser, cur)}, chemicals ${money(c.inputs.chemicals, cur)}, contractor ${money(c.inputs.contractor, cur)}, other ${money(c.inputs.other, cur)}`}>{money(c.inputsMinor, cur)}</td>
                  <td className="text-right tabular-nums">{money(c.salesMinor, cur)}</td>
                  <td className="text-right tabular-nums">{money(c.marginMinor, cur)}</td>
                  <td className="text-right tabular-nums">{money(c.marginPerHectareMinor, cur)}</td>
                  <td>{c.harvests.map((h) => `${qty(h.yieldPerHectareMilli)} ${h.unit}/ha`).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-3 grid gap-3">
          {activeEnterprises.length > 0 && heldParcels.length > 0 && (
            <Disclosure summary="Add a planting">
              <ActionForm action={createPlantingAction} submit="Add" inline>
                {enterpriseSelect}
                <select name="parcelId" required defaultValue="" className={small}>
                  <option value="" disabled>Field</option>
                  {heldParcels.map((p) => <option key={p.id} value={p.id}>{p.reference} {p.name} ({ha(p.areaSqm)} ha)</option>)}
                </select>
                <Input name="crop" required placeholder="Crop" className={small} />
                <Input name="variety" placeholder="Variety" className={small} />
                <Input name="harvestYear" type="number" required defaultValue={year} className={small} />
                <Input name="hectares" required placeholder="Hectares sown" className={small} />
                <Input name="sownOn" type="date" className={small} />
              </ActionForm>
            </Disclosure>
          )}
          {data.plantings.length > 0 && (
            <Disclosure summary="Record a harvest">
              <ActionForm action={recordHarvestAction} submit="Record" inline>
                <select name="plantingId" required defaultValue="" className={small}>
                  <option value="" disabled>Planting</option>
                  {data.plantings.map((p) => <option key={p.id} value={p.id}>{p.harvestYear} {p.crop}</option>)}
                </select>
                <Input name="harvestedOn" type="date" required defaultValue={today} className={small} />
                <Input name="quantity" required placeholder="Quantity" className={small} />
                <Input name="unit" required placeholder="tonnes, bales" className={small} />
              </ActionForm>
            </Disclosure>
          )}
        </div>
      </Panel>
    </Page>
  );
}
