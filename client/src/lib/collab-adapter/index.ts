import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'

// Main adapter factory
export { default as createFirebaseYWebrtcAdapter } from './adapter'
export type { AdapterOptions, AdapterHandle } from './adapter'

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

// Re-export types from config and cluster
import type { ConnectionState } from './utils/config'
import type { PeerInfo } from './firebase/presence'

// Event types for the adapter
export type AdapterEvents = {
  'connection-state-changed': { state: ConnectionState }
  'peer-joined': { peerId: string; user: PeerInfo }
  'peer-left': { peerId: string }
  'document-persisted': { docId: string; version: number }
  'error': { error: Error; context: string }
  'sync-completed': { docId: string; updateSize: number }
  'awareness-updated': { peerId: string; user: PeerInfo }
}

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
  on<K extends keyof AdapterEvents>(event: K, callback: (data: AdapterEvents[K]) => void): void
  off<K extends keyof AdapterEvents>(event: K, callback: (data: AdapterEvents[K]) => void): void
}

// Re-export AdapterOptions for factory
import type { AdapterOptions } from './adapter'

export type AdapterFactory<TOptions = AdapterOptions> = {
  create(options: TOptions): Promise<YDocumentAdapter>
}
