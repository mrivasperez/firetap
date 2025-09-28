import { initializeApp } from 'firebase/app'
import { getAuth, connectAuthEmulator } from 'firebase/auth'
import { getDatabase, connectDatabaseEmulator } from 'firebase/database'
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore'
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions'
import { getStorage, connectStorageEmulator } from 'firebase/storage'

// Minimal config for local development. We won't use real keys in this project.
const firebaseConfig = {
  apiKey: 'fake-api-key',
  authDomain: 'fake-auth-domain',
  // RTDB URL points to emulator namespace; RTDB SDK ignores this for emulator connection,
  // but having a URL helps some helper libraries if they read it.
  databaseURL: 'http://localhost:9000?ns=demo-realtime-tiptap',
  projectId: 'demo-realtime-tiptap',
  storageBucket: 'fake-storage-bucket',
  messagingSenderId: 'fake-msg-sender',
  appId: 'fake-app-id',
}

const app = initializeApp(firebaseConfig)

export const auth = getAuth(app)
export const rtdb = getDatabase(app)
export const firestore = getFirestore(app)
export const functions = getFunctions(app)
export const storage = getStorage(app)

// Connect to local emulators when running on localhost.
const useEmulator = typeof window !== 'undefined' && location.hostname === 'localhost'

if (useEmulator) {
  // Wrap connections in try/catch to avoid noisy errors during non-emulator runs/tests.
  try {
    connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true })
  } catch (e) {
    void e
  }

  try {
    connectDatabaseEmulator(rtdb, 'localhost', 9000)
  } catch (e) {
    void e
  }

  try {
    connectFirestoreEmulator(firestore, 'localhost', 8080)
  } catch (e) {
    void e
  }

  try {
    connectFunctionsEmulator(functions, 'localhost', 5001)
  } catch (e) {
    void e
  }

  try {
    // Storage emulator default port is 9199
    connectStorageEmulator(storage, 'localhost', 9199)
  } catch (e) {
    void e
  }
}

export default app