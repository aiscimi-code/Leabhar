import { Panel, Badge, Select, Input } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { recordCtDecisionAction } from '@/app/corporation-tax-actions';
import { accountingMoney } from '@/lib/format';
import type { CtComputation } from '@/domain/corporationTax/computation';

/**
 * The tax treatments the computation could only suggest (issues #211, #285),
 * each with its options. Choosing one records it by name; the figures above
 * use the suggestion until then. An income tax loss claimed against other
 * income (s.381) also takes the amount being set against it: the person's own
 * figure, as their other income is not in the books.
 */
export function CtDecisions({ computation, currency }: { computation: Pick<CtComputation, 'decisions' | 'to'>; currency: string }) {
  if (computation.decisions.length === 0) return null;
  return (
    <Panel
      title="Tax treatments to decide"
      description="The books cannot settle these. The computation uses the suggested treatment until you choose."
    >
      <table className="ledger">
        <tbody>
          {computation.decisions.map((d) => (
            <tr key={`${d.subjectType}:${d.subjectId}`}>
              <td>
                {d.description}
                <div className="text-[11px] text-ink-faint">{d.reason}</div>
              </td>
              <td className="text-right num w-32">{accountingMoney(d.amountMinor, currency)}</td>
              <td className="w-28">
                {d.decided ? <Badge tone="positive">Decided</Badge> : <Badge tone="caution">Suggested</Badge>}
              </td>
              <td className="w-[34rem]">
                <ActionForm action={recordCtDecisionAction} submit="Record" inline variant="secondary">
                  <input type="hidden" name="subjectType" value={d.subjectType} />
                  <input type="hidden" name="subjectId" value={d.subjectId} />
                  <input type="hidden" name="periodEnd" value={computation.to} />
                  <Select name="choice" defaultValue={d.decided ?? d.suggested} aria-label="Treatment">
                    {d.options.map((o) => <option key={o.choice} value={o.choice}>{o.label}</option>)}
                  </Select>
                  {d.subjectType === 'income_tax_loss_claim' && (
                    <Input
                      name="amount"
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="€ against other income"
                      defaultValue={d.decidedAmountMinor ? d.decidedAmountMinor / 100 : ''}
                      aria-label="Amount of the loss set against other income"
                    />
                  )}
                </ActionForm>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
