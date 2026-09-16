import { ruleList, chartOfAccounts, vatTreatmentList } from '@/lib/queries';
import { Page, Panel, Badge, Empty } from '@/components/primitives';
import { dateTime, label } from '@/lib/format';

export const dynamic = 'force-dynamic';

const OPERATOR_TEXT: Record<string, string> = {
  equals: 'is', not_equals: 'is not', contains: 'contains', not_contains: 'does not contain',
  starts_with: 'starts with', ends_with: 'ends with', matches: 'matches the pattern',
  gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most',
  between: 'is between', in: 'is one of', is_null: 'is empty',
};

const FIELD_TEXT: Record<string, string> = {
  description: 'the description', counterpartyName: 'the counterparty name',
  bankReference: 'the bank reference', amountMinor: 'the amount',
  absAmountMinor: 'the amount', currency: 'the currency',
  supplierId: 'the supplier', supplierName: 'the supplier name',
  supplierCountry: 'the supplier country', direction: 'the direction',
  transactionType: 'the transaction type',
};

/**
 * Rules (README §18).
 *
 * Rendered as sentences rather than as JSON, because a rule the user cannot
 * read is a rule they cannot audit.
 */
export default function RulesPage() {
  const rules = ruleList();
  const accounts = new Map(chartOfAccounts().map((a) => [a.id, `${a.code} ${a.name}`]));
  const treatments = new Map(vatTreatmentList().map((t) => [t.id, t.name]));

  const describeValue = (field: string, value: unknown): string => {
    if (field === 'accountId') return accounts.get(String(value)) ?? String(value);
    if (field === 'vatTreatmentId') return treatments.get(String(value)) ?? String(value);
    return String(value);
  };

  return (
    <Page
      title="Rules"
      subtitle="Deterministic rules you control. A confirmed rule takes precedence over any
        automatic suggestion, and every one of them is readable and editable."
    >
      <Panel>
        {rules.length === 0 ? (
          <Empty
            title="No rules yet"
            detail="Confirming a classification for a supplier offers to create one."
          />
        ) : (
          rules.map((rule) => (
            <article key={rule.id} className="px-4 py-3 border-b border-line last:border-0">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-medium text-ink">{rule.name}</h3>
                    {!rule.enabled && <Badge tone="neutral">Disabled</Badge>}
                    {rule.autoApply
                      ? <Badge tone="accent">Applies automatically</Badge>
                      : <Badge tone="caution">Suggests only</Badge>}
                    {rule.derivedFromHistory && <Badge tone="neutral">Learned from history</Badge>}
                  </div>

                  {rule.description && (
                    <p className="text-ink-muted mt-1 max-w-3xl leading-snug">{rule.description}</p>
                  )}

                  <div className="mt-2 text-[12.5px]">
                    <span className="text-ink-faint uppercase text-[10px] font-semibold tracking-wide mr-1.5">
                      If
                    </span>
                    {rule.conditions.map((condition, index) => (
                      <span key={index}>
                        {index > 0 && <span className="text-ink-faint"> and </span>}
                        <span className="text-ink">
                          {FIELD_TEXT[condition.field] ?? condition.field}{' '}
                          {OPERATOR_TEXT[condition.operator] ?? condition.operator}
                          {condition.value !== null && (
                            <> <strong>
                              {Array.isArray(condition.value)
                                ? condition.value.join(' and ')
                                : condition.field.endsWith('Minor')
                                  ? (Number(condition.value) / 100).toFixed(2)
                                  : String(condition.value)}
                            </strong></>
                          )}
                        </span>
                      </span>
                    ))}
                  </div>

                  <div className="mt-1 text-[12.5px]">
                    <span className="text-ink-faint uppercase text-[10px] font-semibold tracking-wide mr-1.5">
                      Then
                    </span>
                    {rule.actions.map((action, index) => (
                      <span key={index}>
                        {index > 0 && <span className="text-ink-faint"> and </span>}
                        <span className="text-ink">
                          set {label(action.field.replace(/Id$/, ''))} to{' '}
                          <strong>{describeValue(action.field, action.value)}</strong>
                        </span>
                      </span>
                    ))}
                  </div>
                </div>

                <div className="shrink-0 text-right text-[11.5px] text-ink-muted">
                  <div>Priority {rule.priority}</div>
                  <div>Applied {rule.timesApplied} {rule.timesApplied === 1 ? 'time' : 'times'}</div>
                  {rule.lastAppliedAt && <div>Last {dateTime(rule.lastAppliedAt)}</div>}
                  {!rule.stopOnMatch && <div className="text-ink-faint">Continues to later rules</div>}
                </div>
              </div>
            </article>
          ))
        )}
      </Panel>
    </Page>
  );
}
