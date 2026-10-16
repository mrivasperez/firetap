import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { encodeAwarenessUpdate } from "y-protocols/awareness";
import { SimplePeerManager, RemoteOrigin } from "./core/peer-manager";
import { DocumentStore } from "./firebase/document-store";
import type {
  AdapterOptions,
  AdapterEvents,
  AdapterHandle,
  PeerInfo,
} from "./core/types";
import {
  DEFAULT_MAX_DIRECT_PEERS,
  DISCONNECT_FLUSH_TIMEOUT_MS,
  PEER_ID_DISPLAY_LENGTH,
  AWARENESS_THROTTLE_MS,
} from "./utils/constants";
import { resolveLogger } from "./utils/logger";
import { buildDatabasePaths, validateDocId } from "./utils/config";

export async function createFirebaseYWebrtcAdapter(
  opts: AdapterOptions
): Promise<AdapterHandle> {
  const {
    docId,
    firebaseDatabase,
    peerId = crypto.randomUUID(),
    user = {},
    persistDebounceMs,
    maxDirectPeers = DEFAULT_MAX_DIRECT_PEERS,
    databasePaths,
    firebaseFallback = "auto",
    logger: loggerOption,
  } = opts;
  const logger = resolveLogger(loggerOption);
  validateDocId(docId);
  const paths = buildDatabasePaths(databasePaths, docId);

  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);

  const peerInfo: PeerInfo = {
    id: peerId,
    name: user.name || `User-${peerId.slice(0, PEER_ID_DISPLAY_LENGTH)}`,
    connectedAt: Date.now(),
  };

  const store: { current: DocumentStore | null } = { current: null };
  const peerManager = new SimplePeerManager({
    docId,
    peer: peerInfo,
    ydoc,
    awareness,
    rtdb: firebaseDatabase,
    databasePaths,
    maxDirectPeers,
    logger,
    // On mobile, hidden is often the last chance to save.
    onPageHidden: () => {
      store.current?.flush().catch(() => {});
    },
    onPersisted: (clientId, clock) => store.current?.notePersisted(clientId, clock),
    onPeerGone: (clientIds) => store.current?.rescue(clientIds),
    onIsolationChange: (isolated) => {
      if (firebaseFallback === "off") return;
      if (isolated) {
        store.current?.startLogListener().catch((error) =>
          logger.warn("Failed to listen for edits in Firebase:", error)
        );
      } else {
        store.current?.stopLogListener();
      }
    },
  });

  const documentStore = new DocumentStore({
    rtdb: firebaseDatabase,
    paths,
    ydoc,
    peerId,
    debounceMs: persistDebounceMs,
    logger,
    isRemoteOrigin: (origin) => origin instanceof RemoteOrigin,
    onStateChange: (state) => peerManager.emit("save-state-changed", { state }),
    onError: (error) => peerManager.emit("persist-error", { error }),
    onPersisted: (clientId, clock) => peerManager.broadcastPersisted(clientId, clock),
    onMerged: (generation) =>
      peerManager.emit("document-persisted", { docId, version: generation }),
  });
  try {
    await documentStore.load();
  } catch (error) {
    awareness.destroy();
    ydoc.destroy();
    throw error;
  }
  store.current = documentStore;
  documentStore.start();

  // The log is already in memory, so merging now costs no extra download.
  if (documentStore.shouldMerge()) {
    documentStore.merge().catch((error) => logger.warn("Failed to merge the log:", error));
  }

  let updateBatchTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingUpdates: Uint8Array[] = [];
  const UPDATE_BATCH_MS = 50;

  const flushPeerUpdates = () => {
    if (updateBatchTimer) clearTimeout(updateBatchTimer);
    updateBatchTimer = null;
    if (pendingUpdates.length === 0) return;
    peerManager.broadcastUpdate(
      pendingUpdates.length === 1 ? pendingUpdates[0] : Y.mergeUpdates(pendingUpdates)
    );
    pendingUpdates = [];
  };

  ydoc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin instanceof RemoteOrigin) return;
    pendingUpdates.push(update);
    if (updateBatchTimer) clearTimeout(updateBatchTimer);
    updateBatchTimer = setTimeout(flushPeerUpdates, UPDATE_BATCH_MS);
  });

  let awarenessBatchTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingAwarenessChanges = new Set<number>();

  awareness.on(
    "update",
    (
      {
        added,
        updated,
        removed,
      }: {
        added: number[];
        updated: number[];
        removed: number[];
      },
      origin: unknown
    ) => {
      // Peers relay remote changes; removing a departed peer's cursors stays local.
      if (origin !== "local") return;
      added.concat(updated, removed).forEach((id) => pendingAwarenessChanges.add(id));

      if (awarenessBatchTimer) clearTimeout(awarenessBatchTimer);
      awarenessBatchTimer = setTimeout(() => {
        if (pendingAwarenessChanges.size > 0) {
          peerManager.broadcastAwareness(
            encodeAwarenessUpdate(awareness, Array.from(pendingAwarenessChanges))
          );
          pendingAwarenessChanges.clear();
        }
        awarenessBatchTimer = null;
      }, AWARENESS_THROTTLE_MS);
    }
  );

  awareness.setLocalStateField("user", {
    name: peerInfo.name,
    id: peerId,
  });
  // Apps (and TipTap's caret extension) replace the user field, so keep the peer id apart.
  awareness.setLocalStateField("firetap", { peerId });

  await peerManager.start();

  let disconnecting: Promise<void> | null = null;
  const disconnect = () => {
    if (disconnecting) return disconnecting;
    disconnecting = (async () => {
      flushPeerUpdates();
      if (awarenessBatchTimer) clearTimeout(awarenessBatchTimer);
      awarenessBatchTimer = null;

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const saved = await Promise.race([
        documentStore.flush().then(
          () => true,
          () => false
        ),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), DISCONNECT_FLUSH_TIMEOUT_MS);
        }),
      ]);
      clearTimeout(timeout);
      if (!saved && documentStore.hasUnsavedChanges()) {
        logger.warn("Disconnected with unsaved edits; they could not be written to Firebase");
      }

      documentStore.stop();
      try {
        peerManager.destroy();
      } catch (e) {
        logger.warn("PeerManager destroy error:", e);
      }
      awareness.destroy();
      ydoc.destroy();
    })();
    return disconnecting;
  };

  return {
    ydoc,
    awareness,
    disconnect,
    reconnect: () => peerManager.reconnect(),
    getPeerCount: () => peerManager.getPeerCount(),
    getConnectionStatus: () => peerManager.getConnectionStatus(),
    getUserInfo: () => peerInfo,
    flush: () => documentStore.flush(),
    hasUnsavedChanges: () => documentStore.hasUnsavedChanges(),
    getSaveState: () => documentStore.saveState,
    on: <K extends keyof AdapterEvents>(
      event: K,
      callback: (data: AdapterEvents[K]) => void
    ) => peerManager.on(event, callback),
    off: <K extends keyof AdapterEvents>(
      event: K,
      callback: (data: AdapterEvents[K]) => void
    ) => peerManager.off(event, callback),
  };
}

export default createFirebaseYWebrtcAdapter;
