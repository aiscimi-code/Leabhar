
import { createTestDatabase } from "./src/db/testing";
import { createCompany } from "./src/domain/config/setup";
import { ingestFinanceAct2024, deriveTaxRules } from "./src/domain/rules/irishRules";
import { ingestVatca2010, deriveVatcaRules } from "./src/domain/rules/vatcaIngestion";
import { ingestVatcaRevisedSection, deriveVatcaRevisedRules } from "./src/domain/rules/vatcaRevisedIngestion";
import { ingestVatcaSchedule, deriveVatcaScheduleRules } from "./src/domain/rules/vatcaScheduleIngestion";
import { ingestSi692025Reg5, ingestSi692025Reg8, ingestSi692025Reg9, deriveSi692025Rules } from "./src/domain/rules/si692025Ingestion";
import { deriveFinanceAct2024VatThresholds } from "./src/domain/rules/financeAct2024VatThresholdsCuration";
import { ingestSi639, deriveSi639Rules } from "./src/domain/rules/si639Ingestion";
import { ingestSi156, deriveSi156Rules } from "./src/domain/rules/si156Ingestion";
import { ingestTca1997S284, deriveCapitalAllowancesRules } from "./src/domain/rules/capitalAllowancesIngestion";
import { ingestRctTdm18_02_04, ingestRctTdm18_02_05, ingestRctTdm18_02_11, deriveRctRules } from "./src/domain/rules/rctIngestion";
import { lookupTransactionRules } from "./src/domain/rules/transactionLookup";
import { readFileSync } from "node:fs";

const { db } = createTestDatabase();
const { companyId } = createCompany(db, { legalName: "Test Co", vatRegistered: true, vatNumber: "IE1234567T", seedYears: [2025, 2026] });

// Ingest all KB sources
ingestFinanceAct2024(db, { companyId, markdown: readFileSync("docs/statutes/finance-act-2024/2024-act-43-enacted.md", "utf8"), ingestVersion: "v1" });
deriveTaxRules(db, { companyId });

const vatcaMd = readFileSync("docs/statutes/vatca-2010/vatca-2010-enacted.md", "utf8");
ingestVatca2010(db, { companyId, markdown: vatcaMd, ingestVersion: "v1" });
deriveVatcaRules(db, { companyId });

const s46Md = readFileSync("docs/statutes/vatca-2010-revised/s046.md", "utf8");
ingestVatcaRevisedSection(db, { companyId, markdown: s46Md, ingestVersion: "v1" });
deriveVatcaRevisedRules(db, { companyId });

const sch2Md = readFileSync("docs/statutes/vatca-2010-revised/schedule-2.md", "utf8");
const sch3Md = readFileSync("docs/statutes/vatca-2010-revised/schedule-3.md", "utf8");
ingestVatcaSchedule(db, { companyId, scheduleNumber: "2", markdown: sch2Md, ingestVersion: "v1" });
ingestVatcaSchedule(db, { companyId, scheduleNumber: "3", markdown: sch3Md, ingestVersion: "v1" });
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

console.log("KB ingested successfully.");
console.log("Company ID:", companyId);
