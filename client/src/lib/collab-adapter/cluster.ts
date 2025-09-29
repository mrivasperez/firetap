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