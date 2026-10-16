import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { cleanupStalePeers } from "../firebase/presence";
import type { Database } from "firebase/database";
import {
  ref,
  set,
  remove,
  push,
  onChildAdded,
  onChildRemoved,
  onDisconnect,
} from "firebase/database";
import {
  applyAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";

import { type DatabasePathsConfig, buildDatabasePaths } from "../utils/config";
import { compressData, decompressData } from "../utils/compression";
import {
  PEER_PRESENCE_TIMEOUT_MS,
  PEER_ID_DISPLAY_LENGTH,
  MAX_AWARENESS_STATES,
  CLEANUP_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  MIN_VISIBILITY_UPDATE_INTERVAL,
  STUN_SERVERS,
  MAX_CHUNK_SIZE,
  CHUNK_HEADER_SIZE,
  CONNECT_TIMEOUT_MS,
  DISCONNECT_GRACE_MS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  ICE_GATHERING_MAX_MS,
  ICE_SETTLE_MS,
} from "../utils/constants";
import type { AdapterEvents, SignalData } from "./types";
import { defaultLogger, type Logger } from "../utils/logger";

type Timer = ReturnType<typeof setTimeout>;

type PeerConnectionEntry = {
  pc: RTCPeerConnection;
  connectionId: string;
  initiator: boolean;
  wasConnected: boolean;
  connectTimer: Timer | null;
  disconnectTimer: Timer | null;
};

export class SimplePeerManager {
  private docId: string;
  private peerId: string;
  private ydoc: Y.Doc;
  private awareness: Awareness;
  private databasePaths: DatabasePathsConfig | undefined;
  private rtdb: Database;
  private maxPeers: number;
  private logger: Logger;

  private eventListeners: Map<
    keyof AdapterEvents,
    Set<(data: AdapterEvents[keyof AdapterEvents]) => void>
  > = new Map();

  // Changes on every start/stop, so callbacks from an earlier run can bail out.
  private running = false;
  private destroyed = false;
  private runId = 0;
  private connectionStatus: "connecting" | "connected" | "disconnected" =
    "connecting";

  private unsubscribers: Array<() => void> = [];
  private intervals: Array<ReturnType<typeof setInterval>> = [];
  private retryTimers = new Map<string, Timer>();
  private retryAttempts = new Map<string, number>();

  private presentPeers = new Set<string>();

  // WebRTC peer connections
  private peers = new Map<string, PeerConnectionEntry>();
  private dataChannels = new Map<string, RTCDataChannel>();

  // Chunked message reassembly buffers
  private chunkBuffers = new Map<
    string,
    Map<number, { chunk: number[]; totalChunks: number }>
  >();

  private pendingPresenceUpdate: Promise<void> | null = null;
  private lastVisibilityUpdate = 0;
  private persistDocumentSync: (() => void) | null = null;

  constructor(
    docId: string,
    peerId: string,
    ydoc: Y.Doc,
    awareness: Awareness,
    rtdb: Database,
    databasePaths: DatabasePathsConfig | undefined,
    maxDirectPeers: number = 20,
    logger: Logger = defaultLogger
  ) {
    this.docId = docId;
    this.peerId = peerId;
    this.ydoc = ydoc;
    this.awareness = awareness;
    this.rtdb = rtdb;
    this.databasePaths = databasePaths;
    this.maxPeers = maxDirectPeers;
    this.logger = logger;
  }

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
    this.eventListeners
      .get(event)
      ?.delete(callback as (data: AdapterEvents[keyof AdapterEvents]) => void);
  }

  private getPaths() {
    return buildDatabasePaths(this.databasePaths, this.docId);
  }

  async start(): Promise<void> {
    if (this.destroyed) {
      throw new Error("Cannot start a destroyed peer manager");
    }
    if (this.running) return;
    this.running = true;
    const runId = ++this.runId;
    const paths = this.getPaths();

    const signalingRef = ref(this.rtdb, `${paths.signaling}/${this.peerId}`);
    this.unsubscribers.push(
      onChildAdded(signalingRef, (snapshot) => {
        if (runId !== this.runId) return;
        this.handleSignalData(snapshot.val() as SignalData);
        remove(snapshot.ref).catch((error) =>
          this.logger.warn(`Failed to remove signal ${snapshot.key}:`, error)
        );
      })
    );

    const peersRef = ref(this.rtdb, `${paths.rooms}/peers`);
    this.unsubscribers.push(
      onChildAdded(peersRef, (snapshot) => {
        if (runId !== this.runId) return;
        const otherPeerId = snapshot.key!;
        if (otherPeerId === this.peerId) return;
        const peerData = snapshot.val();
        if (
          !peerData?.lastSeen ||
          Date.now() - peerData.lastSeen >= PEER_PRESENCE_TIMEOUT_MS
        ) {
          return;
        }
        this.presentPeers.add(otherPeerId);
        if (this.shouldInitiate(otherPeerId)) {
          this.logger.debug(`New peer detected: ${otherPeerId}, initiating`);
          this.createPeerConnection(otherPeerId, true);
        }
      })
    );
    this.unsubscribers.push(
      onChildRemoved(peersRef, (snapshot) => {
        if (runId !== this.runId) return;
        const otherPeerId = snapshot.key!;
        if (otherPeerId === this.peerId) return;
        this.presentPeers.delete(otherPeerId);
        this.cancelRetry(otherPeerId);
        if (this.peers.has(otherPeerId)) {
          this.logger.debug(`Peer ${otherPeerId} left, closing connection`);
          this.cleanupPeerConnection(otherPeerId);
        }
      })
    );

    this.intervals.push(
      setInterval(() => this.periodicCleanup(runId), CLEANUP_INTERVAL_MS),
      setInterval(() => {
        this.updatePresence(runId).catch(() => {});
      }, HEARTBEAT_INTERVAL_MS)
    );
    this.updatePresence(runId).catch(() => {});

    this.addPageListeners();
    this.connectionStatus = "connected";
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.runId++;

    this.removePageListeners();
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    this.intervals.splice(0).forEach((interval) => clearInterval(interval));
    this.retryTimers.forEach((timer) => clearTimeout(timer));
    this.retryTimers.clear();
    this.retryAttempts.clear();

    for (const peerId of Array.from(this.peers.keys())) {
      this.cleanupPeerConnection(peerId);
    }
    this.presentPeers.clear();
    this.chunkBuffers.clear();

    const peerRef = ref(this.rtdb, `${this.getPaths().rooms}/peers/${this.peerId}`);
    remove(peerRef).catch((error) =>
      this.logger.warn("Failed to remove own presence:", error)
    );

    this.connectionStatus = "disconnected";
  }

  destroy(): void {
    this.stop();
    this.destroyed = true;
  }

  async reconnect(): Promise<void> {
    this.connectionStatus = "connecting";
    this.emit("connection-state-changed", { state: "connecting" });
    try {
      this.stop();
      await this.start();
      this.emit("connection-state-changed", { state: "connected" });
    } catch (error) {
      this.connectionStatus = "disconnected";
      this.emit("error", { error: error as Error, context: "reconnection" });
      this.emit("connection-state-changed", { state: "disconnected" });
      throw error;
    }
  }

  setPersistHandler(handler: () => void): void {
    this.persistDocumentSync = handler;
  }

  getPeerCount(): number {
    let count = 0;
    this.peers.forEach(({ pc }) => {
      if (pc.connectionState === "connected") count++;
    });
    return count;
  }

  getConnectionStatus(): "connecting" | "connected" | "disconnected" {
    return this.connectionStatus;
  }

  private onVisibilityChange = () => {
    if (!this.running || typeof document === "undefined" || document.hidden) {
      return;
    }
    const now = Date.now();
    if (now - this.lastVisibilityUpdate > MIN_VISIBILITY_UPDATE_INTERVAL) {
      this.lastVisibilityUpdate = now;
      this.updatePresence(this.runId).catch(() => {});
    }
    this.connectMissingPeers();
  };

  private onPageHide = () => {
    if (!this.running) return;
    try {
      this.persistDocumentSync?.();
    } catch (error) {
      this.logger.warn("Error persisting document on unload:", error);
    }
    // Best effort; onDisconnect covers it if this write never leaves.
    const peerRef = ref(this.rtdb, `${this.getPaths().rooms}/peers/${this.peerId}`);
    remove(peerRef).catch(() => {});
  };

  private onOnline = () => {
    if (this.running) this.connectMissingPeers();
  };

  private addPageListeners(): void {
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", this.onPageHide);
      window.addEventListener("pagehide", this.onPageHide);
      window.addEventListener("online", this.onOnline);
    }
  }

  private removePageListeners(): void {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("beforeunload", this.onPageHide);
      window.removeEventListener("pagehide", this.onPageHide);
      window.removeEventListener("online", this.onOnline);
    }
  }

  private async updatePresence(runId: number): Promise<void> {
    if (runId !== this.runId) return;

    if (this.pendingPresenceUpdate) {
      await this.pendingPresenceUpdate.catch(() => {});
    }
    if (runId !== this.runId) return;

    this.pendingPresenceUpdate = (async () => {
      try {
        const peerRef = ref(
          this.rtdb,
          `${this.getPaths().rooms}/peers/${this.peerId}`
        );
        await onDisconnect(peerRef).remove();
        if (runId !== this.runId) return;
        await set(peerRef, { id: this.peerId, lastSeen: Date.now() });
      } catch (error) {
        this.logger.warn("Failed to update heartbeat:", error);
        throw error;
      } finally {
        this.pendingPresenceUpdate = null;
      }
    })();
    return this.pendingPresenceUpdate;
  }

  private periodicCleanup(runId: number): void {
    if (runId !== this.runId) return;
    cleanupStalePeers(this.rtdb, this.docId, this.databasePaths, this.logger)
      .catch((error) =>
        this.logger.warn("Failed to cleanup stale peers from Firebase:", error)
      );
    this.cleanupAwarenessStates();
  }

  // The smaller id initiates, so each pair negotiates once.
  private shouldInitiate(otherPeerId: string): boolean {
    return this.peerId < otherPeerId;
  }

  private connectMissingPeers(): void {
    this.presentPeers.forEach((otherPeerId) => {
      if (
        this.shouldInitiate(otherPeerId) &&
        !this.peers.has(otherPeerId) &&
        !this.retryTimers.has(otherPeerId)
      ) {
        this.createPeerConnection(otherPeerId, true);
      }
    });
  }

  private scheduleRetry(otherPeerId: string): void {
    if (
      !this.running ||
      !this.shouldInitiate(otherPeerId) ||
      !this.presentPeers.has(otherPeerId) ||
      this.retryTimers.has(otherPeerId)
    ) {
      return;
    }
    const attempt = (this.retryAttempts.get(otherPeerId) ?? 0) + 1;
    this.retryAttempts.set(otherPeerId, attempt);
    const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    const runId = this.runId;
    this.logger.debug(
      `Retrying connection to ${otherPeerId} in ${Math.round(delay)}ms (attempt ${attempt})`
    );
    this.retryTimers.set(
      otherPeerId,
      setTimeout(() => {
        this.retryTimers.delete(otherPeerId);
        if (
          runId === this.runId &&
          this.presentPeers.has(otherPeerId) &&
          !this.peers.has(otherPeerId)
        ) {
          this.createPeerConnection(otherPeerId, true);
        }
      }, delay)
    );
  }

  private cancelRetry(otherPeerId: string): void {
    const timer = this.retryTimers.get(otherPeerId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(otherPeerId);
    this.retryAttempts.delete(otherPeerId);
  }

  private createPeerConnection(
    otherPeerId: string,
    initiator: boolean,
    connectionId: string = crypto.randomUUID()
  ): PeerConnectionEntry | null {
    if (!this.running || this.peers.has(otherPeerId)) return null;

    if (this.peers.size >= this.maxPeers) {
      this.logger.warn(
        `Maximum peer connections reached (${this.maxPeers}), rejecting new connection to ${otherPeerId}`
      );
      return null;
    }

    const pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    const entry: PeerConnectionEntry = {
      pc,
      connectionId,
      initiator,
      wasConnected: false,
      connectTimer: null,
      disconnectTimer: null,
    };
    this.peers.set(otherPeerId, entry);
    const isCurrent = () => this.peers.get(otherPeerId) === entry;

    entry.connectTimer = setTimeout(() => {
      if (isCurrent() && pc.connectionState !== "connected") {
        this.logger.debug(`Connection to ${otherPeerId} timed out`);
        this.cleanupPeerConnection(otherPeerId, { retry: true });
      }
    }, CONNECT_TIMEOUT_MS);

    pc.onconnectionstatechange = () => {
      if (!isCurrent()) return;
      const state = pc.connectionState;
      this.logger.debug(`Peer ${otherPeerId} connection state: ${state}`);

      if (state === "connected") {
        if (entry.connectTimer) clearTimeout(entry.connectTimer);
        if (entry.disconnectTimer) clearTimeout(entry.disconnectTimer);
        entry.connectTimer = entry.disconnectTimer = null;
        this.retryAttempts.delete(otherPeerId);
        if (!entry.wasConnected) {
          entry.wasConnected = true;
          this.emit("peer-joined", {
            peerId: otherPeerId,
            user: {
              id: otherPeerId,
              name: `User-${otherPeerId.slice(0, PEER_ID_DISPLAY_LENGTH)}`,
              connectedAt: Date.now(),
            },
          });
        }
      } else if (state === "disconnected") {
        // Often a brief network blip; give it a moment to recover.
        if (!entry.disconnectTimer) {
          entry.disconnectTimer = setTimeout(() => {
            if (isCurrent() && pc.connectionState !== "connected") {
              this.cleanupPeerConnection(otherPeerId, { retry: true });
            }
          }, DISCONNECT_GRACE_MS);
        }
      } else if (state === "failed" || state === "closed") {
        this.cleanupPeerConnection(otherPeerId, { retry: true });
      }
    };

    if (initiator) {
      const dataChannel = pc.createDataChannel("data");
      this.dataChannels.set(otherPeerId, dataChannel);
      this.setupDataChannel(otherPeerId, dataChannel);

      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => waitForIceGathering(pc))
        .then(() => {
          if (isCurrent() && pc.localDescription) {
            return this.sendSignal(otherPeerId, "offer", pc.localDescription, connectionId);
          }
        })
        .catch((error) => {
          this.logger.warn(`Error creating offer for ${otherPeerId}:`, error);
          if (isCurrent()) this.cleanupPeerConnection(otherPeerId, { retry: true });
        });
    } else {
      pc.ondatachannel = (event) => {
        if (!isCurrent()) return;
        this.dataChannels.set(otherPeerId, event.channel);
        this.setupDataChannel(otherPeerId, event.channel);
      };
    }

    return entry;
  }

  private cleanupPeerConnection(
    otherPeerId: string,
    { retry = false }: { retry?: boolean } = {}
  ): void {
    const entry = this.peers.get(otherPeerId);
    if (entry) {
      this.peers.delete(otherPeerId);
      if (entry.connectTimer) clearTimeout(entry.connectTimer);
      if (entry.disconnectTimer) clearTimeout(entry.disconnectTimer);
      try {
        entry.pc.close();
      } catch (e) {
        this.logger.warn(`Error closing peer ${otherPeerId}:`, e);
      }
    }

    const dataChannel = this.dataChannels.get(otherPeerId);
    if (dataChannel) {
      this.dataChannels.delete(otherPeerId);
      try {
        dataChannel.close();
      } catch (e) {
        this.logger.warn(`Error closing data channel for ${otherPeerId}:`, e);
      }
    }

    this.chunkBuffers.delete(otherPeerId);

    if (entry?.wasConnected) {
      this.emit("peer-left", { peerId: otherPeerId });
    }
    if (retry) this.scheduleRetry(otherPeerId);
  }

  private async sendSignal(
    targetPeerId: string,
    type: SignalData["type"],
    description: RTCSessionDescriptionInit,
    connectionId: string
  ): Promise<void> {
    const signalData: SignalData = {
      type,
      sdp: { type: description.type!, sdp: description.sdp! },
      from: this.peerId,
      to: targetPeerId,
      connectionId,
      timestamp: Date.now(),
    };
    const messageRef = push(
      ref(this.rtdb, `${this.getPaths().signaling}/${targetPeerId}`)
    );
    await set(messageRef, signalData);
    this.logger.debug(`Sent ${type} to ${targetPeerId}`);
  }

  private handleSignalData(signalData: SignalData): void {
    const { from, type, connectionId } = signalData;
    if (!this.running || !from || !signalData.sdp) return;

    if (type === "offer") {
      // A new offer means the initiator started over, e.g. after a failure.
      if (this.peers.has(from)) {
        this.logger.debug(`New offer from ${from}, replacing existing connection`);
        this.cleanupPeerConnection(from);
      }
      const entry = this.createPeerConnection(from, false, connectionId);
      if (!entry) return;
      const { pc } = entry;
      const isCurrent = () => this.peers.get(from) === entry;

      pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp))
        .then(() => pc.createAnswer())
        .then((answer) => pc.setLocalDescription(answer))
        .then(() => waitForIceGathering(pc))
        .then(() => {
          if (isCurrent() && pc.localDescription) {
            return this.sendSignal(from, "answer", pc.localDescription, entry.connectionId);
          }
        })
        .catch((error) => {
          this.logger.warn(`Error handling offer from ${from}:`, error);
          if (isCurrent()) this.cleanupPeerConnection(from);
        });
      return;
    }

    if (type === "answer") {
      const entry = this.peers.get(from);
      if (!entry || !entry.initiator || entry.connectionId !== connectionId) {
        this.logger.debug(`Ignoring stale answer from ${from}`);
        return;
      }
      entry.pc
        .setRemoteDescription(new RTCSessionDescription(signalData.sdp))
        .catch((error) => {
          this.logger.warn(`Error handling answer from ${from}:`, error);
          if (this.peers.get(from) === entry) {
            this.cleanupPeerConnection(from, { retry: true });
          }
        });
    }
  }

  private setupDataChannel(peerId: string, dataChannel: RTCDataChannel): void {
    dataChannel.onopen = () => {
      this.logger.debug(`Data channel opened for peer ${peerId}`);

      try {
        const update = Y.encodeStateAsUpdate(this.ydoc);
        if (update.length > 0) {
          dataChannel.send(
            JSON.stringify({ type: "sync", update: Array.from(update) })
          );
          this.logger.debug(
            `Sent initial sync to peer ${peerId} (${update.length} bytes)`
          );
        }
      } catch (error) {
        this.logger.error(`Error sending initial sync to ${peerId}:`, error);
      }
    };

    dataChannel.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);

        if (message.type === "sync" && message.update) {
          const updateArray = new Uint8Array(message.update);
          Y.applyUpdate(this.ydoc, updateArray, this);
          this.logger.debug(
            `Applied sync update from peer ${peerId} (${updateArray.length} bytes)`
          );
        } else if (message.type === "sync-chunk" && message.update) {
          this.handleChunkedMessage(peerId, message);
        } else if (message.type === "awareness" && message.update) {
          if (this.awareness.getStates().size < MAX_AWARENESS_STATES) {
            let awarenessUpdate = new Uint8Array(message.update);
            if (message.compressed) {
              awarenessUpdate = await decompressData(awarenessUpdate, this.logger);
            }
            applyAwarenessUpdate(this.awareness, awarenessUpdate, null);
          }
        }
      } catch (error) {
        this.logger.error("Error parsing peer data:", error);
      }
    };

    dataChannel.onerror = (error) => {
      this.logger.error(`Data channel error for peer ${peerId}:`, error);
    };

    dataChannel.onclose = () => {
      this.logger.debug(`Data channel closed for peer ${peerId}`);
    };
  }

  broadcastUpdate(update: Uint8Array): void {
    if (update.length < 3) return;

    const updateArray = Array.from(update);
    const testMessage = JSON.stringify({ type: "sync", update: [] });
    const maxDataSize = MAX_CHUNK_SIZE - CHUNK_HEADER_SIZE - testMessage.length;

    const totalSize = updateArray.length;
    if (totalSize <= maxDataSize) {
      this.sendToAllPeers(JSON.stringify({ type: "sync", update: updateArray }));
    } else {
      const chunks = Math.ceil(totalSize / maxDataSize);
      const messageId = `${this.peerId}-${Date.now()}`;
      for (let i = 0; i < chunks; i++) {
        const start = i * maxDataSize;
        const end = Math.min(start + maxDataSize, totalSize);
        this.sendToAllPeers(
          JSON.stringify({
            type: "sync-chunk",
            messageId,
            chunk: i,
            totalChunks: chunks,
            update: updateArray.slice(start, end),
          })
        );
      }
    }
  }

  private sendToAllPeers(message: string): void {
    this.dataChannels.forEach((dataChannel, peerId) => {
      if (dataChannel.readyState === "open") {
        try {
          dataChannel.send(message);
        } catch (error) {
          this.logger.error(`Error sending update to peer ${peerId}:`, error);
        }
      }
    });
  }

  async broadcastAwareness(update: Uint8Array): Promise<void> {
    const { compressed, isCompressed } = await compressData(update, this.logger);
    const message = JSON.stringify({
      type: "awareness",
      update: Array.from(compressed),
      compressed: isCompressed,
    });
    this.sendToAllPeers(message);
  }

  private handleChunkedMessage(
    peerId: string,
    message: {
      messageId: string;
      chunk: number;
      totalChunks: number;
      update: number[];
    }
  ): void {
    const { chunk, totalChunks, update } = message;

    if (!this.chunkBuffers.has(peerId)) {
      this.chunkBuffers.set(peerId, new Map());
    }
    const peerBuffer = this.chunkBuffers.get(peerId)!;

    if (!peerBuffer.has(chunk)) {
      peerBuffer.set(chunk, { chunk: update, totalChunks });
    }

    if (peerBuffer.size === totalChunks) {
      const completeUpdate: number[] = [];
      for (let i = 0; i < totalChunks; i++) {
        const chunkData = peerBuffer.get(i);
        if (chunkData) completeUpdate.push(...chunkData.chunk);
      }
      Y.applyUpdate(this.ydoc, new Uint8Array(completeUpdate), this);
      peerBuffer.clear();
    }
  }

  private cleanupAwarenessStates(): void {
    const awarenessStates = this.awareness.getStates();
    if (awarenessStates.size <= MAX_AWARENESS_STATES) return;

    this.logger.warn("Too many awareness states, cleaning up old ones");
    const clientsToRemove: number[] = [];
    awarenessStates.forEach((_state: unknown, clientId: number) => {
      if (clientId !== this.ydoc.clientID) clientsToRemove.push(clientId);
    });
    if (clientsToRemove.length > 0) {
      removeAwarenessStates(this.awareness, clientsToRemove, null);
    }
  }
}

// ICE gathering can take tens of seconds to complete when a STUN server is
// unreachable, even though usable candidates arrive almost immediately.
function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    let settleTimer: Timer | null = null;
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", onStateChange);
      pc.removeEventListener("icecandidate", onCandidate);
      clearTimeout(capTimer);
      if (settleTimer) clearTimeout(settleTimer);
      resolve();
    };
    const onStateChange = () => {
      if (pc.iceGatheringState === "complete") done();
    };
    const onCandidate = (event: Event) => {
      const candidate = (event as RTCPeerConnectionIceEvent).candidate;
      if (candidate && candidate.type !== "host" && !settleTimer) {
        settleTimer = setTimeout(done, ICE_SETTLE_MS);
      }
    };
    const capTimer = setTimeout(done, ICE_GATHERING_MAX_MS);
    pc.addEventListener("icegatheringstatechange", onStateChange);
    pc.addEventListener("icecandidate", onCandidate);
  });
}
