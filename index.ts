import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'

// Main adapter factory
export { default as createFirebaseYWebrtcAdapter } from './src/adapter'
export type { AdapterOptions, AdapterHandle } from './src/adapter'

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
} from './src/config'
export type { 
  DatabasePathsConfig, 
  CollaborationConfig,
  ConnectionState 
} from './src/config'

// Persistence utilities (for advanced users)
export { 
  loadDocumentFromFirebase,
  persistDocument,
  createDocumentSnapshot,
  getDocumentVersion
} from './src/persistence'
export type { DocumentSnapshot } from './src/persistence'

// Clustering utilities
export { announcePresence, stopAnnouncingPresence } from './src/cluster'
export type { PeerInfo } from './src/cluster'

// Re-export types from config and cluster
import type { ConnectionState } from './src/config'
import type { PeerInfo } from './src/cluster'

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
import type { AdapterOptions } from './src/adapter'

export type AdapterFactory<TOptions = AdapterOptions> = {
  create(options: TOptions): Promise<YDocumentAdapter>
}
