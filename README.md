# Firetap

> A Yjs provider for building real-time, collaborative editors with Firebase Realtime Database and WebRTC

Firetap combines Firebase Realtime Database for persistence with WebRTC peer-to-peer connections to create a robust, scalable collaboration solution for TipTap editors and other Yjs-based applications.

## Features

- **Firebase Persistence** - Automatic document persistence to Firebase Realtime Database
- **WebRTC P2P** - Direct peer-to-peer connections for fast synchronization
- **Awareness Protocol** - Real-time presence and cursor tracking
- **Auto-reconnection** - Handles network interruptions gracefully
- **Memory Management** - Built-in garbage collection and cleanup
- **TypeScript** - Full type safety and IntelliSense support
- **Zero Config** - Sensible defaults with simple configuration options

## Installation

```bash
npm install firetap yjs firebase y-protocols
```

## Quick Start

```typescript
import { createFirebaseYWebrtcAdapter } from 'firetap'
import { initializeApp } from 'firebase/app'
import * as Y from 'yjs'

// Initialize Firebase
const firebaseApp = initializeApp({
  databaseURL: 'https://your-project.firebaseio.com'
})

// Create a Yjs document
const ydoc = new Y.Doc()

// Create the adapter
const adapter = await createFirebaseYWebrtcAdapter({
  firebaseApp,
  ydoc,
  documentId: 'my-document',
  workspaceId: 'my-workspace',
  userId: 'user-123',
  userName: 'John Doe'
})

// Use with TipTap
import { useEditor } from '@tiptap/react'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCursor from '@tiptap/extension-collaboration-cursor'

const editor = useEditor({
  extensions: [
    StarterKit.configure({
      history: false, // Disable local history
    }),
    Collaboration.configure({
      document: ydoc,
    }),
    CollaborationCursor.configure({
      provider: adapter.awareness,
      user: {
        name: 'John Doe',
        color: '#ff0000',
      },
    }),
  ],
})

// Cleanup when done
adapter.disconnect()
```

## Configuration

### Simple Configuration

For basic use cases:

```typescript
import { createSimpleConfig } from 'firetap'

const config = createSimpleConfig({
  workspaceId: 'my-workspace',
  documentId: 'my-document',
  userId: 'user-123',
  userName: 'John Doe'
})

const adapter = await createFirebaseYWebrtcAdapter({
  firebaseApp,
  ydoc,
  ...config
})
```

### Advanced Configuration

For custom database paths and behavior:

```typescript
import { createAdapterConfig, buildDatabasePaths } from 'firetap'

const paths = buildDatabasePaths({
  workspaceId: 'my-workspace',
  documentId: 'my-document',
  customPrefix: 'collab' // Default is 'collaboration'
})

const config = createAdapterConfig({
  documentId: 'my-document',
  workspaceId: 'my-workspace',
  userId: 'user-123',
  userName: 'John Doe',
  userColor: '#ff0000',
  databasePaths: paths,
  persistenceInterval: 5000, // Save every 5 seconds
  cleanupInterval: 30000, // Cleanup every 30 seconds
  awarenessUpdateInterval: 1000 // Update presence every second
})
```

## API Reference

### `createFirebaseYWebrtcAdapter(options)`

Creates and initializes a new adapter instance.

**Options:**
- `firebaseApp` (required): Firebase app instance
- `ydoc` (required): Yjs document instance
- `documentId` (required): Unique identifier for the document
- `workspaceId` (required): Workspace/room identifier
- `userId` (required): Current user's unique identifier
- `userName` (required): Display name for the user
- `userColor` (optional): Color for user's cursor/presence
- `databasePaths` (optional): Custom Firebase database paths
- `persistenceInterval` (optional): How often to persist (default: 3000ms)
- `cleanupInterval` (optional): How often to cleanup (default: 60000ms)
- `awarenessUpdateInterval` (optional): Awareness update frequency (default: 500ms)

**Returns:** `Promise<YDocumentAdapter>`

### `YDocumentAdapter`

The adapter instance with the following interface:

```typescript
interface YDocumentAdapter {
  // Core properties
  ydoc: Y.Doc
  awareness: Awareness
  
  // Connection management
  disconnect(): void
  reconnect(): Promise<void>
  getConnectionStatus(): ConnectionState
  
  // Peer information
  getPeerCount(): number
  getUserInfo(): PeerInfo
  
  // Memory management
  getMemoryStats(): MemoryStats
  forceGarbageCollection(): void
  
  // Event handling
  on<K extends keyof AdapterEvents>(event: K, callback: (data: AdapterEvents[K]) => void): void
  off<K extends keyof AdapterEvents>(event: K, callback: (data: AdapterEvents[K]) => void): void
}
```

### Events

Listen to adapter events:

```typescript
adapter.on('connection-state-changed', ({ state }) => {
  console.log('Connection state:', state)
})

adapter.on('peer-joined', ({ peerId, user }) => {
  console.log('Peer joined:', user.name)
})

adapter.on('peer-left', ({ peerId }) => {
  console.log('Peer left:', peerId)
})

adapter.on('document-persisted', ({ docId, version }) => {
  console.log('Document saved, version:', version)
})

adapter.on('error', ({ error, context }) => {
  console.error('Error:', error, 'Context:', context)
})
```

## Persistence Utilities

For advanced use cases, you can manually control persistence:

```typescript
import { 
  loadDocumentFromFirebase,
  persistDocument,
  createDocumentSnapshot,
  getDocumentVersion
} from 'firetap'

// Load a document manually
await loadDocumentFromFirebase(firebaseApp, ydoc, documentId, workspaceId)

// Persist a document manually
await persistDocument(firebaseApp, ydoc, documentId, workspaceId)

// Create a snapshot
const snapshot = await createDocumentSnapshot(ydoc)

// Get current version
const version = await getDocumentVersion(firebaseApp, documentId, workspaceId)
```

## How It Works

Firetap uses a hybrid approach:

1. **WebRTC P2P**: Primary synchronization happens peer-to-peer for low latency
2. **Firebase Signaling**: Peers discover each other through Firebase Realtime Database
3. **Firebase Persistence**: Documents are periodically saved to Firebase for durability
4. **Awareness**: User presence and cursor positions are shared via WebRTC

This architecture provides:
- Fast real-time updates (WebRTC)
- Reliable persistence (Firebase)
- Scalable signaling (Firebase)
- Offline support (Yjs CRDT)

## License

ISC

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## Repository

https://github.com/mrivasperez/project-realtime-tiptap
