# Changelog

## Unreleased

### New

- `firetap/server`: `loadDocument()` and `updateDocument()` read and edit documents with the Firebase Admin SDK. People with the document open receive the server's edits within a few seconds.
- `clearLocalCache()` deletes the documents cached in IndexedDB, e.g. when signing out.
- `getPresentPeers()` and the `presence-changed` event list everyone who has the document open. `peer-joined` and `peer-left` only cover direct WebRTC connections.
- `maxDirectPeers: 0` turns WebRTC off, so edits are exchanged through Firebase only, e.g. in tests. Peers that use WebRTC don't try to connect to such a client.

### Fixes

- A collaborator who can't connect to anyone over WebRTC is no longer invisible to the others. Peers that are connected to each other now also receive edits through Firebase while someone present is unreachable; one peer in each connected group downloads them and relays them to the rest.

## 1.0.0-beta.1

This release reworks how documents are stored and synced. It isn't compatible with documents saved by the alpha releases.

### Breaking changes

- Documents are stored as a compressed snapshot plus a log of recent edits (`meta`, `snapshots`, `updates` under each document). Data written by alpha releases isn't read.
- `disconnect()` returns a promise and saves pending edits before leaving.
- `forcePersist()` is replaced by `flush()`, and `syncIntervalMs` by `persistDebounceMs`.
- `createFirebaseYWebrtcAdapter` rejects with `LoadError` when the document can't be read, instead of opening an empty document.
- Only `createFirebaseYWebrtcAdapter` (as a named export), `buildDatabasePaths`, `DEFAULT_DATABASE_PATHS`, `LoadError` and types are exported. Internal helpers, constants, `getMemoryStats()` and `forceGarbageCollection()` are gone.
- The default `maxDirectPeers` is 6 (was 20); larger rooms relay edits through peers.
- The library no longer registers a `beforeunload` listener; use `hasUnsavedChanges()` to prompt.

### Fixes

- Edits are no longer lost when two clients save at about the same time, when a load fails, when an edit is made during a save, or right before `disconnect()`.
- Documents opened without `databasePaths` no longer share storage with each other.
- Peer connections are no longer torn down every ten minutes, `reconnect()` works, and `disconnect()` releases every timer and listener.
- Large documents reach peers that join, and peers that can't connect directly still see each other's edits.

### New

- `flush()`, `hasUnsavedChanges()`, `getSaveState()`, and the `save-state-changed` and `persist-error` events.
- Options: `persistDebounceMs`, `firebaseFallback`, `localCache`, `iceServers`, `logger`.
- `sync-completed`, `document-persisted` and `connection-state-changed` are emitted.
- Much lower Firebase usage; see "Firebase cost" in the README.
