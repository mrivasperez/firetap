export const DEFAULT_MAX_DIRECT_PEERS = 20;
export const PEER_PRESENCE_TIMEOUT_MS = 600_000;
export const PEER_ID_DISPLAY_LENGTH = 6;

export const IDLE_PEER_TIMEOUT_MS = 300_000;
export const MAX_AWARENESS_STATES = 50;

export const CLEANUP_INTERVAL_MS = 300_000;
export const HEARTBEAT_INTERVAL_MS = 300_000;
export const STALE_CONNECTION_TIMEOUT_MS = 600_000;
export const MEMORY_CHECK_INTERVAL_MS = 300_000;
export const MIN_VISIBILITY_UPDATE_INTERVAL = 120_000;

export const DEFAULT_SYNC_INTERVAL_MS = 30_000;

export const AWARENESS_THROTTLE_MS = 50;

export const COMPRESSION_THRESHOLD = 512;
export const USE_NATIVE_COMPRESSION = typeof CompressionStream !== 'undefined';

export const MAX_CHUNK_SIZE = 32_000;
export const CHUNK_HEADER_SIZE = 200;

export const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];
