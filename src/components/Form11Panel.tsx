import { Panel, Badge, Help } from '@/components/primitives';
import { accountingMoney, date } from '@/lib/format';
import type { Form11 } from '@/domain/incomeTax/form11';

/**
 * Form 11 preparation (issue #312): the year's computation laid out in the
 * order the return asks for it, the self-assessment reconciliation (the tax,
 * the payments, the balance) and the tax to fund, per person. Nothing here
 * files anything: the figures are the domain's, prepared for the person or
 * their agent to file through ROS.
 */
export function Form11Panel({ form11: f, currency }: { form11: Form11; currency: string }) {
  return (
    <Panel
      title={`Form 11 preparation ${f.year}`}
      description="The return's own layout of the figures: the trade, each person's computation, the
        self-assessment reconciliation and the tax to set aside. Prepared, not filed."
      tone="warning"
    >
      {f.sections.map((section) => (
        <table className="ledger" key={section.title}>
          <tbody>
            <tr>
              <td colSpan={2} className="font-semibold">
                {section.title}
                {section.note && <div className="text-[11px] text-ink-faint font-normal">{section.note}</div>}
              </td>
            </tr>
            {section.lines.map((line, n) => (
              <tr key={n}>
                <td className="pl-5">
                  {line.label}
                  {line.note && <Help>{line.note}</Help>}
                </td>
                <td className="text-right num w-40">
                  {line.amountMinor === null ? '—' : accountingMoney(line.amountMinor, currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
      {f.selfAssessment.map((sa) => (
        <table className="ledger" key={sa.name}>
          <tbody>
            <tr>
              <td colSpan={2} className="font-semibold">
                Self-assessment reconciliation — {sa.name}{' '}
                {sa.partial && <Badge tone="caution">Partial</Badge>}
              </td>
            </tr>
            <tr><td className="pl-5">Income tax, USC and PRSI for the year</td>
              <td className="text-right num">{accountingMoney(sa.liabilityMinor, currency)}</td></tr>
            <tr><td className="pl-5">Less preliminary tax paid (s.959AO)</td>
              <td className="text-right num">{accountingMoney(-sa.preliminaryTaxMinor, currency)}</td></tr>
            <tr className="font-semibold">
              <td className="border-t border-line-strong">Balance payable with the return by {date(sa.balanceDueDate)}{sa.balanceMinor < 0 ? ' (repayable)' : ''}</td>
              <td className="text-right num border-t border-line-strong">{accountingMoney(sa.balanceMinor, currency)}</td>
            </tr>
            {sa.partial && (
              <tr><td colSpan={2} className="text-[11px] text-ink-faint">
                Partial: it reconciles the trade&apos;s liability only — the person&apos;s other
                income is not in these books, so this is never their total liability (#458).
              </td></tr>
            )}
          </tbody>
        </table>
      ))}
      {f.provision.map((p) => (
        <table className="ledger" key={p.name}>
          <tbody>
            <tr><td colSpan={2} className="font-semibold">Tax provision — {p.name}</td></tr>
            {p.payments.map((x) => (
              <tr key={x.dueDate}>
                <td className="pl-5">{x.description} due {date(x.dueDate)}</td>
                <td className="text-right num">{accountingMoney(x.amountMinor, currency)}</td>
              </tr>
            ))}
            <tr><td colSpan={2} className="text-[11px] text-ink-faint">{p.note}</td></tr>
          </tbody>
        </table>
      ))}
      <div className="px-4 py-2.5 border-t border-caution/30 bg-caution-soft text-caution text-[12px] leading-snug space-y-1">
        {f.findings.map((x, n) => <div key={n}><Badge tone="caution">Check</Badge> {x}</div>)}
      </div>
    </Panel>
  );
}
