import type { Database } from "firebase/database";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { DatabasePathsConfig, ConnectionState } from "../utils/config";
import type { Logger } from "../utils/logger";
import type { SaveState } from "../firebase/document-store";

export type AdapterOptions = {
  docId: string;
  firebaseDatabase: Database;
  peerId?: string;
  user?: { name?: string };
  // Local edits are batched for this long before being written (default 1000ms).
  persistDebounceMs?: number;
  // Direct WebRTC links per peer (default 6); larger rooms relay through peers.
  maxDirectPeers?: number;
  databasePaths?: DatabasePathsConfig;
  // "auto" (default): when no peer is reachable, receive edits from Firebase instead.
  firebaseFallback?: "auto" | "off";
  logger?: Partial<Logger>;
};

export type AdapterEvents = {
  "connection-state-changed": { state: ConnectionState };
  "peer-joined": { peerId: string; user: PeerInfo };
  "peer-left": { peerId: string };
  "document-persisted": { docId: string; version: number };
  "save-state-changed": { state: SaveState };
  // Retried automatically; saveState stays "error" until a write succeeds.
  "persist-error": { error: Error };
  error: { error: Error; context: string };
  // The first sync with a newly connected peer finished.
  "sync-completed": { docId: string; peerId: string; updateSize: number };
};

export type AdapterHandle = {
  ydoc: Y.Doc;
  awareness: Awareness;
  /** Saves pending edits (waiting up to 5s), then leaves. */
  disconnect: () => Promise<void>;
  reconnect: () => Promise<void>;
  getPeerCount: () => number;
  getConnectionStatus: () => ConnectionState;
  getUserInfo: () => PeerInfo;
  /** Resolves once Firebase has acknowledged every pending edit. */
  flush: () => Promise<void>;
  hasUnsavedChanges: () => boolean;
  getSaveState: () => SaveState;
  on: <K extends keyof AdapterEvents>(
    event: K,
    callback: (data: AdapterEvents[K]) => void
  ) => void;
  off: <K extends keyof AdapterEvents>(
    event: K,
    callback: (data: AdapterEvents[K]) => void
  ) => void;
};

export type PeerInfo = {
  id: string;
  name: string;
  connectedAt: number;
};

export type PresenceEntry = {
  name: string;
  connectedAt: number | object; // server timestamp
};

export type SignalData = {
  type: "offer" | "answer";
  sdp?: string;
  sdpGz?: string;
  from: string;
  // Lets the initiator ignore a late answer to an offer it has replaced.
  connectionId: string;
};
