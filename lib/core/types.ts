import type { Database } from "firebase/database";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { PeerInfo } from "../firebase/presence";
import type { DatabasePathsConfig, ConnectionState } from "../utils/config";

export type AdapterOptions = {
  docId: string;
  // Firebase database instance (required for dependency injection)
  firebaseDatabase: Database;
  peerId?: string;
  user?: { name?: string };
  syncIntervalMs?: number;
  maxDirectPeers?: number;
  databasePaths?: DatabasePathsConfig;
};

// Event types for the adapter
export type AdapterEvents = {
  "connection-state-changed": { state: ConnectionState };
  "peer-joined": { peerId: string; user: PeerInfo };
  "peer-left": { peerId: string };
  "document-persisted": { docId: string; version: number };
  error: { error: Error; context: string };
  "sync-completed": { docId: string; updateSize: number };
  "awareness-updated": { peerId: string; user: PeerInfo };
};

export type AdapterHandle = {
  ydoc: Y.Doc;
  awareness: Awareness;
  disconnect: () => void;
  reconnect: () => Promise<void>;
  getPeerCount: () => number;
  getConnectionStatus: () => ConnectionState;
  getUserInfo: () => PeerInfo;
  getMemoryStats: () => {
    messageBuffer: number;
    connectionCount: number;
    lastCleanup: number;
    awarenessStates: number;
  };
  forceGarbageCollection: () => void;
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

export type SignalData = {
  type: "offer" | "answer";
  sdp?: RTCSessionDescriptionInit;
  from: string;
  to: string;
  timestamp: number;
};
