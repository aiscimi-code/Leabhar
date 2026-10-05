import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { buildVat3Return } from './report';
import { journalEntries, journalLines, reviewItems, vatEntries, vatPeriods } from '@/db/schema';
import type { AppDatabase } from '@/db';
import {
  recordDeemedSupply, deemedSupplyGoodsTreatments, BUSINESS_GIFT_LIMIT_MINOR, DeemedSupplyError, type DeemedSupplyInput,
} from './deemedSupply';
import { SI_639_CURATED_RULES } from '../rules/si639Curation';

/**
 * Issue #645: output VAT on a deemed supply with no sale invoice. Goods given
 * away or taken (VATCA s.19(1)(g), s.21, taxable amount s.42(1)(a)) and
 * private use of pre-2011 property (s.27(2), s.44, S.I. 639/2010 reg.7).
 */

let db: AppDatabase;
let companyId: string;
let drawingsId: string;
let vatControlId: string;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, {
    legalName: 'Deemed Ltd', vatRegistrationStatus: 'registered', vatAccountingBasis: 'invoice', seedYears: [2025],
  });
  companyId = created.companyId;
  drawingsId = created.accountsByCode['6070']!;
  vatControlId = created.accountsByKey['vat_control']!;
});

const period = (name: string) => db.select().from(vatPeriods)
  .where(and(eq(vatPeriods.companyId, companyId), eq(vatPeriods.name, name))).get()!;
const t1 = (name: string) => buildVat3Return(db, { companyId, vatPeriodId: period(name).id }).T1.amountMinor;

type Goods = Extract<DeemedSupplyInput, { kind: 'goods' }>;
const goods = (over: Partial<Goods> = {}) => recordDeemedSupply(db, {
  companyId, kind: 'goods', use: 'gift', date: '2025-03-10', accountId: drawingsId, description: 'Hamper for a client',
  recordedBy: 'Aoife', costMinor: 5_000, treatmentCode: 'IE_STD', taxDeductedOrTransferred: true, ...over,
} as Goods);

type Property = Extract<DeemedSupplyInput, { kind: 'immovable_private_use' }>;
const property = (over: Partial<Property> = {}) => recordDeemedSupply(db, {
  companyId, kind: 'immovable_private_use', date: '2025-04-30', accountId: drawingsId, description: 'Flat over the shop',
  recordedBy: 'Aoife', acquiredOn: '2008-06-01', acquisitionTaxableAmountMinor: 50_000_000, privateFloorArea: 30,
  totalFloorArea: 100, treatedAsBusinessAsset: true, ...over,
} as Property);

describe('goods given away or taken (s.19(1)(g), s.21, s.42(1)(a))', () => {
  it('a €50 gift at 23%: €11.50 output VAT in T1, charged to the named account, with a review item', () => {
    const r = goods();
    expect(r).toMatchObject({ posted: true, taxableAmountMinor: 5_000, vatMinor: 1_150 });
    if (!r.posted) throw new Error('not posted');
    expect(t1('Mar–Apr 2025')).toBe(1_150);
    const lines = db.select().from(journalLines).where(eq(journalLines.journalEntryId, r.journalEntryId)).all();
    expect(lines.map((l) => [l.accountId, l.baseDebitMinor, l.baseCreditMinor])).toEqual([
      [drawingsId, 1_150, 0], [vatControlId, 0, 1_150],
    ]);
    const entry = db.select().from(vatEntries).where(eq(vatEntries.journalEntryId, r.journalEntryId)).get()!;
    expect([entry.direction, entry.taxPointDate]).toEqual(['sales', '2025-03-10']);
    const item = db.select().from(reviewItems).where(eq(reviewItems.entityId, r.journalEntryId)).get()!;
    expect(item.title).toContain('Deemed supply recorded');
  });

  it('a gift costing exactly €20 is not a supply; €20.01 is, on the whole cost', () => {
    expect(goods({ costMinor: 2_000 })).toMatchObject({ posted: false });
    expect(goods({ costMinor: 2_001 })).toMatchObject({ posted: true, vatMinor: 460 }); // 2001 x 23% = 460.23
    expect(t1('Mar–Apr 2025')).toBe(460);
  });

  it('a €15 gift that is one of a series to the same person is a supply', () => {
    expect(goods({ costMinor: 1_500, partOfSeriesToSamePerson: true })).toMatchObject({ posted: true, vatMinor: 345 });
  });

  it('the €20 limit is for gifts only: goods taken for private use are taxed at any cost', () => {
    expect(goods({ use: 'private_use', costMinor: 1_000 })).toMatchObject({ posted: true, vatMinor: 230 });
  });

  it('industrial samples, and goods whose VAT was not deducted, are not supplies; nothing is written', () => {
    expect(goods({ costMinor: 50_000, industrialSamples: true })).toMatchObject({ posted: false });
    expect(goods({ costMinor: 50_000, taxDeductedOrTransferred: false })).toMatchObject({ posted: false });
    expect(db.select().from(journalEntries).all()).toHaveLength(0);
  });

  it('takes the rate the goods would bear, and refuses one an Irish sale cannot', () => {
    expect(goods({ costMinor: 10_000, treatmentCode: 'IE_RED' })).toMatchObject({ posted: true, vatMinor: 1_350 });
    expect(() => goods({ treatmentCode: 'IE_EXEMPT' })).toThrow(DeemedSupplyError);
  });

  it('a gift dated in a locked period is refused before anything is written', () => {
    db.update(vatPeriods).set({ status: 'locked' }).where(eq(vatPeriods.id, period('Mar–Apr 2025').id)).run();
    expect(() => goods()).toThrow();
    expect(db.select().from(journalEntries).all()).toHaveLength(0);
    expect(db.select().from(vatEntries).all()).toHaveLength(0);
  });

  it('the limit is the figure in S.I. 639/2010 reg.5', () => {
    expect(BUSINESS_GIFT_LIMIT_MINOR).toBe(2_000);
    expect(SI_639_CURATED_RULES.find((r) => r.regulationNumber === '5')!.statementExcerpt).toContain('exceed €20, exclusive of tax');
  });
});

describe('private use of pre-2011 property (s.27(2), s.44, reg.7)', () => {
  it('€500,000 x 30/100 / 120 = €1,250 taxable, €287.50 VAT at the standard rate', () => {
    const r = property();
    expect(r).toMatchObject({ posted: true, taxableAmountMinor: 125_000, vatMinor: 28_750 });
    expect(t1('Mar–Apr 2025')).toBe(28_750);
  });

  it('rounds once, to the cent: €100.01 x 1/3 / 120 = €0.28', () => {
    expect(property({ acquisitionTaxableAmountMinor: 10_001, privateFloorArea: 1, totalFloorArea: 3 }))
      .toMatchObject({ posted: true, taxableAmountMinor: 28, vatMinor: 6 });
  });

  it('property acquired on or after 1 January 2011 is outside s.27(2)', () => {
    expect(property({ acquiredOn: '2011-01-01' })).toMatchObject({ posted: false });
    expect(property({ acquiredOn: '2010-12-31' })).toMatchObject({ posted: true });
  });

  it('use 20 years or more after the acquisition is not a supply', () => {
    expect(property({ acquiredOn: '2005-04-30' })).toMatchObject({ posted: false });
    expect(property({ acquiredOn: '2005-05-01' })).toMatchObject({ posted: true });
  });

  it('property not treated as a business asset is not a supply', () => {
    expect(property({ treatedAsBusinessAsset: false })).toMatchObject({ posted: false });
  });

  it('refuses a private floor area larger than the whole', () => {
    expect(() => property({ privateFloorArea: 101 })).toThrow(DeemedSupplyError);
    expect(() => property({ privateFloorArea: 0 })).toThrow(DeemedSupplyError);
  });
});

describe('the rates offered for a deemed supply of goods (#658)', () => {
  it('lists only Irish sales rates that charge VAT: the same test recordDeemedSupply applies', () => {
    const offered = deemedSupplyGoodsTreatments(db, companyId);
    expect(offered.map((t) => t.code)).toContain('IE_STD');
    expect(goods({ treatmentCode: 'IE_STD' }).posted).toBe(true);
    for (const t of offered) {
      expect([t.jurisdiction, t.direction === 'purchases', t.isReverseCharge, t.appliesRate]).toEqual(['IE', false, false, true]);
      // Accepted, never refused as the wrong rate; a zero rate is a supply with no VAT to post.
      const r = goods({ treatmentCode: t.code });
      if (!r.posted) expect(r.reason).toMatch(/zero-rated/);
    }
  });
});
