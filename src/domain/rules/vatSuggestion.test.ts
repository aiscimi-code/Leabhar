import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createTestDatabase } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { bankTransactions, suppliers, customers } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';
import { loadStatutoryKnowledgeBase, statuteFilePath } from './knowledgeBase';
import { suggestVatTreatment, RULE_TREATMENT_BINDINGS } from './vatSuggestion';
import { VATCA_REVISED_CURATED_RULES } from './vatcaRevisedCuration';
import { VATCA_SCHEDULE_CURATED_RULES } from './vatcaScheduleCuration';
import { VAT_SCOPE_CURATED_RULES } from './vatScopeCuration';

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;
let tr: Record<string, string>;

function party(table: 'supplier' | 'customer', name: string, over: { countryCode?: string; vatNumber?: string; treatment?: string } = {}): string {
  const id = table === 'supplier' ? ids.supplier() : ids.customer();
  const values = {
    id, companyId, name, matchKey: name.toLowerCase(),
    countryCode: over.countryCode ?? null, vatNumber: over.vatNumber ?? null,
    defaultVatTreatmentId: over.treatment ? tr[over.treatment] : null,
  };
  if (table === 'supplier') db.insert(suppliers).values(values).run();
  else db.insert(customers).values(values).run();
  return id;
}

function tx(description: string, amountMinor: number, over: Partial<typeof bankTransactions.$inferInsert> = {}): string {
  const id = ids.bankTransaction();
  db.insert(bankTransactions).values({
    id, companyId, bankAccountId, transactionDate: '2025-06-15', description,
    amountMinor, currency: 'EUR', fingerprint: `fp-${id}`, ...over,
  }).run();
  return id;
}

function setup(): void {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Suggest Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025],
  });
  companyId = created.companyId;
  tr = created.treatmentsByCode;
  bankAccountId = addBankAccount(db, {
    companyId, bankName: 'AIB', accountName: 'Current', openingDate: '2025-01-01',
    accountId: created.accountsByKey['bank_control']!,
  });
}

describe('before the knowledge base is loaded', () => {
  it('says so rather than suggesting anything', () => {
    setup();
    const s = suggestVatTreatment(db, { companyId, bankTransactionId: tx('Stationery', -5_000) })!;
    expect(s.status).toBe('kb_empty');
    expect(s.treatment).toBeNull();
  });
});

describe('suggestVatTreatment', () => {
  beforeAll(() => {
    setup();
    const first = loadStatutoryKnowledgeBase(db, { companyId });
    expect(first.rulesBefore).toBe(0);
    expect(first.rulesAfter).toBe(77);
  });

  it('loading again is a no-op', () => {
    const again = loadStatutoryKnowledgeBase(db, { companyId });
    expect(again.rulesBefore).toBe(77);
    expect(again.rulesAfter).toBe(77);
  });

  it('US SaaS purchase → non-EU reverse charge, cited to VATCA s.12 with a verifiable slice', () => {
    const supplierId = party('supplier', 'Vercel Inc', { countryCode: 'US', treatment: 'NON_EU_SERVICES_RCV' });
    const s = suggestVatTreatment(db, { companyId, bankTransactionId: tx('VERCEL INC', -2_000, { supplierId }) })!;

    expect(s.status).toBe('suggested');
    expect(s.treatment?.code).toBe('NON_EU_SERVICES_RCV');
    expect(s.decidingRule?.ruleKey).toBe('vat.reverse_charge_services_from_abroad');
    expect(s.decidingRule?.sectionNumber).toBe('12');
    expect(s.factSources['supplyType']).toContain('supplier default treatment');
    expect(s.reviewRequired).toBe(true);
    expect(s.reviewReasons.join(' ')).toContain('282/2011');

    // The citation is checkable: the file exists, its hash matches, and the
    // offsets slice a region containing the quoted words.
    const c = s.decidingRule!;
    expect(c.localPath).toBe('docs/statutes/vatca-2010/vatca-2010-enacted.md');
    const file = readFileSync(statuteFilePath(c.localPath!), 'utf8');
    expect(createHash('sha256').update(file).digest('hex')).toBe(c.sha256);
    const slice = file.slice(c.sourceStart!, c.sourceEnd!).replace(/\s+/g, ' ');
    expect(slice).toContain('receives a service from a supplier established');
  });

  it('German services purchase → EU reverse charge', () => {
    const supplierId = party('supplier', 'Hetzner', { vatNumber: 'DE812871812', treatment: 'EU_SERVICES_RCV' });
    const s = suggestVatTreatment(db, { companyId, bankTransactionId: tx('HETZNER ONLINE', -3_000, { supplierId }) })!;
    expect(s.treatment?.code).toBe('EU_SERVICES_RCV');
    expect(s.facts.counterpartyCountry).toBe('DE');
    expect(s.factSources['counterpartyCountry']).toContain('VAT number prefix');
  });

  it('Irish purchase with no specific rule → standard rate as a fallback only, never a finding', () => {
    const supplierId = party('supplier', 'Easons', { countryCode: 'IE' });
    const s = suggestVatTreatment(db, { companyId, bankTransactionId: tx('EASONS STATIONERY', -4_000, { supplierId }) })!;
    expect(s.status).toBe('fallback_only');
    expect(s.treatment?.code).toBe('IE_STD');
    expect(s.reviewReasons.join(' ')).toContain('curates only five Schedule 1 exemptions');
    expect(s.decidingRule?.ruleKey).toBe('vat.rate_standard_current');
    expect(s.ruleRateBasisPoints).toBe(2300);
    expect(s.configuredRateBasisPoints).toBe(2300);
    expect(s.rateAgrees).toBe(true);
  });

  it('flags a booked treatment that disagrees with the suggestion', () => {
    const supplierId = party('supplier', 'Stripe US', { countryCode: 'US', treatment: 'NON_EU_SERVICES_RCV' });
    const s = suggestVatTreatment(db, {
      companyId, bankTransactionId: tx('STRIPE', -1_500, { supplierId, vatTreatmentId: tr['IE_STD'] }),
    })!;
    expect(s.treatment?.code).toBe('NON_EU_SERVICES_RCV');
    expect(s.agreesWithBooked).toBe(false);
  });

  it('a restaurant purchase is blocked under s.60 rather than rated', () => {
    const supplierId = party('supplier', 'The Winding Stair', { countryCode: 'IE' });
    const s = suggestVatTreatment(db, { companyId, bankTransactionId: tx('CLIENT DINNER RESTAURANT', -12_000, { supplierId }) })!;
    expect(s.treatment?.code).toBe('NON_DEDUCTIBLE');
    expect(s.decidingRule?.ruleKey).toBe('vat.deduction_exclusions_entertainment');
  });

  it('a US purchase of unknown supply type gets no rule — never the domestic 23% fallback', () => {
    const supplierId = party('supplier', 'Amazon US', { countryCode: 'US' });
    const s = suggestVatTreatment(db, { companyId, bankTransactionId: tx('AMAZON.COM', -9_000, { supplierId }) })!;
    expect(s.status).toBe('no_rule');
    expect(s.treatment).toBeNull();
    expect(s.reviewReasons.join(' ')).toContain('domestic 23% fallback was not applied');
  });

  it('goods sold to a VAT-registered German customer → intra-Community supply', () => {
    const customerId = party('customer', 'Berlin GmbH', { vatNumber: 'DE812871812', treatment: 'EU_GOODS_SUPPLY' });
    const s = suggestVatTreatment(db, { companyId, bankTransactionId: tx('BERLIN GMBH PAYMENT', 50_000, { customerId }) })!;
    expect(s.facts.direction).toBe('sale');
    expect(s.treatment?.code).toBe('EU_GOODS_SUPPLY');
    expect(s.decidingRule?.ruleKey).toBe('vat.zero_rate_intra_community_goods');
  });

  it('livestock matches a statutory rule but no treatment exists for it — reported, not guessed', () => {
    const customerId = party('customer', 'Mart Ltd', { countryCode: 'IE' });
    const s = suggestVatTreatment(db, { companyId, bankTransactionId: tx('SALE OF CATTLE', 80_000, { customerId }) })!;
    expect(s.status).toBe('no_treatment');
    expect(s.decidingRule?.ruleKey).toBe('vat.rate_livestock_current');
    expect(s.reviewReasons.join(' ')).toContain('no VAT treatment is configured');
  });
});

describe('exempt and outside-the-scope lines (issue #200)', () => {
  beforeAll(() => {
    setup();
    loadStatutoryKnowledgeBase(db, { companyId });
  });

  const suggest = (description: string, amountMinor: number) =>
    suggestVatTreatment(db, { companyId, bankTransactionId: tx(description, amountMinor) })!;

  it('bank charges → exempt under Schedule 1 para 6(1)(c), with a verifiable slice of schedule-1.md', () => {
    const s = suggest('BANK CHARGES Q1', -1_250);
    expect(s.status).toBe('suggested');
    expect(s.treatment?.code).toBe('IE_EXEMPT');
    expect(s.decidingRule?.ruleKey).toBe('vat.exempt_bank_account_and_payment_services');
    expect(s.decidingRule?.citation).toBe('2010 Act 31 Sch.1');
    expect(s.decidingRule?.sectionNumber).toBe('6');
    const c = s.decidingRule!;
    expect(c.localPath).toBe('docs/statutes/vatca-2010-revised/schedule-1.md');
    const file = readFileSync(statuteFilePath(c.localPath!), 'utf8');
    expect(createHash('sha256').update(file).digest('hex')).toBe(c.sha256);
    expect(file.slice(c.sourceStart!, c.sourceEnd!)).toContain(c.quote!);
  });

  it.each([
    ['INSURANCE IRELAND DAC', -48_000, 'vat.exempt_insurance'],
    ['OFFICE RENT MARCH', -150_000, 'vat.exempt_letting_immovable_goods'],
    ['IRISH RAIL TRAIN TICKET', -3_850, 'vat.exempt_passenger_transport'],
    ['AN POST STAMPS', -1_100, 'vat.exempt_postal_universal_service'],
  ])('%s → exempt (%s)', (description, amount, ruleKey) => {
    const s = suggest(description, amount);
    expect(s.treatment?.code).toBe('IE_EXEMPT');
    expect(s.decidingRule?.ruleKey).toBe(ruleKey);
  });

  it.each([
    ['REVENUE VAT3 PAYMENT', -120_400, 'vat.outside_scope_tax_payment'],
    ['REVENUE COLLECTOR GENERAL PAYE', -80_000, 'vat.outside_scope_tax_payment'],
    ['SALARY J MURPHY', -250_000, 'vat.outside_scope_employment'],
    ['SHARE CAPITAL SUBSCRIPTION', 10_000, 'vat.outside_scope_capital_loans_dividends'],
    ['DIRECTOR LOAN INTRODUCED', 500_000, 'vat.outside_scope_capital_loans_dividends'],
    ['INTERNAL TRANSFER TO SAVINGS ACCOUNT', -100_000, 'vat.outside_scope_own_account_transfer'],
  ])('%s → outside the scope (%s)', (description, amount, ruleKey) => {
    const s = suggest(description, amount);
    expect(s.treatment?.code).toBe('OUT_OF_SCOPE');
    expect(s.decidingRule?.ruleKey).toBe(ruleKey);
  });

  it('an exempt supply outranks the 23% fallback, never the other way round', () => {
    const s = suggest('INSURANCE IRELAND DAC', -48_000);
    expect(s.supportingRules.some((r) => r.ruleKey === 'vat.rate_standard_current')).toBe(true);
    expect(s.treatment?.code).toBe('IE_EXEMPT');
  });

  it('does not stretch a rule past its own words', () => {
    // Car hire is not a letting of immovable goods; loan interest is not covered
    // (Sch.1 para 6(1)(a) reads "…"); insurance received is not an insurance purchase.
    expect(suggest('CAR RENTAL HERTZ', -30_000).decidingRule?.ruleKey).not.toBe('vat.exempt_letting_immovable_goods');
    const interest = suggest('LOAN INTEREST', -4_000);
    expect(interest.treatment?.code).not.toBe('IE_EXEMPT');
    expect(interest.treatment?.code).not.toBe('OUT_OF_SCOPE');
    expect(suggest('INSURANCE CLAIM SETTLEMENT RECEIVED', 90_000).decidingRule?.ruleKey).not.toBe('vat.exempt_insurance');
  });
});

describe('deriveVatScopeRules verbatim guard', () => {
  it('refuses a rule whose quoted excerpt is not in the provision text', async () => {
    setup();
    const { irishActProvisions, irishKnowledgeSources } = await import('@/db/schema');
    const { eq, and } = await import('drizzle-orm');
    const { deriveVatScopeRules } = await import('./vatScopeIngestion');
    loadStatutoryKnowledgeBase(db, { companyId });
    const sch1 = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.citation, '2010 Act 31 Sch.1')).get()!;
    // Simulate a provision whose stored text no longer contains the rule's quote.
    db.update(irishActProvisions).set({ provisionText: 'text that says nothing about insurance' })
      .where(and(eq(irishActProvisions.sourceId, sch1.id), eq(irishActProvisions.sectionNumber, '8'))).run();
    const other = createCompany(db, { legalName: 'Second Ltd', seedYears: [2025] });
    const result = deriveVatScopeRules(db, { companyId: other.companyId });
    expect(result.skippedExcerptNotInProvision).toEqual(['vat.exempt_insurance']);
    expect(result.created).toBe(VAT_SCOPE_CURATED_RULES.length - 1);
  });
});

describe('RULE_TREATMENT_BINDINGS', () => {
  it('covers every curated VAT rate, exemption and scope rule, so none is silently unbound', () => {
    const bound = new Set(RULE_TREATMENT_BINDINGS.flatMap((b) => b.ruleKeys));
    const rateRules = [
      ...VATCA_REVISED_CURATED_RULES.map((r) => r.ruleKey),
      ...VATCA_SCHEDULE_CURATED_RULES.map((r) => r.ruleKey),
      ...VAT_SCOPE_CURATED_RULES.map((r) => r.ruleKey),
    ];
    expect(rateRules.filter((k) => !bound.has(k))).toEqual([]);
  });
});
