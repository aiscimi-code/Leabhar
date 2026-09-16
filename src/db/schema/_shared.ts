import { sql } from 'drizzle-orm';
import { text, integer } from 'drizzle-orm/sqlite-core';

/**
 * Columns repeated across tables. Drizzle spreads these into table definitions
 * so the shape stays identical everywhere and migrations stay predictable.
 */

export const timestamps = {
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
};

/**
 * Provenance, per docs/DOMAIN_MODEL.md §10. Every derived or classified value
 * carries these. There is no such thing as an unattributed number.
 */
export const provenance = {
  source: text('source', {
    enum: ['ai', 'rule', 'user', 'import', 'system', 'derived'],
  }).notNull().default('user'),
  confidence: integer('confidence'), // 0-100, null when source is user/import
  /**
   * Named `provenanceStatus` rather than `status` because several tables carry
   * their own lifecycle `status`, and the two mean different things: this one
   * says who decided the value, not where the record is in its lifecycle.
   */
  provenanceStatus: text('provenance_status', {
    enum: [
      'ai_suggestion', 'user_confirmed', 'user_rejected',
      'system_rule', 'imported', 'manually_entered',
    ],
  }).notNull().default('manually_entered'),
};

/**
 * Effective dating, per invariant #6. Configuration is superseded, never
 * overwritten, so a historical entry can always resolve the configuration that
 * applied on its own date.
 */
export const effectiveDates = {
  effectiveFrom: text('effective_from').notNull(),
  effectiveTo: text('effective_to'), // null == still in force
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
};

/**
 * Where a rule came from and when it was checked, per README §48. Surfaced in
 * the UI so the user can see the basis for a tax treatment rather than trusting
 * the application's word for it.
 */
export const ruleSource = {
  sourceNote: text('source_note'),
  sourceDate: text('source_date'),
};

export type Source = (typeof provenance.source)['_']['data'];
export type ProvenanceStatus = (typeof provenance.provenanceStatus)['_']['data'];
