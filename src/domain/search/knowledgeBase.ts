import { and, asc, eq, or, sql } from 'drizzle-orm';
import type { AppDatabase } from '@/db';
import { irishActProvisions, irishKnowledgeSources, irishTaxRules } from '@/db/schema';
import { provisionCitation } from '../rules/citation';

/**
 * Search over the statutory knowledge base (issue #311: full-text and semantic
 * search; issues #445/#446).
 *
 * Two retrieval modes, both deterministic and both local (this is a
 * local-first desktop app — no embedding service, no network call):
 *
 *  - **Full text** (`searchProvisions`, `searchStatutoryRules`,
 *    `searchKnowledgeSources`) is a LIKE search over the ingested words, like
 *    the rest of `src/domain/search/search.ts`. It finds what is literally
 *    there.
 *  - **Semantic** (`semanticSearchProvisions`) is a TF-IDF cosine ranking over
 *    the provisions' own text. It retrieves *candidates*: provisions that are
 *    statistically close to the question even when they share no literal
 *    phrase with it. Per the task brief, semantic retrieval may surface
 *    candidates but must never by itself determine an accounting or VAT
 *    treatment — so a semantic hit carries no treatment, no rule verdict and
 *    no rate: only the provision, its citation and the terms that connected
 *    it. Reading the provision and applying the rules is the person's job,
 *    through the ordinary lookup paths.
 *
 * Both are pure functions of the stored rows and the query string: the same
 * database and the same query always produce the same ranking, in the same
 * order (ties break on section number, then id), which is what the
 * deterministic tests in `knowledgeBase.test.ts` assert.
 */

/** Characters of context shown either side of a full-text match's first occurrence. */
const SNIPPET_RADIUS = 90;

export interface ProvisionHit {
  provisionId: string;
  sectionNumber: string;
  heading: string;
  /** Full citation including the section, e.g. "2010 Act 31 s.46". */
  citation: string;
  sourceId: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceType: string;
  /** Which field the query was found in. */
  matchedOn: string;
  /** A window around the match, so the result is judgeable without opening it. */
  snippet: string;
}

export interface SemanticProvisionHit extends ProvisionHit {
  /** Cosine similarity of the query and the provision's TF-IDF vectors, 0-1. */
  score: number;
  /** Query terms (stemmed) that also occur in this provision — why it ranked. */
  matchedTerms: string[];
}

/** The provision columns a search reads. Everything else stays in the row it lives in. */
const PROVISION_SEARCH_COLUMNS = {
  id: irishActProvisions.id,
  sectionNumber: irishActProvisions.sectionNumber,
  heading: irishActProvisions.heading,
  provisionText: irishActProvisions.provisionText,
  sourceId: irishKnowledgeSources.id,
  sourceTitle: irishKnowledgeSources.title,
  sourceUrl: irishKnowledgeSources.sourceUrl,
  sourceType: irishKnowledgeSources.sourceType,
  citation: irishKnowledgeSources.citation,
} as const;

type ProvisionSearchRow = {
  id: string;
  sectionNumber: string;
  heading: string;
  provisionText: string | null;
  sourceId: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceType: string;
  citation: string;
};

function toHit(row: ProvisionSearchRow, matchedOn: string, query: string): ProvisionHit {
  return {
    provisionId: row.id,
    sectionNumber: row.sectionNumber,
    heading: row.heading,
    citation: provisionCitation(row.citation, row.sectionNumber),
    sourceId: row.sourceId,
    sourceTitle: row.sourceTitle,
    sourceUrl: row.sourceUrl,
    sourceType: row.sourceType,
    matchedOn,
    snippet: snippetAround(row.provisionText, query),
  };
}

/**
 * A window around the first occurrence of any query word in the provision's
 * own text, so a hit can be judged without opening it. The slice is taken from
 * `provisionText` verbatim (never reworded) and marked with an ellipsis when
 * it does not cover the whole text.
 */
function snippetAround(text: string | null, query: string): string {
  if (!text) return '';
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
  let at = -1;
  for (const word of words) {
    at = text.toLowerCase().indexOf(word);
    if (at >= 0) break;
  }
  if (at < 0) {
    // The match was in the heading or the section number, not the text.
    return text.length <= 2 * SNIPPET_RADIUS ? text : `${text.slice(0, 2 * SNIPPET_RADIUS)}…`;
  }
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + wordLengthAt(text, at) + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

/** Length of the word starting at `at`, so the snippet ends after the match, not inside it. */
function wordLengthAt(text: string, at: number): number {
  let end = at;
  while (end < text.length && /\S/.test(text.charAt(end))) end += 1;
  return end - at;
}

/**
 * Full-text search over ingested provisions (issue #445). Matches the query
 * as a substring of the heading, the provision's own text or the section
 * number — the same semantics as the rest of global search.
 */
export function searchProvisions(
  db: AppDatabase,
  params: { companyId: string; query: string; limit?: number },
): ProvisionHit[] {
  const raw = params.query.trim();
  if (raw.length < 2) return [];
  const needle = `%${raw.toLowerCase()}%`;
  const lowered = raw.toLowerCase();

  const rows = db.select(PROVISION_SEARCH_COLUMNS)
    .from(irishActProvisions)
    .innerJoin(irishKnowledgeSources, eq(irishActProvisions.sourceId, irishKnowledgeSources.id))
    .where(and(
      eq(irishActProvisions.companyId, params.companyId),
      or(
        sql`LOWER(${irishActProvisions.heading}) LIKE ${needle}`,
        sql`LOWER(COALESCE(${irishActProvisions.provisionText}, '')) LIKE ${needle}`,
        sql`LOWER(${irishActProvisions.sectionNumber}) LIKE ${needle}`,
      ),
    ))
    .orderBy(asc(irishActProvisions.sectionNumber))
    .limit(params.limit ?? 25)
    .all();

  return rows.map((row) => toHit(
    row,
    row.heading.toLowerCase().includes(lowered)
      ? 'Provision heading'
      : row.sectionNumber.toLowerCase().includes(lowered)
        ? 'Section number'
        : 'Provision text',
    raw,
  ));
}

/**
 * Full-text search over the derived statutory rules (the `irish_tax_rules`
 * the extraction pipeline produced), by name, statement, key or topic. The
 * coding-rules engine's own `rules` table is searched separately by global
 * search; these are the machine-derived statute rules.
 */
export function searchStatutoryRules(
  db: AppDatabase,
  params: { companyId: string; query: string; limit?: number },
): Array<ProvisionHit & { ruleId: string; ruleKey: string; ruleName: string; topic: string; reviewStatus: string }> {
  const raw = params.query.trim();
  if (raw.length < 2) return [];
  const needle = `%${raw.toLowerCase()}%`;
  const lowered = raw.toLowerCase();

  const rows = db.select({
    ruleId: irishTaxRules.id,
    ruleKey: irishTaxRules.ruleKey,
    ruleName: irishTaxRules.name,
    topic: irishTaxRules.topic,
    reviewStatus: irishTaxRules.reviewStatus,
    statement: irishTaxRules.statement,
    id: irishActProvisions.id,
    provisionId: irishActProvisions.id,
    sectionNumber: irishActProvisions.sectionNumber,
    heading: irishActProvisions.heading,
    provisionText: irishActProvisions.provisionText,
    sourceId: irishKnowledgeSources.id,
    sourceTitle: irishKnowledgeSources.title,
    sourceUrl: irishKnowledgeSources.sourceUrl,
    sourceType: irishKnowledgeSources.sourceType,
    citation: irishKnowledgeSources.citation,
  })
    .from(irishTaxRules)
    .innerJoin(irishActProvisions, eq(irishTaxRules.provisionId, irishActProvisions.id))
    .innerJoin(irishKnowledgeSources, eq(irishActProvisions.sourceId, irishKnowledgeSources.id))
    .where(and(
      eq(irishTaxRules.companyId, params.companyId),
      or(
        sql`LOWER(${irishTaxRules.name}) LIKE ${needle}`,
        sql`LOWER(COALESCE(${irishTaxRules.statement}, '')) LIKE ${needle}`,
        sql`LOWER(${irishTaxRules.ruleKey}) LIKE ${needle}`,
        sql`LOWER(${irishTaxRules.topic}) LIKE ${needle}`,
      ),
    ))
    .orderBy(asc(irishTaxRules.ruleKey))
    .limit(params.limit ?? 25)
    .all();

  return rows.map((row) => ({
    ...toHit(row, row.ruleName.toLowerCase().includes(lowered) ? 'Rule name' : 'Rule statement', raw),
    ruleId: row.ruleId,
    ruleKey: row.ruleKey,
    ruleName: row.ruleName,
    topic: row.topic,
    reviewStatus: row.reviewStatus,
  }));
}

/**
 * Full-text search over the ingested source documents themselves — a search
 * for "2024 Act 43" or a Revenue manual's title should find the document, not
 * just its provisions.
 */
export function searchKnowledgeSources(
  db: AppDatabase,
  params: { companyId: string; query: string; limit?: number },
): Array<{ sourceId: string; title: string; citation: string; sourceType: string; sourceUrl: string; matchedOn: string }> {
  const raw = params.query.trim();
  if (raw.length < 2) return [];
  const needle = `%${raw.toLowerCase()}%`;
  const lowered = raw.toLowerCase();

  const rows = db.select({
    sourceId: irishKnowledgeSources.id,
    title: irishKnowledgeSources.title,
    citation: irishKnowledgeSources.citation,
    sourceType: irishKnowledgeSources.sourceType,
    sourceUrl: irishKnowledgeSources.sourceUrl,
  })
    .from(irishKnowledgeSources)
    .where(and(
      eq(irishKnowledgeSources.companyId, params.companyId),
      or(
        sql`LOWER(${irishKnowledgeSources.title}) LIKE ${needle}`,
        sql`LOWER(${irishKnowledgeSources.citation}) LIKE ${needle}`,
      ),
    ))
    .limit(params.limit ?? 25)
    .all();

  return rows.map((row) => ({
    ...row,
    matchedOn: row.citation.toLowerCase().includes(lowered) ? 'Citation' : 'Title',
  }));
}

// ---------------------------------------------------------------------------
// Semantic retrieval (issue #446): TF-IDF cosine over the provisions' own text.
// ---------------------------------------------------------------------------

/**
 * Words that carry no legal meaning and occur in almost every English
 * sentence. Removing them keeps a long boilerplate provision from drowning
 * out the few words that actually distinguish it.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'his', 'i', 'if', 'in', 'into', 'is', 'it',
  'its', 'no', 'not', 'of', 'on', 'or', 'shall', 'she', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'were', 'which',
  'will', 'with', 'would', 'you', 'your',
]);

/**
 * A deliberately minimal suffix stemmer, applied identically to the query
 * and to the provision text, so "rates", "supplies" and "taxes" meet "rate",
 * "supply" and "tax". It is not a Porter stemmer and does not pretend to be:
 * it only removes plural/possessive endings, which is what statute prose
 * mostly varies on. Anything else stays whole.
 */
export function stem(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(?:sses|shes|ches|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('s') && !/(?:ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

/** Lowercase words of a text, stopwords removed, plural endings stemmed. */
export function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/[’']s\b/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w))
    .map(stem);
}

/**
 * Statistically closest provisions to a question (issue #446).
 *
 * Every provision's own words (heading + text) are turned into a
 * length-normalised TF-IDF vector; the query is turned into one the same way;
 * provisions are ranked by cosine similarity. This is the local, deterministic
 * substitute for an embedding-based semantic search, which a local-first
 * desktop app has no server to call — and, being purely a ranking of
 * *candidates*, it decides nothing: the hit carries the provision and the
 * terms that connected it, never a treatment, a rate or a verdict.
 *
 * Ties break on section number then provision id, so the same book and the
 * same question always rank identically.
 */
export function semanticSearchProvisions(
  db: AppDatabase,
  params: { companyId: string; query: string; limit?: number },
): SemanticProvisionHit[] {
  const raw = params.query.trim();
  const queryTerms = tokenize(raw);
  if (raw.length < 2 || queryTerms.length === 0) return [];

  const rows = db.select(PROVISION_SEARCH_COLUMNS)
    .from(irishActProvisions)
    .innerJoin(irishKnowledgeSources, eq(irishActProvisions.sourceId, irishKnowledgeSources.id))
    .where(eq(irishActProvisions.companyId, params.companyId))
    .orderBy(asc(irishActProvisions.sectionNumber), asc(irishActProvisions.id))
    .all();

  if (rows.length === 0) return [];

  // Document frequency per term, then the idf weights.
  const docs = rows.map((row) => ({
    row,
    terms: tokenize(`${row.heading} ${row.provisionText ?? ''}`),
  }));
  const documentFrequency = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc.terms)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const idf = (term: string): number => {
    const df = documentFrequency.get(term) ?? 0;
    return Math.log(1 + rows.length / Math.max(df, 1));
  };

  // L2-normalised TF-IDF vector for each document. Term frequency is the
  // standard sublinear form (1 + log count) rather than count/length, so a
  // long provision that mentions a term once is not treated as saying the
  // same thing as a short one built around it — and a term repeated in a
  // short provision does not blow the score up linearly.
  const docVectors = docs.map((doc) => {
    const counts = new Map<string, number>();
    for (const term of doc.terms) counts.set(term, (counts.get(term) ?? 0) + 1);
    const weights = new Map<string, number>();
    let norm = 0;
    for (const [term, count] of counts) {
      const weight = (1 + Math.log(count)) * idf(term);
      weights.set(term, weight);
      norm += weight * weight;
    }
    norm = Math.sqrt(norm);
    for (const [term, weight] of weights) weights.set(term, weight / (norm || 1));
    return weights;
  });

  // The query vector uses the same idf table and the same sublinear term
  // frequency; terms no provision contains cannot contribute to a cosine,
  // so they are dropped (their df is 0).
  const queryCounts = new Map<string, number>();
  for (const term of queryTerms) queryCounts.set(term, (queryCounts.get(term) ?? 0) + 1);
  const queryWeights = new Map<string, number>();
  let queryNorm = 0;
  for (const [term, count] of queryCounts) {
    if (!documentFrequency.has(term)) continue;
    const weight = (1 + Math.log(count)) * idf(term);
    queryWeights.set(term, weight);
    queryNorm += weight * weight;
  }
  queryNorm = Math.sqrt(queryNorm);

  const hits: SemanticProvisionHit[] = [];
  docs.forEach((doc, i) => {
    const docVector = docVectors[i]!;
    let score = 0;
    const matchedTerms: string[] = [];
    for (const [term, weight] of queryWeights) {
      const docWeight = docVector.get(term);
      if (docWeight !== undefined) {
        score += (weight / (queryNorm || 1)) * docWeight;
        matchedTerms.push(term);
      }
    }
    if (score > 0) {
      hits.push({
        ...toHit(doc.row, 'Statistically closest provisions', raw),
        score,
        matchedTerms: [...matchedTerms].sort(),
      });
    }
  });

  hits.sort((a, b) =>
    b.score - a.score
    || a.sectionNumber.localeCompare(b.sectionNumber, undefined, { numeric: true })
    || a.provisionId.localeCompare(b.provisionId));

  return hits.slice(0, params.limit ?? 10);
}

/**
 * The ingested source documents with their provision counts — the index the
 * statutes page opens on, and where a knowledge-source search result lands.
 */
export function statuteSourceIndex(
  db: AppDatabase,
  params: { companyId: string },
): Array<{ sourceId: string; title: string; citation: string; sourceType: string; sourceUrl: string; provisionCount: number }> {
  const sources = db.select({
    sourceId: irishKnowledgeSources.id,
    title: irishKnowledgeSources.title,
    citation: irishKnowledgeSources.citation,
    sourceType: irishKnowledgeSources.sourceType,
    sourceUrl: irishKnowledgeSources.sourceUrl,
  })
    .from(irishKnowledgeSources)
    .where(eq(irishKnowledgeSources.companyId, params.companyId))
    .orderBy(asc(irishKnowledgeSources.title))
    .all();

  return sources.map((source) => ({
    ...source,
    provisionCount: db.select({ n: sql<number>`count(*)` })
      .from(irishActProvisions)
      .where(eq(irishActProvisions.sourceId, source.sourceId))
      .get()?.n ?? 0,
  }));
}

/** Every provision of one source, in section order — the source's own index. */
export function sourceProvisions(
  db: AppDatabase,
  params: { companyId: string; sourceId: string },
): ProvisionHit[] {
  const rows = db.select(PROVISION_SEARCH_COLUMNS)
    .from(irishActProvisions)
    .innerJoin(irishKnowledgeSources, eq(irishActProvisions.sourceId, irishKnowledgeSources.id))
    .where(and(
      eq(irishActProvisions.companyId, params.companyId),
      eq(irishActProvisions.sourceId, params.sourceId),
    ))
    .orderBy(asc(irishActProvisions.sectionNumber))
    .all();
  return rows.map((row) => toHit(row, 'Source index', row.heading));
}
