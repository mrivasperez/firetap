import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'

import { rtdb } from '../../firebase'
import { ref, set, get, remove, onValue, push, off, type DatabaseReference } from 'firebase/database'

export type PeerInfo = {
  id: string
  name: string
  color: string
  connectedAt: number
  clusterId?: string
  isCommonClient?: boolean
}

export type ClusterConfig = {
  maxDirectPeers: number
  connectionTimeout: number
  signalingTimeout: number
  heartbeatInterval: number
}

export type RTCSignalingData = {
  type: 'offer' | 'answer' | 'ice-candidate'
  data: unknown
  from: string
  to: string
  timestamp: number
}

const ROOMS_BASE = '/rooms'
const SIGNALING_BASE = '/signaling'

export class ClusterManager {
  private docId: string
  private peerInfo: PeerInfo
  private ydoc: Y.Doc
  private awareness: Awareness
  private config: ClusterConfig
  private clusterId: string
  private isCommonClient = false
  private peerConnections = new Map<string, RTCPeerConnection>()
  private connectedPeers = new Set<string>()
  private pendingConnections = new Set<string>()
  private signalingRef: DatabaseReference | null = null
  private presenceRef: DatabaseReference | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private messageHandlers = new Map<string, (message: { type: string; update?: number[] }) => void>()

  constructor(
    docId: string,
    peerInfo: PeerInfo,
    ydoc: Y.Doc,
    awareness: Awareness,
    config: Partial<ClusterConfig> = {}
  ) {
    this.docId = docId
    this.peerInfo = peerInfo
    this.ydoc = ydoc
    this.awareness = awareness
    this.config = {
      maxDirectPeers: 8,
      connectionTimeout: 30000,
      signalingTimeout: 10000,
      heartbeatInterval: 5000,
      ...config
    }
    this.clusterId = this.generateClusterId()
    
    this.setupDocumentHandlers()
  }

  async initialize(): Promise<void> {
    try {
      // 1. Announce presence in Firebase
      await this.announcePresence()
      
      // 2. Start listening for signaling messages
      this.setupSignalingListener()
      
      // 3. Discover and connect to peers
      await this.discoverAndConnectToPeers()
      
      // 4. Start heartbeat
      this.startHeartbeat()
      
      console.log(`ClusterManager initialized for peer ${this.peerInfo.id} in cluster ${this.clusterId}`)
    } catch (error) {
      console.error('Failed to initialize ClusterManager:', error)
      throw error
    }
  }

  private generateClusterId(): string {
    return `cluster-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
  }

  private async announcePresence(): Promise<void> {
    this.peerInfo.clusterId = this.clusterId
    this.presenceRef = ref(rtdb, `${ROOMS_BASE}/${this.docId}/peers/${this.peerInfo.id}`)
    await set(this.presenceRef, this.peerInfo)
  }

  private setupSignalingListener(): void {
    this.signalingRef = ref(rtdb, `${SIGNALING_BASE}/${this.docId}/${this.peerInfo.id}`)
    onValue(this.signalingRef, (snapshot) => {
      if (snapshot.exists()) {
        const messages = snapshot.val()
        Object.entries(messages).forEach(([key, message]) => {
          this.handleSignalingMessage(message as RTCSignalingData)
          // Clean up processed message
          remove(ref(rtdb, `${SIGNALING_BASE}/${this.docId}/${this.peerInfo.id}/${key}`))
        })
      }
    })
  }

  private async discoverAndConnectToPeers(): Promise<void> {
    const peersSnapshot = await get(ref(rtdb, `${ROOMS_BASE}/${this.docId}/peers`))
    if (!peersSnapshot.exists()) return

    const peers = peersSnapshot.val() as Record<string, PeerInfo>
    const otherPeers = Object.values(peers).filter(p => p.id !== this.peerInfo.id)
    
    // Determine cluster assignment and common client election
    await this.assignToCluster(otherPeers)
    
    // Connect to peers based on clustering strategy
    const peersToConnect = this.selectPeersToConnect(otherPeers)
    
    for (const peer of peersToConnect) {
      if (this.connectedPeers.size < this.config.maxDirectPeers && !this.pendingConnections.has(peer.id)) {
        // Use peer ID comparison to determine who initiates to avoid race conditions
        const shouldInitiate = this.peerInfo.id < peer.id
        if (shouldInitiate) {
          await this.connectToPeer(peer.id, true) // true = initiate connection
        }
      }
    }
  }

  private async assignToCluster(otherPeers: PeerInfo[]): Promise<void> {
    if (otherPeers.length === 0) {
      // First peer in the room becomes common client
      this.isCommonClient = true
      await this.electAsCommonClient()
      return
    }

    // Find existing clusters and their sizes
    const clusterSizes = new Map<string, number>()
    const commonClients = new Set<string>()
    
    otherPeers.forEach(peer => {
      if (peer.clusterId) {
        clusterSizes.set(peer.clusterId, (clusterSizes.get(peer.clusterId) || 0) + 1)
        if (peer.isCommonClient) {
          commonClients.add(peer.clusterId)
        }
      }
    })

    // Join smallest existing cluster or create new one if all clusters are full
    let targetCluster: string | null = null
    let minSize = this.config.maxDirectPeers

    for (const [clusterId, size] of clusterSizes.entries()) {
      if (size < minSize) {
        minSize = size
        targetCluster = clusterId
      }
    }

    if (targetCluster && minSize < this.config.maxDirectPeers) {
      this.clusterId = targetCluster
      this.peerInfo.clusterId = targetCluster
    }
    // else keep our generated cluster ID (create new cluster)

    // Update presence with cluster assignment
    await this.announcePresence()
  }

  private selectPeersToConnect(otherPeers: PeerInfo[]): PeerInfo[] {
    // Connect to peers in same cluster + common clients from other clusters
    const sameCusterPeers = otherPeers.filter(p => p.clusterId === this.clusterId)
    const otherCommonClients = otherPeers.filter(p => p.clusterId !== this.clusterId && p.isCommonClient)
    
    return [...sameCusterPeers, ...otherCommonClients].slice(0, this.config.maxDirectPeers)
  }

  private async connectToPeer(peerId: string, initiator: boolean): Promise<void> {
    if (this.peerConnections.has(peerId) || this.pendingConnections.has(peerId)) return
    
    this.pendingConnections.add(peerId)

    const peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    })

    this.peerConnections.set(peerId, peerConnection)

    // Set up data channel for Y.js sync
    const dataChannel = initiator 
      ? peerConnection.createDataChannel('yjs-sync', { ordered: false })
      : null

    peerConnection.ondatachannel = (event) => {
      const channel = event.channel
      this.setupDataChannel(channel, peerId)
    }

    if (dataChannel) {
      this.setupDataChannel(dataChannel, peerId)
    }

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignalingMessage(peerId, {
          type: 'ice-candidate',
          data: event.candidate,
          from: this.peerInfo.id,
          to: peerId,
          timestamp: Date.now()
        })
      }
    }

    peerConnection.onconnectionstatechange = () => {
      if (peerConnection.connectionState === 'connected') {
        this.connectedPeers.add(peerId)
        this.pendingConnections.delete(peerId)
        console.log(`Connected to peer ${peerId}`)
      } else if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed') {
        this.cleanupPeerConnection(peerId)
        console.log(`Disconnected from peer ${peerId}`)
      }
    }

    if (initiator) {
      const offer = await peerConnection.createOffer()
      await peerConnection.setLocalDescription(offer)
      
      this.sendSignalingMessage(peerId, {
        type: 'offer',
        data: offer,
        from: this.peerInfo.id,
        to: peerId,
        timestamp: Date.now()
      })
    }
  }

  private setupDataChannel(channel: RTCDataChannel, peerId: string): void {
    channel.onopen = () => {
      console.log(`Data channel opened with peer ${peerId}`)
      // Send current document state to newly connected peer
      const stateVector = Y.encodeStateVector(this.ydoc)
      const update = Y.encodeStateAsUpdate(this.ydoc, stateVector)
      if (update.length > 0) {
        this.sendMessage(channel, { type: 'sync-update', update: Array.from(update) })
      }
    }

    channel.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        this.handlePeerMessage(message)
      } catch (error) {
        console.error('Failed to parse peer message:', error)
      }
    }

    channel.onerror = (error) => {
      console.error(`Data channel error with peer ${peerId}:`, error)
    }

    // Store channel for sending messages
    this.messageHandlers.set(peerId, (message) => {
      if (channel.readyState === 'open') {
        channel.send(JSON.stringify(message))
      }
    })
  }

  private async handleSignalingMessage(message: RTCSignalingData): Promise<void> {
    const { type, data, from } = message
    
    try {
      if (type === 'offer') {
        await this.handleOffer(from, data as RTCSessionDescriptionInit)
      } else if (type === 'answer') {
        await this.handleAnswer(from, data as RTCSessionDescriptionInit)
      } else if (type === 'ice-candidate') {
        await this.handleIceCandidate(from, data as RTCIceCandidateInit)
      }
    } catch (error) {
      console.error(`Signaling error with peer ${from}:`, error)
      // Clean up failed connection
      this.cleanupPeerConnection(from)
    }
  }

  private async handleOffer(peerId: string, offer: RTCSessionDescriptionInit): Promise<void> {
    let peerConnection = this.peerConnections.get(peerId)
    
    if (!peerConnection) {
      // Create new connection for incoming offer
      await this.connectToPeer(peerId, false)
      peerConnection = this.peerConnections.get(peerId)
    }
    
    if (!peerConnection) {
      console.error(`Failed to create peer connection for ${peerId}`)
      return
    }
    
    // Check connection state to avoid conflicts
    if (peerConnection.signalingState === 'have-local-offer') {
      // Handle offer collision - lower ID wins
      if (this.peerInfo.id < peerId) {
        console.log(`Offer collision with ${peerId}, ignoring their offer (we have priority)`)
        return
      } else {
        console.log(`Offer collision with ${peerId}, restarting connection`)
        peerConnection.close()
        this.peerConnections.delete(peerId)
        await this.connectToPeer(peerId, false)
        peerConnection = this.peerConnections.get(peerId)
        if (!peerConnection) return
      }
    }
    
    await peerConnection.setRemoteDescription(offer)
    const answer = await peerConnection.createAnswer()
    await peerConnection.setLocalDescription(answer)
    
    this.sendSignalingMessage(peerId, {
      type: 'answer',
      data: answer,
      from: this.peerInfo.id,
      to: peerId,
      timestamp: Date.now()
    })
  }
  
  private async handleAnswer(peerId: string, answer: RTCSessionDescriptionInit): Promise<void> {
    const peerConnection = this.peerConnections.get(peerId)
    if (!peerConnection) {
      console.warn(`Received answer from unknown peer ${peerId}`)
      return
    }
    
    if (peerConnection.signalingState === 'have-local-offer') {
      await peerConnection.setRemoteDescription(answer)
    } else {
      console.warn(`Received answer in unexpected state: ${peerConnection.signalingState}`)
    }
  }
  
  private async handleIceCandidate(peerId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const peerConnection = this.peerConnections.get(peerId)
    if (!peerConnection) {
      console.warn(`Received ICE candidate from unknown peer ${peerId}`)
      return
    }
    
    if (peerConnection.remoteDescription) {
      await peerConnection.addIceCandidate(candidate)
    } else {
      console.warn(`Received ICE candidate before remote description for peer ${peerId}`)
    }
  }

  private async sendSignalingMessage(targetPeerId: string, message: RTCSignalingData): Promise<void> {
    const messageRef = push(ref(rtdb, `${SIGNALING_BASE}/${this.docId}/${targetPeerId}`))
    await set(messageRef, message)
  }

  private handlePeerMessage(message: { type: string; update?: number[] }): void {
    if (message.type === 'sync-update' && message.update) {
      const update = new Uint8Array(message.update)
      Y.applyUpdate(this.ydoc, update)
    } else if (message.type === 'awareness-update' && message.update) {
      // Apply awareness update using the awareness API
      const states = new Map()
      states.set(0, { user: { name: 'Remote User' } })
      // Note: In a real implementation, you'd properly decode the awareness update
    }
  }

  private sendMessage(channel: RTCDataChannel | null, message: { type: string; update?: number[] }): void {
    if (channel && channel.readyState === 'open') {
      channel.send(JSON.stringify(message))
    }
  }

  private broadcastToConnectedPeers(message: { type: string; update?: number[] }): void {
    this.messageHandlers.forEach((sendMessage) => {
      sendMessage(message)
    })
  }

  private setupDocumentHandlers(): void {
    // Y.js document update handler
    this.ydoc.on('update', (update: Uint8Array) => {
      this.broadcastToConnectedPeers({
        type: 'sync-update',
        update: Array.from(update)
      })
    })

    // Awareness update handler
    this.awareness.on('update', () => {
      // Broadcast awareness changes to connected peers
      // Note: In a real implementation, you'd properly encode awareness updates
      this.broadcastToConnectedPeers({
        type: 'awareness-update',
        update: []
      })
    })
  }

  private async electAsCommonClient(): Promise<void> {
    this.isCommonClient = true
    this.peerInfo.isCommonClient = true
    await this.announcePresence()
    console.log(`Elected as common client for cluster ${this.clusterId}`)
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(async () => {
      try {
        // Update presence timestamp
        await this.announcePresence()
        
        // Clean up dead connections
        this.cleanupDeadConnections()
      } catch (error) {
        console.error('Heartbeat error:', error)
      }
    }, this.config.heartbeatInterval)
  }

  private cleanupPeerConnection(peerId: string): void {
    this.connectedPeers.delete(peerId)
    this.pendingConnections.delete(peerId)
    this.messageHandlers.delete(peerId)
    
    const pc = this.peerConnections.get(peerId)
    if (pc) {
      pc.close()
      this.peerConnections.delete(peerId)
    }
  }
  
  private cleanupDeadConnections(): void {
    this.peerConnections.forEach((pc, peerId) => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.cleanupPeerConnection(peerId)
      }
    })
  }

  // Public API methods
  getConnectedPeers(): string[] {
    return Array.from(this.connectedPeers)
  }

  getClusterInfo(): { clusterId: string; peers: PeerInfo[]; isCommonClient: boolean } {
    return {
      clusterId: this.clusterId,
      peers: [this.peerInfo], // Could be extended to track cluster peers
      isCommonClient: this.isCommonClient
    }
  }

  destroy(): void {
    // Clean up timers
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
    }

    // Close all peer connections
    this.peerConnections.forEach((_, peerId) => {
      this.cleanupPeerConnection(peerId)
    })
    this.peerConnections.clear()
    this.connectedPeers.clear()
    this.pendingConnections.clear()
    this.messageHandlers.clear()

    // Remove Firebase listeners
    if (this.signalingRef) {
      off(this.signalingRef)
    }

    // Remove presence
    if (this.presenceRef) {
      remove(this.presenceRef).catch(e => console.warn('Failed to remove presence:', e))
    }

    console.log(`ClusterManager destroyed for peer ${this.peerInfo.id}`)
  }
}
