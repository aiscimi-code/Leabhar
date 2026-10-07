/**
 * A statute copy a book loaded before its source was ported to the rules
 * catalogue, whose words are not the official words the entry holds (#706).
 *
 * `ingestCatalogueEntry` recognises a held source by its hash or by its words.
 * A copy that lost a closing quote, kept its transcript's Markdown marks, or
 * was edited by hand is neither, so the entry loads as a second source under
 * the same citation. This supersedes the copy explicitly instead of leaving
 * the duplicate:
 *
 *   - the copy is kept as it is: a held document is never edited or deleted;
 *   - each rule on a copy provision moves to the entry's provision for the
 *     same section, when that provision still holds the rule's words (layout
 *     aside). A rule whose words are gone stays where it is, and its
 *     derivation supersedes it with a new version;
 *   - a review item puts the difference on the record:
 *     `catalogue-punctuation:<citation>` when only punctuation, marks or a
 *     converter's page markers differ (the letters and digits are the same), and
 *     `catalogue-wording:<citation>` when the words do.
 *
 * Derivations and cross-references then prefer the catalogue source when both
 * are held (`preferredSourceId`, `dependencies.ts`).
 */
import { eq, inArray, sql } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishActProvisions, irishKnowledgeSources, irishTaxRules } from '@/db/schema';
import { upsertReviewItem } from '../extraction/service';
import { containsIgnoringLayout } from './lrcAnnotations';

type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0];

/** The catalogue's directory, as a source's `localPath` starts (catalogue.ts's CATALOGUE_DIR). */
const CATALOGUE_PREFIX = 'catalogue/';

/** Whether a held source was loaded from the rules catalogue. */
export function isCatalogueSource(localPath: string | null): boolean {
  return localPath?.startsWith(CATALOGUE_PREFIX) ?? false;
}

/**
 * The source a derivation reads for a citation: the catalogue's when the book
 * also holds a pre-port copy, else the first held. Deterministic, where a bare
 * `.get()` returned whichever row the database gave first (#706).
 */
export function preferredSourceId(db: AppDatabase | Tx, citation: string): string | undefined {
  return db.select({ id: irishKnowledgeSources.id }).from(irishKnowledgeSources)
    .where(eq(irishKnowledgeSources.citation, citation))
    .orderBy(catalogueSourcesFirst(), sql`rowid`)
    .get()?.id;
}

/** An ordering that puts sources loaded from the catalogue before a pre-port copy. */
export function catalogueSourcesFirst() {
  return sql`(${irishKnowledgeSources.localPath} like ${`${CATALOGUE_PREFIX}%`}) desc`;
}

/**
 * Letters and digits only, lower-cased: what is left when punctuation and
 * marks are set aside. A converter's own markers (`<!-- page 8 of 13 -->`)
 * are not the source's words and are left out too.
 */
function lettersAndDigits(s: string): string {
  return (s.replace(/<!--[\s\S]*?-->/g, ' ').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(' ');
}

export interface HeldCopySupersession {
  copySourceId: string;
  /** Rule ids moved to the catalogue's provisions. */
  moved: string[];
  /** Rule ids left on the copy: their words are not in the entry's provision. */
  kept: string[];
  /** The sections whose words differ, and how. */
  differences: Array<{ sectionNumber: string; kind: 'punctuation' | 'wording' | 'missing' }>;
}

/**
 * Supersede one held pre-port copy with the catalogue source just loaded
 * under the same citation. Runs inside the transaction that loaded it.
 */
export function supersedeHeldCopy(
  tx: Tx,
  params: {
    companyId: string | null;
    citation: string;
    catalogueLocalPath: string;
    copy: { id: string; localPath: string | null; sha256: string };
    catalogueProvisions: Array<{ id: string; sectionNumber: string; text: string }>;
  },
): HeldCopySupersession {
  const copyProvisions = tx.select({ id: irishActProvisions.id, sectionNumber: irishActProvisions.sectionNumber, text: irishActProvisions.provisionText })
    .from(irishActProvisions).where(eq(irishActProvisions.sourceId, params.copy.id)).all();
  const bySection = new Map(params.catalogueProvisions.map((p) => [p.sectionNumber, p]));

  const differences: HeldCopySupersession['differences'] = [];
  for (const old of copyProvisions) {
    const now = bySection.get(old.sectionNumber);
    if (!now) differences.push({ sectionNumber: old.sectionNumber, kind: 'missing' });
    else if (now.text.replace(/\s+/g, ' ').trim() === (old.text ?? '').replace(/\s+/g, ' ').trim()) continue;
    else differences.push({ sectionNumber: old.sectionNumber, kind: lettersAndDigits(now.text) === lettersAndDigits(old.text ?? '') ? 'punctuation' : 'wording' });
  }

  const moved: string[] = [];
  const kept: string[] = [];
  const companies = new Set<string>(params.companyId ? [params.companyId] : []);
  const rules = copyProvisions.length === 0 ? [] : tx.select({
    id: irishTaxRules.id, companyId: irishTaxRules.companyId, provisionId: irishTaxRules.provisionId, statement: irishTaxRules.statement,
  }).from(irishTaxRules).where(inArray(irishTaxRules.provisionId, copyProvisions.map((p) => p.id))).all();
  const sectionOf = new Map(copyProvisions.map((p) => [p.id, p.sectionNumber]));
  for (const rule of rules) {
    companies.add(rule.companyId);
    const target = bySection.get(sectionOf.get(rule.provisionId)!);
    if (target && rule.statement && containsIgnoringLayout(target.text, rule.statement)) {
      tx.update(irishTaxRules).set({ provisionId: target.id }).where(eq(irishTaxRules.id, rule.id)).run();
      moved.push(rule.id);
    } else {
      kept.push(rule.id);
    }
  }

  const wording = differences.some((d) => d.kind !== 'punctuation');
  const what = wording ? 'wording' : 'punctuation';
  const listed = differences.map((d) => `${d.sectionNumber} (${d.kind === 'missing' ? 'not in the catalogue entry' : d.kind})`).join(', ');
  for (const companyId of companies) {
    upsertReviewItem(tx, {
      companyId,
      kind: 'other',
      severity: wording ? 'warning' : 'info',
      title: `${params.citation}: the copy this book loaded differs from the official ${wording ? 'words' : 'punctuation'}`,
      detail: `This book loaded ${params.citation} from a statute copy (${params.copy.localPath ?? 'no local path'}, `
        + `SHA-256 ${params.copy.sha256}) before the source moved to the rules catalogue. The catalogue holds the official `
        + `words (${params.catalogueLocalPath}), which differ in ${listed || 'no provision'}`
        + `${wording ? '' : ': the letters and digits are the same; only punctuation or marks differ'}. `
        + 'The copy is kept as it was. '
        + `${moved.length} rule${moved.length === 1 ? '' : 's'} now read the catalogue's provisions`
        + `${kept.length ? `; ${kept.length} whose words the catalogue does not hold stay on the copy, and the next load supersedes them with a new version` : ''}. `
        + 'Check the difference against the official text.',
      entityType: 'irish_knowledge_source',
      entityId: params.copy.id,
      dedupeKey: `catalogue-${what}:${params.citation}`,
      context: { copySourceId: params.copy.id, differences, movedRuleIds: moved, keptRuleIds: kept },
    });
  }
  return { copySourceId: params.copy.id, moved, kept, differences };
}

/** The pre-port copies a book holds under a citation: sources not loaded from the catalogue. */
export function heldCopies(tx: Tx | AppDatabase, citation: string): Array<{ id: string; localPath: string | null; sha256: string }> {
  return tx.select({ id: irishKnowledgeSources.id, localPath: irishKnowledgeSources.localPath, sha256: irishKnowledgeSources.sha256 })
    .from(irishKnowledgeSources).where(eq(irishKnowledgeSources.citation, citation)).all()
    .filter((s) => !isCatalogueSource(s.localPath));
}
