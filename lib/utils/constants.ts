export const DEFAULT_MAX_DIRECT_PEERS = 6;
export const TOPOLOGY_SETTLE_MS = 200;
export const PEER_ID_DISPLAY_LENGTH = 6;

export const CONNECT_TIMEOUT_MS = 30_000;
export const DISCONNECT_GRACE_MS = 5_000;
export const RETRY_BASE_MS = 2_000;
export const RETRY_MAX_MS = 60_000;
export const ICE_GATHERING_MAX_MS = 3_000;
export const ICE_SETTLE_MS = 300;
export const ANTI_ENTROPY_INTERVAL_MS = 30_000;
export const FALLBACK_DELAY_MS = 5_000;
export const FALLBACK_LINGER_MS = 3_000;
export const PEER_LOAD_TIMEOUT_MS = 2_000;
export const PRESENCE_SETTLE_MS = 500;

export const DEFAULT_PERSIST_DEBOUNCE_MS = 1_000;
export const PERSIST_RETRY_BASE_MS = 1_000;
export const PERSIST_RETRY_MAX_MS = 30_000;
export const DISCONNECT_FLUSH_TIMEOUT_MS = 5_000;
export const RESCUE_JITTER_MS = 3_000;
// Firebase rejects strings over 10MB.
export const STORED_PART_CHARS = 8 * 1024 * 1024;
export const LOG_ENTRY_GZIP_MIN_BYTES = 1024;
export const MERGE_MIN_LOG_BYTES = 8 * 1024;
export const MERGE_MAX_LOG_BYTES = 256 * 1024;
export const MERGE_LEASE_MS = 60_000;
export const MERGE_SETTLE_MS = 5_000;
export const LOAD_MAX_ATTEMPTS = 3;

export const AWARENESS_THROTTLE_MS = 50;

export const USE_NATIVE_COMPRESSION = typeof CompressionStream !== 'undefined';

export const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];
