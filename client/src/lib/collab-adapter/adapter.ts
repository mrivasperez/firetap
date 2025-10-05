import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import SimplePeer from 'simple-peer'
import { startPeriodicPersistence, loadDocumentFromFirebase } from './persistence'
import { announcePresence, stopAnnouncingPresence, cleanupStalePeers, type PeerInfo } from './cluster'
import type { Database } from 'firebase/database'
import { ref, set, remove, onValue, push, off } from 'firebase/database'
import { encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'

import { type DatabasePathsConfig, buildDatabasePaths, type ConnectionState } from './config'

// ============================================================================
// CONSTANTS
// ============================================================================

// Peer Connection Configuration
const DEFAULT_MAX_DIRECT_PEERS = 20 // Maximum number of WebRTC peer connections
const PEER_PRESENCE_TIMEOUT_MS = 120_000 // 120 seconds - consider peer stale if not seen (2x heartbeat)
const PEER_ID_DISPLAY_LENGTH = 6 // Number of characters to show in peer ID

// Memory Management
const MAX_MESSAGE_BUFFER_SIZE = 1_000 // Maximum number of messages to keep in buffer
const MESSAGE_BUFFER_RETENTION_MS = 3_600_000 // 1 hour - how long to keep messages in buffer
const IDLE_PEER_TIMEOUT_MS = 300_000 // 5 minutes - timeout for idle peer connections
const MAX_MEMORY_BUFFER_BYTES = 10 * 1024 * 1024 // 10MB - max message buffer size in bytes
const MAX_AWARENESS_STATES = 50 // Maximum number of awareness states before cleanup

// Cleanup & Heartbeat Intervals
const CLEANUP_INTERVAL_MS = 60_000 // 60 seconds - interval for periodic cleanup
const HEARTBEAT_INTERVAL_MS = 60_000 // 60 seconds - interval for presence heartbeat (reduced Firebase writes)
const STALE_CONNECTION_TIMEOUT_MS = 180_000 // 3 minutes - timeout for stale connections (increased proportionally)
const MEMORY_CHECK_INTERVAL_MS = 300_000 // 5 minutes - interval for memory monitoring

// Default Configuration
const DEFAULT_SYNC_INTERVAL_MS = 15_000 // 15 seconds - default document sync interval

// WebRTC Configuration
const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
]

export type AdapterOptions = {
  docId: string
  // Firebase database instance (required for dependency injection)
  firebaseDatabase: Database
  peerId?: string
  user?: { name?: string }
  syncIntervalMs?: number
  maxDirectPeers?: number
  databasePaths?: DatabasePathsConfig
}

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

export type AdapterHandle = {
  ydoc: Y.Doc
  awareness: Awareness
  disconnect: () => void
  reconnect: () => Promise<void>
  getPeerCount: () => number
  getConnectionStatus: () => ConnectionState
  getUserInfo: () => PeerInfo
  getMemoryStats: () => {
    messageBuffer: number
    connectionCount: number
    lastCleanup: number
    awarenessStates: number
  }
  forceGarbageCollection: () => void
  on: <K extends keyof AdapterEvents>(event: K, callback: (data: AdapterEvents[K]) => void) => void
  off: <K extends keyof AdapterEvents>(event: K, callback: (data: AdapterEvents[K]) => void) => void
}

type SignalData = {
  type: 'offer' | 'answer' | 'signal'
  signal: unknown
  from: string
  to: string
  timestamp: number
}

class SimplePeerManager {
  private docId: string
  private peerId: string
  private ydoc: Y.Doc
  private awareness: Awareness
  private databasePaths: DatabasePathsConfig
  private rtdb: Database
  private eventListeners: Map<keyof AdapterEvents, Set<(data: AdapterEvents[keyof AdapterEvents]) => void>> = new Map()
  private cleanupInterval: NodeJS.Timeout | null = null
  private heartbeatInterval: NodeJS.Timeout | null = null
  private beforeUnloadHandler: (() => void) | null = null
  private visibilityChangeHandler: (() => void) | null = null
  private connectionTimestamps = new Map<string, number>()
  private isDestroyed = false
  private isTabVisible = true

  // Event system methods
  emit<K extends keyof AdapterEvents>(event: K, data: AdapterEvents[K]): void {
    const listeners = this.eventListeners.get(event)
    if (listeners) {
      listeners.forEach(callback => callback(data))
    }
  }

  on<K extends keyof AdapterEvents>(event: K, callback: (data: AdapterEvents[K]) => void): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set())
    }
    this.eventListeners.get(event)!.add(callback as (data: AdapterEvents[keyof AdapterEvents]) => void)
  }

  off<K extends keyof AdapterEvents>(event: K, callback: (data: AdapterEvents[K]) => void): void {
    const listeners = this.eventListeners.get(event)
    if (listeners) {
      listeners.delete(callback as (data: AdapterEvents[keyof AdapterEvents]) => void)
    }
  }

  async reconnect(): Promise<void> {
    this.connectionStatus = 'connecting'
    this.emit('connection-state-changed', { state: 'connecting' })
    try {
      // Clean up existing connections
      this.destroy()
      // Re-initialize
      await this.initialize()
      this.connectionStatus = 'connected'
      this.emit('connection-state-changed', { state: 'connected' })
    } catch (error) {
      this.connectionStatus = 'disconnected'
      this.emit('error', { error: error as Error, context: 'reconnection' })
      this.emit('connection-state-changed', { state: 'disconnected' })
      throw error
    }
  }
  private peers = new Map<string, SimplePeer.Instance>()
  private signalingRef: ReturnType<typeof ref> | null = null
  private connectionStatus: 'connecting' | 'connected' | 'disconnected' = 'connecting'
  private peersRef: ReturnType<typeof ref> | null = null
  private memoryStats = { messageBuffer: 0, connectionCount: 0, lastCleanup: Date.now(), awarenessStates: 0 }

  private maxPeers: number // Prevent too many connections
  private messageBuffer: Array<{ timestamp: number, size: number }> = []
  private maxBufferSize = MAX_MESSAGE_BUFFER_SIZE
  
  constructor(docId: string, peerId: string, ydoc: Y.Doc, awareness: Awareness, rtdb: Database, databasePaths: DatabasePathsConfig, maxDirectPeers: number = 20) {
    this.docId = docId
    this.peerId = peerId
    this.ydoc = ydoc
    this.awareness = awareness
    this.rtdb = rtdb
    this.databasePaths = databasePaths
    this.maxPeers = maxDirectPeers
  }

  private getPaths() {
    return buildDatabasePaths(this.databasePaths, this.docId)
  }

  async initialize(): Promise<void> {
    if (this.isDestroyed) {
      throw new Error('Cannot initialize destroyed peer manager')
    }

    // Set up signaling listener
    this.signalingRef = ref(this.rtdb, `${this.getPaths().signaling}/${this.peerId}`)
    onValue(this.signalingRef, (snapshot) => {
      if (snapshot.exists() && !this.isDestroyed) {
        const signals = snapshot.val()
        const signalKeys = Object.keys(signals)
        
        // Process all signals first
        signalKeys.forEach(key => {
          this.handleSignalData(signals[key] as SignalData)
        })
        
        // OPTIMIZED: Batch delete all processed signals at once
        // This reduces Firebase delete operations from N to 1
        if (signalKeys.length > 0 && this.signalingRef) {
          set(this.signalingRef, null).catch(error => {
            console.warn('Failed to batch delete signals:', error)
          })
        }
      }
    })

    // Listen for other peers joining
    this.peersRef = ref(this.rtdb, `${this.getPaths().rooms}/peers`)
    onValue(this.peersRef, (snapshot) => {
      if (snapshot.exists() && !this.isDestroyed) {
        const peers = snapshot.val()
        const currentPeerIds = Object.keys(peers)
        const now = Date.now()
        
        currentPeerIds.forEach(otherPeerId => {
          if (otherPeerId !== this.peerId && !this.peers.has(otherPeerId)) {
            const peerData = peers[otherPeerId]
            // Check if peer is not stale (connected within last 30 seconds)
            if (peerData.lastSeen && (now - peerData.lastSeen) < PEER_PRESENCE_TIMEOUT_MS) {
              // Only create connection if we should be the initiator (deterministic)
              const shouldInitiate = this.peerId < otherPeerId
              if (shouldInitiate) {
                this.createPeerConnection(otherPeerId, true)
              }
            }
          }
        })
        
        // Clean up our own connections to peers that are no longer present
        this.peers.forEach((peer, peerId) => {
          if (!currentPeerIds.includes(peerId)) {
            console.log(`Removing connection to peer ${peerId} (no longer in presence)`)
            peer.destroy()
            this.peers.delete(peerId)
            this.connectionTimestamps.delete(peerId)
          }
        })
      }
    })

    // Set up periodic cleanup
    this.startPeriodicCleanup()
    
    // Set up heartbeat to maintain presence
    this.startHeartbeat()
    
    // Set up beforeunload handler
    this.setupBeforeUnloadHandler()

    this.connectionStatus = 'connected'
  }

  private createPeerConnection(otherPeerId: string, initiator: boolean): void {
    // Check if peer connection already exists
    if (this.peers.has(otherPeerId)) {
      return
    }
    
    // Check if we're destroyed
    if (this.isDestroyed) {
      return
    }
    
    // Prevent too many connections for memory optimization
    if (this.peers.size >= this.maxPeers) {
      console.warn(`Maximum peer connections reached (${this.maxPeers}), rejecting new connection to ${otherPeerId}`)
      return
    }
    
    const peer = new SimplePeer({
      initiator,
      trickle: false,
      config: {
        iceServers: STUN_SERVERS
      }
    })

    peer.on('signal', (data) => {
      // Send signal through Firebase
      this.sendSignal(otherPeerId, data)
    })

    peer.on('connect', () => {
      console.log(`Peer ${otherPeerId} connected`)
      this.connectionTimestamps.set(otherPeerId, Date.now())
      this.emit('peer-joined', { peerId: otherPeerId, user: { id: otherPeerId, name: `User-${otherPeerId.slice(0, PEER_ID_DISPLAY_LENGTH)}`, connectedAt: Date.now() } })
      
      // Send current document state
      const update = Y.encodeStateAsUpdate(this.ydoc)
      peer.send(JSON.stringify({ type: 'sync', update: Array.from(update) }))
    })

    peer.on('data', (data) => {
      try {
        const message = JSON.parse(data.toString())
        const messageSize = data.length
        
        // Track message buffer for memory monitoring
        this.trackMessage(messageSize)
        
        if (message.type === 'sync' && message.update) {
          Y.applyUpdate(this.ydoc, new Uint8Array(message.update))
        } else if (message.type === 'awareness' && message.update) {
          // Apply awareness updates from peer with size limit check
          if (this.awareness.getStates().size < MAX_AWARENESS_STATES) { // Limit awareness states
            const awarenessUpdate = new Uint8Array(message.update)
            applyAwarenessUpdate(this.awareness, awarenessUpdate, null)
          }
        }
      } catch (error) {
        console.error('Error parsing peer data:', error)
      }
    })

    peer.on('error', (error) => {
      console.error(`Peer connection error with ${otherPeerId}:`, error)
      this.cleanupPeerConnection(otherPeerId)
    })

    peer.on('close', () => {
      console.log(`Peer ${otherPeerId} disconnected`)
      this.cleanupPeerConnection(otherPeerId)
    })

    this.peers.set(otherPeerId, peer)
  }

  private async sendSignal(targetPeerId: string, signal: unknown): Promise<void> {
    const signalData: SignalData = {
      type: 'signal',
      signal,
      from: this.peerId,
      to: targetPeerId,
      timestamp: Date.now()
    }
    
    // Push signal to target peer's signaling path
    const messageRef = push(ref(this.rtdb, `${this.getPaths().signaling}/${targetPeerId}`))
    await set(messageRef, signalData)
  }

  private handleSignalData(signalData: SignalData): void {
    const { from, signal } = signalData
    const peer = this.peers.get(from)
    
    if (peer) {
      try {
        peer.signal(signal as SimplePeer.SignalData)
      } catch (error) {
        console.error(`Error signaling peer ${from}:`, error)
      }
    } else {
      // Create peer connection for incoming signal
      this.createPeerConnection(from, false)
      // Apply the signal immediately after peer creation
      const newPeer = this.peers.get(from)
      if (newPeer) {
        try {
          newPeer.signal(signal as SimplePeer.SignalData)
        } catch (error) {
          console.error(`Error signaling new peer ${from}:`, error)
        }
      }
    }
  }

  broadcastUpdate(update: Uint8Array): void {
    const message = JSON.stringify({ type: 'sync', update: Array.from(update) })
    this.peers.forEach(peer => {
      if (peer.connected) {
        peer.send(message)
      }
    })
  }

  broadcastAwareness(update: Uint8Array): void {
    const message = JSON.stringify({ type: 'awareness', update: Array.from(update) })
    this.peers.forEach(peer => {
      if (peer.connected) {
        peer.send(message)
      }
    })
  }

  getPeerCount(): number {
    return Array.from(this.peers.values()).filter(peer => peer.connected).length
  }

  getConnectionStatus(): 'connecting' | 'connected' | 'disconnected' {
    return this.connectionStatus
  }

  private trackMessage(size: number): void {
    const now = Date.now()
    this.messageBuffer.push({ timestamp: now, size })
    this.memoryStats.messageBuffer += size
    
    // Clean old messages from buffer (keep last hour)
    const cutoff = now - MESSAGE_BUFFER_RETENTION_MS
    while (this.messageBuffer.length > 0 && this.messageBuffer[0].timestamp < cutoff) {
      const old = this.messageBuffer.shift()!
      this.memoryStats.messageBuffer -= old.size
    }
    
    // Prevent buffer from growing too large
    if (this.messageBuffer.length > this.maxBufferSize) {
      const excess = this.messageBuffer.splice(0, this.messageBuffer.length - this.maxBufferSize)
      this.memoryStats.messageBuffer -= excess.reduce((sum, msg) => sum + msg.size, 0)
    }
  }
  
  private cleanupIdlePeers(): void {
    const now = Date.now()
    const idleTimeout = IDLE_PEER_TIMEOUT_MS
    
    this.peers.forEach((peer, peerId) => {
      if (!peer.connected && (now - this.memoryStats.lastCleanup) > idleTimeout) {
        peer.destroy()
        this.peers.delete(peerId)
      }
    })
    
    this.memoryStats.lastCleanup = now
  }
  
  private performMemoryCleanup(): void {
    // Clean up idle peers
    this.cleanupIdlePeers()
    
    // Clear message buffer if too large
    if (this.memoryStats.messageBuffer > MAX_MEMORY_BUFFER_BYTES) { // 10MB
      console.warn('Message buffer too large, clearing older messages')
      this.messageBuffer.splice(0, Math.floor(this.messageBuffer.length / 2))
      this.memoryStats.messageBuffer = this.messageBuffer.reduce((sum, msg) => sum + msg.size, 0)
    }
    
    // Clean up awareness states if too many
    const awarenessStates = this.awareness.getStates()
    if (awarenessStates.size > MAX_AWARENESS_STATES) {
      console.warn('Too many awareness states, cleaning up old ones')
      // Remove stale awareness states (keep only connected peers)
      const connectedPeerIds = new Set(Array.from(this.peers.keys()).filter(id => {
        const peer = this.peers.get(id)
        return peer && peer.connected
      }))
      connectedPeerIds.add(this.peerId)
      
      // Remove states for disconnected peers
      const clientsToRemove: number[] = []
      awarenessStates.forEach((_state, clientId) => {
        if (!connectedPeerIds.has(String(clientId)) && clientId !== this.ydoc.clientID) {
          clientsToRemove.push(clientId)
        }
      })
      
      if (clientsToRemove.length > 0) {
        // Properly remove stale awareness states
        removeAwarenessStates(this.awareness, clientsToRemove, null)
        console.log(`Removed ${clientsToRemove.length} stale awareness states`)
      }
    }
  }
  
  getMemoryStats() {
    return {
      ...this.memoryStats,
      connectionCount: this.peers.size,
      awarenessStates: this.awareness.getStates().size
    }
  }

  private cleanupPeerConnection(peerId: string): void {
    const peer = this.peers.get(peerId)
    if (peer) {
      try {
        peer.destroy()
      } catch (e) {
        console.warn(`Error destroying peer ${peerId}:`, e)
      }
      this.peers.delete(peerId)
    }
    this.connectionTimestamps.delete(peerId)
    this.emit('peer-left', { peerId })
  }

  private startPeriodicCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
    }
    this.cleanupInterval = setInterval(async () => {
      if (this.isDestroyed) return
      
      const now = Date.now()
      const staleTimeout = STALE_CONNECTION_TIMEOUT_MS
      
      // Clean up stale connections
      this.connectionTimestamps.forEach((timestamp, peerId) => {
        if (now - timestamp > staleTimeout) {
          console.log(`Cleaning up stale connection to peer ${peerId}`)
          this.cleanupPeerConnection(peerId)
        }
      })
      
      // Clean up stale peers from Firebase
      try {
        await cleanupStalePeers(this.rtdb, this.docId, this.databasePaths)
      } catch (error) {
        console.warn('Failed to cleanup stale peers from Firebase:', error)
      }
      
      // Perform general memory cleanup
      this.performMemoryCleanup()
    }, CLEANUP_INTERVAL_MS) // Run every 30 seconds
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
    }
    this.heartbeatInterval = setInterval(async () => {
      if (this.isDestroyed) return
      
      try {
        // Update our lastSeen timestamp in Firebase
        const paths = this.getPaths()
        const peerRef = ref(this.rtdb, `${paths.rooms}/peers/${this.peerId}`)
        
        // Set up automatic cleanup on disconnect (Firebase handles this)
        const { onDisconnect } = await import('firebase/database')
        await onDisconnect(peerRef).remove()
        
        const currentData = {
          id: this.peerId,
          name: `User-${this.peerId.slice(0, PEER_ID_DISPLAY_LENGTH)}`,
          connectedAt: Date.now(),
          lastSeen: Date.now()
        }
        await set(peerRef, currentData)
      } catch (error) {
        console.warn('Failed to update heartbeat:', error)
      }
    }, HEARTBEAT_INTERVAL_MS) // Every 60 seconds (reduced from 15s for cost optimization)
  }

  private setupBeforeUnloadHandler(): void {
    this.beforeUnloadHandler = () => {
      // Synchronously clean up our presence on actual page unload
      try {
        const paths = this.getPaths()
        const peerRef = ref(this.rtdb, `${paths.rooms}/peers/${this.peerId}`)
        // Use sendBeacon for reliable cleanup on page unload
        if (navigator.sendBeacon) {
          const cleanupData = JSON.stringify({ action: 'cleanup', peerId: this.peerId })
          navigator.sendBeacon('/cleanup', cleanupData) // This would need server support
        }
        // Fallback: direct Firebase cleanup (may not complete)
        remove(peerRef)
      } catch (error) {
        console.warn('Error in beforeunload cleanup:', error)
      }
    }
    
    // Handle tab visibility changes (different from page unload)
    this.visibilityChangeHandler = async () => {
      if (typeof document === 'undefined') return
      
      const isNowVisible = !document.hidden
      
      if (isNowVisible && !this.isTabVisible) {
        // Tab became visible - resume activity
        console.log('Tab visible: resuming collaboration')
        this.isTabVisible = true
        
        // Resume heartbeat immediately
        if (this.heartbeatInterval) {
          clearInterval(this.heartbeatInterval)
        }
        this.startHeartbeat()
        
        // Update presence immediately
        try {
          const paths = this.getPaths()
          const peerRef = ref(this.rtdb, `${paths.rooms}/peers/${this.peerId}`)
          const { onDisconnect } = await import('firebase/database')
          await onDisconnect(peerRef).remove()
          
          await set(peerRef, {
            id: this.peerId,
            name: `User-${this.peerId.slice(0, PEER_ID_DISPLAY_LENGTH)}`,
            connectedAt: Date.now(),
            lastSeen: Date.now()
          })
        } catch (error) {
          console.warn('Failed to update presence on tab visible:', error)
        }
        
        // Check peer connections and reconnect if needed
        this.checkAndReconnectPeers()
        
      } else if (!isNowVisible && this.isTabVisible) {
        // Tab became hidden - pause heartbeat to save resources
        console.log('Tab hidden: pausing heartbeat (connections maintained)')
        this.isTabVisible = false
        // Note: We don't stop heartbeat completely, just rely on existing interval
        // Firebase will keep connection alive, and onDisconnect() will handle cleanup if needed
      }
    }
    
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', this.beforeUnloadHandler)
      // Also handle page hide (mobile Safari, etc.) - actual page unload
      window.addEventListener('pagehide', this.beforeUnloadHandler)
      // Handle tab visibility changes - pause/resume activity
      window.addEventListener('visibilitychange', this.visibilityChangeHandler)
    }
  }

  private async checkAndReconnectPeers(): Promise<void> {
    // Check if we have active peer connections
    const connectedPeers = Array.from(this.peers.values()).filter(p => p.connected).length
    
    if (connectedPeers === 0 && this.peers.size > 0) {
      // We have peer objects but none are connected - clean up and reconnect
      console.log('No active peer connections after tab visible, reconnecting...')
      
      // Clean up stale connections
      this.peers.forEach((peer, peerId) => {
        if (!peer.connected) {
          try {
            peer.destroy()
          } catch {
            // Ignore errors during cleanup
          }
          this.peers.delete(peerId)
          this.connectionTimestamps.delete(peerId)
        }
      })
      
      // Force a cleanup to discover peers again
      try {
        await cleanupStalePeers(this.rtdb, this.docId, this.databasePaths)
      } catch (error) {
        console.warn('Failed to cleanup stale peers on reconnect:', error)
      }
    }
  }

  destroy(): void {
    // Mark as destroyed first
    this.isDestroyed = true
    
    // Perform final cleanup
    this.performMemoryCleanup()
    
    // Close all peer connections
    this.peers.forEach(peer => {
      try {
        peer.destroy()
      } catch (e) {
        console.warn('Error destroying peer:', e)
      }
    })
    this.peers.clear()

    // Remove Firebase listeners
    if (this.signalingRef) {
      off(this.signalingRef)
      this.signalingRef = null
    }
    
    if (this.peersRef) {
      off(this.peersRef)
      this.peersRef = null
    }

    // Remove event listeners
    if (typeof window !== 'undefined') {
      if (this.beforeUnloadHandler) {
        window.removeEventListener('beforeunload', this.beforeUnloadHandler)
        window.removeEventListener('pagehide', this.beforeUnloadHandler)
      }
      if (this.visibilityChangeHandler) {
        window.removeEventListener('visibilitychange', this.visibilityChangeHandler)
      }
    }

    // Clear memory tracking
    this.messageBuffer = []
    this.memoryStats = { messageBuffer: 0, connectionCount: 0, lastCleanup: Date.now(), awarenessStates: 0 }

    this.connectionStatus = 'disconnected'
  }
}

export async function createFirebaseYWebrtcAdapter(opts: AdapterOptions): Promise<AdapterHandle> {
  const { 
    docId, 
    firebaseDatabase,
    peerId = crypto.randomUUID(), 
    user = {}, 
    syncIntervalMs = DEFAULT_SYNC_INTERVAL_MS,
    maxDirectPeers = DEFAULT_MAX_DIRECT_PEERS,
    databasePaths
  } = opts

  // 1) Create the Y.Doc and Awareness with memory optimizations
  const ydoc = new Y.Doc()
  // Enable garbage collection to clean up old operations
  ydoc.gc = true
  // Set reasonable GC threshold
  ydoc.gcFilter = () => true
  
  const awareness = new Awareness(ydoc)
  // Limit awareness state size to prevent memory bloat
  const maxAwarenessStates = MAX_AWARENESS_STATES
  
  // Memory monitoring for long-running sessions
  let lastMemoryCheck = Date.now()
  const memoryCheckInterval = MEMORY_CHECK_INTERVAL_MS

  // 2) Load persisted state from Firebase (if any)
  try {
    const loaded = await loadDocumentFromFirebase(firebaseDatabase, docId, databasePaths)
    if (loaded) {
      Y.applyUpdate(ydoc, loaded)
    }
  } catch (e) {
    console.warn('Failed to load persisted Y document from Firebase', e)
  }

  // 3) Create peer info for Firebase presence
  const peerInfo: PeerInfo = {
    id: peerId,
    name: user.name || `User-${peerId.slice(0, PEER_ID_DISPLAY_LENGTH)}`,
    connectedAt: Date.now(),
  }

  // 4) Create SimplePeer manager
  const peerManager = new SimplePeerManager(docId, peerId, ydoc, awareness, firebaseDatabase, databasePaths || { structure: 'flat', flat: { documents: '/documents', rooms: '/rooms', snapshots: '/snapshots', signaling: '/signaling' } }, maxDirectPeers)

  // 5) Set up Y.js event handlers
  ydoc.on('update', (update: Uint8Array) => {
    peerManager.broadcastUpdate(update)
  })

  awareness.on('update', ({ added, updated, removed }: { added: number[], updated: number[], removed: number[] }) => {
    const changedClients = added.concat(updated, removed)
    if (changedClients.length > 0) {
      const awarenessUpdate = encodeAwarenessUpdate(awareness, changedClients)
      peerManager.broadcastAwareness(awarenessUpdate)
    }
  })

  // 6) Set up awareness with user info
  awareness.setLocalStateField('user', {
    name: peerInfo.name,
    id: peerId
  })

  // 7) Announce presence in Firebase
  let presenceCleanup: (() => void) | null = null
  try {
    await announcePresence(firebaseDatabase, docId, peerInfo, databasePaths)
    presenceCleanup = () => stopAnnouncingPresence(firebaseDatabase, docId, peerId, databasePaths)
  } catch (e) {
    console.warn('Failed to announce presence in Firebase:', e)
  }

  // 8) Start periodic persistence
  const stopPersistence = startPeriodicPersistence(firebaseDatabase, ydoc, docId, syncIntervalMs, databasePaths)

  // 9) Initialize peer connections
  await peerManager.initialize()

  // 10) Set up memory monitoring
  const memoryMonitorTimer = setInterval(() => {
    const now = Date.now()
    if (now - lastMemoryCheck > memoryCheckInterval) {
      lastMemoryCheck = now
      
      // Note: Y.js garbage collection runs automatically when ydoc.gc = true
      // No manual intervention needed - GC cleans up deleted operations automatically
      
      // Clean up awareness states if needed
      const awarenessStates = awareness.getStates()
      if (awarenessStates.size > maxAwarenessStates) {
        console.warn(`Too many awareness states (${awarenessStates.size}), cleaning up`)
        // Get list of currently connected peers from peer manager
        const connectedPeers = new Set<number>()
        connectedPeers.add(ydoc.clientID) // Always keep our own client
        
        // Collect client IDs that should be removed (stale states)
        const clientsToRemove: number[] = []
        awarenessStates.forEach((_state, clientId) => {
          // Keep only our own state and remove others
          // The peer manager will re-add connected peers' states
          if (clientId !== ydoc.clientID) {
            clientsToRemove.push(clientId)
          }
        })
        
        if (clientsToRemove.length > 0) {
          // Remove stale awareness states properly
          removeAwarenessStates(awareness, clientsToRemove, null)
          console.log(`Removed ${clientsToRemove.length} stale awareness states`)
        }
      }
    }
  }, memoryCheckInterval)

  // 11) Wire cleanup with comprehensive memory management
  const disconnect = () => {
    // Clear memory monitoring
    clearInterval(memoryMonitorTimer)
    
    try {
      peerManager.destroy()
    } catch (e) {
      console.warn('PeerManager destroy error:', e)
    }
    try {
      stopPersistence()
    } catch (e) {
      console.warn('Persistence stop error:', e)
    }
    try {
      presenceCleanup?.()
    } catch (e) {
      console.warn('Presence cleanup error:', e)
    }
    try {
      // Clean up Y.js document memory
      ydoc.getMap().clear()
      ydoc.getText().delete(0, ydoc.getText().length)
      
      // Destroy awareness
      awareness.destroy()
    } catch (e) {
      console.warn('Document cleanup error:', e)
    }
    try {
      // Final Y.js document cleanup
      ydoc.destroy()
    } catch (e) {
      console.warn('Y.js document destroy error:', e)
    }
  }

  return { 
    ydoc, 
    awareness,
    disconnect,
    reconnect: () => peerManager.reconnect(),
    getPeerCount: () => peerManager.getPeerCount(),
    getConnectionStatus: () => peerManager.getConnectionStatus(),
    getUserInfo: () => peerInfo,
    getMemoryStats: () => peerManager.getMemoryStats(),
    forceGarbageCollection: () => {
      // Y.js handles garbage collection automatically when ydoc.gc = true
      // GC runs incrementally during document operations - no manual triggering needed
      // This method is kept for API compatibility but is essentially a no-op
      console.log('Y.js GC is automatic when ydoc.gc = true (current state:', ydoc.gc, ')')
    },
    on: <K extends keyof AdapterEvents>(event: K, callback: (data: AdapterEvents[K]) => void) => 
      peerManager.on(event, callback),
    off: <K extends keyof AdapterEvents>(event: K, callback: (data: AdapterEvents[K]) => void) => 
      peerManager.off(event, callback)
  }
}

export default createFirebaseYWebrtcAdapter
