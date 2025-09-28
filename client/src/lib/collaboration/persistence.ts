import * as Y from 'yjs'
import { rtdb } from '../../firebase'
import { ref, set, get, serverTimestamp, runTransaction } from 'firebase/database'

const DOCUMENTS_BASE = '/documents'
const SNAPSHOTS_BASE = '/snapshots'

export type DocumentSnapshot = {
  update: string
  stateVector: string
  updatedAt: number | object
  version: number
  checksum: string
}

export async function loadDocumentFromFirebase(docId: string): Promise<Uint8Array | null> {
  try {
    // Try to load the latest snapshot first
    const snapshotRef = ref(rtdb, `${SNAPSHOTS_BASE}/${docId}/latest`)
    const snapshotSnap = await get(snapshotRef)
    
    if (snapshotSnap.exists()) {
      const snapshot = snapshotSnap.val() as DocumentSnapshot
      const binary = base64ToUint8Array(snapshot.update)
      console.log(`Loaded document ${docId} from snapshot (version ${snapshot.version})`)
      return binary
    }

    // Fallback to documents collection
    const docRef = ref(rtdb, `${DOCUMENTS_BASE}/${docId}`)
    const docSnap = await get(docRef)
    
    if (!docSnap.exists()) return null
    
    const base64 = docSnap.val()?.update
    if (typeof base64 !== 'string') return null
    
    const binary = base64ToUint8Array(base64)
    console.log(`Loaded document ${docId} from documents collection`)
    return binary
  } catch (e) {
    console.warn('loadDocumentFromFirebase error', e)
    return null
  }
}

export function startPeriodicPersistence(ydoc: Y.Doc, docId: string, intervalMs = 15_000) {
  let persistenceCount = 0
  
  const timer = setInterval(async () => {
    try {
      await persistDocument(ydoc, docId, persistenceCount++)
    } catch (err) {
      console.warn('periodic persistence failed', err)
    }
  }, intervalMs)

  return () => clearInterval(timer)
}

export async function persistDocument(ydoc: Y.Doc, docId: string, version?: number): Promise<void> {
  try {
    const update = Y.encodeStateAsUpdate(ydoc)
    const stateVector = Y.encodeStateVector(ydoc)
    const base64Update = uint8ArrayToBase64(update)
    const base64StateVector = uint8ArrayToBase64(stateVector)
    const checksum = await calculateChecksum(update)
    
    const snapshot: DocumentSnapshot = {
      update: base64Update,
      stateVector: base64StateVector,
      updatedAt: serverTimestamp(),
      version: version || Date.now(),
      checksum
    }

    // Use transaction to ensure atomic updates
    await runTransaction(ref(rtdb, `${SNAPSHOTS_BASE}/${docId}`), (current) => {
      const data = current || {}
      
      return {
        ...data,
        latest: snapshot,
        [`version_${snapshot.version}`]: snapshot
      }
    })

    // Also update the legacy documents collection for backward compatibility
    await set(ref(rtdb, `${DOCUMENTS_BASE}/${docId}`), {
      update: base64Update,
      updatedAt: serverTimestamp(),
      version: snapshot.version
    })

    console.log(`Document ${docId} persisted (version ${snapshot.version}, size: ${update.length} bytes)`)
  } catch (error) {
    console.error('Failed to persist document:', error)
    throw error
  }
}

export async function createDocumentSnapshot(ydoc: Y.Doc, docId: string, label?: string): Promise<void> {
  try {
    const update = Y.encodeStateAsUpdate(ydoc)
    const stateVector = Y.encodeStateVector(ydoc)
    const base64Update = uint8ArrayToBase64(update)
    const base64StateVector = uint8ArrayToBase64(stateVector)
    const checksum = await calculateChecksum(update)
    const timestamp = Date.now()
    
    const snapshot: DocumentSnapshot = {
      update: base64Update,
      stateVector: base64StateVector,
      updatedAt: timestamp,
      version: timestamp,
      checksum
    }

    const snapshotKey = label ? `${label}_${timestamp}` : `snapshot_${timestamp}`
    
    await set(ref(rtdb, `${SNAPSHOTS_BASE}/${docId}/${snapshotKey}`), snapshot)
    
    console.log(`Created snapshot ${snapshotKey} for document ${docId}`)
  } catch (error) {
    console.error('Failed to create snapshot:', error)
    throw error
  }
}

export async function loadDocumentSnapshot(docId: string, snapshotKey: string): Promise<Uint8Array | null> {
  try {
    const snapshotRef = ref(rtdb, `${SNAPSHOTS_BASE}/${docId}/${snapshotKey}`)
    const snap = await get(snapshotRef)
    
    if (!snap.exists()) return null
    
    const snapshot = snap.val() as DocumentSnapshot
    return base64ToUint8Array(snapshot.update)
  } catch (error) {
    console.error('Failed to load snapshot:', error)
    return null
  }
}

export async function getDocumentVersion(docId: string): Promise<number | null> {
  try {
    const snapshotRef = ref(rtdb, `${SNAPSHOTS_BASE}/${docId}/latest`)
    const snap = await get(snapshotRef)
    
    if (!snap.exists()) return null
    
    const snapshot = snap.val() as DocumentSnapshot
    return snapshot.version
  } catch (error) {
    console.error('Failed to get document version:', error)
    return null
  }
}

// Utility functions
function uint8ArrayToBase64(uint8Array: Uint8Array): string {
  return btoa(String.fromCharCode(...uint8Array))
}

function base64ToUint8Array(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
}

async function calculateChecksum(data: Uint8Array): Promise<string> {
  // Create a new ArrayBuffer copy to ensure compatibility
  const buffer = new ArrayBuffer(data.length)
  const view = new Uint8Array(buffer)
  view.set(data)
  
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}
