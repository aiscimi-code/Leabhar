import { inventoryPage } from '@/lib/inventoryQueries';
import { Page, Panel, Badge, Help, Empty, Input, Disclosure } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import {
  createItemAction, createLocationAction, recordMovementAction, transferStockAction, reverseMovementAction, stocktakeAction,
  postClosingStockAction,
} from '@/app/inventory-actions';
import { money, date, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

const qty = (milli: number) => (milli / 1000).toLocaleString('en-IE', { maximumFractionDigits: 3 });

/** Inventory (EPIC 23): items, locations, stock movements, stocktakes, valuation and closing stock. */
export default async function InventoryPage({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  const today = new Date().toISOString().slice(0, 10);
  const asOf = (await searchParams).asOf || today;
  const data = inventoryPage(asOf);
  const stockItems = data.items.filter((i) => i.kind === 'stock' && i.active);
  const locations = data.locations.filter((l) => l.active);
  const itemCode = new Map(data.items.map((i) => [i.id, i.code]));
  const locationCode = new Map(data.locations.map((l) => [l.id, l.code]));
  const small = 'border border-line-strong rounded px-2 py-1 text-[12px]';
  const itemSelect = (
    <select name="itemId" required defaultValue="" className={small}>
      <option value="" disabled>Item</option>
      {stockItems.map((i) => <option key={i.id} value={i.id}>{i.code} — {i.name}</option>)}
    </select>
  );
  const locationSelect = (name = 'locationId', placeholder = 'Location') => (
    <select name={name} required defaultValue="" className={small}>
      <option value="" disabled>{placeholder}</option>
      {locations.map((l) => <option key={l.id} value={l.id}>{l.code} — {l.name}</option>)}
    </select>
  );
  const lineSelect = (lines: typeof data.purchaseLines, placeholder: string) => (
    <select name="invoiceLineId" required defaultValue="" className={small}>
      <option value="" disabled>{placeholder}</option>
      {lines.map((l) => <option key={l.id} value={l.id}>{l.invoiceNumber ?? '—'} ({date(l.invoiceDate)}): {l.description} × {qty(l.quantityMilli)}</option>)}
    </select>
  );

  return (
    <Page
      title="Inventory"
      subtitle="Purchases stay in cost of sales all year; the closing stock journal moves what is on hand to the
        balance sheet at the date you choose. Behind it every movement of every stock item is recorded, and costed
        by FIFO or weighted average."
    >
      <Panel title="Items" description="A stock item is counted and valued. A non-stock product or a service is listed so invoices can name it.">
        {data.items.length === 0 ? (
          <Empty title="No items" detail="Add the products you buy and sell." />
        ) : (
          <table className="ledger">
            <thead><tr><th className="w-24">Code</th><th>Name</th><th className="w-24">Kind</th><th className="w-20">Unit</th><th className="w-36">Costing</th></tr></thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.id}>
                  <td className="font-mono">{i.code}</td>
                  <td>{i.name} {!i.active && <Badge>inactive</Badge>}</td>
                  <td>{label(i.kind)}</td>
                  <td>{i.unit}</td>
                  <td>{i.kind === 'stock' ? (i.costingMethod === 'fifo' ? 'FIFO' : 'Weighted average') : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-3 grid gap-3">
          <Disclosure summary="Add an item">
            <ActionForm action={createItemAction} submit="Add" inline>
              <Input name="code" required placeholder="Code" className={small} />
              <Input name="name" required placeholder="Name" className={small} />
              <select name="kind" required defaultValue="stock" className={small}>
                <option value="stock">Stock item</option><option value="non_stock">Non-stock product</option><option value="service">Service</option>
              </select>
              <Input name="unit" required placeholder="Unit (each, kg)" className={small} />
              <select name="costingMethod" defaultValue="fifo" className={small}>
                <option value="fifo">FIFO</option><option value="weighted_average">Weighted average</option>
              </select>
            </ActionForm>
          </Disclosure>
          <Disclosure summary={`Locations (${data.locations.map((l) => l.code).join(', ') || 'none yet'})`}>
            <ActionForm action={createLocationAction} submit="Add location" inline>
              <Input name="code" required placeholder="Code" className={small} />
              <Input name="name" required placeholder="Warehouse, shop, van" className={small} />
            </ActionForm>
          </Disclosure>
        </div>
      </Panel>

      <Panel
        title={`Stock on hand at ${date(asOf)}`}
        description="Quantity and value by item and location, at cost."
        actions={<form className="flex gap-2"><Input name="asOf" type="date" defaultValue={asOf} className={small} /><button className={small}>Show</button></form>}
      >
        {data.valuation.lines.length === 0 ? (
          <Empty title="Nothing on hand" detail="Record opening stock or receive a purchase." />
        ) : (
          <table className="ledger">
            <thead><tr><th className="w-24">Item</th><th>Name</th><th className="w-24">Location</th><th className="w-28 text-right">Quantity</th><th className="w-32">Method</th><th className="w-28 text-right">Value</th></tr></thead>
            <tbody>
              {data.valuation.lines.map((l) => (
                <tr key={`${l.itemId}-${l.locationId}`}>
                  <td className="font-mono">{l.code}</td><td>{l.name}</td><td>{l.locationCode}</td>
                  <td className="text-right tabular-nums">{qty(l.quantityMilli)} {l.unit}</td>
                  <td>{l.method === 'fifo' ? 'FIFO' : 'Weighted average'}</td>
                  <td className="text-right tabular-nums">{money(l.valueMinor, data.company.baseCurrency)}</td>
                </tr>
              ))}
              <tr className="font-medium"><td colSpan={5}>Total</td><td className="text-right tabular-nums">{money(data.valuation.totalMinor, data.company.baseCurrency)}</td></tr>
            </tbody>
          </table>
        )}
        <p className="mt-2 text-[12px] text-ink-muted">{data.valuation.note}</p>
      </Panel>

      {stockItems.length > 0 && locations.length > 0 && (
        <Panel title="Record a movement" description="Every movement is kept. A mistake is corrected by reversing it, never by editing it.">
          <div className="grid gap-3">
            <Disclosure summary="Receive stock against a purchase invoice line">
              <ActionForm action={recordMovementAction} submit="Receive" inline>
                <input type="hidden" name="kind" value="purchase" />
                {itemSelect}{locationSelect()}{lineSelect(data.purchaseLines, 'Purchase invoice line')}
                <Input name="date" type="date" required defaultValue={today} className={small} />
                <Input name="quantity" placeholder="Quantity (blank: the rest of the line)" className={small} />
              </ActionForm>
            </Disclosure>
            <Disclosure summary="Issue stock against a sales invoice line">
              <ActionForm action={recordMovementAction} submit="Issue" inline>
                <input type="hidden" name="kind" value="sale" />
                {itemSelect}{locationSelect()}{lineSelect(data.salesLines, 'Sales invoice line')}
                <Input name="date" type="date" required defaultValue={today} className={small} />
                <Input name="quantity" placeholder="Quantity (blank: the rest of the line)" className={small} />
              </ActionForm>
            </Disclosure>
            <Disclosure summary="Opening stock, damaged stock, an adjustment or a return">
              <ActionForm action={recordMovementAction} submit="Record" inline>
                <select name="kind" required defaultValue="" className={small}>
                  <option value="" disabled>Kind</option>
                  <option value="opening">Opening stock</option>
                  <option value="damaged">Damaged or lost</option>
                  <option value="adjustment_in">Adjustment up</option>
                  <option value="adjustment_out">Adjustment down</option>
                  <option value="customer_return">Customer return</option>
                  <option value="supplier_return">Supplier return</option>
                </select>
                {itemSelect}{locationSelect()}
                <Input name="date" type="date" required defaultValue={today} className={small} />
                <Input name="quantity" required placeholder="Quantity" className={small} />
                <Input name="unitCost" placeholder="Unit cost (opening, adjustment up)" className={small} />
                <Input name="relatedMovementId" placeholder="Sale or receipt movement (returns)" className={small} />
                <Input name="reason" placeholder="Reason" className={small} />
              </ActionForm>
            </Disclosure>
            {locations.length > 1 && (
              <Disclosure summary="Transfer between locations">
                <ActionForm action={transferStockAction} submit="Transfer" inline>
                  {itemSelect}{locationSelect('fromLocationId', 'From')}{locationSelect('toLocationId', 'To')}
                  <Input name="date" type="date" required defaultValue={today} className={small} />
                  <Input name="quantity" required placeholder="Quantity" className={small} />
                </ActionForm>
              </Disclosure>
            )}
            <Disclosure summary="Stocktake">
              <ActionForm action={stocktakeAction} submit="Post the count">
                <div className="flex flex-wrap gap-2 mb-2">
                  {locationSelect()}
                  <Input name="date" type="date" required defaultValue={today} className={small} />
                  <Input name="countedBy" required placeholder="Counted by" className={small} />
                </div>
                <table className="ledger">
                  <thead><tr><th>Item</th><th className="w-32">Counted</th><th className="w-40">Unit cost <Help>Only for a count over book: what the extra stock is valued at.</Help></th></tr></thead>
                  <tbody>
                    {stockItems.map((i) => (
                      <tr key={i.id}>
                        <td>{i.code} — {i.name}<input type="hidden" name="countItemId" value={i.id} /></td>
                        <td><Input name="countQuantity" placeholder={i.unit} className={small} /></td>
                        <td><Input name="countUnitCost" placeholder="0.00" className={small} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ActionForm>
            </Disclosure>
          </div>
        </Panel>
      )}

      <Panel
        title="Closing stock"
        description="One journal between Stock on hand and each cost-of-sales account, for the change in value since the last
          closing stock (or the opening stock). The stock account must hold exactly what was last booked there first."
      >
        {data.closingError ? (
          <p className="text-[13px]">{data.closingError}</p>
        ) : data.closing && (
          <>
            <table className="ledger">
              <thead><tr><th>Account</th><th className="w-32 text-right">Ledger</th><th className="w-32 text-right">Last booked</th><th className="w-32 text-right">Difference</th></tr></thead>
              <tbody>
                {data.closing.stockAccounts.map((a) => (
                  <tr key={a.accountId}>
                    <td>{a.code} {a.name}</td>
                    <td className="text-right tabular-nums">{money(a.ledgerMinor, data.company.baseCurrency)}</td>
                    <td className="text-right tabular-nums">{money(a.bookedMinor, data.company.baseCurrency)}</td>
                    <td className="text-right tabular-nums">{a.differenceMinor === 0 ? <Badge tone="positive">agrees</Badge> : <Badge tone="negative">{money(a.differenceMinor, data.company.baseCurrency)}</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[13px]">
              Valued at {money(data.closing.valuation.totalMinor, data.company.baseCurrency)} on {date(asOf)};
              the journal moves {money(data.closing.pairs.reduce((s, p) => s + p.changeMinor, 0), data.company.baseCurrency)}.
            </p>
            <div className="mt-2">
              <ActionForm action={postClosingStockAction} submit={`Post closing stock at ${date(asOf)}`} inline>
                <input type="hidden" name="date" value={asOf} />
              </ActionForm>
            </div>
          </>
        )}
        {data.valuations.length > 0 && (
          <table className="ledger mt-3">
            <thead><tr><th className="w-28">Date</th><th className="text-right">Valued at</th><th className="w-32">Posted by</th></tr></thead>
            <tbody>
              {data.valuations.map((v) => (
                <tr key={v.id}><td>{date(v.valuationDate)}</td><td className="text-right tabular-nums">{money(v.valueMinor, data.company.baseCurrency)}</td><td>{v.postedBy}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Movements" description="Newest first. The value is what the movement did to its location's stock, by replay.">
        {data.movements.length === 0 ? <Empty title="No movements" detail="Nothing has moved yet." /> : (
          <table className="ledger">
            <thead><tr><th className="w-24">Date</th><th className="w-20">Item</th><th className="w-20">Location</th><th className="w-32">Kind</th><th className="w-24 text-right">Quantity</th><th className="w-28 text-right">Value</th><th>Reason</th><th className="w-56">Reverse</th></tr></thead>
            <tbody>
              {data.movements.map((m) => (
                <tr key={m.id}>
                  <td>{date(m.movementDate)}</td>
                  <td className="font-mono">{itemCode.get(m.itemId)}</td>
                  <td>{locationCode.get(m.locationId)}</td>
                  <td title={m.id}>{label(m.kind)}</td>
                  <td className="text-right tabular-nums">{qty(m.quantityMilli)}</td>
                  <td className="text-right tabular-nums">{m.valueMinor === null ? '—' : money(m.valueMinor, data.company.baseCurrency)}</td>
                  <td className="text-[12px]">{m.reason}</td>
                  <td>
                    {m.kind !== 'reversal' && !m.kind.startsWith('transfer') && (
                      <ActionForm action={reverseMovementAction} submit="Reverse" inline variant="secondary">
                        <input type="hidden" name="movementId" value={m.id} />
                        <input type="hidden" name="date" value={today} />
                        <Input name="reason" required placeholder="Why" className={small} />
                      </ActionForm>
                    )}
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
