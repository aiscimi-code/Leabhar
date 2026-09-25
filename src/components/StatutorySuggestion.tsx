import Link from 'next/link';
import { Panel, Badge, Help, Disclosure } from './primitives';
import { ActionForm } from './ActionForm';
import { loadStatutoryRulesAction } from '@/app/actions';
import { rate, provisionCitation } from '@/lib/format';
import type { VatSuggestion, StatutoryCitation } from '@/domain/rules/vatSuggestion';

/**
 * The statutory VAT suggestion for one transaction (issue #200): which
 * treatment the knowledge base points to, the rule that decided it, and a
 * link to the provision so the user can read the law it rests on. It renders
 * what `suggestVatTreatment` returned and computes nothing itself (AGENTS.md:
 * pages render what the domain returns).
 */
export function StatutorySuggestion({ suggestion }: { suggestion: VatSuggestion }) {
  const s = suggestion;

  if (s.status === 'kb_empty') {
    return (
      <Panel
        title="Statutory VAT suggestion"
        description="The Irish statutory rules have not been loaded for this company yet."
      >
        <div className="px-4 py-3">
          <ActionForm action={loadStatutoryRulesAction} submit="Load statutory rules" variant="secondary" />
        </div>
      </Panel>
    );
  }

  const tone = s.status === 'suggested' ? 'default' : 'warning';
  return (
    <Panel
      title="Statutory VAT suggestion"
      tone={tone}
      description={s.explanation}
      actions={<Badge tone="ai" title="No statutory rule has been approved by a person yet.">Needs review</Badge>}
    >
      <table className="ledger">
        <tbody>
          <tr>
            <td className="w-44 text-ink-faint">Suggested treatment</td>
            <td>
              {s.treatment ? <strong>{s.treatment.name}</strong> : <span className="text-caution">None</span>}
              {s.status === 'fallback_only' && (
                <Badge tone="caution" title="Applies only if the supply is taxable and not exempt or outside the scope.">
                  Fallback only
                </Badge>
              )}
              {s.agreesWithBooked === false && <Badge tone="negative">Differs from booked</Badge>}
            </td>
          </tr>
          {(s.ruleRateBasisPoints !== null || s.configuredRateBasisPoints !== null) && (
            <tr>
              <td className="text-ink-faint">
                Rate
                <Help>
                  The rate the rule itself states, beside the rate your configuration would charge on
                  this transaction&apos;s date. If they differ, the configuration and the law disagree.
                </Help>
              </td>
              <td className="num !text-left">
                {s.ruleRateBasisPoints !== null ? `${rate(s.ruleRateBasisPoints)} (rule)` : 'rule states none'}
                {' · '}
                {s.configuredRateBasisPoints !== null ? `${rate(s.configuredRateBasisPoints)} (configured)` : 'not configured'}
                {s.rateAgrees === false && <Badge tone="negative">Disagree</Badge>}
              </td>
            </tr>
          )}
          {s.decidingRule && (
            <tr>
              <td className="text-ink-faint align-top">Why</td>
              <td><CitationLink citation={s.decidingRule} /></td>
            </tr>
          )}
        </tbody>
      </table>

      {s.reviewReasons.length > 0 && (
        <Disclosure summary={`What needs checking (${s.reviewReasons.length})`} tone="accent">
          <ul className="list-disc pl-5 space-y-1 text-[12px]">
            {s.reviewReasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </Disclosure>
      )}

      <Disclosure summary="Facts the rules were given">
        <table className="ledger">
          <tbody>
            {Object.entries(s.factSources).map(([field, from]) => (
              <tr key={field}>
                <td className="w-44 text-ink-faint">{field}</td>
                <td>
                  <span className="font-mono text-[11px] break-all">{JSON.stringify(s.facts[field] ?? null)}</span>
                  <span className="text-ink-faint ml-2">from {from}</span>
                </td>
              </tr>
            ))}
            {s.unresolvedFields.length > 0 && (
              <tr>
                <td className="text-ink-faint">Not known</td>
                <td className="text-ink-muted">{s.unresolvedFields.join(', ')}</td>
              </tr>
            )}
          </tbody>
        </table>
      </Disclosure>

      {s.supportingRules.length > 0 && (
        <Disclosure summary={`Other rules that also matched (${s.supportingRules.length})`}>
          <ul className="space-y-2">
            {s.supportingRules.map((c, i) => <li key={`${c.ruleId}-${i}`}><CitationLink citation={c} /></li>)}
          </ul>
        </Disclosure>
      )}
    </Panel>
  );
}

function CitationLink({ citation: c }: { citation: StatutoryCitation }) {
  return (
    <div>
      <Link href={`/statutes/provision/${c.provisionId}?rule=${c.ruleId}`} className="text-accent hover:underline">
        {provisionCitation(c.citation, c.sectionNumber)} — {c.heading}
      </Link>
      {c.sourceType !== 'legislation' && c.sourceType !== 'eu_source' && (
        <Badge tone="caution" title="Guidance explains the law; it is not the law itself.">Guidance</Badge>
      )}
      <div className="text-ink-faint text-[11px]">{c.ruleName} · <span className="num">{c.ruleKey}</span></div>
      {c.quote && (
        <blockquote className="mt-1 pl-2 border-l-2 border-line-strong text-ink-muted text-[12px] whitespace-pre-line">
          {c.quote}
        </blockquote>
      )}
    </div>
  );
}
