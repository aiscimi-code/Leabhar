import { describe, it, expect } from 'vitest';
import { encryptVault, decryptVault, VaultDecryptionError } from './crypto';

describe('portal crypto (issue #166)', () => {
  it('round-trips a buffer through encrypt then decrypt with the same password', () => {
    const plaintext = Buffer.from('a set of books, allegedly');
    const blob = encryptVault(plaintext, 'correct-horse-battery-staple');
    const recovered = decryptVault(blob, 'correct-horse-battery-staple');
    expect(recovered.equals(plaintext)).toBe(true);
  });

  it('refuses to decrypt with the wrong password', () => {
    const blob = encryptVault(Buffer.from('secret'), 'right-password');
    expect(() => decryptVault(blob, 'wrong-password')).toThrow(VaultDecryptionError);
  });

  it('refuses a tampered ciphertext, not just a wrong password', () => {
    const blob = encryptVault(Buffer.from('secret'), 'a-password');
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    expect(() => decryptVault(tampered, 'a-password')).toThrow(VaultDecryptionError);
  });

  it('refuses a file too short to be a vault', () => {
    expect(() => decryptVault(Buffer.from('not a vault'), 'anything')).toThrow(VaultDecryptionError);
  });

  it('produces different ciphertext for the same plaintext and password each time', () => {
    const plaintext = Buffer.from('same content');
    const first = encryptVault(plaintext, 'password');
    const second = encryptVault(plaintext, 'password');
    // A fresh random salt and iv each time — a captured vault never reveals
    // that two backups hold identical books just by comparing bytes.
    expect(first.equals(second)).toBe(false);
    expect(decryptVault(first, 'password').equals(plaintext)).toBe(true);
    expect(decryptVault(second, 'password').equals(plaintext)).toBe(true);
  });

  it('round-trips a large buffer (a realistic serialized database)', () => {
    const plaintext = Buffer.alloc(500_000, 7);
    const blob = encryptVault(plaintext, 'password');
    expect(decryptVault(blob, 'password').equals(plaintext)).toBe(true);
  });
});
