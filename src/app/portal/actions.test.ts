import { describe, it, expect } from 'vitest';
import { createVaultAction, importIntoVaultAction } from './actions';

/**
 * These exercise the actions end to end — real crypto, a real in-memory
 * database, the real domain functions — because the whole point of the
 * portal is that this round trip (create, download, come back later,
 * unlock, import, download again) actually works with nothing left behind
 * on the server in between.
 */

const formData = (fields: Record<string, string | Blob>): FormData => {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
};

describe('createVaultAction (issue #166)', () => {
  it('creates a company and bank account, returned encrypted', async () => {
    const result = await createVaultAction(formData({
      password: 'a-strong-password',
      legalName: 'Wild Atlantic Woodcraft Ltd',
      bankName: 'AIB Current',
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.legalName).toBe('Wild Atlantic Woodcraft Ltd');
    expect(result.summary.bankAccountName).toContain('AIB Current');
    expect(result.summary.transactionCount).toBe(0);
    expect(result.vaultBase64.length).toBeGreaterThan(0);
  });

  it('refuses a password under 8 characters', async () => {
    const result = await createVaultAction(formData({
      password: 'short', legalName: 'Anyone Ltd',
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('8 characters');
  });

  it('refuses a missing company name', async () => {
    const result = await createVaultAction(formData({
      password: 'a-strong-password', legalName: '',
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('company name');
  });
});

describe('importIntoVaultAction (issue #166)', () => {
  const vaultFile = (base64: string): Blob =>
    new File([Buffer.from(base64, 'base64')], 'test.leabhar');

  it('unlocks a vault and imports a bank statement into it', async () => {
    const created = await createVaultAction(formData({
      password: 'a-strong-password',
      legalName: 'Wild Atlantic Woodcraft Ltd',
      bankName: 'AIB Current',
    }));
    if (!created.ok) throw new Error('setup failed');

    const csv = [
      'Date,Description,Amount',
      '15/03/2025,VERCEL INC,-42.17',
    ].join('\n');

    const result = await importIntoVaultAction(formData({
      password: 'a-strong-password',
      vault: vaultFile(created.vaultBase64),
      statement: new File([csv], 'statement.csv', { type: 'text/csv' }),
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.importMessage).toContain('Imported 1 transaction');
    expect(result.summary.transactionCount).toBe(1);
    expect(result.summary.recentTransactions[0]?.description).toBe('VERCEL INC');
  });

  it('refuses the wrong password', async () => {
    const created = await createVaultAction(formData({
      password: 'a-strong-password', legalName: 'Anyone Ltd',
    }));
    if (!created.ok) throw new Error('setup failed');

    const result = await importIntoVaultAction(formData({
      password: 'the-wrong-password',
      vault: vaultFile(created.vaultBase64),
    }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/password is wrong|not a valid/);
  });

  it('refuses when no vault file is given', async () => {
    const result = await importIntoVaultAction(formData({ password: 'anything' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('vault file');
  });

  it('unlocks without importing anything when no statement is given', async () => {
    const created = await createVaultAction(formData({
      password: 'a-strong-password', legalName: 'Anyone Ltd',
    }));
    if (!created.ok) throw new Error('setup failed');

    const result = await importIntoVaultAction(formData({
      password: 'a-strong-password',
      vault: vaultFile(created.vaultBase64),
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary.importMessage).toBeNull();
    expect(result.summary.transactionCount).toBe(0);
  });
});
