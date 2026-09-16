import { activeCompany, searchEverything } from '@/lib/queries';
import { Page, Panel, Badge, Empty, Input, Button } from '@/components/primitives';
import { money, date, label } from '@/lib/format';
import type { SearchEntityType } from '@/domain/search/search';

export const dynamic = 'force-dynamic';

const TYPE_LABELS: Record<SearchEntityType, string> = {
  bank_transaction: 'Transaction',
  document: 'Document',
  supplier: 'Supplier',
  customer: 'Customer',
  invoice: 'Invoice',
  account: 'Account',
  rule: 'Rule',
  journal_entry: 'Journal entry',
  fixed_asset: 'Fixed asset',
  vat_treatment: 'VAT treatment',
};

/** Global search (README §36). */
export default async function SearchPage({ searchParams }: {
  searchParams: Promise<{ q?: string; type?: string }>;
}) {
  const { q = '', type } = await searchParams;
  const company = activeCompany();
  const query = q.trim();
  const response = company && query ? searchEverything(query) : null;

  const shown = response && type
    ? response.results.filter((result) => result.type === type)
    : response?.results ?? [];

  return (
    <Page
      title="Search"
      subtitle="Everything at once: transactions, documents, invoices, suppliers, accounts,
        rules and journal entries. Each result says why it matched."
    >
      <Panel>
        <form method="get" action="/search" className="px-4 py-3 flex items-end gap-2">
          <div className="flex-1 max-w-xl">
            <label className="block text-[11px] uppercase tracking-wide font-semibold
              text-ink-faint mb-1">
              Search
            </label>
            <Input name="q" defaultValue={query} autoFocus
              placeholder="A supplier, an invoice number, a reference, or an amount" />
          </div>
          <Button type="submit" variant="primary">Search</Button>
        </form>
      </Panel>

      {!company && (
        <Panel><Empty title="No company yet" detail="Create a company before searching." /></Panel>
      )}

      {response && (
        <>
          <Panel>
            <div className="px-4 py-2.5 flex items-center gap-3 flex-wrap">
              <span className="text-ink-muted">
                {response.results.length === 0
                  ? 'Nothing found.'
                  : `${response.results.length} result${response.results.length === 1 ? '' : 's'}`}
              </span>

              {response.interpretedAsAmount !== null && (
                <Badge tone="accent"
                  title="The query parsed as a number, so amounts were searched as well as text.
                    Both signs are matched, because a figure copied from a statement rarely
                    carries one.">
                  Read as an amount: {money(response.interpretedAsAmount)}
                </Badge>
              )}

              {Object.entries(response.countsByType)
                .sort(([, a], [, b]) => b - a)
                .map(([resultType, count]) => (
                  <a
                    key={resultType}
                    href={`/search?q=${encodeURIComponent(query)}${
                      type === resultType ? '' : `&type=${resultType}`}`}
                    className={`text-[11px] px-1.5 py-[1px] rounded border ${
                      type === resultType
                        ? 'bg-accent-soft text-accent border-accent/30'
                        : 'bg-surface-sunken text-ink-muted border-line-strong hover:text-ink'}`}
                  >
                    {TYPE_LABELS[resultType as SearchEntityType] ?? label(resultType)} {count}
                  </a>
                ))}

              {response.truncated && (
                <span className="text-caution text-[11.5px]">
                  Showing the strongest matches only — narrow the query to see the rest.
                </span>
              )}
            </div>
          </Panel>

          {shown.length === 0 ? (
            <Panel>
              <Empty
                title={query.length < 2 ? 'Type at least two characters' : 'Nothing matched'}
                detail={query.length < 2 ? undefined
                  : 'Nothing is shown rather than everything, so an empty result is a real '
                    + 'answer: this query matches nothing in the books.'}
              />
            </Panel>
          ) : (
            <Panel title={type ? `${TYPE_LABELS[type as SearchEntityType] ?? label(type)} results`
              : 'Results'}>
              <table className="ledger">
                <thead>
                  <tr>
                    <th className="w-32">Type</th>
                    <th>What</th>
                    <th className="w-28">Date</th>
                    <th className="w-32 text-right">Amount</th>
                    <th className="w-44">Matched on</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((result) => (
                    <tr key={`${result.type}:${result.id}`}>
                      <td>
                        <Badge tone="neutral">
                          {TYPE_LABELS[result.type] ?? label(result.type)}
                        </Badge>
                      </td>
                      <td>
                        <a href={result.href} className="text-accent hover:underline font-medium">
                          {result.title}
                        </a>
                        {result.subtitle && (
                          <div className="text-ink-muted mt-0.5 leading-snug">{result.subtitle}</div>
                        )}
                      </td>
                      <td className="num !text-left">{result.date ? date(result.date) : '—'}</td>
                      <td className="text-right num">
                        {result.amountMinor === undefined
                          ? '—'
                          : money(result.amountMinor, result.currency ?? 'EUR')}
                      </td>
                      <td className="text-ink-muted">{result.matchedOn}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
        </>
      )}
    </Page>
  );
}
