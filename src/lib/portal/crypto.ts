import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

/**
 * Encryption for the portal's local-only vault (issue #166).
 *
 * The portal keeps nothing server-side: a request decrypts an uploaded vault
 * (or starts a fresh one), does its work in memory, and hands an encrypted
 * vault back for the user to keep as their own backup. This module is the
 * whole trust boundary — get it wrong and "we store no data" becomes "we
 * store your data unencrypted for the length of one request, but at least
 * we throw it away afterwards", which is not the promise being made.
 *
 * scrypt is the same key-derivation primitive `domain/auth/auth.ts` already
 * uses for the local single-user login (memory-hard, so brute-forcing a
 * captured vault costs real hardware, not just time). AES-256-GCM is
 * authenticated: a wrong password or a tampered/corrupted file fails to
 * decrypt rather than silently returning garbage.
 */

const VERSION = 1;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const AUTH_TAG_LENGTH = 16;
// N=2^17 is deliberately heavier than auth.ts's login hash (this key, once
// derived, decrypts someone's entire set of books) while still completing in
// well under a second — scrypt's memory requirement is roughly 128 * N * r
// bytes, so 2^17 costs about 128MB, comfortably inside a serverless
// function's memory budget.
const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export class VaultDecryptionError extends Error {}

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 256 * 1024 * 1024 });
}

/**
 * Encrypt an arbitrary byte buffer (a serialized SQLite database, in
 * practice) into one self-describing blob: version, salt, iv, auth tag and
 * ciphertext concatenated, so the only thing the user has to keep track of
 * is a single file and their password.
 */
export function encryptVault(plaintext: Buffer, password: string): Buffer {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(password, salt);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([
    Buffer.from([VERSION]),
    salt,
    iv,
    authTag,
    ciphertext,
  ]);
}

/**
 * Decrypt a blob produced by `encryptVault`. Throws `VaultDecryptionError`
 * for a wrong password, a corrupted file, or a file that isn't one of ours —
 * AES-GCM's auth tag makes those three indistinguishable from the outside,
 * which is the point: nothing here reveals a wrong password by behaving
 * differently from a corrupted file.
 */
export function decryptVault(blob: Buffer, password: string): Buffer {
  const headerLength = 1 + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;
  if (blob.length < headerLength) {
    throw new VaultDecryptionError('This does not look like a Leabhar vault file.');
  }

  const version = blob[0]!;
  if (version !== VERSION) {
    throw new VaultDecryptionError(`This vault was saved by a version of the format (v${version}) this build does not support.`);
  }

  let offset = 1;
  const salt = blob.subarray(offset, offset + SALT_LENGTH); offset += SALT_LENGTH;
  const iv = blob.subarray(offset, offset + IV_LENGTH); offset += IV_LENGTH;
  const authTag = blob.subarray(offset, offset + AUTH_TAG_LENGTH); offset += AUTH_TAG_LENGTH;
  const ciphertext = blob.subarray(offset);

  const key = deriveKey(password, Buffer.from(salt));

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new VaultDecryptionError(
      'Could not open this vault. The password is wrong, or the file is not a valid Leabhar vault.',
    );
  }
}

