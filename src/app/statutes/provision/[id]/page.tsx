import { notFound } from 'next/navigation';
import { provisionDetail } from '@/lib/queries';
import { Page, Panel, Badge, Help } from '@/components/primitives';
import { provisionCitation } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * One statutory provision, as the evidence behind a VAT suggestion (issue #200).
 *
 * The point of this page is that the user does not have to trust the stored
 * row: it re-reads the cited file, recomputes its SHA-256 against the one
 * recorded at ingest, and shows the text the stored offsets actually slice,
 * beside the rules that cite it and what each claims. A mismatch is shown as
 * a mismatch, never smoothed over (AGENTS.md #5, #7).
 */
export default async function ProvisionPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ rule?: string }>;
}) {
  const { id } = await params;
  const { rule: highlightRuleId } = await searchParams;
  const detail = provisionDetail(id);
  if (!detail) notFound();
  const { provision: p, source: s, rulesCiting, file } = detail;
  const isGuidance = s.sourceType !== 'legislation' && s.sourceType !== 'eu_source';

  return (
    <Page
      title={`${provisionCitation(s.citation, p.sectionNumber)} — ${p.heading}`}
      subtitle={<span>{s.title}{isGuidance && <Badge tone="caution">Guidance, not legislation</Badge>}</span>}
    >
      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-4 items-start">
        <div>
          {rulesCiting.map((r) => (
            <Panel
              key={r.id}
              id={`rule-${r.id}`}
              tone={r.id === highlightRuleId ? 'positive' : 'default'}
              title={r.name}
              description={<span className="num">{r.ruleKey}</span>}
              actions={<Badge tone="ai">{r.reviewStatus.replace('_', ' ')}</Badge>}
            >
              <table className="ledger">
                <tbody>
                  <tr>
                    <td className="w-40 text-ink-faint">In force</td>
                    <td>{r.effectiveFrom} → {r.effectiveTo ?? 'open'}</td>
                  </tr>
                  <tr>
                    <td className="text-ink-faint align-top">Quoted text</td>
                    <td>
                      <blockquote className="pl-2 border-l-2 border-line-strong whitespace-pre-line">
                        {r.statement}
                      </blockquote>
                    </td>
                  </tr>
                  <tr>
                    <td className="text-ink-faint align-top">
                      Conditions
                      <Help>What the engine actually tests. A keyword match on the description is a proxy for a legal list, not the legal test itself.</Help>
                    </td>
                    <td className="font-mono text-[11px] break-all">
                      {r.conditions.length === 0
                        ? 'none'
                        : r.conditions.map((c) => `${c.field} ${c.operator} ${JSON.stringify(c.value)}`).join('; ')}
                    </td>
                  </tr>
                  {r.exceptions.length > 0 && (
                    <tr>
                      <td className="text-ink-faint align-top">Exceptions (not evaluated)</td>
                      <td>
                        <ul className="list-disc pl-5 text-[12px]">
                          {r.exceptions.map((e) => <li key={e.condition}>{e.condition} — {e.effect}</li>)}
                        </ul>
                      </td>
                    </tr>
                  )}
                  {(r.vatEffect ?? r.taxEffect) && (
                    <tr>
                      <td className="text-ink-faint align-top">Effect claimed</td>
                      <td className="text-[12px]">{r.vatEffect ?? r.taxEffect}</td>
                    </tr>
                  )}
                  {r.requiresGuidance && (
                    <tr>
                      <td className="text-ink-faint">Guidance</td>
                      <td><Badge tone="caution">Needs guidance this knowledge base does not hold</Badge></td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Panel>
          ))}

          <Panel
            title="Provision text"
            description="As stored at ingest. Compare it with the file slice on the right."
          >
            <pre className="px-4 py-3 whitespace-pre-wrap text-[12px] leading-relaxed">{p.provisionText}</pre>
          </Panel>
        </div>

        <div>
          <Panel title="Source">
            <table className="ledger">
              <tbody>
                <tr><td className="w-32 text-ink-faint">Citation</td><td>{s.citation}</td></tr>
                <tr><td className="text-ink-faint">Type</td><td>{s.sourceType.replace('_', ' ')}</td></tr>
                <tr>
                  <td className="text-ink-faint">Official text</td>
                  <td>
                    <a href={s.sourceUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline break-all">
                      {s.sourceUrl}
                    </a>
                  </td>
                </tr>
                <tr><td className="text-ink-faint">Local file</td><td className="font-mono text-[11px] break-all">{s.localPath ?? '—'}</td></tr>
                <tr>
                  <td className="text-ink-faint">SHA-256</td>
                  <td>
                    <span className="font-mono break-all text-[11px]">{s.sha256}</span>
                    <div>
                      {!file.exists
                        ? <Badge tone="negative">File missing</Badge>
                        : file.sha256Matches
                          ? <Badge tone="positive">File unchanged since ingest</Badge>
                          : <Badge tone="negative">File has changed since ingest</Badge>}
                    </div>
                  </td>
                </tr>
                <tr>
                  <td className="text-ink-faint">Offsets</td>
                  <td className="num !text-left">{p.sourceStart ?? '—'}–{p.sourceEnd ?? '—'}</td>
                </tr>
              </tbody>
            </table>
          </Panel>

          <Panel
            title="File slice at the stored offsets"
            description="Read from the file just now, not from the database."
          >
            <pre className="px-4 py-3 whitespace-pre-wrap text-[11px] leading-relaxed max-h-[70vh] overflow-auto">
              {file.slice ?? 'No slice available.'}
            </pre>
          </Panel>
        </div>
      </div>
    </Page>
  );
}
