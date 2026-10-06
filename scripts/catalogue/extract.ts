/**
 * Write a rules catalogue entry from the official file (issue #443 step 2,
 * issue #686 step 10). A developer step, never run by the app:
 *
 *   npm run catalogue:extract -- vatca-2010-revised/s046
 *   npm run catalogue:extract -- vatca-2010-revised/s046 --html saved.html --retrieved-on 2026-09-29
 *   npm run catalogue:extract -- vatca-2010-revised/s009 vatca-2010-revised/s010 --html-dir pages/
 *   npm run catalogue:extract -- vatca-2010-revised/schedule-2
 *   npm run catalogue:extract -- vatca-2010/vatca-2010-enacted --html vatca.pdf
 *   npm run catalogue:extract -- finance-act-2024/2024-act-43-enacted
 *   npm run catalogue:extract -- tca-1997-nfg/part02
 *   npm run catalogue:extract -- swca-2005/s21
 *
 * Several entries are extracted together: every entry's source and
 * provisions are written first, then the knowledge base is loaded once and
 * each entry's rules are written (a rule can rely on another entry's).
 * `--html-dir` holds a saved copy of each page, named after the entry's last
 * part (`s009.html`; `vatca-2010-enacted.pdf` for a PDF source). `--lrc-annotations` keeps the page's amendment
 * footnotes in the entry (see `annotates`).
 *
 * 1. Fetch the official page (or read `--html`, a copy saved from the same
 *    URL) and keep it beside the entry, byte for byte (`s046.html`): the
 *    entry records its hash, and the gate re-checks it.
 * 2. Convert it to text (lrc_html_to_text.py, with --paragraphs for S.I.
 *    156/2012; convert-statute-pdf.ts for the
 *    VATCA PDF, `pdftotext -layout` for a Finance Act's or a Notes for
 *    Guidance part's, pdfplumber_to_text.py
 *    for a Revenue manual's) and parse it with
 *    the same parser the rules were curated against.
 * 3. Write the entry's source and provisions, load the knowledge base into a
 *    throwaway book from it, and write the rules the curation derives, with
 *    their links. An approval in the previous entry is kept only for a version
 *    and a source hash that have not changed.
 *
 * Review the diff before committing it: a changed hash or excerpt means the
 * law, or its consolidation, has moved (`verify-sources` reports the same).
 * A source ported from a statute copy keeps that copy's title and citation,
 * which books already hold; a re-extraction keeps the entry's.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '@/domain/config/setup';
import {
  CATALOGUE_FORMAT, catalogueEntryPath, catalogueOfficialFilePath, catalogueRulesFor, serialiseCatalogueEntry, validateCatalogueEntry,
  type CatalogueEntry, type CatalogueOfficialExtension,
} from '@/domain/rules/catalogue';
import { loadStatutoryKnowledgeBase } from '@/domain/rules/knowledgeBase';
import { ruleImpact } from '@/domain/rules/ruleImpact';
import { parseVatcaRevisedSection } from '@/domain/rules/vatcaRevisedSectionParser';
import { vatcaRevisedRelevance } from '@/domain/rules/vatcaRevisedIngestion';
import { parseVatcaSchedule } from '@/domain/rules/vatcaScheduleParser';
import { vatcaScheduleRelevance } from '@/domain/rules/vatcaScheduleIngestion';
import { parseVatca2010 } from '@/domain/rules/vatcaParser';
import { VATCA_2010, VATCA_2010_ENACTED_NOTE, vatca2010Relevance } from '@/domain/rules/vatcaIngestion';
import { parseFinanceAct2024 } from '@/domain/rules/statuteParser';
import { parseTca1997Section, type ParsedTcaSection } from '@/domain/rules/tca1997SectionParser';
import { parseFinanceAct2011RctSection } from '@/domain/rules/financeAct2011RctSectionParser';
import {
  RCT_FA2011_CITED_ACTS, RCT_FA2011_NOTE, RCT_FA2011_PRINCIPAL_ACT, RCT_FA2011_SECTIONS, RCT_TDM_NOTE, RCT_TDM_SOURCES,
  TCA_1997_S530, rctFa2011Relevance, rctFa2011Title, rctTdmRelevance, tca1997S530Relevance,
  type RctFa2011SectionKey, type RctTdmKey,
} from '@/domain/rules/rctIngestion';
import { TCA_1997_AS_ENACTED_FROM, TCA_1997_AS_ENACTED_NOTE, tca1997SectionRelevance } from '@/domain/rules/tca1997Ingestion';
import { CAPITAL_ALLOWANCES_CURATED_SECTIONS, FINANCE_ACT_2003 } from '@/domain/rules/capitalAllowancesIngestion';
import {
  FINANCE_ACT_2024, FINANCE_ACT_2025, enactedActRelevance, financeAct2024CuratedReason, financeAct2025CuratedReason,
  type KnowledgeSourceRef,
} from '@/domain/rules/irishRules';
import { parseSi639 } from '@/domain/rules/si639Parser';
import { SI_639, si639Relevance } from '@/domain/rules/si639Ingestion';
import { parseSi156 } from '@/domain/rules/si156Parser';
import { SI_156, si156Relevance } from '@/domain/rules/si156Ingestion';
import { parseSi692025Regulation } from '@/domain/rules/si692025Parser';
import { SI_69_2025, SI_69_2025_REGULATIONS, si692025RelevanceReason } from '@/domain/rules/si692025Ingestion';
import { extractCapacityExclusionSection } from '@/domain/rules/tdm3801_03bParser';
import { parseCompaniesAct2014Section } from '@/domain/rules/companiesAct2014SectionParser';
import { COMPANIES_ACT_2014_NOTE, companiesAct2014Relevance } from '@/domain/rules/companiesAct2014Ingestion';
import { TDM_38_01_03B } from '@/domain/rules/tdm3801_03bIngestion';
import { SWCA_NOTE, SWCA_RELEVANCE_REASON } from '@/domain/rules/incomeTaxIngestion';
import { compareNfgContents, extractNfgSection } from '@/domain/rules/tcaNfgParser';
import { NFG_EFFECTIVE_FROM, NFG_NOTE, nfgRelevanceReason, nfgSourceUrl, nfgTitle } from '@/domain/rules/tcaNfgIngestion';
import { NFG_SECTIONS, nfgCitation } from '@/domain/rules/corporationTaxCuration';
import { nowIso } from '@/domain/dates';
import { lrcAnnotationLayer } from '@/domain/rules/lrcAnnotations';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const CONVERTER = join(ROOT, 'scripts', 'catalogue', 'lrc_html_to_text.py');
const PDF_CONVERTER = join(ROOT, 'scripts', 'convert-statute-pdf.ts');
const PDFPLUMBER_CONVERTER = join(ROOT, 'scripts', 'catalogue', 'pdfplumber_to_text.py');

/** The title and citation a source already goes by: the entry's, else its statute copy's front matter. */
interface Naming { title: string; citation: string; sourceUrl?: string }

function existingNaming(entry: string, previous: CatalogueEntry | null): Naming | null {
  if (previous) return { title: previous.source.title, citation: previous.source.citation, sourceUrl: previous.source.sourceUrl };
  const copy = join(ROOT, 'docs', 'statutes', `${entry}.md`);
  if (!existsSync(copy)) return null;
  const front = readFileSync(copy, 'utf8').split('---')[1] ?? '';
  const field = (name: string) => new RegExp(`^${name}: "?(.*?)"?$`, 'm').exec(front)?.[1];
  const title = field('title');
  const citation = field('citation');
  return title && citation ? { title, citation, sourceUrl: field('source_url') } : null;
}

interface Extractor {
  url: string;
  title: string;
  citation: string;
  /** The official file's kind; an HTML page unless stated. */
  ext?: CatalogueOfficialExtension;
  /** The entry's source and provisions, from the official file's bytes. */
  build: (html: Buffer, retrievedOn: string, annotate: boolean) => Pick<CatalogueEntry, 'source' | 'provisions'>;
}

/** The sources the script can extract, by entry name. Each port adds its own. */
function extractorFor(entry: string, naming: Naming | null): Extractor {
  const section = /^vatca-2010-revised\/s0*(\d+[A-Z]*)$/.exec(entry)?.[1];
  if (section) {
    const url = `https://revisedacts.lawreform.ie/eli/2010/act/31/section/${section}/revised/en/html`;
    const title = naming?.title ?? `VATCA 2010 s.${section} (revised)`;
    const citation = naming?.citation ?? `2010 Act 31 s.${section}`;
    return {
      url, title, citation,
      build: (html, retrievedOn, annotate) => {
        const markdown = convertLrc(html, title, citation, url);
        const parsed = parseVatcaRevisedSection(markdown);
        const { relevant, reason } = vatcaRevisedRelevance(parsed.sectionNumber, citation, parsed.category);
        return {
          source: {
            citation, title, sourceType: 'legislation', jurisdiction: 'IE', sourceUrl: url,
            sha256: createHash('sha256').update(html).digest('hex'),
            conversion: 'lrc-html-plaintext', retrievedOn,
            ...(annotate ? { lrcAnnotations: lrcAnnotationLayer(html.toString('utf8')) } : {}),
          },
          provisions: [{
            sectionNumber: parsed.sectionNumber, heading: parsed.heading, locator: `s.${parsed.sectionNumber}`,
            category: parsed.category, relevant, relevanceReason: reason, excerpt: parsed.provisionText,
          }],
        };
      },
    };
  }
  // A Companies Act 2014 section, revised, from its LRC page: one provision.
  const ca2014 = /^companies-act-2014\/s(\d+[A-Z]*)$/.exec(entry)?.[1];
  if (ca2014) {
    const url = `https://revisedacts.lawreform.ie/eli/2014/act/38/section/${ca2014}/revised/en/html`;
    const title = naming?.title ?? `Companies Act 2014 s.${ca2014} (revised)`;
    const citation = naming?.citation ?? `2014 Act 38 s.${ca2014}`;
    return {
      url, title, citation,
      build: (html, retrievedOn, annotate) => {
        const parsed = parseCompaniesAct2014Section(convertLrc(html, title, citation, url));
        const { relevant, reason } = companiesAct2014Relevance(parsed);
        return {
          source: {
            citation, title, sourceType: 'legislation', jurisdiction: 'IE', sourceUrl: url,
            sha256: createHash('sha256').update(html).digest('hex'),
            conversion: 'lrc-html-plaintext', retrievedOn, note: COMPANIES_ACT_2014_NOTE,
            ...(annotate ? { lrcAnnotations: lrcAnnotationLayer(html.toString('utf8')) } : {}),
          },
          provisions: [{
            sectionNumber: parsed.sectionNumber, heading: parsed.heading, locator: `s.${parsed.sectionNumber}`,
            category: parsed.category, relevant, relevanceReason: reason, excerpt: parsed.provisionText,
          }],
        };
      },
    };
  }
  // A Social Welfare Consolidation Act 2005 section, revised, from its LRC page: one provision.
  const swca = /^swca-2005\/s(\d+[A-Z]*)$/.exec(entry)?.[1];
  if (swca) {
    const url = `https://revisedacts.lawreform.ie/eli/2005/act/26/section/${swca}/revised/en/html`;
    const title = naming?.title ?? `SWCA 2005 s.${swca} (LRC revised)`;
    const citation = naming?.citation ?? `SWCA 2005 s.${swca}`;
    return {
      url, title, citation,
      build: (html, retrievedOn) => {
        const parsed = parseVatcaRevisedSection(convertLrc(html, title, citation, url));
        return {
          source: {
            citation, title, sourceType: 'legislation', jurisdiction: 'IE', sourceUrl: url,
            sha256: createHash('sha256').update(html).digest('hex'),
            conversion: 'lrc-html-plaintext', retrievedOn, note: SWCA_NOTE,
          },
          provisions: [{
            sectionNumber: parsed.sectionNumber, heading: parsed.heading, locator: `s.${parsed.sectionNumber}`,
            category: 'income_tax', relevant: true, relevanceReason: SWCA_RELEVANCE_REASON, excerpt: parsed.provisionText,
          }],
        };
      },
    };
  }
  // A Schedule: one provision per paragraph, as the schedule parser reads it.
  const schedule = /^vatca-2010-revised\/schedule-(\d+)$/.exec(entry)?.[1];
  if (schedule) {
    const url = `https://revisedacts.lawreform.ie/eli/2010/act/31/schedule/${schedule}/revised/en/html`;
    const title = naming?.title ?? `VATCA 2010 Schedule ${schedule} (revised)`;
    const citation = naming?.citation ?? `2010 Act 31 Sch.${schedule}`;
    return {
      url, title, citation,
      build: (html, retrievedOn, annotate) => {
        const paragraphs = parseVatcaSchedule(convertLrc(html, title, citation, url));
        if (paragraphs.length === 0) throw new Error(`Schedule ${schedule}: the parser found no paragraphs.`);
        return {
          source: {
            citation, title, sourceType: 'legislation', jurisdiction: 'IE', sourceUrl: url,
            sha256: createHash('sha256').update(html).digest('hex'),
            conversion: 'lrc-html-plaintext', retrievedOn,
            ...(annotate ? { lrcAnnotations: lrcAnnotationLayer(html.toString('utf8')) } : {}),
          },
          provisions: paragraphs.map((p) => {
            const { relevant, reason } = vatcaScheduleRelevance(schedule, citation, p);
            return {
              sectionNumber: p.paragraphNumber,
              heading: p.heading || `Schedule ${schedule} paragraph ${p.paragraphNumber}`,
              locator: `Sch.${schedule} para ${p.paragraphNumber}`, part: p.part,
              category: p.category, relevant, relevanceReason: reason, excerpt: p.provisionText,
            };
          }),
        };
      },
    };
  }
  // The Act as enacted, from the Irish Statute Book PDF: one provision per
  // section, with the sections each cites.
  if (entry === 'vatca-2010/vatca-2010-enacted') {
    const { sourceUrl: url, title, citation } = VATCA_2010;
    return {
      url, title, citation, ext: 'pdf',
      build: (pdf, retrievedOn) => {
        const sections = parseVatca2010(convertStatutePdf(pdf, [
          '--section-re', String.raw`^(\d+[A-Z]?)\s*\.—`, '--start-after', 'BE IT ENACTED', '--stop-at', 'SCHEDULE',
        ]));
        if (sections.length === 0) throw new Error('VATCA 2010: the parser found no sections.');
        return {
          source: {
            citation, title, sourceType: 'legislation', jurisdiction: 'IE', sourceUrl: url,
            sha256: createHash('sha256').update(pdf).digest('hex'),
            conversion: 'isb-pdf-marginal-notes', retrievedOn,
            // The Act's own commencement (s.125), not the day it was fetched.
            publicationDate: VATCA_2010.enactedDate, effectiveFrom: VATCA_2010.enactedDate,
            note: VATCA_2010_ENACTED_NOTE,
          },
          provisions: sections.map((p) => {
            const { relevant, reason } = vatca2010Relevance(p);
            return {
              sectionNumber: p.sectionNumber, heading: p.heading, locator: `s.${p.sectionNumber}`,
              amendsSection: p.amendsSection.length ? p.amendsSection.join('; ') : null,
              category: p.category, relevant, relevanceReason: reason, excerpt: p.provisionText,
            };
          }),
        };
      },
    };
  }
  // A Finance Act as enacted, from the Irish Statute Book PDF: one provision
  // per section, as `pdftotext -layout` lays it out and statuteParser.ts reads it.
  const financeAct = FINANCE_ACTS[entry];
  if (financeAct) {
    const { act, curatedReason } = financeAct;
    return {
      url: act.sourceUrl, title: act.title, citation: act.citation, ext: 'pdf',
      build: (pdf, retrievedOn) => {
        const sections = parseFinanceAct2024(pdftotextLayout(pdf));
        if (sections.length === 0) throw new Error(`${act.title}: the parser found no sections.`);
        return {
          source: {
            citation: act.citation, title: act.title, sourceType: act.sourceType, jurisdiction: 'IE', sourceUrl: act.sourceUrl,
            sha256: createHash('sha256').update(pdf).digest('hex'),
            conversion: 'pdftotext-layout', retrievedOn,
            // The Act's own date of passing (its long title), not the day it was fetched.
            publicationDate: act.enactedDate, effectiveFrom: act.enactedDate,
          },
          provisions: sections.map((p) => {
            const { category, relevant, reason } = enactedActRelevance(p, curatedReason);
            return {
              sectionNumber: p.sectionNumber, heading: p.heading, locator: `s.${p.sectionNumber}`,
              amendsSection: p.amendsSection.length ? p.amendsSection.join('; ') : null,
              principalAct: p.principalActs.length ? p.principalActs.join('; ') : null,
              effectiveClue: p.effectiveClue, citedActs: p.citedActs,
              category, relevant, relevanceReason: reason, excerpt: p.provisionText,
            };
          }),
        };
      },
    };
  }
  // A TCA 1997 section as enacted, one Irish Statute Book page each, or
  // Finance Act 2003 s.23, which amends s.284: parsed as tca1997SectionParser.ts reads them.
  const tcaSection = TCA_SECTIONS[entry];
  if (tcaSection) {
    const { title, citation, url, compact, source, provision } = tcaSection;
    return {
      url, title, citation,
      build: (html, retrievedOn) => {
        const text = convertLrc(html, title, citation, url);
        const parsed = parseTca1997Section(compact ? withoutBlankLines(text) : text);
        return {
          source: {
            citation, title, sourceType: 'legislation', jurisdiction: 'IE', sourceUrl: url,
            sha256: createHash('sha256').update(html).digest('hex'),
            conversion: compact ? 'isb-html-plaintext-compact' : 'isb-html-plaintext', retrievedOn,
            publicationDate: null, ...source,
          },
          provisions: [{
            sectionNumber: parsed.sectionNumber, heading: parsed.heading, locator: `s.${parsed.sectionNumber}`,
            chapter: parsed.chapter, category: parsed.category, excerpt: parsed.provisionText, ...provision(parsed),
          }],
        };
      },
    };
  }
  // A TCA 1997 section as Finance Act 2011 s.20 inserted it: cut from that
  // Act's page (from the section's heading to the next section's), then
  // parsed as financeAct2011RctSectionParser.ts reads it.
  const rct = /^tca-1997\/s530([AEGHI])$/.exec(entry)?.[1];
  if (rct) {
    const key = `tca1997_s530${rct.toLowerCase()}` as RctFa2011SectionKey;
    const { citation, sourceUrl: url, effectiveFrom, sectionNumber } = RCT_FA2011_SECTIONS[key];
    const title = rctFa2011Title(sectionNumber);
    return {
      url, title, citation,
      build: (html, retrievedOn) => {
        const page = convertLrc(html, title, citation, url);
        const parsed = parseFinanceAct2011RctSection(`# ${title}\n\n${insertedSection(page, sectionNumber)}\n`);
        if (parsed.sectionNumber !== sectionNumber) throw new Error(`${entry}: cut s.${parsed.sectionNumber}, not s.${sectionNumber}.`);
        const { relevant, reason } = rctFa2011Relevance(key, sectionNumber);
        return {
          source: {
            citation, title, sourceType: 'legislation', jurisdiction: 'IE', sourceUrl: url,
            sha256: createHash('sha256').update(html).digest('hex'),
            conversion: 'isb-html-plaintext', retrievedOn,
            publicationDate: null, effectiveFrom, note: RCT_FA2011_NOTE,
          },
          provisions: [{
            sectionNumber, heading: parsed.heading, locator: `s.${sectionNumber}`,
            principalAct: RCT_FA2011_PRINCIPAL_ACT, citedActs: RCT_FA2011_CITED_ACTS,
            category: parsed.category, relevant, relevanceReason: reason, excerpt: parsed.provisionText,
          }],
        };
      },
    };
  }
  // A Revenue Tax and Duty Manual on RCT, from its PDF: the whole text, page
  // by page as pdfplumber extracts it, is one provision.
  const tdm = /^rct\/tdm-18-02-(04|05|11)$/.exec(entry)?.[1];
  if (tdm) {
    const key = `tdm_18_02_${tdm}` as RctTdmKey;
    const { title, citation, sourceType, sourceUrl: url, effectiveFrom } = RCT_TDM_SOURCES[key];
    return {
      url, title, citation, ext: 'pdf',
      build: (pdf, retrievedOn) => {
        const excerpt = pdfplumberText(pdf).trim();
        if (!excerpt.startsWith('<!-- page 1 of')) throw new Error(`${entry}: the PDF gave no text.`);
        const { relevant, reason } = rctTdmRelevance(key);
        return {
          source: {
            citation, title, sourceType, jurisdiction: 'IE', sourceUrl: url,
            sha256: createHash('sha256').update(pdf).digest('hex'),
            conversion: 'pdfplumber-full', retrievedOn,
            publicationDate: null, effectiveFrom, note: RCT_TDM_NOTE,
          },
          provisions: [{
            sectionNumber: 'full', heading: title, locator: 'whole document',
            category: 'procedure', relevant, relevanceReason: reason, excerpt,
          }],
        };
      },
    };
  }
  // Revenue's VAT registration manual, from its PDF: only the capacity
  // exclusion passage, which every Advice of Registration letter repeats.
  if (entry === 'tdm-38-01-03b/38-01-03b') {
    const { title, citation, sourceUrl: url, effectiveFrom, sectionNumber, note, relevanceReason } = TDM_38_01_03B;
    return {
      url, title, citation, ext: 'pdf',
      build: (pdf, retrievedOn) => {
        const section = extractCapacityExclusionSection(pdfplumberText(pdf));
        if (section.occurrences !== 4) throw new Error(`${entry}: expected the passage four times, found ${section.occurrences}.`);
        return {
          source: {
            citation, title, sourceType: 'revenue_guidance', jurisdiction: 'IE', sourceUrl: url,
            sha256: createHash('sha256').update(pdf).digest('hex'),
            conversion: 'pdfplumber-full', retrievedOn,
            publicationDate: null, effectiveFrom, note,
          },
          provisions: [{
            sectionNumber, heading: section.heading,
            locator: 'Appendix 8, page 40 (repeated in Appendices 9, 10 and 11)',
            category: 'procedure', relevant: true, relevanceReason, excerpt: section.provisionText,
          }],
        };
      },
    };
  }
  // A part of Revenue's Notes for Guidance on the TCA 1997, from its PDF as
  // `pdftotext -layout` lays it out: the section notes the curation reads.
  const nfgPart = /^tca-1997-nfg\/(part\w+)$/.exec(entry)?.[1];
  if (nfgPart && NFG_SECTIONS[nfgPart]) {
    const url = nfgSourceUrl(nfgPart);
    const title = naming?.title ?? nfgTitle(nfgPart);
    const citation = naming?.citation ?? nfgCitation(nfgPart);
    return {
      url, title, citation, ext: 'pdf',
      build: (pdf, retrievedOn) => {
        const text = pdftotextLayout(pdf);
        // Every section the part's contents list names has its own note, and
        // no other (issue #287): otherwise a note runs into the next.
        const { missing, unlisted } = compareNfgContents(text);
        if (missing.length || unlisted.length) {
          throw new Error(`${entry}: notes missing for ${missing.join(', ') || 'none'}; unlisted ${unlisted.join(', ') || 'none'}.`);
        }
        return {
          source: {
            citation, title, sourceType: 'revenue_guidance', jurisdiction: 'IE', sourceUrl: url,
            sha256: createHash('sha256').update(pdf).digest('hex'),
            conversion: 'pdftotext-layout', retrievedOn,
            publicationDate: null, effectiveFrom: NFG_EFFECTIVE_FROM, note: NFG_NOTE,
          },
          provisions: NFG_SECTIONS[nfgPart]!.map((n) => {
            const section = extractNfgSection(text, n);
            return {
              sectionNumber: section.sectionNumber, heading: section.heading, locator: `s.${section.sectionNumber}`,
              principalAct: '1997 Act 39', category: 'corporation_tax', relevant: true,
              relevanceReason: nfgRelevanceReason(nfgPart, n), excerpt: section.provisionText,
            };
          }),
        };
      },
    };
  }
  // A statutory instrument as made, from its Irish Statute Book page: the
  // regulations the knowledge base holds, parsed as the curation read them.
  const instrument = STATUTORY_INSTRUMENTS[entry];
  if (instrument) {
    const { title, citation, url, paragraphs, source, provisions } = instrument;
    return {
      url, title, citation,
      build: (html, retrievedOn) => {
        const text = convertLrc(html, title, citation, url, paragraphs);
        return {
          source: {
            citation, title, sourceType: 'legislation', jurisdiction: 'IE', sourceUrl: url,
            sha256: createHash('sha256').update(html).digest('hex'),
            conversion: paragraphs ? 'isb-html-plaintext-paragraphs' : 'isb-html-plaintext', retrievedOn,
            ...source,
          },
          provisions: provisions(text),
        };
      },
    };
  }
  // A section of an Act as enacted, on the Irish Statute Book: the source's
  // URL is the one its statute copy, or the entry, already records.
  const isb = isbSectionUrl(entry, naming);
  if (isb && naming) {
    const { url, section } = isb;
    return {
      url, title: naming.title, citation: naming.citation,
      build: (html, retrievedOn) => {
        const text = convertLrc(html, naming.title, naming.citation, url);
        const { heading, excerpt } = parseIsbSection(text, section);
        return {
          source: {
            citation: naming.citation, title: naming.title, sourceType: 'legislation', jurisdiction: 'IE', sourceUrl: url,
            sha256: createHash('sha256').update(html).digest('hex'),
            conversion: 'isb-html-plaintext', retrievedOn,
          },
          provisions: [{
            sectionNumber: section, heading, locator: `s.${section}`, category: 'vat', relevant: true,
            relevanceReason: 'Amends VATCA 2010 s.46; cited by the s.46 rate rules (vatcaRevisedCuration.ts).',
            excerpt,
          }],
        };
      },
    };
  }
  throw new Error(`No extractor for "${entry}". Add one to scripts/catalogue/extract.ts with the port (#556).`);
}

/** An Irish Statute Book enacted-section URL for the entry, from its statute copy or the entry itself. */
function isbSectionUrl(entry: string, naming: Naming | null): { url: string; section: string } | null {
  const url = naming?.sourceUrl;
  const m = url ? /^https:\/\/www\.irishstatutebook\.ie\/eli\/\d{4}\/act\/\d+\/section\/(\d+[A-Z]*)\/enacted\/en\/html$/.exec(url) : null;
  return m && url && entry.endsWith(`/s${m[1]}`) ? { url, section: m[1]! } : null;
}

/** The heading and text of one enacted section, from the converted page ("# title", heading, "39." and its text). */
function parseIsbSection(text: string, section: string): { heading: string; excerpt: string } {
  const body = text.split(/^# .*$/m)[1] ?? '';
  const start = body.search(new RegExp(`^${section}\\.`, 'm'));
  if (start < 0) throw new Error(`The page has no section ${section}.`);
  const heading = body.slice(0, start).trim();
  if (!heading || heading.includes('\n')) throw new Error(`Section ${section}: expected a one-line heading, found "${heading}".`);
  return { heading, excerpt: body.slice(start).trim() };
}

/**
 * The single-section pages tca1997SectionParser.ts reads, by entry name. The
 * 1997 pages' copies were the converted page with its blank lines dropped,
 * which the parser's layout needs (`compact`); FA 2003 s.23's kept them.
 */
const TCA_SECTIONS: Record<string, {
  title: string; citation: string; url: string; compact: boolean;
  source: Pick<CatalogueEntry['source'], 'effectiveFrom' | 'note'>;
  provision: (p: ParsedTcaSection) => Pick<CatalogueEntry['provisions'][number],
    'relevant' | 'relevanceReason' | 'amendsSection' | 'principalAct' | 'citedActs'>;
}> = {
  'tca-1997/s530': {
    title: TCA_1997_S530.title, citation: TCA_1997_S530.citation, url: TCA_1997_S530.sourceUrl, compact: true,
    source: { effectiveFrom: TCA_1997_S530.effectiveFrom, note: TCA_1997_S530.note },
    provision: (p) => {
      const { relevant, reason } = tca1997S530Relevance(p);
      return { relevant, relevanceReason: reason };
    },
  },
  'tca-1997/s284': {
    title: 'TCA 1997 s.284', citation: '1997 Act 39 s.284', compact: true,
    url: 'https://www.irishstatutebook.ie/eli/1997/act/39/section/284/enacted/en/html',
    source: { effectiveFrom: TCA_1997_AS_ENACTED_FROM, note: TCA_1997_AS_ENACTED_NOTE },
    provision: (p) => {
      const { relevant, reason } = tca1997SectionRelevance(p, CAPITAL_ALLOWANCES_CURATED_SECTIONS);
      return { relevant, relevanceReason: reason };
    },
  },
  'finance-act-2003/s23': {
    title: FINANCE_ACT_2003.title, citation: FINANCE_ACT_2003.citation, url: FINANCE_ACT_2003.sourceUrl, compact: false,
    source: { effectiveFrom: FINANCE_ACT_2003.effectiveFrom, note: FINANCE_ACT_2003.note },
    provision: () => ({
      relevant: true, relevanceReason: FINANCE_ACT_2003.relevanceReason, amendsSection: FINANCE_ACT_2003.amendsSection,
      principalAct: FINANCE_ACT_2003.principalAct, citedActs: FINANCE_ACT_2003.citedActs,
    }),
  },
};

/** A converted page with the blank lines after its title dropped. */
function withoutBlankLines(text: string): string {
  const title = text.search(/^# /m);
  return text.slice(0, title) + text.slice(title).split('\n').filter((l, i) => i === 0 || l.trim() !== '').join('\n');
}

/**
 * One section FA 2011 s.20 inserts, from its page as converted: its heading
 * (the line before "530A.—"), up to the line before the next section's heading.
 */
function insertedSection(page: string, sectionNumber: string): string {
  const lines = page.split('\n');
  const opens = lines.flatMap((l, i) => (/^\d+[A-Z]?\.—/.test(l) ? [i] : []));
  const open = opens.find((i) => lines[i]!.startsWith(`${sectionNumber}.—`));
  if (open === undefined) throw new Error(`The page has no section ${sectionNumber}.`);
  const headingOf = (i: number) => { let j = i - 1; while (j >= 0 && lines[j]!.trim() === '') j--; return j; };
  const next = opens.find((i) => i > open);
  const end = next === undefined ? lines.length : headingOf(next);
  return lines.slice(headingOf(open), end).join('\n').trim();
}

/**
 * The statutory instruments, by entry name. S.I. 156/2012's copy joined each
 * paragraph's lines, which the page breaks around every link (`paragraphs`).
 */
const STATUTORY_INSTRUMENTS: Record<string, {
  title: string; citation: string; url: string; paragraphs: boolean;
  source: Pick<CatalogueEntry['source'], 'publicationDate' | 'effectiveFrom' | 'note'>;
  provisions: (text: string) => CatalogueEntry['provisions'];
}> = {
  'si-639-2010/2010-si-639': {
    title: SI_639.title, citation: SI_639.citation, url: SI_639.sourceUrl, paragraphs: false,
    source: { publicationDate: null, effectiveFrom: SI_639.effectiveFrom, note: SI_639.note },
    provisions: (text) => parseSi639(text).map((reg) => {
      const { relevant, reason } = si639Relevance(reg);
      return {
        sectionNumber: reg.regulationNumber, heading: reg.heading, locator: `reg.${reg.regulationNumber}`,
        category: reg.category, relevant, relevanceReason: reason, excerpt: reg.provisionText,
      };
    }),
  },
  'si-156-2012/2012-si-156': {
    title: SI_156.title, citation: SI_156.citation, url: SI_156.sourceUrl, paragraphs: true,
    source: { publicationDate: null, effectiveFrom: SI_156.effectiveFrom, note: SI_156.note },
    provisions: (text) => {
      const regs = parseSi156(withRegulationHeadings(text)).filter((reg) => SI_156.regulations.includes(reg.regulationNumber));
      const found = regs.map((reg) => reg.regulationNumber).join(', ');
      if (found !== SI_156.regulations.join(', ')) throw new Error(`S.I. 156/2012: found regulations ${found}.`);
      return regs.map((reg) => {
        const { relevant, reason } = si156Relevance(reg);
        return {
          sectionNumber: reg.regulationNumber, heading: reg.heading, locator: `reg.${reg.regulationNumber}`,
          category: reg.category, relevant, relevanceReason: reason, excerpt: reg.provisionText,
        };
      });
    },
  },
  'si-69-2025/2025-si-69': {
    title: SI_69_2025.title, citation: SI_69_2025.citation, url: SI_69_2025.sourceUrl, paragraphs: false,
    source: { publicationDate: SI_69_2025.effectiveFrom, effectiveFrom: SI_69_2025.effectiveFrom, note: SI_69_2025.note },
    provisions: (text) => SI_69_2025_REGULATIONS.map((reg) => ({
      sectionNumber: reg.regulationNumber, heading: reg.heading, locator: `reg.${reg.regulationNumber}`,
      principalAct: SI_69_2025.principalAct, amendsSection: reg.amendsSection, citedActs: [SI_69_2025.principalAct],
      category: 'vat', relevant: true, relevanceReason: si692025RelevanceReason(reg.regulationNumber),
      excerpt: parseSi692025Regulation(text, reg.regulationNumber).provisionText,
    })),
  },
};

/**
 * An instrument's regulations under "## " headings, as si156Parser.ts reads
 * them: between the enacting clause and the Schedules, the line above each
 * "N. " opener is its heading.
 */
function withRegulationHeadings(text: string): string {
  const start = text.indexOf('make the following regulations:');
  if (start < 0) throw new Error('The page has no enacting clause.');
  const lines = text.slice(start).split('\n');
  const end = lines.findIndex((l) => /^SCHEDULE 1$/.test(l));
  const body = lines.slice(1, end < 0 ? lines.length : end);
  body.forEach((line, i) => {
    if (!/^\d+\. /.test(line)) return;
    let j = i - 1;
    while (j >= 0 && body[j]!.trim() === '') j--;
    if (j >= 0 && !/^\d+\. /.test(body[j]!)) body[j] = `## ${body[j]}`;
  });
  return body.join('\n');
}

/** The Finance Acts the script extracts as a whole, by entry name. */
const FINANCE_ACTS: Record<string, { act: KnowledgeSourceRef; curatedReason: (n: string) => string | undefined }> = {
  'finance-act-2024/2024-act-43-enacted': { act: FINANCE_ACT_2024, curatedReason: financeAct2024CuratedReason },
  'finance-act-2025/2025-act-18-enacted': { act: FINANCE_ACT_2025, curatedReason: financeAct2025CuratedReason },
};

/** A Revenue PDF as text, page by page (pdfplumber_to_text.py). */
function pdfplumberText(pdf: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'leabhar-catalogue-'));
  try {
    const input = join(dir, 'manual.pdf');
    writeFileSync(input, pdf);
    return execFileSync('python3', [PDFPLUMBER_CONVERTER, input], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A PDF as Poppler's `pdftotext -layout` lays it out. */
function pdftotextLayout(pdf: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'leabhar-catalogue-'));
  try {
    const input = join(dir, 'act.pdf');
    writeFileSync(input, pdf);
    return execFileSync('pdftotext', ['-layout', input, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** An Irish Statute Book PDF in the marginal-note layout, as text (convert-statute-pdf.ts). */
function convertStatutePdf(pdf: Buffer, options: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'leabhar-catalogue-'));
  try {
    const input = join(dir, 'act.pdf');
    const output = join(dir, 'act.md');
    writeFileSync(input, pdf);
    execFileSync('npx', ['tsx', PDF_CONVERTER, input, output, ...options], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
    return readFileSync(output, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function convertLrc(html: Buffer, title: string, citation: string, url: string, paragraphs = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'leabhar-catalogue-'));
  try {
    const page = join(dir, 'page.html');
    writeFileSync(page, html);
    return execFileSync('python3', [CONVERTER, page, title, citation, url, ...(paragraphs ? ['--paragraphs'] : [])], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Whether the entry carries the page's LRC footnotes. They date a rule from
 * the last amendment to the words it quotes, so adding them can move a rule's
 * start. A port changes nothing: the footnotes come along only where the
 * statute copy had its HTML beside it (as the derivation read before), or the
 * entry already has them, or `--lrc-annotations` asks for them.
 */
function annotates(name: string, previous: CatalogueEntry | null, args: string[]): boolean {
  return args.includes('--lrc-annotations') || previous?.source.lrcAnnotations !== undefined
    || existsSync(join(ROOT, 'docs', 'statutes', `${name}.html`));
}

/** Each rule version whose dates differ from the previous entry's, or that is new or gone. */
function movedWindows(previous: CatalogueEntry | null, entry: CatalogueEntry): Array<{ key: string; what: string }> {
  if (!previous) return [];
  const span = (v: { effectiveFrom: string; effectiveTo: string | null }) => `${v.effectiveFrom} to ${v.effectiveTo ?? 'open'}`;
  const versions = (e: CatalogueEntry) => new Map(e.rules.flatMap((r) => r.versions.map((v) => [`${r.key}@${v.version}`, { key: r.key, v }] as const)));
  const before = versions(previous);
  const after = versions(entry);
  const moved: Array<{ key: string; what: string }> = [];
  for (const [id, { key, v }] of after) {
    const old = before.get(id);
    if (!old) moved.push({ key, what: `${id} is new (${span(v)})` });
    else if (span(old.v) !== span(v)) moved.push({ key, what: `${id} moved from ${span(old.v)} to ${span(v)}` });
  }
  for (const [id, { key, v }] of before) if (!after.has(id)) moved.push({ key, what: `${id} is gone (was ${span(v)})` });
  return moved;
}

async function fetchOfficial(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'User-Agent': 'Leabhar-catalogue/1.0' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(args: string[]): Promise<void> {
  const names = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  if (names.length === 0) {
    throw new Error('Usage: npm run catalogue:extract -- <entry, e.g. vatca-2010-revised/s046> [more entries] '
      + '[--html <file> | --html-dir <dir>] [--retrieved-on <date>]');
  }
  const htmlFile = flag(args, 'html');
  const htmlDir = flag(args, 'html-dir');
  if (htmlFile && names.length > 1) throw new Error('--html names one page; use --html-dir for several entries.');

  // 1. Every entry's source and provisions: the knowledge base loads them from the entries.
  const written: Array<{ name: string; entryFile: string; path: string; entry: CatalogueEntry; previous: CatalogueEntry | null }> = [];
  for (const name of names) {
    const entryFile = `${name}.json`;
    const path = catalogueEntryPath(entryFile, ROOT);
    const previous = existsSync(path) ? validateCatalogueEntry(JSON.parse(readFileSync(path, 'utf8')), entryFile) : null;
    const extractor = extractorFor(name, existingNaming(name, previous));
    const saved = htmlFile ?? (htmlDir ? join(htmlDir, `${name.split('/').pop()}.${extractor.ext ?? 'html'}`) : undefined);
    const html = saved ? readFileSync(saved) : await fetchOfficial(extractor.url);
    const retrievedOn = flag(args, 'retrieved-on') ?? (saved ? previous?.source.retrievedOn : undefined) ?? nowIso().slice(0, 10);
    const built = extractor.build(html, retrievedOn, annotates(name, previous, args));
    if (previous && previous.source.sha256 === built.source.sha256) built.source.retrievedOn = previous.source.retrievedOn;
    const entry: CatalogueEntry = { format: CATALOGUE_FORMAT, ...built, rules: [] };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(catalogueOfficialFilePath(entryFile, ROOT, extractor.ext ?? 'html'), html);
    writeFileSync(path, serialiseCatalogueEntry(entry));
    written.push({ name, entryFile, path, entry, previous });
  }

  // 2. Load the knowledge base once, then write each entry's rules.
  const { db } = createTestDatabase();
  const { companyId } = createCompany(db, { legalName: 'Catalogue extraction', vatRegistrationStatus: 'registered', seedYears: [2025] });
  loadStatutoryKnowledgeBase(db, { companyId, root: ROOT });
  for (const { entryFile, path, entry, previous } of written) {
    entry.rules = catalogueRulesFor(db, { companyId, entry, previous });
    writeFileSync(path, serialiseCatalogueEntry(validateCatalogueEntry(entry, entryFile)));
    const changed = previous && previous.source.sha256 !== entry.source.sha256;
    console.log(`wrote ${path}: ${entry.provisions.length} provision(s), ${entry.rules.length} rule(s)`
      + `${changed ? `; the source hash changed from ${previous.source.sha256}, so every approval was reset` : ''}`);
    // A moved window changes what the rule decides on some dates: name it and
    // what reads it, before the entry is committed (#694).
    for (const moved of movedWindows(previous, entry)) {
      const readers = ruleImpact(db, { companyId, target: { kind: 'rule', ruleKey: moved.key } }).consumers.map((c) => c.name);
      console.log(`  ${moved.what}; read by ${readers.length ? readers.join(', ') : 'no declared consumer'}`);
    }
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
