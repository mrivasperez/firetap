import * as Y from "yjs";
import type { Database } from "firebase/database";
import { get, push, ref, set } from "firebase/database";
import { base64ToUint8Array, uint8ArrayToBase64 } from "../utils/base64";
import { defaultLogger, type Logger } from "../utils/logger";
import {
  DEFAULT_PERSIST_DEBOUNCE_MS,
  PERSIST_RETRY_BASE_MS,
  PERSIST_RETRY_MAX_MS,
  RESCUE_JITTER_MS,
} from "../utils/constants";

// {updates}/{pushKey} = { data, by }. Each client appends only its own edits.

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

export type LogEntry = { data: string; by: string };

export type DocumentStoreOptions = {
  rtdb: Database;
  updatesPath: string;
  ydoc: Y.Doc;
  peerId: string;
  debounceMs?: number;
  logger?: Logger;
  isRemoteOrigin: (origin: unknown) => boolean;
  onStateChange?: (state: SaveState) => void;
  onError?: (error: Error) => void;
  onPersisted?: (clientId: number, clock: number) => void;
};

type Waiter = { resolve: () => void; reject: (error: Error) => void };

export class DocumentStore {
  private readonly opts: Required<
    Pick<DocumentStoreOptions, "debounceMs" | "logger">
  > &
    DocumentStoreOptions;
  private queue: Uint8Array[] = [];
  private inFlight: Uint8Array[] | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private waiters: Waiter[] = [];
  private state: SaveState = "saved";
  private running = false;

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

  hasUnsavedChanges(): boolean {
    return this.queue.length > 0 || this.inFlight !== null;
  }

  async load(): Promise<void> {
    let snapshot;
    try {
      snapshot = await get(ref(this.opts.rtdb, this.opts.updatesPath));
    } catch (error) {
      throw new LoadError("Failed to read the document from Firebase", { cause: error });
    }
    if (!snapshot.exists()) return;

    const updates: Uint8Array[] = [];
    snapshot.forEach((child) => {
      const entry = child.val() as Partial<LogEntry> | null;
      if (typeof entry?.data !== "string") {
        throw new LoadError(`Malformed log entry ${child.key}`);
      }
      try {
        updates.push(base64ToUint8Array(entry.data));
      } catch (error) {
        throw new LoadError(`Malformed log entry ${child.key}`, { cause: error });
      }
    });

    try {
      Y.applyUpdate(this.opts.ydoc, Y.mergeUpdates(updates), FIREBASE_ORIGIN);
    } catch (error) {
      throw new LoadError("The stored document could not be decoded", { cause: error });
    }
    // Everything just loaded is saved.
    Y.decodeStateVector(Y.encodeStateVector(this.opts.ydoc)).forEach((clock, client) =>
      this.notePersisted(client, clock)
    );
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

  private writeEntry(update: Uint8Array): Promise<void> {
    const entry: LogEntry = { data: uint8ArrayToBase64(update), by: this.opts.peerId };
    return set(push(ref(this.opts.rtdb, this.opts.updatesPath)), entry);
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
