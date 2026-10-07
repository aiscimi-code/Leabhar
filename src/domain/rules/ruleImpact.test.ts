import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { createCompany } from '../config/setup';
import { mostReliedOn, resolveImpactTarget, ruleDepends, ruleImpact } from './ruleImpact';
import { generateAuditReport } from './audit';
import { main } from '@/cli/irishRules';
import type { AppDatabase } from '@/db';

afterEach(() => vi.restoreAllMocks());

describe('impact and depends (ADR-0020 §6, issue #686 step 4)', () => {
  let db: AppDatabase;
  let companyId: string;

  beforeAll(() => {
    ({ db } = createTestDatabase());
    ({ companyId } = createCompany(db, { legalName: 'Impact Ltd', vatRegistrationStatus: 'registered', seedYears: [2025] }));
  });

  const impactOf = (target: string) => ruleImpact(db, { companyId, target: resolveImpactTarget(db, { companyId, target }) });

  it('lists the rules relying on a rule, directly and through others', () => {
    const { affected } = impactOf('vat.rate_hairdressing');
    expect(affected).toContainEqual(expect.objectContaining({
      ruleKey: 'vat.reduced_rate_hairdressing', depth: 1, kind: 'rate_from', through: 'vat.rate_hairdressing',
    }));
    // Each rule once, nearest first.
    expect(new Set(affected.map((e) => e.ruleKey)).size).toBe(affected.length);
    expect(affected.map((e) => e.depth)).toEqual([...affected.map((e) => e.depth)].sort((a, b) => a - b));
  });

  it('reaches the Schedule 3 rules through the rates when VATCA s.46 changes', () => {
    const result = impactOf('VATCA 2010 s.46');
    expect(result.target).toMatchObject({ kind: 'provision' });
    const byKey = new Map(result.affected.map((e) => [e.ruleKey, e]));
    expect(byKey.get('vat.rate_hospitality')).toMatchObject({ depth: 1, kind: 'derived_from' });
    // Two steps out: through the hospitality rate it takes its rate from, or a headline rate it excludes.
    expect(byKey.get('vat.reduced_rate_restaurant_catering')).toMatchObject({ depth: 2 });
    expect(ruleImpact(db, { companyId, target: { kind: 'rule', ruleKey: 'vat.rate_hospitality' } }).affected)
      .toContainEqual(expect.objectContaining({ ruleKey: 'vat.reduced_rate_restaurant_catering', kind: 'rate_from' }));
  });

  it('lists what a rule relies on, with the provisions behind it', () => {
    const result = ruleDepends(db, { companyId, ruleKey: 'vat.reduced_rate_hairdressing' });
    expect(result.rules).toContainEqual(expect.objectContaining({ ruleKey: 'vat.rate_hairdressing', depth: 1, kind: 'rate_from' }));
    // A Schedule 3 rule is a determination, so it excludes the headline rate facts.
    expect(result.rules).toContainEqual(expect.objectContaining({ ruleKey: 'vat.rate_reduced_current', depth: 1, kind: 'excludes' }));
    expect(result.provisions.map((p) => p.citation)).toEqual(expect.arrayContaining([expect.stringMatching(/s\.46$/)]));
  });

  it('refuses a target the book does not hold, rather than reporting no impact', () => {
    expect(() => resolveImpactTarget(db, { companyId, target: 'vat.no_such_rule' })).toThrow(/not a rule key/);
  });

  it('puts the link counts, the graph checks and the most relied-on rules in the audit report', () => {
    const { ruleLinks } = generateAuditReport(db, { companyId });
    expect(ruleLinks.graphFindings).toEqual([]);
    expect(ruleLinks.byKind.rate_from).toBeGreaterThan(30);
    expect(ruleLinks.mostReliedOn).toEqual(mostReliedOn(db, { companyId }));
    expect(ruleLinks.mostReliedOn[0]!.affected).toBeGreaterThan(0);
  });

  it('answers on the command line', async () => {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += String(s); return true; });
    expect(await main(['impact', 'vat.rate_hairdressing'], { db, companyId })).toBe(0);
    expect(JSON.parse(out).affected.map((e: { ruleKey: string }) => e.ruleKey)).toContain('vat.reduced_rate_hairdressing');
    out = '';
    expect(await main(['depends', 'vat.reduced_rate_hairdressing'], { db, companyId })).toBe(0);
    expect(JSON.parse(out).rules[0].ruleKey).toBe('vat.rate_hairdressing');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await main(['depends', 'VATCA 2010 s.46'], { db, companyId })).toBe(1);
  });
});
