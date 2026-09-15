import { describe, it, expect } from 'vitest';
import { createTestDatabase } from './testing';

describe('schema migrations', () => {
  it('applies cleanly to an empty database', () => {
    const { sqlite } = createTestDatabase();
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name).sort();

    for (const expected of [
      'companies', 'bank_accounts', 'accounts', 'tax_rates', 'vat_treatments',
      'accounting_periods', 'vat_periods', 'journal_entries', 'journal_lines',
      'vat_entries', 'bank_transactions', 'documents', 'invoices', 'payments',
      'audit_events', 'review_items', 'fixed_assets', 'rules',
    ]) {
      expect(names, `missing table ${expected}`).toContain(expected);
    }
  });

  it('enforces foreign keys', () => {
    const { sqlite } = createTestDatabase();
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() =>
      sqlite.prepare(
        "INSERT INTO bank_accounts (id, company_id, bank_name, account_name, opening_date, created_at, updated_at) VALUES ('x','nonexistent','B','A','2025-01-01','','')",
      ).run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('keeps provenance status distinct from lifecycle status', () => {
    const { sqlite } = createTestDatabase();
    const cols = sqlite.prepare('PRAGMA table_info(bank_transactions)').all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('status');
    expect(names).toContain('provenance_status');
  });

  it('rejects a duplicate bank transaction fingerprint', () => {
    const { sqlite } = createTestDatabase();
    sqlite.exec(`
      INSERT INTO companies (id, legal_name, created_at, updated_at) VALUES ('c1','Demo Ltd','','');
      INSERT INTO bank_accounts (id, company_id, bank_name, account_name, opening_date, created_at, updated_at)
        VALUES ('b1','c1','Bank','Current','2025-01-01','','');
    `);
    const insert = () => sqlite.prepare(`
      INSERT INTO bank_transactions
        (id, company_id, bank_account_id, transaction_date, description, amount_minor, currency, fingerprint, occurrence_index, created_at, updated_at)
      VALUES (?, 'c1','b1','2025-01-15','VERCEL', -4217, 'EUR', 'fp-abc', 0, '','')
    `);
    insert().run('t1');
    expect(() => insert().run('t2')).toThrow(/UNIQUE/);
  });
});
