import type { Database } from "firebase/database";
import {
  ref,
  set,
  remove,
  get,
  query,
  orderByChild,
  endAt,
} from "firebase/database";
import { buildDatabasePaths, type DatabasePathsConfig } from "../utils/config";
import { defaultLogger, type Logger } from "../utils/logger";

// Peer Presence Configuration
const STALE_PEER_THRESHOLD_MS = 600_000; // 10 minutes - consider peer stale after this time (aligned with heartbeat optimization)
const MILLISECONDS_TO_SECONDS = 1_000; // Conversion factor for time display

export type PeerInfo = {
  id: string;
  name: string;
  connectedAt: number;
};

export async function announcePresence(
  rtdb: Database,
  docId: string,
  peer: PeerInfo,
  databasePaths?: DatabasePathsConfig,
  logger: Logger = defaultLogger
): Promise<void> {
  try {
    const paths = buildDatabasePaths(databasePaths, docId);
    const peerRef = ref(rtdb, `${paths.rooms}/peers/${peer.id}`);

    // Set up automatic cleanup on disconnect (cost optimization)
    const { onDisconnect } = await import("firebase/database");
    await onDisconnect(peerRef).remove();

    // Add current timestamp for presence cleanup
    const peerWithTimestamp = {
      ...peer,
      lastSeen: Date.now(),
    };
    await set(peerRef, peerWithTimestamp);
  } catch (error) {
    logger.error("Failed to announce presence:", error);
    throw error;
  }
}

export async function stopAnnouncingPresence(
  rtdb: Database,
  docId: string,
  peerId: string,
  databasePaths?: DatabasePathsConfig,
  logger: Logger = defaultLogger
): Promise<void> {
  try {
    const paths = buildDatabasePaths(databasePaths, docId);
    const peerRef = ref(rtdb, `${paths.rooms}/peers/${peerId}`);
    await remove(peerRef);
  } catch (error) {
    logger.warn("Failed to remove presence:", error);
    // Don't throw here as it's cleanup
  }
}

export async function cleanupStalePeers(
  rtdb: Database,
  docId: string,
  databasePaths?: DatabasePathsConfig,
  logger: Logger = defaultLogger
): Promise<void> {
  try {
    const paths = buildDatabasePaths(databasePaths, docId);
    const peersRef = ref(rtdb, `${paths.rooms}/peers`);

    // Fetch peers with lastSeen older than the stale threshold
    const now = Date.now();
    const staleThreshold = now - STALE_PEER_THRESHOLD_MS;

    // Query for stale peers; where lastSeen <= staleThreshold
    const staleQuery = query(
      peersRef,
      orderByChild("lastSeen"),
      endAt(staleThreshold)
    );

    const snapshot = await get(staleQuery);

    if (snapshot.exists()) {
      const stalePeers = snapshot.val();
      const stalePromises: Promise<void>[] = [];

      Object.entries(stalePeers).forEach(([peerId, peerData]) => {
        const peer = peerData as PeerInfo & { lastSeen?: number };
        const timeSinceLastSeen = peer.lastSeen
          ? (now - peer.lastSeen) / MILLISECONDS_TO_SECONDS
          : "unknown";

        logger.debug(
          `Removing stale peer: ${peerId} (last seen ${timeSinceLastSeen}s ago)`
        );

        // Remove peer presence
        const stalePeerRef = ref(rtdb, `${paths.rooms}/peers/${peerId}`);
        stalePromises.push(remove(stalePeerRef));

        // Also clean up any signaling data for this peer
        const signalingRef = ref(rtdb, `${paths.signaling}/${peerId}`);
        stalePromises.push(remove(signalingRef));
      });

      await Promise.all(stalePromises);

      if (stalePromises.length > 0) {
        logger.debug(
          `Cleaned up ${stalePromises.length / 2} stale peer entries`
        );
      }
    }
  } catch (error) {
    logger.warn("Failed to cleanup stale peers:", error);
  }
}
