/** Encrypted bytes only. The key and the password are never written here. */

const DB_NAME = "leabhar-portal";
const STORE = "vault";
const KEY = "current";

export type StoredVault = {
  bytes: ArrayBuffer;
  legalName: string;
  savedAt: string;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open browser storage."));
  });
}

export async function idbSave(bytes: Uint8Array, legalName: string): Promise<void> {
  const db = await openDb();
  const copy = bytes.slice().buffer;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const record: StoredVault = { bytes: copy, legalName, savedAt: new Date().toISOString() };
    tx.objectStore(STORE).put(record, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not save the encrypted vault."));
  });
  db.close();
}

export async function idbLoad(): Promise<StoredVault | null> {
  const db = await openDb();
  const record = await new Promise<StoredVault | null>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(KEY);
    request.onsuccess = () => resolve((request.result as StoredVault | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("Could not read browser storage."));
  });
  db.close();
  return record;
}

export async function idbForget(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Could not remove the vault."));
  });
  db.close();
}
