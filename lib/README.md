# Firetap

**Real-time collaborative editing adapter for TipTap, Yjs, and Firebase Realtime Database**

Firetap is a high-performance, cost-optimized adapter that enables seamless real-time collaboration in your applications using Yjs CRDTs, Firebase Realtime Database for persistence, and WebRTC for peer-to-peer synchronization.

## Why Firetap?

### Performance First

- **Hybrid Architecture**: Combines Firebase Realtime Database for persistence with WebRTC mesh networking for real-time sync
- **Zero External Dependencies for Compression**: Uses native browser `CompressionStream` API (gzip) to reduce payload sizes
- **Intelligent Data Flow**: Direct peer-to-peer sync for active collaboration, Firebase only for persistence and signaling
- **Automatic Garbage Collection**: Configurable Y.js GC to prevent memory bloat in long-running sessions

### Firebase Cost Optimization

Firebase Realtime Database charges for:
- **Storage**: $5/GB/month
- **Downloads**: All bytes downloaded including protocol overhead, SSL encryption, and connection handshakes

**Firetap minimizes these costs through:**

#### 1. **Dramatic Bandwidth Reduction**
- **Native Gzip Compression**: Automatically compresses updates > 1KB, typically achieving 60-80% size reduction
- **WebRTC Mesh Networking**: Active collaborators sync directly peer-to-peer, bypassing Firebase entirely
- **Batched Updates**: Awareness states throttled to prevent excessive Firebase writes
- **Smart Persistence**: Only periodic snapshots written to Firebase, not every keystroke

#### 2. **Connection Cost Optimization**
- **Persistent Connections**: Uses Firebase SDK's native WebSocket connection (not REST API)
- **Reduced SSL Handshakes**: Single long-lived connection vs. multiple HTTPS requests
- **Minimal Protocol Overhead**: WebRTC handles real-time sync, Firebase only for initial load and signaling

#### 3. **Storage Efficiency**
- **Compressed Snapshots**: Document snapshots stored in gzip format when beneficial
- **Periodic Cleanup**: Automatic cleanup of stale signaling data and peer presence
- **Efficient Data Structures**: Flat or workspace-based paths to minimize nested reads

#### Real-World Cost Impact

**Traditional approach** (REST API, every update through Firebase):
```
100 users × 100 updates/min × 5KB/update × 60 min = 3GB/hour
= $0.15/hour in bandwidth alone
```

**Firetap approach** (WebRTC mesh + compression):
```
100 users × 1 initial load × 50KB (compressed) = 5MB
+ periodic snapshots × 10/hour × 50KB = 500KB
= ~6MB/hour = $0.0003/hour
```

**Savings: ~99.8% reduction in Firebase bandwidth costs for active collaboration sessions**

## Installation

```bash
npm install firetap yjs y-protocols firebase
```

## Quick Start

### Basic Setup

```typescript
import { createFirebaseYWebrtcAdapter } from 'firetap';
import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';

// Initialize Firebase
const firebaseApp = initializeApp({
  databaseURL: 'https://your-project.firebaseio.com',
});
const database = getDatabase(firebaseApp);

// Create adapter
const adapter = await createFirebaseYWebrtcAdapter({
  docId: 'my-document',
  firebaseDatabase: database,
  user: {
    name: 'Alice',
    color: '#ff0000',
  },
});

// Access Y.Doc and Awareness
const { ydoc, awareness } = adapter;

// Clean up when done
adapter.destroy();
```

### With TipTap

```typescript
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import { createFirebaseYWebrtcAdapter } from 'firetap';

const adapter = await createFirebaseYWebrtcAdapter({
  docId: 'my-doc',
  firebaseDatabase: database,
  user: { name: 'Alice', color: '#ff0000' },
});

const editor = new Editor({
  extensions: [
    StarterKit.configure({
      history: false, // Disable local history (Yjs handles this)
    }),
    Collaboration.configure({
      document: adapter.ydoc,
    }),
    CollaborationCursor.configure({
      provider: adapter.awareness,
      user: { name: 'Alice', color: '#ff0000' },
    }),
  ],
});
```

## Configuration

### Simple Configuration

```typescript
import { createSimpleConfig } from 'firetap';

const adapter = await createFirebaseYWebrtcAdapter({
  docId: 'my-document',
  firebaseDatabase: database,
  databasePaths: createSimpleConfig(), // Uses default flat structure
  syncIntervalMs: 30000, // Save to Firebase every 30 seconds
  maxDirectPeers: 5, // Max WebRTC connections per peer
});
```

### Workspace Configuration

```typescript
import { createWorkspaceConfig } from 'firetap';

const adapter = await createFirebaseYWebrtcAdapter({
  docId: 'my-document',
  firebaseDatabase: database,
  databasePaths: createWorkspaceConfig('workspace-123'),
  user: {
    name: 'Alice',
    color: '#ff0000',
    id: 'user-456',
  },
});
```

### Advanced Configuration

```typescript
import { buildDatabasePaths } from 'firetap';

const adapter = await createFirebaseYWebrtcAdapter({
  docId: 'my-document',
  firebaseDatabase: database,
  databasePaths: {
    structure: 'workspace',
    workspace: {
      workspaceId: 'my-workspace',
      basePath: '/workspaces',
    },
  },
  syncIntervalMs: 60000, // Persist every 60 seconds
  maxDirectPeers: 10, // Allow up to 10 WebRTC connections
  peerId: 'custom-peer-id', // Optional custom peer ID
});
```

## API Reference

### `createFirebaseYWebrtcAdapter(options)`

Creates a new Firetap adapter instance.

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `docId` | `string` | Required | Unique document identifier |
| `firebaseDatabase` | `Database` | Required | Firebase Realtime Database instance |
| `peerId` | `string` | `crypto.randomUUID()` | Unique peer identifier |
| `user` | `UserInfo` | `{}` | User information for awareness |
| `syncIntervalMs` | `number` | `30000` | Firebase persistence interval (ms) |
| `maxDirectPeers` | `number` | `5` | Max simultaneous WebRTC connections |
| `databasePaths` | `DatabasePathsConfig` | Flat structure | Firebase path configuration |

**Returns:** `Promise<AdapterHandle>`

### AdapterHandle

```typescript
interface AdapterHandle {
  ydoc: Y.Doc;              // Yjs document
  awareness: Awareness;      // Awareness instance
  destroy: () => void;       // Cleanup function
  on: (event, callback) => void;     // Event listener
  off: (event, callback) => void;    // Remove event listener
  reconnect: () => Promise<void>;    // Reconnect to Firebase
}
```

### Events

```typescript
adapter.on('connection-state-changed', ({ state }) => {
  console.log('Connection state:', state); // 'connecting' | 'connected' | 'disconnected'
});

adapter.on('peer-connected', ({ peerId }) => {
  console.log('Peer connected:', peerId);
});

adapter.on('peer-disconnected', ({ peerId }) => {
  console.log('Peer disconnected:', peerId);
});

adapter.on('sync-complete', () => {
  console.log('Initial sync complete');
});
```

## Utility Functions

### Configuration Helpers

```typescript
import {
  createSimpleConfig,
  createWorkspaceConfig,
  createAdapterConfig,
  validateConfig,
  generateUserId,
  buildDatabasePaths,
  DEFAULT_DATABASE_PATHS,
  DEFAULT_CONFIG,
} from 'firetap';

// Generate unique user ID
const userId = generateUserId();

// Create simple flat structure config
const simpleConfig = createSimpleConfig();

// Create workspace-based config
const workspaceConfig = createWorkspaceConfig('workspace-id');

// Validate configuration
const isValid = validateConfig(myConfig);

// Build database paths
const paths = buildDatabasePaths(config);
```

### Constants

```typescript
import {
  DEFAULT_MAX_DIRECT_PEERS,      // 5
  PEER_PRESENCE_TIMEOUT_MS,      // 60000 (1 minute)
  COMPRESSION_THRESHOLD,         // 1024 bytes
  DEFAULT_SYNC_INTERVAL_MS,      // 30000 (30 seconds)
  AWARENESS_THROTTLE_MS,         // 1000 (1 second)
  MAX_AWARENESS_STATES,          // 100
  HEARTBEAT_INTERVAL_MS,         // 30000
  STALE_CONNECTION_TIMEOUT_MS,   // 180000 (3 minutes)
} from 'firetap';
```

## Architecture

### Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Active Collaboration                      │
│                                                              │
│  Peer A ←─────── WebRTC Mesh ───────→ Peer B               │
│    ↑                                      ↑                  │
│    │                                      │                  │
│    └──────────── WebRTC ─────────────────┘                  │
│                                                              │
│  (Real-time sync happens peer-to-peer, zero Firebase cost)  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                   Persistence Layer                          │
│                                                              │
│            Firebase Realtime Database                        │
│  ┌─────────────────────────────────────────────────┐       │
│  │  Periodic Snapshots (compressed, every 30s)     │       │
│  │  Signaling Data (for WebRTC handshake)         │       │
│  │  Peer Presence (heartbeats, auto-cleanup)      │       │
│  └─────────────────────────────────────────────────┘       │
│                                                              │
│  (Minimal Firebase usage, optimized for cost)               │
└─────────────────────────────────────────────────────────────┘
```

### Key Optimizations

1. **WebRTC Mesh Network**: Peers sync directly, Firebase only stores periodic snapshots
2. **Native Compression**: Gzip compression using browser APIs (no external dependencies)
3. **Smart Throttling**: Awareness updates batched, presence heartbeats optimized
4. **Automatic Cleanup**: Stale data removed periodically to reduce storage costs
5. **Memory Management**: Y.js garbage collection prevents memory leaks
6. **Connection Pooling**: Single Firebase WebSocket connection per client

## Security

Firetap works with Firebase Realtime Database Security Rules:

```json
{
  "rules": {
    "documents": {
      "$docId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    },
    "rooms": {
      "$docId": {
        "peers": {
          "$peerId": {
            ".read": "auth != null",
            ".write": "auth != null && $peerId === auth.uid"
          }
        }
      }
    },
    "signaling": {
      "$docId": {
        ".read": "auth != null",
        ".write": "auth != null"
      }
    }
  }
}
```

## Best Practices

### Optimize for Cost

```typescript
// ✅ Good: Longer sync intervals for infrequent changes
const adapter = await createFirebaseYWebrtcAdapter({
  docId: 'my-doc',
  firebaseDatabase: database,
  syncIntervalMs: 60000, // 1 minute
});

// ❌ Avoid: Very short intervals create unnecessary Firebase writes
const adapter = await createFirebaseYWebrtcAdapter({
  docId: 'my-doc',
  firebaseDatabase: database,
  syncIntervalMs: 1000, // 1 second - too frequent!
});
```

### Monitor Performance

```typescript
adapter.on('connection-state-changed', ({ state }) => {
  // Track connection quality
  analytics.track('collaboration-connection', { state });
});

adapter.on('peer-connected', ({ peerId }) => {
  // Monitor mesh network health
  console.log('WebRTC peer connected:', peerId);
});
```

### Clean Up Properly

```typescript
// Always destroy adapter when component unmounts
useEffect(() => {
  let adapter;
  
  createFirebaseYWebrtcAdapter(options).then(a => {
    adapter = a;
  });
  
  return () => {
    adapter?.destroy();
  };
}, []);
```

## Performance Characteristics

| Metric | Value | Notes |
|--------|-------|-------|
| Initial Load | ~50-100KB | Compressed document snapshot |
| Peer Sync | 0 bytes via Firebase | Direct WebRTC connection |
| Awareness Update | ~500 bytes | User cursor/selection data |
| Heartbeat | ~100 bytes | Every 30 seconds |
| Snapshot Save | ~50-100KB | Every 30 seconds (configurable) |
| Memory Overhead | ~5-10MB | Per document, with GC |

## Troubleshooting

### High Bandwidth Costs?

1. **Check sync interval**: Increase `syncIntervalMs` to reduce Firebase writes
2. **Verify WebRTC**: Ensure peers are connecting via WebRTC (check console logs)
3. **Monitor compression**: Check if compression is enabled and working
4. **Review Rules**: Ensure security rules aren't causing denied operations (they still cost bandwidth!)

### WebRTC Not Connecting?

1. **Check STUN servers**: Default uses Google's public STUN servers
2. **Corporate firewall**: May need to configure TURN servers
3. **Browser support**: Ensure browser supports WebRTC and CompressionStream API

### Performance Issues?

1. **Enable garbage collection**: Ensure `ydoc.gc = true`
2. **Limit awareness states**: Check `MAX_AWARENESS_STATES` constant
3. **Reduce peer connections**: Lower `maxDirectPeers` if experiencing slowdown
4. **Monitor memory**: Check for memory leaks in long-running sessions

## License

MIT License - see [LICENSE](./LICENSE) file for details

## Contributing

Contributions are welcome! Please read our contributing guidelines and submit pull requests to our [GitHub repository](https://github.com/mrivasperez/firetap).

## Links

- [GitHub Repository](https://github.com/mrivasperez/firetap)
- [Issue Tracker](https://github.com/mrivasperez/firetap/issues)
- [Firebase Realtime Database Pricing](https://firebase.google.com/pricing)
- [Yjs Documentation](https://docs.yjs.dev/)
- [TipTap Documentation](https://tiptap.dev/)

---

Built with ❤️ by [Miguel Rivas Perez](https://github.com/mrivasperez)
