import { activeCompany, companyContext, purchaseOrderList, supplierList } from '@/lib/queries';
import { Page, Panel, Badge, Empty, Field, Input, Select, Textarea, Disclosure } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { createPurchaseOrderAction, cancelPurchaseOrderAction } from '@/app/actions';
import { money, date, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

const LINE_ROWS = 5;

/**
 * Purchase orders (issue #411). An order posts nothing and claims no VAT; the
 * bills posted from the supplier's confirmed invoices are linked to it, and
 * what has been billed against it follows from them.
 */
export default async function PurchaseOrdersPage() {
  const company = activeCompany();
  if (!company) {
    return <Page title="Purchase orders"><Panel><Empty title="No company yet" /></Panel></Page>;
  }
  const { currency } = companyContext();
  const orders = purchaseOrderList();
  const suppliers = supplierList().map((s) => s.supplier).filter((s) => s.active);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page title="Purchase orders"
      subtitle="What you have asked suppliers for. An order posts nothing; each bill is linked to the order it was raised against.">
      <Panel title="Orders">
        {orders.length === 0 ? <Empty title="No purchase orders yet" /> : (
          <table className="ledger">
            <thead>
              <tr>
                <th className="w-20">Order</th><th className="w-28">Date</th><th>Supplier</th>
                <th className="w-28 text-right">Ordered</th><th className="w-28 text-right">Billed</th>
                <th className="w-28 text-right">Remaining</th><th className="w-28">Status</th><th className="w-56" />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className={o.status === 'cancelled' ? 'text-ink-faint' : ''}>
                  <td className="font-medium">{o.number}</td>
                  <td>{date(o.orderDate)}</td>
                  <td>
                    <a href={`/suppliers/${o.supplierId}`} className="hover:underline">{o.supplierName}</a>
                    {o.bills.length > 0 && (
                      <div className="text-[11.5px] text-ink-muted">
                        Bills: {o.bills.map((b, i) => (
                          <span key={b.invoiceId}>{i > 0 && ', '}<a href={`/invoices/${b.invoiceId}`} className="underline">{b.number ?? date(b.invoiceDate)}</a></span>
                        ))}
                      </div>
                    )}
                    {o.cancelReason && <div className="text-[11.5px]">Cancelled: {o.cancelReason}</div>}
                  </td>
                  <td className="num">{money(o.orderedMinor, o.currency)}</td>
                  <td className="num">{money(o.billedMinor, o.currency)}</td>
                  <td className="num">{money(o.remainingMinor, o.currency)}</td>
                  <td>
                    <Badge tone={o.billedMinor > o.orderedMinor ? 'negative' : o.status === 'billed' ? 'positive'
                      : o.status === 'part_billed' ? 'caution' : 'neutral'}>
                      {o.billedMinor > o.orderedMinor ? 'over-billed' : label(o.status)}
                    </Badge>
                  </td>
                  <td>
                    <div className="flex gap-2 items-start">
                      <a href={`/api/purchase-orders/${o.id}/pdf`}
                        className="px-2.5 py-1 rounded border border-line-strong text-[12px] font-medium bg-surface hover:bg-surface-sunken">PDF</a>
                      {(o.status === 'open' || o.status === 'part_billed') && (
                        <Disclosure summary="Cancel">
                          <ActionForm action={cancelPurchaseOrderAction} submit="Cancel order" variant="secondary"
                            extra={{ purchaseOrderId: o.id }}>
                            <Field label="Why"><Input name="reason" required placeholder="Supplier could not deliver" /></Field>
                          </ActionForm>
                        </Disclosure>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="New purchase order">
        <Disclosure summary="Raise an order" tone="accent">
          <ActionForm action={createPurchaseOrderAction} submit="Raise order" resetOnSuccess>
            <div className="grid grid-cols-3 gap-3 max-w-4xl">
              <Field label="Supplier">
                <Select name="supplierId" required defaultValue="">
                  <option value="" disabled>Choose a supplier</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </Field>
              <Field label="Order date"><Input name="orderDate" type="date" required defaultValue={today} /></Field>
              <Field label="Wanted by (optional)"><Input name="expectedDate" type="date" /></Field>
            </div>
            <table className="ledger mt-3 max-w-4xl">
              <thead>
                <tr><th>Description</th><th className="w-28">Quantity</th><th className="w-36">{`Net (${currency})`}</th></tr>
              </thead>
              <tbody>
                {Array.from({ length: LINE_ROWS }, (_, i) => (
                  <tr key={i}>
                    <td><Input name="description" required={i === 0} placeholder={i === 0 ? 'Printer toner' : ''} /></td>
                    <td><Input name="quantity" placeholder="1" /></td>
                    <td><Input name="net" required={i === 0} placeholder="0.00" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="max-w-4xl mt-3">
              <Field label="Notes (printed on the order)"><Textarea name="notes" rows={2} /></Field>
            </div>
            <p className="text-[12px] text-ink-muted mt-2">
              Net is the line total, excluding VAT. Blank lines are skipped. An order claims no VAT:
              that comes only from the supplier&apos;s confirmed invoice.
            </p>
          </ActionForm>
        </Disclosure>
      </Panel>
    </Page>
  );
}
