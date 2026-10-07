import { notFound } from 'next/navigation';
import { provisionDetail } from '@/lib/queries';
import { Page, Panel, Badge, Help } from '@/components/primitives';
import { provisionCitation } from '@/lib/format';
import type { ImpactEdge } from '@/domain/rules/ruleImpact';

export const dynamic = 'force-dynamic';

const KIND_TEXT: Record<string, string> = {
  uses_value: 'uses a value of', rate_from: 'takes its rate from', silenced_by: 'is silenced by',
  excludes: 'excludes', supersedes: 'supersedes', cites: 'cites', derived_from: 'is derived from',
};

/** Rule links reached in a walk: the rule, how it was reached, and through which rule. */
function LinkList({ edges }: { edges: ImpactEdge[] }) {
  return (
    <ul className="text-[12px] space-y-0.5">
      {edges.slice(0, 25).map((e) => (
        <li key={`${e.ruleKey}-${e.kind}`}>
          <span className="num">{e.ruleKey}</span>{' '}
          <span className="text-ink-faint">
            {e.depth === 1 ? '' : `(${e.depth} steps) `}via {KIND_TEXT[e.kind] ?? e.kind} {e.through}
          </span>
        </li>
      ))}
      {edges.length > 25 && <li className="text-ink-faint">and {edges.length - 25} more</li>}
    </ul>
  );
}

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
  const { provision: p, source: s, rulesCiting, dependencies, reliesOn, reliedOnBy, readBy, file } = detail;
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
                  {(dependencies[r.id] ?? []).length > 0 && (
                    <tr>
                      <td className="text-ink-faint align-top">
                        Depends on
                        <Help>What this rule's provision cross-references, resolved against what this book holds. "Not ingested" is a gap to close, never a guess.</Help>
                      </td>
                      <td>
                        <ul className="text-[12px] space-y-1">
                          {(dependencies[r.id] ?? []).map((d) => (
                            <li key={d.reference}>
                              {d.resolved && d.provision
                                ? <span>{d.reference} → <Badge tone="positive">{d.provision.citation} s.{d.provision.sectionNumber}</Badge>{d.ruleKeys.length > 0 && <span className="text-ink-faint"> (rules: {d.ruleKeys.join(', ')})</span>}</span>
                                : <span>{d.reference} → <Badge tone="negative">not ingested</Badge> <span className="text-ink-faint">{d.reason}</span></span>}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                  {(reliesOn[r.ruleKey] ?? []).length > 0 && (
                    <tr>
                      <td className="text-ink-faint align-top">
                        Relies on
                        <Help>The rules this rule takes a rate or value from, is silenced or excluded by, or otherwise links to, and theirs in turn. npm run cli:rules -- depends {r.ruleKey}</Help>
                      </td>
                      <td><LinkList edges={reliesOn[r.ruleKey] ?? []} /></td>
                    </tr>
                  )}
                  {(reliedOnBy[r.ruleKey] ?? []).length > 0 && (
                    <tr>
                      <td className="text-ink-faint align-top">
                        Relied on by
                        <Help>The rules to look at again if this rule changes, directly and through other rules. npm run cli:rules -- impact {r.ruleKey}</Help>
                      </td>
                      <td><LinkList edges={reliedOnBy[r.ruleKey] ?? []} /></td>
                    </tr>
                  )}
                  {(readBy[r.ruleKey] ?? []).length > 0 && (
                    <tr>
                      <td className="text-ink-faint align-top">
                        Read by
                        <Help>The computations and returns that read this rule, or a rule relying on it, from their declared manifests.</Help>
                      </td>
                      <td>
                        <ul className="text-[12px] space-y-0.5">
                          {(readBy[r.ruleKey] ?? []).map((c) => (
                            <li key={c.consumer}>{c.name}{c.ruleKeys.some((k) => k !== r.ruleKey) && <span className="text-ink-faint"> (through {c.ruleKeys.filter((k) => k !== r.ruleKey).join(', ')})</span>}</li>
                          ))}
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
                      {file.replacedBy
                        ? <Badge tone="caution">Statute copy replaced by the catalogue</Badge>
                        : !file.exists
                          ? <Badge tone="negative">File missing</Badge>
                          : file.sha256Matches
                            ? <Badge tone="positive">File unchanged since ingest</Badge>
                            : <Badge tone="negative">File has changed since ingest</Badge>}
                    </div>
                  </td>
                </tr>
                {file.replacedBy && (
                  <tr>
                    <td className="text-ink-faint">
                      Replaced by
                      <Help>This book read the provision from a statute copy that has since moved to the rules catalogue. The entry named here holds the same section in the same words. The local file and SHA-256 above are what the book recorded, and are kept as they were.</Help>
                    </td>
                    <td>
                      <span className="font-mono text-[11px] break-all">{file.replacedBy.entry}</span>
                      <div>
                        {!file.replacedBy.check.exists
                          ? <Badge tone="negative">Official file missing</Badge>
                          : file.replacedBy.check.sha256Matches
                            ? <Badge tone="positive">Official file matches the entry</Badge>
                            : <Badge tone="negative">Official file has changed</Badge>}
                      </div>
                    </td>
                  </tr>
                )}
                <tr>
                  <td className="text-ink-faint">Offsets</td>
                  <td className="num !text-left">{p.sourceStart ?? '—'}–{p.sourceEnd ?? '—'}</td>
                </tr>
                <tr>
                  <td className="text-ink-faint">
                    Locator
                    <Help>How the source itself points a reader here: a page for a PDF, an anchor or section for an HTML page, a box for a return form.</Help>
                  </td>
                  <td>{p.locator ?? '—'}</td>
                </tr>
              </tbody>
            </table>
          </Panel>

          {file.replacedBy ? (
            <Panel
              title="The catalogue entry's excerpt"
              description="Read from the entry that replaced the statute copy just now, not from the database."
            >
              <pre className="px-4 py-3 whitespace-pre-wrap text-[11px] leading-relaxed max-h-[70vh] overflow-auto">
                {file.replacedBy.check.slice ?? 'No excerpt available.'}
              </pre>
            </Panel>
          ) : (
            <Panel
              title="File slice at the stored offsets"
              description="Read from the file just now, not from the database."
            >
              <pre className="px-4 py-3 whitespace-pre-wrap text-[11px] leading-relaxed max-h-[70vh] overflow-auto">
                {file.slice ?? 'No slice available.'}
              </pre>
            </Panel>
          )}
        </div>
      </div>
    </Page>
  );
}
