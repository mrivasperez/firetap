# collab-adapter

Thin adapter library to bridge TipTap (Yjs + Awareness) with Firebase Realtime Database.

Usage

- Import the adapter from `client/src/lib/collab-adapter`:

  import { createFirebaseYWebrtcAdapter } from 'path/to/client/src/lib/collab-adapter'

- The adapter accepts an optional `databasePaths` configuration that lets you choose between two structures:

  - flat (legacy): top-level paths like `/documents`, `/rooms`, `/snapshots`, `/signaling`
  - nested (recommended): all document-related collections nested under `/workspaceId/documents/{{docId}}`.

Example nested configuration:

```ts
createFirebaseYWebrtcAdapter({
  docId: 'demo-doc',
  databasePaths: {
    structure: 'nested',
    nested: {
      basePath: '/workspace123/documents',
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

This repository contains helpers in `client/src/lib/collaboration/config.ts` to build paths and defaults.
