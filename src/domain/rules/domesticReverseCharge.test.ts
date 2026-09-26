import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase, insertTestBankTransaction } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { confirmRctPrincipal, rctPrincipalOn } from '../config/companyStatus';
import { auditEvents, companies } from '@/db/schema';
import { loadStatutoryKnowledgeBase } from './knowledgeBase';
import { suggestVatTreatment } from './vatSuggestion';
import { RC_CONSTRUCTION_RULE_KEY } from './domesticReverseChargeCuration';
import type { AppDatabase } from '@/db';

/** Issue #208: the s.16 domestic reverse charges, and the RCT principal status s.16(3) turns on. */

function setup() {
  const { db } = createTestDatabase();
  const created = createCompany(db, { legalName: 'Builders Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2026] });
  const bankAccountId = addBankAccount(db, {
    companyId: created.companyId, bankName: 'AIB', accountName: 'Current', openingDate: '2026-01-01',
    accountId: created.accountsByKey['bank_control']!,
  });
  loadStatutoryKnowledgeBase(db, { companyId: created.companyId });
  return { db, companyId: created.companyId, bankAccountId };
}
const suggest = (ctx: { db: AppDatabase; companyId: string; bankAccountId: string }, description: string, amountMinor: number, date = '2026-03-15') =>
  suggestVatTreatment(ctx.db, {
    companyId: ctx.companyId,
    bankTransactionId: insertTestBankTransaction(ctx.db, { companyId: ctx.companyId, bankAccountId: ctx.bankAccountId, transactionDate: date, description, amountMinor }),
  })!;

describe('recording the company\'s RCT principal status', () => {
  it('needs a person, a basis and (for a principal) a date, and is audited', () => {
    const ctx = setup();
    expect(() => confirmRctPrincipal(ctx.db, { companyId: ctx.companyId, status: 'principal', from: '2026-01-01', basis: '', confirmedBy: 'joe' }))
      .toThrow(/what the status rests on/);
    expect(() => confirmRctPrincipal(ctx.db, { companyId: ctx.companyId, status: 'principal', basis: 'main contractor', confirmedBy: 'joe' }))
      .toThrow(/must be a date/);
    confirmRctPrincipal(ctx.db, { companyId: ctx.companyId, status: 'principal', from: '2026-02-01', basis: 'main contractor', confirmedBy: 'joe' });
    const row = ctx.db.select().from(companies).where(eq(companies.id, ctx.companyId)).get()!;
    expect(rctPrincipalOn(row, '2026-01-31')).toBeNull();
    expect(rctPrincipalOn(row, '2026-02-01')).toBe(true);
    const audit = ctx.db.select().from(auditEvents).where(and(eq(auditEvents.entityId, ctx.companyId), eq(auditEvents.field, 'rct_principal'))).get()!;
    expect(audit).toMatchObject({ action: 'user_confirmed', actor: 'joe' });
  });
});

describe('s.16(3) construction services', () => {
  it('status not recorded: the purchase is flagged, not reverse-charged', () => {
    const ctx = setup();
    const s = suggest(ctx, 'PLASTERING WORKS PHASE 2', -500_000);
    expect(s.decidingRule?.ruleKey).not.toBe(RC_CONSTRUCTION_RULE_KEY);
    expect(s.treatment?.code).not.toBe('RC_CONSTRUCTION');
    expect(s.reviewReasons.join(' ')).toMatch(/Record the company's RCT principal status/);
  });

  it('a recorded principal: construction services it receives get RC_CONSTRUCTION, from the date recorded', () => {
    const ctx = setup();
    confirmRctPrincipal(ctx.db, { companyId: ctx.companyId, status: 'principal', from: '2026-03-01', basis: 'main contractor', confirmedBy: 'joe' });
    const s = suggest(ctx, 'ROOFING SUBCONTRACT STAGE PAYMENT', -500_000);
    expect(s.decidingRule?.ruleKey).toBe(RC_CONSTRUCTION_RULE_KEY);
    expect(s.treatment?.code).toBe('RC_CONSTRUCTION');
    expect(s.reviewRequired).toBe(true);
    const before = suggest(ctx, 'ROOFING SUBCONTRACT STAGE PAYMENT', -500_000, '2026-02-15');
    expect(before.treatment?.code).not.toBe('RC_CONSTRUCTION');
  });

  it('not a principal: no reverse charge and no principal flag, but the connected-builder rule is named', () => {
    const ctx = setup();
    confirmRctPrincipal(ctx.db, { companyId: ctx.companyId, status: 'not_principal', basis: 'software company', confirmedBy: 'joe' });
    const s = suggest(ctx, 'OFFICE FIT-OUT WORKS', -500_000);
    expect(s.treatment?.code).not.toBe('RC_CONSTRUCTION');
    const reasons = s.reviewReasons.join(' ');
    expect(reasons).not.toMatch(/Record the company's RCT principal status/);
    expect(reasons).toMatch(/connected builder/);
  });

  it('a principal buying something that is not construction is not reverse-charged', () => {
    const ctx = setup();
    confirmRctPrincipal(ctx.db, { companyId: ctx.companyId, status: 'principal', from: '2026-01-01', basis: 'main contractor', confirmedBy: 'joe' });
    expect(suggest(ctx, 'LAPTOP PURCHASE', -150_000).treatment?.code).not.toBe('RC_CONSTRUCTION');
  });

  it('construction work sold: flagged, because whether the customer is a principal is not recorded', () => {
    const ctx = setup();
    const s = suggest(ctx, 'INVOICE 104 BLOCKLAYING', 800_000);
    expect(s.reviewReasons.join(' ')).toMatch(/If the customer is a principal for RCT/);
  });
});

describe('the other s.16 reverse charges are flagged', () => {
  it('scrap metal: no treatment chosen, RC_CONSTRUCTION offered', () => {
    const ctx = setup();
    const s = suggest(ctx, 'SCRAP COPPER 2.4T', -90_000);
    expect(s.decidingRule?.ruleKey).toBe('vat.domestic_reverse_charge_scrap_metal');
    expect(s.treatment).toBeNull();
    expect(s.offeredTreatmentCodes).toEqual(['RC_CONSTRUCTION']);
  });

  it('emission allowances and energy certificates', () => {
    const ctx = setup();
    expect(suggest(ctx, 'EU EMISSION ALLOWANCES 500', -900_000).decidingRule?.ruleKey).toBe('vat.domestic_reverse_charge_emission_allowances');
    expect(suggest(ctx, 'GUARANTEES OF ORIGIN Q1', -20_000).decidingRule?.ruleKey).toBe('vat.domestic_reverse_charge_energy_certificates');
  });
});
