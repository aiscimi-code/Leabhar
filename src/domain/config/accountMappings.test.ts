import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from './setup';
import { setAccountMapping, clearAccountMapping, listAccountMappings, mappedTrialBalance } from './accountMappings';
import { ConfigurationError } from './mutations';
import { postJournalEntry } from '../accounting/journal';
import { accounts, accountMappings, auditEvents } from '@/db/schema';
import { makeDate, type IsoDate } from '../dates';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;

const AS_OF: IsoDate = makeDate(2025, 12, 31);

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', seedYears: [2024, 2025],
  });
  companyId = created.companyId;
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
});

describe('setAccountMapping (issue #362)', () => {
  it('records a mapping and replaces it in place, with both states in the audit trail', () => {
    setAccountMapping(db, {
      companyId, accountId: byCode['4000']!,
      chartName: 'Accountant 2025', externalCode: '400', externalName: 'Sales',
    });
    setAccountMapping(db, {
      companyId, accountId: byCode['6010']!,
      chartName: 'Accountant 2025', externalCode: '710', externalName: 'IT costs',
    });

    const mappings = listAccountMappings(db, { companyId, chartName: 'Accountant 2025' });
    expect(mappings.map((m) => m.code).sort()).toEqual(['4000', '6010']);
    expect(mappings.find((m) => m.code === '4000')?.externalCode).toBe('400');

    // One mapping per (account, chart): replacing overwrites, not duplicates.
    setAccountMapping(db, {
      companyId, accountId: byCode['4000']!,
      chartName: 'Accountant 2025', externalCode: '401', externalName: 'Sales of goods',
    });
    const after = db.select().from(accountMappings).where(eq(accountMappings.companyId, companyId)).all();
    expect(after).toHaveLength(2);
    expect(listAccountMappings(db, { companyId, chartName: 'Accountant 2025' })
      .find((m) => m.code === '4000')?.externalCode).toBe('401');

    const events = db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'mapped')).all();
    expect(events).toHaveLength(3);
    expect(events.filter((e) => e.previousValue === '400 Sales')).toHaveLength(1);
  });

  it('keeps charts separate: the same account can be mapped differently in each', () => {
    for (const chart of ['Accountant 2025', 'Sage 50']) {
      setAccountMapping(db, {
        companyId, accountId: byCode['4000']!,
        chartName: chart, externalCode: chart === 'Accountant 2025' ? '400' : '4000S',
      });
    }
    expect(db.select().from(accountMappings).where(eq(accountMappings.companyId, companyId)).all())
      .toHaveLength(2);
    const all = listAccountMappings(db, { companyId });
    expect(new Set(all.map((m) => m.chartName))).toEqual(new Set(['Accountant 2025', 'Sage 50']));
  });

  it('refuses a blank chart name, a blank external code and an unknown account', () => {
    expect(() => setAccountMapping(db, {
      companyId, accountId: byCode['4000']!, chartName: '  ', externalCode: '400',
    })).toThrow(ConfigurationError);
    expect(() => setAccountMapping(db, {
      companyId, accountId: byCode['4000']!, chartName: 'Chart', externalCode: '',
    })).toThrow(/needs the account's code/);
    expect(() => setAccountMapping(db, {
      companyId, accountId: 'acc_nope', chartName: 'Chart', externalCode: '400',
    })).toThrow(/not found/);
    expect(db.select().from(accountMappings).all()).toHaveLength(0);
  });

  it('clears a mapping, and refuses to clear one that is not there', () => {
    setAccountMapping(db, {
      companyId, accountId: byCode['4000']!, chartName: 'Chart', externalCode: '400',
    });
    clearAccountMapping(db, { companyId, accountId: byCode['4000']!, chartName: 'Chart' });
    expect(db.select().from(accountMappings).all()).toHaveLength(0);
    expect(db.select().from(auditEvents).where(eq(auditEvents.action, 'unmapped')).all())
      .toHaveLength(1);

    expect(() => clearAccountMapping(db, {
      companyId, accountId: byCode['4000']!, chartName: 'Chart',
    })).toThrow(/No mapping/);
  });
});

describe('mappedTrialBalance (issue #362)', () => {
  it('restates posted balances in the external chart, and never drops a balance', () => {
    postJournalEntry(db, {
      companyId, entryDate: makeDate(2025, 3, 1), narrative: 'Sales',
      sourceType: 'manual_adjustment', baseCurrency: 'EUR',
      lines: [
        { accountId: acc['bank_control']!, debitMinor: 230_000 },
        { accountId: byCode['4000']!, creditMinor: 200_000 },
        { accountId: byCode['2100']!, creditMinor: 30_000 },
      ],
    });

    setAccountMapping(db, {
      companyId, accountId: byCode['4000']!,
      chartName: 'Accountant 2025', externalCode: '400', externalName: 'Sales',
    });
    setAccountMapping(db, {
      companyId, accountId: byCode['2100']!,
      chartName: 'Accountant 2025', externalCode: '210', externalName: 'VAT',
    });

    const tb = mappedTrialBalance(db, {
      companyId, chartName: 'Accountant 2025', asOf: AS_OF,
    });
    expect(tb.totalDebitMinor).toBe(230_000);
    expect(tb.totalCreditMinor).toBe(230_000);

    const sales = tb.rows.find((r) => r.code === '4000')!;
    expect(sales.externalCode).toBe('400');
    expect(sales.creditMinor).toBe(200_000);

    // The unmapped bank account is still there, blank external code and all —
    // its balance is visible, not silently dropped.
    expect(tb.unmapped).toEqual([
      { code: '1000', name: 'Bank current account', balanceMinor: 230_000 },
    ]);
  });

  it('respects the as-of date and an empty ledger', () => {
    const tb = mappedTrialBalance(db, {
      companyId, chartName: 'Chart', asOf: makeDate(2024, 6, 30),
    });
    expect(tb.rows).toEqual([]);
    expect(tb.unmapped).toEqual([]);
    expect(tb.totalDebitMinor).toBe(0);
  });

  it('names the chart it is presenting', () => {
    expect(() => mappedTrialBalance(db, { companyId, chartName: ' ', asOf: AS_OF }))
      .toThrow(ConfigurationError);
  });
});
