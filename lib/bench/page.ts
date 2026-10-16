// Uses only the public adapter API; version-specific calls live in save() and close().
import { initializeApp } from 'firebase/app'
import { connectDatabaseEmulator, getDatabase } from 'firebase/database'
import * as Y from 'yjs'
import { createFirebaseYWebrtcAdapter, type AdapterHandle } from '../index'

type OpenOptions = { docId: string; basePath: string; name: string; maxDirectPeers?: number }

const params = new URLSearchParams(location.search)
const [host, port] = params.get('emu')!.split(':')
const ns = params.get('ns')!

const app = initializeApp({ projectId: 'demo-firetap', databaseURL: `http://${host}:${port}?ns=${ns}` })
const db = getDatabase(app)
connectDatabaseEmulator(db, host, Number(port))

let adapter: AdapterHandle | null = null

// Deterministic, so seeded documents are reproducible.
function prng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
}

const WORDS = (
  'the quick brown fox jumps over lazy dog collaboration editor document paragraph ' +
  'firebase realtime peer network update cursor selection review draft meeting notes ' +
  'project roadmap milestone release budget design system component layout heading list'
).split(' ')

function phrase(rand: () => number, words: number): string {
  let s = ''
  for (let i = 0; i < words; i++) s += WORDS[Math.floor(rand() * WORDS.length)] + ' '
  return s
}

function text(): Y.Text {
  return adapter!.ydoc.getText('content')
}

const fx = {
  async open(opts: OpenOptions): Promise<string> {
    adapter = await createFirebaseYWebrtcAdapter({
      docId: opts.docId,
      firebaseDatabase: db,
      user: { name: opts.name },
      maxDirectPeers: opts.maxDirectPeers,
      logger: params.get('debug') ? console : undefined,
      databasePaths: {
        structure: 'nested',
        nested: {
          basePath: opts.basePath,
          subPaths: { documents: 'documents', rooms: 'rooms', snapshots: 'snapshots', signaling: 'signaling' },
        },
      },
    })
    return adapter.getUserInfo().id
  },

  peerCount: () => adapter?.getPeerCount() ?? 0,
  textLength: () => (adapter ? text().length : 0),
  textHash: () => {
    let h = 0x811c9dc5
    const s = adapter ? text().toString() : ''
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
    return h
  },
  stateSize: () => (adapter ? Y.encodeStateAsUpdate(adapter.ydoc).length : 0),

  seed(targetBytes: number, seed = 1): number {
    const rand = prng(seed)
    const t = text()
    while (Y.encodeStateAsUpdate(adapter!.ydoc).length < targetBytes) {
      adapter!.ydoc.transact(() => {
        for (let i = 0; i < 200; i++) {
          const len = t.length
          if (len > 50 && rand() < 0.1) {
            t.delete(Math.floor(rand() * (len - 10)), 1 + Math.floor(rand() * 8))
          } else {
            t.insert(Math.floor(rand() * (len + 1)), phrase(rand, 1 + Math.floor(rand() * 6)))
          }
        }
      })
    }
    return Y.encodeStateAsUpdate(adapter!.ydoc).length
  },

  async type(chars: number, intervalMs: number, seed = 2): Promise<void> {
    const rand = prng(seed)
    const t = text()
    let pos = Math.floor(rand() * (t.length + 1))
    for (let i = 0; i < chars; i++) {
      t.insert(Math.min(pos, t.length), WORDS[Math.floor(rand() * WORDS.length)][0])
      pos++
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  },

  async save(): Promise<void> {
    await adapter!.forcePersist()
  },

  async close(): Promise<void> {
    adapter?.disconnect()
    adapter = null
  },
}

;(window as unknown as { __fx: typeof fx }).__fx = fx
