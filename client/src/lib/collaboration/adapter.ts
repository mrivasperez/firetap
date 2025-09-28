import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import SimplePeer from 'simple-peer'
import { startPeriodicPersistence, loadDocumentFromFirebase } from './persistence'
import { announcePresence, stopAnnouncingPresence, type PeerInfo } from './simple-cluster'
import { rtdb } from '../../firebase'
import { ref, set, remove, onValue, push, off } from 'firebase/database'
import { encodeAwarenessUpdate, applyAwarenessUpdate } from 'y-protocols/awareness'

export type AdapterOptions = {
  docId: string
  peerId?: string
  user?: { name?: string; color?: string }
  syncIntervalMs?: number
  maxDirectPeers?: number
}

export type AdapterHandle = {
  ydoc: Y.Doc
  awareness: Awareness
  disconnect: () => void
  getPeerCount: () => number
  getConnectionStatus: () => 'connecting' | 'connected' | 'disconnected'
  getUserInfo: () => PeerInfo
}

type SignalData = {
  type: 'offer' | 'answer' | 'signal'
  signal: unknown
  from: string
  to: string
  timestamp: number
}

const SIGNALING_BASE = '/signaling'

class SimplePeerManager {
  private docId: string
  private peerId: string
  private ydoc: Y.Doc
  private awareness: Awareness
  private peers = new Map<string, SimplePeer.Instance>()
  private signalingRef: ReturnType<typeof ref> | null = null
  private connectionStatus: 'connecting' | 'connected' | 'disconnected' = 'connecting'
  
  constructor(docId: string, peerId: string, ydoc: Y.Doc, awareness: Awareness) {
    this.docId = docId
    this.peerId = peerId
    this.ydoc = ydoc
    this.awareness = awareness
  }

  async initialize(): Promise<void> {
    // Set up signaling listener
    this.signalingRef = ref(rtdb, `${SIGNALING_BASE}/${this.docId}/${this.peerId}`)
    onValue(this.signalingRef, (snapshot) => {
      if (snapshot.exists()) {
        const signals = snapshot.val()
        Object.entries(signals).forEach(([key, signal]) => {
          this.handleSignalData(signal as SignalData)
          // Clean up processed signal
          remove(ref(rtdb, `${SIGNALING_BASE}/${this.docId}/${this.peerId}/${key}`))
        })
      }
    })

    // Listen for other peers joining
    const peersRef = ref(rtdb, `/rooms/${this.docId}/peers`)
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
        if (message.type === 'sync' && message.update) {
          Y.applyUpdate(this.ydoc, new Uint8Array(message.update))
        } else if (message.type === 'awareness' && message.update) {
          // Apply awareness updates from peer
          const awarenessUpdate = new Uint8Array(message.update)
          applyAwarenessUpdate(this.awareness, awarenessUpdate, null)
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
    
    const messageRef = push(ref(rtdb, `${SIGNALING_BASE}/${this.docId}/${targetPeerId}`))
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

  destroy(): void {
    // Close all peer connections
    this.peers.forEach(peer => peer.destroy())
    this.peers.clear()

    // Remove Firebase listeners
    if (this.signalingRef) {
      off(this.signalingRef)
    }

    this.connectionStatus = 'disconnected'
  }
}

export async function createFirebaseYWebrtcAdapter(opts: AdapterOptions): Promise<AdapterHandle> {
  const { 
    docId, 
    peerId = crypto.randomUUID(), 
    user = {}, 
    syncIntervalMs = 15_000
  } = opts

  // 1) Create the Y.Doc and Awareness
  const ydoc = new Y.Doc()
  const awareness = new Awareness(ydoc)

  // 2) Load persisted state from Firebase (if any)
  try {
    const loaded = await loadDocumentFromFirebase(docId)
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
  const peerManager = new SimplePeerManager(docId, peerId, ydoc, awareness)

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
    await announcePresence(docId, peerInfo)
    presenceCleanup = () => stopAnnouncingPresence(docId, peerId)
  } catch (e) {
    console.warn('Failed to announce presence in Firebase:', e)
  }

  // 8) Start periodic persistence
  const stopPersistence = startPeriodicPersistence(ydoc, docId, syncIntervalMs)

  // 9) Initialize peer connections
  await peerManager.initialize()

  // 10) Wire cleanup
  const disconnect = () => {
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
      awareness.destroy()
    } catch (e) {
      console.warn('Awareness destroy error:', e)
    }
  }

  return { 
    ydoc, 
    awareness,
    disconnect,
    getPeerCount: () => peerManager.getPeerCount(),
    getConnectionStatus: () => peerManager.getConnectionStatus(),
    getUserInfo: () => peerInfo
  }
}

export default createFirebaseYWebrtcAdapter
