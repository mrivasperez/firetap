import type { DatabaseBackend } from "./backend";

// The parts of the Admin SDK's Database that firetap uses, typed structurally so
// the library doesn't depend on firebase-admin.
type AdminSnapshot = {
  val(): unknown;
  exists(): boolean;
};

type AdminReference = {
  once(eventType: "value"): Promise<AdminSnapshot>;
  set(value: unknown): Promise<void>;
  update(values: object): Promise<void>;
  remove(): Promise<void>;
  push(): { key: string | null };
  transaction(
    apply: (current: unknown) => unknown
  ): Promise<{ committed: boolean; snapshot: AdminSnapshot | null }>;
};

/** The Realtime Database from firebase-admin's `getDatabase()`. */
export type AdminDatabase = {
  ref(path?: string): AdminReference;
};

const SERVER_OFFSET_TIMEOUT_MS = 1000;

export function adminBackend(db: AdminDatabase): DatabaseBackend {
  return {
    get: async (path) => {
      const snapshot = await db.ref(path).once("value");
      return snapshot.exists() ? snapshot.val() : null;
    },
    set: (path, value) => db.ref(path).set(value),
    update: (path, values) => db.ref(path).update(values),
    remove: (path) => db.ref(path).remove(),
    newKey: (path) => db.ref(path).push().key!,
    transaction: async (path, apply) => {
      const result = await db.ref(path).transaction(apply);
      return { committed: result.committed, value: result.snapshot?.val() ?? null };
    },
    serverTimeOffset: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const offset = await Promise.race([
        db
          .ref(".info/serverTimeOffset")
          .once("value")
          .then((snapshot) => snapshot.val())
          .catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), SERVER_OFFSET_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timer);
      return typeof offset === "number" ? offset : null;
    },
  };
}
