import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'

// Main adapter factory
export { default as createFirebaseYWebrtcAdapter } from './adapter'
export type { 
  AdapterOptions, 
  AdapterHandle,
  AdapterEvents,
  SignalData
} from './core/types'

// Configuration utilities
export { 
  buildDatabasePaths, 
  DEFAULT_DATABASE_PATHS,
  DEFAULT_CONFIG,
  createSimpleConfig,
  createWorkspaceConfig,
  createAdapterConfig,
  validateConfig,
  generateUserId
} from './utils/config'
export type { 
  DatabasePathsConfig, 
  CollaborationConfig,
  ConnectionState 
} from './utils/config'

// Constants
export {
  DEFAULT_MAX_DIRECT_PEERS,
  PEER_PRESENCE_TIMEOUT_MS,
  PEER_ID_DISPLAY_LENGTH,
  MAX_MESSAGE_BUFFER_SIZE,
  MESSAGE_BUFFER_RETENTION_MS,
  IDLE_PEER_TIMEOUT_MS,
  MAX_MEMORY_BUFFER_BYTES,
  MAX_AWARENESS_STATES,
  CLEANUP_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  STALE_CONNECTION_TIMEOUT_MS,
  MEMORY_CHECK_INTERVAL_MS,
  MIN_VISIBILITY_UPDATE_INTERVAL,
  DEFAULT_SYNC_INTERVAL_MS,
  AWARENESS_THROTTLE_MS,
  COMPRESSION_THRESHOLD,
  USE_NATIVE_COMPRESSION,
  STUN_SERVERS,
} from './utils/constants'

// Compression utilities
export { compressData, decompressData } from './utils/compression'

// Persistence utilities (for advanced users)
export { 
  loadDocumentFromFirebase,
  persistDocument,
  createDocumentSnapshot,
  getDocumentVersion
} from './firebase/persistence'
export type { DocumentSnapshot } from './firebase/persistence'

// Clustering utilities
export { announcePresence, stopAnnouncingPresence } from './firebase/presence'
export type { PeerInfo } from './firebase/presence'

// Core peer manager (for advanced users)
export { SimplePeerManager } from './core/peer-manager'

// Re-export types from config and cluster for convenience
import type { ConnectionState } from './utils/config'
import type { PeerInfo } from './firebase/presence'

// Enhanced adapter interface types
export type YDocumentAdapter = {
  ydoc: Y.Doc
  awareness: Awareness
  disconnect(): void
  reconnect(): Promise<void>
  getPeerCount(): number
  getConnectionStatus(): ConnectionState
  getUserInfo(): PeerInfo
  getMemoryStats(): {
    messageBuffer: number
    connectionCount: number
    lastCleanup: number
    awarenessStates: number
  }
  forceGarbageCollection(): void
  forcePersist(): Promise<void>
  on<K extends keyof import('./core/types').AdapterEvents>(event: K, callback: (data: import('./core/types').AdapterEvents[K]) => void): void
  off<K extends keyof import('./core/types').AdapterEvents>(event: K, callback: (data: import('./core/types').AdapterEvents[K]) => void): void
}

// Re-export AdapterOptions for factory
import type { AdapterOptions } from './core/types'

export type AdapterFactory<TOptions = AdapterOptions> = {
  create(options: TOptions): Promise<YDocumentAdapter>
}
