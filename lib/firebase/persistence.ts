import * as Y from 'yjs'
import type { Database } from 'firebase/database'
import { ref, set, get, serverTimestamp } from 'firebase/database'
import { buildDatabasePaths, type DatabasePathsConfig } from '../utils/config'
import { defaultLogger, type Logger } from '../utils/logger'

// ============================================================================
// CONSTANTS
// ============================================================================

// Persistence Configuration
const PERSISTENCE_DEBOUNCE_MS = 2_000 // 2 seconds - debounce rapid changes
const DEFAULT_PERSISTENCE_INTERVAL_MS = 60_000 // 60 seconds - default periodic save interval

// Hash Algorithm
const CHECKSUM_ALGORITHM = 'SHA-256' // Algorithm for document checksums

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Fast array equality check for Uint8Arrays
 */
function arraysAreEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// ============================================================================
// TYPES
// ============================================================================

export type DocumentSnapshot = {
  update: string
  stateVector: string
  updatedAt: number | object
  version: number
  checksum: string
}

export async function loadDocumentFromFirebase(rtdb: Database, docId: string, databasePaths?: DatabasePathsConfig, logger: Logger = defaultLogger): Promise<Uint8Array | null> {
  try {
    const paths = buildDatabasePaths(databasePaths, docId)
    
    // Try to load the latest snapshot first
    const snapshotRef = ref(rtdb, `${paths.snapshots}/latest`)
    const snapshotSnap = await get(snapshotRef)
    
    if (snapshotSnap.exists()) {
      const snapshot = snapshotSnap.val() as DocumentSnapshot
      const binary = base64ToUint8Array(snapshot.update)
      return binary
    }

    // BACKWARD COMPATIBILITY: Fallback to legacy /documents collection
    // Only used for loading old documents created before optimization
    // New documents are saved only to /snapshots/latest
    const docRef = ref(rtdb, `${paths.documents}`)
    const docSnap = await get(docRef)
    
    if (!docSnap.exists()) return null
    
    const base64 = docSnap.val()?.update
    if (typeof base64 !== 'string') return null
    
    const binary = base64ToUint8Array(base64)
    return binary
  } catch (e) {
    logger.warn('loadDocumentFromFirebase error', e)
    return null
  }
}

export function startPeriodicPersistence(rtdb: Database, ydoc: Y.Doc, docId: string, intervalMs = DEFAULT_PERSISTENCE_INTERVAL_MS, databasePaths?: DatabasePathsConfig, logger: Logger = defaultLogger) {
  let persistenceCount = 0
  let lastPersistedStateVector: Uint8Array | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let hasChanges = false
  
  // Track document changes
  const updateHandler = () => {
    hasChanges = true
    
    // Debounce rapid changes to avoid excessive saves
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
    
    debounceTimer = setTimeout(async () => {
      if (hasChanges) {
        try {
          // OPTIMIZATION: Use state vector comparison instead of full state hash
          // This is much faster for large documents (O(peers) vs O(document_size))
          const currentStateVector = Y.encodeStateVector(ydoc)
          const stateVectorChanged = !lastPersistedStateVector || 
            !arraysAreEqual(currentStateVector, lastPersistedStateVector)
          
          if (stateVectorChanged) {
            await persistDocument(rtdb, ydoc, docId, persistenceCount++, databasePaths, logger)
            lastPersistedStateVector = currentStateVector
            hasChanges = false
          }
        } catch (err) {
          logger.warn('debounced persistence failed', err)
        }
      }
    }, PERSISTENCE_DEBOUNCE_MS) // 2 second debounce
  }
  
  // Listen for document updates
  ydoc.on('update', updateHandler)
  
  // Periodic check as backup (only persists if there are unsynced changes)
  const timer = setInterval(async () => {
    try {
      if (hasChanges) {
        const currentStateVector = Y.encodeStateVector(ydoc)
        const stateVectorChanged = !lastPersistedStateVector || 
          !arraysAreEqual(currentStateVector, lastPersistedStateVector)
        
        if (stateVectorChanged) {
          await persistDocument(rtdb, ydoc, docId, persistenceCount++, databasePaths, logger)
          lastPersistedStateVector = currentStateVector
          hasChanges = false
        }
      }
    } catch (err) {
      logger.warn('periodic persistence failed', err)
    }
  }, intervalMs)

  // Initialize the last persisted state vector
  lastPersistedStateVector = Y.encodeStateVector(ydoc)

  return () => {
    ydoc.off('update', updateHandler)
    clearInterval(timer)
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
  }
}

export async function persistDocument(rtdb: Database, ydoc: Y.Doc, docId: string, version?: number, databasePaths?: DatabasePathsConfig, logger: Logger = defaultLogger): Promise<void> {
  try {
    const paths = buildDatabasePaths(databasePaths, docId)
    
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

    // OPTIMIZED: Only write to /snapshots/latest (removed duplicate /documents write)
    // This reduces Firebase write operations by 50% for persistence
    // Note: loadDocumentFromFirebase still has /documents fallback for backward compatibility
    await set(ref(rtdb, `${paths.snapshots}/latest`), snapshot)

    // REMOVED: Duplicate write to /documents collection
    // Old code (removed for cost optimization):
    // await set(ref(rtdb, `${paths.documents}`), { ... })

  } catch (error) {
    logger.error('Failed to persist document:', error)
    throw error
  }
}

// Utility functions
function uint8ArrayToBase64(uint8Array: Uint8Array): string {
  // Handle large arrays by processing in chunks to avoid "too many arguments" error
  const CHUNK_SIZE = 8192; // 8KB chunks - safe for function call stack
  let binary = '';
  
  for (let i = 0; i < uint8Array.length; i += CHUNK_SIZE) {
    const chunk = uint8Array.subarray(i, Math.min(i + CHUNK_SIZE, uint8Array.length));
    binary += String.fromCharCode(...chunk);
  }
  
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

async function calculateChecksum(data: Uint8Array): Promise<string> {
  // Create a new ArrayBuffer copy to ensure compatibility
  const buffer = new ArrayBuffer(data.length)
  const view = new Uint8Array(buffer)
  view.set(data)
  
  const hashBuffer = await crypto.subtle.digest(CHECKSUM_ALGORITHM, buffer)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}
