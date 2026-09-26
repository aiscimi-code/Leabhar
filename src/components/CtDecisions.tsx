import { Panel, Badge, Select } from '@/components/primitives';
import { ActionForm } from '@/components/ActionForm';
import { recordCtDecisionAction } from '@/app/corporation-tax-actions';
import { accountingMoney } from '@/lib/format';
import type { CtComputation } from '@/domain/corporationTax/computation';

/**
 * The corporation tax treatments the computation could only suggest (issue
 * #211), each with its options. Choosing one records it by name; the figures
 * above use the suggestion until then.
 */
export function CtDecisions({ computation, currency }: { computation: CtComputation; currency: string }) {
  if (computation.decisions.length === 0) return null;
  return (
    <Panel
      title="Corporation tax treatments to decide"
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
              <td className="w-[28rem]">
                <ActionForm action={recordCtDecisionAction} submit="Record" inline variant="secondary">
                  <input type="hidden" name="subjectType" value={d.subjectType} />
                  <input type="hidden" name="subjectId" value={d.subjectId} />
                  <input type="hidden" name="periodEnd" value={computation.to} />
                  <Select name="choice" defaultValue={d.decided ?? d.suggested} aria-label="Treatment">
                    {d.options.map((o) => <option key={o.choice} value={o.choice}>{o.label}</option>)}
                  </Select>
                </ActionForm>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
