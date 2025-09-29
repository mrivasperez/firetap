import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import SimplePeer from 'simple-peer'
import { startPeriodicPersistence, loadDocumentFromFirebase } from './persistence'
import { announcePresence, stopAnnouncingPresence, type PeerInfo } from './cluster'
import { rtdb } from '../../firebase'
import { ref, set, remove, onValue, push, off } from 'firebase/database'
import { encodeAwarenessUpdate, applyAwarenessUpdate } from 'y-protocols/awareness'

import { type DatabasePathsConfig, buildDatabasePaths } from './config'

export type AdapterOptions = {
  docId: string
  peerId?: string
  user?: { name?: string; color?: string }
  syncIntervalMs?: number
  maxDirectPeers?: number
  databasePaths?: DatabasePathsConfig
}

export type AdapterHandle = {
  ydoc: Y.Doc
  awareness: Awareness
  disconnect: () => void
  getPeerCount: () => number
  getConnectionStatus: () => 'connecting' | 'connected' | 'disconnected'
  getUserInfo: () => PeerInfo
  getMemoryStats: () => {
    messageBuffer: number
    connectionCount: number
    lastCleanup: number
    awarenessStates: number
  }
  forceGarbageCollection: () => void
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
  private peers = new Map<string, SimplePeer.Instance>()
  private signalingRef: ReturnType<typeof ref> | null = null
  private connectionStatus: 'connecting' | 'connected' | 'disconnected' = 'connecting'
  private peersRef: ReturnType<typeof ref> | null = null
  private memoryStats = { messageBuffer: 0, connectionCount: 0, lastCleanup: Date.now(), awarenessStates: 0 }

  private maxPeers = 8 // Prevent too many connections
  private messageBuffer: Array<{ timestamp: number, size: number }> = []
  private maxBufferSize = 1000
  
  constructor(docId: string, peerId: string, ydoc: Y.Doc, awareness: Awareness, databasePaths: DatabasePathsConfig) {
    this.docId = docId
    this.peerId = peerId
    this.ydoc = ydoc
    this.awareness = awareness
    this.databasePaths = databasePaths
  }

  private getPaths() {
    return buildDatabasePaths(this.databasePaths, this.docId)
  }

  async initialize(): Promise<void> {
    // Set up signaling listener
    this.signalingRef = ref(rtdb, `${this.getPaths().signaling}/${this.peerId}`)
    onValue(this.signalingRef, (snapshot) => {
      if (snapshot.exists()) {
        const signals = snapshot.val()
        Object.entries(signals).forEach(([key, signal]) => {
          this.handleSignalData(signal as SignalData)
          // Clean up processed signal
          remove(ref(rtdb, `${this.getPaths().signaling}/${this.peerId}/${key}`))
        })
      }
    })

    // Listen for other peers joining
    const peersRef = ref(rtdb, `${this.getPaths().rooms}/peers`)
    onValue(peersRef, (snapshot) => {
      if (snapshot.exists()) {
        const peers = snapshot.val()
        const currentPeerIds = Object.keys(peers)
        console.log(`Found ${currentPeerIds.length} peers in room:`, currentPeerIds)
        
        currentPeerIds.forEach(otherPeerId => {
          if (otherPeerId !== this.peerId && !this.peers.has(otherPeerId)) {
            // Only create connection if we should be the initiator (deterministic)
            const shouldInitiate = this.peerId < otherPeerId
            if (shouldInitiate) {
              console.log(`Initiating connection to ${otherPeerId}`)
              this.createPeerConnection(otherPeerId, true)
            } else {
              console.log(`Waiting for ${otherPeerId} to initiate connection`)
            }
          }
        })
      }
    })

    this.connectionStatus = 'connected'
  }

  private createPeerConnection(otherPeerId: string, initiator: boolean): void {
    // Check if peer connection already exists
    if (this.peers.has(otherPeerId)) {
      console.log(`Peer connection to ${otherPeerId} already exists, skipping`)
      return
    }
    
    // Prevent too many connections for memory optimization
    if (this.peers.size >= this.maxPeers) {
      console.warn(`Maximum peer connections reached (${this.maxPeers}), rejecting new connection to ${otherPeerId}`)
      return
    }
    
    console.log(`Creating peer connection to ${otherPeerId} (initiator: ${initiator})`)
    
    const peer = new SimplePeer({
      initiator,
      trickle: false,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      }
    })

    peer.on('signal', (data) => {
      // Send signal through Firebase
      this.sendSignal(otherPeerId, data)
    })

    peer.on('connect', () => {
      console.log(`Connected to peer ${otherPeerId}`)
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
          if (this.awareness.getStates().size < 50) { // Limit awareness states
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
      this.peers.delete(otherPeerId)
    })

    peer.on('close', () => {
      console.log(`Peer connection closed with ${otherPeerId}`)
      this.peers.delete(otherPeerId)
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
    
    const messageRef = push(ref(rtdb, `${this.getPaths().signaling}/${targetPeerId}`))
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
    const cutoff = now - 3600000 // 1 hour
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
    const idleTimeout = 300000 // 5 minutes
    
    this.peers.forEach((peer, peerId) => {
      if (!peer.connected && (now - this.memoryStats.lastCleanup) > idleTimeout) {
        console.log(`Cleaning up idle peer connection: ${peerId}`)
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
    if (this.memoryStats.messageBuffer > 10 * 1024 * 1024) { // 10MB
      console.warn('Message buffer too large, clearing older messages')
      this.messageBuffer.splice(0, Math.floor(this.messageBuffer.length / 2))
      this.memoryStats.messageBuffer = this.messageBuffer.reduce((sum, msg) => sum + msg.size, 0)
    }
    
    // Clean up awareness states if too many
    const awarenessStates = this.awareness.getStates()
    if (awarenessStates.size > 50) {
      console.warn('Too many awareness states, cleaning up old ones')
      // Clear excess awareness states by recreating awareness
      this.awareness.destroy()
    }
  }
  
  getMemoryStats() {
    return {
      ...this.memoryStats,
      connectionCount: this.peers.size,
      awarenessStates: this.awareness.getStates().size
    }
  }

  destroy(): void {
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

        // Clear memory tracking\n    this.messageBuffer = []\n    this.memoryStats = { messageBuffer: 0, connectionCount: 0, lastCleanup: Date.now(), awarenessStates: 0 }\n

    this.connectionStatus = 'disconnected'
  }
}

export async function createFirebaseYWebrtcAdapter(opts: AdapterOptions): Promise<AdapterHandle> {
  const { 
    docId, 
    peerId = crypto.randomUUID(), 
    user = {}, 
    syncIntervalMs = 15_000,
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
  const maxAwarenessStates = 50
  
  // Memory monitoring for long-running sessions
  let lastMemoryCheck = Date.now()
  const memoryCheckInterval = 300_000 // 5 minutes

  // 2) Load persisted state from Firebase (if any)
  try {
    const loaded = await loadDocumentFromFirebase(docId, databasePaths)
    if (loaded) {
      Y.applyUpdate(ydoc, loaded)
    }
  } catch (e) {
    console.warn('Failed to load persisted Y document from Firebase', e)
  }

  // 3) Create peer info for Firebase presence
  const peerInfo: PeerInfo = {
    id: peerId,
    name: user.name || `User-${peerId.slice(0, 6)}`,
    color: user.color || '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0'),
    connectedAt: Date.now(),
  }

  // 4) Create SimplePeer manager
  const peerManager = new SimplePeerManager(docId, peerId, ydoc, awareness, databasePaths || { structure: 'flat', flat: { documents: '/documents', rooms: '/rooms', snapshots: '/snapshots', signaling: '/signaling' } })

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
    color: peerInfo.color,
    id: peerId
  })

  // 7) Announce presence in Firebase
  let presenceCleanup: (() => void) | null = null
  try {
    await announcePresence(docId, peerInfo, databasePaths)
    presenceCleanup = () => stopAnnouncingPresence(docId, peerId, databasePaths)
  } catch (e) {
    console.warn('Failed to announce presence in Firebase:', e)
  }

  // 8) Start periodic persistence
  const stopPersistence = startPeriodicPersistence(ydoc, docId, syncIntervalMs, databasePaths)

  // 9) Initialize peer connections
  await peerManager.initialize()

  // 10) Set up memory monitoring
  const memoryMonitorTimer = setInterval(() => {
    const now = Date.now()
    if (now - lastMemoryCheck > memoryCheckInterval) {
      lastMemoryCheck = now
      
      // Trigger Y.js garbage collection
      if (ydoc.gc) {
        const beforeSize = Y.encodeStateAsUpdate(ydoc).length
        // Force GC by encoding/decoding document state
        const state = Y.encodeStateAsUpdate(ydoc)
        const tempDoc = new Y.Doc()
        tempDoc.gc = true
        Y.applyUpdate(tempDoc, state)
        const afterSize = Y.encodeStateAsUpdate(tempDoc).length
        
        if (beforeSize !== afterSize) {
          console.log(`Y.js GC: reduced document size from ${beforeSize} to ${afterSize} bytes`)
        }
        tempDoc.destroy()
      }
      
      // Log memory stats
      const memStats = peerManager.getMemoryStats()
      console.log('Memory stats:', memStats)
      
      // Clean up awareness states if needed
      const awarenessStates = awareness.getStates()
      if (awarenessStates.size > maxAwarenessStates) {
        console.warn(`Too many awareness states (${awarenessStates.size}), cleaning up`)
        awareness.destroy() // This will clean up and recreate
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
    getPeerCount: () => peerManager.getPeerCount(),
    getConnectionStatus: () => peerManager.getConnectionStatus(),
    getUserInfo: () => peerInfo,
    getMemoryStats: () => peerManager.getMemoryStats(),
    forceGarbageCollection: () => {
      // Trigger immediate Y.js GC
      if (ydoc.gc) {
        const state = Y.encodeStateAsUpdate(ydoc)
        const tempDoc = new Y.Doc()
        tempDoc.gc = true
        Y.applyUpdate(tempDoc, state)
        tempDoc.destroy()
        console.log('Forced garbage collection completed')
      }
    }
  }
}

export default createFirebaseYWebrtcAdapter
