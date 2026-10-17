import * as Y from "yjs";
import type { DatabaseBackend } from "./backend";
import { base64ToUint8Array, uint8ArrayToBase64 } from "../utils/base64";
import { compressBytes, decompressBytes } from "../utils/compression";
import { defaultLogger, type Logger } from "../utils/logger";
import type { SnapshotCache } from "../utils/snapshot-cache";
import { randomId } from "../utils/id";
import {
  DEFAULT_PERSIST_DEBOUNCE_MS,
  LOAD_MAX_ATTEMPTS,
  LOG_ENTRY_GZIP_MIN_BYTES,
  MERGE_LEASE_MS,
  MERGE_MAX_LOG_BYTES,
  MERGE_MIN_LOG_BYTES,
  MERGE_SETTLE_MS,
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
  db: DatabaseBackend;
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
  onGenerationChange?: (generation: number) => void;
  cache?: SnapshotCache | null;
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

  private logGrowth = 0;
  private mergeTimer: ReturnType<typeof setTimeout> | null = null;
  private inSessionMergeDisabled = false;
  private usedCache = false;
  private cacheDisabled = false;
  private knownKeys = new Set<string>();
  private latestKey: string | null = null;
  private stopListening: (() => void) | null = null;

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

  async fetchMeta(): Promise<DocumentMeta> {
    try {
      return readMeta(await this.opts.db.get(this.opts.paths.meta));
    } catch (error) {
      throw new LoadError("Failed to read the document from Firebase", { cause: error });
    }
  }

  /** Pass the snapshot generation peers have already synced to us to skip downloading it. */
  async load({ haveGeneration }: { haveGeneration?: number } = {}): Promise<void> {
    try {
      await this.loadOnce(haveGeneration);
    } catch (error) {
      if (!(error instanceof LoadError) || !this.usedCache) throw error;
      this.opts.logger.warn("The cached snapshot was unreadable; downloading it instead");
      await this.opts.cache?.delete();
      this.cacheDisabled = true;
      await this.loadOnce(haveGeneration);
    }
  }

  async hasCachedSnapshot(meta: DocumentMeta): Promise<boolean> {
    return (await this.cachedSnapshot(meta)) !== null;
  }

  private async loadOnce(haveGeneration?: number): Promise<void> {
    let base: Base | null = null;
    for (let attempt = 1; !base; attempt++) {
      base = await this.readBase(attempt === 1 ? haveGeneration : undefined);
      if (!base && attempt >= LOAD_MAX_ATTEMPTS) {
        throw new LoadError("The document kept changing while loading; try again");
      }
    }

    const updates = [...(base.snapshot ? [base.snapshot] : []), ...base.entries.values()];
    if (updates.length > 0) {
      let stored: Uint8Array;
      try {
        stored = Y.mergeUpdates(updates);
        Y.applyUpdate(this.opts.ydoc, stored, FIREBASE_ORIGIN);
      } catch (error) {
        throw new LoadError("The stored document could not be decoded", { cause: error });
      }
      // Only what was read from Firebase counts as saved, not what peers sent.
      Y.decodeStateVector(Y.encodeStateVectorFromUpdate(stored)).forEach((clock, client) =>
        this.notePersisted(client, clock)
      );
    }
    this.setBase(base);
    base.entries.forEach((_bytes, key) => this.rememberKey(key));
  }

  // Null if a merge landed mid-read: the snapshot may not cover entries it deleted.
  private async readBase(haveGeneration?: number): Promise<Base | null> {
    const { db, paths } = this.opts;
    try {
      const meta = readMeta(await db.get(paths.meta));
      let snapshot: Uint8Array | null = null;
      let snapshotStoredBytes = meta.bytes;
      if (meta.snapshot && meta.generation !== haveGeneration) {
        snapshot = await this.snapshotFor(meta);
        if (!snapshot) return null;
      }

      const { entries, entryStoredBytes } = await this.readLog();

      const after = readMeta(await db.get(paths.meta));
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

  private async readLog(): Promise<{ entries: Map<string, Uint8Array>; entryStoredBytes: number }> {
    const log = (await this.opts.db.get(this.opts.paths.updates)) as Record<string, unknown> | null;
    const entries = new Map<string, Uint8Array>();
    let entryStoredBytes = 0;
    const pending: Promise<void>[] = [];
    for (const [key, value] of Object.entries(log ?? {})) {
      const entry = value as StoredEntry | null;
      const data = entryData(entry);
      if (data === undefined) continue;
      if (data === null) throw new LoadError(`Malformed log entry ${key}`);
      entryStoredBytes += data.length;
      const bytes = base64ToUint8Array(data);
      pending.push(
        (entry!.gz ? decompressBytes(bytes) : Promise.resolve(bytes)).then((b) => {
          entries.set(key, b);
        })
      );
    }
    await Promise.all(pending);
    return { entries, entryStoredBytes };
  }

  private mergeThreshold(base: Base): number {
    // Every load downloads the whole log while a merge downloads it once, so merge early.
    return Math.max(MERGE_MIN_LOG_BYTES, Math.min(MERGE_MAX_LOG_BYTES, base.snapshotStoredBytes / 4));
  }

  shouldMerge(): boolean {
    const base = this.base;
    if (!base || base.entries.size === 0) return false;
    return base.entryStoredBytes > this.mergeThreshold(base);
  }

  /** Pass refreshLog to merge everything in the log now, not just what was loaded. */
  merge({ refreshLog = false }: { refreshLog?: boolean } = {}): Promise<boolean> {
    if (!this.merging) {
      this.merging = this.doMerge(refreshLog).finally(() => {
        this.merging = null;
      });
    }
    return this.merging;
  }

  /** Null if that snapshot is gone, i.e. a merge replaced it. */
  private async snapshotFor(meta: DocumentMeta): Promise<Uint8Array | null> {
    const cached = await this.cachedSnapshot(meta);
    if (cached) {
      this.usedCache = true;
      this.opts.logger.debug("Loaded the snapshot from the local cache");
      return cached;
    }
    const stored = await this.opts.db.get(`${this.opts.paths.snapshots}/${meta.snapshot}`);
    const parts = stored !== null ? partsOf(stored) : null;
    if (!parts || parts.length !== meta.parts) return null;
    const snapshot = await decompressBytes(base64ToUint8Array(parts.join("")));
    this.cacheSnapshot(meta.snapshot!, meta.bytes, snapshot);
    return snapshot;
  }

  private async cachedSnapshot(meta: DocumentMeta): Promise<Uint8Array | null> {
    if (!this.opts.cache || this.cacheDisabled || !meta.snapshot) return null;
    const cached = await this.opts.cache.get();
    return cached?.snapshotKey === meta.snapshot && cached.storedBytes === meta.bytes
      ? cached.snapshot
      : null;
  }

  private cacheSnapshot(snapshotKey: string, storedBytes: number, snapshot: Uint8Array): void {
    if (this.cacheDisabled) return;
    this.opts.cache?.put({ snapshotKey, storedBytes, snapshot }).catch(() => {});
  }

  private async doMerge(refreshLog: boolean): Promise<boolean> {
    const base = this.base;
    if (!base || (!refreshLog && base.entries.size === 0)) return false;
    const { db, paths, peerId, logger } = this.opts;
    if (base.snapshotKey && !base.snapshot) {
      // Peers gave us this snapshot's content, but a merge must start from stored bytes.
      const meta = await this.fetchMeta();
      if (meta.generation !== base.generation) return false;
      base.snapshot = await this.snapshotFor(meta);
      if (!base.snapshot) return false;
    }
    const now = () => Date.now() + this.serverOffset;
    await this.refreshServerOffset();

    const leased = await db.transaction(paths.meta, (current) => {
      if (current === null && base.generation !== 0) return null;
      const meta = readMeta(current);
      if (meta.generation !== base.generation) return undefined;
      if (meta.lease && meta.lease.holder !== peerId && meta.lease.until > now()) return undefined;
      return { ...meta, lease: { holder: peerId, until: now() + MERGE_LEASE_MS } };
    });
    if (!leased.committed || readMeta(leased.value).lease?.holder !== peerId) return false;

    // Holding the lease, nobody else can delete entries while we read them.
    const entries = refreshLog ? (await this.readLog()).entries : base.entries;
    if (entries.size === 0) {
      await db.transaction(paths.meta, (current) =>
        current === null ? null : { ...readMeta(current), lease: null }
      );
      return false;
    }

    // Store the smaller of the merged updates and the re-encoded state (no deleted content).
    const merged = Y.mergeUpdates([...(base.snapshot ? [base.snapshot] : []), ...entries.values()]);
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
    const snapshotKey = `${newGeneration}-${randomId().slice(0, 8)}`;

    const snapshotPath = `${paths.snapshots}/${snapshotKey}`;
    try {
      if (encoded.length <= STORED_PART_CHARS) {
        await db.set(snapshotPath, parts);
      } else {
        for (let i = 0; i < parts.length; i++) {
          await db.set(`${snapshotPath}/${i}`, parts[i]);
        }
      }
      const committed = await db.transaction(paths.meta, (current) => {
        // An empty local cache isn't the server's value; returning null makes Firebase check.
        if (current === null) return null;
        const meta = readMeta(current);
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
      const result = readMeta(committed.value);
      if (!committed.committed || result.snapshot !== snapshotKey) {
        await db.remove(snapshotPath);
        return false;
      }
    } catch (error) {
      db.remove(snapshotPath).catch(() => {});
      throw error;
    }

    // Delete exactly the keys read; entries written since are kept.
    const cleanup: Record<string, null> = {};
    entries.forEach((_bytes, key) => (cleanup[key] = null));
    await db.update(paths.updates, cleanup).catch((error) =>
      logger.warn("Merged, but failed to delete merged log entries:", error)
    );
    if (base.snapshotKey) {
      await db.remove(`${paths.snapshots}/${base.snapshotKey}`).catch((error) =>
        logger.warn("Merged, but failed to delete the old snapshot:", error)
      );
    }

    this.cacheSnapshot(snapshotKey, encoded.length, snapshot);
    this.setBase({
      generation: newGeneration,
      snapshotKey,
      snapshot,
      snapshotStoredBytes: encoded.length,
      entries: new Map(),
      entryStoredBytes: 0,
    });
    logger.debug(
      `Merged ${entries.size} log entries into snapshot generation ${newGeneration}`
    );
    this.opts.onMerged?.(newGeneration);
    return true;
  }

  private serverOffset = 0;
  private async refreshServerOffset(): Promise<void> {
    this.serverOffset = (await this.opts.db.serverTimeOffset()) ?? this.serverOffset;
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
    if (this.mergeTimer) clearTimeout(this.mergeTimer);
    this.mergeTimer = null;
    this.stopLogListener();
  }

  get isListeningToLog(): boolean {
    return this.stopListening !== null;
  }

  // Only for clients that can't reach any peer: every client downloading every
  // edit would cost far more than syncing peer to peer.
  async startLogListener(): Promise<void> {
    const { db, paths, logger } = this.opts;
    if (this.stopListening || !this.running || !this.base || !db.watchChildren) return;
    this.stopListening = () => {};

    const meta = readMeta(await db.get(paths.meta));
    if (meta.generation !== this.base.generation) {
      // A merge may have deleted entries we never saw; they're in the new snapshot.
      const base = await this.readBase();
      if (base) {
        const updates = [...(base.snapshot ? [base.snapshot] : []), ...base.entries.values()];
        Y.applyUpdate(this.opts.ydoc, Y.mergeUpdates(updates), FIREBASE_ORIGIN);
        this.setBase(base);
        base.entries.forEach((_bytes, key) => this.rememberKey(key));
      }
    }
    if (!this.running || !this.stopListening) return;

    this.stopListening = db.watchChildren(paths.updates, this.latestKey, (key, value) => {
      this.applyLogEntry(key, value).catch((error) =>
        logger.warn(`Failed to apply log entry ${key}:`, error)
      );
    });
    logger.debug("No peer is reachable; receiving edits from Firebase");
  }

  stopLogListener(): void {
    if (!this.stopListening) return;
    this.stopListening();
    this.stopListening = null;
    this.opts.logger.debug("Stopped receiving edits from Firebase");
  }

  private async applyLogEntry(key: string, value: unknown): Promise<void> {
    if (this.knownKeys.has(key)) return;
    const entry = value as StoredEntry | null;
    const data = entryData(entry);
    if (data === undefined) return;
    if (data === null) throw new Error("malformed entry");
    this.rememberKey(key);
    if (entry!.by === this.opts.peerId) return;
    const stored = base64ToUint8Array(data);
    const update = entry!.gz ? await decompressBytes(stored) : stored;
    Y.applyUpdate(this.opts.ydoc, update, FIREBASE_ORIGIN);
    if (this.base) {
      this.base.entries.set(key, update);
      this.base.entryStoredBytes += data.length;
    }
  }

  // Every edit, from anyone, ends up in the log, so the edits we see estimate its growth.
  private maybeScheduleMerge(): void {
    const base = this.base;
    if (!this.running || this.mergeTimer || this.inSessionMergeDisabled || !base) return;
    const estimatedLog = base.entryStoredBytes + (this.logGrowth * 4) / 3;
    if (estimatedLog <= this.mergeThreshold(base)) return;
    this.mergeTimer = setTimeout(() => {
      this.mergeTimer = null;
      const current = this.base;
      // Downloading a newer snapshot just to merge would cost more than it saves.
      if (!current || (current.snapshotKey && !current.snapshot)) {
        this.inSessionMergeDisabled = true;
        return;
      }
      this.merge({ refreshLog: true })
        .then((merged) => {
          if (!merged) this.inSessionMergeDisabled = true;
        })
        .catch((error) => {
          this.inSessionMergeDisabled = true;
          this.opts.logger.warn("Failed to merge the log:", error);
        });
    }, MERGE_SETTLE_MS);
  }

  private setBase(base: Base): void {
    const changed = base.generation !== this.base?.generation;
    this.logGrowth = 0;
    this.base = base;
    if (changed) this.opts.onGenerationChange?.(base.generation);
  }

  private rememberKey(key: string): void {
    this.knownKeys.add(key);
    if (!this.latestKey || key > this.latestKey) this.latestKey = key;
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
    this.logGrowth += update.length;
    this.maybeScheduleMerge();
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
    const { db, paths, peerId } = this.opts;
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
    const key = db.newKey(paths.updates);
    this.rememberKey(key);
    const entryPath = `${paths.updates}/${key}`;
    const header = { by: peerId, ...(gz ? { gz: 1 as const } : {}) };

    if (data.length <= STORED_PART_CHARS) {
      await db.set(entryPath, { ...header, data });
      return;
    }
    // Readers skip the entry until the part count is written.
    const parts = splitString(data, STORED_PART_CHARS);
    await db.set(entryPath, { ...header, p: { 0: parts[0] } });
    for (let i = 1; i < parts.length; i++) {
      await db.set(`${entryPath}/p/${i}`, parts[i]);
    }
    await db.set(`${entryPath}/n`, parts.length);
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

function readMeta(value: unknown): DocumentMeta {
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
