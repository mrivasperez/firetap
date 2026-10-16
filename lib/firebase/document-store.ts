import * as Y from "yjs";
import type { Database, DataSnapshot } from "firebase/database";
import {
  get,
  onValue,
  push,
  ref,
  remove,
  runTransaction,
  set,
  update,
} from "firebase/database";
import { base64ToUint8Array, uint8ArrayToBase64 } from "../utils/base64";
import { compressBytes, decompressBytes } from "../utils/compression";
import { defaultLogger, type Logger } from "../utils/logger";
import {
  DEFAULT_PERSIST_DEBOUNCE_MS,
  LOAD_MAX_ATTEMPTS,
  LOG_ENTRY_GZIP_MIN_BYTES,
  MERGE_LEASE_MS,
  MERGE_MAX_LOG_BYTES,
  MERGE_MIN_LOG_BYTES,
  PERSIST_RETRY_BASE_MS,
  PERSIST_RETRY_MAX_MS,
  RESCUE_JITTER_MS,
  STORED_PART_CHARS,
} from "../utils/constants";

// {meta}              { generation, snapshot, parts, bytes, lease? }
// {snapshots}/{key}   base64(gzip(update)), split into parts
// {updates}/{pushKey} { by, data, gz? }, or { by, gz?, p, n } when large
//
// Each client appends only its own edits. Merges fold the log into a new
// snapshot using only what was read from Firebase, and switch generations
// through a transaction on {meta}.

export type SaveState = "saved" | "saving" | "unsaved" | "error";

/** The document couldn't be read. Never treated as an empty document. */
export class LoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "LoadError";
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export const FIREBASE_ORIGIN = Object.freeze({ source: "firebase" });

export type DocumentMeta = {
  generation: number;
  snapshot: string | null;
  parts: number;
  bytes: number;
  lease?: { holder: string; until: number } | null;
};

type StoredEntry = {
  by?: string;
  gz?: 1;
  data?: string;
  p?: string[] | Record<string, string>;
  n?: number;
};

export type DocumentStorePaths = { updates: string; snapshots: string; meta: string };

export type DocumentStoreOptions = {
  rtdb: Database;
  paths: DocumentStorePaths;
  ydoc: Y.Doc;
  peerId: string;
  debounceMs?: number;
  logger?: Logger;
  isRemoteOrigin: (origin: unknown) => boolean;
  onStateChange?: (state: SaveState) => void;
  onError?: (error: Error) => void;
  onPersisted?: (clientId: number, clock: number) => void;
  onMerged?: (generation: number) => void;
};

// Merges use only what was read from Firebase, never the live document.
type Base = {
  generation: number;
  snapshotKey: string | null;
  snapshot: Uint8Array | null;
  snapshotStoredBytes: number;
  entries: Map<string, Uint8Array>;
  entryStoredBytes: number;
};

type Waiter = { resolve: () => void; reject: (error: Error) => void };

export class DocumentStore {
  private readonly opts: DocumentStoreOptions & { debounceMs: number; logger: Logger };
  private queue: Uint8Array[] = [];
  private inFlight: Uint8Array[] | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private waiters: Waiter[] = [];
  private state: SaveState = "saved";
  private running = false;
  private base: Base | null = null;
  private merging: Promise<boolean> | null = null;

  // How far each client's edits are saved, to rescue a departed peer's unsaved edits.
  private persistedClocks = new Map<number, number>();
  private rescueTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(options: DocumentStoreOptions) {
    this.opts = {
      ...options,
      debounceMs: options.debounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS,
      logger: options.logger ?? defaultLogger,
    };
  }

  get saveState(): SaveState {
    return this.state;
  }

  get generation(): number {
    return this.base?.generation ?? 0;
  }

  hasUnsavedChanges(): boolean {
    return this.queue.length > 0 || this.inFlight !== null;
  }

  async load(): Promise<void> {
    let base: Base | null = null;
    for (let attempt = 1; !base; attempt++) {
      base = await this.readBase();
      if (!base && attempt >= LOAD_MAX_ATTEMPTS) {
        throw new LoadError("The document kept changing while loading; try again");
      }
    }

    const updates = [...(base.snapshot ? [base.snapshot] : []), ...base.entries.values()];
    if (updates.length > 0) {
      try {
        Y.applyUpdate(this.opts.ydoc, Y.mergeUpdates(updates), FIREBASE_ORIGIN);
      } catch (error) {
        throw new LoadError("The stored document could not be decoded", { cause: error });
      }
    }
    this.base = base;

    // Everything just loaded is saved.
    Y.decodeStateVector(Y.encodeStateVector(this.opts.ydoc)).forEach((clock, client) =>
      this.notePersisted(client, clock)
    );
  }

  // Null if a merge landed mid-read: the snapshot may not cover entries it deleted.
  private async readBase(): Promise<Base | null> {
    const { rtdb, paths } = this.opts;
    try {
      const meta = readMeta(await get(ref(rtdb, paths.meta)));
      let snapshot: Uint8Array | null = null;
      let snapshotStoredBytes = 0;
      if (meta.snapshot) {
        const stored = await get(ref(rtdb, `${paths.snapshots}/${meta.snapshot}`));
        const parts = stored.exists() ? partsOf(stored.val()) : null;
        if (!parts || parts.length !== meta.parts) return null;
        const joined = parts.join("");
        snapshotStoredBytes = joined.length;
        snapshot = await decompressBytes(base64ToUint8Array(joined));
      }

      const log = await get(ref(rtdb, paths.updates));
      const entries = new Map<string, Uint8Array>();
      let entryStoredBytes = 0;
      const pending: Promise<void>[] = [];
      log.forEach((child) => {
        const entry = child.val() as StoredEntry | null;
        const data = entryData(entry);
        if (data === undefined) return;
        if (data === null) throw new LoadError(`Malformed log entry ${child.key}`);
        entryStoredBytes += data.length;
        const bytes = base64ToUint8Array(data);
        pending.push(
          (entry!.gz ? decompressBytes(bytes) : Promise.resolve(bytes)).then((b) => {
            entries.set(child.key!, b);
          })
        );
      });
      await Promise.all(pending);

      const after = readMeta(await get(ref(rtdb, paths.meta)));
      if (after.generation !== meta.generation) return null;

      return {
        generation: meta.generation,
        snapshotKey: meta.snapshot,
        snapshot,
        snapshotStoredBytes,
        entries,
        entryStoredBytes,
      };
    } catch (error) {
      if (error instanceof LoadError) throw error;
      throw new LoadError("Failed to read the document from Firebase", { cause: error });
    }
  }

  shouldMerge(): boolean {
    const base = this.base;
    if (!base || base.entries.size === 0) return false;
    const threshold = Math.max(
      MERGE_MIN_LOG_BYTES,
      Math.min(MERGE_MAX_LOG_BYTES, base.snapshotStoredBytes / 2)
    );
    return base.entryStoredBytes > threshold;
  }

  merge(): Promise<boolean> {
    if (!this.merging) {
      this.merging = this.doMerge().finally(() => {
        this.merging = null;
      });
    }
    return this.merging;
  }

  private async doMerge(): Promise<boolean> {
    const base = this.base;
    if (!base || base.entries.size === 0) return false;
    const { rtdb, paths, peerId, logger } = this.opts;
    const metaRef = ref(rtdb, paths.meta);
    const now = () => Date.now() + this.serverOffset;
    await this.refreshServerOffset();

    const leased = await runTransaction(metaRef, (current) => {
      if (current === null && base.generation !== 0) return null;
      const meta = readMetaValue(current);
      if (meta.generation !== base.generation) return undefined;
      if (meta.lease && meta.lease.holder !== peerId && meta.lease.until > now()) return undefined;
      return { ...meta, lease: { holder: peerId, until: now() + MERGE_LEASE_MS } };
    });
    if (!leased.committed || readMeta(leased.snapshot).lease?.holder !== peerId) return false;

    // Store the smaller of the merged updates and the re-encoded state (no deleted content).
    const merged = Y.mergeUpdates([
      ...(base.snapshot ? [base.snapshot] : []),
      ...base.entries.values(),
    ]);
    const scratch = new Y.Doc();
    Y.applyUpdate(scratch, merged);
    const reencoded = Y.encodeStateAsUpdate(scratch);
    scratch.destroy();
    const snapshot = reencoded.length < merged.length ? reencoded : merged;
    const compressed = (await compressBytes(snapshot)) ?? snapshot;
    if (compressed === snapshot) {
      throw new Error("Merging requires CompressionStream support");
    }
    const encoded = uint8ArrayToBase64(compressed);
    const parts = splitString(encoded, STORED_PART_CHARS);
    const newGeneration = base.generation + 1;
    // Unique per attempt, so a client that loses the race can't overwrite the winner's parts.
    const snapshotKey = `${newGeneration}-${crypto.randomUUID().slice(0, 8)}`;

    const snapshotRef = ref(rtdb, `${paths.snapshots}/${snapshotKey}`);
    try {
      if (encoded.length <= STORED_PART_CHARS) {
        await set(snapshotRef, parts);
      } else {
        for (let i = 0; i < parts.length; i++) {
          await set(ref(rtdb, `${paths.snapshots}/${snapshotKey}/${i}`), parts[i]);
        }
      }
      const committed = await runTransaction(metaRef, (current) => {
        // An empty local cache isn't the server's value; returning null makes Firebase check.
        if (current === null) return null;
        const meta = readMetaValue(current);
        if (meta.generation !== base.generation || meta.lease?.holder !== peerId) return undefined;
        const next: DocumentMeta = {
          generation: newGeneration,
          snapshot: snapshotKey,
          parts: parts.length,
          bytes: encoded.length,
          lease: null,
        };
        return next;
      });
      const result = readMeta(committed.snapshot);
      if (!committed.committed || result.snapshot !== snapshotKey) {
        await remove(snapshotRef);
        return false;
      }
    } catch (error) {
      remove(snapshotRef).catch(() => {});
      throw error;
    }

    // Delete exactly the keys read; entries written since are kept.
    const cleanup: Record<string, null> = {};
    base.entries.forEach((_bytes, key) => (cleanup[key] = null));
    await update(ref(rtdb, paths.updates), cleanup).catch((error) =>
      logger.warn("Merged, but failed to delete merged log entries:", error)
    );
    if (base.snapshotKey) {
      await remove(ref(rtdb, `${paths.snapshots}/${base.snapshotKey}`)).catch((error) =>
        logger.warn("Merged, but failed to delete the old snapshot:", error)
      );
    }

    this.base = {
      generation: newGeneration,
      snapshotKey,
      snapshot,
      snapshotStoredBytes: encoded.length,
      entries: new Map(),
      entryStoredBytes: 0,
    };
    logger.debug(
      `Merged ${base.entries.size} log entries into snapshot generation ${newGeneration}`
    );
    this.opts.onMerged?.(newGeneration);
    return true;
  }

  private serverOffset = 0;
  private refreshServerOffset(): Promise<void> {
    // get() doesn't support .info paths.
    return new Promise((resolve) => {
      let unsubscribe = () => {};
      const timer = setTimeout(() => {
        unsubscribe();
        resolve(); // fall back to the local clock
      }, 1000);
      unsubscribe = onValue(ref(this.opts.rtdb, ".info/serverTimeOffset"), (snapshot) => {
        if (typeof snapshot.val() === "number") this.serverOffset = snapshot.val();
        clearTimeout(timer);
        unsubscribe();
        resolve();
      });
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.opts.ydoc.on("update", this.onUpdate);
  }

  stop(): void {
    this.running = false;
    this.opts.ydoc.off("update", this.onUpdate);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.debounceTimer = this.retryTimer = null;
    this.rescueTimers.forEach((timer) => clearTimeout(timer));
    this.rescueTimers.clear();
  }

  flush(): Promise<void> {
    if (!this.hasUnsavedChanges()) return Promise.resolve();
    const done = new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.writeNext();
    return done;
  }

  notePersisted(clientId: number, clock: number): void {
    if (clock > (this.persistedClocks.get(clientId) ?? 0)) {
      this.persistedClocks.set(clientId, clock);
    }
  }

  // Several peers may rescue the same edits; duplicates are harmless.
  rescue(clientIds: Iterable<number>): void {
    const ids = Array.from(clientIds).filter((id) => id !== this.opts.ydoc.clientID);
    if (ids.length === 0 || !this.running) return;
    // Jitter, so most peers see someone else's rescue first.
    const timer = setTimeout(() => {
      this.rescueTimers.delete(timer);
      if (this.running) this.writeRescue(ids);
    }, Math.random() * RESCUE_JITTER_MS);
    this.rescueTimers.add(timer);
  }

  private writeRescue(clientIds: number[]): void {
    const ours = Y.decodeStateVector(Y.encodeStateVector(this.opts.ydoc));
    const target = new Map(ours);
    let missing = false;
    for (const id of clientIds) {
      const have = ours.get(id) ?? 0;
      const saved = this.persistedClocks.get(id) ?? 0;
      if (have > saved) {
        target.set(id, saved);
        missing = true;
      }
    }
    if (!missing) return;

    const update = Y.encodeStateAsUpdate(this.opts.ydoc, encodeStateVector(target));
    this.opts.logger.debug(
      `Saving ${update.length} bytes of edits from departed clients ${clientIds.join(", ")}`
    );
    this.writeEntry(update)
      .then(() => {
        for (const id of clientIds) {
          const clock = ours.get(id) ?? 0;
          this.notePersisted(id, clock);
          this.opts.onPersisted?.(id, clock);
        }
      })
      .catch((error) => {
        this.opts.logger.warn("Failed to save a departed peer's edits:", error);
      });
  }

  private onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === FIREBASE_ORIGIN || this.opts.isRemoteOrigin(origin)) return;
    this.queue.push(update);
    if (!this.inFlight) this.setState("unsaved");
    if (!this.debounceTimer && !this.retryTimer) {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.writeNext();
      }, this.opts.debounceMs);
    }
  };

  private async writeNext(): Promise<void> {
    if (this.inFlight || this.queue.length === 0) return;

    const batch = this.queue.splice(0);
    this.inFlight = batch;
    // Everything we've authored is in this batch or already saved.
    const ownClock =
      Y.decodeStateVector(Y.encodeStateVector(this.opts.ydoc)).get(
        this.opts.ydoc.clientID
      ) ?? 0;
    this.setState("saving");

    try {
      const update = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch);
      await this.writeEntry(update);
    } catch (error) {
      this.queue.unshift(...batch);
      this.inFlight = null;
      const err = error instanceof Error ? error : new Error(String(error));
      this.setState("error");
      this.opts.logger.warn("Failed to save edits:", err);
      this.opts.onError?.(err);
      this.waiters.splice(0).forEach((w) => w.reject(err));
      this.scheduleRetry();
      return;
    }

    this.inFlight = null;
    this.retryAttempt = 0;
    this.notePersisted(this.opts.ydoc.clientID, ownClock);
    this.opts.onPersisted?.(this.opts.ydoc.clientID, ownClock);

    if (this.queue.length > 0) {
      this.writeNext();
    } else {
      this.setState("saved");
      this.waiters.splice(0).forEach((w) => w.resolve());
    }
  }

  private async writeEntry(update: Uint8Array): Promise<void> {
    const { rtdb, paths, peerId } = this.opts;
    let bytes = update;
    let gz = false;
    if (update.length >= LOG_ENTRY_GZIP_MIN_BYTES) {
      const compressed = await compressBytes(update);
      if (compressed && compressed.length < update.length) {
        bytes = compressed;
        gz = true;
      }
    }
    const data = uint8ArrayToBase64(bytes);
    const entryRef = push(ref(rtdb, paths.updates));
    const header = { by: peerId, ...(gz ? { gz: 1 as const } : {}) };

    if (data.length <= STORED_PART_CHARS) {
      await set(entryRef, { ...header, data });
      return;
    }
    // Readers skip the entry until the part count is written.
    const parts = splitString(data, STORED_PART_CHARS);
    await set(entryRef, { ...header, p: { 0: parts[0] } });
    for (let i = 1; i < parts.length; i++) {
      await set(ref(rtdb, `${paths.updates}/${entryRef.key}/p/${i}`), parts[i]);
    }
    await set(ref(rtdb, `${paths.updates}/${entryRef.key}/n`), parts.length);
  }

  private scheduleRetry(): void {
    if (!this.running || this.retryTimer) return;
    this.retryAttempt++;
    const delay = Math.min(
      PERSIST_RETRY_MAX_MS,
      PERSIST_RETRY_BASE_MS * 2 ** (this.retryAttempt - 1)
    );
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.writeNext();
    }, delay);
  }

  private setState(state: SaveState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onStateChange?.(state);
  }
}

function readMeta(snapshot: DataSnapshot): DocumentMeta {
  return readMetaValue(snapshot.exists() ? snapshot.val() : null);
}

function readMetaValue(value: unknown): DocumentMeta {
  const v = (value ?? {}) as Partial<DocumentMeta>;
  return {
    generation: typeof v.generation === "number" ? v.generation : 0,
    snapshot: typeof v.snapshot === "string" ? v.snapshot : null,
    parts: typeof v.parts === "number" ? v.parts : 0,
    bytes: typeof v.bytes === "number" ? v.bytes : 0,
    lease: v.lease ?? null,
  };
}

// Firebase returns small integer-keyed objects as arrays.
function partsOf(value: unknown): string[] | null {
  const values = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? Object.keys(value)
          .sort((a, b) => Number(a) - Number(b))
          .map((k) => (value as Record<string, unknown>)[k])
      : null;
  if (!values || !values.every((p) => typeof p === "string")) return null;
  return values as string[];
}

/** undefined while a large entry is incomplete, null if malformed. */
function entryData(entry: StoredEntry | null): string | null | undefined {
  if (!entry) return null;
  if (typeof entry.data === "string") return entry.data;
  if (entry.p !== undefined) {
    if (typeof entry.n !== "number") return undefined;
    const parts = partsOf(entry.p);
    if (!parts || parts.length < entry.n) return undefined;
    return parts.slice(0, entry.n).join("");
  }
  return null;
}

function splitString(value: string, size: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < value.length; i += size) parts.push(value.slice(i, i + size));
  return parts.length > 0 ? parts : [""];
}

function encodeStateVector(stateVector: Map<number, number>): Uint8Array {
  const bytes: number[] = [];
  const writeVarUint = (value: number) => {
    while (value > 0x7f) {
      bytes.push(0x80 | (value & 0x7f));
      value = Math.floor(value / 128);
    }
    bytes.push(value);
  };
  writeVarUint(stateVector.size);
  stateVector.forEach((clock, client) => {
    writeVarUint(client);
    writeVarUint(clock);
  });
  return new Uint8Array(bytes);
}
