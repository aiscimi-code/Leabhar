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
    expect(first.rulesAfter).toBe(68);
  });

  it('loading again is a no-op', () => {
    const again = loadStatutoryKnowledgeBase(db, { companyId });
    expect(again.rulesBefore).toBe(68);
    expect(again.rulesAfter).toBe(68);
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
    expect(s.reviewReasons.join(' ')).toContain('no exemption (Schedule 1)');
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

describe('RULE_TREATMENT_BINDINGS', () => {
  it('covers every curated VAT rate rule, so no rate rule is silently unbound', () => {
    const bound = new Set(RULE_TREATMENT_BINDINGS.flatMap((b) => b.ruleKeys));
    const rateRules = [
      ...VATCA_REVISED_CURATED_RULES.map((r) => r.ruleKey),
      ...VATCA_SCHEDULE_CURATED_RULES.map((r) => r.ruleKey),
    ];
    expect(rateRules.filter((k) => !bound.has(k))).toEqual([]);
  });
});
