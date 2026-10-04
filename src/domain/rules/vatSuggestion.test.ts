import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createTestDatabase, insertTestBankTransaction } from '@/db/testing';
import { createCompany, addBankAccount } from '../config/setup';
import { bankTransactions, suppliers, customers } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';
import { loadStatutoryKnowledgeBase, statuteFilePath } from './knowledgeBase';
import { suggestVatTreatment, RULE_TREATMENT_BINDINGS } from './vatSuggestion';
import { VATCA_REVISED_CURATED_RULES } from './vatcaRevisedCuration';
import { VATCA_SCHEDULE_CURATED_RULES } from './vatcaScheduleCuration';
import { VAT_SCOPE_CURATED_RULES } from './vatScopeCuration';
import { VAT_PLACE_OF_SUPPLY_CURATED_RULES } from './vatPlaceOfSupplyCuration';
import { lookupTransactionRules } from './transactionLookup';

let db: AppDatabase;
let companyId: string;
let bankAccountId: string;
let tr: Record<string, string>;

function party(table: 'supplier' | 'customer', name: string, over: {
  countryCode?: string; vatNumber?: string; treatment?: string;
  taxableStatus?: 'taxable_person' | 'non_taxable_person';
  /** Where the party is established, as a person confirmed it (issue #207). */
  establishment?: 'in_state' | 'outside_state';
} = {}): string {
  const id = table === 'supplier' ? ids.supplier() : ids.customer();
  const values = {
    id, companyId, name, matchKey: name.toLowerCase(),
    countryCode: over.countryCode ?? null, vatNumber: over.vatNumber ?? null,
    defaultVatTreatmentId: over.treatment ? tr[over.treatment] : null,
    ...(over.establishment ? {
      establishment: over.establishment, establishmentBasis: 'test fixture',
      establishmentConfirmedBy: 'tester', establishmentConfirmedAt: '2025-06-01T00:00:00Z',
    } : {}),
  };
  if (table === 'supplier') db.insert(suppliers).values(values).run();
  else db.insert(customers).values({ ...values, taxableStatus: over.taxableStatus ?? null }).run();
  return id;
}

function tx(description: string, amountMinor: number, over: Partial<typeof bankTransactions.$inferInsert> = {}): string {
  return insertTestBankTransaction(db, {
    companyId, bankAccountId, transactionDate: '2025-06-15', description, amountMinor, ...over,
  });
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
    // Every rule the curated sources derive (issue #277: keep this a count the
    // curation arrays explain — vat3-rtd 15, eBrief 1, EU 282/2011 7 were added
    // by #439/#440/#441 on top of the 266 on main, 257 plus #434's 9; issue #313
    // added Part 11's 7 motor car rules and s.959AN(4)'s preliminary tax rule;
    // the rule-figure batch added 8 (USC surcharge threshold, PRSI Class S
    // minimum, five CT preliminary-tax percentages, s.440 marginal relief cap);
    // EPIC 20's payroll curation added 34 (#526: 3 PRSI thresholds and credit,
    // 15 dated Class A and 5 dated Class S rate versions, 2 employer thresholds, the NTF levy, and
    // 8 PAYE and USC procedures); EPIC 21 added 5 (#532: ERR particulars and
    // subcategories, the €3.20 allowance, the small benefit count and limit); EPIC 22
    // added 11 (#466: the Part 11C car emissions groups under the 2008, 2021 and 2027 schemes); #614 added
    // 1 (s.37(4), the exchange rate); #646 added 1 (s.99(4), the refund claim time limit); #611 added 2 (the s.74 and s.75 tax
    // points); #645 added 6 (ss.21, 27(2), 42 and 44, and S.I. 639/2010 regs 5 and 7: the deemed supplies); #620 added 3 (s.39(2)
    // and S.I. 639/2010 reg.10: bad-debt relief and its recovery).
    expect(first.rulesAfter).toBe(412);
  });

  it('loading again is a no-op', () => {
    const again = loadStatutoryKnowledgeBase(db, { companyId });
    expect(again.rulesBefore).toBe(412);
    expect(again.rulesAfter).toBe(412);
  });

  it('US SaaS purchase → non-EU reverse charge, cited to VATCA s.12 with a verifiable slice', () => {
    const supplierId = party('supplier', 'Vercel Inc', { countryCode: 'US', treatment: 'NON_EU_SERVICES_RCV', establishment: 'outside_state' });
    const s = suggestVatTreatment(db, { companyId, bankTransactionId: tx('VERCEL INC', -2_000, { supplierId }) })!;

    expect(s.status).toBe('suggested');
    expect(s.treatment?.code).toBe('NON_EU_SERVICES_RCV');
    expect(s.decidingRule?.ruleKey).toBe('vat.reverse_charge_services_from_abroad');
    expect(s.decidingRule?.sectionNumber).toBe('12');
    expect(s.factSources['supplyType']).toContain('supplier default treatment');
    expect(s.reviewRequired).toBe(true);
    expect(s.factSources['supplierEstablishedOutsideState']).toContain('confirmed by tester');

    // The citation is checkable: the file exists, its hash matches, and the
    // offsets slice a region containing the quoted words.
    const c = s.decidingRule!;
    expect(c.localPath).toBe('docs/statutes/vatca-2010/vatca-2010-enacted.md');
    const file = readFileSync(statuteFilePath(c.localPath!), 'utf8');
    expect(createHash('sha256').update(file).digest('hex')).toBe(c.sha256);
    const slice = file.slice(c.sourceStart!, c.sourceEnd!).replace(/\s+/g, ' ');
    expect(slice).toContain('receives a service from a supplier established');
  });

  it('a US supplier whose establishment nobody has confirmed: no reverse charge from its country alone, flagged', () => {
    const supplierId = party('supplier', 'Unconfirmed Inc', { countryCode: 'US', treatment: 'NON_EU_SERVICES_RCV' });
    const s = suggestVatTreatment(db, { companyId, bankTransactionId: tx('UNCONFIRMED INC', -2_000, { supplierId }) })!;
    expect(s.decidingRule?.ruleKey).not.toBe('vat.reverse_charge_services_from_abroad');
    expect(s.treatment?.code).not.toBe('IE_STD');
    expect(s.reviewReasons.join(' ')).toMatch(/where it is established .* has not been confirmed/);
  });

  it('German services purchase → EU reverse charge', () => {
    const supplierId = party('supplier', 'Hetzner', { vatNumber: 'DE812871812', treatment: 'EU_SERVICES_RCV', establishment: 'outside_state' });
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
    const supplierId = party('supplier', 'Stripe US', { countryCode: 'US', treatment: 'NON_EU_SERVICES_RCV', establishment: 'outside_state' });
    const s = suggestVatTreatment(db, {
      companyId, bankTransactionId: tx('STRIPE', -1_500, { supplierId, vatTreatmentId: tr['IE_STD'] }),
    })!;
    expect(s.treatment?.code).toBe('NON_EU_SERVICES_RCV');
    expect(s.agreesWithBooked).toBe(false);
  });

  it('a restaurant purchase keeps its rate, and s.60 blocks only the deduction (issue #616)', () => {
    const supplierId = party('supplier', 'The Winding Stair', { countryCode: 'IE' });
    const s = suggestVatTreatment(db, { companyId, bankTransactionId: tx('CLIENT DINNER RESTAURANT', -12_000, { supplierId }) })!;
    expect(s.treatment?.code).not.toBe('NON_DEDUCTIBLE');
    expect(s.treatment?.code).not.toBe('IE_STD');
    expect(s.deductionBlocked?.ruleKey).toBe('vat.blocked_food_drink_accommodation');
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

  it('livestock is suggested the livestock treatment at 4.8% (issue #205)', () => {
    const customerId = party('customer', 'Mart Ltd', { countryCode: 'IE' });
    const s = suggestVatTreatment(db, { companyId, bankTransactionId: tx('SALE OF CATTLE', 80_000, { customerId }) })!;
    expect(s.status).toBe('suggested');
    expect(s.decidingRule?.ruleKey).toBe('vat.rate_livestock_current');
    expect(s.treatment?.code).toBe('IE_LIVESTOCK');
    expect(s.configuredRateBasisPoints).toBe(480);
    expect(s.rateAgrees).toBe(true);
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

describe('services sold abroad — VATCA s.34 (issue #200)', () => {
  beforeAll(() => {
    setup();
    loadStatutoryKnowledgeBase(db, { companyId });
  });

  it('to an Italian business (EU VAT number) → services supplied to an EU business, cited to revised s.34(a)', () => {
    const customerId = party('customer', 'Continental Design SRL', {
      countryCode: 'IT', vatNumber: 'IT12345678901', treatment: 'EU_SERVICES_SUPPLY', establishment: 'outside_state',
    });
    const s = suggestVatTreatment(db, { companyId, bankTransactionId: tx('CONTINENTAL DESIGN SRL', 600_000, { customerId }) })!;
    expect(s.status).toBe('suggested');
    expect(s.treatment?.code).toBe('EU_SERVICES_SUPPLY');
    expect(s.decidingRule?.ruleKey).toBe('vat.place_of_supply_services_to_business_abroad');
    expect(s.decidingRule?.citation).toBe('2010 Act 31 s.34');
    expect(s.decidingRule?.localPath).toBe('docs/statutes/vatca-2010-revised/s034.md');
    expect(s.factSources['customerIsTaxablePerson']).toContain('282/2011 art.18(1)');
    const file = readFileSync(statuteFilePath(s.decidingRule!.localPath!), 'utf8');
    expect(file.slice(s.decidingRule!.sourceStart!, s.decidingRule!.sourceEnd!)).toContain(s.decidingRule!.quote!);
  });

  it('to a US business recorded as a taxable person → services supplied outside the EU', () => {
    const customerId = party('customer', 'Redwood Analytics Inc', {
      countryCode: 'US', treatment: 'NON_EU_SERVICES_SUPPLY', taxableStatus: 'taxable_person', establishment: 'outside_state',
    });
    const s = suggestVatTreatment(db, { companyId, bankTransactionId: tx('REDWOOD ANALYTICS', 250_000, { customerId }) })!;
    expect(s.treatment?.code).toBe('NON_EU_SERVICES_SUPPLY');
    expect(s.factSources['customerIsTaxablePerson']).toContain('customer record');
  });

  it('to a US customer whose status nobody has recorded → no suggestion, not the domestic 23%', () => {
    const customerId = party('customer', 'Unknown US Buyer', { countryCode: 'US', treatment: 'NON_EU_SERVICES_SUPPLY' });
    const s = suggestVatTreatment(db, { companyId, bankTransactionId: tx('US BUYER', 90_000, { customerId }) })!;
    expect(s.status).toBe('no_rule');
    expect(s.unresolvedFields).toContain('customerIsTaxablePerson');
  });

  it('a recorded status beats the VAT number, and a consumer is never treated as a business', () => {
    const customerId = party('customer', 'Jean Dupont', {
      countryCode: 'FR', vatNumber: 'FR40303265045', treatment: 'EU_SERVICES_SUPPLY', taxableStatus: 'non_taxable_person',
    });
    const s = suggestVatTreatment(db, { companyId, bankTransactionId: tx('J DUPONT', 20_000, { customerId }) })!;
    expect(s.facts['customerIsTaxablePerson']).toBe(false);
    expect(s.treatment?.code).not.toBe('EU_SERVICES_SUPPLY');
    expect(s.supportingRules.map((r) => r.ruleKey)).toContain('vat.place_of_supply_services_to_consumer');
    expect(s.reviewReasons.join(' ')).toContain('s.34(kc)');
  });

  it('s.34(b): a service sold to a consumer abroad is supplied here (lookup level)', () => {
    const r = lookupTransactionRules(db, { companyId, transaction: {
      transactionDate: '2025-06-15', amountMinor: 20_000, direction: 'sale', supplyType: 'services',
      customerCountry: 'FR', customerIsTaxablePerson: false, vatRegistered: true, description: 'Consulting',
    } });
    expect(r.applicableRules.map((a) => a.ruleKey)).toContain('vat.place_of_supply_services_to_consumer');
    expect(r.applicableRules.map((a) => a.ruleKey)).not.toContain('vat.place_of_supply_services_to_business_abroad');
  });

  it('a domestic business sale is not caught by the "abroad" rule', () => {
    const customerId = party('customer', 'Mulligan Digital', {
      countryCode: 'IE', vatNumber: 'IE6543217L', taxableStatus: 'taxable_person',
    });
    const s = suggestVatTreatment(db, { companyId, bankTransactionId: tx('MULLIGAN DIGITAL', 430_500, { customerId }) })!;
    expect(s.decidingRule?.ruleKey).not.toBe('vat.place_of_supply_services_to_business_abroad');
  });
});

describe('rules with no conditions stay out of every lookup', () => {
  const CITED_ONLY = ['vat.dual_use_apportionment', 'vat.invoice_tax_stated_in_error', 'vat.invoice_time_limit',
    'vat.tax_point_supply_invoice', 'vat.tax_point_intra_community_acquisition'];

  it('every derived vat_scope rule has conditions: the topic opens for every transaction', async () => {
    const { VAT_SCOPE_DERIVED_RULES } = await import('./vatScopeIngestion');
    expect(VAT_SCOPE_DERIVED_RULES.filter((r) => r.topic === 'vat_scope' && r.conditions.length === 0)
      .map((r) => r.ruleKey)).toEqual([]);
    expect(VAT_SCOPE_DERIVED_RULES.filter((r) => CITED_ONLY.includes(r.ruleKey)).map((r) => r.topic))
      .toEqual(CITED_ONLY.map(() => 'vat_reference'));
  });

  it('a grocery purchase is not given the acquisition tax point or the invoice time limit', () => {
    setup();
    loadStatutoryKnowledgeBase(db, { companyId });
    const r = lookupTransactionRules(db, { companyId, transaction: {
      transactionDate: '2025-06-15', amountMinor: 5_000, direction: 'purchase', description: 'Tesco groceries',
    } });
    const keys = r.applicableRules.map((a) => a.ruleKey);
    for (const key of CITED_ONLY) expect(keys).not.toContain(key);
  });

  it('a book derived with the old topic is re-derived, not left as it was', async () => {
    setup();
    loadStatutoryKnowledgeBase(db, { companyId });
    const { irishTaxRules } = await import('@/db/schema');
    const { eq, and } = await import('drizzle-orm');
    const { deriveVatScopeRules } = await import('./vatScopeIngestion');
    const active = and(eq(irishTaxRules.ruleKey, 'vat.tax_point_supply_invoice'), eq(irishTaxRules.active, true));
    db.update(irishTaxRules).set({ topic: 'vat_scope' }).where(active).run();
    const result = deriveVatScopeRules(db, { companyId });
    expect(result.superseded).toBe(1);
    expect(db.select().from(irishTaxRules).where(active).get()!.topic).toBe('vat_reference');
  });
});

describe('deriveVatScopeRules verbatim guard', () => {
  it('refuses a rule whose quoted excerpt is not in the provision text', async () => {
    setup();
    const { irishActProvisions, irishKnowledgeSources } = await import('@/db/schema');
    const { eq, and } = await import('drizzle-orm');
    const { deriveVatScopeRules, VAT_SCOPE_DERIVED_RULES } = await import('./vatScopeIngestion');
    loadStatutoryKnowledgeBase(db, { companyId });
    const sch1 = db.select().from(irishKnowledgeSources).where(eq(irishKnowledgeSources.citation, '2010 Act 31 Sch.1')).get()!;
    // Simulate a provision whose stored text no longer contains the rule's quote.
    db.update(irishActProvisions).set({ provisionText: 'text that says nothing about insurance' })
      .where(and(eq(irishActProvisions.sourceId, sch1.id), eq(irishActProvisions.sectionNumber, '8'))).run();
    const other = createCompany(db, { legalName: 'Second Ltd', seedYears: [2025] });
    const result = deriveVatScopeRules(db, { companyId: other.companyId });
    expect(result.skippedExcerptNotInProvision).toEqual(['vat.exempt_insurance']);
    expect(result.created).toBe(VAT_SCOPE_DERIVED_RULES.length - 1);
  });
});

describe('RULE_TREATMENT_BINDINGS', () => {
  it('covers every curated VAT rate, exemption and scope rule, so none is silently unbound', () => {
    const bound = new Set(RULE_TREATMENT_BINDINGS.flatMap((b) => b.ruleKeys));
    const rateRules = [
      ...VATCA_REVISED_CURATED_RULES.map((r) => r.ruleKey),
      ...VATCA_SCHEDULE_CURATED_RULES.map((r) => r.ruleKey),
      ...VAT_SCOPE_CURATED_RULES.map((r) => r.ruleKey),
      'vat.place_of_supply_services_to_business_abroad',
    ];
    expect(rateRules.filter((k) => !bound.has(k))).toEqual([]);
  });
});
