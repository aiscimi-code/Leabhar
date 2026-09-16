import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { evaluateRules, createRule, proposeRuleFromClassification } from './engine';
import { rules, suppliers } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';

let db: AppDatabase;
let companyId: string;
let byCode: Record<string, string>;
let tr: Record<string, string>;

beforeEach(() => {
  ({ db } = createTestDatabase());
  const created = createCompany(db, { legalName: 'Acme Ltd', seedYears: [2025] });
  companyId = created.companyId;
  byCode = created.accountsByCode;
  tr = created.treatmentsByCode;
});

const rule = (over: Partial<Parameters<typeof createRule>[1]> = {}) =>
  createRule(db, {
    companyId,
    name: 'Vercel is hosting',
    conditions: [{ field: 'description', operator: 'contains', value: 'VERCEL' }],
    actions: [{ field: 'accountId', value: byCode['6010']! }],
    ...over,
  });

describe('evaluateRules', () => {
  it('matches and explains itself in plain terms', () => {
    rule();
    const result = evaluateRules(db, {
      companyId, subject: { description: 'CARD PAYMENT VERCEL INC' },
    });
    expect(result.matches).toHaveLength(1);
    expect(result.effectiveActions['accountId']).toBe(byCode['6010']);
    expect(result.winner!.explanation)
      .toBe('Rule "Vercel is hosting" matched because The description contains "VERCEL".');
  });

  it('does not match when the condition fails', () => {
    rule();
    const result = evaluateRules(db, { companyId, subject: { description: 'STRIPE PAYOUT' } });
    expect(result.matches).toHaveLength(0);
    expect(result.winner).toBeNull();
  });

  it('matches regardless of punctuation and case', () => {
    rule();
    for (const description of ['vercel inc', 'VERCEL, INC.', 'Vercel  Inc']) {
      expect(evaluateRules(db, { companyId, subject: { description } }).matches).toHaveLength(1);
    }
  });

  it('requires every condition to hold', () => {
    rule({
      conditions: [
        { field: 'description', operator: 'contains', value: 'VERCEL' },
        { field: 'absAmountMinor', operator: 'gt', value: 10_000 },
      ],
    });
    expect(evaluateRules(db, {
      companyId, subject: { description: 'VERCEL', absAmountMinor: 4_217 },
    }).matches).toHaveLength(0);
    expect(evaluateRules(db, {
      companyId, subject: { description: 'VERCEL', absAmountMinor: 20_000 },
    }).matches).toHaveLength(1);
  });

  // A blank rule must not silently reclassify the whole ledger.
  it('never matches a rule with no conditions', () => {
    db.insert(rules).values({
      id: ids.rule(), companyId, name: 'Empty', conditions: [],
      actions: [{ field: 'accountId', value: byCode['6010']! }],
    }).run();
    expect(evaluateRules(db, { companyId, subject: { description: 'ANYTHING' } }).matches)
      .toHaveLength(0);
  });

  it('refuses to create a rule with no conditions', () => {
    expect(() => createRule(db, {
      companyId, name: 'Empty', conditions: [],
      actions: [{ field: 'accountId', value: byCode['6010']! }],
    })).toThrow(/would match every transaction/);
  });

  it('refuses to create a rule with no actions', () => {
    expect(() => createRule(db, {
      companyId, name: 'Pointless',
      conditions: [{ field: 'description', operator: 'contains', value: 'X' }],
      actions: [],
    })).toThrow(/would do nothing/);
  });

  it('honours priority order', () => {
    rule({ name: 'Low priority', priority: 200, actions: [{ field: 'accountId', value: byCode['6900']! }] });
    rule({ name: 'High priority', priority: 10, actions: [{ field: 'accountId', value: byCode['6010']! }] });
    const result = evaluateRules(db, { companyId, subject: { description: 'VERCEL' } });
    expect(result.winner!.ruleName).toBe('High priority');
    expect(result.effectiveActions['accountId']).toBe(byCode['6010']);
  });

  it('stops at the first matching rule by default', () => {
    rule({ name: 'First', priority: 10 });
    rule({ name: 'Second', priority: 20 });
    expect(evaluateRules(db, { companyId, subject: { description: 'VERCEL' } }).matches)
      .toHaveLength(1);
  });

  it('lets a non-stopping rule fall through to fill other fields', () => {
    rule({
      name: 'Account only', priority: 10, stopOnMatch: false,
      actions: [{ field: 'accountId', value: byCode['6010']! }],
    });
    rule({
      name: 'VAT treatment', priority: 20,
      actions: [{ field: 'vatTreatmentId', value: tr['NON_EU_SERVICES_RCV']! }],
    });
    const result = evaluateRules(db, { companyId, subject: { description: 'VERCEL' } });
    expect(result.matches).toHaveLength(2);
    expect(result.effectiveActions['accountId']).toBe(byCode['6010']);
    expect(result.effectiveActions['vatTreatmentId']).toBe(tr['NON_EU_SERVICES_RCV']);
  });

  it('never lets a later rule overwrite an earlier one', () => {
    rule({
      name: 'First', priority: 10, stopOnMatch: false,
      actions: [{ field: 'accountId', value: byCode['6010']! }],
    });
    rule({
      name: 'Second', priority: 20,
      actions: [{ field: 'accountId', value: byCode['6900']! }],
    });
    expect(evaluateRules(db, { companyId, subject: { description: 'VERCEL' } })
      .effectiveActions['accountId']).toBe(byCode['6010']);
  });

  it('ignores disabled rules', () => {
    const id = rule();
    db.update(rules).set({ enabled: false }).where(eq(rules.id, id)).run();
    expect(evaluateRules(db, { companyId, subject: { description: 'VERCEL' } }).matches)
      .toHaveLength(0);
  });

  it('filters by what the rule applies to', () => {
    rule({ appliesTo: 'document' });
    expect(evaluateRules(db, {
      companyId, subject: { description: 'VERCEL' }, appliesTo: 'bank_transaction',
    }).matches).toHaveLength(0);
    expect(evaluateRules(db, {
      companyId, subject: { description: 'VERCEL' }, appliesTo: 'document',
    }).matches).toHaveLength(1);
  });
});

describe('operators', () => {
  const check = (
    condition: Parameters<typeof createRule>[1]['conditions'][number],
    subject: Record<string, unknown>,
  ) => {
    db.delete(rules).run();
    rule({ conditions: [condition] });
    return evaluateRules(db, { companyId, subject }).matches.length === 1;
  };

  it('handles text operators', () => {
    expect(check({ field: 'currency', operator: 'equals', value: 'EUR' }, { currency: 'EUR' })).toBe(true);
    expect(check({ field: 'currency', operator: 'equals', value: 'EUR' }, { currency: 'USD' })).toBe(false);
    expect(check({ field: 'currency', operator: 'not_equals', value: 'EUR' }, { currency: 'USD' })).toBe(true);
    expect(check({ field: 'description', operator: 'starts_with', value: 'sepa' }, { description: 'SEPA TRANSFER' })).toBe(true);
    expect(check({ field: 'description', operator: 'ends_with', value: 'payout' }, { description: 'STRIPE PAYOUT' })).toBe(true);
    expect(check({ field: 'description', operator: 'not_contains', value: 'REFUND' }, { description: 'PAYMENT' })).toBe(true);
    expect(check({ field: 'currency', operator: 'in', value: ['EUR', 'GBP'] }, { currency: 'GBP' })).toBe(true);
    expect(check({ field: 'currency', operator: 'in', value: ['EUR', 'GBP'] }, { currency: 'USD' })).toBe(false);
  });

  it('handles numeric operators on amounts', () => {
    expect(check({ field: 'absAmountMinor', operator: 'gt', value: 50_000 }, { absAmountMinor: 60_000 })).toBe(true);
    expect(check({ field: 'absAmountMinor', operator: 'gte', value: 50_000 }, { absAmountMinor: 50_000 })).toBe(true);
    expect(check({ field: 'absAmountMinor', operator: 'lt', value: 50_000 }, { absAmountMinor: 10_000 })).toBe(true);
    expect(check({ field: 'absAmountMinor', operator: 'lte', value: 50_000 }, { absAmountMinor: 50_000 })).toBe(true);
    expect(check({ field: 'absAmountMinor', operator: 'between', value: [10_000, 20_000] }, { absAmountMinor: 15_000 })).toBe(true);
    expect(check({ field: 'absAmountMinor', operator: 'between', value: [10_000, 20_000] }, { absAmountMinor: 25_000 })).toBe(false);
  });

  it('describes amounts in currency units, not cents', () => {
    rule({ conditions: [{ field: 'absAmountMinor', operator: 'gt', value: 50_000 }] });
    const result = evaluateRules(db, { companyId, subject: { absAmountMinor: 60_000 } });
    expect(result.winner!.explanation).toContain('(600.00)');
    expect(result.winner!.explanation).toContain('greater than 500.00');
  });

  it('handles regular expressions', () => {
    expect(check({ field: 'description', operator: 'matches', value: '^AWS.*SARL$' }, { description: 'AWS EMEA SARL' })).toBe(true);
    expect(check({ field: 'description', operator: 'matches', value: '^AWS' }, { description: 'MY AWS BILL' })).toBe(false);
  });

  it('never lets an invalid regular expression match everything', () => {
    expect(check({ field: 'description', operator: 'matches', value: '[unclosed' }, { description: 'ANYTHING' })).toBe(false);
  });

  it('handles empty checks', () => {
    expect(check({ field: 'supplierId', operator: 'is_null', value: null }, { supplierId: null })).toBe(true);
    expect(check({ field: 'supplierId', operator: 'is_null', value: null }, { supplierId: 'sup_1' })).toBe(false);
  });

  it('fails a condition on a missing field rather than matching', () => {
    expect(check({ field: 'nonexistent', operator: 'equals', value: 'x' }, {})).toBe(false);
  });

  it('respects case sensitivity when asked', () => {
    expect(check(
      { field: 'currency', operator: 'equals', value: 'eur', caseSensitive: true },
      { currency: 'EUR' },
    )).toBe(false);
  });

  it('routes on direction', () => {
    expect(check({ field: 'direction', operator: 'equals', value: 'out' }, { direction: 'out' })).toBe(true);
    expect(check({ field: 'direction', operator: 'equals', value: 'out' }, { direction: 'in' })).toBe(false);
  });
});

describe('learning from confirmed history', () => {
  it('proposes an inspectable rule from a confirmed classification', () => {
    const supplierId = ids.supplier();
    db.insert(suppliers).values({
      id: supplierId, companyId, name: 'Anthropic', matchKey: 'anthropic',
      countryCode: 'US',
    }).run();

    const result = proposeRuleFromClassification(db, {
      companyId, supplierId,
      accountId: byCode['6000']!, vatTreatmentId: tr['NON_EU_SERVICES_RCV']!,
    });

    expect(result.ruleId).toBeTruthy();
    const created = db.select().from(rules).where(eq(rules.id, result.ruleId!)).get()!;
    expect(created.derivedFromHistory).toBe(true);
    // It proposes, it does not decide.
    expect(created.autoApply).toBe(false);
    expect(created.description).toContain('proposes rather than decides');

    // And it fires next time.
    const evaluation = evaluateRules(db, { companyId, subject: { supplierId } });
    expect(evaluation.effectiveActions['accountId']).toBe(byCode['6000']);
    expect(evaluation.effectiveActions['vatTreatmentId']).toBe(tr['NON_EU_SERVICES_RCV']);
  });

  it('does not create a second rule for the same supplier', () => {
    const supplierId = ids.supplier();
    db.insert(suppliers).values({
      id: supplierId, companyId, name: 'Anthropic', matchKey: 'anthropic',
    }).run();

    const first = proposeRuleFromClassification(db, {
      companyId, supplierId, accountId: byCode['6000']!, vatTreatmentId: tr['IE_STD']!,
    });
    const second = proposeRuleFromClassification(db, {
      companyId, supplierId, accountId: byCode['6010']!, vatTreatmentId: tr['IE_STD']!,
    });

    expect(second.ruleId).toBe(first.ruleId);
    expect(second.reason).toContain('already exists');
    expect(db.select().from(rules).all()).toHaveLength(1);
  });
});
