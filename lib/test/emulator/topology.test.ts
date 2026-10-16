import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createFirebaseYWebrtcAdapter } from '../../adapter'
import type { AdapterHandle } from '../../core/types'
import { FakeRTCPeerConnection, installFakeWebRTC, resetFakeWebRTC } from '../support/fake-webrtc'
import { closeClients, createClient, nestedPaths, setRules, sleep, uniqueBasePath, waitFor } from './helpers'

installFakeWebRTC()

const open: AdapterHandle[] = []
const quiet = { warn: () => {}, error: () => {} }

async function room(size: number, maxDirectPeers: number, label: string) {
  const basePath = uniqueBasePath(label)
  const peers: AdapterHandle[] = []
  for (let i = 0; i < size; i++) {
    const adapter = await createFirebaseYWebrtcAdapter({
      docId: 'doc',
      firebaseDatabase: createClient(),
      databasePaths: nestedPaths(basePath),
      maxDirectPeers,
      logger: quiet,
    })
    open.push(adapter)
    peers.push(adapter)
  }
  return peers
}

const text = (adapter: AdapterHandle) => adapter.ydoc.getText('t').toString()

async function expectConverged(peers: AdapterHandle[], from: AdapterHandle, value: string) {
  from.ydoc.getText('t').insert(text(from).length, value)
  const expected = text(from)
  await waitFor(() => peers.every((p) => text(p) === expected), { timeout: 15_000, message: `"${value}" everywhere` })
}

describe('sparse mesh', () => {
  beforeAll(() => setRules())
  beforeEach(() => resetFakeWebRTC())
  afterEach(() => open.splice(0).forEach((a) => a.disconnect()))
  afterAll(() => closeClients())

  it('caps direct links and still syncs everyone in a 9-peer room', async () => {
    const peers = await room(9, 4, 'sparse')
    await waitFor(() => peers.every((p) => p.getPeerCount() >= 2), { timeout: 15_000, message: 'links' })
    await sleep(1000) // let pruning settle

    for (const p of peers) expect(p.getPeerCount()).toBeLessThanOrEqual(4)
    await expectConverged(peers, peers[0], 'hello ')
    await expectConverged(peers, peers[8], 'world')

    // A full mesh would need 36 links (72 connection objects).
    const totalLinks = peers.reduce((sum, p) => sum + p.getPeerCount(), 0) / 2
    expect(totalLinks).toBeLessThanOrEqual(18)
    expect(FakeRTCPeerConnection.created).toBeLessThan(72)
  })

  it('repairs the mesh when a peer leaves', async () => {
    const peers = await room(8, 2, 'ring') // k=2: a plain ring, the most fragile shape
    await waitFor(() => peers.every((p) => p.getPeerCount() === 2), { timeout: 15_000, message: 'ring' })

    const leaver = peers.splice(3, 1)[0]
    leaver.disconnect()
    await waitFor(() => peers.every((p) => p.getPeerCount() === 2), { timeout: 15_000, message: 'ring repaired' })
    await expectConverged(peers, peers[0], 'still connected')
  })
})
