import { describe, it, expect } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { visibleKnowledgeSources } from '@/db/schema';
import { CATALOGUE_DIR, CATALOGUE_ENTRIES } from './catalogue';

/**
 * The knowledge base's sources (#591, #556). Every source a new book sees is
 * a rules catalogue entry in the rules store (ADR-0021), whose official file
 * is kept beside it and re-hashed by the catalogue tests; no statute copy is
 * read any more.
 */
describe('ingested source inventory', () => {
  it('a new book sees exactly the catalogue entries, each loaded from the catalogue', () => {
    const { db } = createTestDatabase();
    createCompany(db, { legalName: 'Inventory Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
    const paths = db.select({ localPath: visibleKnowledgeSources.localPath }).from(visibleKnowledgeSources).all().map((s) => s.localPath);
    expect(paths).toHaveLength(CATALOGUE_ENTRIES.length);
    expect(paths.filter((p) => !p?.startsWith(`${CATALOGUE_DIR}/`))).toEqual([]);
    expect(new Set(paths)).toEqual(new Set(CATALOGUE_ENTRIES.map((e) => `${CATALOGUE_DIR}/${e}`)));
  });
});
