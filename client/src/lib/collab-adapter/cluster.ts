import type { Database } from 'firebase/database'
import { ref, set, remove } from 'firebase/database'
import { buildDatabasePaths, type DatabasePathsConfig } from './config'

export type PeerInfo = {
  id: string
  name: string
  color: string
  connectedAt: number
}

export async function announcePresence(rtdb: Database, docId: string, peer: PeerInfo, databasePaths?: DatabasePathsConfig): Promise<void> {
  try {
    const paths = buildDatabasePaths(databasePaths || { structure: 'flat', flat: { documents: '/documents', rooms: '/rooms', snapshots: '/snapshots', signaling: '/signaling' } }, docId)
    const peerRef = ref(rtdb, `${paths.rooms}/peers/${peer.id}`)
    // Add current timestamp for presence cleanup
    const peerWithTimestamp = {
      ...peer,
      lastSeen: Date.now()
    }
    await set(peerRef, peerWithTimestamp)
  } catch (error) {
    console.error('Failed to announce presence:', error)
    throw error
  }
}

export async function stopAnnouncingPresence(rtdb: Database, docId: string, peerId: string, databasePaths?: DatabasePathsConfig): Promise<void> {
  try {
    const paths = buildDatabasePaths(databasePaths || { structure: 'flat', flat: { documents: '/documents', rooms: '/rooms', snapshots: '/snapshots', signaling: '/signaling' } }, docId)
    const peerRef = ref(rtdb, `${paths.rooms}/peers/${peerId}`)
    await remove(peerRef)
  } catch (error) {
    console.warn('Failed to remove presence:', error)
    // Don't throw here as it's cleanup
  }
}

export async function cleanupStalePeers(rtdb: Database, docId: string, databasePaths?: DatabasePathsConfig): Promise<void> {
  try {
    const paths = buildDatabasePaths(databasePaths || { structure: 'flat', flat: { documents: '/documents', rooms: '/rooms', snapshots: '/snapshots', signaling: '/signaling' } }, docId)
    const peersRef = ref(rtdb, `${paths.rooms}/peers`)
    
    // Get all current peers
    const { get } = await import('firebase/database')
    const snapshot = await get(peersRef)
    
    if (snapshot.exists()) {
      const peers = snapshot.val()
      const now = Date.now()
      const staleThreshold = 120000 // 2 minutes
      
      const stalePromises: Promise<void>[] = []
      
      Object.entries(peers).forEach(([peerId, peerData]) => {
        const peer = peerData as PeerInfo & { lastSeen?: number }
        if (peer.lastSeen && (now - peer.lastSeen) > staleThreshold) {
          console.log(`Removing stale peer: ${peerId} (last seen ${(now - peer.lastSeen) / 1000}s ago)`)
          const stalePeerRef = ref(rtdb, `${paths.rooms}/peers/${peerId}`)
          stalePromises.push(remove(stalePeerRef))
          
          // Also clean up any signaling data for this peer
          const signalingRef = ref(rtdb, `${paths.signaling}/${peerId}`)
          stalePromises.push(remove(signalingRef))
        }
      })
      
      await Promise.all(stalePromises)
      
      if (stalePromises.length > 0) {
        console.log(`Cleaned up ${stalePromises.length / 2} stale peer entries`)
      }
    }
  } catch (error) {
    console.warn('Failed to cleanup stale peers:', error)
  }
}