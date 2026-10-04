// IndexedDB 本地库：断网期间所有工作只落本地，恢复连接后再同步。

const DB_NAME = "cleanroom-offline-v1";
const DB_VERSION = 1;

export type StoreName =
  | "records"
  | "tickets"
  | "calibrations"
  | "resolutions"
  | "handovers"
  | "outbox";

const STORES: StoreName[] = [
  "records",
  "tickets",
  "calibrations",
  "resolutions",
  "handovers",
  "outbox",
];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function idbPut<T extends { id: string }>(store: StoreName, value: T): Promise<void> {
  await tx(store, "readwrite", (s) => s.put(value));
}

export async function idbGet<T>(store: StoreName, id: string): Promise<T | undefined> {
  return tx<T | undefined>(store, "readonly", (s) => s.get(id) as IDBRequest<T | undefined>);
}

export async function idbGetAll<T>(store: StoreName): Promise<T[]> {
  return tx<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>);
}

export async function idbBulkPut<T extends { id: string }>(store: StoreName, values: T[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(store, "readwrite");
    const s = t.objectStore(store);
    for (const v of values) s.put(v);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function idbClear(store: StoreName): Promise<void> {
  await tx(store, "readwrite", (s) => s.clear());
}
