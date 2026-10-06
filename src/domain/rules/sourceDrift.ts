/**
 * Has a catalogued source moved? (issue #443 `verify-sources`; issue #686
 * step 12; ADR-0020 §7.)
 *
 * `verifySources` fetches each catalogue entry's official file — online and
 * only when asked, never at start-up — and compares it with what the entry
 * records:
 *
 *   - `unchanged`: the file's SHA-256 is the one recorded;
 *   - `changed`: it is not. Each rule version's quote is then looked for in
 *     the file's words, so the report says which quotes still stand and which
 *     are gone. A changed hash with every quote found is usually a
 *     consolidation that re-wrapped or re-numbered its footnotes, but only a
 *     person can say so;
 *   - `unreachable`: the file could not be fetched.
 *
 * Nothing here edits the catalogue or a rule. A change becomes review items
 * (`traceSourceChange`), never a silent update (AGENTS.md #7).
 */
import { createHash } from 'node:crypto';
import type { AppDatabase } from '@/db';
import { upsertReviewItem } from '../extraction/service';
import { CATALOGUE_ENTRIES, quotedWords, readCatalogueEntry, type CatalogueEntry } from './catalogue';
import { ruleImpact } from './ruleImpact';

export type SourceDriftStatus = 'unchanged' | 'changed' | 'unreachable';

export interface SourceDriftReport {
  entry: string;
  citation: string;
  sourceUrl: string;
  status: SourceDriftStatus;
  recordedSha256: string;
  /** Null when unreachable. */
  currentSha256: string | null;
  /** Rule versions whose quote is no longer in the file, as `key@version`. */
  quotesMissing: string[];
  quotesFound: string[];
  error: string | null;
}

/** The words of an HTML or text file, lower-cased, without markup, footnote markers or bracket print conventions. */
export function sourceWords(content: string): string[] {
  const text = content
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;|&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#8217;|&#39;|&rsquo;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
  return (text.toLowerCase().match(/[a-z0-9%€]+/g) ?? [])
    // LRC footnote markers (F95) sit between the words they annotate.
    .filter((w) => !/^f\d+$/.test(w));
}

function containsRun(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return true;
  outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Compare a fetched official file with the entry that records it. */
export function compareWithCatalogue(name: string, entry: CatalogueEntry, fetched: Buffer): SourceDriftReport {
  const currentSha256 = createHash('sha256').update(fetched).digest('hex');
  const base = {
    entry: name, citation: entry.source.citation, sourceUrl: entry.source.sourceUrl,
    recordedSha256: entry.source.sha256, currentSha256, error: null,
  };
  if (currentSha256 === entry.source.sha256) {
    return { ...base, status: 'unchanged', quotesMissing: [], quotesFound: [] };
  }
  const words = sourceWords(fetched.toString('utf8'));
  const quotesMissing: string[] = [];
  const quotesFound: string[] = [];
  for (const rule of entry.rules) {
    for (const v of rule.versions) {
      if (!v.quote) continue;
      (containsRun(words, sourceWords(quotedWords(entry, rule, v.quote))) ? quotesFound : quotesMissing).push(`${rule.key}@${v.version}`);
    }
  }
  return { ...base, status: 'changed', quotesMissing, quotesFound };
}

export type SourceFetcher = (url: string) => Promise<Buffer>;

export const fetchOfficialFile: SourceFetcher = async (url) => {
  const res = await fetch(url, { headers: { 'User-Agent': 'Leabhar-verify-sources/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

/** Check every catalogue entry (or the ones named) against its official file. */
export async function verifySources(params: {
  entries?: readonly string[];
  fetch?: SourceFetcher;
  root?: string;
} = {}): Promise<SourceDriftReport[]> {
  const get = params.fetch ?? fetchOfficialFile;
  const reports: SourceDriftReport[] = [];
  for (const name of params.entries ?? CATALOGUE_ENTRIES) {
    const entry = readCatalogueEntry(name, params.root);
    try {
      reports.push(compareWithCatalogue(name, entry, await get(entry.source.sourceUrl)));
    } catch (err) {
      reports.push({
        entry: name, citation: entry.source.citation, sourceUrl: entry.source.sourceUrl, status: 'unreachable',
        recordedSha256: entry.source.sha256, currentSha256: null, quotesMissing: [], quotesFound: [],
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return reports;
}

export interface SourceChangeTrace {
  entry: string;
  /** Every rule whose words are in the source, then every rule relying on one of them, directly or through others. */
  affectedRules: string[];
  /** The computations reading any of them. */
  consumers: string[];
  reviewItemsRaised: number;
}

/**
 * Trace a changed source through the rule graph and put each affected rule
 * in front of the book as a review item: the rules derived from the source,
 * and everything that relies on them (`ruleImpact`). The person re-confirms
 * each one, or it is superseded; nothing is changed for them.
 */
export function traceSourceChange(
  db: AppDatabase,
  params: { companyId: string; report: SourceDriftReport; root?: string },
): SourceChangeTrace {
  const { report } = params;
  if (report.status !== 'changed') return { entry: report.entry, affectedRules: [], consumers: [], reviewItemsRaised: 0 };
  const entry = readCatalogueEntry(report.entry, params.root);
  const direct = entry.rules.map((r) => r.key);
  const affected = new Set(direct);
  const consumers = new Set<string>();
  for (const key of direct) {
    const impact = ruleImpact(db, { companyId: params.companyId, target: { kind: 'rule', ruleKey: key } });
    for (const a of impact.affected) affected.add(a.ruleKey);
    for (const c of impact.consumers) consumers.add(c.consumer);
  }
  const missing = new Set(report.quotesMissing.map((v) => v.replace(/@\d+$/, '')));
  const changeId = `${report.entry}:${report.currentSha256}`;
  let raised = 0;
  for (const ruleKey of [...affected].sort()) {
    const inSource = direct.includes(ruleKey);
    upsertReviewItem(db, {
      companyId: params.companyId,
      kind: 'other',
      severity: missing.has(ruleKey) ? 'warning' : 'info',
      title: `Re-confirm ${ruleKey}: ${report.citation} has changed`,
      detail: `The official text of ${report.citation} (${report.sourceUrl}) no longer matches the copy the rules `
        + `were curated from (SHA-256 ${report.recordedSha256.slice(0, 12)}…, now ${report.currentSha256!.slice(0, 12)}…). `
        + (inSource
          ? (missing.has(ruleKey)
            ? 'This rule’s quote is no longer in the text. '
            : 'This rule’s quote is still in the text. ')
          : 'This rule relies on a rule taken from that text. ')
        + 'Check it against the current text, then confirm it still stands, or have it superseded. Nothing has been changed.',
      entityType: 'irish_rule_key',
      entityId: ruleKey,
      dedupeKey: `rule_source_change:${changeId}:${ruleKey}`,
      context: { ruleKey, entry: report.entry, citation: report.citation, recordedSha256: report.recordedSha256, currentSha256: report.currentSha256, inSource },
    });
    raised += 1;
  }
  return { entry: report.entry, affectedRules: [...affected].sort(), consumers: [...consumers].sort(), reviewItemsRaised: raised };
}
