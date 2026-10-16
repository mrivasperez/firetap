const DB_NAME = "firetap";
const STORE = "snapshots";

export type CachedSnapshot = {
  snapshotKey: string;
  storedBytes: number;
  snapshot: Uint8Array;
};

// Best effort: every failure (no IndexedDB, private mode, quota) reads as a miss.
export class SnapshotCache {
  constructor(private readonly key: string) {}

  async get(): Promise<CachedSnapshot | null> {
    const value = await this.request("readonly", (store) => store.get(this.key));
    return isCachedSnapshot(value) ? value : null;
  }

  async put(entry: CachedSnapshot): Promise<void> {
    await this.request("readwrite", (store) => store.put(entry, this.key));
  }

  async delete(): Promise<void> {
    await this.request("readwrite", (store) => store.delete(this.key));
  }

  private async request(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest
  ): Promise<unknown> {
    try {
      const db = await openDatabase();
      if (!db) return null;
      return await new Promise((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } catch {
      return null;
    }
  }
}

let database: Promise<IDBDatabase | null> | null = null;

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  database ??= new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
  return database;
}

function isCachedSnapshot(value: unknown): value is CachedSnapshot {
  const v = value as Partial<CachedSnapshot> | null;
  return (
    typeof v?.snapshotKey === "string" &&
    typeof v.storedBytes === "number" &&
    v.snapshot instanceof Uint8Array
  );
}
