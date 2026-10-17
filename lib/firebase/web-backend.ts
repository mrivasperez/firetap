import type { Database, DataSnapshot } from "firebase/database";
import {
  get,
  onDisconnect,
  onChildAdded,
  onChildChanged,
  onValue,
  orderByKey,
  push,
  query,
  ref,
  remove,
  runTransaction,
  set,
  startAfter,
  update,
} from "firebase/database";
import type { DatabaseBackend } from "./backend";

const SERVER_OFFSET_TIMEOUT_MS = 1000;

export function webBackend(db: Database): DatabaseBackend {
  return {
    get: async (path) => {
      const snapshot = await get(ref(db, path));
      return snapshot.exists() ? snapshot.val() : null;
    },
    set: (path, value) => set(ref(db, path), value),
    update: (path, values) => update(ref(db, path), values),
    remove: (path) => remove(ref(db, path)),
    removeOnDisconnect: (path) => onDisconnect(ref(db, path)).remove(),
    newKey: (path) => push(ref(db, path)).key!,
    transaction: async (path, apply) => {
      const result = await runTransaction(ref(db, path), apply);
      return { committed: result.committed, value: result.snapshot.val() };
    },
    // get() doesn't support .info paths.
    serverTimeOffset: () =>
      new Promise((resolve) => {
        let unsubscribe = () => {};
        const timer = setTimeout(() => {
          unsubscribe();
          resolve(null);
        }, SERVER_OFFSET_TIMEOUT_MS);
        unsubscribe = onValue(ref(db, ".info/serverTimeOffset"), (snapshot) => {
          clearTimeout(timer);
          unsubscribe();
          resolve(typeof snapshot.val() === "number" ? snapshot.val() : null);
        });
      }),
    watchChildren: (path, afterKey, onChild) => {
      const children = afterKey
        ? query(ref(db, path), orderByKey(), startAfter(afterKey))
        : ref(db, path);
      const handle = (child: DataSnapshot) => onChild(child.key!, child.val());
      const unsubscribers = [onChildAdded(children, handle), onChildChanged(children, handle)];
      return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
    },
  };
}
