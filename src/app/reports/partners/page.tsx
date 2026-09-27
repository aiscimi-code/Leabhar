import { getDb } from '@/db';
import { companyContext } from '@/lib/queries';
import { Page, Panel, Empty, LinkButton } from '@/components/primitives';
import { PartnerAllocationPanel, Form1FirmsPanel } from '@/components/PartnershipPanels';
import { partnerAllocationStatement, form1Firms, PartnershipReportError } from '@/domain/partnerships/report';
import { asIsoDate } from '@/domain/dates';
import { date } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * The partnership's reports (issue #314): the statement of how a period's
 * result and the partners' balances stand per partner, and the Form 1
 * (Firms) statement the precedent partner files (TCA s.1007).
 */
export default async function PartnersReportPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const { company, financialYears, currentYear } = companyContext();

  if (company.entityType !== 'partnership') {
    return (
      <Page title="Partners" subtitle="Partnership reports">
        <Panel>
          <Empty
            title="These books are not a partnership's"
            detail={`Partner allocation and Form 1 (Firms) belong to a partnership. These books are for a ${company.entityType === 'sole_trader' ? 'sole trader' : 'company'}.`}
          />
        </Panel>
      </Page>
    );
  }

  const year = financialYears.find((y) => y.id === params['year']) ?? currentYear;
  if (!year) {
    return (
      <Page title="Partners" subtitle="Partnership reports">
        <Panel><Empty title="No financial year configured" /></Panel>
      </Page>
    );
  }

  const from = asIsoDate(year.startDate);
  const to = asIsoDate(year.endDate);
  const statement = partnerAllocationStatement(getDb(), { companyId: company.id, from, to });

  let form1: ReturnType<typeof form1Firms> | null = null;
  let form1Error: string | null = null;
  try {
    form1 = form1Firms(getDb(), { companyId: company.id, year: Number(to.slice(0, 4)) });
  } catch (e) {
    form1Error = e instanceof PartnershipReportError ? e.message : null;
  }

  return (
    <Page
      title="Partners"
      subtitle={`${statement.firmName} · ${date(from)} to ${date(to)}`}
      actions={
        <>
          <form method="get" className="flex items-center gap-1.5">
            <select name="year" defaultValue={year.id}
              className="border border-line-strong rounded px-2 py-1 text-[12px]">
              {financialYears.map((y) => <option key={y.id} value={y.id}>{y.name}</option>)}
            </select>
            <button type="submit"
              className="px-2.5 py-1 rounded border border-line-strong bg-surface text-[12px] font-medium">
              Show
            </button>
          </form>
          <a href={`/api/export/year-end?from=${from}&to=${to}`}
            className="inline-block px-2.5 py-1 rounded border border-accent bg-accent
              text-white text-[12px] font-medium">
            Export pack
          </a>
          <LinkButton href="/reports/year-end">Year-end pack</LinkButton>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4 items-start">
        <PartnerAllocationPanel statement={statement} currency={company.baseCurrency} />
        {form1
          ? <Form1FirmsPanel form1={form1} currency={company.baseCurrency} />
          : (
            <Panel title={`Form 1 (Firms) ${Number(to.slice(0, 4))}`} tone="negative">
              <div className="px-4 py-3 text-negative text-[12px] leading-snug">
                The Form 1 (Firms) statement could not be prepared for this year.
                {form1Error ? ` ${form1Error}` : ''}
              </div>
            </Panel>
          )}
      </div>
    </Page>
  );
}
