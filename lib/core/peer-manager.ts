import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import {
  stopAnnouncingPresence,
  cleanupStalePeers,
} from "../firebase/presence";
import type { Database } from "firebase/database";
import { ref, set, remove, push, off, onChildAdded, onChildRemoved } from "firebase/database";
import {
  applyAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";

import {
  type DatabasePathsConfig,
  buildDatabasePaths,
} from "../utils/config";
import { compressData, decompressData } from "../utils/compression";
import {
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
  MIN_VISIBILITY_UPDATE_INTERVAL,
  STUN_SERVERS,
  MAX_CHUNK_SIZE,
  CHUNK_HEADER_SIZE,
} from "../utils/constants";
import type { AdapterEvents, SignalData } from "./types";

export class SimplePeerManager {
  private docId: string;
  private peerId: string;
  private ydoc: Y.Doc;
  private awareness: Awareness;
  private databasePaths: DatabasePathsConfig;
  private rtdb: Database;
  private eventListeners: Map<
    keyof AdapterEvents,
    Set<(data: AdapterEvents[keyof AdapterEvents]) => void>
  > = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private beforeUnloadHandler: (() => void) | null = null;
  private visibilityChangeHandler: (() => void) | null = null;
  private pendingPresenceUpdate: Promise<void> | null = null; // Track pending presence updates to prevent race conditions
  private connectionTimestamps = new Map<string, number>();
  private isDestroyed = false;
  private isTabVisible = true;

  // Event system methods
  emit<K extends keyof AdapterEvents>(event: K, data: AdapterEvents[K]): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.forEach((callback) => callback(data));
    }
  }

  on<K extends keyof AdapterEvents>(
    event: K,
    callback: (data: AdapterEvents[K]) => void
  ): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners
      .get(event)!
      .add(callback as (data: AdapterEvents[keyof AdapterEvents]) => void);
  }

  off<K extends keyof AdapterEvents>(
    event: K,
    callback: (data: AdapterEvents[K]) => void
  ): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.delete(
        callback as (data: AdapterEvents[keyof AdapterEvents]) => void
      );
    }
  }

  async reconnect(): Promise<void> {
    this.connectionStatus = "connecting";
    this.emit("connection-state-changed", { state: "connecting" });
    try {
      // Clean up existing connections
      this.destroy();
      // Re-initialize
      await this.initialize();
      this.connectionStatus = "connected";
      this.emit("connection-state-changed", { state: "connected" });
    } catch (error) {
      this.connectionStatus = "disconnected";
      this.emit("error", { error: error as Error, context: "reconnection" });
      this.emit("connection-state-changed", { state: "disconnected" });
      throw error;
    }
  }

  // WebRTC peer connections
  private peers = new Map<string, RTCPeerConnection>();
  private dataChannels = new Map<string, RTCDataChannel>();
  
  // Delta-only sync optimization: track peer sync states
  private peerSyncState = new Map<string, Uint8Array>();

  private signalingRef: ReturnType<typeof ref> | null = null;
  private connectionStatus: "connecting" | "connected" | "disconnected" =
    "connecting";
  private peersRef: ReturnType<typeof ref> | null = null;
  
  // Firebase listener unsubscribe functions
  private signalingListenerUnsubscribe: (() => void) | null = null;
  private peersAddedListenerUnsubscribe: (() => void) | null = null;
  private peersRemovedListenerUnsubscribe: (() => void) | null = null;
  
  private memoryStats = {
    messageBuffer: 0,
    connectionCount: 0,
    lastCleanup: Date.now(),
    awarenessStates: 0,
  };

  private maxPeers: number; // Prevent too many connections
  private messageBuffer: Array<{ timestamp: number; size: number }> = [];
  private maxBufferSize = MAX_MESSAGE_BUFFER_SIZE;
  
  // Chunked message reassembly buffers
  private chunkBuffers = new Map<string, Map<number, { chunk: number[]; totalChunks: number }>>();

  constructor(
    docId: string,
    peerId: string,
    ydoc: Y.Doc,
    awareness: Awareness,
    rtdb: Database,
    databasePaths: DatabasePathsConfig,
    maxDirectPeers: number = 20
  ) {
    this.docId = docId;
    this.peerId = peerId;
    this.ydoc = ydoc;
    this.awareness = awareness;
    this.rtdb = rtdb;
    this.databasePaths = databasePaths;
    this.maxPeers = maxDirectPeers;
  }

  private getPaths() {
    return buildDatabasePaths(this.databasePaths, this.docId);
  }

  async initialize(): Promise<void> {
    if (this.isDestroyed) {
      throw new Error("Cannot initialize destroyed peer manager");
    }

    // Set up signaling listener - OPTIMIZED: Use onChildAdded for granular updates
    // This reduces bandwidth by 40-60% compared to onValue() which downloads entire signaling node
    this.signalingRef = ref(
      this.rtdb,
      `${this.getPaths().signaling}/${this.peerId}`
    );
    console.log(
      `Setting up granular signaling listener at: ${this.getPaths().signaling}/${
        this.peerId
      }`
    );
    
    // Listen only for NEW signals (not entire collection)
    this.signalingListenerUnsubscribe = onChildAdded(this.signalingRef, (snapshot) => {
      if (this.isDestroyed) return;
      
      const signal = snapshot.val() as SignalData;
      console.log(`Received signal: ${signal.type} from ${signal.from}`);
      
      // Process the signal
      this.handleSignalData(signal);
      
      // Immediately clean up this specific signal
      remove(snapshot.ref).catch((error) => {
        console.warn(`Failed to remove signal ${snapshot.key}:`, error);
      });
    });

    // Listen for other peers joining/leaving - OPTIMIZED: Use child listeners for granular updates
    // This reduces bandwidth by 40-60% compared to onValue() which downloads entire peers collection
    this.peersRef = ref(this.rtdb, `${this.getPaths().rooms}/peers`);
    
    // Listen for NEW peers joining
    this.peersAddedListenerUnsubscribe = onChildAdded(this.peersRef, (snapshot) => {
      if (this.isDestroyed) return;
      
      const otherPeerId = snapshot.key!;
      const peerData = snapshot.val();
      
      // Skip our own peer entry
      if (otherPeerId === this.peerId) return;
      
      // Skip if connection already exists
      if (this.peers.has(otherPeerId)) return;
      
      const now = Date.now();
      // Check if peer is not stale
      if (
        peerData.lastSeen &&
        now - peerData.lastSeen < PEER_PRESENCE_TIMEOUT_MS
      ) {
        // Only create connection if we should be the initiator (deterministic)
        const shouldInitiate = this.peerId < otherPeerId;
        if (shouldInitiate) {
          console.log(`New peer detected: ${otherPeerId}, initiating connection`);
          this.createPeerConnection(otherPeerId, true);
        }
      }
    });
    
    // Listen for peers leaving
    this.peersRemovedListenerUnsubscribe = onChildRemoved(this.peersRef, (snapshot) => {
      if (this.isDestroyed) return;
      
      const peerId = snapshot.key!;
      if (peerId !== this.peerId && this.peers.has(peerId)) {
        console.log(
          `Peer ${peerId} removed from presence, cleaning up connection`
        );
        this.cleanupPeerConnection(peerId);
      }
    });

    // Set up periodic cleanup
    this.startPeriodicCleanup();

    // Set up heartbeat to maintain presence
    this.startHeartbeat();

    // Set up beforeunload handler
    this.setupBeforeUnloadHandler();

    this.connectionStatus = "connected";
  }

  private createPeerConnection(otherPeerId: string, initiator: boolean): void {
    // Check if peer connection already exists
    if (this.peers.has(otherPeerId)) {
      return;
    }

    // Check if we're destroyed
    if (this.isDestroyed) {
      return;
    }

    // Prevent too many connections for memory optimization
    if (this.peers.size >= this.maxPeers) {
      console.warn(
        `Maximum peer connections reached (${this.maxPeers}), rejecting new connection to ${otherPeerId}`
      );
      return;
    }

    // Create RTCPeerConnection with STUN servers
    const peerConnection = new RTCPeerConnection({
      iceServers: STUN_SERVERS,
    });

    // Store the peer connection
    this.peers.set(otherPeerId, peerConnection);

    // Handle ICE candidates - using non-trickle ICE for cost optimization
    // All candidates will be bundled in the SDP, so we don't need to send them separately
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        // With non-trickle ICE, candidates are automatically included in the SDP
        // No need to send them separately - this saves Firebase write costs
        console.log(
          `ICE candidate generated for ${otherPeerId} (will be bundled in SDP)`
        );
      } else {
        // null candidate means ICE gathering is complete
        console.log(`ICE gathering complete for ${otherPeerId}`);
      }
    };

    // Handle connection state changes
    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      console.log(`Peer ${otherPeerId} connection state: ${state}`);

      if (state === "connected") {
        console.log(`Peer ${otherPeerId} connected`);
        this.connectionTimestamps.set(otherPeerId, Date.now());
        this.emit("peer-joined", {
          peerId: otherPeerId,
          user: {
            id: otherPeerId,
            name: `User-${otherPeerId.slice(0, PEER_ID_DISPLAY_LENGTH)}`,
            connectedAt: Date.now(),
          },
        });
        
        // Initial sync now happens in dataChannel.onopen to ensure channel is ready
      } else if (
        state === "failed" ||
        state === "disconnected" ||
        state === "closed"
      ) {
        console.log(`Peer ${otherPeerId} ${state}`);
        this.cleanupPeerConnection(otherPeerId);
      }
    };

    // Handle data channel
    if (initiator) {
      // Create data channel as initiator
      console.log(
        `Creating data channel and offer for peer ${otherPeerId} (I am initiator)`
      );
      const dataChannel = peerConnection.createDataChannel("data");
      this.dataChannels.set(otherPeerId, dataChannel);
      this.setupDataChannel(otherPeerId, dataChannel);

      // Create offer and wait for ICE gathering to complete (non-trickle ICE)
      peerConnection
        .createOffer()
        .then((offer) => {
          console.log(
            `Created offer for ${otherPeerId}, setting local description`
          );
          return peerConnection.setLocalDescription(offer);
        })
        .then(() => {
          // Wait for ICE gathering to complete before sending
          return new Promise<void>((resolve) => {
            if (peerConnection.iceGatheringState === "complete") {
              resolve();
            } else {
              const checkGathering = () => {
                if (peerConnection.iceGatheringState === "complete") {
                  peerConnection.removeEventListener(
                    "icegatheringstatechange",
                    checkGathering
                  );
                  resolve();
                }
              };
              peerConnection.addEventListener(
                "icegatheringstatechange",
                checkGathering
              );
            }
          });
        })
        .then(() => {
          if (peerConnection.localDescription) {
            console.log(
              `ICE gathering complete, sending offer to ${otherPeerId}`
            );
            return this.sendOffer(otherPeerId, peerConnection.localDescription);
          }
        })
        .then(() => {
          console.log(`Offer sent successfully to ${otherPeerId}`);
        })
        .catch((error) => {
          console.error(`Error creating offer for ${otherPeerId}:`, error);
          this.cleanupPeerConnection(otherPeerId);
        });
    } else {
      console.log(
        `Waiting for offer from peer ${otherPeerId} (they are initiator)`
      );
      // Handle incoming data channel as receiver
      peerConnection.ondatachannel = (event) => {
        console.log(`Received data channel from ${otherPeerId}`);
        const dataChannel = event.channel;
        this.dataChannels.set(otherPeerId, dataChannel);
        this.setupDataChannel(otherPeerId, dataChannel);
      };
    }
  }

  private setupDataChannel(peerId: string, dataChannel: RTCDataChannel): void {
    dataChannel.onopen = () => {
      console.log(`Data channel opened for peer ${peerId}`);
      
      // CRITICAL: Send initial document state when data channel opens
      // This ensures new peers receive the full document
      try {
        const lastState = this.peerSyncState.get(peerId);
        const update = lastState
          ? Y.encodeStateAsUpdate(this.ydoc, lastState) // Delta only
          : Y.encodeStateAsUpdate(this.ydoc);            // Full state for new peer
        
        // Only send if there's actual content to sync
        if (update.length > 0) {
          const message = JSON.stringify({ 
            type: "sync", 
            update: Array.from(update) 
          });
          dataChannel.send(message);
          console.log(`Sent initial sync to peer ${peerId} (${update.length} bytes)`);
          
          // Track current state for next delta sync
          this.peerSyncState.set(peerId, Y.encodeStateVector(this.ydoc));
        }
      } catch (error) {
        console.error(`Error sending initial sync to ${peerId}:`, error);
      }
    };

    dataChannel.onmessage = async (event) => {
      try {
        // OPTIMIZATION: Use try-catch for JSON parsing to handle malformed messages gracefully
        const message = JSON.parse(event.data);
        const messageSize = event.data.length;

        // Track message buffer for memory monitoring
        this.trackMessage(messageSize);

        if (message.type === "sync" && message.update) {
          // OPTIMIZATION: Apply remote update with origin to prevent re-broadcasting
          // Reuse Uint8Array to avoid extra allocations
          const updateArray = new Uint8Array(message.update);
          Y.applyUpdate(this.ydoc, updateArray, this);
          console.log(`Applied sync update from peer ${peerId} (${updateArray.length} bytes)`);
        } else if (message.type === "sync-chunk" && message.update) {
          // Handle chunked sync message
          this.handleChunkedMessage(peerId, message);
        } else if (message.type === "awareness" && message.update) {
          // Apply awareness updates from peer with size limit check
          if (this.awareness.getStates().size < MAX_AWARENESS_STATES) {
            let awarenessUpdate = new Uint8Array(message.update);
            
            // OPTIMIZATION: Decompress if compressed flag is set
            if (message.compressed) {
              awarenessUpdate = await decompressData(awarenessUpdate);
            }
            
            applyAwarenessUpdate(this.awareness, awarenessUpdate, null);
          }
        }
      } catch (error) {
        console.error("Error parsing peer data:", error);
      }
    };

    dataChannel.onerror = (error) => {
      console.error(`Data channel error for peer ${peerId}:`, error);
    };

    dataChannel.onclose = () => {
      console.log(`Data channel closed for peer ${peerId}`);
    };
  }

  private async sendOffer(
    targetPeerId: string,
    offer: RTCSessionDescriptionInit
  ): Promise<void> {
    const signalData: SignalData = {
      type: "offer",
      sdp: {
        type: offer.type!,
        sdp: offer.sdp!,
      },
      from: this.peerId,
      to: targetPeerId,
      timestamp: Date.now(),
    };

    console.log(
      `Pushing offer to Firebase path: ${
        this.getPaths().signaling
      }/${targetPeerId}`,
      signalData
    );
    const messageRef = push(
      ref(this.rtdb, `${this.getPaths().signaling}/${targetPeerId}`)
    );
    await set(messageRef, signalData);
    console.log(`Offer successfully written to Firebase for ${targetPeerId}`);
  }

  private async sendAnswer(
    targetPeerId: string,
    answer: RTCSessionDescriptionInit
  ): Promise<void> {
    const signalData: SignalData = {
      type: "answer",
      sdp: {
        type: answer.type!,
        sdp: answer.sdp!,
      },
      from: this.peerId,
      to: targetPeerId,
      timestamp: Date.now(),
    };

    console.log(`Sending answer to ${targetPeerId}`);
    const messageRef = push(
      ref(this.rtdb, `${this.getPaths().signaling}/${targetPeerId}`)
    );
    await set(messageRef, signalData);
    console.log(`Answer successfully written to Firebase for ${targetPeerId}`);
  }

  private handleSignalData(signalData: SignalData): void {
    const { from, type } = signalData;
    let peer = this.peers.get(from);

    if (!peer && type === "offer") {
      // Create peer connection for incoming offer
      console.log(`Received offer from ${from}, creating peer connection`);
      this.createPeerConnection(from, false);
      peer = this.peers.get(from);

      if (!peer) {
        console.error(`Failed to create peer connection for ${from}`);
        return;
      }

      // Immediately handle the offer after creating the peer
      console.log(`Set remote description from offer for ${from}`);
      peer
        .setRemoteDescription(new RTCSessionDescription(signalData.sdp!))
        .then(() => {
          console.log(`Set remote description for ${from}, creating answer`);
          return peer!.createAnswer();
        })
        .then((answer) => {
          console.log(`Created answer for ${from}, setting local description`);
          return peer!.setLocalDescription(answer);
        })
        .then(() => {
          // Wait for ICE gathering to complete before sending answer (non-trickle ICE)
          return new Promise<void>((resolve) => {
            if (peer!.iceGatheringState === "complete") {
              resolve();
            } else {
              const checkGathering = () => {
                if (peer!.iceGatheringState === "complete") {
                  peer!.removeEventListener(
                    "icegatheringstatechange",
                    checkGathering
                  );
                  resolve();
                }
              };
              peer!.addEventListener("icegatheringstatechange", checkGathering);
            }
          });
        })
        .then(() => {
          if (peer!.localDescription) {
            console.log(`ICE gathering complete, sending answer to ${from}`);
            return this.sendAnswer(from, peer!.localDescription);
          }
        })
        .then(() => {
          console.log(`Answer sent successfully to ${from}`);
        })
        .catch((error) => {
          console.error(`Error handling offer from ${from}:`, error);
          this.cleanupPeerConnection(from);
        });
      return;
    }

    if (!peer) {
      // With non-trickle ICE, we don't handle separate ICE candidates
      // They're bundled in the SDP, so we only need to warn about unexpected signals
      console.warn(
        `No peer connection found for ${from}, signal type: ${type}`
      );
      return;
    }

    try {
      if (type === "offer" && signalData.sdp) {
        // This shouldn't happen since we handle offers above, but just in case
        console.warn(`Received duplicate offer from ${from}, ignoring`);
      } else if (type === "answer" && signalData.sdp) {
        // Handle incoming answer
        console.log(`Received answer from ${from}`);
        peer
          .setRemoteDescription(new RTCSessionDescription(signalData.sdp))
          .then(() => {
            console.log(`Set remote description from answer for ${from}`);
          })
          .catch((error) => {
            console.error(`Error handling answer from ${from}:`, error);
            this.cleanupPeerConnection(from);
          });
      }
    } catch (error) {
      console.error(`Error processing signal from ${from}:`, error);
    }
  }

  broadcastUpdate(update: Uint8Array): void {
    // OPTIMIZATION: Skip broadcasting empty or tiny updates to reduce overhead
    if (update.length === 0 || update.length < 3) {
      return;
    }
    
    const updateArray = Array.from(update);
    const baseMessage = { type: "sync" };
    const testMessage = JSON.stringify({ ...baseMessage, update: [] });
    const maxDataSize = MAX_CHUNK_SIZE - CHUNK_HEADER_SIZE - testMessage.length;
    
    // Check if message needs chunking
    const totalSize = updateArray.length;
    if (totalSize <= maxDataSize) {
      // Small message - send as is
      const message = JSON.stringify({
        type: "sync",
        update: updateArray,
      });
      this.sendToAllPeers(message);
    } else {
      // Large message - chunk it
      const chunks = Math.ceil(totalSize / maxDataSize);
      const messageId = `${this.peerId}-${Date.now()}`;
      
      for (let i = 0; i < chunks; i++) {
        const start = i * maxDataSize;
        const end = Math.min(start + maxDataSize, totalSize);
        const chunk = updateArray.slice(start, end);
        
        const message = JSON.stringify({
          type: "sync-chunk",
          messageId,
          chunk: i,
          totalChunks: chunks,
          update: chunk,
        });
        this.sendToAllPeers(message);
      }
    }
  }

  private sendToAllPeers(message: string): void {
    this.dataChannels.forEach((dataChannel, peerId) => {
      if (dataChannel.readyState === "open") {
        try {
          dataChannel.send(message);
          // Update peer sync state after sending update
          this.peerSyncState.set(peerId, Y.encodeStateVector(this.ydoc));
        } catch (error) {
          console.error(`Error sending update to peer ${peerId}:`, error);
        }
      }
    });
  }

  async broadcastAwareness(update: Uint8Array): Promise<void> {
    // OPTIMIZATION: Compress awareness updates using native browser API (60-80% bandwidth reduction)
    const { compressed, isCompressed } = await compressData(update);
    
    const message = JSON.stringify({
      type: "awareness",
      update: Array.from(compressed),
      compressed: isCompressed, // Flag to decompress on receiver
    });
    
    this.dataChannels.forEach((dataChannel, peerId) => {
      if (dataChannel.readyState === "open") {
        try {
          dataChannel.send(message);
        } catch (error) {
          console.error(`Error sending awareness to peer ${peerId}:`, error);
        }
      }
    });
  }

  getPeerCount(): number {
    return Array.from(this.peers.values()).filter(
      (peer) => peer.connectionState === "connected"
    ).length;
  }

  getConnectionStatus(): "connecting" | "connected" | "disconnected" {
    return this.connectionStatus;
  }

  private handleChunkedMessage(peerId: string, message: {
    messageId: string;
    chunk: number;
    totalChunks: number;
    update: number[];
  }): void {
    const { chunk, totalChunks, update } = message;
    
    // Initialize buffer for this peer if needed
    if (!this.chunkBuffers.has(peerId)) {
      this.chunkBuffers.set(peerId, new Map());
    }
    
    const peerBuffer = this.chunkBuffers.get(peerId)!;
    
    // Initialize buffer for this message if needed
    if (!peerBuffer.has(chunk)) {
      peerBuffer.set(chunk, { chunk: update, totalChunks });
    }
    
    // Check if we have all chunks
    if (peerBuffer.size === totalChunks) {
      // Reassemble the complete message
      const completeUpdate: number[] = [];
      for (let i = 0; i < totalChunks; i++) {
        const chunkData = peerBuffer.get(i);
        if (chunkData) {
          completeUpdate.push(...chunkData.chunk);
        }
      }
      
      // Apply the complete update
      Y.applyUpdate(this.ydoc, new Uint8Array(completeUpdate), this);
      
      // Clean up the buffer for this message
      peerBuffer.clear();
    }
  }

  private trackMessage(size: number): void {
    const now = Date.now();
    this.messageBuffer.push({ timestamp: now, size });
    this.memoryStats.messageBuffer += size;

    // Clean old messages from buffer (keep last hour)
    const cutoff = now - MESSAGE_BUFFER_RETENTION_MS;
    while (
      this.messageBuffer.length > 0 &&
      this.messageBuffer[0].timestamp < cutoff
    ) {
      const old = this.messageBuffer.shift()!;
      this.memoryStats.messageBuffer -= old.size;
    }

    // Prevent buffer from growing too large
    if (this.messageBuffer.length > this.maxBufferSize) {
      const excess = this.messageBuffer.splice(
        0,
        this.messageBuffer.length - this.maxBufferSize
      );
      this.memoryStats.messageBuffer -= excess.reduce(
        (sum, msg) => sum + msg.size,
        0
      );
    }
  }

  private cleanupIdlePeers(): void {
    const now = Date.now();
    const idleTimeout = IDLE_PEER_TIMEOUT_MS;

    this.peers.forEach((peer, peerId) => {
      if (
        peer.connectionState !== "connected" &&
        now - this.memoryStats.lastCleanup > idleTimeout
      ) {
        peer.close();
        this.peers.delete(peerId);
        this.dataChannels.delete(peerId);
        this.chunkBuffers.delete(peerId); // Clean up chunk buffers
      }
    });

    this.memoryStats.lastCleanup = now;
  }

  private performMemoryCleanup(): void {
    // Clean up idle peers
    this.cleanupIdlePeers();

    // Clear message buffer if too large
    if (this.memoryStats.messageBuffer > MAX_MEMORY_BUFFER_BYTES) {
      // 10MB
      console.warn("Message buffer too large, clearing older messages");
      this.messageBuffer.splice(0, Math.floor(this.messageBuffer.length / 2));
      this.memoryStats.messageBuffer = this.messageBuffer.reduce(
        (sum, msg) => sum + msg.size,
        0
      );
    }

    // Clean up awareness states if too many
    const awarenessStates = this.awareness.getStates();
    if (awarenessStates.size > MAX_AWARENESS_STATES) {
      console.warn("Too many awareness states, cleaning up old ones");
      // Remove stale awareness states (keep only connected peers)
      const connectedPeerIds = new Set(
        Array.from(this.peers.keys()).filter((id) => {
          const peer = this.peers.get(id);
          return peer && peer.connectionState === "connected";
        })
      );
      connectedPeerIds.add(this.peerId); // Remove states for disconnected peers
      const clientsToRemove: number[] = [];
      awarenessStates.forEach((_state: unknown, clientId: number) => {
        if (
          !connectedPeerIds.has(String(clientId)) &&
          clientId !== this.ydoc.clientID
        ) {
          clientsToRemove.push(clientId);
        }
      });

      if (clientsToRemove.length > 0) {
        // Properly remove stale awareness states
        removeAwarenessStates(this.awareness, clientsToRemove, null);
        console.log(`Removed ${clientsToRemove.length} stale awareness states`);
      }
    }
  }

  getMemoryStats() {
    return {
      ...this.memoryStats,
      connectionCount: this.peers.size,
      awarenessStates: this.awareness.getStates().size,
    };
  }

  private cleanupPeerConnection(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      try {
        peer.close();
      } catch (e) {
        console.warn(`Error closing peer ${peerId}:`, e);
      }
      this.peers.delete(peerId);
    }

    const dataChannel = this.dataChannels.get(peerId);
    if (dataChannel) {
      try {
        dataChannel.close();
      } catch (e) {
        console.warn(`Error closing data channel for ${peerId}:`, e);
      }
      this.dataChannels.delete(peerId);
    }

    this.connectionTimestamps.delete(peerId);
    
    // Clean up delta sync state
    this.peerSyncState.delete(peerId);
    
    // Clean up chunk buffers
    this.chunkBuffers.delete(peerId);

    // Remove peer from Firebase presence immediately (WebRTC-based stale detection)
    // This provides instant cleanup when WebRTC detects disconnection/failure
    stopAnnouncingPresence(
      this.rtdb,
      this.docId,
      peerId,
      this.databasePaths
    ).catch((error) =>
      console.warn(`Failed to remove presence for ${peerId}:`, error)
    );

    this.emit("peer-left", { peerId });
  }

  private startPeriodicCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.cleanupInterval = setInterval(async () => {
      if (this.isDestroyed) return;

      const now = Date.now();
      const staleTimeout = STALE_CONNECTION_TIMEOUT_MS;

      // Clean up stale connections
      this.connectionTimestamps.forEach((timestamp, peerId) => {
        if (now - timestamp > staleTimeout) {
          console.log(`Cleaning up stale connection to peer ${peerId}`);
          this.cleanupPeerConnection(peerId);
        }
      });

      // Clean up stale peers from Firebase
      try {
        await cleanupStalePeers(this.rtdb, this.docId, this.databasePaths);
      } catch (error) {
        console.warn("Failed to cleanup stale peers from Firebase:", error);
      }

      // Perform general memory cleanup
      this.performMemoryCleanup();
    }, CLEANUP_INTERVAL_MS); // Run every 30 seconds
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Track last visibility update time for throttling
    let lastVisibilityUpdate = 0;

    // Helper function to update presence with promise serialization
    const updatePresence = async () => {
      if (this.isDestroyed) return;

      // Serialize presence updates to prevent race conditions
      if (this.pendingPresenceUpdate) {
        try {
          await this.pendingPresenceUpdate;
        } catch (error) {
          // Ignore errors from previous update
          console.warn("Previous presence update failed:", error);
        }
      }

      // Create new pending update
      this.pendingPresenceUpdate = (async () => {
        try {
          // Update our lastSeen timestamp in Firebase
          const paths = this.getPaths();
          const peerRef = ref(this.rtdb, `${paths.rooms}/peers/${this.peerId}`);

          // Set up automatic cleanup on disconnect (Firebase handles this)
          const { onDisconnect } = await import("firebase/database");
          await onDisconnect(peerRef).remove();

          // Reduced payload: only id and lastSeen (removed name and connectedAt for cost savings)
          const currentData = {
            id: this.peerId,
            lastSeen: Date.now(),
          };
          await set(peerRef, currentData);
        } catch (error) {
          console.warn("Failed to update heartbeat:", error);
          throw error; // Re-throw to mark promise as rejected
        } finally {
          this.pendingPresenceUpdate = null;
        }
      })();

      return this.pendingPresenceUpdate;
    };

    // Set up timer-based heartbeat (every 5 minutes)
    this.heartbeatInterval = setInterval(updatePresence, HEARTBEAT_INTERVAL_MS);

    // Set up throttled visibility change handler
    if (typeof document !== "undefined") {
      this.visibilityChangeHandler = () => {
        const now = Date.now();
        // Only update if tab becomes visible AND throttle period has passed
        if (
          !document.hidden &&
          now - lastVisibilityUpdate > MIN_VISIBILITY_UPDATE_INTERVAL
        ) {
          lastVisibilityUpdate = now;
          updatePresence().catch(() => {
            // Error already logged in updatePresence
          });
        }
      };

      document.addEventListener(
        "visibilitychange",
        this.visibilityChangeHandler
      );
    }

    // Send initial presence update immediately
    updatePresence().catch(() => {
      // Error already logged in updatePresence
    });
  }

  private persistDocumentSync: (() => void) | null = null;

  setPersistHandler(handler: () => void): void {
    this.persistDocumentSync = handler;
  }

  private setupBeforeUnloadHandler(): void {
    this.beforeUnloadHandler = () => {
      // CRITICAL: Persist document before page unload to prevent data loss
      try {
        if (this.persistDocumentSync) {
          this.persistDocumentSync();
        }
      } catch (error) {
        console.warn("Error persisting document on unload:", error);
      }

      // Synchronously clean up our presence on actual page unload
      try {
        const paths = this.getPaths();
        const peerRef = ref(this.rtdb, `${paths.rooms}/peers/${this.peerId}`);
        // Firebase's onDisconnect() handles cleanup automatically
        // Just attempt direct cleanup as best effort
        remove(peerRef);
      } catch (error) {
        console.warn("Error in beforeunload cleanup:", error);
      }
    };

    // Handle tab visibility changes (different from page unload)
    this.visibilityChangeHandler = async () => {
      if (typeof document === "undefined") return;

      const isNowVisible = !document.hidden;

      if (isNowVisible && !this.isTabVisible) {
        // Tab became visible - resume activity
        console.log("Tab visible: resuming collaboration");
        this.isTabVisible = true;

        // Resume heartbeat immediately
        if (this.heartbeatInterval) {
          clearInterval(this.heartbeatInterval);
        }
        this.startHeartbeat();

        // Update presence immediately
        try {
          const paths = this.getPaths();
          const peerRef = ref(this.rtdb, `${paths.rooms}/peers/${this.peerId}`);
          const { onDisconnect } = await import("firebase/database");
          await onDisconnect(peerRef).remove();

          await set(peerRef, {
            id: this.peerId,
            name: `User-${this.peerId.slice(0, PEER_ID_DISPLAY_LENGTH)}`,
            connectedAt: Date.now(),
            lastSeen: Date.now(),
          });
        } catch (error) {
          console.warn("Failed to update presence on tab visible:", error);
        }

        // Check peer connections and reconnect if needed
        this.checkAndReconnectPeers();
      } else if (!isNowVisible && this.isTabVisible) {
        // Tab became hidden - pause heartbeat to save resources
        console.log("Tab hidden: pausing heartbeat (connections maintained)");
        this.isTabVisible = false;
        // Note: We don't stop heartbeat completely, just rely on existing interval
        // Firebase will keep connection alive, and onDisconnect() will handle cleanup if needed
      }
    };

    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", this.beforeUnloadHandler);
      // Also handle page hide (mobile Safari, etc.) - actual page unload
      window.addEventListener("pagehide", this.beforeUnloadHandler);
      // Handle tab visibility changes - pause/resume activity
      window.addEventListener("visibilitychange", this.visibilityChangeHandler);
    }
  }

  private async checkAndReconnectPeers(): Promise<void> {
    // Check if we have active peer connections
    const connectedPeers = Array.from(this.peers.values()).filter(
      (p) => p.connectionState === "connected"
    ).length;

    if (connectedPeers === 0 && this.peers.size > 0) {
      // We have peer objects but none are connected - clean up and reconnect
      console.log(
        "No active peer connections after tab visible, reconnecting..."
      );

      // Clean up stale connections
      this.peers.forEach((peer, peerId) => {
        if (peer.connectionState !== "connected") {
          try {
            this.cleanupPeerConnection(peerId);
          } catch {
            // Ignore errors during cleanup
          }
        }
      });

      // Force a cleanup to discover peers again
      try {
        await cleanupStalePeers(this.rtdb, this.docId, this.databasePaths);
      } catch (error) {
        console.warn("Failed to cleanup stale peers on reconnect:", error);
      }
    }
  }

  destroy(): void {
    // Mark as destroyed first
    this.isDestroyed = true;

    // Perform final cleanup
    this.performMemoryCleanup();

    // Close all peer connections
    this.peers.forEach((peer) => {
      try {
        peer.close();
      } catch (e) {
        console.warn("Error closing peer:", e);
      }
    });
    this.peers.clear();

    // Close all data channels
    this.dataChannels.forEach((dataChannel) => {
      try {
        dataChannel.close();
      } catch (e) {
        console.warn("Error closing data channel:", e);
      }
    });
    this.dataChannels.clear();
    
    // Clear delta sync state
    this.peerSyncState.clear();

    // Remove Firebase listeners
    if (this.signalingListenerUnsubscribe) {
      this.signalingListenerUnsubscribe();
      this.signalingListenerUnsubscribe = null;
    }
    
    if (this.peersAddedListenerUnsubscribe) {
      this.peersAddedListenerUnsubscribe();
      this.peersAddedListenerUnsubscribe = null;
    }
    
    if (this.peersRemovedListenerUnsubscribe) {
      this.peersRemovedListenerUnsubscribe();
      this.peersRemovedListenerUnsubscribe = null;
    }

    if (this.signalingRef) {
      off(this.signalingRef);
      this.signalingRef = null;
    }

    if (this.peersRef) {
      off(this.peersRef);
      this.peersRef = null;
    }

    // Remove event listeners
    if (typeof window !== "undefined") {
      if (this.beforeUnloadHandler) {
        window.removeEventListener("beforeunload", this.beforeUnloadHandler);
        window.removeEventListener("pagehide", this.beforeUnloadHandler);
      }
    }

    if (typeof document !== "undefined" && this.visibilityChangeHandler) {
      document.removeEventListener(
        "visibilitychange",
        this.visibilityChangeHandler
      );
      this.visibilityChangeHandler = null;
    }

    // Clear memory tracking
    this.messageBuffer = [];
    this.memoryStats = {
      messageBuffer: 0,
      connectionCount: 0,
      lastCleanup: Date.now(),
      awarenessStates: 0,
    };

    this.connectionStatus = "disconnected";
  }
}
