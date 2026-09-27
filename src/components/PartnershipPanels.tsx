import { Panel, Badge, Help, Empty } from '@/components/primitives';
import { accountingMoney, date } from '@/lib/format';
import type { Form1Firms, PartnerAllocationStatement } from '@/domain/partnerships/report';

/**
 * The partnership's own reports (issue #314): how a period's result and the
 * partners' balances stand per partner, and the Form 1 (Firms) statement the
 * precedent partner files (TCA s.1007). Every figure comes from the domain;
 * nothing is recomputed here.
 */

export function PartnerAllocationPanel({
  statement, currency,
}: { statement: PartnerAllocationStatement; currency: string }) {
  return (
    <Panel
      title="Partner allocation"
      description={`${statement.firmName} · ${date(statement.from)} to ${date(statement.to)}`}
    >
      {statement.rows.length === 0 ? <Empty title="No partners recorded" /> : (
        <>
          <table className="ledger">
            <thead>
              <tr>
                <th>Partner</th>
                <th className="text-right">Share of period</th>
                <th className="text-right">Allocated result</th>
                <th className="text-right">Capital</th>
                <th className="text-right">Current account</th>
                <th className="text-right">Loan owed to them</th>
              </tr>
            </thead>
            <tbody>
              {statement.rows.map((row) => (
                <tr key={row.partnerId}>
                  <td>
                    {row.name} {row.isPrecedentPartner && <Badge tone="positive">Precedent partner</Badge>}
                  </td>
                  <td className="text-right num">{(row.weightedShareBasisPoints / 100).toFixed(2)}%</td>
                  <td className="text-right num">{accountingMoney(row.allocatedResultMinor, currency)}</td>
                  <td className="text-right num">
                    {row.capitalBalanceMinor === null ? '—' : accountingMoney(row.capitalBalanceMinor, currency)}
                  </td>
                  <td className="text-right num">
                    {row.currentBalanceMinor === null ? '—' : accountingMoney(row.currentBalanceMinor, currency)}
                  </td>
                  <td className="text-right num">
                    {row.loanBalanceMinor === null ? '—' : accountingMoney(row.loanBalanceMinor, currency)}
                  </td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="border-t border-line-strong">Result for the period</td>
                <td className="text-right num border-t border-line-strong" />
                <td className="text-right num border-t border-line-strong">
                  {accountingMoney(statement.resultMinor, currency)}
                </td>
                <td colSpan={3} className="border-t border-line-strong" />
              </tr>
            </tbody>
          </table>
          <p className="px-4 py-2.5 text-[11.5px] text-ink-muted border-t border-line leading-snug">
            The result is allocated by the shares in force, day by day through a change — the same
            allocation the year-end close and the income tax computation use, so the books and the
            Form 1 (Firms) statement cannot disagree. The account balances stand at {date(statement.to)}.
          </p>
          <p className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-wide font-semibold text-ink-faint">
            Shares in force during the period
          </p>
          <table className="ledger">
            <tbody>
              {statement.segments.map((seg, i) => (
                <tr key={i}>
                  <td className="text-ink-faint">{date(seg.from)} – {date(seg.to)}</td>
                  <td className="text-right">
                    {seg.shares.length === 0
                      ? 'No shares in force'
                      : seg.shares.map((s) => `${s.name} ${(s.shareBasisPoints / 100).toFixed(2)}%`).join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {statement.findings.map((f, i) => (
        <div key={i} className="px-4 py-1 text-[12px] text-caution"><Badge tone="caution">Check</Badge> {f}</div>
      ))}
    </Panel>
  );
}

export function Form1FirmsPanel({ form1, currency }: { form1: Form1Firms; currency: string }) {
  return (
    <Panel
      title={`Form 1 (Firms) ${form1.year}`}
      description="The partnership return the precedent partner files (TCA s.1007). A preparation statement: check it with your accountant before filing."
      tone="warning"
    >
      <table className="ledger">
        <tbody>
          <tr>
            <td className="w-48 text-ink-faint">Firm</td><td>{form1.firmName}</td>
          </tr>
          <tr>
            <td className="text-ink-faint">Precedent partner</td>
            <td>
              {form1.precedentPartner
                ? `${form1.precedentPartner.name}${form1.precedentPartner.taxReference ? ` (${form1.precedentPartner.taxReference})` : ''}`
                : <Badge tone="caution">Not recorded</Badge>}
            </td>
          </tr>
          <tr>
            <td className="text-ink-faint">Basis period</td>
            <td>{date(form1.basis.from)} – {date(form1.basis.to)} <Help>{form1.basis.rule}</Help></td>
          </tr>
          <tr className="font-semibold">
            <td className="border-t border-line-strong">Firm assessable profit</td>
            <td className="text-right num border-t border-line-strong">
              {accountingMoney(form1.assessableProfitMinor, currency)}
            </td>
          </tr>
          {form1.partners.map((p) => (
            <tr key={p.partnerId}>
              <td className="pl-5">
                {p.name}{p.taxReference ? ` · ${p.taxReference}` : ' · PPSN not recorded'}
                <Help>
                  Their share of the basis period is {(p.weightedShareBasisPoints / 100).toFixed(2)}%.
                  The income tax, USC and PRSI on their share are their own Form 11 figures:
                  income tax {accountingMoney(p.incomeTaxMinor, currency)},
                  USC {accountingMoney(p.uscMinor, currency)},
                  PRSI {p.prsiMinor === null ? 'not computed' : accountingMoney(p.prsiMinor, currency)}.
                </Help>
              </td>
              <td className="text-right num">{accountingMoney(p.profitMinor, currency)}</td>
            </tr>
          ))}
          <tr>
            <td className="text-ink-faint">Preliminary tax due</td>
            <td className="text-right num">{date(form1.dates.preliminaryTaxDue)}</td>
          </tr>
          <tr>
            <td className="text-ink-faint">Return and balance due</td>
            <td className="text-right num">{date(form1.dates.returnDue)}</td>
          </tr>
        </tbody>
      </table>
      {form1.findings.map((f, i) => (
        <div key={i} className="px-4 py-1 text-[12px] text-caution"><Badge tone="caution">Check</Badge> {f}</div>
      ))}
    </Panel>
  );
}
