import type { Database } from "firebase/database";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { DatabasePathsConfig, ConnectionState } from "../utils/config";
import type { Logger } from "../utils/logger";

export type AdapterOptions = {
  docId: string;
  firebaseDatabase: Database;
  peerId?: string;
  user?: { name?: string };
  syncIntervalMs?: number;
  maxDirectPeers?: number;
  databasePaths?: DatabasePathsConfig;
  logger?: Partial<Logger>;
};

export type AdapterEvents = {
  "connection-state-changed": { state: ConnectionState };
  "peer-joined": { peerId: string; user: PeerInfo };
  "peer-left": { peerId: string };
  "document-persisted": { docId: string; version: number };
  error: { error: Error; context: string };
  "sync-completed": { docId: string; updateSize: number };
};

export type AdapterHandle = {
  ydoc: Y.Doc;
  awareness: Awareness;
  disconnect: () => void;
  reconnect: () => Promise<void>;
  getPeerCount: () => number;
  getConnectionStatus: () => ConnectionState;
  getUserInfo: () => PeerInfo;
  forcePersist: () => Promise<void>;
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
