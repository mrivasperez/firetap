import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createFirebaseYWebrtcAdapter } from '../../adapter'
import type { AdapterHandle } from '../../core/types'
import { FakeDataChannel, installFakeWebRTC, resetFakeWebRTC } from '../support/fake-webrtc'
import { closeClients, createClient, nestedPaths, setRules, sleep, uniqueBasePath, waitFor } from './helpers'

installFakeWebRTC()

const open: AdapterHandle[] = []
const quiet = { warn: () => {}, error: () => {} }

async function openAdapter(basePath: string) {
  const adapter = await createFirebaseYWebrtcAdapter({
    docId: 'doc',
    firebaseDatabase: createClient(),
    databasePaths: nestedPaths(basePath),
    logger: quiet,
  })
  open.push(adapter)
  return adapter
}

async function connectedPair(basePath: string) {
  const a = await openAdapter(basePath)
  const b = await openAdapter(basePath)
  await waitFor(() => a.getPeerCount() === 1 && b.getPeerCount() === 1, { message: 'connection' })
  return { a, b }
}

const text = (adapter: AdapterHandle) => adapter.ydoc.getText('t').toString()

describe('peer sync protocol', () => {
  // Paths under t-nosnap-* can't store edits, so peers only get state over WebRTC.
  beforeAll(() =>
    setRules({
      rules: {
        '.read': true,
        $root: {
          '.write': "!$root.beginsWith('t-nosnap')",
          $doc: { rooms: { '.write': true }, signaling: { '.write': true } },
        },
      },
    })
  )
  beforeEach(() => resetFakeWebRTC())
  afterEach(() => open.splice(0).forEach((a) => a.disconnect()))
  afterAll(async () => {
    await setRules()
    await closeClients()
  })

  it('syncs a large document to a joiner over WebRTC', async () => {
    const basePath = uniqueBasePath('nosnap-large')
    const a = await openAdapter(basePath)
    const content = 'x'.repeat(1024 * 1024)
    a.ydoc.getText('t').insert(0, content)

    const b = await openAdapter(basePath)
    expect(text(b)).toBe('') // nothing in Firebase
    await waitFor(() => text(b).length === content.length, { timeout: 20_000, message: 'large sync' })
  })

  it('applies backpressure instead of overflowing the send buffer', async () => {
    FakeDataChannel.sendBufferCapacity = 2 * 1024 * 1024
    const { a, b } = await connectedPair(uniqueBasePath('nosnap-flood'))
    a.ydoc.getText('t').insert(0, 'y'.repeat(6 * 1024 * 1024))
    await waitFor(() => text(b).length === 6 * 1024 * 1024, { timeout: 30_000, message: 'flooded sync' })
    expect(a.getPeerCount()).toBe(1)
  })

  it('replaces a connection after a protocol error and resyncs what was missed', async () => {
    const { a, b } = await connectedPair(uniqueBasePath('nosnap-corrupt'))
    const channel = FakeDataChannel.all.find((c) => c.readyState === 'open')!
    const bogus = new Uint8Array(20)
    bogus[0] = 5 // a chunk that claims to be the second of a message nobody started
    new DataView(bogus.buffer).setUint32(5, 1)
    channel.remote!.onmessage!({ data: bogus.buffer })
    a.ydoc.getText('t').insert(0, 'sent while reconnecting')

    await waitFor(() => text(b) === 'sent while reconnecting', { timeout: 15_000, message: 'resync' })
    await waitFor(() => a.getPeerCount() === 1 && b.getPeerCount() === 1, { message: 'reconnection' })
  })

  it("removes a departed peer's cursor right away and keeps the others", async () => {
    const basePath = uniqueBasePath('cursors')
    const a = await openAdapter(basePath)
    const b = await openAdapter(basePath)
    const c = await openAdapter(basePath)
    await waitFor(() => [a, b, c].every((x) => x.getPeerCount() === 2), { message: 'mesh' })
    b.awareness.setLocalStateField('cursor', 1)
    c.awareness.setLocalStateField('cursor', 2)
    await waitFor(() => a.awareness.getStates().get(b.ydoc.clientID)?.cursor === 1, { message: 'cursor B' })
    await waitFor(() => a.awareness.getStates().get(c.ydoc.clientID)?.cursor === 2, { message: 'cursor C' })

    b.disconnect()
    await waitFor(() => !a.awareness.getStates().has(b.ydoc.clientID), { timeout: 5000, message: 'cursor removal' })
    await sleep(200)
    expect(a.awareness.getStates().get(c.ydoc.clientID)?.cursor).toBe(2)
  })
})
