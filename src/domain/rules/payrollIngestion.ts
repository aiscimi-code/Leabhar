/**
 * Ingestion for the payroll sources (EPIC 20, issue #526), and the derive
 * step for the curated payroll rules.
 *
 * Each source file becomes one knowledge source. Each provision a rule
 * quotes is an exact slice of that file, between a start marker (the
 * provision's opening words) and an end marker (the next provision's
 * heading, or the end of the operative text). The offsets are the slice's
 * own, so the provision viewer can re-check it against the committed file
 * (AGENTS.md #5), and nothing is normalised or paraphrased.
 */
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishKnowledgeSources, irishActProvisions } from '@/db/schema';
import { ids } from '@/lib/ids';
import { nowIso } from '../dates';
import { sha256Hex } from '@/lib/hash';
import { parseScheduleFrontMatter } from './vatcaScheduleParser';
import { provisionSlug } from './statuteParser';
import { deriveCuratedRuleFamilies, type IncomeTaxDeriveResult } from './incomeTaxIngestion';
import { PAYROLL_CURATED_RULES } from './payrollCuration';

interface ProvisionSlice {
  sectionNumber: string;
  heading: string;
  /** The provision's first words, where the slice begins. */
  start: string;
  /** Where the slice ends (exclusive): the next provision's heading, or null for the end of the file. */
  end: string | null;
  category: 'income_tax' | 'usc' | 'procedure';
}

interface PayrollSource {
  path: string;
  /** Legislation unless stated: a Revenue manual is guidance, ranked below the law it explains. */
  sourceType?: 'legislation' | 'revenue_guidance';
  /** Legislation dated from when it applies; LRC revised text is current law on the day it was retrieved. */
  effectiveFrom: string;
  sourceNote: string;
  provisions: ProvisionSlice[];
}

export const PAYROLL_SOURCES: PayrollSource[] = [
  {
    path: 'docs/statutes/swca-2005/swca-2005-s13.md',
    effectiveFrom: '2026-09-27',
    sourceNote: 'LRC revised text as retrieved on 2026-09-27: current law on that date. The amendment notes that date '
      + 'each figure are in swca-2005-s13.html beside it.',
    provisions: [{
      sectionNumber: '13', heading: 'Employment contributions', category: 'income_tax',
      start: '13.\n—(1)', end: null,
    }],
  },
  {
    path: 'docs/statutes/swmpa-2024/2024-act-24-s3.md',
    effectiveFrom: '2024-10-01',
    sourceNote: 'As enacted. The Table fixes the Class A rates on 1 October in each of 2024 to 2028 (s.3(1)-(5)).',
    provisions: [{
      sectionNumber: '3', heading: 'Amendment of certain provisions of Principal Act relevant to employment contributions',
      category: 'income_tax', start: '3.\n(1) Each provision', end: null,
    }],
  },
  {
    path: 'docs/statutes/swa-2024/2024-act-36-s2.md',
    effectiveFrom: '2025-01-01',
    sourceNote: 'As enacted; in operation from 1 January 2025 (s.2(2)).',
    provisions: [{ sectionNumber: '2', heading: 'Employment contributions', category: 'income_tax', start: '2.\n(1)', end: null }],
  },
  {
    path: 'docs/statutes/swaerss-2025/2025-act-19-s2.md',
    effectiveFrom: '2026-01-01',
    sourceNote: 'As enacted; in operation from 1 January 2026 (s.2(2)).',
    provisions: [{ sectionNumber: '2', heading: 'Employment contributions', category: 'income_tax', start: '2.\n(1)', end: null }],
  },
  {
    path: 'docs/statutes/ntf-2000/ntf-2000-s4.md',
    effectiveFrom: '2026-09-27',
    sourceNote: 'LRC revised text as retrieved on 2026-09-27: current law on that date. The 1.0% rate is dated by '
      + 'amendment note F3 in ntf-2000-s4.html beside it (1 January 2020).',
    provisions: [{
      sectionNumber: '4', heading: 'Rate of levy and supplemental provisions', category: 'income_tax',
      start: '4.\n—\n(1)', end: null,
    }],
  },
  {
    path: 'docs/statutes/si-345-2018/2018-si-345.md',
    effectiveFrom: '2019-01-01',
    sourceNote: 'As made; in operation from 1 January 2019 for payments made on or after that date (reg.1(2)).',
    provisions: [
      { sectionNumber: '11', heading: 'Calculation and making of deduction or repayment', category: 'procedure',
        start: '11. (1) On any payment of emoluments', end: 'Deduction of tax in respect of notional payments' },
      { sectionNumber: '15', heading: 'Deduction in special cases', category: 'procedure',
        start: '15. (1) This Regulation applies to', end: 'Arrears of pay' },
      { sectionNumber: '19', heading: 'Emergency basis of deduction', category: 'procedure',
        start: '19. (1) This Regulation applies where', end: 'Aggregation of emoluments in non-cumulative cases' },
      { sectionNumber: '20', heading: 'Aggregation of emoluments in non-cumulative cases', category: 'procedure',
        start: '20. Where under these Regulations', end: 'Tax-free emoluments' },
      { sectionNumber: '31', heading: 'Deduction or repayment by reference to superannuation contribution', category: 'procedure',
        start: '31. (1) In this Regulations', end: 'Revocation' },
    ],
  },
  {
    path: 'docs/statutes/si-1-2024/2024-si-1.md',
    effectiveFrom: '2024-01-04',
    sourceNote: 'As made; in operation on the date of making, 4 January 2024 (reg.1(2)). Inserts reg.10A (ERR) into S.I. 345/2018.',
    provisions: [{
      sectionNumber: '3', heading: 'Amendment of the Income Tax (Employments) Regulations 2018 (reportable benefits)',
      category: 'procedure', start: '3. The Principal Regulations are amended', end: 'GIVEN under my hand',
    }],
  },
  {
    path: 'docs/statutes/tdm-38-03-33/38-03-33.md',
    sourceType: 'revenue_guidance',
    effectiveFrom: '2024-01-01',
    sourceNote: 'Revenue Tax and Duty Manual, reviewed September 2026, as retrieved on 2026-09-27: guidance on TCA s.897C, '
      + 'not law. Converted from the PDF whose SHA-256 is in the front matter.',
    provisions: [
      { sectionNumber: '4', heading: 'Reportable Measures', category: 'procedure',
        start: '4.1. €3.20 remote working daily allowance\nRevenue operates', end: '5. Reporting Requirements\nThe legislation' },
      { sectionNumber: '5', heading: 'Reporting Requirements', category: 'procedure',
        start: '5. Reporting Requirements\nThe legislation', end: '6. Reporting Mechanisms\nThere are three' },
    ],
  },
  {
    path: 'docs/statutes/si-510-2018/2018-si-510.md',
    effectiveFrom: '2019-01-01',
    sourceNote: 'As made; in operation from 1 January 2019 for payments made on or after that date (reg.1(2)).',
    provisions: [
      { sectionNumber: '14', heading: 'Calculation and making of deduction or repayment', category: 'usc',
        start: '14.  (1) On any payment of relevant emoluments', end: 'Deduction of USC in respect of notional payments' },
      { sectionNumber: '19', heading: 'Emergency basis of deduction', category: 'usc',
        start: '19.  (1) Until a revenue payroll notification', end: '20.  Where an employer makes a payment' },
    ],
  },
];

/** The exact slice of a source file a provision occupies. Throws if a marker is missing: never a guess. */
export function sliceProvision(markdown: string, p: ProvisionSlice): { text: string; start: number; end: number } {
  const start = markdown.indexOf(p.start);
  if (start < 0) throw new Error(`Payroll source: the opening "${p.start}" of provision ${p.sectionNumber} is not in the file.`);
  let end = markdown.length;
  if (p.end !== null) {
    end = markdown.indexOf(p.end, start + p.start.length);
    if (end < 0) throw new Error(`Payroll source: the end marker "${p.end}" of provision ${p.sectionNumber} is not in the file.`);
  }
  const raw = markdown.slice(start, end);
  const trimmed = raw.trimEnd();
  return { text: trimmed, start, end: start + trimmed.length };
}

/** Ingest one payroll source file. Idempotent by content. */
export function ingestPayrollSource(
  db: AppDatabase,
  params: { companyId?: string | null; markdown: string; ingestVersion: string; localPath: string },
): { sourceId: string; ingested: boolean } {
  const source = PAYROLL_SOURCES.find((s) => s.path === params.localPath);
  if (!source) throw new Error(`${params.localPath} is not a payroll source.`);
  const fm = parseScheduleFrontMatter(params.markdown);
  const digest = sha256Hex(params.markdown);
  const existing = db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(and(eq(irishKnowledgeSources.citation, fm.citation), eq(irishKnowledgeSources.sha256, digest))).get();
  if (existing) return { sourceId: existing.id, ingested: false };
  const slices = source.provisions.map((p) => ({ p, ...sliceProvision(params.markdown, p) }));
  return db.transaction((tx) => {
    const sourceId = ids.knowledgeSource();
    tx.insert(irishKnowledgeSources).values({
      id: sourceId, companyId: params.companyId ?? null, sourceType: source.sourceType ?? 'legislation', title: fm.title, citation: fm.citation,
      jurisdiction: 'IE', sourceUrl: fm.sourceUrl, localPath: params.localPath, sha256: digest,
      ingestVersion: params.ingestVersion, publicationDate: null, retrievedAt: nowIso(),
      effectiveFrom: source.effectiveFrom, sourceNote: source.sourceNote, sourceDate: nowIso(),
    }).run();
    for (const { p, text, start, end } of slices) {
      tx.insert(irishActProvisions).values({
        id: ids.provision(), companyId: params.companyId ?? null, sourceId, sectionNumber: p.sectionNumber,
        slug: provisionSlug(`${fm.citation}-${p.sectionNumber}`, p.heading), heading: p.heading, principalAct: null,
        provisionText: text, sourceStart: start, sourceEnd: end,
        category: p.category, amendsSection: null, effectiveClue: null, citedActs: [], relevant: true,
        relevanceReason: 'Payroll: PAYE, USC and PRSI an employer deducts and pays, and the benefits it reports (EPICs 20 and 21).',
        source: 'import', provenanceStatus: 'imported',
      }).run();
    }
    return { sourceId, ingested: true };
  });
}

/** Derive the curated payroll rules, one dated version per row, chained by `supersedesRuleId`. */
export function derivePayrollRules(db: AppDatabase, params: { companyId: string }): IncomeTaxDeriveResult {
  return deriveCuratedRuleFamilies(db, { companyId: params.companyId, rules: PAYROLL_CURATED_RULES, label: 'payroll' });
}
