import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from './setup';
import {
  updateCompany, supersedeTaxRate, createTaxRate, deactivateTaxRate,
  updateVatTreatment, createAccount, updateAccount, deleteAccount,
  generateVatPeriodsForYear, generateFinancialYearPeriod, updateVatPeriod,
  upsertCustomer, ConfigurationError,
} from './mutations';
import { postJournalEntry } from '../accounting/journal';
import { createVatEntries, resolveRate } from '../vat/engine';
import { accountBalance } from '../accounting/ledger';
import {
  taxRates, vatTreatments, accounts, vatPeriods, auditEvents, companies, taxDeadlines,
  journalEntries, customers,
} from '@/db/schema';
import { makeDate } from '../dates';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let acc: Record<string, string>;
let byCode: Record<string, string>;
let tr: Record<string, string>;
let rates: Record<string, string>;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', seedYears: [2025],
  });
  companyId = created.companyId;
  acc = created.accountsByKey;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
  rates = created.ratesByCode;
});

describe('updateCompany', () => {
  it('records each changed field in the audit trail', () => {
    const result = updateCompany(db, {
      companyId,
      changes: { legalName: 'Acme Software Limited', croNumber: '654321' },
      actor: 'joseph',
    });

    expect(result.changed).toEqual(['legalName', 'croNumber']);
    const events = db.select().from(auditEvents)
      .where(eq(auditEvents.action, 'settings_changed')).all();
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.field === 'legalName')!.previousValue).toBe('Acme Ltd');
  });

  it('ignores a change that changes nothing', () => {
    expect(updateCompany(db, { companyId, changes: { legalName: 'Acme Ltd' } }).changed)
      .toEqual([]);
  });

  // Silently restating filed returns would be unforgivable.
  it('warns rather than restating when the VAT basis changes with entries present', () => {
    createVatEntries(db, {
      companyId, sourceType: 'purchase_invoice', direction: 'purchases',
      treatmentId: tr['IE_STD']!, taxPointDate: makeDate(2025, 3, 15),
      netMinor: 10_000, currency: 'EUR', baseCurrency: 'EUR',
    });

    const result = updateCompany(db, {
      companyId, changes: { vatAccountingBasis: 'invoice' },
    });
    expect(result.changed).toContain('vatAccountingBasis');
    expect(result.warnings.join(' ')).toContain('nothing is restated');
    expect(result.warnings.join(' ')).toContain('already filed');
  });

  it('refuses to change the base currency once anything is posted', () => {
    postJournalEntry(db, {
      companyId, entryDate: makeDate(2025, 3, 15), narrative: 'Test',
      sourceType: 'manual_adjustment', baseCurrency: 'EUR',
      lines: [
        { accountId: byCode['6010']!, debitMinor: 1000 },
        { accountId: acc['bank_control']!, creditMinor: 1000 },
      ],
    });

    expect(() => updateCompany(db, { companyId, changes: { baseCurrency: 'USD' } }))
      .toThrow(/every historical figure mean something different/);
  });

  it('allows the base currency to change before anything is posted', () => {
    expect(updateCompany(db, { companyId, changes: { baseCurrency: 'GBP' } }).changed)
      .toContain('baseCurrency');
  });

  it('warns that changing the year end does not move existing periods', () => {
    const result = updateCompany(db, {
      companyId, changes: { financialYearEndMonth: 6, financialYearEndDay: 30 },
    });
    expect(result.warnings.join(' ')).toContain('a decision, not a side effect');
  });
});

describe('tax rates', () => {
  // The core requirement of README §6.
  it('supersedes a rate without altering historical transactions', () => {
    const before = createVatEntries(db, {
      companyId, sourceType: 'purchase_invoice', direction: 'purchases',
      treatmentId: tr['IE_STD']!, taxPointDate: makeDate(2025, 6, 15),
      netMinor: 10_000, currency: 'EUR', baseCurrency: 'EUR',
    });
    expect(before.entries[0]!.rateBasisPoints).toBe(2300);

    const { newRateId } = supersedeTaxRate(db, {
      companyId, taxRateId: rates['VAT_STD']!,
      newRateBasisPoints: 2400, effectiveFrom: makeDate(2026, 1, 1),
      sourceNote: 'Budget change',
    });

    // The old row now has a closed window; the new one starts where it ends.
    const old = db.select().from(taxRates).where(eq(taxRates.id, rates['VAT_STD']!)).get()!;
    const fresh = db.select().from(taxRates).where(eq(taxRates.id, newRateId)).get()!;
    expect(old.effectiveTo).toBe('2025-12-31');
    expect(fresh.effectiveFrom).toBe('2026-01-01');
    expect(fresh.rateBasisPoints).toBe(2400);
    expect(fresh.code).toBe(old.code);

    // Resolution by date gives the right rate on either side of the change.
    expect(resolveRate(db, {
      companyId, rateId: rates['VAT_STD']!, onDate: makeDate(2025, 6, 15),
    }).rateBasisPoints).toBe(2300);
    expect(resolveRate(db, {
      companyId, rateId: newRateId, onDate: makeDate(2026, 6, 15),
    }).rateBasisPoints).toBe(2400);
  });

  it('refuses a new rate that starts before the one it replaces', () => {
    expect(() => supersedeTaxRate(db, {
      companyId, taxRateId: rates['VAT_STD']!,
      newRateBasisPoints: 2400, effectiveFrom: makeDate(2020, 1, 1),
    })).toThrow(/must start after the one it replaces/);
  });

  it('deactivates a rate rather than deleting it, and says what still uses it', () => {
    createVatEntries(db, {
      companyId, sourceType: 'purchase_invoice', direction: 'purchases',
      treatmentId: tr['IE_STD']!, taxPointDate: makeDate(2025, 6, 15),
      netMinor: 10_000, currency: 'EUR', baseCurrency: 'EUR',
    });

    const result = deactivateTaxRate(db, { companyId, taxRateId: rates['VAT_STD']! });
    expect(result.referencedBy).toBe(1);

    const rate = db.select().from(taxRates).where(eq(taxRates.id, rates['VAT_STD']!)).get()!;
    expect(rate.active).toBe(false);
    // Still there, so the historical entry can still resolve it.
    expect(rate.rateBasisPoints).toBe(2300);
  });

  it('creates a new rate', () => {
    const id = createTaxRate(db, {
      companyId, code: 'VAT_SPECIAL', name: 'Special rate',
      rateBasisPoints: 1000, effectiveFrom: makeDate(2025, 1, 1),
      sourceNote: 'Confirmed with Revenue',
    });
    const rate = db.select().from(taxRates).where(eq(taxRates.id, id)).get()!;
    expect(rate.rateBasisPoints).toBe(1000);
    expect(rate.sourceNote).toBe('Confirmed with Revenue');
  });

  it('refuses a negative rate', () => {
    expect(() => createTaxRate(db, {
      companyId, code: 'BAD', name: 'Bad', rateBasisPoints: -100,
      effectiveFrom: makeDate(2025, 1, 1),
    })).toThrow(/cannot be negative/);
  });
});

describe('VAT treatments', () => {
  it('allows cosmetic edits freely', () => {
    const result = updateVatTreatment(db, {
      companyId, treatmentId: tr['IE_STD']!,
      changes: { name: 'Irish standard rate (23%)', notes: 'Checked March 2026' },
    });
    expect(result.changed).toContain('name');
  });

  // Editing the mapping would leave configuration disagreeing with history.
  it('refuses to change the box mapping once the treatment has been used', () => {
    createVatEntries(db, {
      companyId, sourceType: 'purchase_invoice', direction: 'purchases',
      treatmentId: tr['IE_STD']!, taxPointDate: makeDate(2025, 6, 15),
      netMinor: 10_000, currency: 'EUR', baseCurrency: 'EUR',
    });

    expect(() => updateVatTreatment(db, {
      companyId, treatmentId: tr['IE_STD']!, changes: { purchasesVatBox: 'T9' },
    })).toThrow(/cannot be changed/);

    expect(() => updateVatTreatment(db, {
      companyId, treatmentId: tr['IE_STD']!, changes: { isRecoverable: false },
    })).toThrow(/disagreeing with the history it produced/);
  });

  it('allows the mapping to change while the treatment is unused', () => {
    const result = updateVatTreatment(db, {
      companyId, treatmentId: tr['IE_STD']!, changes: { purchasesVatBox: 'T2' },
    });
    // No change: it is already T2.
    expect(result.changed).toEqual([]);

    const changed = updateVatTreatment(db, {
      companyId, treatmentId: tr['IE_RED']!, changes: { recoverableBasisPoints: 5_000 },
    });
    expect(changed.changed).toContain('recoverableBasisPoints');
  });

  it('warns when deactivating a treatment that history uses', () => {
    createVatEntries(db, {
      companyId, sourceType: 'purchase_invoice', direction: 'purchases',
      treatmentId: tr['IE_STD']!, taxPointDate: makeDate(2025, 6, 15),
      netMinor: 10_000, currency: 'EUR', baseCurrency: 'EUR',
    });
    const result = updateVatTreatment(db, {
      companyId, treatmentId: tr['IE_STD']!, changes: { active: false },
    });
    expect(result.warnings.join(' ')).toContain('They are unaffected');
  });
});

describe('chart of accounts', () => {
  it('creates an account', () => {
    const id = createAccount(db, {
      companyId, code: '6180', name: 'Research and development',
      type: 'expense', reportSection: 'operating_expenses',
    });
    expect(db.select().from(accounts).where(eq(accounts.id, id)).get()!.name)
      .toBe('Research and development');
  });

  it('refuses a duplicate account code', () => {
    expect(() => createAccount(db, {
      companyId, code: '6010', name: 'Duplicate',
      type: 'expense', reportSection: 'operating_expenses',
    })).toThrow(/already in use/);
  });

  it('never deletes an account, and explains why', () => {
    expect(() => deleteAccount(db, { companyId, accountId: byCode['6010']! }))
      .toThrow(/Accounts are never deleted/);
    expect(() => deleteAccount(db, { companyId, accountId: byCode['6010']! }))
      .toThrow(/Deactivate it instead/);
  });

  it('warns when deactivating an account that has postings', () => {
    postJournalEntry(db, {
      companyId, entryDate: makeDate(2025, 3, 15), narrative: 'Test',
      sourceType: 'manual_adjustment', baseCurrency: 'EUR',
      lines: [
        { accountId: byCode['6010']!, debitMinor: 1000 },
        { accountId: acc['bank_control']!, creditMinor: 1000 },
      ],
    });

    const result = updateAccount(db, {
      companyId, accountId: byCode['6010']!, changes: { active: false },
    });
    expect(result.warnings.join(' ')).toContain('history and balance stay exactly as they are');
    expect(db.select().from(accounts).where(eq(accounts.id, byCode['6010']!)).get()!.active)
      .toBe(false);
  });

  it('refuses to deactivate a system account', () => {
    expect(() => updateAccount(db, {
      companyId, accountId: acc['bank_control']!, changes: { active: false },
    })).toThrow(/system account/);
  });

  it('allows a system account to be renamed', () => {
    const result = updateAccount(db, {
      companyId, accountId: acc['bank_control']!,
      changes: { name: 'Bank of Ireland current account' },
    });
    expect(result.changed).toContain('name');
  });
});

describe('periods', () => {
  it('generates VAT periods for a year', () => {
    const result = generateVatPeriodsForYear(db, {
      companyId, year: 2026, frequency: 'bi_monthly',
    });
    expect(result.created).toBe(6);
    expect(result.issues).toEqual([]);
  });

  // Historical periods must remain unchanged when configuration is edited.
  it('skips periods that would overlap ones already defined', () => {
    const result = generateVatPeriodsForYear(db, {
      companyId, year: 2025, frequency: 'monthly',
    });
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(12);
    // The originals are untouched.
    expect(db.select().from(vatPeriods)
      .where(eq(vatPeriods.companyId, companyId)).all()).toHaveLength(6);
  });

  it('creates a matching filing deadline for each period', () => {
    generateVatPeriodsForYear(db, { companyId, year: 2026, frequency: 'bi_monthly' });
    const deadlines = db.select().from(taxDeadlines).all();
    expect(deadlines.length).toBeGreaterThanOrEqual(6);
  });

  it('generates a financial year with its months', () => {
    const result = generateFinancialYearPeriod(db, { companyId, endYear: 2026 });
    expect(result.name).toBe('FY 2026');
    expect(result.startDate).toBe('2026-01-01');
    expect(result.issues).toEqual([]);
  });

  it('refuses a financial year overlapping one that exists', () => {
    expect(() => generateFinancialYearPeriod(db, { companyId, endYear: 2025 }))
      .toThrow(/already covers those dates/);
  });

  it('refuses to move the dates of a submitted period', () => {
    const period = db.select().from(vatPeriods).get()!;
    db.update(vatPeriods).set({ status: 'submitted' })
      .where(eq(vatPeriods.id, period.id)).run();

    expect(() => updateVatPeriod(db, {
      companyId, vatPeriodId: period.id, changes: { endDate: '2025-03-31' },
    })).toThrow(/change which transactions it contained after the fact/);
  });

  it('refuses dates that overlap another period', () => {
    const periods = db.select().from(vatPeriods).orderBy(vatPeriods.startDate).all();
    expect(() => updateVatPeriod(db, {
      companyId, vatPeriodId: periods[0]!.id, changes: { endDate: '2025-04-15' },
    })).toThrow(/cannot belong to two VAT periods at once/);
  });

  it('refuses a period that ends before it starts', () => {
    const period = db.select().from(vatPeriods).orderBy(vatPeriods.startDate).get()!;
    expect(() => updateVatPeriod(db, {
      companyId, vatPeriodId: period.id, changes: { endDate: '2024-12-01' },
    })).toThrow(/cannot end before it starts/);
  });

  it('allows an open period to be renamed and redated within its gap', () => {
    const periods = db.select().from(vatPeriods).orderBy(vatPeriods.startDate).all();
    const result = updateVatPeriod(db, {
      companyId, vatPeriodId: periods[0]!.id,
      changes: { name: 'First bi-monthly period 2025' },
    });
    expect(result.changed).toContain('name');
  });
});

// Issue #153: openingBalanceMinor was stored on bank_accounts but never
// journaled, leaving a supplied statement close unexplained by exactly the
// opening amount.
describe('addBankAccount opening balance', () => {
  it('journals a positive opening balance: Dr the control account, Cr retained earnings', () => {
    const bankAccountId = addBankAccount(db, {
      companyId, bankName: 'AIB', accountName: 'Current',
      openingBalanceMinor: 1_425_000, openingDate: '2025-01-01',
    });

    expect(accountBalance(db, { companyId, accountId: acc['bank_control']! })).toBe(1_425_000);
    expect(accountBalance(db, { companyId, accountId: acc['retained_earnings']! })).toBe(1_425_000);

    const entry = db.select().from(journalEntries)
      .where(eq(journalEntries.sourceId, bankAccountId)).get()!;
    expect(entry.sourceType).toBe('opening_balance');
    expect(entry.entryDate).toBe('2025-01-01');
  });

  it('journals a negative (overdrawn) opening balance the other way round', () => {
    addBankAccount(db, {
      companyId, bankName: 'AIB', accountName: 'Overdraft',
      openingBalanceMinor: -50_000, openingDate: '2025-01-01',
    });

    expect(accountBalance(db, { companyId, accountId: acc['bank_control']! })).toBe(-50_000);
    expect(accountBalance(db, { companyId, accountId: acc['retained_earnings']! })).toBe(-50_000);
  });

  it('posts nothing for a zero opening balance', () => {
    const bankAccountId = addBankAccount(db, {
      companyId, bankName: 'AIB', accountName: 'Savings', openingDate: '2025-01-01',
    });
    expect(db.select().from(journalEntries)
      .where(eq(journalEntries.sourceId, bankAccountId)).all()).toHaveLength(0);
  });

  it('refuses a nonzero opening balance with no financial year to post it into', () => {
    expect(() => addBankAccount(db, {
      companyId, bankName: 'AIB', accountName: 'Current',
      openingBalanceMinor: 1_000_00, openingDate: '2030-01-01',
    })).toThrow(/No accounting period covers/);
  });

  it('refuses a foreign-currency opening balance rather than posting it as base currency', () => {
    expect(() => addBankAccount(db, {
      companyId, bankName: 'Wise', accountName: 'USD account', currency: 'USD',
      openingBalanceMinor: 10_000, openingDate: '2025-01-01',
    })).toThrow(/deliberate exchange rate/);
  });
});

describe('upsertCustomer', () => {
  it('creates a customer with a normalised match key', () => {
    const id = upsertCustomer(db, { companyId, name: 'Mulligan Digital Limited' });
    const row = db.select().from(customers).where(eq(customers.id, id)).get()!;
    expect(row.matchKey).toBe('mulligan digital');
  });

  it('updates an existing customer in place rather than duplicating it', () => {
    const id = upsertCustomer(db, { companyId, name: 'Mulligan Digital Limited' });
    upsertCustomer(db, { companyId, customerId: id, name: 'Mulligan Digital Ltd', countryCode: 'IE' });

    expect(db.select().from(customers).where(eq(customers.companyId, companyId)).all()).toHaveLength(1);
    const row = db.select().from(customers).where(eq(customers.id, id)).get()!;
    expect(row.countryCode).toBe('IE');
  });
});
