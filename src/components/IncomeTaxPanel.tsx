import { Panel, Badge, Help } from '@/components/primitives';
import { CtDecisions } from '@/components/CtDecisions';
import { accountingMoney, date } from '@/lib/format';
import { asIsoDate } from '@/domain/dates';
import type { IncomeTaxComputation } from '@/domain/incomeTax/computation';

/**
 * Income tax on a sole trader's or partnership's trading profits for the year
 * (issue #212): the basis period, the assessable profit, and each person's
 * income tax, USC and PRSI Class S. Figures come from the domain; nothing is
 * recomputed here.
 */
export function IncomeTaxPanel({ computation: c, currency }: { computation: IncomeTaxComputation; currency: string }) {
  return (
    <>
      <Panel
        title={`Income tax ${c.year}`}
        description="Trading profit for the year of assessment and the tax on it for each person. Check it with your
          accountant before filing Form 11 or Form 1 (Firms)."
        tone="warning"
      >
        <table className="ledger">
          <tbody>
            <tr>
              <td>Basis period {date(c.basis.from)} – {date(c.basis.to)} <Help>{c.basis.rule}</Help></td>
              <td className="text-right num w-40">{accountingMoney(c.assessableProfitMinor + c.thirdYearReliefMinor, currency)}</td>
            </tr>
            {c.thirdYearReliefMinor !== 0 && (
              <tr><td className="pl-5">Less second-year excess (s.66(3))</td>
                <td className="text-right num">{accountingMoney(-c.thirdYearReliefMinor, currency)}</td></tr>
            )}
            <tr className="font-semibold">
              <td className="border-t border-line-strong">Assessable trading profit</td>
              <td className="text-right num border-t border-line-strong">{accountingMoney(c.assessableProfitMinor, currency)}</td>
            </tr>
            {c.individuals.map((i) => (
              <tr key={i.partnerId ?? 'owner'}>
                <td className="pl-5">
                  {i.name}: profit {accountingMoney(i.profitMinor, currency)}; income tax {accountingMoney(i.incomeTaxMinor, currency)},
                  USC {accountingMoney(i.uscMinor, currency)}, PRSI {i.prsiMinor === null ? 'not computed' : accountingMoney(i.prsiMinor, currency)}
                  <Help>{[...i.incomeTax, ...i.usc].map((l) => `${l.label}: ${accountingMoney(l.amountMinor, currency)}`).join('; ')}</Help>
                </td>
                <td className="text-right num">{accountingMoney(i.totalMinor, currency)}</td>
              </tr>
            ))}
            <tr><td>Preliminary tax due {date(c.dates.preliminaryTaxDue)} <Help>{c.dates.basis}</Help></td>
              <td className="text-right num">{accountingMoney(c.dates.preliminaryTaxMinor, currency)}</td></tr>
            <tr><td>Return and balance due</td><td className="text-right num">{date(c.dates.returnDue)}</td></tr>
          </tbody>
        </table>
        <div className="px-4 py-2.5 border-t border-caution/30 bg-caution-soft text-caution text-[12px] leading-snug space-y-1">
          {c.findings.map((f, n) => <div key={n}><Badge tone="caution">Check</Badge> {f}</div>)}
        </div>
      </Panel>
      <CtDecisions computation={{ decisions: c.decisions, to: asIsoDate(`${c.year}-12-31`) }} currency={currency} />
    </>
  );
}
