
import { createTestDatabase } from "./src/db/testing";
import { createCompany } from "./src/domain/config/setup";
import { loadStatutoryKnowledgeBase } from "./src/domain/rules/knowledgeBase";

const { db } = createTestDatabase();
const { companyId } = createCompany(db, { legalName: "Test Co", vatNumber: "IE1234567T", vatRegistrationStatus: "registered", seedYears: [2025, 2026] });

// Ingest every source and derive every rule, as the app does: the sources
// ported to the rules catalogue (#556) load from it, the rest from their copies.
const result = loadStatutoryKnowledgeBase(db, { companyId });

console.log("KB ingested successfully.", `${result.rulesAfter} rules.`);
console.log("Company ID:", companyId);
