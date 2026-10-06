/**
 * The statutory rule keys this area reads, declared (ADR-0020 §4, issue #686
 * step 5). `resolveRuleFigure` accepts only a declared key, so a figure read
 * but not listed here fails the typecheck; `consumers.test.ts` checks every
 * rule key the source names is listed, and every listed key exists. The
 * manifests load as `consumed_by` links, so `impact` lists the computation.
 */

/** The statutory tax outflows in the forecast (taxOutflows.ts). */
export const FORECAST_RULE_KEYS = [
  'ct.return_filing_date', 'income_tax.preliminary_tax_date', 'income_tax.return_date', 'rct.return_due_date',
  'rct.return_due_date_electronic',
] as const;
