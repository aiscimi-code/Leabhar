import { createTestDatabase } from "@/db/testing";
import { createCompany } from "@/domain/config/setup";
import { deriveStatutoryKnowledgeBase } from "@/domain/rules/knowledgeBase";
import { irishTaxRules } from "@/db/schema";
import { eq } from "drizzle-orm";

// Reads the derived copies only, so no rules store is attached (ADR-0021).
const { db } = createTestDatabase({ rulesStore: false });
const { companyId } = createCompany(db, {
  legalName: "Verification Ltd",
  vatNumber: "IE1234567T",
  vatRegistrationStatus: "registered",
  seedYears: [2025, 2026],
});

// Ingest every source and derive every rule, as the app does: the sources
// ported to the rules catalogue (#556) load from it, the rest from their copies.
deriveStatutoryKnowledgeBase(db, { companyId });

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
