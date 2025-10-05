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
import { getDatabase } from 'firebase/database'

// Initialize Firebase
const firebaseApp = initializeApp({
  databaseURL: 'https://your-project.firebaseio.com'
})
const firebaseDatabase = getDatabase(firebaseApp)

// Create the adapter
const adapter = await createFirebaseYWebrtcAdapter({
  docId: 'my-document',
  firebaseDatabase,
  user: {
    name: 'John Doe',
    color: '#ff0000'
  }
})

// Use with TipTap
import { useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'

const editor = useEditor({
  extensions: [
    StarterKit.configure({
      // Disable undoRedo when using collaboration
      undoRedo: false,
    }),
    Collaboration.configure({
      document: adapter.ydoc,
    }),
    CollaborationCaret.configure({
      provider: { awareness: adapter.awareness },
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

### Basic Configuration

```typescript
import { createFirebaseYWebrtcAdapter } from 'firetap'
import { getDatabase } from 'firebase/database'

const adapter = await createFirebaseYWebrtcAdapter({
  docId: 'my-document',
  firebaseDatabase: getDatabase(firebaseApp),
  user: {
    name: 'John Doe',
    color: '#ff0000'
  }
})
```

### Advanced Configuration

For custom database paths, sync intervals, and peer limits:

```typescript
import { createFirebaseYWebrtcAdapter } from 'firetap'
import { getDatabase } from 'firebase/database'

const adapter = await createFirebaseYWebrtcAdapter({
  docId: 'my-document',
  firebaseDatabase: getDatabase(firebaseApp),
  peerId: 'custom-peer-id', // Optional: custom peer identifier
  user: {
    name: 'John Doe',
    color: '#ff0000'
  },
  syncIntervalMs: 15000, // Sync to Firebase every 15 seconds
  maxDirectPeers: 6, // Maximum WebRTC connections
  databasePaths: {
    structure: 'nested',
    nested: {
      basePath: '/my-workspace/documents',
      subPaths: {
        documents: 'documents',
        rooms: 'rooms',
        snapshots: 'snapshots',
        signaling: 'signaling'
      }
    }
  }
})
```

## API Reference

### `createFirebaseYWebrtcAdapter(options)`

Creates and initializes a new adapter instance.

**Options:**
- `docId` (required): Unique identifier for the document
- `firebaseDatabase` (required): Firebase Realtime Database instance
- `peerId` (optional): Custom peer identifier (auto-generated if not provided)
- `user` (optional): User information object
  - `name` (optional): Display name for the user (default: "User-{id}")
  - `color` (optional): Color for user's cursor/presence (auto-generated if not provided)
- `syncIntervalMs` (optional): How often to persist to Firebase (default: 30000ms)
- `maxDirectPeers` (optional): Maximum WebRTC peer connections (default: 10)
- `databasePaths` (optional): Custom Firebase database path structure
  - `structure`: Either `'flat'` or `'nested'`
  - For flat structure: specify custom paths for documents, rooms, snapshots, signaling
  - For nested structure: specify basePath and subPaths

**Returns:** `Promise<AdapterHandle>`

### `AdapterHandle`

The adapter instance with the following interface:

```typescript
interface AdapterHandle {
  // Core properties
  ydoc: Y.Doc
  awareness: Awareness
  
  // Connection management
  disconnect(): void
  reconnect(): Promise<void>
  getConnectionStatus(): ConnectionState
  
  // Peer information
  getPeerCount(): number
  getUserInfo(): UserInfo
  
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

## React Integration Example

Here's a complete example of using Firetap with React and TipTap:

```typescript
import { useEffect, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { createFirebaseYWebrtcAdapter, type AdapterHandle } from 'firetap'
import { getDatabase } from 'firebase/database'

export default function CollaborativeEditor({ 
  docId = 'demo-doc',
  userName = 'Anonymous',
  userColor = '#ff0000'
}) {
  const [adapter, setAdapter] = useState<AdapterHandle | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Disable undoRedo when using collaboration
        undoRedo: adapter ? false : {},
      }),
      // Only add collaboration extensions when adapter is ready
      ...(adapter ? [
        Collaboration.configure({
          document: adapter.ydoc,
        }),
        CollaborationCaret.configure({
          provider: { awareness: adapter.awareness },
          user: {
            name: userName,
            color: userColor,
          },
        }),
      ] : []),
    ],
    editable: !!adapter,
  }, [adapter, userName, userColor])

  useEffect(() => {
    let handle: AdapterHandle | null = null
    
    ;(async () => {
      try {
        setIsLoading(true)
        
        handle = await createFirebaseYWebrtcAdapter({ 
          docId,
          firebaseDatabase: getDatabase(),
          user: { name: userName, color: userColor },
          syncIntervalMs: 15000,
          maxDirectPeers: 6,
        })
        
        setAdapter(handle)
        setIsLoading(false)
      } catch (err) {
        console.error('Failed to initialize editor:', err)
        setIsLoading(false)
      }
    })()

    return () => {
      handle?.disconnect()
    }
  }, [docId, userName, userColor])

  if (isLoading) {
    return <div>Loading collaborative editor...</div>
  }

  return (
    <div>
      <div className="editor-header">
        <span>👥 {adapter?.getPeerCount() || 0} peers</span>
        <span>{adapter?.getConnectionStatus()}</span>
      </div>
      <EditorContent editor={editor} />
    </div>
  )
}
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
