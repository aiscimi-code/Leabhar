import { fixedAssetList } from '@/lib/queries';
import { Page, Panel, Badge, Help, Empty } from '@/components/primitives';
import { money, date, rate, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** Fixed asset register (README §29). */
export default function AssetsPage() {
  const rows = fixedAssetList();

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
    </Page>
  );
}
