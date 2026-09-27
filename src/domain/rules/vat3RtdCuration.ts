/**
 * Curated reporting rules from Revenue's own VAT3 and RTD form guidance
 * (issue #439, epic #310 "Sources: Revenue forms"). The screens already
 * implement the box layout (src/domain/vat/boxDefinitions.ts, rtd.ts); these
 * rules are the knowledge base's own statement of which form box a figure
 * lands in, each quoting Revenue's definition verbatim, so a report that
 * names a box can cite the source behind it.
 *
 * The underlying obligation — a periodic VAT return (reg.24) and the annual
 * Return of Trading Details (VATCA s.76) — is dated from S.I. 639/2010, in
 * force here from 2011-01-01 (si639Ingestion.ts). The guidance documents
 * themselves are dated from their own stated publication/update dates, and
 * recorded separately on the source rows.
 */
import type { IrishRuleType } from '@/db/schema';
import { VAT3_BOX_DEFINITIONS } from '../vat/boxDefinitions';

type IrishRuleUnit = 'eur_minor' | 'usd_minor' | 'basis_points' | 'percent' | 'count' | 'text';

export interface CuratedFormRule {
  /** The guidance source's citation this rule is derived from. */
  citation: 'Revenue: How do you complete a VAT 3 return?' | 'Revenue TDM VAT-RTD-S76';
  sectionNumber: string;
  ruleKey: string;
  ruleType: IrishRuleType;
  name: string;
  statementExcerpt: string;
  reportingEffect: string;
  crossReferences: string[];
  interpretationNote: string;
}

export const VAT3_GUIDANCE_CITATION = 'Revenue: How do you complete a VAT 3 return?' as const;
export const RTD_TDM_CITATION = 'Revenue TDM VAT-RTD-S76' as const;

/** Every box definition in boxDefinitions.ts, as a rule citing Revenue's words. */
export const VAT3_BOX_RULES: CuratedFormRule[] = Object.values(VAT3_BOX_DEFINITIONS).map((d) => ({
  citation: VAT3_GUIDANCE_CITATION,
  sectionNumber: d.box,
  ruleKey: `vat3.box_${d.box.toLowerCase()}`,
  ruleType: 'reporting' as const,
  name: `VAT3 box ${d.box}: ${d.label}`,
  statementExcerpt: d.quote,
  reportingEffect: `Reported in box ${d.box} of the VAT3 return. ${d.label}.`,
  crossReferences: ['Value-Added Tax Consolidation Act 2010 s.76', 'S.I. 639/2010 reg.24'],
  interpretationNote: 'Revenue\'s own definition of the box, from its "How do you complete a VAT 3 return?" page. '
    + 'The reporting engine (src/domain/vat/boxDefinitions.ts) implements this mapping; this rule is the citation behind it.',
}));

/** The RTD manual's obligations and sections, curated as reporting rules. */
export const RTD_MANUAL_RULES: CuratedFormRule[] = [
  {
    citation: RTD_TDM_CITATION, sectionNumber: '1', ruleKey: 'rtd.annual_return_required', ruleType: 'reporting',
    name: 'RTD: an annual return every VAT-registered person must submit',
    statementExcerpt: 'This is an annual return which all VAT registered persons are required to complete and '
      + 'submit to Revenue, within 23 days of the end of the accountable persons\u2019 tax year.',
    reportingEffect: 'A Return of Trading Details is required for each accounting year, filed with the year\u2019s final VAT3.',
    crossReferences: ['Value-Added Tax Consolidation Act 2010 s.76', 'S.I. 639/2010 reg.24'],
    interpretationNote: 'TDM VAT-RTD-S76 \u00a71. The statutory requirement is VATCA s.76 and S.I. 639/2010 reg.24(1); '
      + 'the manual is Revenue guidance on how it is filed.',
  },
  {
    citation: RTD_TDM_CITATION, sectionNumber: '1', ruleKey: 'rtd.due_date_23rd', ruleType: 'procedure',
    name: 'RTD: due the 23rd of the month after the accounting period ends',
    statementExcerpt: 'The due date for RTD submission is the 23rd of the month following the month in which '
      + 'the company\u2019s, entity\u2019s, or individual\u2019s accounting period ends.',
    reportingEffect: 'The RTD for a year ending 31 August is due by 23 September (manual \u00a71\u2019s example).',
    crossReferences: ['S.I. 639/2010 reg.24'],
    interpretationNote: 'A filer with an e-filing exemption that does not pay and file on ROS has 19 days instead (\u00a71\u2019s footnote).',
  },
  {
    citation: RTD_TDM_CITATION, sectionNumber: '2.2', ruleKey: 'rtd.section_supplies', ruleType: 'reporting',
    name: 'RTD section 1: supplies of goods and services, split by Irish rate',
    statementExcerpt: 'The purpose of this section is to provide a breakdown of the net value of goods and/or services '
      + 'sold/supplied during the RTD period.',
    reportingEffect: 'Section 1 reports supplies by Irish rate: D1 (0%), C5 (livestock 4.8%), BC5 (9%), AC5 (13.5%), '
      + 'P1 (23%), B5 (flat-rate addition), E3 (exempt), D4 (intra-EU supplies and exports).',
    crossReferences: ['Value-Added Tax Consolidation Act 2010 s.76'],
    interpretationNote: 'Self-accounted received services also belong here (\u00a72.2(e)); supplies under the One-Stop Shop are excluded (\u00a72.2(c)).',
  },
  {
    citation: RTD_TDM_CITATION, sectionNumber: '2.3', ruleKey: 'rtd.section_acquisitions', ruleType: 'reporting',
    name: 'RTD section 2: EU acquisitions and postponed-accounting imports',
    statementExcerpt: 'The purpose of this section is to provide a breakdown of the net value of intra-community '
      + 'acquisitions (goods and services) and imports from outside the EU where Postponed Accounting was applied (goods only).',
    reportingEffect: 'Section 2 reports the values behind the VAT3 E2, ES2 and PA1 fields, at the Irish rate that would apply '
      + 'if the goods or services were bought in Ireland.',
    crossReferences: ['Value-Added Tax Consolidation Act 2010 s.76'],
    interpretationNote: 'Every section-2 transaction also belongs in section 3 or 4, by whether it was for resale (\u00a72.3).',
  },
  {
    citation: RTD_TDM_CITATION, sectionNumber: '2.4', ruleKey: 'rtd.section_resale', ruleType: 'reporting',
    name: 'RTD section 3: goods or services purchased for resale',
    statementExcerpt: 'The purpose of this section is to provide a breakdown of the net value of all purchases that were '
      + 'bought for resale to customers.',
    reportingEffect: 'Section 3 reports purchases for resale regardless of where they were acquired: Irish, intra-EU, '
      + 'postponed-accounting imports and non-EU imports.',
    crossReferences: ['Value-Added Tax Consolidation Act 2010 s.76'],
    interpretationNote: 'A purchase is for resale or it is not; the report asks the filer rather than deciding silently (src/domain/vat/rtd.ts).',
  },
  {
    citation: RTD_TDM_CITATION, sectionNumber: '2.5', ruleKey: 'rtd.section_other_deductible', ruleType: 'reporting',
    name: 'RTD section 4: other deductible goods and services',
    statementExcerpt: 'The purpose of this section is to provide a breakdown of the net value of goods and services '
      + 'acquired that were not for resale, but where VAT paid can be claimed as an input credit.',
    reportingEffect: 'Section 4 reports deductible purchases that were not for resale, at the filer\u2019s deductibility rate.',
    crossReferences: ['Value-Added Tax Consolidation Act 2010 s.76'],
    interpretationNote: 'Operating expenses and overheads belong here (\u00a72.5\u2019s example).',
  },
];
