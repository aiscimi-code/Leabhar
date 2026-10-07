import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '@/domain/config/setup';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules } from '@/db/schema';
import { main } from './irishRules';

afterEach(() => vi.restoreAllMocks());

describe('rules CLI: no command loads rules into a book (ADR-0021 §7)', () => {
  it.each([['ingest', '--source', 'finance-act-2025'], ['ingest-all'], ['extract', '--source', 'vatca-2010']])(
    '%s is not a command, and writes nothing',
    async (...args) => {
      const { db } = createTestDatabase();
      const { companyId } = createCompany(db, { legalName: 'Cli Ltd', seedYears: [2025] });
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      expect(await main(args, { db, companyId })).toBe(2);
      expect(String(stderr.mock.calls[0]![0])).toContain(`Unknown command: ${args[0]}`);
      for (const table of [irishKnowledgeSources, irishActProvisions, irishTaxRules]) expect(db.select().from(table).all()).toEqual([]);
    },
  );
});
