import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '@/domain/config/setup';
import { irishKnowledgeSources, irishActProvisions, irishTaxRules, irishTaxRuleTests } from '@/db/schema';
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

describe('rules CLI: the test cases ship with the rules store (#723)', () => {
  it('test runs the store\u2019s cases, and every one passes', async () => {
    const { db } = createTestDatabase();
    const { companyId } = createCompany(db, { legalName: 'Cli Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] });
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    expect(await main(['test'], { db, companyId })).toBe(0);
    const result = JSON.parse(stdout.mock.calls.map((c) => String(c[0])).join(''));
    expect(result.total).toBeGreaterThan(0);
    expect(result).toMatchObject({ passed: result.total, failed: 0, failures: [] });
  }, 60_000); // one lookup per case, a few hundred of them

  it('generate-tests writes nothing into the book', async () => {
    const { db } = createTestDatabase();
    const { companyId } = createCompany(db, { legalName: 'Cli Ltd', seedYears: [2025] });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(await main(['generate-tests'], { db, companyId })).toBe(0);
    expect(String(stderr.mock.calls[0]![0])).toContain('the test cases ship with the rules store');
    expect(db.select().from(irishTaxRuleTests).all()).toEqual([]);
  });
});
