import { activeCompany } from '@/lib/queries';
import { getDb } from '@/db';
import {
  searchProvisions, semanticSearchProvisions, statuteSourceIndex, sourceProvisions,
} from '@/domain/search/knowledgeBase';
import { Page, Panel, Badge, Empty, Input, Button } from '@/components/primitives';
import { label } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Statute search (issue #311: full-text and semantic search; issues #445/#446).
 *
 * Full-text matches are literal: the query appears in a provision's heading,
 * text or section number. The "closest provisions" list is a TF-IDF ranking
 * (see `src/domain/search/knowledgeBase.ts`): statistically close, not
 * verified — it retrieves candidates for a person to read, and decides
 * nothing about a treatment. That caveat is on the page, not just in the
 * code, because a user who cannot see it cannot audit it.
 */
export default async function StatutesPage({ searchParams }: {
  searchParams: Promise<{ q?: string; source?: string }>;
}) {
  const { q = '', source } = await searchParams;
  const company = activeCompany();
  const query = q.trim();
  const db = getDb();

  const sources = company ? statuteSourceIndex(db, { companyId: company.id }) : [];
  const sourceHits = company && source
    ? sourceProvisions(db, { companyId: company.id, sourceId: source })
    : [];
  const fullText = company && query ? searchProvisions(db, { companyId: company.id, query }) : [];
  const semantic = company && query ? semanticSearchProvisions(db, { companyId: company.id, query }) : [];
  const listedSource = sources.find((s) => s.sourceId === source) ?? null;

  return (
    <Page
      title="Statutes"
      subtitle="The ingested Irish legislation and Revenue guidance behind every statutory
        rule, searched by exact words or by statistical closeness. A provision's
        text is the source; nothing on this page decides a treatment."
    >
      <Panel>
        <form method="get" action="/statutes" className="px-4 py-3 flex items-end gap-2">
          <div className="flex-1 max-w-xl">
            <label className="block text-[11px] uppercase tracking-wide font-semibold
              text-ink-faint mb-1">
              Search provisions
            </label>
            <Input name="q" defaultValue={query} autoFocus
              placeholder="e.g. reverse charge, capital allowances, second-hand vehicles" />
          </div>
          <Button type="submit" variant="primary">Search</Button>
        </form>
      </Panel>

      {!company && (
        <Panel><Empty title="No company yet" detail="Create a company before searching statutes." /></Panel>
      )}

      {company && listedSource && (
        <Panel
          title={listedSource.title}
          description={<span className="num">{listedSource.citation}</span>}
          actions={<a href={listedSource.sourceUrl} className="text-accent hover:underline text-[12px]">
            Official source
          </a>}
        >
          <table className="ledger">
            <tbody>
              {sourceHits.map((hit) => (
                <tr key={hit.provisionId}>
                  <td className="w-40 num">{hit.citation}</td>
                  <td>
                    <a href={`/statutes/provision/${hit.provisionId}`} className="text-accent hover:underline font-medium">
                      {hit.heading}
                    </a>
                  </td>
                </tr>
              ))}
              {sourceHits.length === 0 && (
                <tr><td>No provisions were ingested from this source.</td></tr>
              )}
            </tbody>
          </table>
        </Panel>
      )}

      {company && query && (
        <>
          <Panel title="Exact text matches">
            {fullText.length === 0 ? (
              <Empty
                title="No provision contains that text"
                detail="Nothing is shown rather than everything, so an empty result is a real
                  answer. The statistical matches below may still be relevant."
              />
            ) : (
              <table className="ledger">
                <thead>
                  <tr>
                    <th className="w-40">Citation</th>
                    <th>Provision</th>
                    <th className="w-36">Matched on</th>
                  </tr>
                </thead>
                <tbody>
                  {fullText.map((hit) => (
                    <tr key={hit.provisionId}>
                      <td className="num">{hit.citation}</td>
                      <td>
                        <a href={`/statutes/provision/${hit.provisionId}`} className="text-accent hover:underline font-medium">
                          {hit.heading}
                        </a>
                        <div className="text-ink-muted mt-0.5 leading-snug">{hit.snippet}</div>
                        <div className="text-ink-faint text-[11px] mt-0.5">{hit.sourceTitle}</div>
                      </td>
                      <td>{hit.matchedOn}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>

          <Panel
            title="Closest provisions"
            description={
              <span>
                A local statistical ranking (TF-IDF), not a verified match. It retrieves
                candidates to read; it never determines a VAT or tax treatment.
              </span>
            }
          >
            {semantic.length === 0 ? (
              <Empty
                title="Nothing is statistically close to that question"
                detail="No provision shares enough distinguishing words with the query. Try
                  naming the subject in the statute's own terms."
              />
            ) : (
              <table className="ledger">
                <thead>
                  <tr>
                    <th className="w-40">Citation</th>
                    <th>Provision</th>
                    <th className="w-56">Connected by</th>
                  </tr>
                </thead>
                <tbody>
                  {semantic.map((hit) => (
                    <tr key={hit.provisionId}>
                      <td className="num">{hit.citation}</td>
                      <td>
                        <a href={`/statutes/provision/${hit.provisionId}`} className="text-accent hover:underline font-medium">
                          {hit.heading}
                        </a>
                        <div className="text-ink-muted mt-0.5 leading-snug">{hit.snippet}</div>
                      </td>
                      <td>
                        <Badge tone="neutral" title="The query terms this provision shares, after plural endings are stemmed.">
                          {hit.matchedTerms.join(', ')}
                        </Badge>
                        <div className="text-ink-faint text-[11px] mt-1 num">
                          similarity {hit.score.toFixed(4)}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </>
      )}

      {company && !query && !listedSource && (
        <Panel title="Ingested sources">
          {sources.length === 0 ? (
            <Empty
              title="No statutes in the rules store"
              detail="The rules store installed with Leabhar holds no statutes. In development,
                build it with npm run rules:build."
            />
          ) : (
            <table className="ledger">
              <thead>
                <tr>
                  <th>Document</th>
                  <th className="w-36">Citation</th>
                  <th className="w-32">Type</th>
                  <th className="w-24 text-right">Provisions</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.sourceId}>
                    <td>
                      <a href={`/statutes?source=${s.sourceId}`} className="text-accent hover:underline font-medium">
                        {s.title}
                      </a>
                      <div className="text-ink-faint text-[11px] mt-0.5">
                        <a href={s.sourceUrl} className="hover:underline">{s.sourceUrl}</a>
                      </div>
                    </td>
                    <td className="num">{s.citation}</td>
                    <td>{label(s.sourceType)}</td>
                    <td className="text-right num">{s.provisionCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}
    </Page>
  );
}
