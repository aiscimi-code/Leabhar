/**
 * Comprehensive transaction rule verification script.
 * 
 * This script ingests the full rule KB, approves all rules to 'active' status
 * (simulating a human reviewer approving AI-extracted rules), then runs a suite
 * of positive and negative transaction scenarios through lookupTransactionRules
 * to verify each rule fires (or doesn't fire) correctly.
 * 
 * Key insight: `reviewRequired=true` is the DESIGNED behavior when:
 * - A rule has requiresGuidance=true (depends on guidance not in KB)
 * - A rule has humanReviewRequired=true (AI-extracted, not yet approved)
 * - A rule has exceptions (statutory carve-outs the system doesn't evaluate)
 * - Transaction data is incomplete (unresolved fields)
 * - No rules matched at all
 * 
 * The test expectations reflect this: many "passed" tests expect reviewRequired=true
 * because the system correctly identifies that human review IS needed.
 */
import { readFileSync } from "node:fs";
import { createTestDatabase } from "@/db/testing";
import { createCompany } from "@/domain/config/setup";
import { ingestFinanceAct2024, deriveTaxRules } from "@/domain/rules/irishRules";
import { ingestVatca2010, deriveVatcaRules } from "@/domain/rules/vatcaIngestion";
import { ingestVatcaRevisedSection, deriveVatcaRevisedRules } from "@/domain/rules/vatcaRevisedIngestion";
import { ingestVatcaSchedule, deriveVatcaScheduleRules } from "@/domain/rules/vatcaScheduleIngestion";
import { ingestSi692025Reg5, ingestSi692025Reg8, ingestSi692025Reg9, deriveSi692025Rules } from "@/domain/rules/si692025Ingestion";
import { deriveFinanceAct2024VatThresholds } from "@/domain/rules/financeAct2024VatThresholdsIngestion";
import { ingestSi639, deriveSi639Rules } from "@/domain/rules/si639Ingestion";
import { ingestSi156, deriveSi156Rules } from "@/domain/rules/si156Ingestion";
import { ingestTca1997S284, deriveCapitalAllowancesRules } from "@/domain/rules/capitalAllowancesIngestion";
import { ingestRctTdm18_02_04, ingestRctTdm18_02_05, ingestRctTdm18_02_11, deriveRctRules } from "@/domain/rules/rctIngestion";
import { ingestTdm3801_03bCapacityExclusion, deriveTdm3801_03bCapacityExclusionRule } from "@/domain/rules/tdm3801_03bIngestion";
import { lookupTransactionRules, type TransactionContext, identifyTopics } from "@/domain/rules/transactionLookup";
import { setRuleReviewStatus } from "@/domain/rules/review";
import { irishTaxRules } from "@/db/schema";
import { eq } from "drizzle-orm";

// === SETUP ===
const { db } = createTestDatabase();
const { companyId, accountsByCode, accountsByKey } = createCompany(db, {
  legalName: "Verification Ltd",
  vatNumber: "IE1234567T",
  vatRegistrationStatus: "registered",
  seedYears: [2025, 2026],
});

// Ingest all KB sources
const faMd = readFileSync("docs/statutes/finance-act-2024/2024-act-43-enacted.md", "utf8");
ingestFinanceAct2024(db, { companyId, markdown: faMd, ingestVersion: "v1" });
deriveTaxRules(db, { companyId });

const vatcaMd = readFileSync("docs/statutes/vatca-2010/vatca-2010-enacted.md", "utf8");
ingestVatca2010(db, { companyId, markdown: vatcaMd, ingestVersion: "v1" });
deriveVatcaRules(db, { companyId });

const s46Md = readFileSync("docs/statutes/vatca-2010-revised/s046.md", "utf8");
ingestVatcaRevisedSection(db, { companyId, markdown: s46Md, ingestVersion: "v1" });
deriveVatcaRevisedRules(db, { companyId });

ingestVatcaSchedule(db, { companyId, scheduleNumber: "2", markdown: readFileSync("docs/statutes/vatca-2010-revised/schedule-2.md", "utf8"), ingestVersion: "v1" });
ingestVatcaSchedule(db, { companyId, scheduleNumber: "3", markdown: readFileSync("docs/statutes/vatca-2010-revised/schedule-3.md", "utf8"), ingestVersion: "v1" });
deriveVatcaScheduleRules(db, { companyId, scheduleNumber: "2" });
deriveVatcaScheduleRules(db, { companyId, scheduleNumber: "3" });

const si69Md = readFileSync("docs/statutes/si-69-2025/2025-si-69.md", "utf8");
ingestSi692025Reg5(db, { companyId, markdown: si69Md, ingestVersion: "v1" });
ingestSi692025Reg8(db, { companyId, markdown: si69Md, ingestVersion: "v1" });
ingestSi692025Reg9(db, { companyId, markdown: si69Md, ingestVersion: "v1" });
deriveSi692025Rules(db, { companyId });
deriveFinanceAct2024VatThresholds(db, { companyId });

const si639Md = readFileSync("docs/statutes/si-639-2010/2010-si-639.md", "utf8");
ingestSi639(db, { companyId, markdown: si639Md, ingestVersion: "v1" });
deriveSi639Rules(db, { companyId });

const si156Md = readFileSync("docs/statutes/si-156-2012/2012-si-156.md", "utf8");
ingestSi156(db, { companyId, markdown: si156Md, ingestVersion: "v1" });
deriveSi156Rules(db, { companyId });

const tca284Md = readFileSync("docs/statutes/tca-1997/s284.md", "utf8");
ingestTca1997S284(db, { companyId, markdown: tca284Md, ingestVersion: "v1" });
deriveCapitalAllowancesRules(db, { companyId });

const rctMd = readFileSync("docs/statutes/tca-1997/s530.md", "utf8");
ingestRctTdm18_02_04(db, { companyId, markdown: rctMd, ingestVersion: "v1" });
ingestRctTdm18_02_05(db, { companyId, markdown: rctMd, ingestVersion: "v1" });
ingestRctTdm18_02_11(db, { companyId, markdown: rctMd, ingestVersion: "v1" });
deriveRctRules(db, { companyId });

const tdmMd = readFileSync("docs/statutes/tdm-38-01-03b/38-01-03b.md", "utf8");
ingestTdm3801_03bCapacityExclusion(db, { companyId, markdown: tdmMd, ingestVersion: "v1" });
deriveTdm3801_03bCapacityExclusionRule(db, { companyId });

// === LIST ALL RULES ===
const allRules = db.select({
  id: irishTaxRules.id,
  ruleKey: irishTaxRules.ruleKey,
  name: irishTaxRules.name,
  topic: irishTaxRules.topic,
  ruleType: irishTaxRules.ruleType,
  active: irishTaxRules.active,
  reviewStatus: irishTaxRules.reviewStatus,
  humanReviewRequired: irishTaxRules.humanReviewRequired,
  requiresGuidance: irishTaxRules.requiresGuidance,
  effectiveFrom: irishTaxRules.effectiveFrom,
  effectiveTo: irishTaxRules.effectiveTo,
  conditions: irishTaxRules.conditions,
  vatEffect: irishTaxRules.vatEffect,
  accountingEffect: irishTaxRules.accountingEffect,
  taxEffect: irishTaxRules.taxEffect,
  exceptions: irishTaxRules.exceptions,
}).from(irishTaxRules).where(eq(irishTaxRules.companyId, companyId)).all();

// Approve all active rules to 'active' status (simulating human review)
const approvedRules = [];
for (const rule of allRules) {
  if (rule.active && rule.effectiveTo === null) {
    if (rule.humanReviewRequired) {
      setRuleReviewStatus(db, { ruleId: rule.id, status: "active", reviewedBy: "verification-script" });
    }
    approvedRules.push({
      ...rule,
      reviewStatus: "active",
      humanReviewRequired: false,
    });
  } else {
    approvedRules.push(rule);
  }
}

// === DEFINE TRANSACTION TEST CASES ===
interface TestCase {
  id: string;
  description: string;
  businessType?: string;
  transaction: TransactionContext;
  expectedRuleKeys: string[];
  notExpectedRuleKeys?: string[];
  expectedTopics?: string[];
  /** Whether reviewRequired should be true. */
  reviewRequired: boolean;
}

const testCases: TestCase[] = [
  // === VAT RATE RULES ===

  // 1. Irish standard-rated domestic sale (23% output VAT)
  {
    id: "tc01-domestic-sale-standard-rate",
    description: "Irish standard-rated domestic sale at 23%",
    businessType: "Irish VAT-registered retailer",
    transaction: {
      transactionDate: "2025-06-15",
      amountMinor: 12300,
      currency: "EUR",
      entityType: "Irish_LTD",
      vatRegistered: true,
      transactionType: "sale_invoice",
      description: "Software license to Irish customer",
      businessUsePercent: 100,
      invoiceAvailable: true,
    },
    expectedRuleKeys: ["vat.rate_standard_current"],
    expectedTopics: ["vat"],
    reviewRequired: true, // requiresGuidance=true for vat.charge_general, vat.mandatory_electronic_filing, etc.
  },

  // 2. Irish standard-rated domestic purchase (23% recoverable input VAT)
  {
    id: "tc02-domestic-purchase-standard-rate",
    description: "Irish standard-rated domestic purchase with recoverable input VAT",
    businessType: "Irish VAT-registered retailer",
    transaction: {
      transactionDate: "2025-06-15",
      amountMinor: 12300,
      currency: "EUR",
      entityType: "Irish_LTD",
      vatRegistered: true,
      transactionType: "purchase_invoice",
      description: "Purchase of standard rated goods from Irish supplier",
      businessUsePercent: 100,
      invoiceAvailable: true,
    },
    expectedRuleKeys: ["vat.input_deduction_general", "vat.rate_standard_current"],
    expectedTopics: ["vat"],
    reviewRequired: true, // requiresGuidance=true for multiple rules
  },

  // 3. US SaaS reverse charge (services from abroad)
  {
    id: "tc03-us-saas-reverse-charge",
    description: "US SaaS service with reverse charge mechanism",
    businessType: "Irish VAT-registered business buying digital services",
    transaction: {
      transactionDate: "2025-06-15",
      amountMinor: 123000,
      currency: "EUR",
      entityType: "Irish_LTD",
      vatRegistered: true,
      supplierCountry: "US",
      supplierType: "software_service",
      transactionType: "AI_SaaS",
      supplyType: "services",
      description: "Anthropic API credits",
      businessUsePercent: 100,
      invoiceAvailable: true,
    },
    expectedRuleKeys: [
      "vat.reverse_charge_services_from_abroad",
      "vat.place_of_supply_b2b_general",
      "vat.input_deduction_general",
      "vat.rate_standard_current",
    ],
    expectedTopics: ["vat"],
    reviewRequired: true, // requiresGuidance=true for multiple rules
  },

  // 4. Zero-rated export outside EU
  {
    id: "tc04-export-zero-rated",
    description: "Zero-rated export supply of goods outside the EU",
    businessType: "Irish exporter",
    transaction: {
      transactionDate: "2025-06-15",
      amountMinor: 100000,
      currency: "EUR",
      entityType: "Irish_LTD",
      vatRegistered: true,
      supplyType: "goods",
      supplierCountry: "IE",
      transactionType: "sale_invoice",
      description: "Export of widgets to US customer, shipped directly",
      goodsExportedOutsideEu: true,
      invoiceAvailable: true,
    },
    expectedRuleKeys: ["vat.zero_rate_export_outside_community"],
    expectedTopics: ["vat"],
    reviewRequired: true, // requiresGuidance=true for vat.charge_general, vat.mandatory_electronic_filing, vat.cash_accounting_*, vat.zero_rate_export
  },

  // 5. Livestock supply (4.8% rate)
  {
    id: "tc05-livestock-supply",
    description: "Livestock supply qualifying for 4.8% rate",
    businessType: "Irish farmer/grocer",
    transaction: {
      transactionDate: "2025-06-15",
      amountMinor: 500000,
      currency: "EUR",
      entityType: "Irish_LTD",
      vatRegistered: true,
      supplyType: "goods",
      description: "Sale of cattle at the mart",
      invoiceAvailable: true,
    },
    expectedRuleKeys: ["vat.rate_livestock_current"],
    expectedTopics: ["vat"],
    reviewRequired: true, // requiresGuidance=true for several rules
  },

  // 6. Capital purchase of equipment
  {
    id: "tc06-capital-purchase-equipment",
    description: "Capital purchase of computer equipment (capital allowances)",
    businessType: "Irish VAT-registered business",
    transaction: {
      transactionDate: "2025-06-15",
      amountMinor: 123000,
      currency: "EUR",
      entityType: "Irish_LTD",
      vatRegistered: true,
      transactionType: "capital_purchase",
      description: "Purchase of computer equipment from Irish supplier",
      businessUsePercent: 100,
      invoiceAvailable: true,
      isCapitalExpenditure: true,
    },
    expectedRuleKeys: ["income_tax.wear_and_tear_allowance_qualifies"],
    expectedTopics: ["capital_allowances", "vat"],
    reviewRequired: true, // requiresGuidance=true for multiple rules + exceptions on wear_and_tear
  },

  // 7. Director loan advance (non-trading)
  {
    id: "tc07-director-loan-advance",
    description: "Director introduces funds via loan (non-trading)",
    businessType: "Irish private limited company",
    transaction: {
      transactionDate: "2025-06-15",
      amountMinor: 100000,
      currency: "EUR",
      entityType: "Irish_LTD",
      vatRegistered: true,
      transactionType: "director_loan",
      description: "Director loan advance by cheque",
      invoiceAvailable: true,
    },
    expectedTopics: ["director_transaction"],
    notExpectedRuleKeys: ["vat.rate_standard_current", "vat.input_deduction_general"],
    expectedRuleKeys: [], // No matching rules (no rule for director loans in KB)
    reviewRequired: true, // No matching rules => reviewRequired=true
  },

  // 8. Bank charge with input VAT
  {
    id: "tc08-bank-charge-deductible",
    description: "Bank charge with input VAT, deductible under general rule",
    businessType: "Irish VAT-registered business",
    transaction: {
      transactionDate: "2025-06-15",
      amountMinor: 5000,
      currency: "EUR",
      entityType: "Irish_LTD",
      vatRegistered: true,
      transactionType: "bank_charge",
      description: "Bank of Ireland monthly charge",
      businessUsePercent: 100,
      invoiceAvailable: true,
    },
    expectedRuleKeys: ["vat.input_deduction_general", "vat.rate_standard_current"],
    expectedTopics: ["vat", "banking"],
    reviewRequired: true, // requiresGuidance=true for multiple rules
  },

  // 9. Restaurant meal (13.5% reduced rate before July 2026)
  {
    id: "tc09-restaurant-meal-reduced",
    description: "Restaurant meal qualifying for 13.5% reduced rate (before July 2026)",
    businessType: "Irish restaurant/café (VAT-registered)",
    transaction: {
      transactionDate: "2026-06-15",
      amountMinor: 4500,
      currency: "EUR",
      entityType: "Irish_LTD",
      vatRegistered: true,
      supplyType: "services",
      description: "Restaurant meal with a client",
      invoiceAvailable: true,
    },
    expectedRuleKeys: ["vat.rate_restaurant_catering_reduced_current"],
    expectedTopics: ["vat"],
    reviewRequired: true, // humanReviewRequired=true (ai_extracted) + requiresGuidance=true
  },

  // 10. Restaurant meal on/after July 2026 (9% not modelled)
  {
    id: "tc10-restaurant-meal-post-july2026",
    description: "Restaurant meal after July 2026 — 9% rate not modelled, gap flagged",
    businessType: "Irish restaurant/café (VAT-registered)",
    transaction: {
      transactionDate: "2026-07-02",
      amountMinor: 4500,
      currency: "EUR",
      entityType: "Irish_LTD",
      vatRegistered: true,
      supplyType: "services",
      description: "Restaurant meal with a client",
      invoiceAvailable: true,
    },
    expectedRuleKeys: ["vat.rate_hospitality_9pct_not_modelled"],
    notExpectedRuleKeys: ["vat.rate_standard_current", "vat.rate_reduced_current"],
    expectedTopics: ["vat"],
    reviewRequired: true, // requiresGuidance=true for multiple rules
  },

  // 11. Entertainment exclusion (no VAT deduction)
  {
    id: "tc11-entertainment-exclusion",
    description: "Client restaurant entertainment — VAT deduction excluded",
    businessType: "Irish VAT-registered business (entertainment)",
    transaction: {
      transactionDate: "2025-06-15",
      amountMinor: 4500,
      currency: "EUR",
      entityType: "Irish_LTD",
      vatRegistered: true,
      supplyType: "services",
      description: "Client restaurant entertainment meal",
      businessUsePercent: 100,
      invoiceAvailable: true,
    },
    expectedRuleKeys: ["vat.deduction_exclusions_entertainment"],
    notExpectedRuleKeys: ["vat.input_deduction_general"],
    expectedTopics: ["vat"],
    reviewRequired: true, // requiresGuidance=true for multiple rules + exceptions on deduction_exclusions_entertainment
  },

  // 12. Petrol purchase (no VAT deduction)
  {
    id: "tc12-petrol-exclusion",
    description: "Petrol for company car — VAT deduction excluded",
    businessType: "Irish VAT-registered transport business",
    transaction: {
      transactionDate: "2025-06-15",
      amountMinor: 8000,
      currency: "EUR",
      entityType: "Irish_LTD",
      vatRegistered: true,
      supplyType: "goods",
      description: "Petrol for company car",
      businessUsePercent: 100,
      invoiceAvailable: true,
    },
    expectedRuleKeys: ["vat.deduction_exclusions_entertainment"],
    notExpectedRuleKeys: ["vat.input_deduction_general"],
    expectedTopics: ["vat"],
    reviewRequired: true, // requiresGuidance=true for multiple rules + exceptions
  },

  // === VAT REGISTRATION THRESHOLDS ===

  // 13. VAT registration threshold — services exceeded
  {
    id: "tc13-reg-threshold-services-exceeded",
    description: "Unregistered trader exceeding €42,500 services threshold",
    businessType: "Unregistered sole trader (services)",
    transaction: {
      transactionDate: "2026-09-18",
      amountMinor: 500000,
      currency: "EUR",
      vatRegistered: false,
      supplyType: "services",
      description: "Consulting",
      annualTurnoverCurrentYearMinor: 5_000_000, // €50,000, over the €42,500 threshold
    },
    expectedRuleKeys: ["vat.registration_threshold_services"],
    expectedTopics: ["vat"],
    reviewRequired: true, // requiresGuidance=true for vat.charge_general, cash_accounting rules
  },

  // 14. VAT registration threshold — services below threshold
  {
    id: "tc14-reg-threshold-services-below",
    description: "Unregistered trader below €42,500 services threshold",
    businessType: "Unregistered sole trader (services)",
    transaction: {
      transactionDate: "2026-09-18",
      amountMinor: 500000,
      currency: "EUR",
      vatRegistered: false,
      supplyType: "services",
      description: "Consulting",
      annualTurnoverCurrentYearMinor: 1_000_000, // €10,000, below threshold
    },
    notExpectedRuleKeys: ["vat.registration_threshold_services"],
    expectedTopics: ["vat"],
    expectedRuleKeys: [],
    reviewRequired: true, // still requiresGuidance for other rules like vat.charge_general
  },

  // 15. VAT registration threshold — goods with >90% goods share
  {
    id: "tc15-reg-threshold-goods-exceeded",
    description: "Unregistered trader exceeding €85,000 goods threshold with >90% goods share",
    businessType: "Unregistered retailer (goods)",
    transaction: {
      transactionDate: "2026-09-18",
      amountMinor: 500000,
      currency: "EUR",
      vatRegistered: false,
      supplyType: "goods",
      description: "Kitchen units supply and fit",
      annualTurnoverCurrentYearMinor: 9_000_000, // €90,000
      goodsShareOfAnnualTurnoverPercent: 95,
    },
    expectedRuleKeys: ["vat.registration_threshold_goods"],
    expectedTopics: ["vat"],
    reviewRequired: true, // requiresGuidance=true for other rules
  },

  // 16. VAT registration threshold — mixed trader below 90% goods share
  {
    id: "tc16-reg-threshold-mixed-trader",
    description: "Mixed trader below 90% goods share — goods threshold does NOT fire",
    businessType: "Unregistered mixed trader (goods + services)",
    transaction: {
      transactionDate: "2026-09-18",
      amountMinor: 500000,
      currency: "EUR",
      vatRegistered: false,
      supplyType: "goods",
      description: "Kitchen units supply and fit",
      annualTurnoverCurrentYearMinor: 8_200_000, // €82,000
      goodsShareOfAnnualTurnoverPercent: 70, // below 90%
    },
    notExpectedRuleKeys: ["vat.registration_threshold_goods"],
    expectedTopics: ["vat"],
    expectedRuleKeys: [],
    reviewRequired: true, // requiresGuidance=true for other rules
  },

  // === NEGATIVE / INVALID INPUTS ===

  // 17. Invalid supplier country (not a real ISO code)
  {
    id: "tc17-invalid-country-code",
    description: "Invalid supplier country code does not proxy as 'established outside State'",
    businessType: "Irish VAT-registered business",
    transaction: {
      transactionDate: "2026-09-18",
      amountMinor: 123000,
      currency: "EUR",
      vatRegistered: true,
      supplyType: "services",
      supplierCountry: "XX", // Invalid ISO code
      supplierType: "software_service",
      transactionType: "AI_SaaS",
    },
    notExpectedRuleKeys: ["vat.reverse_charge_services_from_abroad"],
    reviewRequired: true, // unresolved field supplierCountry
  },

  // 18. Non-trading bank narrative — funds introduced
  {
    id: "tc18-non-trading-funds-introduced",
    description: "Director funds introduced — no VAT rate applied",
    businessType: "Irish private limited company",
    transaction: {
      transactionDate: "2026-09-18",
      amountMinor: 500000,
      currency: "EUR",
      vatRegistered: true,
      description: "Funds introduced by director",
    },
    notExpectedRuleKeys: ["vat.rate_standard_current"],
    expectedTopics: ["director_transaction", "business_expense"],
    reviewRequired: true, // no matching rules for director_transaction
  },

  // 19. Non-trading bank narrative — VAT settlement
  {
    id: "tc19-non-trading-vat-settlement",
    description: "Revenue VAT settlement payment — no VAT rate applied",
    businessType: "Irish VAT-registered business",
    transaction: {
      transactionDate: "2026-01-31",
      amountMinor: 50000,
      currency: "EUR",
      vatRegistered: true,
      description: "Revenue payment - VAT settlement",
    },
    notExpectedRuleKeys: ["vat.rate_standard_current"],
    reviewRequired: true, // no matching rules
  },

  // 20. Bare card payment (no merchant) — no VAT
  {
    id: "tc20-bare-card-payment",
    description: "Bare 'CARD PAYMENT' with no invoice — no VAT rate",
    businessType: "Irish VAT-registered business",
    transaction: {
      transactionDate: "2026-08-16",
      amountMinor: 7325,
      currency: "EUR",
      vatRegistered: true,
      description: "CARD PAYMENT",
      invoiceAvailable: false,
    },
    notExpectedRuleKeys: ["vat.rate_standard_current", "vat.rate_reduced_current"],
    reviewRequired: true, // no matching rules (non-trading narrative + bare card payment)
  },

  // 21. Unregistered trader over threshold, no turnover data
  {
    id: "tc21-threshold-no-turnover-data",
    description: "Unregistered trader with no turnover data — threshold rule unresolved",
    businessType: "Unregistered trader",
    transaction: {
      transactionDate: "2026-09-18",
      amountMinor: 500000,
      currency: "EUR",
      vatRegistered: false,
      supplyType: "services",
      description: "Consulting",
      // No annualTurnoverCurrentYearMinor supplied
    },
    notExpectedRuleKeys: ["vat.registration_threshold_services"],
    expectedTopics: ["vat"],
    reviewRequired: true, // unresolved field annualTurnoverMaxMinor
  },

  // 22. Cash basis company with description mention
  {
    id: "tc22-cash-basis-description",
    description: "Cash basis mentioned in description triggers cash-accounting rules",
    businessType: "Irish cash-basis trader",
    transaction: {
      transactionDate: "2026-09-18",
      amountMinor: 15000,
      currency: "EUR",
      entityType: "Irish_LTD",
      vatRegistered: true,
      supplyType: "services",
      description: "Plumbing repair for a customer (cash basis)",
    },
    expectedRuleKeys: ["vat.cash_accounting_turnover_threshold", "vat.cash_accounting_supplies_to_unregistered_persons_test"],
    expectedTopics: ["vat"],
    reviewRequired: true, // requiresGuidance=true for cash_accounting_requires_authorisation and other rules
  },

  // 23. Goods with no annual turnover data — goods threshold unresolved
  {
    id: "tc23-goods-threshold-no-share-data",
    description: "Goods threshold omitted — goodsShareOfAnnualTurnoverPercent unresolved",
    businessType: "Unregistered trader",
    transaction: {
      transactionDate: "2026-09-18",
      amountMinor: 500000,
      currency: "EUR",
      vatRegistered: false,
      supplyType: "goods",
      description: "Sale of goods to a new customer",
      annualTurnoverCurrentYearMinor: 9_000_000, // €90,000, over euro figure
      // goodsShareOfAnnualTurnoverPercent deliberately omitted
    },
    notExpectedRuleKeys: ["vat.registration_threshold_goods"],
    reviewRequired: true, // unresolved field goodsShareOfAnnualTurnoverPercent
  },

  // 24. Children's clothing (zero-rated)
  {
    id: "tc24-childrens-clothing-zero-rated",
    description: "Children's clothing zero-rated under Schedule 2 para 10",
    businessType: "Irish children's clothing retailer",
    transaction: {
      transactionDate: "2025-06-15",
      amountMinor: 10000,
      currency: "EUR",
      entityType: "Irish_LTD",
      vatRegistered: true,
      supplyType: "goods",
      description: "Children's clothing purchase",
      invoiceAvailable: true,
    },
    expectedRuleKeys: ["vat.zero_rate_childrens_clothing_footwear"],
    expectedTopics: ["vat"],
    reviewRequired: true, // requiresGuidance=true for other rules
  },

  // 25. Solid fuel (reduced 13.5%)
  {
    id: "tc25-solid-fuel-reduced",
    description: "Coal/peat solid fuel at 13.5% reduced rate (Schedule 3 para 17)",
    businessType: "Irish fuel retailer",
    transaction: {
      transactionDate: "2025-06-15",
      amountMinor: 5000,
      currency: "EUR",
      entityType: "Irish_LTD",
      vatRegistered: true,
      supplyType: "goods",
      description: "Purchase of coal for heating",
      invoiceAvailable: true,
    },
    expectedRuleKeys: ["vat.reduced_rate_solid_fuel"],
    expectedTopics: ["vat"],
    reviewRequired: true, // requiresGuidance=true for other rules
  },

  // 26. Dwelling repair services (13.5% reduced)
  {
    id: "tc26-dwelling-repair-reduced",
    description: "Routine cleaning of private dwelling at 13.5% reduced rate",
    businessType: "Irish property services company",
    transaction: {
      transactionDate: "2025-06-15",
      amountMinor: 10000,
      currency: "EUR",
      entityType: "Irish_LTD",
      vatRegistered: true,
      supplyType: "services",
      description: "Routine cleaning of private dwelling",
      invoiceAvailable: true,
    },
    expectedRuleKeys: ["vat.reduced_rate_dwelling_services"],
    expectedTopics: ["vat"],
    reviewRequired: true, // requiresGuidance=true for other rules
  },

  // 27. RCT candidate (construction/renovation)
  {
    id: "tc27-rct-construction-candidate",
    description: "Renovation of private dwelling — RCT scope candidate",
    businessType: "Irish building contractor",
    transaction: {
      transactionDate: "2026-09-18",
      amountMinor: 100000,
      description: "Renovation of a private dwelling house",
    },
    expectedTopics: ["rct"],
    expectedRuleKeys: ["rct.payment_notification_required", "rct.deduction_rate_not_determinable", "rct.subcontractor_compliance_criteria"],
    reviewRequired: true, // RCT rules have exceptions
  },

  // 28. Non-trading: unknown/unidentified lodgement
  {
    id: "tc28-non-trading-unknown-lodgement",
    description: "Unknown lodgement — no VAT rule applied",
    businessType: "Irish VAT-registered business",
    transaction: {
      transactionDate: "2026-09-18",
      amountMinor: 50000,
      vatRegistered: true,
      description: "Unknown lodgement, no invoice on file",
    },
    notExpectedRuleKeys: ["vat.rate_standard_current"],
    reviewRequired: true, // no matching rules
  },

  // 29. US SaaS with explicit supplierEstablishedOutsideState: false
  {
    id: "tc29-explicit-established-in-ie",
    description: "US supplier explicitly established in Ireland — no reverse charge",
    businessType: "Irish VAT-registered business",
    transaction: {
      transactionDate: "2026-09-18",
      amountMinor: 123000,
      currency: "EUR",
      vatRegistered: true,
      supplyType: "services",
      supplierCountry: "US",
      supplierEstablishedOutsideState: false,
      supplierType: "software_service",
      transactionType: "AI_SaaS",
      invoiceAvailable: true,
    },
    notExpectedRuleKeys: ["vat.reverse_charge_services_from_abroad"],
    reviewRequired: true, // requiresGuidance=true for other rules
  },

  // 30. US SaaS with explicit supplierEstablishedOutsideState: true
  {
    id: "tc30-explicit-established-outside",
    description: "IE supplier explicitly established outside — reverse charge applies",
    businessType: "Irish VAT-registered business",
    transaction: {
      transactionDate: "2026-09-18",
      amountMinor: 123000,
      currency: "EUR",
      vatRegistered: true,
      supplyType: "services",
      supplierCountry: "IE",
      supplierEstablishedOutsideState: true,
      description: "Consulting services from IE-registered supplier established abroad",
      invoiceAvailable: true,
    },
    expectedRuleKeys: ["vat.reverse_charge_services_from_abroad"],
    expectedTopics: ["vat"],
    reviewRequired: true, // requiresGuidance=true for other rules
  },

  // 31. Negative: office supplies — no topic-specific rules
  {
    id: "tc31-office-supplies-no-specific-rule",
    description: "Office supplies transaction — no specific rule matches",
    businessType: "Irish business",
    transaction: {
      transactionDate: "2025-06-01",
      amountMinor: 500,
      transactionType: "office_supplies",
      description: "Stationery order",
    },
    notExpectedRuleKeys: ["usc.first_band_threshold", "income_tax.standard_rate_threshold"],
    reviewRequired: true, // no matching rules
  },

  // 32. Invalid date — fails closed
  {
    id: "tc32-invalid-date-fails-closed",
    description: "Invalid transaction date fails closed — no rules looked up",
    businessType: "N/A (invalid input)",
    transaction: {
      transactionDate: "not-a-date",
      amountMinor: 100000,
      transactionType: "payroll",
    },
    notExpectedRuleKeys: ["usc.first_band_threshold", "vat.rate_standard_current"],
    reviewRequired: true, // invalid date => no rules looked up
  },

  // 33. Negative amount — fails closed
  {
    id: "tc33-negative-amount-fails-closed",
    description: "Negative amount fails closed — no rules looked up",
    businessType: "N/A (invalid input)",
    transaction: {
      transactionDate: "2026-09-18",
      amountMinor: -500,
      currency: "EUR",
      vatRegistered: true,
      supplyType: "services",
    },
    notExpectedRuleKeys: ["vat.input_deduction_general"],
    reviewRequired: true, // negative amount => no rules looked up
  },

  // 34. VAT not registered, no turnover data, no supplyType
  //     The vat topic IS opened (vatRegistered===false triggers the registration
  //     threshold question), but with no supplyType or turnover data, the
  //     rate/registration rules are unresolved.
  {
    id: "tc34-vat-not-registered-no-turnover",
    description: "Non-registered trader — VAT topic opened but rules unresolved without turnover or supplyType",
    businessType: "Unregistered trader",
    transaction: {
      transactionDate: "2026-09-18",
      amountMinor: 500000,
      currency: "EUR",
      vatRegistered: false,
      description: "Sale of cattle at the mart",
    },
    expectedTopics: ["vat"],
    reviewRequired: true, // unresolved fields for threshold/rate rules
  },

  // 35. US SaaS reverse charge — supplyType omitted
  {
    id: "tc35-reverse-charge-supplytype-omitted",
    description: "US SaaS with no supplyType — reverse charge unresolved, not assumed",
    businessType: "Irish VAT-registered business",
    transaction: {
      transactionDate: "2026-09-18",
      amountMinor: 123000,
      currency: "EUR",
      vatRegistered: true,
      supplierCountry: "US",
      supplierType: "software_service",
      transactionType: "AI_SaaS",
      businessUsePercent: 100,
      invoiceAvailable: true,
      // supplyType deliberately omitted
    },
    notExpectedRuleKeys: ["vat.reverse_charge_services_from_abroad"],
    reviewRequired: true, // unresolved field supplyType
  },

  // 36. Domestic service — standard rate only
  {
    id: "tc36-single-rate-domestic-service",
    description: "Domestic professional services — only standard rate, not 23%+13.5%+4.8%",
    businessType: "Irish professional services firm",
    transaction: {
      transactionDate: "2026-09-18",
      amountMinor: 100000,
      currency: "EUR",
      vatRegistered: true,
      supplyType: "services",
      description: "Legal advisory services",
    },
    expectedRuleKeys: ["vat.rate_standard_current"],
    notExpectedRuleKeys: ["vat.rate_reduced_current", "vat.rate_livestock_current"],
    expectedTopics: ["vat"],
    reviewRequired: true, // requiresGuidance=true for other rules
  },

  // === ADDITIONAL EDGE CASE TESTS ===

  // 37. Intra-community supply of goods to EU VAT-registered customer (zero-rated)
  {
    id: "tc37-intra-community-goods-zero-rated",
    description: "Intra-Community dispatch of goods to VAT-registered EU customer — zero-rated",
    businessType: "Irish B2B goods supplier",
    transaction: {
      transactionDate: "2025-06-15",
      amountMinor: 50000,
      currency: "EUR",
      entityType: "Irish_LTD",
      vatRegistered: true,
      supplyType: "goods",
      description: "Dispatch of machinery to German VAT-registered customer",
      customerCountry: "DE",
      customerVatRegisteredEu: true,
      invoiceAvailable: true,
    },
    expectedRuleKeys: ["vat.zero_rate_intra_community_goods"],
    notExpectedRuleKeys: ["vat.input_deduction_general"],
    expectedTopics: ["vat"],
    reviewRequired: true, // requiresGuidance=true for other rules
  },

  // 38. Printed books — zero-rated
  {
    id: "tc38-printed-books-zero-rated",
    description: "Printed books zero-rated under Schedule 2",
    businessType: "Irish bookseller/publisher",
    transaction: {
      transactionDate: "2025-03-10",
      amountMinor: 15000,
      currency: "EUR",
      entityType: "Irish_LTD",
      vatRegistered: true,
      supplyType: "goods",
      description: "Sale of printed books and booklets",
      invoiceAvailable: true,
    },
    expectedRuleKeys: ["vat.zero_rate_printed_books"],
    expectedTopics: ["vat"],
    reviewRequired: true, // requiresGuidance=true for other rules
  },

  // 39. RCT — meat processing subcontractor (should trigger RCT rules)
  {
    id: "tc39-rct-meat-processing",
    description: "Payment to meat processing subcontractor — RCT scope",
    businessType: "Irish meat processor",
    transaction: {
      transactionDate: "2026-09-20",
      amountMinor: 25000,
      currency: "EUR",
      entityType: "Irish_LTD",
      vatRegistered: true,
      description: "Subcontractor abattoir service payment",
      invoiceAvailable: true,
    },
    expectedTopics: ["rct"],
    expectedRuleKeys: ["rct.payment_notification_required", "rct.deduction_rate_not_determinable"],
    reviewRequired: true, // RCT rules have exceptions + requiresGuidance
  },

  // 40. Non-registered trader selling services below threshold — no VAT registered
  {
    id: "tc40-non-registered-service-below-threshold",
    description: "Non-registered trader below threshold — no VAT registration required yet",
    businessType: "Unregistered sole trader (services)",
    transaction: {
      transactionDate: "2026-09-18",
      amountMinor: 500000,
      currency: "EUR",
      vatRegistered: false,
      supplyType: "services",
      description: "Consulting services to Irish client",
      annualTurnoverCurrentYearMinor: 1_000_000, // €10,000, below €42,500
    },
    notExpectedRuleKeys: ["vat.registration_threshold_services"],
    expectedTopics: ["vat"],
    reviewRequired: true, // requiresGuidance for other matched rules
  },

  // 41. Film production — corporation tax relief
  {
    id: "tc41-film-production-tax-credit",
    description: "Film production qualifying for tax credit",
    businessType: "Irish film production company",
    transaction: {
      transactionDate: "2025-06-15",
      amountMinor: 500000,
      currency: "EUR",
      entityType: "Irish_LTD",
      vatRegistered: true,
      description: "Film production expenditure - eligible for tax credit under Film Act",
    },
    expectedRuleKeys: ["film.tax_credit_rate"],
    expectedTopics: ["corporation_tax_relief"],
    reviewRequired: true, // other matched rules require guidance
  },

  // 42. Zero amount — fails closed
  {
    id: "tc42-zero-amount-fails-closed",
    description: "Zero amount fails closed — no rules looked up",
    businessType: "N/A (invalid input)",
    transaction: {
      transactionDate: "2026-09-18",
      amountMinor: 0,
      currency: "EUR",
      vatRegistered: true,
      supplyType: "services",
    },
    notExpectedRuleKeys: ["vat.input_deduction_general"],
    reviewRequired: true, // zero amount => no rules looked up
  },

  // 43. Missing transactionDate — falls back to today
  //     The lookup uses `today()` as a fallback for a missing date, so rules ARE
  //     looked up against today's date. This is documented behavior: the caller
  //     should supply the transaction date for historical accuracy, but a missing
  //     date does not fail closed — it defaults to today.
  {
    id: "tc43-missing-date-fails-closed",
    description: "Missing transactionDate falls back to today — rules looked up against current date",
    businessType: "N/A (missing date)",
    transaction: {
      transactionDate: undefined as any,
      amountMinor: 100000,
      currency: "EUR",
      vatRegistered: true,
      supplyType: "services",
    },
    notExpectedRuleKeys: ["vat.input_deduction_general"],
    reviewRequired: true, // requiresGuidance=true for matched rules
  },
];

// === RUN ALL TEST CASES ===
interface TestResult {
  id: string;
  description: string;
  businessType?: string;
  passed: boolean;
  failures: string[];
  lookupResult: {
    identifiedTopics: string[];
    applicableRuleKeys: string[];
    matchedRules: string[];
    reviewRequired: boolean;
    unresolvedFields: string[];
    reviewReasons: string[];
    possibleTreatment: {
      accounting: string[];
      tax: string[];
      vat: string[];
      reporting: string[];
    };
  };
}

const results: TestResult[] = [];

for (const tc of testCases) {
  const result = lookupTransactionRules(db, {
    companyId,
    transaction: tc.transaction,
  });

  const actualKeys = result.applicableRules.map((r) => r.ruleKey);
  const failures: string[] = [];

  // Check expected rules are present
  for (const expected of tc.expectedRuleKeys || []) {
    if (!actualKeys.includes(expected)) {
      failures.push(`Expected rule "${expected}" to be in applicableRules, but it was not. Got: ${JSON.stringify(actualKeys)}`);
    }
  }

  // Check not-expected rules are absent
  for (const notExpected of tc.notExpectedRuleKeys || []) {
    if (actualKeys.includes(notExpected)) {
      failures.push(`Expected rule "${notExpected}" to NOT be in applicableRules, but it was. Got: ${JSON.stringify(actualKeys)}`);
    }
  }

  // Check topics (if specified)
  if (tc.expectedTopics !== undefined) {
    for (const topic of tc.expectedTopics) {
      if (!result.identifiedTopics.includes(topic)) {
        failures.push(`Expected topic "${topic}" to be identified. Got: ${JSON.stringify(result.identifiedTopics)}`);
      }
    }
  }

  // Check reviewRequired
  if (result.reviewRequired !== tc.reviewRequired) {
    failures.push(`Expected reviewRequired=${tc.reviewRequired}, got ${result.reviewRequired}. Reasons: ${result.reviewReasons.join('; ')}`);
  }

  results.push({
    id: tc.id,
    description: tc.description,
    businessType: tc.businessType,
    passed: failures.length === 0,
    failures,
    lookupResult: {
      identifiedTopics: result.identifiedTopics,
      applicableRuleKeys: actualKeys,
      matchedRules: result.applicableRules.map((r) => r.ruleKey),
      reviewRequired: result.reviewRequired,
      unresolvedFields: result.unresolvedFields,
      reviewReasons: result.reviewReasons,
      possibleTreatment: result.possibleTreatment,
    },
  });
}

// === OUTPUT ===
const summary = {
  totalTestCases: results.length,
  passed: results.filter((r) => r.passed).length,
  failed: results.filter((r) => !r.passed).length,
  allRulesInKb: approvedRules.length,
  rules: approvedRules.map((r) => ({
    ruleKey: r.ruleKey,
    name: r.name,
    topic: r.topic,
    ruleType: r.ruleType,
    reviewStatus: r.reviewStatus,
    humanReviewRequired: r.humanReviewRequired,
    requiresGuidance: r.requiresGuidance,
    conditions: r.conditions,
    vatEffect: r.vatEffect,
    accountingEffect: r.accountingEffect,
    requiresGuidance: r.requiresGuidance,
  })),
  results,
};

console.log(JSON.stringify(summary, null, 2));
