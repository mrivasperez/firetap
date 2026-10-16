import { goOffline, goOnline, type Database } from 'firebase/database'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createFirebaseYWebrtcAdapter } from '../../adapter'
import type { AdapterHandle } from '../../core/types'
import type { ConnectionState } from '../../utils/config'
import { installFakeWebRTC, resetFakeWebRTC } from '../support/fake-webrtc'
import { closeClients, createClient, nestedPaths, readRaw, setRules, sleep, uniqueBasePath, waitFor } from './helpers'

installFakeWebRTC()

const open: AdapterHandle[] = []

async function openAdapter(basePath: string, name: string, db: Database = createClient()) {
  const adapter = await createFirebaseYWebrtcAdapter({
    docId: 'doc',
    firebaseDatabase: db,
    databasePaths: nestedPaths(basePath),
    user: { name },
  })
  open.push(adapter)
  return adapter
}

const presencePath = (basePath: string, adapter: AdapterHandle) =>
  `${basePath}/doc/rooms/peers/${adapter.getUserInfo().id}`

describe('presence', () => {
  beforeAll(() => setRules())
  beforeEach(() => resetFakeWebRTC())
  afterEach(() => open.splice(0).forEach((a) => a.disconnect()))
  afterAll(() => closeClients())

  it('announces the user name and reports it to peers', async () => {
    const basePath = uniqueBasePath('names')
    const a = await openAdapter(basePath, 'Alice')
    const joined: string[] = []
    a.on('peer-joined', ({ user }) => joined.push(user.name))
    const b = await openAdapter(basePath, 'Bob')

    const entry = (await waitFor(() => readRaw(presencePath(basePath, b)), { message: 'presence' })) as Record<
      string,
      unknown
    >
    expect(entry).toEqual({ name: 'Bob', connectedAt: expect.any(Number) })
    await waitFor(() => joined.length === 1, { message: 'peer-joined' })
    expect(joined).toEqual(['Bob'])
  })

  it('is removed by Firebase when the connection drops, and restored on reconnect', async () => {
    const basePath = uniqueBasePath('drop')
    const db = createClient()
    const a = await openAdapter(basePath, 'Alice', db)
    const states: ConnectionState[] = []
    a.on('connection-state-changed', ({ state }) => states.push(state))
    const path = presencePath(basePath, a)
    await waitFor(async () => (await readRaw(path)) !== null, { message: 'presence' })
    expect(a.getConnectionStatus()).toBe('connected')

    goOffline(db)
    await waitFor(async () => (await readRaw(path)) === null, { message: 'server-side removal' })
    expect(a.getConnectionStatus()).toBe('disconnected')

    goOnline(db)
    await waitFor(async () => (await readRaw(path)) !== null, { message: 're-announcement' })
    expect(a.getConnectionStatus()).toBe('connected')
    expect(states).toEqual(['disconnected', 'connected'])
  })

  it('is removed even if the page goes away right after disconnect()', async () => {
    const basePath = uniqueBasePath('unload')
    const db = createClient()
    const a = await openAdapter(basePath, 'Alice', db)
    const path = presencePath(basePath, a)
    await waitFor(async () => (await readRaw(path)) !== null, { message: 'presence' })

    // The page closes before the removal write can go out.
    goOffline(db)
    a.disconnect()
    await waitFor(async () => (await readRaw(path)) === null, { message: 'server-side removal' })
    await sleep(500)
    expect(await readRaw(path)).toBeNull()
  })

  it('keeps a live WebRTC connection through a brief Firebase disconnect', async () => {
    const basePath = uniqueBasePath('blip')
    const a = await openAdapter(basePath, 'Alice')
    const dbB = createClient()
    const b = await openAdapter(basePath, 'Bob', dbB)
    await waitFor(() => a.getPeerCount() === 1 && b.getPeerCount() === 1, { message: 'connection' })
    const departures: string[] = []
    a.on('peer-left', ({ peerId }) => departures.push(peerId))

    goOffline(dbB)
    await waitFor(async () => (await readRaw(presencePath(basePath, b))) === null, { message: 'presence removal' })
    await sleep(300)
    goOnline(dbB)
    await waitFor(async () => (await readRaw(presencePath(basePath, b))) !== null, { message: 're-announcement' })

    expect(departures).toEqual([])
    expect(a.getPeerCount()).toBe(1)
    a.ydoc.getText('t').insert(0, 'still synced')
    await waitFor(() => b.ydoc.getText('t').toString() === 'still synced', { message: 'sync' })
  })
})
