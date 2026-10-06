/**
 * Curated rules for VATCA 2010 Part 9 Chapter 1 — returns and remittances
 * (issue #278: s.76, the legal basis of the return).
 *
 * The return itself is computed and filed by the product: `src/domain/vat/`
 * (rtd.ts builds it, periodClose.ts files it, periodLock guards it). A
 * transaction-level rule cannot decide anything about it, so the rule here
 * carries the deadline the calendar and the filing pack are measured against,
 * and lives on the `vat_return` topic: it never surfaces in a transaction
 * lookup, because no bank line or invoice line is a return.
 *
 * The excerpt is verbatim from the LRC-revised s.76
 * (catalogue/vatca-2010-revised/s076.json); `deriveVatScopeRules` refuses
 * any that is not.
 */
import type { CuratedVatScopeRule } from './vatScopeCuration';

export const RETURN_DUE_RULE_KEY = 'vat.return_due_within_9_days';

const VATCA_COMMENCEMENT = '2010-11-01';

export const RETURNS_CURATED_RULES: CuratedVatScopeRule[] = [
  {
    citation: '2010 Act 31 s.76',
    sectionNumber: '76',
    ruleKey: RETURN_DUE_RULE_KEY,
    ruleType: 'reporting',
    topic: 'vat_return',
    name: 'The return and remittance are due within 9 days after the 10th of the following month (s.76(1))',
    statementExcerpt: 'an accountable person shall, within 9 days immediately after the 10th day of the\nmonth immediately following a taxable period',
    conditions: [],
    exceptions: [
      {
        condition: 'the return is filed and paid electronically (s.78(2), mandatory for VAT, S.I. 156/2012)',
        effect: '13 days instead of 9 — see vat.mandatory_electronic_filing',
      },
      {
        condition: 'the person is registered under an OSS scheme (ss.91C, 91E, 91K)',
        effect: 'the scheme\'s own return dates apply instead',
      },
    ],
    crossReferences: [
      'VATCA 2010 s.78(2) (electronic returns: 13 days)',
      'S.I. 156/2012 reg. 8 (mandatory electronic filing; vat.mandatory_electronic_filing)',
      'src/domain/vat/rtd.ts (the return this section is the legal basis of)',
    ],
    treatment: null,
    vatEffect: 'A true and correct return of the tax due and deductible for the taxable period is furnished to the '
      + 'Collector-General, and the tax payable remitted with it, within 9 days after the 10th day of the month '
      + 'following the period. Electronic filers have 13 days (s.78(2)).',
    accountingEffect: null,
    reportingEffect: 'The return for a period is the RTD (VAT3): its figures come from the posted VAT entries of the '
      + 'period, never recomputed.',
    effectiveFrom: VATCA_COMMENCEMENT,
    interpretationNote: 'Return-level fact, not a transaction classification: the `vat_return` topic keeps it out of '
      + 'transaction lookups. The period-lock machinery (assertVatPeriodWritable) enforces that a filed return is '
      + 'never changed afterwards.',
  },
];
