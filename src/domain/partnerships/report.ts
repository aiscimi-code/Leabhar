import { eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { companies, partners as partnersTable } from '@/db/schema';
import { accountBalance } from '../accounting/ledger';
import {
  allocateByShares, partnershipFindings, shareSegments,
  type Partner, type PartnerAllocation,
} from '../config/partners';
import { computeIncomeTax, type IncomeTaxComputation, IncomeTaxError } from '../incomeTax/computation';
import { profitAndLoss } from '../reports/financial';
import type { IsoDate } from '../dates';

/**
 * Partnership reports (issue #314): the statement of how a period's result
 * and balances stand per partner, and the Form 1 (Firms) statement the
 * precedent partner files (TCA s.1007).
 *
 * Both are prepared here, in the domain, so a page or an export can only
 * render them: no figure is recomputed on the way to the screen, and the
 * allocation is the same one the year-end close and the income tax
 * computation use (`allocateByShares`), so the books, this statement and the
 * tax computation cannot disagree.
 */

export class PartnershipReportError extends Error {}

export interface ShareSegment {
  from: string;
  to: string;
  shares: Array<{ partnerId: string; name: string; shareBasisPoints: number }>;
}

export interface PartnerStatementRow {
  partnerId: string;
  name: string;
  taxReference: string | null;
  isPrecedentPartner: boolean;
  /** The partner's share of the period, weighted by days through share changes. */
  weightedShareBasisPoints: number;
  /** The accounting result of the period allocated to this partner. */
  allocatedResultMinor: number;
  capitalBalanceMinor: number | null;
  currentBalanceMinor: number | null;
  /** Money the firm owes the partner on their loan account, or null if they never lent. */
  loanBalanceMinor: number | null;
}

export interface PartnerAllocationStatement {
  companyId: string;
  firmName: string;
  from: IsoDate;
  to: IsoDate;
  /** The accounting result of the period: profit positive, loss negative. */
  resultMinor: number;
  segments: ShareSegment[];
  rows: PartnerStatementRow[];
  findings: string[];
}

function requirePartnershipCompany(db: AppDatabase, companyId: string): typeof companies.$inferSelect {
  const company = db.select().from(companies).where(eq(companies.id, companyId)).get();
  if (!company) throw new PartnershipReportError(`Company ${companyId} not found.`);
  if (company.entityType !== 'partnership') {
    throw new PartnershipReportError('Partnership reports belong to a partnership; these books are for a '
      + `${company.entityType === 'sole_trader' ? 'sole trader' : 'company'}.`);
  }
  return company;
}

/**
 * What each partner is entitled to and owed at the end of a period: their
 * share of the period's accounting result, and the balances standing on
 * their capital, current and loan accounts.
 */
export function partnerAllocationStatement(
  db: AppDatabase, params: { companyId: string; from: IsoDate; to: IsoDate },
): PartnerAllocationStatement {
  const company = requirePartnershipCompany(db, params.companyId);

  const result = profitAndLoss(db, { companyId: params.companyId, from: params.from, to: params.to })
    .netProfit.valueMinor;
  const allocation = allocateByShares(db, params.companyId, {
    from: params.from, to: params.to, amountMinor: result,
  });
  const allocated = new Map(allocation.map((a: PartnerAllocation) => [a.partner.id, a]));

  const rows = db.select().from(partnersTable)
    .where(eq(partnersTable.companyId, params.companyId)).all()
    .sort((a, b) => a.joinedOn.localeCompare(b.joinedOn) || a.name.localeCompare(b.name))
    .map((p: Partner) => {
      const balance = (accountId: string | null) => accountId
        ? accountBalance(db, { companyId: params.companyId, accountId, asOf: params.to })
        : null;
      const share = allocated.get(p.id);
      return {
        partnerId: p.id,
        name: p.name,
        taxReference: p.taxReference,
        isPrecedentPartner: p.isPrecedentPartner,
        weightedShareBasisPoints: share?.weightedShareBasisPoints ?? 0,
        allocatedResultMinor: share?.amountMinor ?? 0,
        capitalBalanceMinor: balance(p.capitalAccountId),
        currentBalanceMinor: balance(p.currentAccountId),
        loanBalanceMinor: balance(p.loanAccountId),
      };
    });

  const byId = new Map(db.select().from(partnersTable)
    .where(eq(partnersTable.companyId, params.companyId)).all().map((p: Partner) => [p.id, p]));

  return {
    companyId: params.companyId,
    firmName: company.legalName,
    from: params.from,
    to: params.to,
    resultMinor: result,
    segments: shareSegments(db, params.companyId, params.from, params.to).map((seg) => ({
      from: seg.from,
      to: seg.to,
      shares: seg.shares.map((s) => ({
        partnerId: s.partner.id,
        name: byId.get(s.partner.id)?.name ?? s.partner.name,
        shareBasisPoints: s.shareBasisPoints,
      })),
    })),
    rows,
    findings: partnershipFindings(db, params.companyId, params.from, params.to),
  };
}

export interface Form1PartnerRow {
  partnerId: string;
  name: string;
  taxReference: string | null;
  /** The partner's share of the basis period, weighted by days through changes. */
  weightedShareBasisPoints: number;
  /** The partner's assessable share of the firm's profit for the year. */
  profitMinor: number;
  incomeTaxMinor: number;
  uscMinor: number;
  prsiMinor: number | null;
}

export interface Form1Firms {
  companyId: string;
  firmName: string;
  year: number;
  /** The precedent partner who makes the return (TCA s.1007). */
  precedentPartner: { id: string; name: string; taxReference: string | null } | null;
  basis: { from: string; to: string; rule: string };
  /** The firm's assessable profit for the year, before allocation. */
  assessableProfitMinor: number;
  partners: Form1PartnerRow[];
  dates: { preliminaryTaxDue: string; returnDue: string };
  findings: string[];
}

/**
 * The Form 1 (Firms) statement (TCA s.1007): the firm's basis period and
 * assessable profit, and each partner's share of it, which the precedent
 * partner reports and each partner then carries to their own Form 11.
 *
 * The figures are the income tax computation's own (issue #212), read back
 * here: this statement adds nothing and changes nothing.
 */
export function form1Firms(db: AppDatabase, params: { companyId: string; year: number }): Form1Firms {
  const company = requirePartnershipCompany(db, params.companyId);
  let computation: IncomeTaxComputation;
  try {
    computation = computeIncomeTax(db, { companyId: params.companyId, year: params.year });
  } catch (e) {
    if (e instanceof IncomeTaxError) throw new PartnershipReportError(e.message);
    throw e;
  }
  const shares = new Map(allocateByShares(db, params.companyId, {
    from: computation.basis.from, to: computation.basis.to, amountMinor: computation.assessableProfitMinor,
  }).map((a) => [a.partner.id, a]));

  const precedent = db.select().from(partnersTable)
    .where(eq(partnersTable.companyId, params.companyId)).all()
    .find((p) => p.isPrecedentPartner && (!p.leftOn || p.leftOn > computation.basis.to));

  return {
    companyId: params.companyId,
    firmName: company.legalName,
    year: params.year,
    precedentPartner: precedent
      ? { id: precedent.id, name: precedent.name, taxReference: precedent.taxReference }
      : null,
    basis: {
      from: computation.basis.from,
      to: computation.basis.to,
      rule: computation.basis.rule,
    },
    assessableProfitMinor: computation.assessableProfitMinor,
    partners: computation.individuals.flatMap((i) => {
      if (!i.partnerId) return [];
      const share = shares.get(i.partnerId);
      return [{
        partnerId: i.partnerId,
        name: i.name,
        taxReference: share?.partner.taxReference ?? null,
        weightedShareBasisPoints: share?.weightedShareBasisPoints ?? 0,
        profitMinor: i.profitMinor,
        incomeTaxMinor: i.incomeTaxMinor,
        uscMinor: i.uscMinor,
        prsiMinor: i.prsiMinor,
      }];
    }),
    dates: {
      preliminaryTaxDue: computation.dates.preliminaryTaxDue,
      returnDue: computation.dates.returnDue,
    },
    findings: computation.findings,
  };
}
