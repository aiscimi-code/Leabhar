import { constructionPage } from '@/lib/constructionQueries';
import { Page, Panel, Badge, Empty, Input, Disclosure } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import {
  createProjectAction, createSiteAction, registerSubcontractorAction, recordRctContractAction, notifyRctPaymentAction,
  deductionAuthorisationAction, payRctPaymentAction, fileRctReturnAction, payRctReturnAction, reconcileRctAction,
} from '@/app/construction-actions';
import { money, date } from '@/lib/format';

export const dynamic = 'force-dynamic';

/** Construction and relevant contracts tax (EPIC 26): projects, sites, subcontractors, payments and returns. */
export default async function ConstructionPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const today = new Date().toISOString().slice(0, 10);
  const period = (await searchParams).period || today.slice(0, 7);
  const data = constructionPage(period);
  const cur = data.company.baseCurrency;
  const small = 'border border-line-strong rounded px-2 py-1 text-[12px]';
  const subName = new Map(data.subcontractors.map((s) => [s.id, s.supplierName]));
  const contractLabel = new Map(data.contracts.map((c) => [c.id, `${subName.get(c.subcontractorId)}: ${c.description}`]));
  const awaitingDa = data.payments.filter((p) => !p.deductionAuthorisationNumber);
  const awaitingPayment = data.payments.filter((p) => p.deductionAuthorisationNumber && !p.paymentId);

  return (
    <Page
      title="Construction and RCT"
      subtitle="The rate and the tax on each payment are Revenue's, from its deduction authorisation: record them as issued,
        and the payment settles the subcontractor's invoice net of the tax."
      actions={<form className="flex gap-2"><Input name="period" type="month" defaultValue={period} className={small} /><button className={small}>Period</button></form>}
    >
      <Panel title={`RCT return, ${period}`} description="The relevant payments made in the period and the tax deducted (s.530K).">
        {data.period.payments.length === 0 ? <Empty title="No relevant payments this period" detail="Payments appear here once made." /> : (
          <table className="ledger">
            <thead><tr><th className="w-24">Paid</th><th>Subcontractor</th><th className="w-28">Authorisation</th><th className="w-16 text-right">Rate</th><th className="w-28 text-right">Gross</th><th className="w-28 text-right">Tax</th><th className="w-28 text-right">Net</th></tr></thead>
            <tbody>
              {data.period.payments.map((p) => (
                <tr key={p.id}>
                  <td>{date(p.paidOn)}</td><td>{p.supplierName}</td><td className="font-mono text-[12px]">{p.deductionAuthorisationNumber}</td>
                  <td className="text-right">{(p.rateBasisPoints ?? 0) / 100}%</td>
                  <td className="text-right tabular-nums">{money(p.grossMinor, cur)}</td>
                  <td className="text-right tabular-nums">{money(p.rctMinor, cur)}</td>
                  <td className="text-right tabular-nums">{money(p.netMinor, cur)}</td>
                </tr>
              ))}
              <tr className="font-medium"><td colSpan={4}>Total</td><td className="text-right tabular-nums">{money(data.period.grossMinor, cur)}</td><td className="text-right tabular-nums">{money(data.period.liabilityMinor, cur)}</td><td /></tr>
            </tbody>
          </table>
        )}
        <div className="mt-3 grid gap-3">
          {data.period.return ? (
            <p className="text-[13px]">
              Return recorded {date(data.period.return.filedOn)}: {money(data.period.return.summaryLiabilityMinor, cur)}
              {data.period.return.summaryLiabilityMinor !== data.period.return.booksLiabilityMinor && <> <Badge tone="negative">books {money(data.period.return.booksLiabilityMinor, cur)}</Badge></>}
              {data.period.return.paidOn ? <> · paid {date(data.period.return.paidOn)}</> : null}
            </p>
          ) : (
            <ActionForm action={fileRctReturnAction} submit="Record the return" inline>
              <input type="hidden" name="period" value={period} />
              <Input name="summary" required placeholder="Deduction summary liability" className={small} />
              <label className="text-[12px] flex items-center gap-1"><input type="checkbox" name="amended" /> Amended</label>
              <Input name="filedOn" type="date" required defaultValue={today} className={small} />
            </ActionForm>
          )}
          {data.period.return && !data.period.return.paidOn && (
            <ActionForm action={payRctReturnAction} submit="Record the payment to Revenue" inline>
              <input type="hidden" name="period" value={period} />
              <Input name="date" type="date" defaultValue={today} className={small} />
              <Input name="bankTransactionId" placeholder="or a bank line id" className={small} />
            </ActionForm>
          )}
          <ActionForm action={reconcileRctAction} submit="Reconcile RCT" inline variant="secondary">
            <Input name="asOf" type="date" required defaultValue={today} className={small} />
          </ActionForm>
        </div>
      </Panel>

      <Panel title="Payments to subcontractors" description="Notify, record the deduction authorisation, then pay.">
        <div className="grid gap-3">
          {data.contracts.length > 0 && (
            <Disclosure summary="Notify a payment (s.530C)">
              <ActionForm action={notifyRctPaymentAction} submit="Record notification" inline>
                <select name="contractId" required defaultValue="" className={small}>
                  <option value="" disabled>Contract</option>
                  {data.contracts.map((c) => <option key={c.id} value={c.id}>{contractLabel.get(c.id)}</option>)}
                </select>
                <select name="invoiceId" required defaultValue="" className={small}>
                  <option value="" disabled>Subcontractor&apos;s invoice</option>
                  {data.openInvoices.map((i) => <option key={i.id} value={i.id}>{i.invoiceNumber ?? i.id} ({date(i.invoiceDate)}): {money(i.outstandingMinor, i.currency)}</option>)}
                </select>
                <Input name="gross" required placeholder="Gross payment" className={small} />
                <Input name="notifiedOn" type="date" required defaultValue={today} className={small} />
              </ActionForm>
            </Disclosure>
          )}
          {awaitingDa.map((p) => (
            <ActionForm key={p.id} action={deductionAuthorisationAction} submit="Record authorisation" inline>
              <span className="text-[12px]">{contractLabel.get(p.contractId)} · {money(p.grossMinor, cur)} notified {date(p.notifiedOn)}</span>
              <input type="hidden" name="rctPaymentId" value={p.id} />
              <Input name="number" required placeholder="DA number" className={small} />
              <select name="rate" required defaultValue="20" className={small}><option value="0">0%</option><option value="20">20%</option><option value="35">35%</option></select>
              <Input name="tax" required placeholder="Tax specified" className={small} />
            </ActionForm>
          ))}
          {awaitingPayment.map((p) => (
            <ActionForm key={p.id} action={payRctPaymentAction} submit={`Pay ${money(p.grossMinor - (p.rctMinor ?? 0), cur)}`} inline>
              <span className="text-[12px]">{contractLabel.get(p.contractId)} · {p.deductionAuthorisationNumber}: tax {money(p.rctMinor, cur)}</span>
              <input type="hidden" name="rctPaymentId" value={p.id} />
              <Input name="date" type="date" defaultValue={today} className={small} />
              <Input name="bankTransactionId" placeholder="or a bank line id" className={small} />
            </ActionForm>
          ))}
        </div>
      </Panel>

      <Panel title="Subcontractors and contracts">
        {data.contracts.length === 0 ? <Empty title="No relevant contracts" detail="Register the subcontractor, then record the contract and its notification." /> : (
          <table className="ledger">
            <thead><tr><th>Contract</th><th className="w-28">Starts</th><th className="w-28 text-right">Estimated</th><th className="w-32">Notified</th></tr></thead>
            <tbody>
              {data.contracts.map((c) => (
                <tr key={c.id}><td>{contractLabel.get(c.id)}{c.labourOnly && <> <Badge>labour only</Badge></>}</td><td>{date(c.startsOn)}</td>
                  <td className="text-right tabular-nums">{money(c.estimatedValueMinor, cur)}</td>
                  <td>{c.notifiedOn ? `${date(c.notifiedOn)} · ${c.revenueContractId}` : <Badge tone="caution">not notified</Badge>}</td></tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mt-3 grid gap-3">
          <Disclosure summary="Register a subcontractor">
            <ActionForm action={registerSubcontractorAction} submit="Register" inline>
              <select name="supplierId" required defaultValue="" className={small}>
                <option value="" disabled>Supplier</option>
                {data.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <Input name="taxReference" required placeholder="Tax reference" className={small} />
              <Input name="identityEvidence" required placeholder="Identity evidence seen" className={small} />
              <Input name="identityCheckedOn" type="date" required defaultValue={today} className={small} />
              <label className="text-[12px] flex items-center gap-1"><input type="checkbox" name="notEmployee" /> Not an employee</label>
            </ActionForm>
          </Disclosure>
          {data.subcontractors.length > 0 && data.sites.length > 0 && (
            <Disclosure summary="Record a relevant contract">
              <ActionForm action={recordRctContractAction} submit="Record" inline>
                <select name="subcontractorId" required defaultValue="" className={small}>
                  <option value="" disabled>Subcontractor</option>
                  {data.subcontractors.map((s) => <option key={s.id} value={s.id}>{s.supplierName}</option>)}
                </select>
                <select name="siteId" required defaultValue="" className={small}>
                  <option value="" disabled>Site</option>
                  {data.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
                <select name="projectId" defaultValue="" className={small}>
                  <option value="">Project</option>
                  {data.projects.map((p) => <option key={p.id} value={p.id}>{p.code} {p.name}</option>)}
                </select>
                <Input name="description" required placeholder="Work" className={small} />
                <Input name="value" required placeholder="Estimated value" className={small} />
                <Input name="startsOn" type="date" required className={small} />
                <label className="text-[12px] flex items-center gap-1"><input type="checkbox" name="labourOnly" /> Labour only</label>
                <Input name="notifiedOn" type="date" className={small} />
                <Input name="revenueContractId" placeholder="Revenue contract ID" className={small} />
              </ActionForm>
            </Disclosure>
          )}
        </div>
      </Panel>

      <Panel title="Projects and sites">
        {data.projects.length === 0 ? <Empty title="No projects" detail="Add a project, and the sites it is carried out at." /> : (
          <ul className="text-[13px] space-y-1">
            {data.projects.map((p) => (
              <li key={p.id}><span className="font-mono">{p.code}</span> {p.name} <Badge>{p.status}</Badge>
                {' '}{data.sites.filter((s) => s.projectId === p.id).map((s) => s.name).join(', ')}</li>
            ))}
          </ul>
        )}
        <div className="mt-3 grid gap-3">
          <Disclosure summary="Add a project">
            <ActionForm action={createProjectAction} submit="Add" inline>
              <Input name="code" required placeholder="Code" className={small} />
              <Input name="name" required placeholder="Name" className={small} />
              <Input name="startsOn" type="date" required defaultValue={today} className={small} />
            </ActionForm>
          </Disclosure>
          <Disclosure summary="Add a site">
            <ActionForm action={createSiteAction} submit="Add" inline>
              <Input name="name" required placeholder="Name" className={small} />
              <Input name="address" required placeholder="Address" className={small} />
              <Input name="eircode" placeholder="Eircode" className={small} />
              <select name="projectId" defaultValue="" className={small}>
                <option value="">Project</option>
                {data.projects.map((p) => <option key={p.id} value={p.id}>{p.code} {p.name}</option>)}
              </select>
            </ActionForm>
          </Disclosure>
        </div>
      </Panel>
    </Page>
  );
}
