import { describe, it, expect } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { irishKnowledgeSources } from '@/db/schema';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import { CATALOGUE_DIR, CATALOGUE_ENTRIES } from './catalogue';

/**
 * The knowledge base's sources (#591, #556). Every source a new book holds is
 * a rules catalogue entry, whose official file is kept beside it and re-hashed
 * by the catalogue tests; no statute copy is read any more.
 */
describe('ingested source inventory', () => {
  it('a new book holds exactly the catalogue entries, each loaded from the catalogue', () => {
    const { db } = createTestDatabase();
    const { companyId } = createCompany(db, { legalName: 'Inventory Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
    const result = loadStatutoryKnowledgeBase(db, { companyId });
    expect(result.sourcesProcessed).toBe(CATALOGUE_ENTRIES.length);
    const paths = db.select({ localPath: irishKnowledgeSources.localPath }).from(irishKnowledgeSources).all().map((s) => s.localPath);
    expect(paths.filter((p) => !p?.startsWith(`${CATALOGUE_DIR}/`))).toEqual([]);
    expect(new Set(paths)).toEqual(new Set(CATALOGUE_ENTRIES.map((e) => `${CATALOGUE_DIR}/${e}`)));
  });
});
