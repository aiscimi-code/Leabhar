import { projectsPage } from '@/lib/projectQueries';
import { Page, Panel, Badge, Empty, Input, Disclosure } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { createJobAction, allocateToProjectAction, setProjectBudgetAction, setOverheadRateAction } from '@/app/projects-actions';
import { money, date, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

const CATEGORIES = ['income', 'labour', 'materials', 'contractors', 'other_direct', 'overheads'] as const;

/** Projects and job costing (EPIC 27): margin and profitability, budget against actual, and WIP. */
export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const today = new Date().toISOString().slice(0, 10);
  const year = Number((await searchParams).year) || Number(today.slice(0, 4));
  const data = projectsPage(year, today);
  const cur = data.company.baseCurrency;
  const small = 'border border-line-strong rounded px-2 py-1 text-[12px]';
  const projectSelect = (
    <select name="projectId" required defaultValue="" className={small}>
      <option value="" disabled>Project</option>
      {data.projects.map((p) => <option key={p.id} value={p.id}>{p.code} {p.name}</option>)}
    </select>
  );
  const pct = (bp: number | null) => (bp === null ? '—' : `${(bp / 100).toFixed(1)}%`);

  return (
    <Page
      title="Projects"
      subtitle="Income and costs are shares of posted lines, allocated to a project and job by category. Budgets and overhead
        rates are kept from the date they apply. Nothing here posts."
      actions={<form className="flex gap-2"><Input name="year" type="number" defaultValue={year} className={small} /><button className={small}>Year</button></form>}
    >
      <Panel title={`Profitability, ${year}`}>
        {data.projects.length === 0 ? <Empty title="No projects" detail="Add a project on the construction screen, or by the CLI." /> : (
          <table className="ledger">
            <thead><tr><th>Project</th><th className="w-28 text-right">Income</th><th className="w-28 text-right">Direct costs</th><th className="w-28 text-right">Gross margin</th><th className="w-28 text-right">Overheads</th><th className="w-28 text-right">Net margin</th><th className="w-20 text-right">Margin</th><th className="w-28 text-right">Budget income</th></tr></thead>
            <tbody>
              {data.profitability.projects.map((r) => (
                <tr key={r.project.id}>
                  <td>{r.project.code} {r.project.name} {r.project.status !== 'active' && <Badge>{r.project.status}</Badge>}</td>
                  <td className="text-right tabular-nums">{money(r.actual.income, cur)}</td>
                  <td className="text-right tabular-nums">{money(r.directCostsMinor, cur)}</td>
                  <td className="text-right tabular-nums">{money(r.grossMarginMinor, cur)}</td>
                  <td className="text-right tabular-nums" title={r.absorbedOverheadsMinor !== null ? 'Absorbed at the project rate' : 'Allocated'}>{money(r.overheadsChargedMinor, cur)}</td>
                  <td className="text-right tabular-nums font-medium">{money(r.netMarginMinor, cur)}</td>
                  <td className="text-right">{pct(r.marginBasisPoints)}</td>
                  <td className="text-right tabular-nums">{r.budget.income === undefined ? '—' : money(r.budget.income, cur)}</td>
                </tr>
              ))}
              <tr className="text-ink-muted"><td>Not allocated to a project</td><td className="text-right tabular-nums">{money(data.profitability.unallocated.incomeMinor, cur)}</td>
                <td className="text-right tabular-nums">{money(data.profitability.unallocated.costsMinor, cur)}</td><td colSpan={5} /></tr>
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title={`Work in progress at ${date(data.wip.asOf)}`} description={data.wip.method}>
        {data.wip.lines.length === 0 ? <Empty title="No active projects" detail="Nothing is in progress." /> : (
          <table className="ledger">
            <thead><tr><th>Project</th><th className="w-32 text-right">Costs to date</th><th className="w-32 text-right">Billed to date</th><th className="w-24 text-right">Cost ratio</th><th className="w-28 text-right">WIP</th></tr></thead>
            <tbody>
              {data.wip.lines.map((l) => (
                <tr key={l.project.id}>
                  <td>{l.project.code} {l.project.name}{l.finding && <div className="text-[12px] text-ink-muted">{l.finding}</div>}</td>
                  <td className="text-right tabular-nums">{money(l.directCostsToDateMinor, cur)}</td>
                  <td className="text-right tabular-nums">{money(l.billedToDateMinor, cur)}</td>
                  <td className="text-right">{pct(l.budgetCostRatioBasisPoints)}</td>
                  <td className="text-right tabular-nums">{l.wipMinor === null ? '—' : money(l.wipMinor, cur)}</td>
                </tr>
              ))}
              <tr className="font-medium"><td colSpan={4}>Total</td><td className="text-right tabular-nums">{money(data.wip.totalMinor, cur)}</td></tr>
            </tbody>
          </table>
        )}
      </Panel>

      {data.projects.length > 0 && (
        <Panel title="Allocate, budget and set rates">
          <div className="grid gap-3">
            {data.lines.length > 0 && (
              <Disclosure summary="Allocate a posted line to a project">
                <ActionForm action={allocateToProjectAction} submit="Allocate" inline>
                  <select name="journalLineId" required defaultValue="" className={small}>
                    <option value="" disabled>Posted line</option>
                    {data.lines.map((l) => (
                      <option key={l.id} value={l.id}>{date(l.entryDate)} {l.accountCode} {l.narrative}: {money(l.accountType === 'income' ? l.credit - l.debit : l.debit - l.credit, cur)}
                        {l.allocatedBasisPoints ? ` (${(l.allocatedBasisPoints / 100).toFixed(2)}% allocated)` : ''}</option>
                    ))}
                  </select>
                  {projectSelect}
                  <select name="jobId" defaultValue="" className={small}>
                    <option value="">No job</option>
                    {data.jobs.map((j) => <option key={j.id} value={j.id}>{data.projects.find((p) => p.id === j.projectId)?.code}/{j.code} {j.name}</option>)}
                  </select>
                  <select name="category" required defaultValue="labour" className={small}>{CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select>
                  <Input name="percent" required defaultValue="100" className={small} />
                </ActionForm>
              </Disclosure>
            )}
            <Disclosure summary="Add a job">
              <ActionForm action={createJobAction} submit="Add" inline>
                {projectSelect}
                <Input name="code" required placeholder="Code" className={small} />
                <Input name="name" required placeholder="Name" className={small} />
              </ActionForm>
            </Disclosure>
            <Disclosure summary="Set or revise a budget">
              <ActionForm action={setProjectBudgetAction} submit="Record" inline>
                {projectSelect}
                <select name="category" required defaultValue="income" className={small}>{CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select>
                <Input name="amount" required placeholder="Amount" className={small} />
                <Input name="effectiveFrom" type="date" required defaultValue={today} className={small} />
                <Input name="note" placeholder="Why (a variation, say)" className={small} />
              </ActionForm>
            </Disclosure>
            <Disclosure summary="Set an overhead absorption rate">
              <ActionForm action={setOverheadRateAction} submit="Record" inline>
                {projectSelect}
                <Input name="percent" required placeholder="% of direct costs" className={small} />
                <Input name="effectiveFrom" type="date" required defaultValue={today} className={small} />
                <Input name="basis" required placeholder="How the rate was worked out" className={small} />
              </ActionForm>
            </Disclosure>
          </div>
        </Panel>
      )}
    </Page>
  );
}
