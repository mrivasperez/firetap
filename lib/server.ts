import * as Y from "yjs";
import { DocumentStore } from "./firebase/document-store";
import { adminBackend, type AdminDatabase } from "./firebase/admin-backend";
import { buildDatabasePaths, type DatabasePathsConfig } from "./utils/config";
import { resolveLogger, type Logger } from "./utils/logger";
import { randomId } from "./utils/id";

export { LoadError } from "./firebase/document-store";
export type { AdminDatabase } from "./firebase/admin-backend";
export type { DatabasePathsConfig } from "./utils/config";
export type { Logger } from "./utils/logger";

export type ServerDocumentOptions = {
  docId: string;
  /** The Realtime Database from firebase-admin's `getDatabase()`. */
  database: AdminDatabase;
  databasePaths?: DatabasePathsConfig;
  /** Stored as the author of the edits, in each log entry's `by` field. */
  authorId?: string;
  /** Shown as the presence entry's name while saving (default "Server"). */
  authorName?: string;
  logger?: Partial<Logger>;
};

function openStore(options: ServerDocumentOptions, ydoc: Y.Doc) {
  const logger = resolveLogger(options.logger);
  const db = adminBackend(options.database);
  const paths = buildDatabasePaths(options.databasePaths, options.docId);
  const authorId = options.authorId ?? `server-${randomId()}`;
  return {
    logger,
    presencePath: `${paths.rooms}/peers/${authorId}`,
    db,
    authorName: options.authorName ?? "Server",
    store: new DocumentStore({
      db,
      paths,
      ydoc,
      peerId: authorId,
      logger,
      isRemoteOrigin: () => false,
    }),
  };
}

/** Reads a document. Rejects with LoadError if it can't be read. */
export async function loadDocument(options: ServerDocumentOptions): Promise<Y.Doc> {
  const ydoc = new Y.Doc();
  try {
    await openStore(options, ydoc).store.load();
  } catch (error) {
    ydoc.destroy();
    throw error;
  }
  return ydoc;
}

/**
 * Loads a document, runs `change` on it, and saves the edits `change` made.
 * A document that doesn't exist yet starts out empty. Resolves with the updated
 * document once Firebase has acknowledged the edits.
 */
export async function updateDocument(
  options: ServerDocumentOptions,
  change: (ydoc: Y.Doc) => void | Promise<void>
): Promise<Y.Doc> {
  const ydoc = new Y.Doc();
  const { store, logger, db, presencePath, authorName } = openStore(options, ydoc);
  let announced = false;
  try {
    await store.load();
    store.start();
    await change(ydoc);
    if (store.hasUnsavedChanges()) {
      // Open clients only read the log while someone present is unreachable,
      // so being present makes them pick up these edits now.
      await db.removeOnDisconnect(presencePath);
      await db.set(presencePath, {
        name: authorName,
        connectedAt: { ".sv": "timestamp" },
        rtc: false,
        server: true,
      });
      announced = true;
      await store.flush();
    }
    // The log is already downloaded, so merging it costs no extra download.
    if (store.shouldMerge()) {
      await store.merge().catch((error) => logger.warn("Failed to merge the log:", error));
    }
  } catch (error) {
    ydoc.destroy();
    throw error;
  } finally {
    store.stop();
    if (announced) {
      await db.remove(presencePath).catch((error) =>
        logger.warn("Failed to remove the server's presence:", error)
      );
    }
  }
  return ydoc;
}
