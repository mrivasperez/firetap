// ============================================================================
// CONSTANTS
// ============================================================================

// Peer Connection Configuration
export const DEFAULT_MAX_DIRECT_PEERS = 20; // Maximum number of WebRTC peer connections
export const PEER_PRESENCE_TIMEOUT_MS = 600_000; // 10 minutes - consider peer stale if not seen (2x heartbeat)
export const PEER_ID_DISPLAY_LENGTH = 6; // Number of characters to show in peer ID

// Memory Management
export const MAX_MESSAGE_BUFFER_SIZE = 1_000; // Maximum number of messages to keep in buffer
export const MESSAGE_BUFFER_RETENTION_MS = 3_600_000; // 1 hour - how long to keep messages in buffer
export const IDLE_PEER_TIMEOUT_MS = 300_000; // 5 minutes - timeout for idle peer connections
export const MAX_MEMORY_BUFFER_BYTES = 10 * 1024 * 1024; // 10MB - max message buffer size in bytes
export const MAX_AWARENESS_STATES = 50; // Maximum number of awareness states before cleanup

// Cleanup & Heartbeat Intervals
export const CLEANUP_INTERVAL_MS = 300_000; // 5 minutes - interval for periodic cleanup
export const HEARTBEAT_INTERVAL_MS = 300_000; // 5 minutes - interval for presence heartbeat (optimized for cost savings)
export const STALE_CONNECTION_TIMEOUT_MS = 600_000; // 10 minutes - timeout for stale connections
export const MEMORY_CHECK_INTERVAL_MS = 300_000; // 5 minutes - interval for memory monitoring
export const MIN_VISIBILITY_UPDATE_INTERVAL = 120_000; // 2 minutes - throttle for visibility change updates

// Default Configuration
export const DEFAULT_SYNC_INTERVAL_MS = 15_000; // 15 seconds - default document sync interval

// Awareness Throttling Configuration
export const AWARENESS_THROTTLE_MS = 50; // 50ms batch window = max 20 updates/second

// Compression Configuration
export const COMPRESSION_THRESHOLD = 100; // Only compress messages larger than 100 bytes
export const USE_NATIVE_COMPRESSION = typeof CompressionStream !== 'undefined'; // Check browser support

// WebRTC Configuration
export const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];
