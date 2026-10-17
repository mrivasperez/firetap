import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createFirebaseYWebrtcAdapter } from '../../adapter'
import type { AdapterHandle, AdapterOptions } from '../../core/types'
import { FakeRTCPeerConnection, installFakeWebRTC, resetFakeWebRTC } from '../support/fake-webrtc'
import { closeClients, createClient, nestedPaths, setRules, sleep, uniqueBasePath, waitFor } from './helpers'

installFakeWebRTC()

const open: AdapterHandle[] = []

function recordingLogger() {
  const lines: string[] = []
  return { lines, logger: { debug: (...args: unknown[]) => lines.push(args.join(' ')), warn: () => {}, error: () => {} } }
}

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
const listening = (lines: string[]) => lines.some((l) => l.includes('receiving edits from Firebase'))
const stopped = (lines: string[]) => lines.some((l) => l.includes('Stopped receiving edits'))

describe('Firebase fallback', () => {
  beforeAll(() => setRules())
  beforeEach(() => resetFakeWebRTC())
  afterEach(() => open.splice(0).forEach((a) => a.disconnect()))
  afterAll(() => closeClients())

  it('lets peers that cannot connect see each other’s edits through Firebase', async () => {
    FakeRTCPeerConnection.isBlocked = () => true
    const basePath = uniqueBasePath('isolated')
    const a = await openAdapter(basePath)
    const b = await openAdapter(basePath)

    b.ydoc.getText('t').insert(0, 'from B')
    await waitFor(() => text(a) === 'from B', { timeout: 15_000, message: 'B -> A via Firebase' })
    a.ydoc.getText('t').insert(text(a).length, ', from A')
    await waitFor(() => text(b) === 'from B, from A', { timeout: 15_000, message: 'A -> B via Firebase' })
  })

  it('lets connected peers see a collaborator neither of them can reach', async () => {
    const basePath = uniqueBasePath('partial')
    const logA = recordingLogger()
    const logB = recordingLogger()
    const a = await openAdapter(basePath, { logger: logA.logger })
    const b = await openAdapter(basePath, { logger: logB.logger })
    await waitFor(() => a.getPeerCount() === 1 && b.getPeerCount() === 1, { message: 'A and B connect' })

    FakeRTCPeerConnection.isBlocked = () => true
    const c = await openAdapter(basePath)
    c.ydoc.getText('t').insert(0, 'from C')
    await waitFor(() => text(a) === 'from C' && text(b) === 'from C', {
      timeout: 15_000,
      message: 'C -> A and B via Firebase',
    })
    a.ydoc.getText('t').insert(text(a).length, ', from A')
    await waitFor(() => text(c) === 'from C, from A', { timeout: 15_000, message: 'A -> C via Firebase' })

    // One of A and B downloads the log and relays it to the other.
    expect([listening(logA.lines), listening(logB.lines)].filter(Boolean)).toHaveLength(1)
  }, 30_000)

  it('stays off when disabled', async () => {
    FakeRTCPeerConnection.isBlocked = () => true
    const basePath = uniqueBasePath('off')
    const a = await openAdapter(basePath, { firebaseFallback: 'off' })
    const b = await openAdapter(basePath)
    b.ydoc.getText('t').insert(0, 'from B')
    await sleep(8000)
    expect(text(a)).toBe('')
  })

  it('is not used while peers are connected, and stops once a peer is reachable', async () => {
    const connected = recordingLogger()
    const basePath = uniqueBasePath('connected')
    const a = await openAdapter(basePath, { logger: connected.logger })
    const b = await openAdapter(basePath)
    await waitFor(() => a.getPeerCount() === 1 && b.getPeerCount() === 1, { message: 'connection' })
    await sleep(6000)
    expect(listening(connected.lines)).toBe(false)

    FakeRTCPeerConnection.isBlocked = () => true
    const isolated = recordingLogger()
    const c = await openAdapter(basePath, { logger: isolated.logger, maxDirectPeers: 2 })
    await waitFor(() => listening(isolated.lines), { timeout: 10_000, message: 'listening' })
    FakeRTCPeerConnection.isBlocked = () => false
    await waitFor(() => c.getPeerCount() > 0, { timeout: 15_000, message: 'C connects' })
    await waitFor(() => stopped(isolated.lines), { message: 'stopped listening' })
  }, 40_000)
})
