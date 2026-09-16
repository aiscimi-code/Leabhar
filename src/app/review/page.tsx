import Link from 'next/link';
import { reviewQueue } from '@/lib/queries';
import { Page, Panel, Badge, Empty, LinkButton } from '@/components/primitives';
import { ReviewActions } from '@/components/ReviewActions';
import { AnomalyScan } from '@/components/AnomalyScan';
import { label, dateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

/**
 * Review / needs-attention queue (README §20).
 *
 * The objective from §20 is that the user spends time only on exceptions, so
 * each item carries the minimum information needed to resolve it and, where
 * possible, the action to resolve it in place.
 */
export default function ReviewPage() {
  const items = reviewQueue();

  const blocking = items.filter((i) => i.severity === 'blocking' || i.severity === 'error');
  const warnings = items.filter((i) => i.severity === 'warning');
  const info = items.filter((i) => i.severity === 'info');

  return (
    <Page
      title="Review queue"
      subtitle={items.length === 0
        ? 'Nothing needs your attention.'
        : `${items.length} item${items.length === 1 ? '' : 's'} need a decision. `
          + 'Everything else has been handled automatically.'}
      actions={
        <>
          <AnomalyScan />
          <LinkButton href="/transactions?status=unclassified">Unclassified transactions</LinkButton>
        </>
      }
    >
      {items.length === 0 ? (
        <Panel>
          <Empty
            title="Nothing to review"
            detail="Every transaction is classified, every document is matched, and no
              integrity checks have failed. This does not mean your figures are correct —
              only that the system has nothing to flag."
          />
        </Panel>
      ) : (
        <>
          {blocking.length > 0 && (
            <Group
              title="Blocking"
              description="These prevent a VAT period being marked ready."
              items={blocking} tone="negative"
            />
          )}
          {warnings.length > 0 && (
            <Group
              title="Worth checking"
              description="Not blocking, but likely to matter."
              items={warnings} tone="warning"
            />
          )}
          {info.length > 0 && (
            <Group title="For information" items={info} tone="default" />
          )}
        </>
      )}
    </Page>
  );
}

function Group({ title, description, items, tone }: {
  title: string; description?: string;
  items: ReturnType<typeof reviewQueue>;
  tone: 'default' | 'warning' | 'negative';
}) {
  return (
    <Panel title={`${title} (${items.length})`} description={description} tone={tone}>
      {items.map((item) => (
        <article key={item.id} className="px-4 py-3 border-b border-line last:border-0">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge tone={item.severity === 'blocking' || item.severity === 'error' ? 'negative'
                  : item.severity === 'warning' ? 'caution' : 'neutral'}>
                  {label(item.kind)}
                </Badge>
                <h3 className="font-medium text-ink">{item.title}</h3>
              </div>
              <p className="text-ink-muted mt-1 max-w-3xl leading-snug">{item.detail}</p>

              <ContextLinks item={item} />

              <div className="text-[11px] text-ink-faint mt-1.5">
                Raised {dateTime(item.createdAt)}
              </div>
            </div>

            <ReviewActions
              reviewItemId={item.id}
              suggestedActions={item.suggestedActions}
            />
          </div>
        </article>
      ))}
    </Panel>
  );
}

function ContextLinks({ item }: { item: ReturnType<typeof reviewQueue>[number] }) {
  const context = item.context as Record<string, unknown>;
  const ids = Array.isArray(context['entityIds']) ? context['entityIds'] as string[] : [];

  const href = (entityType: string, entityId: string): string | null => {
    if (entityType === 'bank_transaction') return `/transactions/${entityId}`;
    if (entityType === 'document') return `/documents/${entityId}`;
    if (entityType === 'vat_period') return `/vat/${entityId}`;
    return null;
  };

  const primary = href(item.entityType, item.entityId);

  return (
    <div className="mt-1.5 flex flex-wrap gap-2 text-[12px]">
      {primary && (
        <Link href={primary} className="text-accent hover:underline">
          Open {label(item.entityType).toLowerCase()}
        </Link>
      )}
      {ids.length > 1 && (
        <span className="text-ink-faint">
          and {ids.length - 1} more affected
        </span>
      )}
    </div>
  );
}
