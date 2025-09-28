import { rtdb } from '../../firebase'
import { ref, set, remove } from 'firebase/database'

export type PeerInfo = {
  id: string
  name: string
  color: string
  connectedAt: number
}

const ROOMS_BASE = '/rooms'

export async function announcePresence(docId: string, peer: PeerInfo): Promise<void> {
  try {
    const peerRef = ref(rtdb, `${ROOMS_BASE}/${docId}/peers/${peer.id}`)
    // Add current timestamp for presence cleanup
    const peerWithTimestamp = {
      ...peer,
      lastSeen: Date.now()
    }
    await set(peerRef, peerWithTimestamp)
    console.log(`Announced presence for peer ${peer.id} in document ${docId}`)
  } catch (error) {
    console.error('Failed to announce presence:', error)
    throw error
  }
}

export async function stopAnnouncingPresence(docId: string, peerId: string): Promise<void> {
  try {
    const peerRef = ref(rtdb, `${ROOMS_BASE}/${docId}/peers/${peerId}`)
    await remove(peerRef)
    console.log(`Removed presence for peer ${peerId} from document ${docId}`)
  } catch (error) {
    console.warn('Failed to remove presence:', error)
    // Don't throw here as it's cleanup
  }
}