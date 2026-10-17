import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createFirebaseYWebrtcAdapter } from '../../adapter'
import type { AdapterHandle, AdapterOptions } from '../../core/types'
import { FakeRTCPeerConnection, installFakeWebRTC, resetFakeWebRTC } from '../support/fake-webrtc'
import { closeClients, createClient, nestedPaths, readRaw, setRules, sleep, uniqueBasePath, waitFor } from './helpers'

const open: AdapterHandle[] = []

async function openAdapter(basePath: string, extra: Partial<AdapterOptions> = {}) {
  const adapter = await createFirebaseYWebrtcAdapter({
    docId: 'doc',
    firebaseDatabase: createClient(),
    databasePaths: nestedPaths(basePath),
    persistDebounceMs: 50,
    logger: { warn: () => {}, error: () => {} },
    ...extra,
  })
  open.push(adapter)
  return adapter
}

const text = (adapter: AdapterHandle) => adapter.ydoc.getText('t').toString()

describe('maxDirectPeers: 0', () => {
  beforeAll(() => setRules())
  afterEach(() => open.splice(0).forEach((a) => a.disconnect()))
  afterAll(() => closeClients())

  it('syncs through Firebase alone, without WebRTC', async () => {
    expect(globalThis.RTCPeerConnection).toBeUndefined()
    const basePath = uniqueBasePath('rtc-off')
    const a = await openAdapter(basePath, { maxDirectPeers: 0, user: { name: 'A' } })
    const b = await openAdapter(basePath, { maxDirectPeers: 0, user: { name: 'B' } })
    await waitFor(() => a.getPresentPeers().length === 1, { message: 'presence' })

    const start = Date.now()
    a.ydoc.getText('t').insert(0, 'from A')
    await waitFor(() => text(b) === 'from A', { message: 'A -> B' })
    b.ydoc.getText('t').insert(text(b).length, ', from B')
    await waitFor(() => text(a) === 'from A, from B', { message: 'B -> A' })
    // No waiting for WebRTC connections that will never come.
    expect(Date.now() - start).toBeLessThan(4000)
    expect(a.getPeerCount()).toBe(0)
  })

  it('is left alone by peers that use WebRTC, which still exchange edits with it', async () => {
    installFakeWebRTC()
    resetFakeWebRTC()
    const basePath = uniqueBasePath('rtc-mixed')
    const a = await openAdapter(basePath)
    const b = await openAdapter(basePath)
    await waitFor(() => a.getPeerCount() === 1 && b.getPeerCount() === 1, { message: 'A and B connect' })
    const connections = FakeRTCPeerConnection.created

    const x = await openAdapter(basePath, { maxDirectPeers: 0 })
    x.ydoc.getText('t').insert(0, 'from X')
    await waitFor(() => text(a) === 'from X' && text(b) === 'from X', { message: 'X -> A and B' })
    a.ydoc.getText('t').insert(text(a).length, ', from A')
    await waitFor(() => text(x) === 'from X, from A', { message: 'A -> X' })

    await sleep(500)
    expect(FakeRTCPeerConnection.created).toBe(connections)
    expect(await readRaw(`${basePath}/doc/signaling/${x.getUserInfo().id}`)).toBeNull()
  })
})
