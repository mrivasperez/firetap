export const DEFAULT_MAX_DIRECT_PEERS = 20;
export const PEER_ID_DISPLAY_LENGTH = 6;

export const CONNECT_TIMEOUT_MS = 30_000;
export const DISCONNECT_GRACE_MS = 5_000;
export const RETRY_BASE_MS = 2_000;
export const RETRY_MAX_MS = 60_000;
export const ICE_GATHERING_MAX_MS = 3_000;
export const ICE_SETTLE_MS = 300;
export const ANTI_ENTROPY_INTERVAL_MS = 30_000;

export const DEFAULT_SYNC_INTERVAL_MS = 30_000;

export const AWARENESS_THROTTLE_MS = 50;

export const USE_NATIVE_COMPRESSION = typeof CompressionStream !== 'undefined';

export const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];
