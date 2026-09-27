import Link from 'next/link';
import { retentionOverview } from '@/lib/queries';
import {
  Page, Panel, Badge, Field, Input, Disclosure, Empty,
} from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { setRetentionPolicyAction, disposeDocumentAction } from '@/app/actions';
import { date, label } from '@/lib/format';
import { today } from '@/domain/dates';
import { ALL_DOCUMENT_TYPES } from '@/domain/documents/types';

export const dynamic = 'force-dynamic';

/**
 * Document retention (issue #429). A policy is effective-dated: setting a new
 * one supersedes the old from its date, and each document resolves the policy
 * in force as of its own date. Nothing is ever disposed automatically —
 * documents past their policy are listed for a person to decide.
 */
export default function RetentionPage() {
  const { policies, status } = retentionOverview();

  return (
    <Page
      title="Document retention"
      subtitle={`How long each kind of document is kept before it may be disposed of.
        Nothing is ever removed on its own: a document past its policy is listed below,
        and disposal is an explicit, audited decision. ${status.eligible.length} ${
          status.eligible.length === 1 ? 'document is' : 'documents are'
        } past retention as of ${date(status.asOf)}.`}
    >
      <Panel
        title="Policies"
        description="A policy is in force from its effective date until the policy that supersedes
          it takes over, so a document always resolves the policy of its own day. The clock
          runs from the document's own date, or from when it was filed if it states none.
          No periods are built in: how long to keep each kind of record is this book's own
          decision (verify against Companies Act 2014 s.881, TCA97 s.886 and Revenue practice
          for your entity type)."
      >
        {policies.length === 0 ? (
          <Empty
            title="No retention policy set"
            detail="Without a policy no document is ever listed as past retention."
          />
        ) : (
          <table className="ledger">
            <thead>
              <tr>
                <th className="w-44">Applies to</th>
                <th className="w-24 text-right">Keep for</th>
                <th className="w-28">From</th>
                <th className="w-28">Until</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((policy) => (
                <tr key={policy.id}>
                  <td>{policy.appliesTo === 'all' ? 'All types without a specific policy' : label(policy.appliesTo)}</td>
                  <td className="text-right num">{policy.retainYears} {policy.retainYears === 1 ? 'year' : 'years'}</td>
                  <td className="num !text-left">{date(policy.effectiveFrom)}</td>
                  <td className="num !text-left text-ink-muted">
                    {policy.supersededAt ? date(policy.supersededAt) : 'current'}
                  </td>
                  <td>
                    {policy.supersededAt
                      ? <Badge tone="neutral">Superseded</Badge>
                      : <Badge tone="positive">In force</Badge>}
                    {policy.note && (
                      <div className="text-[11px] text-ink-faint mt-0.5">{policy.note}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="px-4 py-3 border-t border-line">
          <Disclosure summary="Set or change a policy">
            <ActionForm action={setRetentionPolicyAction} submit="Set policy" inline>
              <Field label="Applies to">
                <select name="appliesTo" defaultValue="all"
                  className="border border-line-strong rounded px-2 py-1 text-[12px]">
                  <option value="all">All types without a specific policy</option>
                  {ALL_DOCUMENT_TYPES.map((type) => (
                    <option key={type} value={type}>{label(type)}</option>
                  ))}
                </select>
              </Field>
              <Field label="Keep for (years)">
                <Input name="retainYears" type="number" min="0" step="1" required defaultValue="6" />
              </Field>
              <Field label="In force from">
                <Input name="effectiveFrom" type="date" required defaultValue={today()} />
              </Field>
              <Field label="Note (optional)">
                <Input name="note" placeholder="e.g. Companies Act 2014 s.881" />
              </Field>
            </ActionForm>
            <p className="text-[11.5px] text-ink-muted mt-2">
              Setting a policy for a type that already has one supersedes it from the effective
              date — the old row is kept, and documents dated before the change still resolve it.
            </p>
          </Disclosure>
        </div>
      </Panel>

      <Panel
        title="Past retention"
        description="Documents whose policy has run out. Each one is disposed of by an explicit
          archive with a reason; the reason joins the audit trail. A disposed document can be
          restored from its own page."
      >
        {status.eligible.length === 0 ? (
          <Empty
            title="Nothing to dispose of"
            detail={
              policies.length === 0
                ? 'No policy is set, so no document is ever past retention.'
                : 'No document has passed its retention period yet.'
            }
          />
        ) : (
          status.eligible.map((item) => (
            <div key={item.documentId} className="px-4 py-3 border-b border-line last:border-0">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={`/documents/${item.documentId}`} className="text-accent hover:underline font-medium">
                    {item.filename}
                  </Link>
                  <div className="text-ink-muted text-[12px] mt-0.5">
                    {label(item.documentType)} · dated {date(item.documentDate)} · kept for{' '}
                    {item.retainYears} {item.retainYears === 1 ? 'year' : 'years'} · past
                    retention since {date(item.eligibleFrom)}
                  </div>
                </div>
                <Disclosure summary="Dispose — archive with a reason">
                  <ActionForm
                    action={disposeDocumentAction} submit="Archive as disposed" variant="danger"
                    extra={{ documentId: item.documentId }}
                  >
                    <Field label="Why may it be disposed of?">
                      <Input name="reason" required placeholder="Retention period has ended" />
                    </Field>
                  </ActionForm>
                </Disclosure>
              </div>
            </div>
          ))
        )}
      </Panel>

      {status.withoutPolicy.length > 0 && (
        <Panel
          title="No policy in force"
          description="These documents resolve no policy as of their own date, so they are never
            listed as past retention. Set a policy for their type (or a default) to cover them."
        >
          <ul className="px-4 py-3 space-y-1">
            {status.withoutPolicy.slice(0, 20).map((item) => (
              <li key={item.documentId} className="text-[12px] text-ink-muted">
                <Link href={`/documents/${item.documentId}`} className="text-accent hover:underline">
                  {item.filename}
                </Link>
                {' '}· {label(item.documentType)}
              </li>
            ))}
            {status.withoutPolicy.length > 20 && (
              <li className="text-[12px] text-ink-faint">
                …and {status.withoutPolicy.length - 20} more.
              </li>
            )}
          </ul>
        </Panel>
      )}
    </Page>
  );
}
