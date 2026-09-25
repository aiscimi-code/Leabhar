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
import { lookupTransactionRules, type TransactionContext } from "@/domain/rules/transactionLookup";
import { setRuleReviewStatus } from "@/domain/rules/review";
import { irishTaxRules } from "@/db/schema";
import { eq } from "drizzle-orm";

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

// List all rules
const allRules = db.select({
  ruleKey: irishTaxRules.ruleKey,
  name: irishTaxRules.name,
  topic: irishTaxRules.topic,
  ruleType: irishTaxRules.ruleType,
  active: irishTaxRules.active,
  reviewStatus: irishTaxRules.reviewStatus,
  humanReviewRequired: irishTaxRules.humanReviewRequired,
  effectiveFrom: irishTaxRules.effectiveFrom,
  effectiveTo: irishTaxRules.effectiveTo,
  conditions: irishTaxRules.conditions,
  vatEffect: irishTaxRules.vatEffect,
  accountingEffect: irishTaxRules.accountingEffect,
  taxEffect: irishTaxRules.taxEffect,
  exceptions: irishTaxRules.exceptions,
  requiresGuidance: irishTaxRules.requiresGuidance,
}).from(irishTaxRules).where(eq(irishTaxRules.companyId, companyId)).all();

console.log("=== ALL RULES IN KB ===");
for (const r of allRules) {
  console.log(`${r.ruleKey} | topic=${r.topic} | type=${r.ruleType} | active=${r.active} | review=${r.reviewStatus} | hr=${r.humanReviewRequired}`);
}
console.log(`\nTotal rules: ${allRules.length}`);
console.log(`Active rules: ${allRules.filter(r => r.active).length}`);
console.log(`Human-review-required rules: ${allRules.filter(r => r.humanReviewRequired).length}`);
