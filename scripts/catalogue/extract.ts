/**
 * Write a rules catalogue entry from the official file (issue #443 step 2,
 * issue #686 step 10). A developer step, never run by the app:
 *
 *   npm run catalogue:extract -- vatca-2010-revised/s046
 *   npm run catalogue:extract -- vatca-2010-revised/s046 --html saved.html --retrieved-on 2026-09-29
 *
 * 1. Fetch the official page into a temporary directory (or read `--html`, a
 *    copy saved from the same URL). Nothing fetched is committed.
 * 2. Convert it to text (lrc_html_to_text.py) and parse it with the same
 *    parser the rules were curated against.
 * 3. Write the entry's source and provisions, load the knowledge base into a
 *    throwaway book from it, and write the rules the curation derives, with
 *    their links. An approval in the previous entry is kept only for a version
 *    and a source hash that have not changed.
 *
 * Review the diff before committing it: a changed hash or excerpt means the
 * law, or its consolidation, has moved (`verify-sources` reports the same).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '@/domain/config/setup';
import {
  CATALOGUE_FORMAT, catalogueEntryPath, catalogueRulesFor, serialiseCatalogueEntry, validateCatalogueEntry,
  type CatalogueEntry,
} from '@/domain/rules/catalogue';
import { loadStatutoryKnowledgeBase } from '@/domain/rules/knowledgeBase';
import { parseVatcaRevisedSection } from '@/domain/rules/vatcaRevisedSectionParser';
import { vatcaRevisedRelevance } from '@/domain/rules/vatcaRevisedIngestion';
import { nowIso } from '@/domain/dates';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const CONVERTER = join(ROOT, 'scripts', 'catalogue', 'lrc_html_to_text.py');

interface Extractor {
  url: string;
  title: string;
  citation: string;
  /** The entry's source and provisions, from the official file's bytes. */
  build: (html: Buffer, retrievedOn: string) => Pick<CatalogueEntry, 'source' | 'provisions'>;
}

/** The sources the script can extract, by entry name. Each port adds its own. */
function extractorFor(entry: string): Extractor {
  const section = /^vatca-2010-revised\/s0*(\d+[A-Z]*)$/.exec(entry)?.[1];
  if (section) {
    const url = `https://revisedacts.lawreform.ie/eli/2010/act/31/section/${section}/revised/en/html`;
    const title = `VATCA 2010 s.${section} (revised)`;
    const citation = `2010 Act 31 s.${section}`;
    return {
      url, title, citation,
      build: (html, retrievedOn) => {
        const markdown = convertLrc(html, title, citation, url);
        const parsed = parseVatcaRevisedSection(markdown);
        const { relevant, reason } = vatcaRevisedRelevance(parsed.sectionNumber, citation, parsed.category);
        return {
          source: {
            citation, title, sourceType: 'legislation', jurisdiction: 'IE', sourceUrl: url,
            sha256: createHash('sha256').update(html).digest('hex'),
            conversion: 'lrc-html-plaintext', retrievedOn,
          },
          provisions: [{
            sectionNumber: parsed.sectionNumber, heading: parsed.heading, locator: `s.${parsed.sectionNumber}`,
            category: parsed.category, relevant, relevanceReason: reason, excerpt: parsed.provisionText,
          }],
        };
      },
    };
  }
  throw new Error(`No extractor for "${entry}". Add one to scripts/catalogue/extract.ts with the port (#556).`);
}

function convertLrc(html: Buffer, title: string, citation: string, url: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'leabhar-catalogue-'));
  try {
    const page = join(dir, 'page.html');
    writeFileSync(page, html);
    return execFileSync('python3', [CONVERTER, page, title, citation, url], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  const name = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
  if (!name) throw new Error('Usage: npm run catalogue:extract -- <entry, e.g. vatca-2010-revised/s046> [--html <file>] [--retrieved-on <date>]');
  const entryFile = `${name}.json`;
  const path = catalogueEntryPath(entryFile, ROOT);
  const previous = existsSync(path) ? validateCatalogueEntry(JSON.parse(readFileSync(path, 'utf8')), entryFile) : null;
  const extractor = extractorFor(name);

  const htmlFile = flag(args, 'html');
  const html = htmlFile ? readFileSync(htmlFile) : await fetchOfficial(extractor.url);
  const retrievedOn = flag(args, 'retrieved-on') ?? (htmlFile ? previous?.source.retrievedOn : undefined) ?? nowIso().slice(0, 10);
  const built = extractor.build(html, retrievedOn);
  if (previous && previous.source.sha256 === built.source.sha256) built.source.retrievedOn = previous.source.retrievedOn;

  // The source and provisions first: the knowledge base loads them from the entry.
  const entry: CatalogueEntry = { format: CATALOGUE_FORMAT, ...built, rules: [] };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serialiseCatalogueEntry(entry));

  const { db } = createTestDatabase();
  const { companyId } = createCompany(db, { legalName: 'Catalogue extraction', vatRegistrationStatus: 'registered', seedYears: [2025] });
  loadStatutoryKnowledgeBase(db, { companyId, root: ROOT });
  entry.rules = catalogueRulesFor(db, { companyId, entry, previous });
  writeFileSync(path, serialiseCatalogueEntry(validateCatalogueEntry(entry, entryFile)));

  const changed = previous && previous.source.sha256 !== entry.source.sha256;
  console.log(`wrote ${path}: ${entry.provisions.length} provision(s), ${entry.rules.length} rule(s)`
    + `${changed ? `; the source hash changed from ${previous.source.sha256}, so every approval was reset` : ''}`);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
