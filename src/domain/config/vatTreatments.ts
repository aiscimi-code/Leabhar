/**
 * Default Irish VAT treatments and rates (README §6, §7).
 *
 * Two principles govern this file:
 *
 *  1. Nothing here is hard-coded into application logic. These are seed rows
 *     for editable configuration tables. The engine reads the database, never
 *     this module, once a company is set up.
 *
 *  2. A transaction carries a *treatment*, not merely a percentage. Zero-rated,
 *     exempt and outside-scope all produce no VAT, and all three are different:
 *     zero-rated supplies are taxable and go into the VAT3 net boxes, exempt
 *     supplies are not taxable and restrict input recovery, and outside-scope
 *     supplies are not Irish VAT transactions at all.
 *
 * `sourceNote` and `sourceDate` record where each default came from and when it
 * was last checked, and are shown in the UI (README §48). They are a statement
 * about the seed value, not a guarantee that the rate is current — rates change,
 * and the user is expected to verify and edit them.
 */

export interface TaxRateSeed {
  code: string;
  name: string;
  rateBasisPoints: number;
  taxType: 'vat' | 'corporation_tax';
  jurisdiction: string;
  effectiveFrom: string;
  reportingClassification?: string;
  isDefault?: boolean;
  notes?: string;
  sourceNote?: string;
}

/**
 * Irish VAT rates as at the seed date. Every one is editable, and the system
 * supports historical rates: changing a rate creates a new effective-dated row
 * rather than altering the old one, so historical transactions keep the rate
 * that applied when they occurred.
 */
export const DEFAULT_TAX_RATES: TaxRateSeed[] = [
  {
    code: 'VAT_STD', name: 'VAT standard rate', rateBasisPoints: 2300,
    taxType: 'vat', jurisdiction: 'IE', effectiveFrom: '2021-03-01',
    reportingClassification: 'standard', isDefault: true,
    sourceNote: 'Irish standard VAT rate. Verify against current Revenue guidance before filing.',
  },
  {
    code: 'VAT_RED', name: 'VAT reduced rate', rateBasisPoints: 1350,
    taxType: 'vat', jurisdiction: 'IE', effectiveFrom: '2021-03-01',
    reportingClassification: 'reduced',
    sourceNote: 'Irish reduced VAT rate. Applies to specified goods and services only.',
  },
  {
    code: 'VAT_SECOND_RED', name: 'VAT second reduced rate', rateBasisPoints: 900,
    taxType: 'vat', jurisdiction: 'IE', effectiveFrom: '2021-03-01',
    reportingClassification: 'second_reduced',
    sourceNote: 'Irish second reduced VAT rate. Scope has changed repeatedly in recent years — check before use.',
  },
  {
    code: 'VAT_LIVESTOCK', name: 'VAT livestock rate', rateBasisPoints: 480,
    taxType: 'vat', jurisdiction: 'IE', effectiveFrom: '2021-03-01',
    reportingClassification: 'livestock',
    sourceNote: 'Irish livestock VAT rate. Unlikely to apply to a technology company; seeded for completeness.',
  },
  {
    code: 'VAT_ZERO', name: 'VAT zero rate', rateBasisPoints: 0,
    taxType: 'vat', jurisdiction: 'IE', effectiveFrom: '2021-03-01',
    reportingClassification: 'zero',
    notes: 'Zero-rated supplies are taxable at 0%. They are not the same as exempt supplies.',
  },
  {
    code: 'VAT_NONE', name: 'No VAT', rateBasisPoints: 0,
    taxType: 'vat', jurisdiction: 'IE', effectiveFrom: '2021-03-01',
    reportingClassification: 'none',
    notes: 'Used by treatments where no rate applies at all, such as exempt and outside-scope.',
  },
  {
    code: 'CT_TRADING', name: 'Corporation tax — trading income', rateBasisPoints: 1250,
    taxType: 'corporation_tax', jurisdiction: 'IE', effectiveFrom: '2003-01-01',
    reportingClassification: 'trading',
    sourceNote: 'Irish corporation tax rate on trading income. A higher rate applies to '
      + 'non-trading (passive) income, and large groups may fall under separate rules. '
      + 'This system prepares figures; it does not compute your final liability.',
  },
  {
    code: 'CT_PASSIVE', name: 'Corporation tax — passive income', rateBasisPoints: 2500,
    taxType: 'corporation_tax', jurisdiction: 'IE', effectiveFrom: '2003-01-01',
    reportingClassification: 'passive',
    sourceNote: 'Irish corporation tax rate on non-trading income such as interest and rent.',
  },
];

export interface VatTreatmentSeed {
  code: string;
  name: string;
  description: string;
  jurisdiction: 'IE' | 'EU' | 'NON_EU';
  direction: 'sales' | 'purchases' | 'both';
  supplyKind: 'goods' | 'services' | 'both';
  appliesRate: boolean;
  defaultRateCode: string;
  isReverseCharge?: boolean;
  isRecoverable?: boolean;
  recoverableBasisPoints?: number;
  salesVatBox?: string;
  purchasesVatBox?: string;
  netSalesBox?: string;
  netPurchasesBox?: string;
  requiresCounterpartyVatNumber?: boolean;
  isDefault?: boolean;
  isSystem?: boolean;
  sourceNote?: string;
}

/**
 * VAT3 boxes, for reference:
 *
 *   T1   VAT on sales (output VAT)
 *   T2   VAT on purchases (input VAT)
 *   T3   Net payable, where T1 exceeds T2
 *   T4   Net repayable, where T2 exceeds T1
 *   E1   Goods dispatched to other EU member states (net value)
 *   E2   Goods acquired from other EU member states (net value)
 *   ES1  Services supplied to other EU member states (net value)
 *   ES2  Services received from other EU member states (net value)
 *   PA1  Goods imported under postponed accounting (net value)
 *
 * T3 and T4 are derived from T1 and T2 rather than being mapped from a
 * treatment, which is why no treatment below names them.
 */
export const DEFAULT_VAT_TREATMENTS: VatTreatmentSeed[] = [
  {
    code: 'IE_STD', name: 'Irish standard rate', isDefault: true, isSystem: true,
    description: 'Standard-rated Irish supply. The default treatment for most domestic '
      + 'sales and purchases.',
    jurisdiction: 'IE', direction: 'both', supplyKind: 'both',
    appliesRate: true, defaultRateCode: 'VAT_STD',
    salesVatBox: 'T1', purchasesVatBox: 'T2',
  },
  {
    code: 'IE_RED', name: 'Irish reduced rate', isSystem: true,
    description: 'Reduced-rate Irish supply, for the specified categories that qualify.',
    jurisdiction: 'IE', direction: 'both', supplyKind: 'both',
    appliesRate: true, defaultRateCode: 'VAT_RED',
    salesVatBox: 'T1', purchasesVatBox: 'T2',
  },
  {
    code: 'IE_SECOND_RED', name: 'Irish second reduced rate', isSystem: true,
    description: 'Second reduced-rate Irish supply.',
    jurisdiction: 'IE', direction: 'both', supplyKind: 'both',
    appliesRate: true, defaultRateCode: 'VAT_SECOND_RED',
    salesVatBox: 'T1', purchasesVatBox: 'T2',
  },
  {
    code: 'IE_ZERO', name: 'Irish zero-rated', isSystem: true,
    description: 'A taxable supply charged at 0%. VAT is chargeable in principle, which '
      + 'means the supply is still reported and related input VAT remains recoverable. '
      + 'This is materially different from an exempt supply.',
    jurisdiction: 'IE', direction: 'both', supplyKind: 'both',
    appliesRate: true, defaultRateCode: 'VAT_ZERO',
    salesVatBox: 'T1', purchasesVatBox: 'T2',
  },
  {
    code: 'IE_LIVESTOCK', name: 'Irish livestock rate', isSystem: true,
    description: 'The supply of livestock (VATCA s.46(1)(d)): cattle, sheep, goats, pigs and deer, and horses '
      + 'normally intended for foodstuffs or agricultural production (s.2(1)).',
    jurisdiction: 'IE', direction: 'both', supplyKind: 'goods',
    appliesRate: true, defaultRateCode: 'VAT_LIVESTOCK',
    salesVatBox: 'T1', purchasesVatBox: 'T2',
  },
  {
    code: 'IE_EXEMPT', name: 'Exempt', isSystem: true,
    description: 'An exempt supply, such as certain financial or insurance services. '
      + 'No VAT arises and, unlike a zero-rated supply, exempt activity can restrict '
      + 'the recovery of related input VAT.',
    jurisdiction: 'IE', direction: 'both', supplyKind: 'both',
    appliesRate: false, defaultRateCode: 'VAT_NONE',
    isRecoverable: false, recoverableBasisPoints: 0,
  },
  {
    code: 'OUT_OF_SCOPE', name: 'Outside the scope of VAT', isSystem: true,
    description: 'Not a VAT transaction at all — bank transfers between own accounts, '
      + 'salary payments, dividends, director loan movements. Reported nowhere on the VAT3.',
    jurisdiction: 'IE', direction: 'both', supplyKind: 'both',
    appliesRate: false, defaultRateCode: 'VAT_NONE',
    isRecoverable: false, recoverableBasisPoints: 0,
  },

  // ---- EU ----
  {
    code: 'EU_GOODS_ACQ', name: 'EU acquisition of goods (reverse charge)', isSystem: true,
    description: 'Goods acquired from a VAT-registered business in another EU member '
      + 'state. You self-account: output VAT in T1 and, where recoverable, the same '
      + 'amount as input VAT in T2, with the net value in E2. Usually VAT-neutral in cash terms.',
    jurisdiction: 'EU', direction: 'purchases', supplyKind: 'goods',
    appliesRate: true, defaultRateCode: 'VAT_STD',
    isReverseCharge: true, salesVatBox: 'T1', purchasesVatBox: 'T2', netPurchasesBox: 'E2',
    requiresCounterpartyVatNumber: true,
    sourceNote: 'Intra-Community acquisition. Requires the supplier’s VAT number.',
  },
  {
    code: 'EU_SERVICES_RCV', name: 'EU services received (reverse charge)', isSystem: true,
    description: 'Services received from a business in another EU member state under the '
      + 'general place-of-supply rule. You self-account: T1 and T2, net value in ES2. '
      + 'This is the usual treatment for EU-based SaaS and hosting suppliers.',
    jurisdiction: 'EU', direction: 'purchases', supplyKind: 'services',
    appliesRate: true, defaultRateCode: 'VAT_STD',
    isReverseCharge: true, salesVatBox: 'T1', purchasesVatBox: 'T2', netPurchasesBox: 'ES2',
    requiresCounterpartyVatNumber: true,
  },
  {
    code: 'EU_GOODS_SUPPLY', name: 'Intra-Community supply of goods', isSystem: true,
    description: 'Goods dispatched to a VAT-registered business in another EU member '
      + 'state. Zero-rated where the conditions are met, with the net value in E1. '
      + 'The customer’s VAT number must be held and valid.',
    jurisdiction: 'EU', direction: 'sales', supplyKind: 'goods',
    appliesRate: true, defaultRateCode: 'VAT_ZERO',
    salesVatBox: 'T1', netSalesBox: 'E1', requiresCounterpartyVatNumber: true,
  },
  {
    code: 'EU_SERVICES_SUPPLY', name: 'Services supplied to EU business', isSystem: true,
    description: 'Services supplied to a business customer in another EU member state. '
      + 'The customer accounts for the VAT; you report the net value in ES1.',
    jurisdiction: 'EU', direction: 'sales', supplyKind: 'services',
    appliesRate: true, defaultRateCode: 'VAT_ZERO',
    salesVatBox: 'T1', netSalesBox: 'ES1', requiresCounterpartyVatNumber: true,
  },

  // ---- Non-EU ----
  {
    code: 'NON_EU_SERVICES_RCV', name: 'Non-EU services received (reverse charge)', isSystem: true,
    description: 'Services received from a supplier outside the EU. You self-account '
      + 'for Irish VAT: T1 and T2. This is the usual treatment for US SaaS suppliers '
      + 'billing a VAT-registered Irish business.',
    jurisdiction: 'NON_EU', direction: 'purchases', supplyKind: 'services',
    appliesRate: true, defaultRateCode: 'VAT_STD',
    isReverseCharge: true, salesVatBox: 'T1', purchasesVatBox: 'T2',
  },
  {
    code: 'NON_EU_SERVICES_SUPPLY', name: 'Services supplied outside the EU', isSystem: true,
    description: 'Services supplied to a customer outside the EU. Generally outside the '
      + 'scope of Irish VAT under the place-of-supply rules.',
    jurisdiction: 'NON_EU', direction: 'sales', supplyKind: 'services',
    appliesRate: true, defaultRateCode: 'VAT_ZERO',
    salesVatBox: 'T1',
  },
  {
    code: 'IMPORT_PA', name: 'Import — postponed accounting', isSystem: true,
    description: 'Goods imported from outside the EU where postponed accounting is used: '
      + 'import VAT is self-accounted on the VAT3 (T1 and T2, net value in PA1) rather '
      + 'than paid at the point of entry. Requires an EORI number and authorisation.',
    jurisdiction: 'NON_EU', direction: 'purchases', supplyKind: 'goods',
    appliesRate: true, defaultRateCode: 'VAT_STD',
    isReverseCharge: true, salesVatBox: 'T1', purchasesVatBox: 'T2', netPurchasesBox: 'PA1',
    sourceNote: 'Postponed accounting for import VAT. Check your authorisation status before using.',
  },
  {
    code: 'IMPORT_VAT_PAID', name: 'Import VAT paid at entry', isSystem: true,
    description: 'Import VAT actually paid to Revenue or a customs agent at the point of '
      + 'entry, reclaimed as input VAT in T2. There is no corresponding output entry, '
      + 'because the VAT was paid rather than self-accounted.',
    jurisdiction: 'NON_EU', direction: 'purchases', supplyKind: 'goods',
    appliesRate: true, defaultRateCode: 'VAT_STD',
    purchasesVatBox: 'T2',
  },
  {
    code: 'RC_CONSTRUCTION', name: 'Domestic reverse charge (construction)', isSystem: true,
    description: 'Irish domestic reverse charge for construction services between '
      + 'principal and subcontractor under Relevant Contracts Tax.',
    jurisdiction: 'IE', direction: 'purchases', supplyKind: 'services',
    appliesRate: true, defaultRateCode: 'VAT_STD',
    isReverseCharge: true, salesVatBox: 'T1', purchasesVatBox: 'T2',
  },
  {
    code: 'NON_DEDUCTIBLE', name: 'Non-deductible VAT', isSystem: true,
    description: 'Irish VAT charged by the supplier that cannot be reclaimed — for '
      + 'example petrol, entertainment and most passenger motor vehicles. The VAT is '
      + 'charged and forms part of the cost, so it is not reported in T2.',
    jurisdiction: 'IE', direction: 'purchases', supplyKind: 'both',
    appliesRate: true, defaultRateCode: 'VAT_STD',
    isRecoverable: false, recoverableBasisPoints: 0,
    sourceNote: 'Blocked input VAT. The categories are set by law — confirm before relying on this.',
  },
];

export const VAT3_BOXES = {
  T1: 'VAT on sales',
  T2: 'VAT on purchases',
  T3: 'Net payable',
  T4: 'Net repayable',
  E1: 'Goods dispatched to other EU member states',
  E2: 'Goods acquired from other EU member states',
  ES1: 'Services supplied to other EU member states',
  ES2: 'Services received from other EU member states',
  PA1: 'Goods imported under postponed accounting',
} as const;

export type Vat3Box = keyof typeof VAT3_BOXES;
