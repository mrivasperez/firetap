import { type AdapterOptions } from "./adapter";

export type DatabasePathsConfig = {
  // Base path structure - can be 'flat' or 'nested'
  structure: 'flat' | 'nested';
  
  // For 'flat' structure: separate top-level paths
  flat?: {
    documents: string;
    rooms: string;
    snapshots: string;
    signaling: string;
  };
  
  // For 'nested' structure: all under documents/{{docId}}
  nested?: {
    basePath: string; // e.g., '/documents'
    subPaths: {
      documents: string; // e.g., 'documents'
      rooms: string;     // e.g., 'rooms'
      snapshots: string; // e.g., 'snapshots'
      signaling: string; // e.g., 'signaling'
    };
  };
};

export type CollaborationConfig = {
  // Document settings
  docId: string;

  // Database paths configuration
  databasePaths?: DatabasePathsConfig;

  // User settings
  user: {
    name: string;
    color?: string;
  };

  // Network settings
  maxDirectPeers: number;
  syncIntervalMs: number;
  connectionTimeout: number;
  heartbeatInterval: number;

  // UI settings
  placeholder: string;
  showConnectionStatus: boolean;
  showPeerCount: boolean;
  autoReconnect: boolean;

  // Debug settings
  enableDebugLogs: boolean;
};

export const DEFAULT_DATABASE_PATHS: DatabasePathsConfig = {
  structure: 'nested',
  nested: {
    basePath: '/documents',
    subPaths: {
      documents: 'documents',
      rooms: 'rooms',
      snapshots: 'snapshots',
      signaling: 'signaling'
    }
  }
};

export const DEFAULT_CONFIG: CollaborationConfig = {
  docId: "default-doc",
  databasePaths: DEFAULT_DATABASE_PATHS,
  user: {
    name: "Anonymous User",
  },
  maxDirectPeers: 4,
  syncIntervalMs: 60000,
  connectionTimeout: 15000,
  heartbeatInterval: 30000,
  placeholder: "Start typing to collaborate...",
  showConnectionStatus: true,
  showPeerCount: true,
  autoReconnect: true,
  enableDebugLogs: false,
};

export function createAdapterConfig(
  config: Partial<CollaborationConfig>
): AdapterOptions {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  return {
    docId: mergedConfig.docId,
    user: {
      name: mergedConfig.user.name,
      color: mergedConfig.user.color,
    },
    maxDirectPeers: mergedConfig.maxDirectPeers,
    syncIntervalMs: mergedConfig.syncIntervalMs,
    databasePaths: mergedConfig.databasePaths,
  };
}

// generateRandomColor moved to client/src/utils/color.ts

export function generateUserId(): string {
  return `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function validateConfig(config: Partial<CollaborationConfig>): string[] {
  const errors: string[] = [];

  if (config.docId && config.docId.trim().length === 0) {
    errors.push("Document ID cannot be empty");
  }

  if (config.user?.name && config.user.name.trim().length === 0) {
    errors.push("User name cannot be empty");
  }

  if (
    config.maxDirectPeers &&
    (config.maxDirectPeers < 1 || config.maxDirectPeers > 20)
  ) {
    errors.push("Max direct peers must be between 1 and 20");
  }

  if (config.syncIntervalMs && config.syncIntervalMs < 1000) {
    errors.push("Sync interval must be at least 1000ms");
  }

  return errors;
}

export type ConnectionState = "disconnected" | "connecting" | "connected";

export function formatConnectionState(state: ConnectionState): string {
  switch (state) {
    case "disconnected":
      return "🔴 Disconnected";
    case "connecting":
      return "🟡 Connecting...";
    case "connected":
      return "🟢 Connected";
    default:
      return "⚫ Unknown";
  }
}

export function formatPeerCount(count: number): string {
  if (count === 0) return "Solo";
  if (count === 1) return "1 peer";
  return `${count} peers`;
}

export function buildDatabasePaths(config: DatabasePathsConfig, docId: string) {
  if (config.structure === 'flat') {
    if (!config.flat) throw new Error('Flat structure requires flat config');
    return {
      documents: config.flat.documents,
      rooms: config.flat.rooms,
      snapshots: config.flat.snapshots,
      signaling: config.flat.signaling
    };
  } else if (config.structure === 'nested') {
    if (!config.nested) throw new Error('Nested structure requires nested config');
    const base = `${config.nested.basePath}/${docId}`;
    return {
      documents: `${base}/${config.nested.subPaths.documents}`,
      rooms: `${base}/${config.nested.subPaths.rooms}`,
      snapshots: `${base}/${config.nested.subPaths.snapshots}`,
      signaling: `${base}/${config.nested.subPaths.signaling}`
    };
  } else {
    throw new Error(`Unknown database structure: ${config.structure}`);
  }
}
