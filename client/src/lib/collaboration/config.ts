import { type AdapterOptions } from "./adapter";

export type CollaborationConfig = {
  // Document settings
  docId: string;

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

export const DEFAULT_CONFIG: CollaborationConfig = {
  docId: "default-doc",
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
      color: mergedConfig.user.color || generateRandomColor(),
    },
    maxDirectPeers: mergedConfig.maxDirectPeers,
    syncIntervalMs: mergedConfig.syncIntervalMs,
  };
}

export function generateRandomColor(): string {
  const colors = [
    "#FF6B6B",
    "#4ECDC4",
    "#45B7D1",
    "#96CEB4",
    "#FFEAA7",
    "#DDA0DD",
    "#98D8C8",
    "#F7DC6F",
    "#BB8FCE",
    "#85C1E9",
    "#F8C471",
    "#82E0AA",
    "#F1948A",
    "#85C1E9",
    "#D2B4DE",
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

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

export type CollaborationStats = {
  connectionState: ConnectionState;
  peerCount: number;
  clusterId: string;
  isCommonClient: boolean;
  documentVersion: number | null;
  lastSyncTime: number | null;
};

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
