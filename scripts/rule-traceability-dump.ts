/**
 * Rule-traceability inventory dump (docs/trust/rule-traceability-audit.md).
 *
 * Runs the derive pipeline the rules store is built from
 * (`deriveStatutoryKnowledgeBase`) into a throwaway in-memory DB, then
 * writes one JSON record per derived `irish_tax_rules` row with
 * its provision and source, and re-checks each source file's SHA-256 and each
 * provision's offset slice. Read-only with respect to the repo: it approves
 * nothing and changes no reviewStatus.
 *
 *   npx tsx scripts/rule-traceability-dump.ts [out.json]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '@/domain/config/setup';
import { deriveStatutoryKnowledgeBase } from '@/domain/rules/knowledgeBase';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';

const words = (s: string): string[] => s.replace(/<!--[^>]*-->/g, ' ').split(/\s+/).filter(Boolean);

/** Every word of `text`, in order, within `slice` — i.e. the slice contains the text modulo page furniture. */
function sliceContains(slice: string, text: string): { found: number; total: number } {
  const tw = words(text);
  let i = 0;
  for (const w of words(slice)) if (i < tw.length && w === tw[i]) i++;
  return { found: i, total: tw.length };
}

async function run(): Promise<void> {
  // Reads the derived copies only, so no rules store is attached (ADR-0021).
  const { db } = createTestDatabase({ rulesStore: false });
  const { companyId } = createCompany(db, { legalName: 'Traceability Audit Ltd', seedYears: [2024, 2025, 2026] });
  const derived = deriveStatutoryKnowledgeBase(db, { companyId });

  const sources = db.select().from(irishKnowledgeSources).all();
  const provisions = db.select().from(irishActProvisions).all();
  const rules = db.select().from(irishTaxRules).all();

  const records = rules.map((rule) => {
    const prov = provisions.find((p) => p.id === rule.provisionId);
    const src = prov ? sources.find((s) => s.id === prov.sourceId) : undefined;
    const path = src?.localPath ?? null;
    const file = path && existsSync(path) ? readFileSync(path, 'utf8') : null;
    const fileSha = file === null ? null : createHash('sha256').update(file).digest('hex');
    const slice = file !== null && prov?.sourceStart != null && prov.sourceEnd != null
      ? file.slice(prov.sourceStart, prov.sourceEnd)
      : null;
    return {
      ruleKey: rule.ruleKey, ruleType: rule.ruleType, topic: rule.topic,
      reviewStatus: rule.reviewStatus, requiresGuidance: rule.requiresGuidance,
      effectiveFrom: rule.effectiveFrom, effectiveTo: rule.effectiveTo,
      ruleVersion: rule.ruleVersion, supersedesRuleId: rule.supersedesRuleId,
      conditions: rule.conditions, exceptions: rule.exceptions, crossReferences: rule.crossReferences,
      taxRateId: rule.taxRateId, vatTreatmentId: rule.vatTreatmentId,
      extractedFact: rule.extractedFact, numericValue: rule.numericValue, unit: rule.unit,
      statement: rule.statement,
      provision: prov && {
        sectionNumber: prov.sectionNumber, heading: prov.heading,
        sourceStart: prov.sourceStart, sourceEnd: prov.sourceEnd,
        provisionTextLength: prov.provisionText?.length ?? 0,
        sliceExact: slice !== null && slice === prov.provisionText,
        sliceWords: slice !== null ? sliceContains(slice, prov.provisionText ?? '') : null,
      },
      source: src && {
        citation: src.citation, sourceType: src.sourceType, sourceUrl: src.sourceUrl, localPath: path,
        sha256: src.sha256, fileExists: file !== null, sha256Matches: fileSha === src.sha256,
        effectiveFrom: src.effectiveFrom,
      },
    };
  });

  const out = process.argv[2] ?? 'rule-traceability-dump.json';
  writeFileSync(out, JSON.stringify({ derived, counts: { sources: sources.length, provisions: provisions.length, rules: rules.length }, rules: records }, null, 2));
  process.stdout.write(`sources=${sources.length} provisions=${provisions.length} rules=${rules.length} -> ${out}\n`);
}

void run();
