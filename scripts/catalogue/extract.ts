/**
 * Write a rules catalogue entry from the official file (issue #443 step 2,
 * issue #686 step 10). A developer step, never run by the app:
 *
 *   npm run catalogue:extract -- vatca-2010-revised/s046
 *   npm run catalogue:extract -- vatca-2010-revised/s046 --html saved.html --retrieved-on 2026-09-29
 *   npm run catalogue:extract -- vatca-2010-revised/s009 vatca-2010-revised/s010 --html-dir pages/
 *
 * Several entries are extracted together: every entry's source and
 * provisions are written first, then the knowledge base is loaded once and
 * each entry's rules are written (a rule can rely on another entry's).
 * `--html-dir` holds a saved copy of each page, named after the entry's last
 * part (`s009.html`). `--lrc-annotations` keeps the page's amendment
 * footnotes in the entry (see `annotates`).
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
  CATALOGUE_FORMAT, catalogueEntryPath, catalogueRulesFor, serialiseCatalogueEntry, validateCatalogueEntry,
  type CatalogueEntry,
} from '@/domain/rules/catalogue';
import { loadStatutoryKnowledgeBase } from '@/domain/rules/knowledgeBase';
import { parseVatcaRevisedSection } from '@/domain/rules/vatcaRevisedSectionParser';
import { vatcaRevisedRelevance } from '@/domain/rules/vatcaRevisedIngestion';
import { nowIso } from '@/domain/dates';
import { lrcAnnotationLayer } from '@/domain/rules/lrcAnnotations';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const CONVERTER = join(ROOT, 'scripts', 'catalogue', 'lrc_html_to_text.py');

/** The title and citation a source already goes by: the entry's, else its statute copy's front matter. */
interface Naming { title: string; citation: string }

function existingNaming(entry: string, previous: CatalogueEntry | null): Naming | null {
  if (previous) return { title: previous.source.title, citation: previous.source.citation };
  const copy = join(ROOT, 'docs', 'statutes', `${entry}.md`);
  if (!existsSync(copy)) return null;
  const front = readFileSync(copy, 'utf8').split('---')[1] ?? '';
  const field = (name: string) => new RegExp(`^${name}: "?(.*?)"?$`, 'm').exec(front)?.[1];
  const title = field('title');
  const citation = field('citation');
  return title && citation ? { title, citation } : null;
}

interface Extractor {
  url: string;
  title: string;
  citation: string;
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
    const saved = htmlFile ?? (htmlDir ? join(htmlDir, `${name.split('/').pop()}.html`) : undefined);
    const html = saved ? readFileSync(saved) : await fetchOfficial(extractor.url);
    const retrievedOn = flag(args, 'retrieved-on') ?? (saved ? previous?.source.retrievedOn : undefined) ?? nowIso().slice(0, 10);
    const built = extractor.build(html, retrievedOn, annotates(name, previous, args));
    if (previous && previous.source.sha256 === built.source.sha256) built.source.retrievedOn = previous.source.retrievedOn;
    const entry: CatalogueEntry = { format: CATALOGUE_FORMAT, ...built, rules: [] };
    mkdirSync(dirname(path), { recursive: true });
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
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
