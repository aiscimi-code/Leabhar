/**
 * Rule-traceability inventory dump (docs/trust/rule-traceability-audit.md).
 *
 * Ingests every source into a throwaway in-memory DB through the production
 * CLI entry point (`src/cli/irishRules.ts` `main()`, default `--source`
 * paths), then writes one JSON record per derived `irish_tax_rules` row with
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
import { main } from '@/cli/irishRules';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';

const INGEST_SOURCES = [
  'finance-act-2024', 'vatca-2010', 'vatca-2010-sch1', 'vatca-2010-sch2', 'vatca-2010-sch3', 'rct-tca530',
  'rct-fa2011-a', 'rct-fa2011-e', 'rct-fa2011-g', 'rct-fa2011-h', 'rct-fa2011-i',
  'rct-tdm', 'rct-tdm-05', 'rct-tdm-11', 'vatca-2010-revised', 'tca1997-s284', 'finance-act-2003-s23',
  'si639', 'si156', 'si69-2025-reg5', 'si69-2025', 'si69-2025-reg7', 'si69-2025-reg9',
  'tdm-38-01-03b', 'companies-act-2014',
];
const EXTRACT_SOURCES = [
  'finance-act-2024', 'vatca-2010', 'vatca-2010-sch2', 'vatca-2010-sch3', 'rct', 'vatca-2010-revised',
  'tca1997-s284', 'si639', 'si156', 'si69-2025', 'finance-act-2024-vat-thresholds', 'tdm-38-01-03b',
  'companies-act-2014', 'vat-scope',
];

const words = (s: string): string[] => s.replace(/<!--[^>]*-->/g, ' ').split(/\s+/).filter(Boolean);

/** Every word of `text`, in order, within `slice` — i.e. the slice contains the text modulo page furniture. */
function sliceContains(slice: string, text: string): { found: number; total: number } {
  const tw = words(text);
  let i = 0;
  for (const w of words(slice)) if (i < tw.length && w === tw[i]) i++;
  return { found: i, total: tw.length };
}

async function run(): Promise<void> {
  const { db } = createTestDatabase();
  const { companyId } = createCompany(db, { legalName: 'Traceability Audit Ltd', seedYears: [2024, 2025, 2026] });
  const log: Array<{ args: string[]; exit: number }> = [];
  const write = process.stdout.write.bind(process.stdout);
  const silence = (): void => { process.stdout.write = (() => true) as typeof process.stdout.write; };
  const runs: string[][] = [
    ...INGEST_SOURCES.map((source) => ['ingest', '--source', source]),
    // Revised s.2 and s.3 back the outside-the-scope rules (vatScopeCuration.ts).
    ...['s002', 's003'].map((f) => ['ingest', '--source', 'vatca-2010-revised', '--file', `docs/statutes/vatca-2010-revised/${f}.md`]),
    ...EXTRACT_SOURCES.map((source) => ['extract', '--source', source]),
  ];
  {
    for (const args of runs) {
      silence();
      const exit = await main(args, { db, companyId });
      process.stdout.write = write;
      log.push({ args, exit });
    }
  }

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
  writeFileSync(out, JSON.stringify({ log, counts: { sources: sources.length, provisions: provisions.length, rules: rules.length }, rules: records }, null, 2));
  write(`sources=${sources.length} provisions=${provisions.length} rules=${rules.length} -> ${out}\n`);
}

void run();
