import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type { Database } from "firebase/database";
import {
  ref,
  set,
  remove,
  push,
  onChildAdded,
  onChildRemoved,
  onDisconnect,
  onValue,
  serverTimestamp,
} from "firebase/database";
import { applyAwarenessUpdate } from "y-protocols/awareness";

import { type DatabasePathsConfig, buildDatabasePaths } from "../utils/config";
import {
  compressData,
  decompressData,
  compressText,
  decompressText,
} from "../utils/compression";
import {
  PEER_ID_DISPLAY_LENGTH,
  MAX_AWARENESS_STATES,
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
import type {
  AdapterEvents,
  PeerInfo,
  PresenceEntry,
  SignalData,
} from "./types";
import type { ConnectionState } from "../utils/config";
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

export type PeerManagerOptions = {
  docId: string;
  peer: PeerInfo;
  ydoc: Y.Doc;
  awareness: Awareness;
  rtdb: Database;
  databasePaths?: DatabasePathsConfig;
  maxDirectPeers?: number;
  logger?: Logger;
};

export class SimplePeerManager {
  private docId: string;
  private peer: PeerInfo;
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
  private connectionStatus: ConnectionState = "connecting";

  private unsubscribers: Array<() => void> = [];
  private retryTimers = new Map<string, Timer>();
  private retryAttempts = new Map<string, number>();

  private presentPeers = new Map<string, PresenceEntry>();

  // WebRTC peer connections
  private peers = new Map<string, PeerConnectionEntry>();
  private dataChannels = new Map<string, RTCDataChannel>();

  // Chunked message reassembly buffers
  private chunkBuffers = new Map<
    string,
    Map<number, { chunk: number[]; totalChunks: number }>
  >();

  private persistDocumentSync: (() => void) | null = null;

  constructor(options: PeerManagerOptions) {
    this.docId = options.docId;
    this.peer = options.peer;
    this.peerId = options.peer.id;
    this.ydoc = options.ydoc;
    this.awareness = options.awareness;
    this.rtdb = options.rtdb;
    this.databasePaths = options.databasePaths;
    this.maxPeers = options.maxDirectPeers ?? 20;
    this.logger = options.logger ?? defaultLogger;
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
    this.setConnectionStatus("connecting");

    // On every (re)connect: register onDisconnect cleanup, then announce ourselves.
    this.unsubscribers.push(
      onValue(ref(this.rtdb, ".info/connected"), (snapshot) => {
        if (runId !== this.runId) return;
        if (snapshot.val() === true) {
          this.setConnectionStatus("connected");
          this.announcePresence(runId);
        } else if (this.connectionStatus === "connected") {
          this.setConnectionStatus("disconnected");
        }
      })
    );

    const signalingRef = ref(this.rtdb, `${paths.signaling}/${this.peerId}`);
    this.unsubscribers.push(
      onChildAdded(signalingRef, (snapshot) => {
        if (runId !== this.runId) return;
        this.handleSignalData(snapshot.val() as SignalData).catch((error) =>
          this.logger.warn("Failed to handle signal:", error)
        );
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
        this.presentPeers.set(otherPeerId, snapshot.val() as PresenceEntry);
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
        // Presence also drops during brief Firebase disconnects, so a live connection
        // is kept; its data channel closes if the peer is really gone.
        this.presentPeers.delete(otherPeerId);
        this.cancelRetry(otherPeerId);
        const entry = this.peers.get(otherPeerId);
        if (entry && entry.pc.connectionState !== "connected") {
          this.cleanupPeerConnection(otherPeerId);
        }
      })
    );

    this.addPageListeners();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.runId++;

    this.removePageListeners();
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    this.retryTimers.forEach((timer) => clearTimeout(timer));
    this.retryTimers.clear();
    this.retryAttempts.clear();

    for (const peerId of Array.from(this.peers.keys())) {
      this.cleanupPeerConnection(peerId);
    }
    this.presentPeers.clear();
    this.chunkBuffers.clear();

    // onDisconnect stays registered in case this write doesn't reach the server.
    const peerRef = this.presenceRef();
    remove(peerRef).catch((error) =>
      this.logger.warn("Failed to remove own presence:", error)
    );

    this.setConnectionStatus("disconnected");
  }

  destroy(): void {
    this.stop();
    this.destroyed = true;
  }

  async reconnect(): Promise<void> {
    try {
      this.stop();
      await this.start();
    } catch (error) {
      this.setConnectionStatus("disconnected");
      this.emit("error", { error: error as Error, context: "reconnection" });
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

  getConnectionStatus(): ConnectionState {
    return this.connectionStatus;
  }

  private setConnectionStatus(state: ConnectionState): void {
    if (this.connectionStatus === state) return;
    this.connectionStatus = state;
    this.emit("connection-state-changed", { state });
  }

  private onVisibilityChange = () => {
    if (!this.running || typeof document === "undefined" || document.hidden) {
      return;
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
    remove(this.presenceRef()).catch(() => {});
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

  private presenceRef() {
    return ref(this.rtdb, `${this.getPaths().rooms}/peers/${this.peerId}`);
  }

  private async announcePresence(runId: number): Promise<void> {
    const peerRef = this.presenceRef();
    try {
      await onDisconnect(peerRef).remove();
      if (runId !== this.runId) return;
      const entry: PresenceEntry = {
        name: this.peer.name,
        connectedAt: serverTimestamp(),
      };
      await set(peerRef, entry);
    } catch (error) {
      this.logger.warn("Failed to announce presence:", error);
      this.emit("error", { error: error as Error, context: "presence" });
    }
  }

  // The smaller id initiates, so each pair negotiates once.
  private shouldInitiate(otherPeerId: string): boolean {
    return this.peerId < otherPeerId;
  }

  private connectMissingPeers(): void {
    this.presentPeers.forEach((_entry, otherPeerId) => {
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
          const presence = this.presentPeers.get(otherPeerId);
          this.emit("peer-joined", {
            peerId: otherPeerId,
            user: {
              id: otherPeerId,
              name:
                presence?.name ??
                `User-${otherPeerId.slice(0, PEER_ID_DISPLAY_LENGTH)}`,
              connectedAt:
                typeof presence?.connectedAt === "number"
                  ? presence.connectedAt
                  : Date.now(),
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
    const sdp = description.sdp ?? "";
    const sdpGz = await compressText(sdp).catch(() => null);
    const signalData: SignalData = {
      type,
      ...(sdpGz ? { sdpGz } : { sdp }),
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

  private async handleSignalData(signalData: SignalData): Promise<void> {
    const { from, type, connectionId } = signalData;
    if (!this.running || !from) return;

    let sdp: string;
    try {
      sdp = signalData.sdpGz
        ? await decompressText(signalData.sdpGz)
        : signalData.sdp ?? "";
    } catch (error) {
      this.logger.warn(`Ignoring unreadable signal from ${from}:`, error);
      return;
    }
    if (!sdp || !this.running) return;
    const description = new RTCSessionDescription({ type, sdp });

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

      pc.setRemoteDescription(description)
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
        .setRemoteDescription(description)
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
      if (this.dataChannels.get(peerId) === dataChannel) {
        this.cleanupPeerConnection(peerId, { retry: true });
      }
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
