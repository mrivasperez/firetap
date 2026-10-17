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
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";

import { type DatabasePathsConfig, buildDatabasePaths } from "../utils/config";
import { compressText, decompressText } from "../utils/compression";
import { desiredNeighbors } from "./topology";
import {
  PeerSession,
  MSG_AWARENESS,
  MSG_SYNC_STEP1,
  MSG_SYNC_STEP2,
  MSG_UPDATE,
  MSG_NEIGHBORS,
  MSG_PERSISTED,
  MSG_STATUS,
  PROTOCOL_VERSION,
} from "./peer-session";
import {
  PEER_ID_DISPLAY_LENGTH,
  CONNECT_TIMEOUT_MS,
  DISCONNECT_GRACE_MS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  ICE_GATHERING_MAX_MS,
  ICE_SETTLE_MS,
  ANTI_ENTROPY_INTERVAL_MS,
  FALLBACK_DELAY_MS,
  PRESENCE_SETTLE_MS,
  DEFAULT_MAX_DIRECT_PEERS,
  TOPOLOGY_SETTLE_MS,
} from "../utils/constants";
import type {
  AdapterEvents,
  PeerInfo,
  PresenceEntry,
  SignalData,
} from "./types";
import type { ConnectionState } from "../utils/config";
import { defaultLogger, type Logger } from "../utils/logger";
import { randomId } from "../utils/id";

type Timer = ReturnType<typeof setTimeout>;

export class RemoteOrigin {
  constructor(readonly peerId: string) {}
}

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
  iceServers?: RTCIceServer[];
  logger?: Logger;
  onPageHidden?: () => void;
  onPersisted?: (clientId: number, clock: number) => void;
  onPeerGone?: (clientIds: number[]) => void;
  /** Called with true when this client should receive edits from Firebase, because a present peer is unreachable. */
  onFallbackChange?: (active: boolean) => void;
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
  private iceServers: RTCIceServer[];
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
  private reconcileTimer: Timer | null = null;
  private fallbackActive = false;
  private fallbackTimer: Timer | null = null;

  // The snapshot generation our document contains, and what each peer reports.
  private knownGeneration = 0;
  private peerGenerations = new Map<string, number>();
  private initiallySynced = new Set<string>();
  private syncWaiters = new Set<() => void>();
  private desiredCache: Set<string> | null = null;

  private presentPeers = new Map<string, PresenceEntry>();
  // Kept while a peer is directly connected, through brief Firebase disconnects.
  private peerInfos = new Map<string, PeerInfo>();
  private reportedPresence = "";

  private peers = new Map<string, PeerConnectionEntry>();
  private sessions = new Map<
    string,
    { channel: RTCDataChannel; session: PeerSession }
  >();
  private origins = new Map<string, RemoteOrigin>();

  // Peers relay each other's cursors, so track which clients came from each peer.
  private awarenessClientsByPeer = new Map<string, Set<number>>();

  // Relays skip peers the original sender is already connected to.
  private neighborsOf = new Map<string, Set<string>>();
  private antiEntropyTimer: ReturnType<typeof setInterval> | null = null;

  private readonly hooks: Pick<
    PeerManagerOptions,
    "onPageHidden" | "onPersisted" | "onPeerGone" | "onFallbackChange"
  >;
  // Who authored each Yjs client, from awareness and save reports.
  private clientToPeer = new Map<number, string>();

  constructor(options: PeerManagerOptions) {
    this.docId = options.docId;
    this.peer = options.peer;
    this.peerId = options.peer.id;
    this.ydoc = options.ydoc;
    this.awareness = options.awareness;
    this.rtdb = options.rtdb;
    this.databasePaths = options.databasePaths;
    const maxPeers = options.maxDirectPeers ?? DEFAULT_MAX_DIRECT_PEERS;
    this.maxPeers = maxPeers === 0 ? 0 : Math.max(2, maxPeers);
    this.logger = options.logger ?? defaultLogger;
    this.iceServers = options.iceServers ?? [];
    this.hooks = options;
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

  get usesWebRTC(): boolean {
    return this.maxPeers > 0;
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

    if (this.usesWebRTC) {
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
    }

    const peersRef = ref(this.rtdb, `${paths.rooms}/peers`);
    this.unsubscribers.push(
      onChildAdded(peersRef, (snapshot) => {
        if (runId !== this.runId) return;
        const otherPeerId = snapshot.key!;
        if (otherPeerId === this.peerId) return;
        const entry = snapshot.val() as PresenceEntry;
        this.presentPeers.set(otherPeerId, entry);
        this.peerInfos.set(otherPeerId, {
          id: otherPeerId,
          name: entry.name ?? `User-${otherPeerId.slice(0, PEER_ID_DISPLAY_LENGTH)}`,
          connectedAt: typeof entry.connectedAt === "number" ? entry.connectedAt : Date.now(),
        });
        this.desiredCache = null;
        this.scheduleReconcile();
        this.updateFallback();
        this.reportPresence();
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
        this.desiredCache = null;
        this.cancelRetry(otherPeerId);
        this.reportPeerGone(otherPeerId);
        const entry = this.peers.get(otherPeerId);
        if (entry && entry.pc.connectionState !== "connected") {
          this.cleanupPeerConnection(otherPeerId);
        }
        this.scheduleReconcile();
        this.updateFallback();
        this.reportPresence();
      })
    );

    this.awareness.on("update", this.onAwarenessUpdate);
    this.ydoc.on("update", this.onDocUpdate);
    this.antiEntropyTimer = setInterval(
      () => this.syncWithNeighbors(),
      ANTI_ENTROPY_INTERVAL_MS
    );
    this.addPageListeners();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.runId++;

    this.removePageListeners();
    this.awareness.off("update", this.onAwarenessUpdate);
    this.ydoc.off("update", this.onDocUpdate);
    if (this.antiEntropyTimer) clearInterval(this.antiEntropyTimer);
    this.antiEntropyTimer = null;
    if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
    this.reconcileTimer = null;
    this.desiredCache = null;
    this.unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
    this.retryTimers.forEach((timer) => clearTimeout(timer));
    this.retryTimers.clear();
    this.retryAttempts.clear();

    for (const peerId of Array.from(this.peers.keys())) {
      this.cleanupPeerConnection(peerId);
    }
    this.presentPeers.clear();
    this.updateFallback();
    this.reportPresence();

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

  getPeerCount(): number {
    let count = 0;
    this.peers.forEach(({ pc }) => {
      if (pc.connectionState === "connected") count++;
    });
    return count;
  }

  /** Everyone else who has the document open. */
  getPresentPeers(): PeerInfo[] {
    const ids = new Set(this.presentPeers.keys());
    for (const [peerId] of this.openSessions()) ids.add(peerId);
    return Array.from(ids)
      .sort()
      .flatMap((id) => this.peerInfos.get(id) ?? []);
  }

  private reportPresence(): void {
    const peers = this.getPresentPeers();
    const present = new Set(peers.map(({ id }) => id));
    this.peerInfos.forEach((_info, id) => {
      if (!present.has(id)) this.peerInfos.delete(id);
    });
    const key = Array.from(present).join(",");
    if (key === this.reportedPresence) return;
    this.reportedPresence = key;
    this.emit("presence-changed", { peers });
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
    if (!this.running || typeof document === "undefined") return;
    if (document.hidden) {
      this.hooks.onPageHidden?.();
    } else {
      this.connectMissingPeers();
    }
  };

  // No beforeunload listener: prompting is the app's choice, and the listener
  // can keep pages out of the back/forward cache.
  private onPageHide = () => {
    if (!this.running) return;
    this.hooks.onPageHidden?.();
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
      window.addEventListener("pagehide", this.onPageHide);
      window.addEventListener("online", this.onOnline);
    }
  }

  private removePageListeners(): void {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    if (typeof window !== "undefined") {
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
        ...(this.usesWebRTC ? {} : { rtc: false as const }),
      };
      await set(peerRef, entry);
    } catch (error) {
      this.logger.warn("Failed to announce presence:", error);
      this.emit("error", { error: error as Error, context: "presence" });
    }
  }

  private desiredPeers(): Set<string> {
    if (!this.desiredCache) {
      const candidates = Array.from(this.presentPeers)
        .filter(([, entry]) => this.usesWebRTC && entry.rtc !== false)
        .map(([peerId]) => peerId);
      this.desiredCache = desiredNeighbors(this.peerId, candidates, this.maxPeers);
    }
    return this.desiredCache;
  }

  // The smaller id initiates, so each pair negotiates once.
  private shouldInitiate(otherPeerId: string): boolean {
    return this.peerId < otherPeerId && this.desiredPeers().has(otherPeerId);
  }

  // Presence changes arrive in bursts, e.g. when someone joins.
  private scheduleReconcile(): void {
    if (this.reconcileTimer || !this.running) return;
    const runId = this.runId;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      if (runId === this.runId) this.reconcile();
    }, TOPOLOGY_SETTLE_MS);
  }

  // Existing links are kept when the topology shifts, unless we're over the cap.
  private reconcile(): void {
    if (!this.running) return;
    const desired = this.desiredPeers();
    desired.forEach((otherPeerId) => {
      if (
        this.shouldInitiate(otherPeerId) &&
        !this.peers.has(otherPeerId) &&
        !this.retryTimers.has(otherPeerId)
      ) {
        this.createPeerConnection(otherPeerId, true);
      }
    });

    let excess = this.peers.size - this.maxPeers;
    if (excess > 0) {
      for (const otherPeerId of Array.from(this.peers.keys())) {
        if (excess <= 0) break;
        if (!desired.has(otherPeerId)) {
          this.logger.debug(`Closing link to ${otherPeerId}: no longer needed`);
          this.cleanupPeerConnection(otherPeerId);
          excess--;
        }
      }
    }
  }

  private connectMissingPeers(): void {
    this.reconcile();
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
    connectionId: string = randomId().slice(0, 8)
  ): PeerConnectionEntry | null {
    if (!this.running || this.peers.has(otherPeerId)) return null;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
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
            user: this.peerInfos.get(otherPeerId) ?? {
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
      this.setupDataChannel(otherPeerId, pc.createDataChannel("data"));

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

    const current = this.sessions.get(otherPeerId);
    if (current) {
      this.sessions.delete(otherPeerId);
      current.session.close();
      try {
        current.channel.close();
      } catch (e) {
        this.logger.warn(`Error closing data channel for ${otherPeerId}:`, e);
      }
    }

    this.removePeerAwareness(otherPeerId);
    this.peerGenerations.delete(otherPeerId);
    this.initiallySynced.delete(otherPeerId);
    this.neighborsOf.delete(otherPeerId);
    if (current && this.running) this.announceNeighbors();
    this.updateFallback();
    this.reportPresence();

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
      connectionId,
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
      // Accept every offer; if that puts us over the cap, reconcile() closes a spare link.
      const entry = this.createPeerConnection(from, false, connectionId);
      if (!entry) return;
      this.scheduleReconcile();
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

  originFor(peerId: string): RemoteOrigin {
    let origin = this.origins.get(peerId);
    if (!origin) {
      origin = new RemoteOrigin(peerId);
      this.origins.set(peerId, origin);
    }
    return origin;
  }

  private setupDataChannel(peerId: string, channel: RTCDataChannel): void {
    const session = new PeerSession(channel, {
      onMessage: (type, payload) => this.handleMessage(peerId, session, type, payload),
      onError: (error) => {
        this.logger.warn(`Closing connection to ${peerId}: ${error.message}`);
        if (this.sessions.get(peerId)?.session === session) {
          this.cleanupPeerConnection(peerId, { retry: true });
        }
      },
    });
    this.sessions.set(peerId, { channel, session });

    channel.onopen = () => {
      this.logger.debug(`Data channel opened for peer ${peerId}`);
      // The peer answers our state vector with exactly what we're missing.
      const step1 = Y.encodeStateVector(this.ydoc);
      const payload = new Uint8Array(1 + step1.length);
      payload[0] = PROTOCOL_VERSION;
      payload.set(step1, 1);
      session.send(MSG_SYNC_STEP1, payload);
      // Before awareness, so the peer doesn't relay our cursors to our own neighbors.
      this.announceNeighbors();

      const clients = Array.from(this.awareness.getStates().keys());
      if (clients.length > 0) {
        session.send(MSG_AWARENESS, encodeAwarenessUpdate(this.awareness, clients));
      }
      session.send(MSG_STATUS, this.statusPayload());
      session.flush();
      this.updateFallback();
    };

    channel.onmessage = (event) => session.receive(event.data as ArrayBuffer);

    channel.onerror = (error) => {
      // Fires when the remote page closes; onclose handles it.
      this.logger.debug(`Data channel error for peer ${peerId}:`, error);
    };

    channel.onclose = () => {
      this.logger.debug(`Data channel closed for peer ${peerId}`);
      if (this.sessions.get(peerId)?.session === session) {
        this.cleanupPeerConnection(peerId, { retry: true });
      }
    };
  }

  private handleMessage(
    peerId: string,
    session: PeerSession,
    type: number,
    payload: Uint8Array
  ): void {
    switch (type) {
      case MSG_SYNC_STEP1: {
        if (payload[0] !== PROTOCOL_VERSION) {
          throw new Error(`unsupported protocol version ${payload[0]}`);
        }
        const theirStateVector = payload.subarray(1);
        session.send(MSG_SYNC_STEP2, Y.encodeStateAsUpdate(this.ydoc, theirStateVector));
        break;
      }
      case MSG_SYNC_STEP2:
        Y.applyUpdate(this.ydoc, payload, this.originFor(peerId));
        if (!this.initiallySynced.has(peerId)) {
          this.initiallySynced.add(peerId);
          this.emit("sync-completed", { docId: this.docId, peerId, updateSize: payload.length });
          this.syncWaiters.forEach((check) => check());
        }
        break;
      case MSG_UPDATE:
        Y.applyUpdate(this.ydoc, payload, this.originFor(peerId));
        break;
      case MSG_STATUS: {
        const status = JSON.parse(new TextDecoder().decode(payload));
        if (!Number.isInteger(status?.generation)) throw new Error("invalid status");
        this.peerGenerations.set(peerId, status.generation);
        this.syncWaiters.forEach((check) => check());
        break;
      }
      case MSG_AWARENESS:
        applyAwarenessUpdate(this.awareness, payload, this.originFor(peerId));
        break;
      case MSG_PERSISTED: {
        const report = JSON.parse(new TextDecoder().decode(payload));
        if (
          typeof report?.peer !== "string" ||
          !Number.isInteger(report?.client) ||
          !Number.isInteger(report?.clock)
        ) {
          throw new Error("invalid save report");
        }
        this.clientToPeer.set(report.client, report.peer);
        this.hooks.onPersisted?.(report.client, report.clock);
        this.forward(MSG_PERSISTED, payload, peerId);
        break;
      }
      case MSG_NEIGHBORS: {
        const ids = JSON.parse(new TextDecoder().decode(payload));
        if (!Array.isArray(ids)) throw new Error("invalid neighbor list");
        const previous = this.neighborsOf.get(peerId);
        const next = new Set<string>(ids.filter((id) => typeof id === "string"));
        this.neighborsOf.set(peerId, next);
        // That peer lost a link, so a relay we skipped may not have reached its target.
        if (previous && Array.from(previous).some((id) => !next.has(id))) {
          this.syncWithNeighbors();
        }
        break;
      }
    }
  }

  private openSessions(): Array<[string, PeerSession]> {
    const open: Array<[string, PeerSession]> = [];
    this.sessions.forEach(({ channel, session }, peerId) => {
      if (channel.readyState === "open") open.push([peerId, session]);
    });
    return open;
  }

  private announceNeighbors(): void {
    const open = this.openSessions();
    const payload = new TextEncoder().encode(JSON.stringify(open.map(([id]) => id)));
    for (const [, session] of open) session.send(MSG_NEIGHBORS, payload);
  }

  // Each neighbor answers our state vector with anything we lack.
  private syncWithNeighbors(): void {
    const stateVector = Y.encodeStateVector(this.ydoc);
    const payload = new Uint8Array(1 + stateVector.length);
    payload[0] = PROTOCOL_VERSION;
    payload.set(stateVector, 1);
    for (const [, session] of this.openSessions()) {
      session.send(MSG_SYNC_STEP1, payload);
    }
  }

  private forward(type: number, payload: Uint8Array, sourcePeerId: string): void {
    const sourceNeighbors = this.neighborsOf.get(sourcePeerId);
    for (const [peerId, session] of this.openSessions()) {
      if (peerId !== sourcePeerId && !sourceNeighbors?.has(peerId)) {
        session.send(type, payload);
      }
    }
  }

  // Yjs only emits updates that were new to us, so relaying stops on its own.
  private onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin instanceof RemoteOrigin) {
      this.forward(MSG_UPDATE, update, origin.peerId);
    }
  };

  broadcastUpdate(update: Uint8Array): void {
    if (update.length < 3) return;
    this.sessions.forEach(({ session }) => session.send(MSG_UPDATE, update));
  }

  broadcastPersisted(clientId: number, clock: number): void {
    const peer =
      clientId === this.ydoc.clientID ? this.peerId : this.clientToPeer.get(clientId) ?? "";
    const payload = new TextEncoder().encode(
      JSON.stringify({ peer, client: clientId, clock })
    );
    for (const [, session] of this.openSessions()) session.send(MSG_PERSISTED, payload);
  }

  setKnownGeneration(generation: number): void {
    if (generation === this.knownGeneration) return;
    this.knownGeneration = generation;
    const payload = this.statusPayload();
    for (const [, session] of this.openSessions()) session.send(MSG_STATUS, payload);
  }

  private statusPayload(): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ generation: this.knownGeneration }));
  }

  /**
   * Resolves true once a peer whose document contains snapshot `generation` has
   * finished its initial sync with us, or false if none does in time.
   */
  waitForPeerSync(generation: number, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const finish = (synced: boolean) => {
        this.syncWaiters.delete(check);
        clearTimeout(timeout);
        clearTimeout(noPeers);
        resolve(synced);
      };
      const check = () => {
        for (const peerId of this.initiallySynced) {
          if ((this.peerGenerations.get(peerId) ?? -1) >= generation) return finish(true);
        }
      };
      const timeout = setTimeout(() => finish(false), timeoutMs);
      const noPeers = setTimeout(() => {
        if (this.presentPeers.size === 0) finish(false);
      }, PRESENCE_SETTLE_MS);
      this.syncWaiters.add(check);
      check();
    });
  }

  // Peers whose cursors reach us, directly or relayed, are in sync with us.
  private reachablePeers(): Set<string> {
    const reachable = new Set(this.openSessions().map(([peerId]) => peerId));
    this.awareness.getStates().forEach((state, clientId) => {
      const peerId = (state as { firetap?: { peerId?: unknown } }).firetap?.peerId;
      if (clientId !== this.ydoc.clientID && typeof peerId === "string") reachable.add(peerId);
    });
    return reachable;
  }

  // The present peers whose edits this client should receive through Firebase.
  // Edits from the log reach the rest of our group through us, so only the
  // group's smallest peer id needs to download them.
  private fallbackPeers(): string[] {
    if (!this.running) return [];
    const reachable = this.reachablePeers();
    if (Array.from(reachable).some((id) => id < this.peerId && this.presentPeers.has(id))) return [];
    return Array.from(this.presentPeers.keys()).filter((id) => !reachable.has(id));
  }

  private updateFallback(): void {
    const peers = this.fallbackPeers();
    if (peers.length === 0) {
      if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
      this.setFallbackActive(false);
      return;
    }
    if (this.fallbackActive) return;
    const mayConnect =
      this.usesWebRTC && peers.some((id) => this.presentPeers.get(id)?.rtc !== false);
    if (!mayConnect) {
      if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
      this.setFallbackActive(true);
      return;
    }
    if (this.fallbackTimer) return;
    // Give WebRTC a chance to connect first.
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      if (this.fallbackPeers().length > 0) this.setFallbackActive(true);
    }, FALLBACK_DELAY_MS);
  }

  private setFallbackActive(active: boolean): void {
    if (this.fallbackActive === active) return;
    this.fallbackActive = active;
    this.hooks.onFallbackChange?.(active);
  }

  private reportPeerGone(peerId: string): void {
    const clients: number[] = [];
    this.clientToPeer.forEach((author, clientId) => {
      if (author === peerId) clients.push(clientId);
    });
    if (clients.length > 0) this.hooks.onPeerGone?.(clients);
  }

  broadcastAwareness(update: Uint8Array): void {
    this.sessions.forEach(({ session }) => session.send(MSG_AWARENESS, update));
  }

  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) => {
    if (added.length > 0 || removed.length > 0) this.updateFallback();
    if (!(origin instanceof RemoteOrigin)) return;
    for (const id of added.concat(updated)) {
      const author = (this.awareness.getStates().get(id) as { firetap?: { peerId?: unknown } } | undefined)
        ?.firetap?.peerId;
      if (typeof author === "string") this.clientToPeer.set(id, author);
    }
    const changed = added.concat(updated, removed);
    if (changed.length > 0) {
      this.forward(
        MSG_AWARENESS,
        encodeAwarenessUpdate(this.awareness, changed),
        origin.peerId
      );
    }
    let clients = this.awarenessClientsByPeer.get(origin.peerId);
    if (!clients) {
      clients = new Set();
      this.awarenessClientsByPeer.set(origin.peerId, clients);
    }
    for (const id of added) clients.add(id);
    for (const id of updated) clients.add(id);
    for (const id of removed) clients.delete(id);
  };

  private removePeerAwareness(peerId: string): void {
    const clients = this.awarenessClientsByPeer.get(peerId);
    this.awarenessClientsByPeer.delete(peerId);
    if (!clients) return;

    const stillReachable = new Set<number>([this.ydoc.clientID]);
    this.awarenessClientsByPeer.forEach((ids) => ids.forEach((id) => stillReachable.add(id)));
    const stale = Array.from(clients).filter((id) => !stillReachable.has(id));
    if (stale.length > 0) {
      removeAwarenessStates(this.awareness, stale, "peer-left");
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
