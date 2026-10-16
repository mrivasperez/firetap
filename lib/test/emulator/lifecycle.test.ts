import { get, ref } from 'firebase/database'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFirebaseYWebrtcAdapter } from '../../adapter'
import type { AdapterHandle } from '../../core/types'
import { FakeRTCPeerConnection, installFakeWebRTC, resetFakeWebRTC } from '../support/fake-webrtc'
import { closeClients, createClient, nestedPaths, readRaw, setRules, sleep, uniqueBasePath, waitFor } from './helpers'

installFakeWebRTC()

const open: AdapterHandle[] = []

async function openAdapter(basePath: string, docId = 'doc'): Promise<AdapterHandle> {
  const adapter = await createFirebaseYWebrtcAdapter({
    docId,
    firebaseDatabase: createClient(),
    databasePaths: nestedPaths(basePath),
  })
  open.push(adapter)
  return adapter
}

async function connectedPair(label: string) {
  const basePath = uniqueBasePath(label)
  const a = await openAdapter(basePath)
  const b = await openAdapter(basePath)
  await waitFor(() => a.getPeerCount() === 1 && b.getPeerCount() === 1, { message: 'peers to connect' })
  return { basePath, a, b }
}

const presencePath = (basePath: string, adapter: AdapterHandle) =>
  `${basePath}/doc/rooms/peers/${adapter.getUserInfo().id}`

describe('peer lifecycle', () => {
  beforeAll(() => setRules())
  beforeEach(() => resetFakeWebRTC())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    open.splice(0).forEach((a) => a.disconnect())
  })
  afterAll(() => closeClients())

  it('connects two peers and syncs edits', async () => {
    const { a, b } = await connectedPair('sync')
    a.ydoc.getText('t').insert(0, 'hello')
    await waitFor(() => b.ydoc.getText('t').toString() === 'hello', { message: 'edit to sync' })
  })

  it('keeps healthy connections and presence through a long session', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'], shouldAdvanceTime: true })
    const { basePath, a, b } = await connectedPair('long')
    const departures: string[] = []
    a.on('peer-left', ({ peerId }) => departures.push(peerId))
    b.on('peer-left', ({ peerId }) => departures.push(peerId))
    const connectionsBefore = FakeRTCPeerConnection.created

    // 30 minutes of cleanup and heartbeat ticks.
    for (let minute = 0; minute < 30; minute++) {
      vi.advanceTimersByTime(60_000)
      await sleep(20)
    }
    vi.useRealTimers()
    await sleep(500)

    expect(departures).toEqual([])
    expect(FakeRTCPeerConnection.created).toBe(connectionsBefore)
    expect(a.getPeerCount()).toBe(1)
    expect(b.getPeerCount()).toBe(1)
    expect(await readRaw(presencePath(basePath, a))).not.toBeNull()
    expect(await readRaw(presencePath(basePath, b))).not.toBeNull()
  })

  it('connects without waiting for slow ICE gathering to complete', async () => {
    // Real browsers can take ~40s to finish gathering when a STUN server is unreachable.
    FakeRTCPeerConnection.gatheringCompleteMs = 60_000
    const started = Date.now()
    await connectedPair('slow-ice')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('reconnect() restores the connection', async () => {
    const { a, b } = await connectedPair('reconnect')
    await a.reconnect()
    await waitFor(() => a.getPeerCount() === 1 && b.getPeerCount() === 1, { message: 'reconnection' })
    a.ydoc.getText('t').insert(0, 'after reconnect')
    await waitFor(() => b.ydoc.getText('t').toString() === 'after reconnect', { message: 'edit to sync' })
  })

  it('retries a connection that failed to establish', async () => {
    FakeRTCPeerConnection.isBlocked = () => true
    const basePath = uniqueBasePath('retry')
    const a = await openAdapter(basePath)
    const b = await openAdapter(basePath)
    await sleep(1000)
    expect(a.getPeerCount()).toBe(0)

    FakeRTCPeerConnection.isBlocked = () => false
    await waitFor(() => a.getPeerCount() === 1 && b.getPeerCount() === 1, {
      timeout: 15_000,
      message: 'retry to connect',
    })
  })

  it('recovers when an established connection drops', async () => {
    const { a, b } = await connectedPair('drop')
    const connected = [...FakeRTCPeerConnection.registry.values()].find((pc) => pc.connectionState === 'connected')!
    connected.simulateFailure()
    await waitFor(() => a.getPeerCount() === 0, { message: 'drop to register' })
    await waitFor(() => a.getPeerCount() === 1 && b.getPeerCount() === 1, {
      timeout: 15_000,
      message: 'reconnection after drop',
    })
  })

  it('closes the connection without retrying when a peer leaves', async () => {
    const { basePath, a, b } = await connectedPair('leave')
    b.disconnect()
    await waitFor(() => a.getPeerCount() === 0, { message: 'peer to leave' })
    const created = FakeRTCPeerConnection.created
    await sleep(3000)
    expect(FakeRTCPeerConnection.created).toBe(created)
    expect(await readRaw(presencePath(basePath, a))).not.toBeNull()
  })

  describe('in a browser-like page', () => {
    let listeners: Set<EventListenerOrEventListenerObject>
    let doc: EventTarget & { hidden: boolean }

    beforeEach(() => {
      listeners = new Set()
      const track = (target: EventTarget) => {
        const add = target.addEventListener.bind(target)
        const remove = target.removeEventListener.bind(target)
        target.addEventListener = (type: string, listener: EventListenerOrEventListenerObject | null) => {
          if (listener) listeners.add(listener)
          add(type, listener)
        }
        target.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject | null) => {
          if (listener) listeners.delete(listener)
          remove(type, listener)
        }
        return target
      }
      doc = Object.assign(track(new EventTarget()), { hidden: false })
      vi.stubGlobal('document', doc)
      vi.stubGlobal('window', track(new EventTarget()))
    })

    it('releases every timer and page listener on disconnect', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      const db = createClient()
      await get(ref(db, '/probe')) // connect the SDK so its own keepalive timer exists already
      const timersBefore = vi.getTimerCount()
      const listenersBefore = listeners.size

      const adapter = await createFirebaseYWebrtcAdapter({
        docId: 'doc',
        firebaseDatabase: db,
        databasePaths: nestedPaths(uniqueBasePath('leaks')),
      })
      expect(vi.getTimerCount()).toBeGreaterThan(timersBefore)
      expect(listeners.size).toBeGreaterThan(listenersBefore)

      adapter.disconnect()
      expect(vi.getTimerCount()).toBe(timersBefore)
      expect(listeners.size).toBe(listenersBefore)
    })

    it('does not write presence after disconnect when the tab becomes visible', async () => {
      const basePath = uniqueBasePath('ghost')
      const adapter = await openAdapter(basePath)
      const path = presencePath(basePath, adapter)
      await waitFor(async () => (await readRaw(path)) !== null, { message: 'presence' })

      adapter.disconnect()
      await waitFor(async () => (await readRaw(path)) === null, { message: 'presence removal' })

      doc.hidden = true
      doc.dispatchEvent(new Event('visibilitychange'))
      doc.hidden = false
      doc.dispatchEvent(new Event('visibilitychange'))
      await sleep(500)
      expect(await readRaw(path)).toBeNull()
    })
  })
})
