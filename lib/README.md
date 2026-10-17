# Firetap

Real-time collaborative editing for [Yjs](https://docs.yjs.dev/) and [TipTap](https://tiptap.dev/), using WebRTC between collaborators and Firebase Realtime Database for storage.

- **Edits travel peer to peer.** People editing the same document sync directly over WebRTC, so live editing doesn't go through Firebase.
- **Firebase stores the document and introduces peers.** Edits are saved to Firebase as they happen, and Firebase carries presence and the WebRTC handshake.
- **It's built to keep the Firebase bill small.** Documents are stored compressed, new collaborators get the document from people who already have it open, and browsers cache it between visits.

## Install

```bash
npm install firetap yjs y-protocols firebase
```

Firetap runs in the browser: it needs WebRTC, and uses `CompressionStream` and IndexedDB when they're available. To read or edit documents from Node.js (20 or later) with the Admin SDK, see [On a server](#on-a-server).

## Quick start

```ts
import { initializeApp } from 'firebase/app'
import { getDatabase } from 'firebase/database'
import { createFirebaseYWebrtcAdapter } from 'firetap'

const app = initializeApp({ databaseURL: 'https://your-project-default-rtdb.firebaseio.com' })

const adapter = await createFirebaseYWebrtcAdapter({
  docId: 'my-document',
  firebaseDatabase: getDatabase(app),
  user: { name: 'Alice' },
})

// A regular Y.Doc and y-protocols Awareness: use them with any Yjs binding.
adapter.ydoc.getText('notes').insert(0, 'Hello')

// When you're done: saves pending edits, then leaves.
await adapter.disconnect()
```

`createFirebaseYWebrtcAdapter` resolves once the document is loaded. If it can't be read from Firebase, it rejects with a `LoadError` rather than opening an empty document.

### With TipTap

```ts
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { getDatabase } from 'firebase/database'
import { createFirebaseYWebrtcAdapter } from 'firetap'

const adapter = await createFirebaseYWebrtcAdapter({
  docId: 'my-document',
  firebaseDatabase: getDatabase(),
  user: { name: 'Alice' },
})

const editor = new Editor({
  element: document.querySelector<HTMLElement>('#editor')!,
  extensions: [
    StarterKit.configure({ undoRedo: false }), // Yjs handles undo
    Collaboration.configure({ document: adapter.ydoc }),
    CollaborationCaret.configure({
      provider: { awareness: adapter.awareness },
      user: { name: 'Alice', color: '#f783ac' },
    }),
  ],
})
```

## Saving

Each client writes the edits it makes to Firebase about a second after they happen (`persistDebounceMs`). Pending edits are also written when the page is hidden or closed, and by `disconnect()`.

Firetap reports save state, and leaves what to show the user up to your app:

```ts
import { getDatabase } from 'firebase/database'
import { createFirebaseYWebrtcAdapter } from 'firetap'

const adapter = await createFirebaseYWebrtcAdapter({ docId: 'doc', firebaseDatabase: getDatabase() })

// Warn before leaving with edits that haven't reached Firebase.
window.addEventListener('beforeunload', (event) => {
  if (adapter.hasUnsavedChanges()) event.preventDefault()
})

// Show save status: 'saved' | 'saving' | 'unsaved' | 'error'.
adapter.on('save-state-changed', ({ state }) => {
  document.title = state === 'saved' ? 'My document' : `My document (${state})`
})

// Make sure everything is saved before doing something that depends on it.
async function exportDocument() {
  await adapter.flush()
}
```

A failed write is retried automatically; `persist-error` is emitted and the save state stays `'error'` until a retry succeeds.

## Signing out

With `localCache` on, the last snapshot of each opened document stays in IndexedDB. `clearLocalCache()` deletes it for every document, in every tab:

```ts
import { clearLocalCache, type AdapterHandle } from 'firetap'

async function signOut(adapter: AdapterHandle) {
  // Close every open document first, or it may cache itself again.
  await adapter.disconnect()
  await clearLocalCache()
}
```

## Options

| Option | Default | |
|---|---|---|
| `docId` | required | Document identifier. Can't contain `. # $ [ ] /`. |
| `firebaseDatabase` | required | The `Database` from `getDatabase()`. |
| `user` | `{ name: 'User-xxxxxx' }` | Shown to other collaborators. |
| `peerId` | random UUID | Identifies this client. Must be unique per open document, so don't reuse a user id across tabs. |
| `persistDebounceMs` | `1000` | How long local edits are batched before being written. |
| `maxDirectPeers` | `6` | WebRTC connections per client. Larger rooms relay edits through other peers. `0` turns WebRTC off, e.g. in tests: edits are then exchanged through Firebase only, which downloads every edit. |
| `firebaseFallback` | `'auto'` | If a collaborator can't be reached over WebRTC, exchange edits with them through Firebase. `'off'` disables it. |
| `localCache` | `true` | Keep the last downloaded snapshot in IndexedDB so reopening skips the download. Turn off if document content must not stay on the device. |
| `iceServers` | Google's public STUN servers | STUN and TURN servers for WebRTC. Add a TURN server so peers behind strict firewalls can connect. |
| `databasePaths` | `/documents/{docId}/...` | Where data is stored; see [Database layout](#database-layout). |
| `logger` | warnings and errors to the console | Any object with `debug`, `info`, `warn` and `error` methods, e.g. `console` for everything. |

## The adapter

| | |
|---|---|
| `ydoc`, `awareness` | The document and presence state for your Yjs bindings. |
| `disconnect()` | Saves pending edits (waiting up to 5 seconds), then leaves. Returns a promise. |
| `reconnect()` | Drops and re-establishes every connection. |
| `flush()` | Resolves once Firebase has acknowledged all pending edits. |
| `hasUnsavedChanges()` | Whether some local edits haven't been acknowledged yet. |
| `getSaveState()` | `'saved'`, `'saving'`, `'unsaved'` or `'error'`. |
| `getConnectionStatus()` | Firebase connection: `'connecting'`, `'connected'` or `'disconnected'`. |
| `getPeerCount()` | Number of direct WebRTC connections. |
| `getPresentPeers()` | Everyone else who has the document open, as `{ id, name, connectedAt }`, whether or not they're connected directly. |
| `getUserInfo()` | This client's `{ id, name, connectedAt }`. |
| `on(event, callback)`, `off(event, callback)` | Subscribe to events. |

### Events

| Event | Payload | When |
|---|---|---|
| `connection-state-changed` | `{ state }` | The Firebase connection goes up or down. |
| `peer-joined` | `{ peerId, user }` | A direct WebRTC connection is established. |
| `peer-left` | `{ peerId }` | A direct connection closed. |
| `presence-changed` | `{ peers }` | Someone opened or closed the document; `peers` is the new `getPresentPeers()`. |
| `sync-completed` | `{ docId, peerId, updateSize }` | The first sync with a newly connected peer finished. |
| `save-state-changed` | `{ state }` | The save state changed. |
| `persist-error` | `{ error }` | A write to Firebase failed (it will be retried). |
| `document-persisted` | `{ docId, version }` | Recent edits were merged into a new stored snapshot. |
| `error` | `{ error, context }` | Something else failed, e.g. announcing presence. |

## On a server

`firetap/server` reads and edits documents with the Firebase Admin SDK, for scripts and backends that create or change pages:

```ts
import { initializeApp } from 'firebase-admin/app'
import { getDatabase } from 'firebase-admin/database'
import { loadDocument, updateDocument } from 'firetap/server'

initializeApp({ databaseURL: 'https://your-project-default-rtdb.firebaseio.com' })
const database = getDatabase()

// Creates the document if it doesn't exist. Only the edits made in the callback are saved.
const updated = await updateDocument({ docId: 'my-document', database }, (ydoc) => {
  ydoc.getText('notes').insert(0, 'Written by a script\n')
})
updated.destroy()

const ydoc = await loadDocument({ docId: 'my-document', database })
console.log(ydoc.getText('notes').toString())
ydoc.destroy()
```

Both take `docId`, `database`, and optionally `databasePaths`, `logger` and `authorId` (stored as the author of the edits; default `server-<random id>`). They reject with `LoadError` if the document can't be read, and `updateDocument` then saves nothing.

- `updateDocument` isn't idempotent: running the same insert twice inserts the text twice. If a script may run again, check the document's content in the callback first.
- People who have the document open receive the server's edits the next time they open it, not live.
- The Admin SDK bypasses security rules.

## Database layout

By default everything for a document lives under `/documents/{docId}`:

| Path | Contents |
|---|---|
| `meta` | Which snapshot is current. |
| `snapshots/{key}` | The document, gzip-compressed. |
| `updates/{key}` | Edits made since that snapshot. Each client appends only its own. |
| `rooms/peers/{peerId}` | Who has the document open. Removed automatically when a client disconnects. |
| `signaling/{peerId}/{key}` | WebRTC offers and answers, deleted once read. |

To store documents elsewhere, pass `databasePaths`:

```ts
import type { DatabasePathsConfig } from 'firetap'

// /workspaces/acme/docs/{docId}/...
const nested: DatabasePathsConfig = { structure: 'nested', nested: { basePath: '/workspaces/acme/docs' } }

// Separate roots: /presence/{docId}, /updates/{docId}, ...
const flat: DatabasePathsConfig = { structure: 'flat', flat: { rooms: '/presence' } }
```

### Security rules

Firetap doesn't authenticate users; protect documents with Firebase Authentication and security rules. A starting point for the default layout, assuming your app keeps an access list at `/access/{docId}/{uid}`:

```json
{
  "rules": {
    "documents": {
      "$docId": {
        ".read": "auth != null && root.child('access').child($docId).child(auth.uid).exists()",
        ".write": "auth != null && root.child('access').child($docId).child(auth.uid).exists()",
        "updates": {
          "$entry": { ".validate": "newData.hasChild('by')" }
        }
      }
    }
  }
}
```

Everyone with access to a document can read its signaling data, which includes collaborators' network addresses.

## Firebase cost

Firebase bills Realtime Database by data downloaded and data stored; uploads are free. Firetap keeps downloads low:

- Live edits go between peers over WebRTC, not through Firebase.
- Documents are stored gzip-compressed, and the edit log is regularly merged into a snapshot so loads stay small.
- Someone opening a document others already have open gets the snapshot from them, and only downloads the latest edits.
- Browsers cache the snapshot, so reopening an unchanged document downloads almost nothing.
- Presence relies on Firebase's built-in disconnect detection instead of heartbeats, and WebRTC handshakes are compressed.

Measured in Chromium against the Firebase emulator, for a document with 200KB of Yjs state (bytes Firebase sent to clients; production adds TLS overhead):

| Scenario | Before (0.x alpha) | Now |
|---|---|---|
| Open the document | 271KB | 65KB |
| Reopen it in the same browser | 271KB | under 1KB |
| Join while 7 others have it open | 281KB | 7KB |
| 8 people edit together, each reloading twice | 6.8MB | 0.8MB |

To measure your own scenarios, see `bench/run.mjs` (`npm run bench:cost -w lib`).

## Limitations

- **Offline edits are kept in memory only.** If a tab closes while it is offline and can't reach any peer, its unsaved edits are lost. `hasUnsavedChanges()` tells you when that could happen.
- **WebRTC needs a network path.** Peers that can't connect directly need a TURN server (`iceServers`). Until then they still receive each other's edits through Firebase, with a few seconds' delay, but not each other's cursors.
- **One client per peer ID.** Every open document needs its own `peerId`; the default is a fresh random ID.

## License

MIT
