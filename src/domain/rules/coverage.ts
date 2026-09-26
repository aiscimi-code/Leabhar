import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseVatca2010 } from './vatcaParser';
import { parseVatcaSchedule } from './vatcaScheduleParser';
import { RULE_TREATMENT_BINDINGS } from './vatSuggestion';

/**
 * The rule coverage matrix (issue #204): one row per provision, VAT treatment
 * and common transaction type the knowledge base is meant to cover, each with
 * exactly one status. Completeness is something a test proves, not something
 * anyone asserts.
 *
 * The matrix itself is data (`docs/rules/coverage-matrix.json`). This module
 * says which rows must exist — read from the statute files themselves where
 * the source defines them, so a row cannot be silently left out — and checks
 * the matrix against the rules the knowledge base actually derives.
 */

export type CoverageStatus = 'rule' | 'not_applicable' | 'deferred';

export type CoverageArea =
  | 'vatca_section'
  | 'vatca_schedule'
  | 'vat_treatment'
  | 'tca_section'
  | 'companies_act'
  | 'other_source'
  | 'transaction_type';

export interface CoverageRow {
  /** Stable id, e.g. "vatca:s46", "vatca:sch3:p2:13A", "treatment:IE_STD". */
  id: string;
  area: CoverageArea;
  title: string;
  status: CoverageStatus;
  /** For `rule`: the rule keys that cover it. */
  ruleKeys?: string[];
  /** For `not_applicable` and `deferred`: why. */
  reason?: string;
  /** For `deferred`: the issue that will cover it. */
  issue?: number;
  /** Anything a reader should know about the row itself (e.g. an unnumbered paragraph in the source). */
  note?: string;
}

export interface CoverageMatrix {
  description: string;
  rows: CoverageRow[];
}

export const COVERAGE_MATRIX_PATH = 'docs/rules/coverage-matrix.json';

// ---- Rows the sources define ----

const VATCA_ENACTED = 'docs/statutes/vatca-2010/vatca-2010-enacted.md';
const VATCA_REVISED_DIR = 'docs/statutes/vatca-2010-revised';

/** Schedules whose paragraphs are rows. Schedule 9 is a list of sections by Part, so its Parts are the rows. */
const PARAGRAPH_SCHEDULES = ['1', '2', '3', '4', '5', '6'] as const;

/**
 * Paragraphs present in a schedule but printed without their number in the
 * LRC revised text, so the parser cannot see them. Each is identified by its
 * position and heading, and noted on its row rather than invented.
 */
export const UNNUMBERED_SCHEDULE_PARAGRAPHS: Array<{ id: string; title: string; note: string }> = [
  {
    id: 'vatca:sch3:p4:21',
    title: 'Sch.3 para 21 — Miscellaneous services',
    note: 'The LRC revised text prints this paragraph (substituted, F481) without its number; it sits between '
      + 'paragraphs 20 and 22 under the heading "Miscellaneous services".',
  },
];

/**
 * Sections in scope for corporation tax, income tax (excluding PAYE) and RCT,
 * as listed by #211, #212 and #213. Part-level entries stand for a Part whose
 * section numbers the issue leaves to be confirmed from the text.
 */
export const TCA_SECTIONS_IN_SCOPE: string[] = [
  's3', 's15', 's18', 's21', 's21A', 's65', 's66', 's67', 's76', 's81', 's284', 's285A', 's288', 's291A', 's292',
  'part9-computer-software', 'part9-motor-vehicles',
  's396', 's396A', 's396B', 's430', 's434', 's440', 's441', 's472AB', 'part18D', 'part41A', 's840', 's1007', 's1008',
  's530', ...'ABCDEFGHIJKLMNOPQRSTUV'.split('').map((l) => `s530${l}`),
];

/** Companies Act 2014 provisions in scope for #214. */
export const COMPANIES_ACT_IN_SCOPE: string[] = [
  's280A', 's280B', 's280C', 's280D', 's280E', 's280F',
  's281', 's282', 's283', 's284', 's285', 's286', 's290', 's291', 's292', 's293',
  's343', 's347', 's352', 's358', 's359', 's360', 'sch3A',
];

/** Common transaction types an Irish SME books (#204). */
export const TRANSACTION_TYPES: string[] = [
  'office-rent', 'software-subscription-abroad', 'software-subscription-ireland', 'motor-fuel', 'entertainment',
  'hotel-accommodation', 'restaurant-meal', 'capital-purchase', 'motor-vehicle-purchase', 'grant-received',
  'loan-drawdown-or-repayment', 'dividend', 'wages', 'tax-payment', 'own-account-transfer', 'bank-charges',
  'insurance', 'passenger-transport', 'postage', 'gas-electricity', 'books', 'childrens-clothing',
  'professional-fees-ireland', 'telephone-broadband', 'subcontractor-construction', 'import-of-goods',
  'sale-services-to-eu-business', 'sale-goods-to-eu-business', 'export-of-goods',
];

export interface ExpectedRow { id: string; area: CoverageArea; title: string }

/** Every row the matrix must have, read from the sources and the declared scope lists. */
export function expectedCoverageRows(params: { root: string; treatmentCodes: string[] }): ExpectedRow[] {
  const rows: ExpectedRow[] = [];
  const read = (p: string) => readFileSync(join(params.root, p), 'utf8');

  for (const s of parseVatca2010(read(VATCA_ENACTED))) {
    rows.push({ id: `vatca:s${s.sectionNumber}`, area: 'vatca_section', title: `s.${s.sectionNumber} ${s.heading}` });
  }
  // Sections inserted after enactment (91A…, 92A…, 108A…), from the revised files in the repo.
  for (const file of readdirSync(join(params.root, VATCA_REVISED_DIR))) {
    const m = /^s0*(\d+[A-Z]+)\.md$/.exec(file);
    if (m) rows.push({ id: `vatca:s${m[1]}`, area: 'vatca_section', title: `s.${m[1]} (inserted)` });
  }

  for (const n of PARAGRAPH_SCHEDULES) {
    const text = read(`${VATCA_REVISED_DIR}/schedule-${n}.md`);
    let paragraphs = parseVatcaSchedule(text).map((p) => ({
      part: p.part ? p.part.replace(/^Part\s+/i, 'p') : null, number: p.paragraphNumber, heading: p.heading,
    }));
    // Schedule 5 marks its paragraphs as Markdown headings ("## 1. Works of art").
    if (paragraphs.length === 0) {
      paragraphs = [...text.matchAll(/^##\s+(\d+[A-Z]?)\.\s+(.+)$/gm)]
        .map((m) => ({ part: null, number: m[1]!, heading: m[2]!.trim() }));
    }
    for (const p of paragraphs) {
      rows.push({
        id: `vatca:sch${n}:${p.part ? `${p.part}:` : ''}${p.number}`,
        area: 'vatca_schedule',
        title: `Sch.${n} para ${p.number}${p.heading ? ` — ${p.heading}` : ''}`,
      });
    }
  }
  for (const extra of UNNUMBERED_SCHEDULE_PARAGRAPHS) {
    rows.push({ id: extra.id, area: 'vatca_schedule', title: extra.title });
  }
  for (const m of read(`${VATCA_REVISED_DIR}/schedule-9.md`).matchAll(/^##\s+Part\s+(\d+)/gm)) {
    rows.push({ id: `vatca:sch9:part${m[1]}`, area: 'vatca_schedule', title: `Sch.9 Part ${m[1]}` });
  }

  for (const code of params.treatmentCodes) {
    rows.push({ id: `treatment:${code}`, area: 'vat_treatment', title: code });
  }
  for (const s of TCA_SECTIONS_IN_SCOPE) rows.push({ id: `tca:${s}`, area: 'tca_section', title: `TCA 1997 ${s}` });
  for (const s of COMPANIES_ACT_IN_SCOPE) rows.push({ id: `ca2014:${s}`, area: 'companies_act', title: `CA 2014 ${s}` });
  for (const t of TRANSACTION_TYPES) rows.push({ id: `txn:${t}`, area: 'transaction_type', title: t });
  return rows;
}

// ---- Which treatments the rules can produce ----

/**
 * Treatment code -> the rule keys whose binding can produce it. A binding's
 * code can depend on the counterparty's country and on the date (a Schedule
 * 3 rate), so each rule is asked for an EU, a non-EU and an Irish
 * counterparty on dates either side of each rate change, and with the
 * customs-entry markers an import binding reads.
 */
/** Customs-entry markers a binding may read (the import choice, issue #207). */
const SAMPLE_DESCRIPTIONS = ['', 'IEPOSTPONED', 'B00'];
const SAMPLE_DATES = ['2021-06-01', '2024-06-01', '2025-06-01', '2025-11-01', '2026-06-01', '2026-09-01', '2031-06-01'];

export function producibleTreatments(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const binding of RULE_TREATMENT_BINDINGS) {
    for (const key of binding.ruleKeys) {
      for (const country of ['DE', 'US', 'IE']) {
        for (const transactionDate of SAMPLE_DATES) for (const description of SAMPLE_DESCRIPTIONS) {
          const code = binding.treatmentCode({ counterpartyCountry: country, transactionDate, description } as never, key);
          if (!code) continue;
          const keys = out.get(code) ?? new Set<string>();
          keys.add(key);
          out.set(code, keys);
        }
      }
    }
  }
  return out;
}

// ---- Validation ----

export interface CoverageReport {
  errors: string[];
  /** Counts by status within each area. */
  summary: Record<CoverageArea, Record<CoverageStatus, number>>;
}

export function validateCoverageMatrix(params: {
  matrix: CoverageMatrix;
  expected: ExpectedRow[];
  derivedRuleKeys: string[];
  producible: Map<string, Set<string>>;
}): CoverageReport {
  const errors: string[] = [];
  const derived = new Set(params.derivedRuleKeys);
  const byId = new Map<string, CoverageRow>();

  for (const row of params.matrix.rows) {
    if (byId.has(row.id)) errors.push(`${row.id}: duplicate row`);
    byId.set(row.id, row);
    switch (row.status) {
      case 'rule':
        if (!row.ruleKeys?.length) errors.push(`${row.id}: status "rule" lists no ruleKeys`);
        for (const key of row.ruleKeys ?? []) {
          if (!derived.has(key)) errors.push(`${row.id}: ruleKey "${key}" is not derived by the knowledge base`);
        }
        break;
      case 'not_applicable':
        if (!row.reason?.trim()) errors.push(`${row.id}: not_applicable without a reason`);
        break;
      case 'deferred':
        if (!row.reason?.trim()) errors.push(`${row.id}: deferred without a reason`);
        if (!row.issue) errors.push(`${row.id}: deferred without an issue number`);
        break;
      default:
        errors.push(`${row.id}: no status (got "${String((row as { status?: unknown }).status)}")`);
    }
  }

  // Every row the sources define is present, and nothing is there that they do not define.
  const expectedIds = new Set(params.expected.map((r) => r.id));
  for (const e of params.expected) if (!byId.has(e.id)) errors.push(`${e.id}: missing from the matrix (${e.title})`);
  for (const row of params.matrix.rows) {
    if (row.area !== 'other_source' && !expectedIds.has(row.id)) {
      errors.push(`${row.id}: not a row any source or scope list defines`);
    }
  }

  // Every derived rule is somewhere in the matrix.
  const mapped = new Set(params.matrix.rows.flatMap((r) => (r.status === 'rule' ? r.ruleKeys ?? [] : [])));
  for (const key of derived) if (!mapped.has(key)) errors.push(`rule "${key}" is derived but in no matrix row`);

  // A treatment row marked "rule" must be producible, by the rules it names.
  for (const row of params.matrix.rows.filter((r) => r.area === 'vat_treatment')) {
    const code = row.id.replace(/^treatment:/, '');
    const producers = params.producible.get(code);
    if (row.status === 'rule') {
      if (!producers) {
        errors.push(`${row.id}: marked "rule" but no rule binding can produce ${code}`);
      } else {
        for (const key of row.ruleKeys ?? []) {
          if (!producers.has(key)) errors.push(`${row.id}: rule "${key}" does not produce ${code}`);
        }
      }
    } else if (producers) {
      errors.push(`${row.id}: ${code} is producible (by ${[...producers].join(', ')}) but the row says ${row.status}`);
    }
  }

  const statuses: CoverageStatus[] = ['rule', 'not_applicable', 'deferred'];
  const areas: CoverageArea[] = [
    'vatca_section', 'vatca_schedule', 'vat_treatment', 'tca_section', 'companies_act', 'other_source', 'transaction_type',
  ];
  const summary = Object.fromEntries(areas.map((a) => [a, Object.fromEntries(statuses.map((s) => [s, 0]))])) as CoverageReport['summary'];
  for (const row of params.matrix.rows) if (summary[row.area] && statuses.includes(row.status)) summary[row.area][row.status] += 1;

  return { errors, summary };
}

export function formatCoverageSummary(summary: CoverageReport['summary']): string {
  const lines = ['area                 rule  n/a  deferred  total'];
  for (const [area, c] of Object.entries(summary)) {
    const total = c.rule + c.not_applicable + c.deferred;
    lines.push(`${area.padEnd(20)} ${String(c.rule).padStart(4)} ${String(c.not_applicable).padStart(4)} ${String(c.deferred).padStart(9)} ${String(total).padStart(6)}`);
  }
  return lines.join('\n');
}
