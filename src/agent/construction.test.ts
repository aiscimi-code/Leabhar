import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDatabase } from '@/db/testing';
import { suppliers } from '@/db/schema';
import { ids } from '@/lib/ids';
import type { AppDatabase } from '@/db';
import { createCompany } from '@/domain/config/setup';
import { confirmRctPrincipal } from '@/domain/config/companyStatus';
import { main } from '@/cli/reconcile';

let db: AppDatabase;
let companyId: string;
let supplierId: string;
beforeEach(() => {
  ({ db } = createTestDatabase());
  ({ companyId } = createCompany(db, { legalName: 'Tógáil Ltd', vatRegistrationStatus: 'registered', seedYears: [2026] }));
  confirmRctPrincipal(db, { companyId, status: 'principal', from: '2026-01-01', basis: 'Main contractor', confirmedBy: 'owner' });
  supplierId = ids.supplier();
  db.insert(suppliers).values({ id: supplierId, companyId, name: 'Plasterer', matchKey: 'plasterer', countryCode: 'IE' }).run();
});

async function run(argv: string[]): Promise<unknown> {
  const out: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true; });
  try {
    const code = await main(argv, { db, companyId });
    expect(code, out.join('')).toBe(0);
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(out.join(''));
}

describe('construction and RCT from the CLI (EPIC 26)', () => {
  it('sets up a project, site, subcontractor and a notified contract', async () => {
    await run(['add-project', '--code', 'P1', '--name', 'Extension', '--from', '2026-01-10', '--by', 'o']);
    const site = await run(['add-site', '--name', 'Scoil', '--address', 'Tuam', '--project', 'P1', '--by', 'o']) as { id: string };
    const sub = await run(['add-subcontractor', '--supplier', supplierId, '--tax-ref', '1234567T', '--evidence', 'Passport',
      '--checked-by', 'o', '--checked-on', '2026-01-12', '--not-employee']) as { id: string };
    const contract = await run(['add-rct-contract', '--subcontractor', sub.id, '--site', site.id, '--project', 'P1', '--description', 'Plastering',
      '--value', '50000', '--from', '2026-01-15', '--notified', '2026-01-14', '--revenue-id', 'C-1', '--by', 'o']) as { revenueContractId: string };
    expect(contract.revenueContractId).toBe('C-1');
    expect(await run(['rct-period', '--period', '2026-03'])).toMatchObject({ liabilityMinor: 0 });
  });
});
