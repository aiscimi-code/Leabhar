import { scryptAsync } from "@noble/hashes/scrypt.js";

/**
 * Portal vault (issue #166), entirely in the browser.
 *
 * Format v2: magic "LBHV", version, scrypt log2(N)/r/p, 16-byte salt,
 * 12-byte IV, AES-256-GCM ciphertext (tag appended by Web Crypto).
 * The password is not stored. A wrong password and a damaged file fail
 * the same way. N = 2^15 is the cost this portal writes; higher costs in
 * a file are refused so a hostile vault cannot lock the tab.
 */

const MAGIC = "LBHV";
const VERSION = 2;
const SALT_LEN = 16;
const IV_LEN = 12;
const HEADER_LEN = 4 + 4 + SALT_LEN + IV_LEN;
export const DEFAULT_LOG_N = 15;

export class VaultError extends Error {}

export type KeyMaterial = {
  key: CryptoKey;
  logN: number;
  r: number;
  p: number;
  salt: Uint8Array;
};

async function derive(
  password: string,
  salt: Uint8Array,
  logN: number,
  r: number,
  p: number,
  onProgress?: (progress: number) => void,
): Promise<CryptoKey> {
  const raw = await scryptAsync(password, salt, {
    N: 2 ** logN,
    r,
    p,
    dkLen: 32,
    maxmem: 128 * 1024 * 1024,
    onProgress,
  });
  const bytes = new Uint8Array(raw);
  try {
    return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  } finally {
    bytes.fill(0);
  }
}

export async function createKey(
  password: string,
  onProgress?: (progress: number) => void,
): Promise<KeyMaterial> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const key = await derive(password, salt, DEFAULT_LOG_N, 8, 1, onProgress);
  return { key, logN: DEFAULT_LOG_N, r: 8, p: 1, salt };
}

export async function seal(material: KeyMaterial, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, material.key, plaintext as BufferSource),
  );
  const header = new Uint8Array(HEADER_LEN);
  header.set(new TextEncoder().encode(MAGIC), 0);
  header[4] = VERSION;
  header[5] = material.logN;
  header[6] = material.r;
  header[7] = material.p;
  header.set(material.salt, 8);
  header.set(iv, 24);
  const out = new Uint8Array(header.length + cipher.length);
  out.set(header, 0);
  out.set(cipher, header.length);
  return out;
}

export async function openVault(
  blob: Uint8Array,
  password: string,
  onProgress?: (progress: number) => void,
): Promise<{ plaintext: Uint8Array; material: KeyMaterial }> {
  const head = new TextDecoder().decode(blob.subarray(0, Math.min(blob.length, 16)));
  if (head.startsWith("SQLite format")) {
    throw new VaultError("This file is an unencrypted SQLite database, not an encrypted portal vault.");
  }
  if (blob.length < HEADER_LEN + 16) {
    throw new VaultError("This does not look like a Leabhar portal vault.");
  }
  const magic = new TextDecoder().decode(blob.subarray(0, 4));
  if (magic !== MAGIC) {
    throw new VaultError(
      "This file is not a vault from this portal. The installed app's server portal uses a different file format.",
    );
  }
  if (blob[4] !== VERSION) {
    throw new VaultError(`This vault uses format v${blob[4]}, which this portal does not open.`);
  }
  const logN = blob[5] ?? 0;
  const r = blob[6] ?? 0;
  const p = blob[7] ?? 0;
  if (logN < 10 || logN > 16 || r < 1 || r > 16 || p < 1 || p > 2) {
    throw new VaultError("This vault's key cost is not one this portal will run in a browser.");
  }
  const salt = blob.slice(8, 24);
  const iv = blob.slice(24, 36);
  const cipher = blob.slice(36);
  const key = await derive(password, salt, logN, r, p, onProgress);
  try {
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher as BufferSource),
    );
    return { plaintext, material: { key, logN, r, p, salt } };
  } catch {
    throw new VaultError("Could not open this vault. The password is wrong, or the file is damaged.");
  }
}
