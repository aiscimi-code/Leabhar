import { fixedAssetList, chartOfAccounts } from '@/lib/queries';
import { Page, Panel, Badge, Help, Empty, Field, Input, Select, Disclosure } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { postDepreciationAction } from '@/app/settings-actions';
import {
  registerFixedAssetAction, recordCarEmissionsAction, transferFixedAssetAction, reconcileFixedAssetsAction,
} from '@/app/assets-actions';
import { money, date, rate, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** Fixed asset register (README §29). */
export default function AssetsPage() {
  const rows = fixedAssetList();
  const costAccounts = chartOfAccounts().filter((a) => a.active && a.type === 'asset' && a.subtype === 'fixed_asset'
    && a.systemKey !== 'accumulated_depreciation' && !/accumulated depreciation/i.test(a.name));
  const today = new Date().toISOString().slice(0, 10);
  const small = 'border border-line-strong rounded px-2 py-1 text-[12px]';
  const held = rows.filter(({ asset }) => asset.status !== 'disposed');
  const cars = held.filter(({ asset }) => asset.assetCategory === 'motor_vehicles');

  return (
    <Page
      title="Fixed assets"
      subtitle="Accounting depreciation and tax capital allowances are tracked separately,
        because Irish tax does not accept your depreciation policy."
    >
      <Panel>
        {rows.length === 0 ? (
          <Empty
            title="No fixed assets"
            detail="Substantial purchases are flagged for review when they are classified,
              rather than being capitalised automatically."
          />
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th>Asset</th>
                <th className="w-32">Category</th>
                <th className="w-24">Purchased</th>
                <th className="w-40">Supplier</th>
                <th className="w-28 text-right">Cost</th>
                <th className="w-28 text-right">
                  Depreciation
                  <Help>
                    Your own accounting depreciation, charged to the profit and loss account.
                    It is added back in the tax computation.
                  </Help>
                </th>
                <th className="w-28 text-right">Net book value</th>
                <th className="w-36 text-right">
                  Capital allowances
                  <Help>
                    The tax equivalent of depreciation, at a rate set by legislation rather
                    than by you. Configured per asset, not hard-coded — confirm the rate
                    against current guidance.
                  </Help>
                </th>
                <th className="w-24">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ asset, supplierName }) => (
                <tr key={asset.id}>
                  <td>
                    {asset.name}
                    {asset.co2EmissionsGramsPerKm !== null && (
                      <div className="text-[11px] text-ink-faint">CO2 {asset.co2EmissionsGramsPerKm}g/km</div>
                    )}
                    {asset.description && (
                      <div className="text-[11px] text-ink-faint">{asset.description}</div>
                    )}
                  </td>
                  <td className="text-ink-muted">{label(asset.assetCategory)}</td>
                  <td className="num !text-left">{date(asset.purchaseDate)}</td>
                  <td>{supplierName ?? '—'}</td>
                  <td className="text-right num">{money(asset.baseCostMinor, asset.baseCurrency)}</td>
                  <td className="text-right num">
                    {money(asset.accumulatedDepreciationMinor, asset.baseCurrency)}
                    <div className="text-[10.5px] text-ink-faint">
                      {label(asset.depreciationMethod)}, {Math.round(asset.usefulLifeMonths / 12)}yr
                    </div>
                  </td>
                  <td className="text-right num">
                    {money(asset.baseCostMinor - asset.accumulatedDepreciationMinor, asset.baseCurrency)}
                  </td>
                  <td className="text-right num">
                    {money(asset.accumulatedCapitalAllowancesMinor, asset.baseCurrency)}
                    <div className="text-[10.5px] text-ink-faint">
                      {rate(asset.capitalAllowanceRateBasisPoints)} over {asset.capitalAllowanceYears}yr
                    </div>
                  </td>
                  <td>
                    <Badge tone={asset.status === 'active' ? 'positive'
                      : asset.status === 'pending_review' ? 'caution' : 'neutral'}>
                      {label(asset.status)}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>


      <Panel title="Register an acquisition" description="The purchase is posted first (an invoice, or a bank line
        classified to the asset account). Registering records what that cost is, so it can be depreciated and claimed.">
        <Disclosure summary="New asset" tone="accent">
          <ActionForm action={registerFixedAssetAction} submit="Register" resetOnSuccess>
            <div className="grid grid-cols-3 gap-3 max-w-3xl">
              <Field label="Name"><Input name="name" required /></Field>
              <Field label="Category">
                <Select name="assetCategory" defaultValue="computer_equipment">
                  {['computer_equipment', 'office_equipment', 'furniture_fittings', 'motor_vehicles', 'plant_machinery', 'farm_buildings', 'slurry_storage', 'other']
                    .map((c) => <option key={c} value={c}>{label(c)}</option>)}
                </Select>
              </Field>
              <Field label="Account the purchase was posted to">
                <Select name="accountId" required defaultValue="">
                  <option value="" disabled>Choose</option>
                  {costAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                </Select>
              </Field>
              <Field label="Purchased"><Input name="purchaseDate" type="date" required defaultValue={today} /></Field>
              <Field label="Cost (net of recoverable VAT)"><Input name="cost" required placeholder="0.00" /></Field>
              <Field label="Useful life (months)"><Input name="usefulLifeMonths" type="number" min="1" defaultValue="48" /></Field>
              <Field label="Car: CO2 g/km" help="From the registration certificate. It decides a car's capital allowances (TCA Part 11C).">
                <Input name="co2" type="number" min="0" />
              </Field>
              <Field label="Car: where the CO2 figure comes from"><Input name="co2Evidence" placeholder="Registration certificate" /></Field>
              <Field label="Description"><Input name="description" /></Field>
            </div>
          </ActionForm>
        </Disclosure>
        {cars.length > 0 && (
          <div className="mt-3">
            <Disclosure summary="Record a car's CO2 emissions">
              <ActionForm action={recordCarEmissionsAction} submit="Record" inline>
                <select name="assetId" required defaultValue="" className={small}>
                  <option value="" disabled>Car</option>
                  {cars.map(({ asset }) => <option key={asset.id} value={asset.id}>{asset.name}{asset.co2EmissionsGramsPerKm !== null ? ` (${asset.co2EmissionsGramsPerKm}g/km)` : ''}</option>)}
                </select>
                <Input name="co2" type="number" min="0" required placeholder="g/km" className={small} />
                <Input name="evidence" required placeholder="Registration certificate" className={small} />
                <Input name="reason" placeholder="Reason, if changing a figure" className={small} />
              </ActionForm>
            </Disclosure>
          </div>
        )}
        {held.length > 0 && (
          <div className="mt-3">
            <Disclosure summary="Transfer an asset to another account">
              <ActionForm action={transferFixedAssetAction} submit="Transfer" inline>
                <select name="assetId" required defaultValue="" className={small}>
                  <option value="" disabled>Asset</option>
                  {held.map(({ asset }) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
                </select>
                <select name="toAccountId" required defaultValue="" className={small}>
                  <option value="" disabled>To account</option>
                  {costAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                </select>
                <Input name="date" type="date" required defaultValue={today} className={small} />
                <Input name="reason" required placeholder="Why" className={small} />
              </ActionForm>
            </Disclosure>
          </div>
        )}
        <div className="mt-3">
          <ActionForm action={reconcileFixedAssetsAction} submit="Reconcile the register to the ledger" inline variant="secondary">
            <Input name="asOf" type="date" required defaultValue={today} className={small} />
          </ActionForm>
        </div>
      </Panel>
      <Panel
        title="Post depreciation"
        description="Depreciation is not posted automatically. Running this charges every
          period that is due up to the date you choose, and it can be run twice without
          double-charging — a period already posted is skipped."
      >
        <Disclosure summary="Run the depreciation charge" tone="accent">
          <div className="max-w-3xl">
            <ActionForm action={postDepreciationAction} submit="Post depreciation">
              <Field
                label="Post everything due up to"
                help="Each asset is charged monthly from the month after it was brought into
                  use. Capital allowances are a separate calculation and are never posted to
                  the books — they belong in the tax computation only."
              >
                <Input name="upTo" type="date"
                  defaultValue={new Date().toISOString().slice(0, 10)} />
              </Field>
            </ActionForm>
          </div>
        </Disclosure>
      </Panel>
    </Page>
  );
}
