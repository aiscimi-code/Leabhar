import { getDb } from '@/db';
import { glossaryTerms } from '@/db/schema';
import { Page, Panel, Badge, Empty } from '@/components/primitives';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

/** Searchable glossary (README §41). */
export default async function GlossaryPage({ searchParams }: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const query = (params['q'] ?? '').trim().toLowerCase();

  const db = getDb();
  const all = db.select().from(glossaryTerms).orderBy(glossaryTerms.term).all();

  const terms = query
    ? all.filter((term) =>
        term.term.toLowerCase().includes(query)
        || term.shortDefinition.toLowerCase().includes(query)
        || (term.longDefinition ?? '').toLowerCase().includes(query)
        || (term.irishContext ?? '').toLowerCase().includes(query))
    : all;

  const categories = [...new Set(terms.map((t) => t.category ?? 'General'))].sort();

  return (
    <Page
      title="Glossary"
      subtitle={`${terms.length} of ${all.length} terms${query ? ` matching “${query}”` : ''}.`}
    >
      <Panel>
        <form method="get" className="flex items-end gap-2 px-4 py-2.5">
          <div>
            <label className="block text-[10px] uppercase tracking-wide font-semibold text-ink-faint mb-0.5">
              Search
            </label>
            <input type="search" name="q" defaultValue={params['q'] ?? ''}
              placeholder="reverse charge, tax point, debtor…"
              className="border border-line-strong rounded px-2 py-1 text-[12px] w-72" />
          </div>
          <button type="submit"
            className="px-2.5 py-1 rounded border border-accent bg-accent text-white text-[12px] font-medium">
            Search
          </button>
          {query && (
            <a href="/glossary" className="text-[12px] text-ink-muted hover:underline px-1">Clear</a>
          )}
        </form>
      </Panel>

      {terms.length === 0 ? (
        <Panel><Empty title="Nothing matches" detail="Try a shorter search." /></Panel>
      ) : (
        categories.map((category) => {
          const inCategory = terms.filter((t) => (t.category ?? 'General') === category);
          if (inCategory.length === 0) return null;
          return (
            <Panel key={category} title={category}>
              <dl className="divide-y divide-line">
                {inCategory.map((term) => (
                  <div key={term.id} id={term.slug} className="px-4 py-3 scroll-mt-4">
                    <dt className="font-semibold text-ink flex items-center gap-2">
                      {term.term}
                      {term.irishContext && <Badge tone="accent">Irish context</Badge>}
                    </dt>
                    <dd className="mt-1 max-w-3xl">
                      <p className="text-ink">{term.shortDefinition}</p>
                      {term.longDefinition && (
                        <p className="text-ink-muted mt-1.5 leading-relaxed">{term.longDefinition}</p>
                      )}
                      {term.irishContext && (
                        <p className="text-ink-muted mt-1.5 leading-relaxed border-l-2 border-accent/40 pl-2.5">
                          {term.irishContext}
                        </p>
                      )}
                      {term.relatedTerms.length > 0 && (
                        <p className="text-[11.5px] text-ink-faint mt-1.5">
                          See also:{' '}
                          {term.relatedTerms.map((related, index) => (
                            <span key={related}>
                              {index > 0 && ', '}
                              <a href={`#${related}`} className="text-accent hover:underline">
                                {related.replace(/-/g, ' ')}
                              </a>
                            </span>
                          ))}
                        </p>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </Panel>
          );
        })
      )}
    </Page>
  );
}
