import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from './setup';
import { ConfigurationError } from './mutations';
import {
  recordTradingName, endTradingName,
  recordTradingActivity, ceaseTradingActivity,
  recordRegistration, endRegistration,
  recordEuVatNumber, recordEoriNumber,
  ceaseTrade, archiveCompany, unarchiveCompany,
  complianceProfile,
} from './businessProfile';
import {
  companies, companyTradingNames, companyTradingActivities, companyRegistrations,
  auditEvents, reviewItems, journalEntries,
} from '@/db/schema';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  companyId = createCompany(db, {
    legalName: 'Acme Ltd', vatRegistrationStatus: 'registered', vatNumber: 'IE1234567A',
    seedYears: [2025],
  }).companyId;
});

const events = (field: string) => db.select().from(auditEvents)
  .where(eq(auditEvents.field, field)).all();
const openReviewItems = () => db.select().from(reviewItems)
  .where(and(eq(reviewItems.companyId, companyId), eq(reviewItems.status, 'open'))).all();

describe('trading names', () => {
  it('records a name as an effective-dated row and makes it the current name', () => {
    recordTradingName(db, {
      companyId, name: 'Acme Tools', effectiveFrom: '2025-02-01', recordedBy: 'joseph',
    });

    const rows = db.select().from(companyTradingNames).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'Acme Tools', effectiveFrom: '2025-02-01', effectiveTo: null, recordedBy: 'joseph',
    });
    expect(db.select().from(companies).get()!.tradingName).toBe('Acme Tools');
    expect(events('tradingName')).toHaveLength(1);
  });

  it('rejects a second current name spelled the same, but allows several at once', () => {
    recordTradingName(db, { companyId, name: 'Acme Tools', effectiveFrom: '2025-02-01', recordedBy: 'joseph' });
    recordTradingName(db, { companyId, name: 'Acme Hardware', effectiveFrom: '2025-03-01', recordedBy: 'joseph' });
    expect(() => recordTradingName(db, {
      companyId, name: 'acme tools', effectiveFrom: '2025-04-01', recordedBy: 'joseph',
    })).toThrow(ConfigurationError);
    expect(db.select().from(companyTradingNames).all()).toHaveLength(2);
  });

  it('passes the current name on when a name stops, and to nothing when none is left', () => {
    const first = recordTradingName(db, {
      companyId, name: 'Acme Tools', effectiveFrom: '2025-02-01', recordedBy: 'joseph',
    });
    recordTradingName(db, { companyId, name: 'Acme Hardware', effectiveFrom: '2025-03-01', recordedBy: 'joseph' });

    endTradingName(db, {
      companyId, tradingNameId: first.id, effectiveTo: '2025-06-30', recordedBy: 'joseph',
    });
    expect(db.select().from(companies).get()!.tradingName).toBe('Acme Hardware');
    expect(db.select().from(companyTradingNames).where(eq(companyTradingNames.id, first.id)).get()!.effectiveTo)
      .toBe('2025-06-30');

    const second = db.select().from(companyTradingNames)
      .where(eq(companyTradingNames.name, 'Acme Hardware')).get()!;
    endTradingName(db, {
      companyId, tradingNameId: second.id, effectiveTo: '2025-07-31', recordedBy: 'joseph',
    });
    expect(db.select().from(companies).get()!.tradingName).toBeNull();
  });

  it('refuses a window that ends before it starts, or twice', () => {
    const row = recordTradingName(db, {
      companyId, name: 'Acme Tools', effectiveFrom: '2025-02-01', recordedBy: 'joseph',
    });
    expect(() => endTradingName(db, {
      companyId, tradingNameId: row.id, effectiveTo: '2025-01-31', recordedBy: 'joseph',
    })).toThrow(ConfigurationError);
    endTradingName(db, {
      companyId, tradingNameId: row.id, effectiveTo: '2025-06-30', recordedBy: 'joseph',
    });
    expect(() => endTradingName(db, {
      companyId, tradingNameId: row.id, effectiveTo: '2025-08-31', recordedBy: 'joseph',
    })).toThrow(/already stopped/);
  });
});

describe('trading activities', () => {
  it('records a farm with its herd number', () => {
    const row = recordTradingActivity(db, {
      companyId, name: 'Dairy herd', sector: 'farming', commencedOn: '2024-04-01',
      herdNumber: 'A123456', recordedBy: 'joseph',
    });
    expect(row).toMatchObject({
      name: 'Dairy herd', sector: 'farming', herdNumber: 'A123456', ceasedOn: null,
    });
    expect(events('trading_activity')).toHaveLength(1);
  });

  it('records a herd number for farming only', () => {
    expect(() => recordTradingActivity(db, {
      companyId, name: 'Shop', sector: 'retail', commencedOn: '2024-04-01',
      herdNumber: 'A123456', recordedBy: 'joseph',
    })).toThrow(ConfigurationError);
  });

  it('rejects a duplicate current activity and refuses a bad cease date', () => {
    const row = recordTradingActivity(db, {
      companyId, name: 'Shop', sector: 'retail', commencedOn: '2024-04-01', recordedBy: 'joseph',
    });
    expect(() => recordTradingActivity(db, {
      companyId, name: 'shop', sector: 'retail', commencedOn: '2024-05-01', recordedBy: 'joseph',
    })).toThrow(ConfigurationError);
    expect(() => ceaseTradingActivity(db, {
      companyId, activityId: row.id, ceasedOn: '2024-03-31', recordedBy: 'joseph',
    })).toThrow(ConfigurationError);
    ceaseTradingActivity(db, {
      companyId, activityId: row.id, ceasedOn: '2025-05-31', recordedBy: 'joseph',
    });
    expect(db.select().from(companyTradingActivities).get()!.ceasedOn).toBe('2025-05-31');
  });
});

describe('registrations', () => {
  it('records an income tax registration for a sole trader', () => {
    const soleTraderId = createCompany(db, {
      legalName: 'Jo Byrne', entityType: 'sole_trader', tradeCommencedOn: '2024-01-01',
    }).companyId;
    const { registration, warnings } = recordRegistration(db, {
      companyId: soleTraderId, registrationType: 'income_tax', registrationNumber: '1234567A',
      registeredFrom: '2024-01-01', recordedBy: 'joseph',
    });
    expect(registration).toMatchObject({
      registrationType: 'income_tax', registrationNumber: '1234567A', deregisteredOn: null,
    });
    expect(warnings).toEqual([]);
  });

  it('refuses an income tax registration for a company', () => {
    expect(() => recordRegistration(db, {
      companyId, registrationType: 'income_tax', registrationNumber: '1234567A',
      registeredFrom: '2024-01-01', recordedBy: 'joseph',
    })).toThrow(/corporation tax/);
  });

  it('records the PAYE employer registration payroll will run against, with no warning', () => {
    const { registration, warnings } = recordRegistration(db, {
      companyId, registrationType: 'paye', registrationNumber: '654321',
      registeredFrom: '2024-01-01', recordedBy: 'joseph',
    });
    expect(registration.registrationType).toBe('paye');
    expect(warnings).toEqual([]);
  });

  it('requires a number, except for a named "other" registration', () => {
    expect(() => recordRegistration(db, {
      companyId, registrationType: 'rct', registeredFrom: '2024-01-01', recordedBy: 'joseph',
    })).toThrow(ConfigurationError);
    expect(() => recordRegistration(db, {
      companyId, registrationType: 'other', registeredFrom: '2024-01-01', recordedBy: 'joseph',
    })).toThrow(ConfigurationError);
    const { registration } = recordRegistration(db, {
      companyId, registrationType: 'other', label: 'DAC7', registeredFrom: '2024-01-01', recordedBy: 'joseph',
    });
    expect(registration).toMatchObject({ registrationType: 'other', label: 'DAC7', registrationNumber: null });
  });

  it('rejects a second current registration of the same kind, and closes one on a date', () => {
    const { registration } = recordRegistration(db, {
      companyId, registrationType: 'paye', registrationNumber: '654321',
      registeredFrom: '2024-01-01', recordedBy: 'joseph',
    });
    expect(() => recordRegistration(db, {
      companyId, registrationType: 'paye', registrationNumber: '999999',
      registeredFrom: '2025-01-01', recordedBy: 'joseph',
    })).toThrow(ConfigurationError);
    endRegistration(db, {
      companyId, registrationId: registration.id, deregisteredOn: '2025-06-30', recordedBy: 'joseph',
    });
    const again = recordRegistration(db, {
      companyId, registrationType: 'paye', registrationNumber: '999999',
      registeredFrom: '2025-07-01', recordedBy: 'joseph',
    });
    expect(again.registration.registrationNumber).toBe('999999');
  });
});

describe('cross-border identifiers', () => {
  it('records the EU VAT identification number with who confirmed it', () => {
    recordEuVatNumber(db, {
      companyId, vatNumber: 'IE 1234567A', registeredFrom: '2024-06-01',
      basis: 'as issued on ROS', confirmedBy: 'joseph',
    });
    const company = db.select().from(companies).get()!;
    expect(company.euVatNumber).toBe('IE1234567A');
    expect(company.euVatConfirmedBy).toBe('joseph');
    expect(events('eu_vat_number')).toHaveLength(1);
  });

  it('rejects a number that is not a VAT identification number', () => {
    for (const bad of ['1234567A', 'IE1', 'IEXX1234567890123X']) {
      expect(() => recordEuVatNumber(db, {
        companyId, vatNumber: bad, registeredFrom: '2024-06-01',
        basis: 'as issued on ROS', confirmedBy: 'joseph',
      })).toThrow(ConfigurationError);
    }
  });

  it('records the EORI number with what it was checked against, and replaces it audited', () => {
    recordEoriNumber(db, {
      companyId, eoriNumber: 'ie1234567a', basis: 'validated on the EU EORI portal', confirmedBy: 'joseph',
    });
    recordEoriNumber(db, {
      companyId, eoriNumber: 'IE9876543B', basis: 'checked again', confirmedBy: 'mary',
    });
    const company = db.select().from(companies).get()!;
    expect(company.eoriNumber).toBe('IE9876543B');
    const audit = events('eori_number');
    expect(audit).toHaveLength(2);
    expect(audit[0]!.newValue).toContain('IE1234567A');
    expect(audit[1]!.previousValue).toContain('IE1234567A');
    expect(() => recordEoriNumber(db, {
      companyId, eoriNumber: 'IE123456789012345X', basis: 'checked', confirmedBy: 'joseph',
    })).toThrow(ConfigurationError);
  });
});

describe('closure', () => {
  it('records the date the trade ceased and flags an open VAT registration rather than closing it', () => {
    const { warnings } = ceaseTrade(db, {
      companyId, ceasedOn: '2025-09-30', basis: 'retired', confirmedBy: 'joseph',
    });
    const company = db.select().from(companies).get()!;
    expect(company.tradeCeasedOn).toBe('2025-09-30');
    expect(company.vatRegistrationStatus).toBe('registered');
    expect(warnings).toEqual([]);
    expect(openReviewItems().map((r) => r.dedupeKey))
      .toContain(`vat_registration_open_after_cease:${companyId}`);
  });

  it('records the VAT deregistration when its date is given', () => {
    ceaseTrade(db, {
      companyId, ceasedOn: '2025-09-30', basis: 'retired',
      vatDeregistrationOn: '2025-11-30', confirmedBy: 'joseph',
    });
    const company = db.select().from(companies).get()!;
    expect(company.vatRegistrationStatus).toBe('deregistered');
    expect(company.vatDeregistrationDate).toBe('2025-11-30');
    expect(openReviewItems()).toHaveLength(0);
  });

  it('flags posted entries dated after the day the trade ceased, and changes nothing', () => {
    db.insert(journalEntries).values({
      id: 'je_test1', companyId, entryNumber: 1, entryDate: '2025-10-15',
      narrative: 'Winding-up costs', sourceType: 'manual_adjustment',
    }).run();
    ceaseTrade(db, { companyId, ceasedOn: '2025-09-30', basis: 'retired', confirmedBy: 'joseph' });
    expect(db.select().from(journalEntries).get()!.entryDate).toBe('2025-10-15');
    expect(openReviewItems().map((r) => r.dedupeKey))
      .toContain(`entries_after_trade_ceased:${companyId}`);
  });

  it('refuses a cessation before commencement and warns when it replaces a date', () => {
    const soleTraderId = createCompany(db, {
      legalName: 'Jo Byrne', entityType: 'sole_trader', tradeCommencedOn: '2024-01-01',
    }).companyId;
    expect(() => ceaseTrade(db, {
      companyId: soleTraderId, ceasedOn: '2023-12-31', basis: 'x', confirmedBy: 'joseph',
    })).toThrow(ConfigurationError);

    ceaseTrade(db, { companyId, ceasedOn: '2025-09-30', basis: 'retired', confirmedBy: 'joseph' });
    const { warnings } = ceaseTrade(db, {
      companyId, ceasedOn: '2025-10-31', basis: 'corrected: the sale completed later', confirmedBy: 'joseph',
    });
    expect(warnings.join(' ')).toMatch(/replaces that date/);
    const audit = events('trade_ceased_on');
    expect(audit[1]!.previousValue).toContain('2025-09-30');

    // Recording the date again keeps one open item, describing the new date.
    const open = openReviewItems().filter((r) => r.dedupeKey === `vat_registration_open_after_cease:${companyId}`);
    expect(open).toHaveLength(1);
    expect(open[0]!.title).toContain('2025-10-31');
  });
});

describe('archive', () => {
  it('takes the business out of the working set without deleting anything, and can bring it back', () => {
    const { warnings } = archiveCompany(db, {
      companyId, basis: 'the company was sold', confirmedBy: 'joseph',
    });
    const archived = db.select().from(companies).get()!;
    expect(archived.archivedAt).toBeTruthy();
    expect(archived.archiveBasis).toBe('the company was sold');
    expect(warnings.join(' ')).toMatch(/no trade cessation/);

    expect(() => archiveCompany(db, { companyId, basis: 'again', confirmedBy: 'joseph' }))
      .toThrow(ConfigurationError);

    unarchiveCompany(db, { companyId, confirmedBy: 'joseph' });
    expect(db.select().from(companies).get()!.archivedAt).toBeNull();
    const audit = events('archived_at');
    expect(audit[1]!.previousValue).toContain('the company was sold');
  });
});

describe('compliance profile', () => {
  it('names the gap a sole trader has until the income tax registration is recorded', () => {
    const soleTraderId = createCompany(db, {
      legalName: 'Jo Byrne', entityType: 'sole_trader', tradeCommencedOn: '2024-01-01',
    }).companyId;
    const before = complianceProfile(db, soleTraderId);
    expect(before.gaps.map((g) => g.code)).toContain('income_tax_registration_missing');

    recordRegistration(db, {
      companyId: soleTraderId, registrationType: 'income_tax', registrationNumber: '1234567A',
      registeredFrom: '2024-01-01', recordedBy: 'joseph',
    });
    const after = complianceProfile(db, soleTraderId);
    expect(after.gaps.map((g) => g.code)).not.toContain('income_tax_registration_missing');
    expect(after.registrations).toHaveLength(1);
  });

  it('names what is missing for a company: corporation tax, VAT number, activities', () => {
    const bareId = createCompany(db, {
      legalName: 'Bare Ltd', vatRegistrationStatus: 'registered',
    }).companyId;
    const codes = complianceProfile(db, bareId).gaps.map((g) => g.code);
    expect(codes).toContain('corporation_tax_registration_missing');
    expect(codes).toContain('vat_number_missing');
    expect(codes).toContain('trading_activities_missing');
  });

  it('flags a farm with no herd number and a ceased trade with an open VAT registration', () => {
    recordTradingActivity(db, {
      companyId, name: 'Dairy herd', sector: 'farming', commencedOn: '2024-04-01',
      recordedBy: 'joseph',
    });
    ceaseTrade(db, { companyId, ceasedOn: '2025-09-30', basis: 'retired', confirmedBy: 'joseph' });
    const codes = complianceProfile(db, companyId).gaps.map((g) => g.code);
    expect(codes).toContain('herd_number_missing');
    expect(codes).toContain('vat_registration_open_after_cease');
  });

  it('assembles the profile from the recorded facts', () => {
    recordTradingName(db, { companyId, name: 'Acme Tools', effectiveFrom: '2025-02-01', recordedBy: 'joseph' });
    recordEoriNumber(db, {
      companyId, eoriNumber: 'IE1234567A', basis: 'validated on the EU EORI portal', confirmedBy: 'joseph',
    });
    recordEuVatNumber(db, {
      companyId, vatNumber: 'IE1234567A', registeredFrom: '2024-06-01',
      basis: 'as issued on ROS', confirmedBy: 'joseph',
    });
    const profile = complianceProfile(db, companyId);
    expect(profile.tradingNames.map((n) => n.name)).toEqual(['Acme Tools']);
    expect(profile.vat.euVatNumber).toBe('IE1234567A');
    expect(profile.gaps.map((g) => g.code)).not.toContain('eu_vat_number_mismatch');
    expect(profile.eori).toMatchObject({ number: 'IE1234567A', confirmedBy: 'joseph' });
    expect(profile.entityType).toBe('company');
  });

  it('flags an EU VAT identification number that is not the registration number with its IE prefix', () => {
    recordEuVatNumber(db, {
      companyId, vatNumber: 'IE7654321B', registeredFrom: '2024-06-01',
      basis: 'as issued on ROS', confirmedBy: 'joseph',
    });
    const gap = complianceProfile(db, companyId).gaps.find((g) => g.code === 'eu_vat_number_mismatch');
    expect(gap).toMatchObject({ kind: 'check' });
    expect(gap!.message).toContain('IE7654321B');
  });
});
